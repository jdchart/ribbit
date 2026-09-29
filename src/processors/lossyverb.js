import { RibbitWorkletProcessor } from "../dsp/effect.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams, toggleOption, isOn } from "../dsp/spec.js";

// A reverb built like a failing codec — the AE machine's LSYX (`aemd_lsyx`),
// "the digital sibling of Oxide: where the tape sheds oxide, this loses
// data". It sits after `spectra` in the original; here it goes anywhere.
//
// `kbps` (320 down to 8) is the quality of the connection: bandwidth, bit
// depth and clock stability collapse together, and below roughly 100 the
// *birdies* appear — watery whistles from a sparse bank of narrow bands that
// hop every few tens of milliseconds, driven by the signal itself (the sound
// of a starved codec throwing most of the spectrum away). `pack` drops
// packets: brief holes and repeats, alternating left and right.
//
// The tank (four lines, `verb` = amount and length together, up to ~20s;
// `spc` its size) has one defining trait: **every recirculation is
// re-encoded** — bandwidth-limited and requantised again — so the tail
// doesn't fade, it grinds away generation after generation, and at low kbps a
// long tail dissolves into codec noise rather than dying. `tone` darkens it
// (never brighter than kbps allows), `duck` bows the tail under the input so
// it rises in the gaps, `width`, `mix`. `freeze=on` holds the tank — the
// codec stops re-encoding: a stuck RAM that darkens very slowly.
export const LOSSYVERB_PARAMS = {
    kbps: { value: 128, min: 8, max: 320 },
    pack: { value: 0, min: 0, max: 1 },
    verb: { value: 0.4, min: 0, max: 1 },
    spc: { value: 0.5, min: 0, max: 1 },
    tone: { value: 0.6, min: 0, max: 1 },
    duck: { value: 0.3, min: 0, max: 1 },
    width: { value: 0.8, min: 0, max: 1 },
    mix: { value: 0.5, min: 0, max: 1 },
};

