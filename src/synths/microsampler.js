import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams, toggleOption, isOn } from "../dsp/spec.js";
import { SampleSlot, transferable } from "../dsp/sampled.js";

// A pitched stereo sampler with a micro-loop engine that turns velocity into
// shape — the AE machine's Samplers 2, 3 and 4 (`voce_2..4`). Three of these,
// each on its own lane (2, 3, 4), is the manual's "closest this machine gets
// to writing for an ensemble".
//
// Plain playback: a note transposes the recording like a keyboard (note 48 =
// original pitch, the sequencer's `shift` detunes), velocity is level, and
// `attack`/`decay` shape it. `start` is where playback begins; with
// `loop=on` it loops `loop_start..loop_end`.
//
// **`mod=on` is the micro-loop engine**, and the reason to feed it long
// recordings rather than one-shots. The file is cut into `slices`; every hit
// relocates a playhead — usually one slice on, sometimes (`chaos`) a jump to
// a random one — and loops a fragment there whose length is *velocity*: with
// `vel_invert=off` an accent gets a short loop (it turns into a pitched tone)
// and a quiet hit a long one (texture); `vel_invert=on` swaps that.
// `loop_min`/`loop_max` bound the fragment (ms). `vel_jump=on` ties jumping to
// how hard you play: up to 40% extra chance at full velocity on top of chaos.
// What you get is "a recording being read in time with the music, in an order
// it will never repeat".
export const MICROSAMPLER_PARAMS = {
    attack: { value: 2, min: 0, max: 500 },
    decay: { value: 200, min: 5, max: 5000 },
    start: { value: 0, min: 0, max: 1 },
    loop_start: { value: 0.2, min: 0, max: 1 },
    loop_end: { value: 0.3, min: 0, max: 1 },
    slices: { value: 16, min: 1, max: 64 },
    chaos: { value: 0.2, min: 0, max: 1 },
    loop_min: { value: 4, min: 1, max: 1000 },
    loop_max: { value: 250, min: 1, max: 2000 },
    level: { value: 0.8, min: 0, max: 1 },
};

export function microsamplerProcessor(Base, DSP) {
    const { SR, clamp, readAt, readLoop, Rng, voiceProcessor } = DSP;

    class Voice {
        constructor(m, P, proc) {
            const buffer = proc.buffer;
            this.left = buffer.left;
            this.right = buffer.right;
            this.length = buffer.left.length;
            this.rate = Math.pow(2, (m.pitch - 48) / 12) * (buffer.sampleRate / SR);
            this.gain = buffer.gain * m.velocity * P.level;
            this.attack = Math.max(1, (P.attack / 1000) * SR);
            this.hold = Math.max(1, m.duration * SR);
            this.decayMul = Math.exp(-6.9 / Math.max(1, (P.decay / 1000) * SR));
            this.env = 0;
            this.n = 0;

            if (proc.mod) {
                // Relocate: one slice on, or a jump (chaos, + velocity if
                // vel_jump). The fragment's length is velocity, inverted or not.
                const slices = Math.max(1, Math.round(P.slices));
                const jump = P.chaos + (proc.velJump ? 0.4 * m.velocity : 0);
                proc.cursor = proc.rng.next() < jump ? Math.floor(proc.rng.next() * slices) : (proc.cursor + 1) % slices;
                const lo = Math.min(P.loop_min, P.loop_max), hi = Math.max(P.loop_min, P.loop_max);
                const t = proc.velInvert ? m.velocity : 1 - m.velocity;
                const loopMs = lo + (hi - lo) * t;
                this.loopStart = (proc.cursor / slices) * this.length;
                this.loopLength = Math.max(8, Math.min(this.length - this.loopStart - 4, (loopMs / 1000) * buffer.sampleRate));
                this.looping = true;
                this.position = this.loopStart;
            } else {
                this.position = clamp(P.start, 0, 1) * this.length;
                this.looping = proc.loop;
                const a = clamp(Math.min(P.loop_start, P.loop_end), 0, 1) * this.length;
                const b = clamp(Math.max(P.loop_start, P.loop_end), 0, 1) * this.length;
                this.loopStart = a;
                this.loopLength = Math.max(8, b - a);
            }
            this.fade = Math.min(this.loopLength * 0.25, 0.01 * SR);
        }
        render(L, R, from, to) {
            for (let i = from; i < to; i++) {
                if (this.n < this.attack) this.env = this.n / this.attack;
                else if (this.n < this.hold) this.env = 1;
                else this.env *= this.decayMul;
                if (this.n > this.hold && this.env < 1e-4) return false;

                let l, r;
                if (this.looping && this.position >= this.loopStart) {
                    const end = this.loopStart + this.loopLength;
                    while (this.position >= end) this.position -= this.loopLength;
                    l = readLoop(this.left, this.position, this.loopStart, this.loopLength, this.fade);
                    r = this.right === this.left ? l : readLoop(this.right, this.position, this.loopStart, this.loopLength, this.fade);
                } else {
                    if (this.position >= this.length - 2) return false;
                    l = readAt(this.left, this.position);
                    r = this.right === this.left ? l : readAt(this.right, this.position);
                }
                const g = this.env * this.gain;
                L[i] += l * g;
                R[i] += r * g;
                this.position += this.rate;
                this.n++;
            }
            return true;
        }
    }

    return voiceProcessor(Base, (m, P, proc) => (proc.buffer ? new Voice(m, P, proc) : null), 12, {
        init() {
            this.buffer = null;
            this.rng = new Rng(0x3a3);
            this.cursor = 0;
            this.mod = !!this.opts.mod;
            this.loop = !!this.opts.loop;
            this.velInvert = !!this.opts.vel_invert;
            this.velJump = !!this.opts.vel_jump;
        },
        message(m) {
            if (m.type === "buffer") this.buffer = { left: m.left, right: m.right, sampleRate: m.sampleRate, gain: m.gain };
            else if (m.type === "flags") Object.assign(this, m.flags);
        },
    });
};

