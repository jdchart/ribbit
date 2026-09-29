import { RibbitWorkletProcessor } from "../dsp/effect.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// A three-band compressor with a ducker on every band — the AE machine's
// Breathe (`aem_fx_breathe`), "what makes the low end move out of the way".
// In the original it's the insert on the pads' parallel bus; here, put it on
// whatever bus the pads (`tapedrone`, a `deeppad` bus) run through.
//
// Linkwitz-Riley crossovers at `x_lo` and `x_hi` split three bands; each is
// compressed (`thr` dB, `ratio`, `attack`/`release` ms — a long release is
// the pumping this is named for) and `depth` is how much of that
// compression is applied (its dry/wet).
//
// **The duck needs a key.** `key` is a sidechain: patch the drums into it —
// `/patch source=kick dest=breathe.key depth=1` — and every hit ducks the
// three bands by `duck_lo`/`duck_mid`/`duck_hi` (high, medium, low is the
// classic setting: the bass makes way, the air barely moves), recovering over
// `d_rel` ms. It's an audio-rate param, so what arrives is the kick's
// signal, not a control value. `out` trims (dB). Its jumper re-rolls the
// duck depths and fires one duck on its own.
export const BREATHE_PARAMS = {
    x_lo: { value: 220, min: 40, max: 1000 },
    x_hi: { value: 2500, min: 1000, max: 10000 },
    thr: { value: -24, min: -60, max: 0 },
    ratio: { value: 3, min: 1, max: 20 },
    depth: { value: 0.6, min: 0, max: 1 },
    attack: { value: 10, min: 0.1, max: 100 },
    release: { value: 250, min: 10, max: 2000 },
    duck_lo: { value: 0.7, min: 0, max: 1 },
    duck_mid: { value: 0.4, min: 0, max: 1 },
    duck_hi: { value: 0.1, min: 0, max: 1 },
    d_rel: { value: 300, min: 10, max: 2000 },
    out: { value: 0, min: -24, max: 12 },
    key: { value: 0, min: -1, max: 1, rate: "a-rate", randomizable: false },
};

export function breatheProcessor(Base, DSP) {
    const { SR, Biquad, effectProcessor } = DSP;

    // One channel's crossover: LR4 (two Butterworth biquads in series) low
    // and high at x_lo, then the upper part split again at x_hi.
    class Split {
        constructor() {
            this.lo = [new Biquad("lowpass", 200, 0.7071), new Biquad("lowpass", 200, 0.7071)];
            this.rest = [new Biquad("highpass", 200, 0.7071), new Biquad("highpass", 200, 0.7071)];
            this.mid = [new Biquad("lowpass", 2500, 0.7071), new Biquad("lowpass", 2500, 0.7071)];
            this.hi = [new Biquad("highpass", 2500, 0.7071), new Biquad("highpass", 2500, 0.7071)];
            this.out = new Float64Array(3);
        }
        set(xlo, xhi) {
            for (const f of this.lo) f.set("lowpass", xlo, 0.7071);
            for (const f of this.rest) f.set("highpass", xlo, 0.7071);
            for (const f of this.mid) f.set("lowpass", xhi, 0.7071);
            for (const f of this.hi) f.set("highpass", xhi, 0.7071);
        }
        process(x) {
            const low = this.lo[1].process(this.lo[0].process(x));
            const rest = this.rest[1].process(this.rest[0].process(x));
            this.out[0] = low;
            this.out[1] = this.mid[1].process(this.mid[0].process(rest));
            this.out[2] = this.hi[1].process(this.hi[0].process(rest));
            return this.out;
        }
    }

    return effectProcessor(Base, {
        setup() {
            this.left = new Split();
            this.right = new Split();
            this.levels = new Float64Array(3);   // per-band detector, linear
            this.keyEnv = 0;
            this.xlo = -1;
            this.xhi = -1;
        },
        onMessage(m) {
            if (m.type === "duck_now") this.keyEnv = 1;
        },
        render(inL, inR, outL, outR, P, frames, parameters) {
            if (P.x_lo !== this.xlo || P.x_hi !== this.xhi) {
                this.xlo = P.x_lo;
                this.xhi = Math.max(P.x_hi, P.x_lo * 1.5);
                this.left.set(this.xlo, this.xhi);
                this.right.set(this.xlo, this.xhi);
            }
            const key = parameters.key;
            const keyIsBlock = key.length === 1;
            const attack = Math.exp(-1 / ((P.attack / 1000) * SR));
            const release = Math.exp(-1 / ((P.release / 1000) * SR));
            const duckRelease = Math.exp(-1 / ((P.d_rel / 1000) * SR));
            const duckAttack = Math.exp(-1 / (0.001 * SR));
            const threshold = Math.pow(10, P.thr / 20);
            const slope = 1 - 1 / P.ratio;
            const out = Math.pow(10, P.out / 20);
            const ducks = [P.duck_lo, P.duck_mid, P.duck_hi];
            for (let i = 0; i < frames; i++) {
                const k = Math.abs(keyIsBlock ? key[0] : key[i]);
                this.keyEnv = k > this.keyEnv ? k + (this.keyEnv - k) * duckAttack : this.keyEnv * duckRelease;
                const keyed = Math.min(1, this.keyEnv * 4);
                const bl = this.left.process(inL[i]);
                const br = this.right.process(inR[i]);
                let l = 0, r = 0;
                for (let b = 0; b < 3; b++) {
                    const level = Math.max(Math.abs(bl[b]), Math.abs(br[b]));
                    const current = this.levels[b];
                    this.levels[b] = level > current ? level + (current - level) * attack : level + (current - level) * release;
                    let gain = 1;
                    if (this.levels[b] > threshold) {
                        // Gain reduction in dB, scaled back by depth.
                        const over = 20 * Math.log10(this.levels[b] / threshold);
                        gain = Math.pow(10, (-over * slope * P.depth) / 20);
                    }
                    gain *= 1 - ducks[b] * keyed;
                    l += bl[b] * gain;
                    r += br[b] * gain;
                }
                outL[i] = l * out;
                outR[i] = r * out;
            }
        },
    });
};

registerWorkletProcessor("ribbit-breathe", breatheProcessor, workletParams(BREATHE_PARAMS));

export class RibbitBreathe extends RibbitWorkletProcessor {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "breathe", ...options }, { processor: "ribbit-breathe", params: BREATHE_PARAMS });
        this.llm_summary = "A three-band compressor with a ducker per band (the AE machine's breathe): crossovers x_lo/x_hi, thr/ratio/attack/release/depth, and duck_lo/duck_mid/duck_hi keyed by the audio-rate `key` param — patch the drums into it (/patch source=kick dest=breathe.key depth=1) so the pads get out of their way. d_rel recovery, out dB.";
    };

    // The Breath jumper: new duck depths, and one duck now.
    jump(random, time) {
        this.setParamAt("duck_lo", 0.3 + random() * 0.7, time);
        this.setParamAt("duck_mid", random() * 0.6, time);
        this.setParamAt("duck_hi", random() * 0.3, time);
        this.send({ type: "duck_now" }, time);
    };
};
