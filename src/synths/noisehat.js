import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// Filtered-noise hats — the AE machine's Hats Voice (`aemd_hat`), "the air
// of the machine", simple by design.
//
// One noise source into three resonant bandpass filters: `low` (the tick and
// the body) and `hi1`/`hi2` (the metal), each band as narrow as its Q (narrow
// = more pitched). `mix` balances the low band against the two high ones, and
// one percussive envelope (`decay`, `curve`) shapes the lot. The two high
// bands read decorrelated noise on left and right, so the metal has width and
// the body stays centred.
//
// Recipes (manual): closed hat decay 25ms, mix 0.8, curve -0.6; open hat the
// same at 300ms; shaker decay 60, mix 0.5, all Qs low; rim tick mix 0.1, low
// ~900Hz, Q high, decay 15.
export const NOISEHAT_PARAMS = {
    low: { value: 900, min: 20, max: 4000 },
    hi1: { value: 7000, min: 1000, max: 22000 },
    hi2: { value: 11000, min: 1000, max: 22000 },
    lowq: { value: 0.8, min: 0.1, max: 2 },
    hiq: { value: 0.9, min: 0.1, max: 2 },
    mix: { value: 0.8, min: 0, max: 1 },
    decay: { value: 45, min: 5, max: 1000 },
    curve: { value: -0.6, min: -0.99, max: 0.99 },
    level: { value: 0.6, min: 0, max: 1 },
};

export function noisehatProcessor(Base, DSP) {
    const { SR, curveEnv, SVF, Rng, voiceProcessor } = DSP;
    const seeds = new Rng(0x7a11);

    // The Q controls run 0.1..2 on the panel; a resonant bandpass wants a
    // wider span, so they're mapped onto 0.4..16, exponentially.
    const mapQ = (q) => 0.4 * Math.pow(40, (q - 0.1) / 1.9);

    class Voice {
        constructor(m, P) {
            const nyquistSafe = (f) => Math.min(f, SR * 0.45);
            this.low = new SVF(P.low, mapQ(P.lowq));
            this.h1L = new SVF(nyquistSafe(P.hi1), mapQ(P.hiq));
            this.h2L = new SVF(nyquistSafe(P.hi2), mapQ(P.hiq));
            this.h1R = new SVF(nyquistSafe(P.hi1), mapQ(P.hiq));
            this.h2R = new SVF(nyquistSafe(P.hi2), mapQ(P.hiq));
            // White noise through a bandpass keeps power in proportion to
            // the bandwidth (f / Q), so a narrow or low band is far quieter
            // than a wide high one. Each band is normalised to the same
            // expected RMS, which makes Q and frequency colour controls
            // rather than volume controls.
            const bandGain = (f, q) => {
                const fraction = Math.min(1, (Math.PI * 0.5 * (f / q)) / (SR * 0.5));
                // (the SVF's band output peaks at Q, hence the 1/q)
                return 0.4 / (0.577 * Math.sqrt(fraction)) / q;
            };
            this.lowGain = bandGain(Math.min(P.low, SR * 0.45), mapQ(P.lowq));
            this.h1Gain = bandGain(Math.min(P.hi1, SR * 0.45), mapQ(P.hiq));
            this.h2Gain = bandGain(Math.min(P.hi2, SR * 0.45), mapQ(P.hiq));
            this.mix = P.mix;
            this.len = Math.max(1, (P.decay / 1000) * SR);
            this.curve = P.curve;
            this.amp = P.level * m.velocity;
            this.noiseL = new Rng((seeds.next() * 4294967296) >>> 0);
            this.noiseR = new Rng((seeds.next() * 4294967296) >>> 0);
            this.n = 0;
        }
        render(L, R, from, to) {
            for (let i = from; i < to; i++) {
                const x = this.n / this.len;
                if (x >= 1) return false;
                const env = curveEnv(x, this.curve) * this.amp;
                const nl = this.noiseL.bi();
                const nr = this.noiseR.bi();
                this.low.process((nl + nr) * 0.5);
                this.h1L.process(nl); this.h2L.process(nl);
                this.h1R.process(nr); this.h2R.process(nr);
                const body = this.low.band * this.lowGain * (1 - this.mix);
                const metalL = (this.h1L.band * this.h1Gain + this.h2L.band * this.h2Gain) * 0.7 * this.mix;
                const metalR = (this.h1R.band * this.h1Gain + this.h2R.band * this.h2Gain) * 0.7 * this.mix;
                L[i] += (body + metalL) * env;
                R[i] += (body + metalR) * env;
                this.n++;
            }
            return true;
        }
    }

    return voiceProcessor(Base, (m, P) => new Voice(m, P), 10);
};

registerWorkletProcessor("ribbit-noisehat", noisehatProcessor, workletParams(NOISEHAT_PARAMS));

export class RibbitNoiseHat extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "noisehat", ...options }, {
            processor: "ribbit-noisehat",
            params: NOISEHAT_PARAMS,
            lane: "5",
            sieve: "4:3",
        });
        this.llm_summary = "Filtered-noise hats (the AE machine's hats voice): noise into one low band (body/tick) and two high bands (metal), mix balances them, one envelope. Closed hat decay 25ms, open 300ms, rim tick mix 0.1 low 900. Sieve 4:3 on lane 5.";
    };
};
