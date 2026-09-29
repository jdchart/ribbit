import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// A falling sine with two transients — the AE machine's Sub Voice
// (`aemd_sub`), "the oldest trick in electronic percussion".
//
// The pitch envelope is what makes it a drum rather than a bass note: it
// starts `chirp` (up to four octaves) above `pitch` and slides down
// exponentially with time constant `chtime`. **`chtime` is the character**:
// under 20ms a tight modern kick, around 80ms a 909 with a tail, over 200ms a
// falling tone that stops being percussion.
//
// On top: a `click` (band-passed noise at `cfreq`, the skin) and a `spike`
// (a resonant ping at `sfreq`, re-rolled ±7% per hit so no two are the same).
// Then `drive` (1..8, before the filter), `cut` (lowpass on the output), and
// `width`, which runs the right channel's sine a quarter-cycle-times-width out
// of phase with the left.
export const SUBDRUM_PARAMS = {
    pitch: { value: 33, min: 18, max: 60 },
    chirp: { value: 0.5, min: 0, max: 1 },
    chtime: { value: 45, min: 5, max: 300 },
    attack: { value: 1, min: 0, max: 50 },
    decay: { value: 420, min: 50, max: 1500 },
    click: { value: 0.3, min: 0, max: 1 },
    cfreq: { value: 2500, min: 500, max: 8000 },
    cdecay: { value: 18, min: 5, max: 200 },
    spike: { value: 0.1, min: 0, max: 1 },
    sfreq: { value: 9000, min: 4000, max: 14000 },
    sdecay: { value: 20, min: 5, max: 120 },
    drive: { value: 1.5, min: 1, max: 8 },
    cut: { value: 2500, min: 200, max: 4000 },
    width: { value: 0, min: 0, max: 1 },
    level: { value: 0.8, min: 0, max: 1 },
};

export function subdrumProcessor(Base, DSP) {
    const { SR, TAU, mtof, tanh, t60, SVF, Resonator, OnePole, Rng, voiceProcessor } = DSP;
    const rng = new Rng(0x5ab);

    class Voice {
        constructor(m, P) {
            this.f0 = mtof(P.pitch);
            this.chirpOct = P.chirp * 4;
            this.sweep = Math.exp(-1 / Math.max(1, (P.chtime / 1000) * SR));
            this.sweepState = 1;
            this.attack = Math.max(1, (P.attack / 1000) * SR);
            this.decayMul = t60(P.decay / 1000);
            this.env = 1;
            this.clickAmp = P.click;
            this.clickFilter = new SVF(P.cfreq, 1.4);
            this.clickMul = t60(P.cdecay / 1000);
            this.clickEnv = 1;
            this.spike = new Resonator(Math.min(SR * 0.45, P.sfreq * (1 + (rng.next() - 0.5) * 0.14)), P.sdecay / 1000);
            this.spikeAmp = P.spike;
            this.spikeKicked = false;
            this.drive = P.drive;
            this.driveNorm = 1 / tanh(P.drive);
            this.cutL = new OnePole(P.cut);
            this.cutR = new OnePole(P.cut);
            this.width = P.width;
            this.amp = P.level * m.velocity;
            this.noise = new Rng((rng.next() * 4294967296) >>> 0);
            this.phase = 0;
            this.n = 0;
        }
        render(L, R, from, to) {
            for (let i = from; i < to; i++) {
                const a = this.n < this.attack ? this.n / this.attack : 1;
                if (this.n >= this.attack) this.env *= this.decayMul;
                if (this.env < 1e-4) return false;
                this.sweepState *= this.sweep;
                const freq = this.f0 * Math.pow(2, this.chirpOct * this.sweepState);
                this.phase += freq / SR;
                if (this.phase >= 1) this.phase -= 1;
                const env = a * this.env;
                const sineL = Math.sin(TAU * this.phase);
                const sineR = this.width > 0 ? Math.sin(TAU * (this.phase + this.width * 0.25)) : sineL;

                this.clickEnv *= this.clickMul;
                this.clickFilter.process(this.noise.bi());
                const click = this.clickFilter.band * this.clickEnv * this.clickAmp * 2.5;
                let spike = 0;
                if (this.spikeAmp > 0) {
                    spike = this.spike.process(this.spikeKicked ? 0 : 1) * this.spikeAmp * 0.6;
                    this.spikeKicked = true;
                }
                const transient = click + spike;
                let l = tanh((sineL * env + transient) * this.drive) * this.driveNorm;
                let r = tanh((sineR * env + transient) * this.drive) * this.driveNorm;
                l = this.cutL.lp(l);
                r = this.cutR.lp(r);
                L[i] += l * this.amp;
                R[i] += r * this.amp;
                this.n++;
            }
            return true;
        }
    }

    return voiceProcessor(Base, (m, P) => new Voice(m, P), 6);
};

registerWorkletProcessor("ribbit-subdrum", subdrumProcessor, workletParams(SUBDRUM_PARAMS));

export class RibbitSubDrum extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "subdrum", ...options }, {
            processor: "ribbit-subdrum",
            params: SUBDRUM_PARAMS,
            lane: "5",
            sieve: "5:4",
        });
        this.llm_summary = "A falling sine with a noise click and a random-pitched spike (the AE machine's sub voice). chtime is the character: <20ms tight kick, ~80ms 909 tail, >200ms a falling tone. Pitch is the voice's own, not the note's. Sieve 5:4 on lane 5.";
    };
};