export function lossyverbProcessor(Base, DSP) {
    const { SR, OnePole, SVF, Delay, Follower, Rng, effectProcessor } = DSP;
    const TANK_MS = [43.1, 57.7, 71.3, 89.9];

    return effectProcessor(Base, {
        setup() {
            this.rng = new Rng(0x15b);
            this.bandL = new OnePole(16000);
            this.bandR = new OnePole(16000);
            this.holdL = 0; this.holdR = 0; this.holdCount = 0; this.holdLength = 1;
            this.tank = TANK_MS.map((ms) => ({ line: new Delay(Math.ceil(ms * 0.001 * SR * 2) + 8), lp: new OnePole(8000), ms }));
            this.tankOut = new Float64Array(4);
            this.follower = new Follower(0.005, 0.3);
            this.birdies = [0, 1, 2, 3].map(() => ({ filter: new SVF(1000, 30), gain: 0, target: 0 }));
            this.birdTimer = 0;
            this.frozen = !!this.opts.freeze;
            this.freeze = this.frozen ? 1 : 0;
            // Packets.
            this.packetPos = 0; this.packetLen = 480; this.packetState = 0; this.packetSide = 0;
            const cap = Math.ceil(0.03 * SR);
            this.prevL = new Float32Array(cap); this.prevR = new Float32Array(cap);
            this.curL = new Float32Array(cap); this.curR = new Float32Array(cap);
        },
        onMessage(m) {
            if (m.type === "freeze") this.frozen = m.on;
        },
        render(inL, inR, outL, outR, P, frames) {
            // Codec quality: 320kbps ≈ full band, 16 bits, a steady clock;
            // 8kbps ≈ 500Hz, 4 bits, a clock that stumbles.
            const q = (P.kbps - 8) / 312;
            const bandwidth = Math.min(SR * 0.45, 500 * Math.pow(40, q));
            const levels = Math.pow(2, 4 + 12 * Math.sqrt(q));
            const quantise = (x) => Math.round(x * levels) / levels;
            this.bandL.set(bandwidth);
            this.bandR.set(bandwidth);
            const tankCut = Math.min(bandwidth, 400 + 12000 * P.tone * P.tone);
            const t60 = 0.2 + 20 * P.verb * P.verb;
            const scale = 0.4 + P.spc * 1.6;
            for (const tap of this.tank) {
                tap.lp.set(tankCut);
                tap.gain = Math.pow(0.001, (tap.ms * 0.001 * scale) / t60);
                tap.d = tap.ms * 0.001 * scale * SR;
            }
            const birdAmount = P.kbps < 100 ? (100 - P.kbps) / 92 : 0;
            const lossChance = P.pack * 0.5;
            const mix = P.mix;
            const freezeStep = 1 / (0.05 * SR);
            for (let i = 0; i < frames; i++) {
                this.freeze += this.frozen ? freezeStep : -freezeStep;
                if (this.freeze < 0) this.freeze = 0; else if (this.freeze > 1) this.freeze = 1;
                const f = this.freeze;
                // Encode the input: band-limit, a jittery sample clock, bits.
                if (++this.holdCount >= this.holdLength) {
                    this.holdCount = 0;
                    this.holdLength = 1 + Math.floor(this.rng.next() * (1 - q) * 3);
                    this.holdL = quantise(this.bandL.lp(inL[i]));
                    this.holdR = quantise(this.bandR.lp(inR[i]));
                } else {
                    this.bandL.lp(inL[i]);
                    this.bandR.lp(inR[i]);
                }
                let cl = this.holdL, cr = this.holdR;

                // Birdies: four narrow bands at hopping frequencies, their
                // level following the signal.
                const x = (inL[i] + inR[i]) * 0.5;
                const env = this.follower.process(x);
                if (birdAmount > 0) {
                    if (--this.birdTimer <= 0) {
                        this.birdTimer = Math.round((0.02 + this.rng.next() * 0.05) * SR);
                        for (const bird of this.birdies) {
                            bird.filter.set(Math.min(bandwidth * 0.95, 300 + this.rng.next() * this.rng.next() * 5000), 25);
                            bird.target = this.rng.next() < 0.6 ? 1 : 0;
                        }
                    }
                    let whistle = 0;
                    for (const bird of this.birdies) {
                        bird.gain += (bird.target - bird.gain) * 0.002;
                        bird.filter.process(x);
                        whistle += bird.filter.band * bird.filter.k * bird.gain;
                    }
                    const w = whistle * 3 * birdAmount;
                    cl = cl * (1 - birdAmount * 0.6) + w;
                    cr = cr * (1 - birdAmount * 0.6) + w;
                }

                // Packets: holes and repeats, alternating sides.
                if (this.packetPos === 0) {
                    let t = this.prevL; this.prevL = this.curL; this.curL = t;
                    t = this.prevR; this.prevR = this.curR; this.curR = t;
                    this.packetLen = Math.round((0.008 + this.rng.next() * 0.02) * SR);
                    this.packetState = this.rng.next() < lossChance ? (this.rng.next() < 0.5 ? 1 : 2) : 0;
                    if (this.packetState) this.packetSide ^= 1;
                }
                this.curL[this.packetPos] = cl;
                this.curR[this.packetPos] = cr;
                if (this.packetState) {
                    const replacement = this.packetState === 1 ? 0 : (this.packetSide ? this.prevR[this.packetPos] : this.prevL[this.packetPos]);
                    if (this.packetSide) cr = replacement; else cl = replacement;
                }
                if (++this.packetPos >= this.packetLen) this.packetPos = 0;

                // The tank, re-encoded every pass (unless frozen).
                let sum = 0;
                for (let k = 0; k < 4; k++) {
                    const tap = this.tank[k];
                    const raw = tap.line.read(tap.d);
                    const encoded = quantise(tap.lp.lp(raw)) * tap.gain;
                    this.tankOut[k] = encoded + (raw - encoded) * f;
                    sum += this.tankOut[k];
                }
                sum *= 0.5;
                const duck = 1 / (1 + env * P.duck * 12);
                const feed = ((cl + cr) * 0.5) * (1 - f) * 0.5;
                for (let k = 0; k < 4; k++) this.tank[k].line.write(feed + (this.tankOut[k] - sum));
                const tailL = (this.tankOut[0] + this.tankOut[2]) * duck;
                const tailR = (this.tankOut[1] + this.tankOut[3]) * duck;
                const mid = (tailL + tailR) * 0.5, side = (tailL - tailR) * 0.5 * P.width;
                const wetL = cl * 0.6 + (mid + side) * 0.7;
                const wetR = cr * 0.6 + (mid - side) * 0.7;
                outL[i] = inL[i] * (1 - mix) + wetL * mix;
                outR[i] = inR[i] * (1 - mix) + wetR * mix;
            }
        },
    });
};

registerWorkletProcessor("ribbit-lossyverb", lossyverbProcessor, workletParams(LOSSYVERB_PARAMS));

export class RibbitLossyVerb extends RibbitWorkletProcessor {
    constructor(audioContext, options = {}) {
        const freeze = isOn(options.freeze, false);
        super(audioContext, { name: "lossyverb", ...options }, {
            processor: "ribbit-lossyverb",
            params: LOSSYVERB_PARAMS,
            processorOptions: { freeze },
        });
        this.llm_summary = "A reverb built like a failing codec (the AE machine's LSYX): kbps 320..8 collapses bandwidth, bits and clock together, with watery 'birdies' below ~100; pack drops packets; verb/spc the tank, re-encoded every pass so tails grind away instead of fading; tone, duck (tail bows to the input), width, mix, freeze.";
        this.freeze = freeze;
        this.options = {
            freeze: toggleOption(this, "freeze", (on) => this.send({ type: "freeze", on })),
        };
    };
};
