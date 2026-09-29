import { RibbitWorkletProcessor } from "../dsp/effect.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// A short tuned delay that bursts into resonance when a drum hits it — the
// AE machine's Micro Delays (`aem_fx_mdelay`, two instances, A and B). IDM
// stutter, but tuned.
//
// `tap` (ms) is the delay, so the pitch of the comb. Inside the loop a
// bandpass is locked to an exact harmonic of that delay (`tone` = which
// harmonic, 1..8), so the resonance always sings in tune with the comb
// rather than fighting it; `reso` is how much it rings. When a transient
// arrives and the dice allow it (`stut`, %), the feedback opens to `fb` for
// `burst` ms and the delay rings; otherwise it barely repeats. On every hit
// the left and right taps are re-scattered (`scat_l`/`scat_r`), so the image
// jumps. `crush` reduces the sample rate of the return, `level` sets it, and
// `dry` passes the input through (0 on a send bus).
//
// The original feeds each instance from six voices with its own dials; here
// that's six sends into the bus it sits on. Two of them with different
// tunings and stutter chances is the manual's call and response.
export const MICRODELAY_PARAMS = {
    tap: { value: 12, min: 1, max: 100 },
    fb: { value: 0.85, min: 0, max: 0.98 },
    stut: { value: 40, min: 0, max: 100 },
    burst: { value: 180, min: 10, max: 1000 },
    scat_l: { value: 0.3, min: 0, max: 1 },
    scat_r: { value: 0.3, min: 0, max: 1 },
    reso: { value: 0.5, min: 0, max: 1 },
    tone: { value: 2, min: 1, max: 8 },
    crush: { value: 0, min: 0, max: 1 },
    level: { value: 0.8, min: 0, max: 1 },
    dry: { value: 0, min: 0, max: 1 },
};

export function microdelayProcessor(Base, DSP) {
    const { SR, tanh, smoothing, Delay, SVF, Follower, Rng, effectProcessor } = DSP;

    return effectProcessor(Base, {
        setup() {
            this.lineL = new Delay(Math.ceil(0.14 * SR));
            this.lineR = new Delay(Math.ceil(0.14 * SR));
            this.bandL = new SVF(1000, 4);
            this.bandR = new SVF(1000, 4);
            this.follower = new Follower(0.0005, 0.05);
            this.armed = true;
            this.rng = new Rng(0x3d1a);
            this.burstLeft = 0;
            this.feedback = 0.15;
            this.scatterL = 1;
            this.scatterR = 1;
            this.tapL = 0.012 * SR;
            this.tapR = 0.012 * SR;
            this.glide = 1 - smoothing(0.004);
            this.holdCount = 0;
            this.heldL = 0;
            this.heldR = 0;
        },
        render(inL, inR, outL, outR, P, frames) {
            const tap = (P.tap / 1000) * SR;
            const harmonic = Math.max(1, Math.round(P.tone));
            const bandHz = Math.min(SR * 0.45, (harmonic * 1000) / P.tap);
            const q = 1 + P.reso * 20;
            this.bandL.set(bandHz, q);
            this.bandR.set(bandHz * 1.003, q);
            const burst = (P.burst / 1000) * SR;
            const hold = 1 + Math.round(P.crush * P.crush * 24);
            for (let i = 0; i < frames; i++) {
                const x = (inL[i] + inR[i]) * 0.5;
                const env = this.follower.process(x);
                // A hit: re-scatter the taps, and maybe open a burst.
                if (this.armed && env > 0.15) {
                    this.armed = false;
                    this.scatterL = 1 + (this.rng.next() - 0.5) * P.scat_l * 0.6;
                    this.scatterR = 1 + (this.rng.next() - 0.5) * P.scat_r * 0.6;
                    if (this.rng.next() * 100 < P.stut) this.burstLeft = burst;
                } else if (env < 0.04) this.armed = true;
                const open = this.burstLeft > 0;
                if (open) this.burstLeft--;
                this.feedback += ((open ? P.fb : 0.15) - this.feedback) * 0.003;
                this.tapL += (tap * this.scatterL - this.tapL) * this.glide;
                this.tapR += (tap * this.scatterR - this.tapR) * this.glide;

                const yl = this.lineL.read(Math.max(1, this.tapL));
                const yr = this.lineR.read(Math.max(1, this.tapR));
                this.bandL.process(yl);
                this.bandR.process(yr);
                const rl = yl + (this.bandL.band * this.bandL.k * 1.5 - yl) * P.reso;
                const rr = yr + (this.bandR.band * this.bandR.k * 1.5 - yr) * P.reso;
                this.lineL.write(inL[i] + tanh(rl * this.feedback));
                this.lineR.write(inR[i] + tanh(rr * this.feedback));
                if (++this.holdCount >= hold) {
                    this.holdCount = 0;
                    this.heldL = yl;
                    this.heldR = yr;
                }
                outL[i] = inL[i] * P.dry + this.heldL * P.level;
                outR[i] = inR[i] * P.dry + this.heldR * P.level;
            }
        },
    });
};

registerWorkletProcessor("ribbit-microdelay", microdelayProcessor, workletParams(MICRODELAY_PARAMS));

export class RibbitMicroDelay extends RibbitWorkletProcessor {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "microdelay", ...options }, { processor: "ribbit-microdelay", params: MICRODELAY_PARAMS });
        this.llm_summary = "A short tuned delay that bursts into resonance on hits (the AE machine's micro delays): tap ms = comb pitch, a bandpass locked to harmonic `tone` of it (reso), and on each transient with chance stut% the feedback opens to fb for burst ms; scat_l/scat_r re-scatter the taps per hit; crush; level; dry. Use two, differently tuned, for call and response.";
    };
};
