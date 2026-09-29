import { RibbitWorkletProcessor } from "../dsp/effect.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// Ten resonators in permanent excitation, sinking slowly, with wind, grey
// noise and vinyl around them — the AE machine's Deep Pad (`aemd_thmk`), plus
// its *Send to Drone / Excite* routing, which is what makes it a processor
// here: **it lives on a bus**, and whatever is sent into that bus strikes its
// resonators.
//
// Alone it plays itself: a bed of filtered noise keeps ten resonators ringing
// (ATT up to forty seconds before it arrives — nothing seems to happen for
// half a minute; that's the instrument). Tuned by `pitch` (+`oct`), from a
// harmonic series at `inharm` 0 to a deep bell at 1; `partials`/`sub`/`tilt`
// balance the upper modes, two subharmonics and the overall slope; `spread`
// and `drift` detune the modes slowly (the breathing); `decay` is their ring,
// up to forty seconds; `descent` sinks the whole bank as it plays, up to three
// octaves over a few minutes and back; `erode` wears the upper partials away.
// `grey`/`wind`/`vinyl` are three noise layers (a filtered band — `tone`,
// `q` — breath, crackle), `space`/`dist`/`damp` a small built-in reverb,
// `sat`, `hp`, `level`.
//
// **`excite`** opens the bank to its input — the manual's "convolution you can
// play". Send any track into the bus (`/hats add_send=pad`) and its hits
// become the excitation: transients turn into swells, a loop becomes the pulse
// inside a room, unpitched material acquires a pitch. The internal bed ducks
// out of the way as signal arrives and returns over about a second, level
// matched — adding sources changes *what* plays the bank, never how hard.
// `decay` 0.2..0.4 makes each hit its own strike with its own tail (above
// ~0.7 everything integrates into one tone and the source dissolves). Tune
// `pitch` to the key of what goes in and the bank agrees with the music; a
// semitone off and it argues with it.
//
// Sends in ribbit are post-fader, where the AE's are pre-fader: to hear only
// the resonated result, route a track's main out to the pad bus
// (`/hats out=pad`) instead of pulling its fader down.
export const DEEPPAD_PARAMS = {
    pitch: { value: 36, min: 24, max: 84 },
    oct: { value: 0, min: -3, max: 2 },
    descent: { value: 0.2, min: 0, max: 1 },
    inharm: { value: 0.15, min: 0, max: 1 },
    partials: { value: 0.5, min: 0, max: 1 },
    sub: { value: 0.3, min: 0, max: 1 },
    tilt: { value: 0, min: -1, max: 1 },
    spread: { value: 0.3, min: 0, max: 1 },
    drift: { value: 0.3, min: 0, max: 1 },
    decay: { value: 0.6, min: 0, max: 1 },
    erode: { value: 0, min: 0, max: 1 },
    grey: { value: 0.15, min: 0, max: 1 },
    wind: { value: 0.1, min: 0, max: 1 },
    vinyl: { value: 0.05, min: 0, max: 1 },
    tone: { value: 0.5, min: 0, max: 1 },
    q: { value: 0.3, min: 0, max: 1 },
    space: { value: 0.5, min: 0, max: 1 },
    dist: { value: 0.3, min: 0, max: 1 },
    damp: { value: 0.4, min: 0, max: 1 },
    excite: { value: 0, min: 0, max: 1 },
    att: { value: 8, min: 0.5, max: 40 },
    sat: { value: 0.2, min: 0, max: 1 },
    hp: { value: 0.1, min: 0, max: 1 },
    level: { value: 0.6, min: 0, max: 1 },
};

