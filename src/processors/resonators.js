import { RibbitWorkletProcessor } from "../dsp/effect.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams, choiceOption } from "../dsp/spec.js";

// Four tuned strings that ring whatever you feed them — the AE machine's
// Resonators (`aem_fx_res`). Send percussion in, get harmony out.
//
// Each string is a feedback delay one period long with a lowpass in its loop
// (Karplus-Strong, driven by the input instead of a pluck). The four notes
// are four degrees of `scale` above `root` (every other degree, so a chord
// rather than a cluster). `decay` is how long they ring — near 1 they almost
// drone; `damp` darkens (higher is darker, "the opposite of what the name
// suggests"); `inharm` detunes the strings against each other: a little is
// chorus, a lot is bells. `prob` is the chance, on each transient that comes
// in, that the root moves on its own by a step or two of the scale.
//
// The root and scale are also the machine's shared tuning for its *tuned
// jumpers*: `dicejumpers` picks delay times as pitches of this root/scale
// when a resonators processor is present — so moving the root here retunes
// the echoes elsewhere, as in the original.
export const RESONATORS_PARAMS = {
    decay: { value: 0.6, min: 0, max: 1 },
    damp: { value: 0.4, min: 0, max: 1 },
    inharm: { value: 0.1, min: 0, max: 1 },
    root: { value: 48, min: 24, max: 72 },
    prob: { value: 0, min: 0, max: 1 },
    mix: { value: 1, min: 0, max: 1 },
};

export const RESONATOR_SCALES = {
    pent_minor: [0, 3, 5, 7, 10],
    pent_major: [0, 2, 4, 7, 9],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    wholetone: [0, 2, 4, 6, 8, 10],
    hirajoshi: [0, 2, 3, 7, 8],
};
const SCALE_NAMES = Object.keys(RESONATOR_SCALES);

export function resonatorsProcessor(Base, DSP) {
    const { SR, clamp, mtof, smoothing, Delay, OnePole, Follower, Rng, effectProcessor } = DSP;
    const DETUNE_SMALL = [0, 9, -13, 21];
    const DETUNE_LARGE = [0, 180, -240, 410];

    return effectProcessor(Base, {
        setup() {
            this.scale = this.opts.scale || [0, 3, 5, 7, 10];
            this.strings = [0, 1, 2, 3].map(() => ({ line: new Delay(Math.ceil(SR / 25) + 8), lp: new OnePole(4000), period: 200 }));
            this.follower = new Follower(0.001, 0.08);
            this.armed = true;
            this.rng = new Rng(0x7e5);
            this.rootOffset = 0;
            this.degree = 0;
            this.glide = 1 - smoothing(0.02);
        },
        onMessage(m) {
            if (m.type === "scale") this.scale = m.scale;
            else if (m.type === "root_offset") this.rootOffset = this.degree = 0;
        },
        render(inL, inR, outL, outR, P, frames) {
            const scale = this.scale;
            const t60 = 0.08 * Math.pow(250, P.decay);
            const cutoff = 200 + 15800 * (1 - P.damp) * (1 - P.damp);
            const inharm = P.inharm;
            for (let s = 0; s < 4; s++) {
                const string = this.strings[s];
                const degree = s * 2;
                const octave = Math.floor(degree / scale.length);
                const pitch = P.root + this.rootOffset + scale[degree % scale.length] + 12 * octave;
                const cents = DETUNE_SMALL[s] * inharm + DETUNE_LARGE[s] * inharm * inharm;
                const freq = mtof(pitch) * Math.pow(2, cents / 1200);
                string.target = SR / freq;
                string.lp.set(Math.min(SR * 0.45, cutoff));
                string.gain = Math.pow(0.001, 1 / (t60 * freq));
            }
            for (let i = 0; i < frames; i++) {
                const x = (inL[i] + inR[i]) * 0.5;
                // Self-moving root: a transient, a dice roll, a step or two.
                const e = this.follower.process(x);
                if (this.armed && e > 0.2) {
                    this.armed = false;
                    if (this.rng.next() < P.prob) {
                        // Wander by one or two scale degrees, staying within
                        // an octave of the root either way.
                        const step = (this.rng.next() < 0.5 ? -1 : 1) * (1 + Math.floor(this.rng.next() * 2));
                        this.degree = clamp(this.degree + step, -scale.length, scale.length);
                        const wrapped = ((this.degree % scale.length) + scale.length) % scale.length;
                        this.rootOffset = scale[wrapped] + 12 * Math.floor(this.degree / scale.length);
                        this.port.postMessage({ type: "root", offset: this.rootOffset });
                    }
                } else if (e < 0.05) this.armed = true;

                let l = 0, r = 0;
                for (let s = 0; s < 4; s++) {
                    const string = this.strings[s];
                    string.period += (string.target - string.period) * this.glide;
                    const back = string.lp.lp(string.line.readHermite(string.period - 1)) * string.gain;
                    const v = x * 0.25 + back;
                    string.line.write(v);
                    if (s & 1) r += v; else l += v;
                }
                const mix = P.mix;
                outL[i] = inL[i] * (1 - mix) + l * mix * 0.7;
                outR[i] = inR[i] * (1 - mix) + r * mix * 0.7;
            }
        },
    });
};

registerWorkletProcessor("ribbit-resonators", resonatorsProcessor, workletParams(RESONATORS_PARAMS));

export class RibbitResonators extends RibbitWorkletProcessor {
    constructor(audioContext, options = {}) {
        const scale = SCALE_NAMES.includes(options.scale) ? options.scale : "pent_minor";
        super(audioContext, { name: "resonators", ...options }, {
            processor: "ribbit-resonators",
            params: RESONATORS_PARAMS,
            processorOptions: { scale: RESONATOR_SCALES[scale] },
        });
        this.llm_summary = "Four tuned strings that ring whatever is fed in (the AE machine's resonators): percussion in, harmony out. root + scale (pent_minor, pent_major, dorian, lydian, wholetone, hirajoshi) pick the four notes; decay (near 1 drones), damp (higher = darker), inharm (chorus → bells), prob (chance a transient moves the root). Also the shared tuning dicejumpers picks delay times from.";
        this.scale = scale;
        // Where the root has wandered to on its own (prob), in semitones.
        this.rootOffset = 0;
        this.options = {
            scale: choiceOption(this, "scale", SCALE_NAMES, (name) => this.send({ type: "scale", scale: RESONATOR_SCALES[name] })),
        };
        this.onWorkletMessage = (message) => {
            if (message.type === "root") this.rootOffset = message.offset;
        };
    };

    // The pitches the tuned jumpers draw from: the current root (where it
    // wandered to included) and scale.
    tuning() {
        return { root: this.params.root.get() + this.rootOffset, scale: RESONATOR_SCALES[this.scale] };
    };

    // A new root, a degree of the scale away.
    jump(random, time) {
        const scale = RESONATOR_SCALES[this.scale];
        const base = 36 + Math.floor(random() * 3) * 12;
        this.setParamAt("root", base + scale[Math.floor(random() * scale.length)], time);
        this.rootOffset = 0;
        this.send({ type: "root_offset" }, time);
    };

    describeState() {
        const { root, scale } = this.tuning();
        const notes = [0, 2, 4, 6].map((d) => root + scale[d % scale.length] + 12 * Math.floor(d / scale.length));
        return `[strings at ${notes.map((n) => Number(n.toFixed(1))).join(", ")}${this.rootOffset ? ` (root wandered ${this.rootOffset > 0 ? "+" : ""}${this.rootOffset})` : ""}]`;
    };
};
