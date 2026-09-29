import { RibbitModulator, refOption } from "../modulator.js";
import { registerWorkletProcessor, WorkletNode } from "../dsp/worklet.js";
import { buildParams, workletParams, choiceOption } from "../dsp/spec.js";

export const LOUDNESS_MODES = ["gate", "envelope"];

// An envelope follower with a threshold: listens to another object's audio
// and turns it into control. The first of the audio-analysis modulators —
// the shape later ones (pitch, brightness, onsets by spectral flux) can
// copy: `source=<name>` picks what to hear, the output is a signal, and each
// detected event *fires* the object.
//
//     /add_modulator type=loudness name=onset source=mic threshold=-30
//
// **Output** (patch it into any param): `mode=gate` is 1 for `width` seconds
// from each onset, else 0 — an impulse; `mode=envelope` is the followed
// level itself, 0..1 (instant attack, `release` seconds).
//
// **Firing.** Each time the level crosses `threshold` (dBFS) it fires —
// `lastEventTime`/`lastVelocity` (louder = higher velocity), the same stamp a
// played note leaves — at most once per `hold` seconds, and not again until
// the level has dropped 6dB below the threshold. That's what `trigger=` on
// randomnotes and `strike=` on modlfo/attractor read, so an onset can play a
// note or re-roll a modulator without this object knowing about either.
//
// `source` is any object with audio: a track (a live `audioin` is heard
// before its monitor switch, so `monitor=off` still analyses), a bus,
// master, an effect. It's resolved by name on every clock pass, so it can be
// set before the source exists (a session loading) and follows a re-created
// one.
export const LOUDNESS_PARAMS = {
    threshold: { value: -30, min: -80, max: 0 },
    hold: { value: 0.1, min: 0.01, max: 4 },
    release: { value: 0.1, min: 0.005, max: 4 },
    width: { value: 0.02, min: 0.001, max: 1 },
};

export function loudnessProcessor(Base) {
    return class extends Base {
        constructor(options) {
            super(options);
            const o = (options && options.processorOptions) || {};
            this.mode = o.mode || 0;
            this.env = 0;
            this.armed = true;
            this.since = 1e9;
            this.gate = 0;
            this.dead = false;
            this.port.onmessage = (event) => {
                const m = event.data;
                if (m.type === "dispose") this.dead = true;
                else if (m.type === "config") Object.assign(this, m.config);
            };
        }
        process(inputs, outputs, parameters) {
            if (this.dead) return false;
            const input = inputs[0] || [];
            const out = outputs[0][0];
            const frames = out.length;
            const threshold = parameters.threshold[0];
            const holdFrames = parameters.hold[0] * sampleRate;
            const widthFrames = parameters.width[0] * sampleRate;
            const coef = Math.exp(-1 / (Math.max(parameters.release[0], 0.001) * sampleRate));
            const rearm = Math.pow(10, (threshold - 6) / 20);
            const fire = Math.pow(10, threshold / 20);
            for (let i = 0; i < frames; i++) {
                let x = 0;
                for (let c = 0; c < input.length; c++) {
                    const v = Math.abs(input[c][i]);
                    if (v > x) x = v;
                }
                this.env = x > this.env ? x : this.env * coef;
                this.since++;
                if (this.armed && this.env > fire && this.since >= holdFrames) {
                    this.armed = false;
                    this.since = 0;
                    this.gate = widthFrames;
                    this.port.postMessage({ type: "onset", time: currentTime + i / sampleRate, level: this.env });
                } else if (!this.armed && this.env < rearm) {
                    this.armed = true;
                }
                out[i] = this.mode === 1 ? Math.min(1, this.env) : (this.gate > 0 ? 1 : 0);
                if (this.gate > 0) this.gate--;
            }
            return true;
        }
    };
};

registerWorkletProcessor("ribbit-loudness", loudnessProcessor, workletParams(LOUDNESS_PARAMS));

// The node to listen to on `object`: a synth's pre-monitor signal when it
// has one (audioin), else the object's output.
function tapOf(object) {
    return object?.source?.analysisOutput ?? object?.output ?? null;
};

export class RibbitLoudness extends RibbitModulator {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: options.name ?? "loudness" });
        this.llm_summary = "An envelope follower with a threshold, listening to source=<track|bus|master|effect>: each time the level crosses threshold dBFS it fires (so randomnotes trigger=<this> plays a note, modlfo strike=<this> re-rolls), at most once per hold seconds; its output is a gate impulse (width seconds, mode=gate) or the level itself (mode=envelope) for param patches.";
        this.engine = options.engine ?? null;
        // Has the clock hook (to re-resolve `source`) but publishes a signal
        // — see RibbitWorkletModulator.
        this.signalOutput = true;
        this.mode = LOUDNESS_MODES.includes(options.mode) ? options.mode : "gate";
        // Not `this.source`: on a modulator that name means a node (cv) or a
        // pattern elsewhere, and hosts duck-type on it.
        this.sourceName = String(options.source ?? "").trim();
        this.level = 0;

        const { sources, params } = buildParams(audioContext, LOUDNESS_PARAMS, options);
        this._paramSources = sources;
        this.params = params;

        this.input = audioContext.createGain();
        this._tapped = null;
        this.node = new WorkletNode(audioContext, "ribbit-loudness", {
            params: this.params,
            input: this.input,
            output: this.output,
            outputChannels: 1,
            processorOptions: { mode: LOUDNESS_MODES.indexOf(this.mode) },
        });
        this.node.onmessage = (message) => {
            if (message.type !== "onset") return;
            this.level = message.level;
            // Velocity from how far over the threshold it went: just over is
            // soft, 0dBFS is full.
            const db = 20 * Math.log10(Math.max(message.level, 1e-9));
            const threshold = this.params.threshold.get();
            this.lastVelocity = Math.max(0.2, Math.min(1, 0.2 + 0.8 * (db - threshold) / Math.max(1, -threshold)));
            this.lastEventTime = message.time;
        };

        this.options = {
            source: refOption({
                get: () => this.sourceName,
                set: (value) => {
                    this.sourceName = String(value ?? "").trim();
                    this._retap();
                },
            }, { direction: "in" }),
            mode: choiceOption(this, "mode", LOUDNESS_MODES, () => {
                this.node.post({ type: "config", config: { mode: LOUDNESS_MODES.indexOf(this.mode) } });
            }),
        };
        this._retap();
    };

    _retap() {
        const object = this.sourceName && this.engine ? this.engine._resolveObject(this.sourceName) : null;
        const tap = object === this ? null : tapOf(object);
        if (tap === this._tapped) return;
        if (this._tapped) {
            try { this._tapped.disconnect(this.input); } catch {}
        }
        if (tap) tap.connect(this.input);
        this._tapped = tap;
    };

    onSchedule() {
        this._retap();
    };

    describeState() {
        if (!this.sourceName) return "[no source — set source=<track>]";
        return this._tapped ? `[listening to ${this.sourceName}]` : `[waiting for "${this.sourceName}"]`;
    };

    dispose() {
        if (this._tapped) {
            try { this._tapped.disconnect(this.input); } catch {}
        }
        this.node.dispose();
        this._paramSources.dispose();
    };
};
