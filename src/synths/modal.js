import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// Modal percussion — the AE machine's Modal Voice (`aemd_modal`): eight
// tuned resonators struck by a burst of noise. What you set is not a
// waveform but the shape and material of an imaginary object.
//
// A drum and a bell differ not in pitch but in the *ratios* between their
// modes, and `material` is exactly that: it crossfades five ratio sets —
// drum (an ideal circular membrane's Bessel ratios), mixed, harmonic, bell
// (the church-bell hum/prime/tierce/quint/nominal family) and metal (a
// free-free bar). `inharm` then stretches the upper modes out of tune
// (multiplicatively — real metal), `disp` pushes them apart linearly (a
// different kind of detuning).
//
// **`damp` is the realism control** (the manual's words): upper modes die
// faster than lower ones, which is what makes an object sound *damped* rather
// than merely short. At 0 every mode rings equally and it sounds synthetic.
//
// **Velocity reaches the timbre**, which is the manual's whole argument for
// why modal drums sound played: a harder strike is a shorter, brighter burst
// (it moves `bright`), shifts the balance towards the high modes and — via
// the burst — changes how the upper partials die. Two hits are the same
// object struck twice, never the same recording twice: the burst is fresh
// noise every time.
//
// Recipes (manual): tom material 0, decay 0.3, damp 0.6, bright 0.3.
// Woodblock 0.2 / 0.1 / 0.8 / 0.9. Bell material 0.75, decay 0.8, damp 0.15,
// inharm 0.3. Sheet metal material 1, inharm 0.6, decay 0.6, bright 1, drive.
export const MODAL_PARAMS = {
    material: { value: 0.1, min: 0, max: 1 },
    inharm: { value: 0, min: 0, max: 1 },
    disp: { value: 0, min: 0, max: 1 },
    decay: { value: 0.35, min: 0, max: 1 },
    damp: { value: 0.5, min: 0, max: 1 },
    bright: { value: 0.5, min: 0, max: 1 },
    pitch: { value: 48, min: 12, max: 108 },
    keytrk: { value: 1, min: 0, max: 1 },
    n_tmbr: { value: 0.3, min: 0, max: 1 },
    drive: { value: 0, min: 0, max: 1 },
    fold: { value: 0, min: 0, max: 1 },
    level: { value: 0.7, min: 0, max: 1 },
};