registerWorkletProcessor("ribbit-microsampler", microsamplerProcessor, workletParams(MICROSAMPLER_PARAMS));

export class RibbitMicroSampler extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        const flags = {
            mod: isOn(options.mod, true),
            loop: isOn(options.loop, false),
            vel_invert: isOn(options.vel_invert, false),
            vel_jump: isOn(options.vel_jump, false),
        };
        super(audioContext, { name: "microsampler", ...options }, {
            processor: "ribbit-microsampler",
            params: MICROSAMPLER_PARAMS,
            lane: "2",
            sieve: "all",
            processorOptions: flags,
        });
        this.llm_summary = "A pitched stereo sampler (the AE machine's samplers 2-4): note 48 = original pitch. mod=on is the micro-loop engine — every hit relocates through the file's slices (chaos = jump chance) and loops a fragment whose length is velocity (vel_invert swaps loud=short/tonal for loud=long/textural). Feed it long recordings. Lane 2 by default (3 and 4 for the other two).";
        Object.assign(this, flags);
        const sendFlags = () => this.node.post({ type: "flags", flags: { mod: this.mod, loop: this.loop, velInvert: this.vel_invert, velJump: this.vel_jump } });
        this.recording = new SampleSlot(this, {
            folder: options.folder ?? "foley",
            sample: options.sample,
            // Slices here are equal divisions (`slices`), not onsets.
            analysis: () => ({ onsets: false }),
            onLoad: (result, gain) => {
                const { left, right, transfer } = transferable(result.sample);
                this.node.post({ type: "buffer", left, right, sampleRate: result.sample.sampleRate, gain }, transfer);
            },
        });
        this.options = {
            ...this.options,
            ...this.recording.options(),
            mod: toggleOption(this, "mod", sendFlags),
            loop: toggleOption(this, "loop", sendFlags),
            vel_invert: toggleOption(this, "vel_invert", sendFlags),
            vel_jump: toggleOption(this, "vel_jump", sendFlags),
        };
        sendFlags();
    };

    // The source's path and folder, read by hosts (lilypad's sample picker)
    // the same way they read granular's.
    get sample() {
        return this.recording?.sample ?? null;
    };

    get folder() {
        return this.recording?.folder ?? null;
    };

    describeState() {
        return `[${this.recording.describe()}]`;
    };
};
