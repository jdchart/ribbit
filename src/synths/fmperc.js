import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// Two-operator FM percussion — the AE machine's FM Voice (`aemd_fm`), "the
// sharp, bell-like, metallic voice of the machine".
//
// A carrier is phase-modulated by a second oscillator at `harm` times its
// frequency. The ratio decides harmonic (whole numbers) or metallic
// (anything between); `index` how many sidebands. What makes it percussion
// rather than a synth patch is that **amplitude and timbre have separate
// envelopes** (`a_dec`, `i_dec`): the sound can stay loud while its
// brightness collapses, which is how a struck object behaves. Both share one
// `curve`.
//
// After the operators: soft `drive`, a wavefolder (`fold`), and `down`, a
// sample-and-hold rate reducer for digital grit. `keytrk` blends from the
// voice's own `pitch` (0) to the note's (1); `n_tmbr` makes higher notes
// brighter by raising the index; velocity raises it too, so a harder hit is
// a brighter one, not just a louder one.
//
// The manual's recipes: wood block harm 2–3, index 2–5, both decays short,
// curve negative. Bell harm ~1.4 or 3.5, index 15–25, a_dec long, i_dec
// short. Metallic click harm > 8, index high, both decays < 40ms, a little
// fold. Tuned tone harm 1 or 2, index < 3, keytrk 1.
export const FMPERC_PARAMS = {
    harm: { value: 2, min: 0.1, max: 16 },
    index: { value: 6, min: 0, max: 50 },
    a_dec: { value: 350, min: 1, max: 4000 },
    i_dec: { value: 80, min: 1, max: 4000 },
    curve: { value: -0.4, min: -0.99, max: 0.99 },
    drive: { value: 0, min: 0, max: 1 },
    fold: { value: 0, min: 0, max: 1 },
    down: { value: 0, min: 0, max: 1 },
    pitch: { value: 60, min: 12, max: 108 },
    keytrk: { value: 1, min: 0, max: 1 },
    n_tmbr: { value: 0.3, min: 0, max: 1 },
    level: { value: 0.7, min: 0, max: 1 },
};

export function fmpercProcessor(Base, DSP) {
    const { SR, TAU, clamp, mtof, tanh, fold, curveEnv, voiceProcessor } = DSP;

    class Voice {
        constructor(m, P) {
            const pitch = P.pitch + P.keytrk * (m.pitch - P.pitch);
            this.fc = mtof(pitch) / SR;
            this.fm = this.fc * P.harm;
            // Higher notes and harder hits raise the index — timbre follows
            // the performance, not only level.
            const noteT = clamp((m.pitch - 60) / 24, -1, 1.5);
            this.index = P.index * Math.max(0, 1 + P.n_tmbr * noteT) * (0.35 + 0.65 * m.velocity);
            this.aLen = Math.max(1, (P.a_dec / 1000) * SR);
            this.iLen = Math.max(1, (P.i_dec / 1000) * SR);
            this.curve = P.curve;
            this.amp = m.velocity * P.level;
            this.drive = P.drive;
            this.driveGain = 1 + P.drive * 6;
            this.driveNorm = 1 / tanh(this.driveGain);
            this.foldAmount = P.fold;
            this.foldGain = 1 + P.fold * 4;
            this.hold = 1 + Math.round(P.down * P.down * 40);
            this.holdCount = 0;
            this.held = 0;
            this.pc = 0;
            this.pm = 0;
            this.n = 0;
        }
        render(L, R, from, to) {
            for (let i = from; i < to; i++) {
                const xa = this.n / this.aLen;
                if (xa >= 1) return false;
                const ampEnv = curveEnv(xa, this.curve);
                const indexEnv = curveEnv(Math.min(1, this.n / this.iLen), this.curve);
                let y = Math.sin(TAU * this.pc + this.index * indexEnv * Math.sin(TAU * this.pm));
                this.pc += this.fc; if (this.pc >= 1) this.pc -= 1;
                this.pm += this.fm; if (this.pm >= 1) this.pm -= 1;
                if (this.drive > 0) y = tanh(y * this.driveGain) * this.driveNorm;
                if (this.foldAmount > 0) y += (fold(y * this.foldGain) - y) * this.foldAmount;
                if (++this.holdCount >= this.hold) {
                    this.held = y;
                    this.holdCount = 0;
                }
                const out = this.held * ampEnv * this.amp;
                L[i] += out;
                R[i] += out;
                this.n++;
            }
            return true;
        }
    }

    return voiceProcessor(Base, (m, P) => new Voice(m, P), 12);
};

registerWorkletProcessor("ribbit-fmperc", fmpercProcessor, workletParams(FMPERC_PARAMS));

export class RibbitFMPerc extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "fmperc", ...options }, {
            processor: "ribbit-fmperc",
            params: FMPERC_PARAMS,
            lane: "5",
            sieve: "4:0",
            quant: true,
        });
        this.llm_summary = "Two-operator FM percussion (the AE machine's FM voice): separate amplitude and index envelopes, so brightness can collapse while the hit stays loud; harm=ratio (whole = harmonic, between = bells/metal), index=brightness, drive/fold/down for grit. Sieve 4:0 on lane 5.";
    };
};
