import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// Rim shot / clap / snare in one voice — the AE machine's Crack Voice
// (`aemd_crk`).
//
// **The trick is `cracks`**: one burst of band-passed noise reads as a rim
// shot; two, three, four bursts a few milliseconds apart (`spread`, 4..16ms)
// with the last one longer (`nse_dcy`, 30..400ms) is the anatomy of a hand
// clap. Under the noise a tuned `body` (a sine at `pitch` with a small pitch
// drop, decaying over `bdy_dcy`), and `rattle`: snare wires, two short
// feedback delay lines driven by the body's motion that buzz. `width`
// decorrelates the noise left/right.
//
// Recipes (manual): rim shot cracks 0, tone 0.7, q 0.8, body 0.4, rattle 0,
// short decay. Clap cracks 1, spread 0.5, nse_dcy 0.4, body 0, rattle 0.2.
// Snare cracks 0.3, body 0.6, rattle 0.7, tone 0.4.
export const CRACK_PARAMS = {
    cracks: { value: 0.3, min: 0, max: 1 },
    spread: { value: 0.5, min: 0, max: 1 },
    nse_dcy: { value: 0.35, min: 0, max: 1 },
    tone: { value: 0.45, min: 0, max: 1 },
    q: { value: 0.3, min: 0, max: 1 },
    body: { value: 0.5, min: 0, max: 1 },
    pitch: { value: 55, min: 40, max: 72 },
    bdy_dcy: { value: 0.35, min: 0, max: 1 },
    rattle: { value: 0.5, min: 0, max: 1 },
    width: { value: 0.4, min: 0, max: 1 },
    drive: { value: 0.1, min: 0, max: 1 },
    level: { value: 0.7, min: 0, max: 1 },
};

export function crackProcessor(Base, DSP) {
    const { SR, TAU, mtof, registerPitch, tanh, t60, SVF, OnePole, Delay, Rng, voiceProcessor } = DSP;
    const seeds = new Rng(0xc4ac);

    class Voice {
        constructor(m, P) {
            this.count = 1 + Math.round(P.cracks * 3);
            this.gap = Math.round(((4 + P.spread * 12) / 1000) * SR);
            this.shortMul = t60(0.012);
            this.longMul = t60((30 + P.nse_dcy * 370) / 1000);
            this.burst = 0;       // index of the burst currently sounding
            this.burstEnv = 0;
            const toneHz = 500 * Math.pow(8, P.tone);
            const q = 0.5 + P.q * 7;
            this.bandL = new SVF(toneHz, q);
            this.bandR = new SVF(toneHz, q);
            this.noiseGain = Math.sqrt(q) * 0.9;
            this.width = P.width;
            this.noise = new Rng((seeds.next() * 4294967296) >>> 0);

            // With QUANT on the body takes the note's pitch class, in the
            // register `pitch` sets (and snapped to the tuning upstream);
            // otherwise it's `pitch` itself. A short drop gives it a
            // stick-on-skin attack.
            this.bodyHz = mtof(m.useNote ? registerPitch(P.pitch, m.pitch) : P.pitch);
            this.bodyAmp = P.body;
            this.bodyMul = t60((10 + P.bdy_dcy * 390) / 1000);
            this.bodyEnv = 1;
            this.drop = 1;
            this.dropMul = Math.exp(-1 / (0.012 * SR));
            this.phase = 0;

            // Snare wires: two short lines (2.3ms, 3.7ms) fed by the body's
            // motion plus a little noise, recirculating through a lowpass.
            this.rattle = P.rattle;
            this.wireA = new Delay(Math.ceil(0.004 * SR));
            this.wireB = new Delay(Math.ceil(0.005 * SR));
            this.wireLp = new OnePole(5200);
            this.wireHp = new OnePole(900);
            this.wireFb = 0.55 + P.rattle * 0.35;

            this.driveGain = 1 + P.drive * 6;
            this.driveNorm = 1 / tanh(this.driveGain);
            this.amp = P.level * m.velocity;
            this.n = 0;
            this.quiet = 0;
        }
        render(L, R, from, to) {
            const dA = 0.0023 * SR;
            const dB = 0.0037 * SR;
            for (let i = from; i < to; i++) {
                // Burst sequencing: each burst restarts the envelope at the
                // next gap; the last one takes the long decay.
                if (this.burst < this.count && this.n === this.burst * this.gap) {
                    this.burstEnv = 1;
                    this.burst++;
                }
                const isLast = this.burst >= this.count;
                this.burstEnv *= isLast ? this.longMul : this.shortMul;

                const common = this.noise.bi();
                const left = common * (1 - this.width) + this.noise.bi() * this.width;
                const right = common * (1 - this.width) + this.noise.bi() * this.width;
                this.bandL.process(left);
                this.bandR.process(right);
                const noiseEnv = this.burstEnv * this.noiseGain;

                this.drop *= this.dropMul;
                this.phase += (this.bodyHz * (1 + 0.25 * this.drop)) / SR;
                if (this.phase >= 1) this.phase -= 1;
                this.bodyEnv *= this.bodyMul;
                const body = Math.sin(TAU * this.phase) * this.bodyEnv * this.bodyAmp;

                let wires = 0;
                if (this.rattle > 0) {
                    const drive = body * 0.8 + common * this.bodyEnv * 0.15;
                    const fb = this.wireLp.lp((this.wireA.read(dA) + this.wireB.read(dB)) * 0.5);
                    const v = tanh(drive + fb * this.wireFb);
                    this.wireA.write(v);
                    this.wireB.write(-v);
                    wires = this.wireHp.hp(v) * this.rattle * 1.4;
                }

                let l = this.bandL.band * noiseEnv + body + wires;
                let r = this.bandR.band * noiseEnv + body + wires;
                l = tanh(l * this.driveGain) * this.driveNorm * this.amp;
                r = tanh(r * this.driveGain) * this.driveNorm * this.amp;
                L[i] += l;
                R[i] += r;
                this.n++;
                if (isLast && Math.abs(l) + Math.abs(r) < 2e-5) {
                    if (++this.quiet > 1024) return false;
                } else this.quiet = 0;
            }
            return true;
        }
    }

    return voiceProcessor(Base, (m, P) => new Voice(m, P), 8);
};

registerWorkletProcessor("ribbit-crack", crackProcessor, workletParams(CRACK_PARAMS));

export class RibbitCrack extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "crack", ...options }, {
            processor: "ribbit-crack",
            params: CRACK_PARAMS,
            lane: "5",
            sieve: "7:3",
            quant: true,
        });
        this.llm_summary = "Rim shot to clap to snare (the AE machine's crack voice): cracks sets 1-4 noise bursts (1 = rim, 4 = clap), spread their gap, a tuned body and rattle (snare wires). Sieve 7:3 on lane 5.";
    };

    // With QUANT on, the body plays the note (snapped to the tuning);
    // otherwise it's the voice's own `pitch`, as in the original.
    noteExtras() {
        return { useNote: this.quant };
    };
};