export function deeppadProcessor(Base, DSP) {
    const { SR, TAU, clamp, mtof, tanh, SVF, OnePole, Delay, Follower, Rng, effectProcessor } = DSP;
    const MODES = 10;
    const UPDATE = 64;
    const VERB_MS = [31.3, 41.9, 53.7, 67.1];

    return effectProcessor(Base, {
        setup() {
            this.rng = new Rng(0xdee9);
            // Complex one-pole modes: retuning one never changes its level,
            // which matters when descent and drift move them continuously.
            this.re = new Float64Array(MODES);
            this.im = new Float64Array(MODES);
            this.c = new Float64Array(MODES);
            this.s = new Float64Array(MODES);
            this.r = new Float64Array(MODES);
            this.amp = new Float64Array(MODES);
            this.driftPhase = new Float64Array(MODES);
            this.driftRate = new Float64Array(MODES);
            for (let k = 0; k < MODES; k++) {
                this.driftPhase[k] = this.rng.next();
                this.driftRate[k] = 0.5 + this.rng.next();
            }
            this.greyL = new SVF(800, 2);
            this.greyR = new SVF(800, 2);
            this.windL = new OnePole(600);
            this.windR = new OnePole(600);
            this.windPhase = 0;
            this.bed = new SVF(300, 1);
            this.follower = new Follower(0.005, 0.3);
            this.duck = 1;
            this.gate = 0;
            this.descentPhase = 0;
            this.erosion = 0;
            this.verb = VERB_MS.map((ms) => ({ line: new Delay(Math.ceil(ms * 0.001 * SR * 1.6) + 8), lp: new OnePole(5000), ms }));
            this.verbOut = new Float64Array(4);
            this.hpL = new OnePole(30);
            this.hpR = new OnePole(30);
            this.n = 0;
        },
        onMessage(m) {
            if (m.type === "restart") this.gate = 0;
        },
        retune(P, dt) {
            // Descent: a slow triangle, down for ~4 minutes and back.
            this.descentPhase = (this.descentPhase + dt / 480) % 1;
            const sink = (1 - Math.abs(this.descentPhase * 2 - 1)) * P.descent * 36;
            const f0 = mtof(P.pitch + Math.round(P.oct) * 12 - sink);
            const t60 = 0.3 + 40 * P.decay * P.decay;
            // Erode: the upper partials wear away over minutes, faster with
            // more erode; setting it to 0 restores them.
            this.erosion = P.erode <= 0 ? 0 : Math.min(1, this.erosion + (dt * P.erode) / 90);
            let norm = 0;
            for (let k = 0; k < MODES; k++) {
                // Modes 0,1 are subharmonics (½, ¾); 2.. the upper series,
                // bent from harmonic towards a bell by inharm.
                let ratio;
                if (k === 0) ratio = 0.5;
                else if (k === 1) ratio = 0.75;
                else {
                    const n = k - 1;
                    ratio = Math.pow(n, 1 + P.inharm * 0.55) * (1 + P.inharm * 0.08 * Math.sin(n * 2.3));
                }
                this.driftPhase[k] += (dt * this.driftRate[k] * (0.02 + P.drift * 0.2));
                const detune = Math.sin(TAU * this.driftPhase[k]) * P.spread * 0.012;
                const f = Math.min(SR * 0.45, f0 * ratio * (1 + detune));
                const w = (TAU * f) / SR;
                this.c[k] = Math.cos(w);
                this.s[k] = Math.sin(w);
                const upper = k >= 2 ? (k - 2) / (MODES - 3) : 0;
                const modeT60 = t60 / (1 + upper * (1 + this.erosion * 6));
                this.r[k] = Math.exp(-6.907755 / (modeT60 * SR));
                let a = k < 2 ? P.sub : P.partials * Math.pow(k - 1, -0.6) + (k === 2 ? 1 - P.partials * 0.5 : 0);
                a *= Math.exp(P.tilt * 1.2 * (upper * 2 - 1)) * (1 - this.erosion * upper);
                this.amp[k] = Math.max(0, a);
                norm += this.amp[k];
            }
            for (let k = 0; k < MODES; k++) this.amp[k] /= norm || 1;
            this.bed.set(Math.min(SR * 0.45, f0 * 2), 0.8);
            const toneHz = 150 * Math.pow(60, P.tone);
            this.greyL.set(Math.min(SR * 0.45, toneHz), 0.6 + P.q * 12);
            this.greyR.set(Math.min(SR * 0.45, toneHz * 1.07), 0.6 + P.q * 12);
            const verbT60 = 0.4 + P.space * 5;
            const verbScale = 0.5 + P.space;
            for (const tap of this.verb) {
                tap.d = tap.ms * 0.001 * verbScale * SR;
                tap.g = Math.pow(0.001, (tap.ms * 0.001 * verbScale) / verbT60);
                tap.lp.set(800 + 12000 * (1 - P.damp));
            }
            this.hpL.set(15 + 400 * P.hp * P.hp);
            this.hpR.set(15 + 400 * P.hp * P.hp);
        },
        render(inL, inR, outL, outR, P, frames) {
            const attack = 1 / (P.att * SR);
            const satGain = 1 + P.sat * 4;
            const satNorm = 1 / tanh(satGain);
            const excite = P.excite;
            const dist = P.dist;
            for (let i = 0; i < frames; i++) {
                if ((this.n++ % UPDATE) === 0) this.retune(P, UPDATE / SR);
                this.gate = Math.min(1, this.gate + attack);
                const x = (inL[i] + inR[i]) * 0.5 * excite;
                // The bed ducks under incoming signal and returns over ~1s.
                const e = this.follower.process(x);
                const duckTarget = 1 / (1 + e * 20);
                this.duck += (duckTarget - this.duck) * (duckTarget < this.duck ? 0.01 : 0.00002);
                const bedNoise = this.bed.process(this.rng.bi()) * 0.02 * this.duck;
                const drive = bedNoise + x * 0.5;
                let body = 0, bodyL = 0, bodyR = 0;
                for (let k = 0; k < MODES; k++) {
                    const re = this.re[k], im = this.im[k], r = this.r[k];
                    const nre = r * (this.c[k] * re - this.s[k] * im) + drive;
                    const nim = r * (this.s[k] * re + this.c[k] * im);
                    this.re[k] = nre;
                    this.im[k] = nim;
                    const v = nim * this.amp[k];
                    body += v;
                    if (k & 1) bodyR += v; else bodyL += v;
                }
                // The noise layers.
                this.greyL.process(this.rng.bi());
                this.greyR.process(this.rng.bi());
                this.windPhase += 0.09 / SR;
                const gust = 0.5 + 0.5 * Math.sin(TAU * this.windPhase) * Math.sin(TAU * this.windPhase * 0.37);
                const windL = this.windL.lp(this.rng.bi()) * gust;
                const windR = this.windR.lp(this.rng.bi()) * gust;
                let crackle = 0;
                if (this.rng.next() < P.vinyl * 12 / SR) crackle = this.rng.bi() * 0.5;
                let l = (body * 0.6 + bodyL * 0.4) * 0.35 + this.greyL.band * this.greyL.k * P.grey * 0.3 + windL * P.wind * 0.4 + crackle * P.vinyl;
                let r = (body * 0.6 + bodyR * 0.4) * 0.35 + this.greyR.band * this.greyR.k * P.grey * 0.3 + windR * P.wind * 0.4 + crackle * P.vinyl;
                // Space: four lines, Householder feedback.
                let sum = 0;
                for (let k = 0; k < 4; k++) {
                    const tap = this.verb[k];
                    this.verbOut[k] = tap.lp.lp(tap.line.read(tap.d)) * tap.g;
                    sum += this.verbOut[k];
                }
                sum *= 0.5;
                const feed = (l + r) * 0.5;
                for (let k = 0; k < 4; k++) this.verb[k].line.write(feed + this.verbOut[k] - sum);
                const wetL = this.verbOut[0] + this.verbOut[2];
                const wetR = this.verbOut[1] + this.verbOut[3];
                l = l * (1 - dist * 0.7) + wetL * (0.3 + dist * 0.7) * P.space;
                r = r * (1 - dist * 0.7) + wetR * (0.3 + dist * 0.7) * P.space;
                l = this.hpL.hp(tanh(l * satGain) * satNorm);
                r = this.hpR.hp(tanh(r * satGain) * satNorm);
                const g = this.gate * this.gate * P.level;
                outL[i] = l * g;
                outR[i] = r * g;
            }
        },
    });
};

registerWorkletProcessor("ribbit-deeppad", deeppadProcessor, workletParams(DEEPPAD_PARAMS));

export class RibbitDeepPad extends RibbitWorkletProcessor {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "deeppad", ...options }, { processor: "ribbit-deeppad", params: DEEPPAD_PARAMS });
        this.llm_summary = "Ten resonators in permanent self-excitation (the AE machine's deep pad), sinking slowly (descent), with grey/wind/vinyl noise and a small reverb. Put it on a bus: alone it plays itself (att up to 40s); excite=1 makes whatever is sent into the bus strike the bank — a convolution you can tune (pitch to the key of the source; decay 0.2-0.4 for distinct strikes, high to dissolve). inharm harmonic->bell, partials/sub/tilt, spread/drift, erode.";
        this.options = {
            // A gesture: fades the pad back in from silence over `att`.
            restart: {
                get: () => "-",
                set: () => this.send({ type: "restart" }),
            },
        };
    };

    getOptions() {
        return {};
    };
};
