import { RibbitWorkletProcessor } from "../dsp/effect.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams, toggleOption, isOn } from "../dsp/spec.js";

// A reverb that doesn't pretend to be a room, and can be frozen solid — the
// AE machine's Notverb (`aem_fx_notverb`). "Freeze is the reason this module
// exists: catch a moment, hold it as a drone, keep playing over it, release."
//
// An eight-line feedback delay network (Hadamard-mixed, lightly modulated so
// it doesn't ring metallic) after four input diffusers. `size` scales every
// line — moving it while sound is in there *bends the tail*, since the lines
// are read with a glide rather than jumped. `decay` is the tail's T60, 0.3s
// up to a minute; `damp` absorbs highs in every loop.
//
// **`freeze=on`** sets the loop gain to exactly one, takes the absorption out
// and closes the input — each over 40ms, so there's no click either way — and
// the tank recirculates forever. A frozen notverb keeps sounding after every
// voice has stopped; that's the texture, not a stuck note (`mix` is the
// control that silences it). The `dicejumpers` jumper throws freezes on its
// own, for a random while, without touching the `freeze` option.
export const NOTVERB_PARAMS = {
    size: { value: 0.5, min: 0, max: 1 },
    decay: { value: 0.5, min: 0, max: 1 },
    damp: { value: 0.4, min: 0, max: 1 },
    mix: { value: 1, min: 0, max: 1 },
};

export function notverbProcessor(Base, DSP) {
    const { SR, TAU, smoothing, Delay, OnePole, Allpass, effectProcessor } = DSP;
    const LINES_MS = [29.7, 37.1, 41.1, 43.7, 53.9, 59.3, 67.9, 73.3];
    const N = 8;

    // In-place fast Walsh-Hadamard transform, normalised (orthogonal: the
    // loop is exactly lossless at gain 1, which is what makes freeze hold).
    const hadamard = (v) => {
        for (let len = 1; len < N; len <<= 1) {
            for (let i = 0; i < N; i += len << 1) {
                for (let j = i; j < i + len; j++) {
                    const a = v[j], b = v[j + len];
                    v[j] = a + b;
                    v[j + len] = a - b;
                }
            }
        }
        const k = 1 / Math.sqrt(N);
        for (let i = 0; i < N; i++) v[i] *= k;
    };

    return effectProcessor(Base, {
        setup() {
            this.lines = LINES_MS.map((ms) => new Delay(Math.ceil(ms * 0.001 * SR * 2.2) + 16));
            this.damps = LINES_MS.map(() => new OnePole(8000));
            this.diffusers = [0.0047, 0.0071, 0.0113, 0.0149].map((t) => new Allpass(Math.round(t * SR), 0.62));
            this.v = new Float64Array(N);
            this.scale = 1;
            this.glide = 1 - smoothing(0.3);
            this.frozen = !!this.opts.freeze;
            this.jumpUntil = 0;
            this.freezeAmount = this.frozen ? 1 : 0;
            this.freezeStep = 1 / (0.04 * SR);
            this.modPhase = 0;
            this.frame = 0;
        },
        onMessage(m, offset) {
            if (m.type === "freeze") this.frozen = m.on;
            else if (m.type === "freeze_for") this.jumpUntil = this.frame + offset + m.seconds * SR;
        },
        render(inL, inR, outL, outR, P, frames) {
            const t60 = 0.3 * Math.pow(200, P.decay);
            const cutoff = 500 + 19500 * (1 - P.damp) * (1 - P.damp);
            for (const d of this.damps) d.set(Math.min(SR * 0.45, cutoff));
            const targetScale = 0.35 + P.size * 1.65;
            const mix = P.mix;
            const v = this.v;
            // Loop gains per block (the lines' lengths move slowly), not per
            // sample: eight pow() calls a sample adds up.
            const gains = this.gains || (this.gains = new Float64Array(N));
            for (let k = 0; k < N; k++) gains[k] = Math.pow(0.001, (LINES_MS[k] * 0.001 * this.scale) / t60);
            for (let i = 0; i < frames; i++) {
                this.frame++;
                const frozen = this.frozen || this.frame < this.jumpUntil;
                this.freezeAmount += frozen ? this.freezeStep : -this.freezeStep;
                if (this.freezeAmount < 0) this.freezeAmount = 0;
                else if (this.freezeAmount > 1) this.freezeAmount = 1;
                const f = this.freezeAmount;
                this.scale += (targetScale - this.scale) * this.glide;
                this.modPhase += 0.37 / SR;
                if (this.modPhase >= 1) this.modPhase -= 1;
                const wobble = Math.sin(TAU * this.modPhase) * 0.0003 * SR;

                let x = (inL[i] + inR[i]) * 0.5 * (1 - f);
                for (let a = 0; a < 4; a++) x = this.diffusers[a].process(x);

                for (let k = 0; k < N; k++) {
                    const length = LINES_MS[k] * 0.001 * SR * this.scale + (k & 1 ? wobble : -wobble);
                    const raw = this.lines[k].read(length);
                    const damped = this.damps[k].lp(raw);
                    // Frozen: no absorption, no loss.
                    const g = gains[k];
                    v[k] = (damped + (raw - damped) * f) * (g + (1 - g) * f);
                }
                let l = 0, r = 0;
                for (let k = 0; k < N; k++) if (k & 1) r += v[k]; else l += v[k];
                hadamard(v);
                for (let k = 0; k < N; k++) this.lines[k].write(v[k] + x * 0.35);
                outL[i] = inL[i] * (1 - mix) + l * 0.45 * mix;
                outR[i] = inR[i] * (1 - mix) + r * 0.45 * mix;
            }
        },
    });
};

registerWorkletProcessor("ribbit-notverb", notverbProcessor, workletParams(NOTVERB_PARAMS));

export class RibbitNotverb extends RibbitWorkletProcessor {
    constructor(audioContext, options = {}) {
        const freeze = isOn(options.freeze, false);
        super(audioContext, { name: "notverb", ...options }, {
            processor: "ribbit-notverb",
            params: NOTVERB_PARAMS,
            processorOptions: { freeze },
        });
        this.llm_summary = "A freezable reverb (the AE machine's notverb): an eight-line FDN; size bends the tail when moved, decay up to a minute, damp. freeze=on holds the tank forever and closes the input (click-free) — it keeps sounding with every voice stopped; mix silences it. Its jumper throws timed freezes.";
        this.freeze = freeze;
        this.options = {
            freeze: toggleOption(this, "freeze", (on) => this.send({ type: "freeze", on })),
        };
    };

    // The Notverb jumper: freeze, for a while.
    jump(random, time) {
        this.send({ type: "freeze_for", seconds: 1.5 + random() * 8 }, time);
    };
};