export function modalProcessor(Base, DSP) {
    const { SR, clamp, lerp, mtof, tanh, fold, Resonator, OnePole, Rng, voiceProcessor } = DSP;

    // Five ratio sets, eight modes each, crossfaded by `material`.
    const SETS = [
        [1, 1.594, 2.136, 2.296, 2.653, 2.918, 3.156, 3.501], // drum: circular membrane j_mn / j_01
        [1, 1.72, 2.41, 2.98, 3.61, 4.27, 4.84, 5.53],        // mixed
        [1, 2, 3, 4, 5, 6, 7, 8],                             // harmonic
        [1, 2, 2.4, 3, 4, 5.33, 6, 8],                        // bell (hum = 1)
        [1, 2.756, 5.404, 8.933, 13.34, 18.64, 24.81, 31.87], // metal: free-free bar
    ];
    const MODES = 8;
    const rng = new Rng(0x51ed270b);

    class Voice {
        constructor(m, P) {
            const pitch = P.pitch + P.keytrk * (m.pitch - P.pitch);
            const f0 = mtof(pitch);
            const noteT = clamp((m.pitch - 60) / 24, -1, 1.5) * P.n_tmbr;
            const v = m.velocity;

            // Strike hardness: bright raised by velocity and (n_tmbr) note.
            const bright = clamp(P.bright + (v - 0.7) * 0.4 + noteT * 0.3, 0, 1);

            const position = clamp(P.material, 0, 1) * (SETS.length - 1);
            const lo = Math.floor(position);
            const hi = Math.min(SETS.length - 1, lo + 1);
            const t = position - lo;

            // 0.02s .. 5.5s, exponential; shortened by n_tmbr for high notes.
            const baseDecay = 0.02 * Math.pow(275, P.decay) * (1 - noteT * 0.3);

            this.modes = [];
            for (let i = 0; i < MODES; i++) {
                let ratio = lerp(SETS[lo][i], SETS[hi][i], t);
                ratio *= 1 + P.inharm * 0.045 * i * i;
                ratio += P.disp * i * 0.37;
                const freq = f0 * ratio;
                if (freq >= SR * 0.45) continue;
                // Upper modes die faster: damp scales decay down by how far
                // above the fundamental the mode sits.
                const decay = baseDecay / (1 + P.damp * 6 * (ratio - 1));
                // Mode weight: a soft strike feeds the low modes, a hard one
                // spreads energy upward.
                const weight = Math.pow(ratio, -1.6 * (1 - bright)) * (0.75 + 0.5 * rng.next());
                this.modes.push({ res: new Resonator(freq, Math.max(0.005, decay)), weight });
            }
            // The strike: 1..8ms of noise, darker and longer when soft.
            this.burstLen = Math.round((0.0085 - bright * 0.0075) * SR);
            this.burstFilter = new OnePole(300 + bright * bright * 14000);
            // A burst's energy grows with its length and a lowpassed burst
            // drives the low modes coherently, so both are normalised out —
            // bright and velocity change the *colour* at roughly equal
            // loudness, and velocity alone sets the level.
            this.burstGain = 2.2 / Math.sqrt(this.burstLen);
            let weights = 0;
            for (const mode of this.modes) weights += mode.weight;
            for (const mode of this.modes) mode.weight /= weights || 1;
            this.n = 0;
            this.quiet = 0;
            this.amp = P.level * v * 2;
            this.driveGain = 1 + P.drive * 8;
            this.driveNorm = P.drive > 0 ? 1 / tanh(this.driveGain) : 1;
            this.foldAmount = P.fold;
            this.foldGain = 1 + P.fold * 3;
            this.noise = new Rng((rng.next() * 4294967296) >>> 0);
        }
        render(L, R, from, to) {
            const modes = this.modes;
            for (let i = from; i < to; i++) {
                let x = 0;
                if (this.n < this.burstLen) {
                    // Raised-cosine burst envelope.
                    const env = 0.5 - 0.5 * Math.cos((Math.PI * 2 * this.n) / this.burstLen);
                    x = this.burstFilter.lp(this.noise.bi()) * env * this.burstGain;
                }
                let y = 0;
                for (let k = 0; k < modes.length; k++) y += modes[k].res.process(x) * modes[k].weight;
                y *= this.amp;
                if (this.driveGain > 1) y = tanh(y * this.driveGain) * this.driveNorm;
                if (this.foldAmount > 0) y += (fold(y * this.foldGain) - y) * this.foldAmount;
                L[i] += y;
                R[i] += y;
                this.n++;
                // Finished when every resonator has rung down.
                if (Math.abs(y) < 1e-5) {
                    if (++this.quiet > 2048 && this.n > this.burstLen) return false;
                } else this.quiet = 0;
            }
            return true;
        }
    }

    return voiceProcessor(Base, (m, P) => new Voice(m, P), 12);
};

registerWorkletProcessor("ribbit-modal", modalProcessor, workletParams(MODAL_PARAMS));

export class RibbitModal extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "modal", ...options }, {
            processor: "ribbit-modal",
            params: MODAL_PARAMS,
            lane: "5",
            sieve: "3:1",
            quant: true,
        });
        this.llm_summary = "Modal percussion (the AE machine's modal voice): eight resonators struck by a noise burst; material crossfades drum/mixed/harmonic/bell/metal mode ratios, damp makes upper modes die first (the realism control), velocity changes the strike not just the level. Sieve 3:1 on lane 5.";
    };
};
