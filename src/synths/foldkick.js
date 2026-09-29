import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams, choiceOption } from "../dsp/spec.js";

const WAVES = ["sine", "triangle", "saw", "square"];

// One oscillator with a pitch sweep, a wavefolder and a compressor — the AE
// machine's Kick Voice (`aemd_v1b`). It lives on lane 6 beside Big Modal and
// splits it with it by parity (`sieve=even` here, `odd` there — the manual's
// CH control; `all` takes every note).
//
// `pitch` is the fundamental in Hz and comes from the voice, not the note
// (a kick shouldn't play melodies). `chirp` starts the sweep up to eight
// times above it, falling over `chtime`; `attack` softens the transient,
// `punch` holds the envelope at full before `decay` begins. `body` is
// wavefolding plus asymmetric saturation (grain and harmonics), `sub` a second
// oscillator an octave down with a slower envelope, `noise` noise on the
// attack only, `boost` emphasises the fundamental, and `comp` a fast built-in
// compressor with makeup.
export const FOLDKICK_PARAMS = {
    pitch: { value: 48, min: 18, max: 120 },
    chirp: { value: 0.45, min: 0, max: 1 },
    chtime: { value: 35, min: 5, max: 150 },
    attack: { value: 0.5, min: 0, max: 30 },
    punch: { value: 12, min: 0, max: 60 },
    decay: { value: 450, min: 50, max: 2500 },
    body: { value: 0.2, min: 0, max: 1 },
    sub: { value: 0.2, min: 0, max: 1 },
    noise: { value: 0.1, min: 0, max: 1 },
    boost: { value: 0.3, min: 0, max: 1 },
    comp: { value: 0.3, min: 0, max: 1 },
    level: { value: 0.8, min: 0, max: 1 },
};

export function foldkickProcessor(Base, DSP) {
    const { SR, TAU, tanh, fold, asym, t60, OnePole, Follower, Rng, voiceProcessor } = DSP;
    const seeds = new Rng(0xf01d);

    const osc = (wave, phase) => {
        if (wave === 1) return 1 - 4 * Math.abs(phase - 0.5);
        if (wave === 2) return 2 * phase - 1;
        if (wave === 3) return phase < 0.5 ? 1 : -1;
        return Math.sin(TAU * phase);
    };

    class Voice {
        constructor(m, P, proc) {
            this.wave = proc.wave;
            this.f0 = P.pitch;
            this.chirpRatio = 1 + P.chirp * 7;
            this.sweep = Math.exp(-1 / Math.max(1, (P.chtime / 1000) * SR));
            this.sweepState = 1;
            this.attack = Math.max(1, (P.attack / 1000) * SR);
            this.punch = (P.punch / 1000) * SR;
            this.decayMul = t60(P.decay / 1000);
            this.subMul = t60((P.decay * 1.6) / 1000);
            this.env = 1;
            this.subEnv = 1;
            this.body = P.body;
            this.subAmp = P.sub;
            this.noiseAmp = P.noise;
            this.noiseMul = t60(0.012);
            this.noiseEnv = 1;
            this.noiseHp = new OnePole(1500);
            this.boost = P.boost;
            this.comp = P.comp;
            this.follower = new Follower(0.0008, 0.06);
            this.antiAlias = new OnePole(Math.min(SR * 0.4, 9000));
            this.noise = new Rng((seeds.next() * 4294967296) >>> 0);
            this.amp = P.level * m.velocity;
            this.phase = 0;
            this.subPhase = 0;
            this.n = 0;
        }
        render(L, R, from, to) {
            for (let i = from; i < to; i++) {
                const n = this.n;
                const a = n < this.attack ? n / this.attack : 1;
                if (n > this.attack + this.punch) {
                    this.env *= this.decayMul;
                    this.subEnv *= this.subMul;
                }
                if (this.env < 1e-4 && this.subEnv < 1e-4) return false;

                this.sweepState *= this.sweep;
                const freq = this.f0 * (1 + (this.chirpRatio - 1) * this.sweepState);
                this.phase += freq / SR;
                if (this.phase >= 1) this.phase -= 1;
                this.subPhase += freq / (2 * SR);
                if (this.subPhase >= 1) this.subPhase -= 1;

                let y = osc(this.wave, this.phase);
                if (this.body > 0) {
                    const folded = fold(y * (1 + this.body * 3));
                    y = y + (asym(folded * (1 + this.body * 2), 0.3) - y) * this.body;
                }
                y *= a * this.env;
                // The fundamental, reinforced as a clean sine under the wave.
                y += Math.sin(TAU * this.phase) * this.boost * 0.6 * a * this.env;
                y += Math.sin(TAU * this.subPhase) * this.subAmp * a * this.subEnv;
                this.noiseEnv *= this.noiseMul;
                y += this.noiseHp.hp(this.noise.bi()) * this.noiseEnv * this.noiseAmp * 0.6;

                if (this.comp > 0) {
                    const e = this.follower.process(y);
                    const reduction = 1 / (1 + this.comp * 5 * Math.max(0, e - 0.25));
                    y *= reduction * (1 + this.comp * 1.2);
                }
                y = this.antiAlias.lp(tanh(y));
                const out = y * this.amp;
                L[i] += out;
                R[i] += out;
                this.n++;
            }
            return true;
        }
    }

    return voiceProcessor(Base, (m, P, proc) => new Voice(m, P, proc), 6, {
        init() {
            this.wave = Math.max(0, ["sine", "triangle", "saw", "square"].indexOf(this.opts.wave ?? "sine"));
        },
        message(m) {
            if (m.type === "wave") this.wave = m.index;
        },
    });
};

registerWorkletProcessor("ribbit-foldkick", foldkickProcessor, workletParams(FOLDKICK_PARAMS));

export class RibbitFoldKick extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        const wave = WAVES.includes(options.wave) ? options.wave : "sine";
        super(audioContext, { name: "foldkick", ...options }, {
            processor: "ribbit-foldkick",
            params: FOLDKICK_PARAMS,
            lane: "6",
            sieve: "even",
            processorOptions: { wave },
        });
        this.llm_summary = "A kick from one oscillator (the AE machine's kick voice): pitch sweep (chirp/chtime), punch hold, wavefold body, sub octave, attack noise, built-in compressor. Pitch in Hz, from the voice not the note. Lane 6, even notes (shares the lane with bigmodal).";
        this.wave = wave;
        this.options.wave = choiceOption(this, "wave", WAVES, (value) => {
            this.node.post({ type: "wave", index: WAVES.indexOf(value) });
        });
    };
};
