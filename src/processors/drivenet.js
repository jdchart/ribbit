import { RibbitWorkletProcessor, tunedDelay } from "../dsp/effect.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// Four delay lines at irrational ratios, folded and saturated, feeding each
// other — the AE machine's Drive (`aem_fx_drive`). Rough rather than warm.
//
// The lines run at `time` × 1, √2, φ and √5 (ratios that never share a
// period, so the echoes never re-align into a rhythm). Each loop has a lowpass
// (`damp`, Hz) and a wavefolder (`drive` — harsh upper harmonics, not valve
// warmth). `cross` is how much each line *subtracts* the others: from four
// separate echoes to one diffuse mess. Under ~30ms the network is a metallic
// resonance; over ~100ms a dense echo. `noise` adds noise that only appears
// when signal does (the tape illusion), `width` spreads the return, `out`
// trims it (dB).
export const DRIVENET_PARAMS = {
    time: { value: 45, min: 1, max: 500 },
    feedback: { value: 0.55, min: 0, max: 0.95 },
    damp: { value: 5000, min: 300, max: 16000 },
    drive: { value: 0.3, min: 0, max: 1 },
    cross: { value: 0.3, min: 0, max: 1 },
    noise: { value: 0.05, min: 0, max: 1 },
    width: { value: 0.7, min: 0, max: 1 },
    mix: { value: 1, min: 0, max: 1 },
    out: { value: 0, min: -24, max: 12 },
};

export function drivenetProcessor(Base, DSP) {
    const { SR, fold, tanh, smoothing, Delay, OnePole, Follower, Rng, effectProcessor } = DSP;
    const RATIOS = [1, Math.SQRT2, 1.6180339887, 2.2360679775];

    return effectProcessor(Base, {
        setup() {
            this.lines = RATIOS.map(() => new Delay(Math.ceil(0.5 * 2.3 * SR) + 8));
            this.lps = RATIOS.map(() => new OnePole(5000));
            this.hps = RATIOS.map(() => new OnePole(40));
            this.outs = new Float64Array(4);
            this.time = 0.045 * SR;
            this.glide = 1 - smoothing(0.08);
            this.follower = new Follower(0.002, 0.15);
            this.rng = new Rng(0xd41);
        },
        render(inL, inR, outL, outR, P, frames) {
            for (let k = 0; k < 4; k++) this.lps[k].set(P.damp);
            const target = (P.time / 1000) * SR;
            const fb = P.feedback;
            const driveGain = 1 + P.drive * 5;
            const cross = P.cross;
            const mix = P.mix;
            const out = Math.pow(10, P.out / 20);
            const width = P.width;
            for (let i = 0; i < frames; i++) {
                this.time += (target - this.time) * this.glide;
                const x = (inL[i] + inR[i]) * 0.5;
                const env = this.follower.process(x);
                let mean = 0;
                for (let k = 0; k < 4; k++) {
                    this.outs[k] = this.lps[k].lp(this.lines[k].read(Math.max(1, this.time * RATIOS[k])));
                    mean += this.outs[k];
                }
                mean *= 0.25;
                const hiss = this.rng.bi() * env * P.noise * 0.5;
                for (let k = 0; k < 4; k++) {
                    // `cross` blends each line towards the Householder mix
                    // (I - 2/N·11ᵀ): orthogonal, so however much the lines
                    // subtract from each other the loop gain stays at
                    // `feedback`, never above it.
                    const mixed = this.outs[k] - 2 * cross * mean;
                    let v = x + hiss + mixed * fb;
                    // Fold scaled back to unity slope: drive adds harmonics to
                    // loud signal without raising the loop's small-signal gain
                    // (which would make it oscillate), then a soft clip bounds
                    // the level whatever feedback and drive agree to.
                    v = tanh(fold(v * driveGain) / driveGain);
                    this.lines[k].write(this.hps[k].hp(v));
                }
                const l = this.outs[0] + this.outs[2] * (0.5 + 0.5 * (1 - width)) + this.outs[1] * (0.5 - 0.5 * width);
                const r = this.outs[1] + this.outs[3] * (0.5 + 0.5 * (1 - width)) + this.outs[2] * (0.5 - 0.5 * width);
                // The fold/driveGain normalisation makes a driven network
                // quieter; give most of that back on the way out.
                const makeup = 0.8 * Math.sqrt(driveGain);
                outL[i] = inL[i] * (1 - mix) + l * makeup * out * mix;
                outR[i] = inR[i] * (1 - mix) + r * makeup * out * mix;
            }
        },
    });
};

registerWorkletProcessor("ribbit-drivenet", drivenetProcessor, workletParams(DRIVENET_PARAMS));

export class RibbitDriveNet extends RibbitWorkletProcessor {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "drivenet", ...options }, { processor: "ribbit-drivenet", params: DRIVENET_PARAMS });
        this.llm_summary = "Four delay lines at irrational ratios, wavefolded and feeding each other (the AE machine's drive): time (ms; <30 metallic resonance, >100 dense echo), feedback, damp (Hz), drive (fold), cross (lines subtract each other: echoes -> diffuse mess), noise that follows the signal, width, out (dB).";
    };

    // The Drive jumper: a delay time in tune, and a new drive.
    jump(random, time, tuning) {
        this.setParamAt("time", tunedDelay(random, tuning, 0.004, 0.4) * 1000, time);
        this.setParamAt("drive", random() * 0.8, time);
    };
};
