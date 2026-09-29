import { RibbitModulator, firingOf, refOption } from "../modulator.js";
import { WorkletNode } from "./worklet.js";
import { buildParams } from "./spec.js";

// Base for continuous modulators whose signal is computed in an AudioWorklet
// (`modlfo`, `attractor`, `curveloop`): one mono output into `this.output`,
// which is what a `/patch` connects from.
//
// **Beat sync.** A worklet knows the audio clock but not the musical one, so
// every scheduling pass sends an *anchor* — "beat B falls at time T, at this
// bpm" — and the processor derives the beat at any sample from the latest
// anchor. The anchors ride the clock's own lookahead, so a synced LFO's
// phase lands on the grid, and follows `/clock bpm=` and `elastictempo`
// within one scheduling pass. The worklet half is DSP.BeatClock (lib.js).
//
// **Strikes.** A modulator can be told to watch another object
// (`strike=<name>`): each time it fires is forwarded (a sample-and-hold
// re-rolls, an attractor is pushed). A track fires on every note it plays,
// a loudness on every onset, a midiin on every key — see firingOf.
export class RibbitWorkletModulator extends RibbitModulator {
    constructor(audioContext, options = {}, spec) {
        super(audioContext, { name: options.name ?? spec.processor });
        this.engine = options.engine ?? null;
        // These use the clock's onSchedule hook only for beat anchors and
        // strikes; unlike randomgestures (the other onSchedule modulator)
        // they publish a signal and are patched like an LFO. Hosts that infer
        // "acts on the session, no outlet" from onSchedule read this first.
        this.signalOutput = true;
        const { sources, params } = buildParams(audioContext, spec.params, options);
        this._paramSources = sources;
        this.params = params;
        this.strike = String(options.strike ?? "").trim();
        this._lastStrike = null;
        this.node = new WorkletNode(audioContext, spec.processor, {
            params: this.params,
            output: this.output,
            outputChannels: 1,
            processorOptions: spec.processorOptions ?? {},
        });
        this.node.onmessage = (message) => this.onWorkletMessage?.(message);
    };

    send(message, time) {
        this.node.post({ ...message, time: time ?? this.audioContext.currentTime });
    };

    // An option naming the object whose firings strike this modulator.
    strikeOption() {
        return refOption({
            get: () => this.strike,
            set: (value) => {
                this.strike = String(value).trim();
                this._lastStrike = null;
            },
        }, { direction: "in" });
    };

    onSchedule(fromBeat, toBeat, secondsPerBeat, clock) {
        this.node.post({ type: "anchor", time: clock.beatToTime(fromBeat), beat: fromBeat, bpm: clock.bpm });
        if (!this.strike || !this.engine) return;
        const at = firingOf(this.engine._resolveObject(this.strike))?.time;
        if (at !== undefined && at !== this._lastStrike) {
            this._lastStrike = at;
            this.node.post({ type: "strike", time: at });
        }
    };

    dispose() {
        this.node.dispose();
        this._paramSources.dispose();
    };
};
