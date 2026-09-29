import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams, choiceOption } from "../dsp/spec.js";

const LSY_MODES = ["lowpass", "bandpass", "highpass"];

// A bass drum in the non-resonant, inharmonic family — the AE machine's
// voce 1 voice (`aemd_bd`): "built to give the rhythm weight without
// ringing". It answers every note on its lane; rests belong to the
// sequencer's step probability, never to the voice.
//
// A hit is: a body sine with an exponential pitch `sweep` (octaves; low is a
// thump, high a zap) over `decay` (short by design); a `knock` of two
// inharmonic partials that dies in 70ms (the struck quality); a filtered
// click; and asymmetric saturation (`dirt`). `tune` is the fundamental in Hz,
// bent only slightly by the note — a kick should not play melodies.
//
// **No two hits are identical by construction.** Every trigger draws three
// values that shift decay, sweep depth, knock level and the hit's own gain,
// scaled by `vary`; velocity pushes drive, pitch start and decay on top.
//
// Two stages outlive the hit, so they run once on the voice's sum:
//   rvb   the voice's own rumble reverb, one macro (amount and decay rise
//         together), band-limited below the mids and ducked by the kick's own
//         hits — density without smear.
//   lsy   a degradation macro: a filter at `freq` (lowpass/bandpass/highpass —
//         `lsy_mode`, which the panel doesn't show; `dice` rolls it), sample
//         decimation and packet dropouts in one gesture; `pack` adds its own
//         dropouts: brief holes and repeats alternating left and right.
//
// `dice=random` rerolls the whole voice within musical ranges, hidden mode
// included — the fastest way to find a character.
export const BASSDRUM_PARAMS = {
    rvb: { value: 0.15, min: 0, max: 1 },
    tune: { value: 52, min: 30, max: 120 },
    sweep: { value: 1.8, min: 0, max: 4 },
    decay: { value: 0.35, min: 0, max: 1 },
    knock: { value: 0.35, min: 0, max: 1 },
    dirt: { value: 0.3, min: 0, max: 1 },
    lsy: { value: 0, min: 0, max: 1 },
    freq: { value: 0.6, min: 0, max: 1 },
    pack: { value: 0, min: 0, max: 1 },
    vary: { value: 0.3, min: 0, max: 1 },
    level: { value: 0.8, min: 0, max: 1 },
};

// Musical ranges `dice` draws from — narrower than the clamps, since a
// reroll should land on a kick.
const DICE_RANGES = {
    rvb: [0, 0.5], tune: [38, 80], sweep: [0.6, 3.2], decay: [0.15, 0.7],
    knock: [0.1, 0.8], dirt: [0, 0.8], lsy: [0, 0.6], freq: [0.2, 0.9], pack: [0, 0.35],
};

export function bassdrumProcessor(Base, DSP) {
    const { SR, TAU, clamp, asym, t60, smoothing, SVF, OnePole, Delay, Follower, Rng, voiceProcessor } = DSP;
    const seeds = new Rng(0xbd01);

    class Voice {
        constructor(m, P, proc) {
            const rng = proc.rng;
            const vary = P.vary;
            const r1 = rng.bi() * vary, r2 = rng.bi() * vary, r3 = rng.bi() * vary;
            const v = m.velocity;
            // The note bends tune by at most ±1.5 semitones around 36.
            const bend = clamp((m.pitch - 36) / 12, -1, 1) * 1.5;
            this.f0 = P.tune * Math.pow(2, bend / 12);
            this.sweepOct = Math.max(0, P.sweep * (1 + 0.3 * r2) + (v - 0.7) * 0.6);
            this.sweepMul = Math.exp(-1 / (0.028 * SR));
            this.sweepState = 1;
            const decay = (0.06 + 0.84 * P.decay * P.decay) * (1 + 0.3 * r1) * (0.8 + 0.4 * v);
            this.decayMul = t60(Math.max(0.03, decay));
            this.env = 1;
            this.knockAmp = P.knock * (1 + 0.5 * r3) * 0.5;
            this.knockMul = t60(0.07);
            this.knockEnv = 1;
            this.knockF = [this.f0 * 4.13, this.f0 * 6.71];
            this.knockPhase = [0, 0.25];
            this.clickFilter = new SVF(3200, 0.9);
            this.clickMul = t60(0.006);
            this.clickEnv = 1;
            this.noise = new Rng((seeds.next() * 4294967296) >>> 0);
            this.dirtGain = 1 + (P.dirt + v * 0.3) * 6;
            this.dirtNorm = 1 / Math.abs(asym(1, 0.35) || 1);
            this.amp = P.level * v * (1 + 0.12 * r1);
            this.phase = 0;
        }
        render(L, R, from, to) {
            for (let i = from; i < to; i++) {
                this.env *= this.decayMul;
                if (this.env < 1e-4) return false;
                this.sweepState *= this.sweepMul;
                const f = this.f0 * Math.pow(2, this.sweepOct * this.sweepState);
                this.phase += f / SR;
                if (this.phase >= 1) this.phase -= 1;
                let y = Math.sin(TAU * this.phase) * this.env;

                if (this.knockEnv > 1e-4) {
                    this.knockEnv *= this.knockMul;
                    let k = 0;
                    for (let j = 0; j < 2; j++) {
                        this.knockPhase[j] += this.knockF[j] / SR;
                        if (this.knockPhase[j] >= 1) this.knockPhase[j] -= 1;
                        k += Math.sin(TAU * this.knockPhase[j]);
                    }
                    y += k * this.knockEnv * this.knockAmp;
                }
                if (this.clickEnv > 1e-4) {
                    this.clickEnv *= this.clickMul;
                    this.clickFilter.process(this.noise.bi());
                    y += this.clickFilter.band * this.clickEnv * 0.9;
                }
                y = asym(y * this.dirtGain, 0.35) * this.dirtNorm / Math.sqrt(this.dirtGain);
                y *= this.amp;
                L[i] += y;
                R[i] += y;
            }
            return true;
        }
    }

    return voiceProcessor(Base, (m, P, proc) => new Voice(m, P, proc), 4, {
        init() {
            this.rng = new Rng(0x5eed);
            this.lsyMode = Math.max(0, ["lowpass", "bandpass", "highpass"].indexOf(this.opts.lsy_mode ?? "lowpass"));
            // Rumble reverb: four combs in parallel with a lowpass in each
            // loop, fed from a band-limited copy of the voice.
            this.rvbIn = new OnePole(260);
            this.rvbOutL = new OnePole(320);
            this.rvbOutR = new OnePole(320);
            this.rvbHpL = new OnePole(28);
            this.rvbHpR = new OnePole(28);
            this.combs = [0.0297, 0.0371, 0.0411, 0.0437].map((t) => ({ line: new Delay(Math.ceil(t * SR) + 4), d: t * SR, lp: new OnePole(900), fbSign: 1 }));
            this.duck = new Follower(0.002, 0.25);
            // Degradation.
            this.lsyL = new SVF(2000, 1.2);
            this.lsyR = new SVF(2000, 1.2);
            this.holdL = 0; this.holdR = 0; this.holdCount = 0;
            // Packets: 8..30ms slices; a lost one is a hole or a repeat of
            // the previous one, on one side, alternating.
            this.packetLen = Math.round(0.012 * SR);
            this.packetPos = 0;
            this.packetState = 0; // 0 fine, 1 hole, 2 repeat
            this.packetSide = 0;
            this.prevL = new Float32Array(Math.ceil(0.03 * SR));
            this.prevR = new Float32Array(Math.ceil(0.03 * SR));
            this.curL = new Float32Array(Math.ceil(0.03 * SR));
            this.curR = new Float32Array(Math.ceil(0.03 * SR));
            this.lsySmooth = 1 - smoothing(0.02);
            this.lsyAmount = 0;
        },
        message(m) {
            if (m.type === "lsy_mode") this.lsyMode = m.index;
        },
        after(L, R, P) {
            const frames = L.length;
            // Rumble reverb.
            if (P.rvb > 0 || Math.abs(this.combs[0].line.tap(0)) > 1e-6) {
                const fb = 0.55 + 0.42 * P.rvb;
                const wet = P.rvb * 0.7;
                for (let i = 0; i < frames; i++) {
                    const dry = (L[i] + R[i]) * 0.5;
                    const duck = this.duck.process(dry);
                    const x = this.rvbIn.lp(dry);
                    let sumL = 0, sumR = 0;
                    for (let c = 0; c < 4; c++) {
                        const comb = this.combs[c];
                        const out = comb.lp.lp(comb.line.read(comb.d - 1));
                        comb.line.write(x + out * fb);
                        if (c & 1) sumR += out; else sumL += out;
                    }
                    const gain = wet / (1 + duck * 6);
                    L[i] += this.rvbHpL.hp(this.rvbOutL.lp(sumL)) * gain;
                    R[i] += this.rvbHpR.hp(this.rvbOutR.lp(sumR)) * gain;
                }
            }
            // Degradation (lsy + pack).
            const active = P.lsy > 0 || P.pack > 0 || this.lsyAmount > 1e-3;
            if (!active) return;
            const freq = 150 * Math.pow(60, P.freq);
            this.lsyL.set(Math.min(freq, SR * 0.45), 0.8 + P.lsy * 3);
            this.lsyR.set(Math.min(freq, SR * 0.45), 0.8 + P.lsy * 3);
            const hold = 1 + Math.round(P.lsy * P.lsy * 18);
            const lossChance = P.pack * 0.6 + P.lsy * 0.15;
            for (let i = 0; i < frames; i++) {
                this.lsyAmount += (P.lsy - this.lsyAmount) * this.lsySmooth;
                let l = L[i], r = R[i];
                this.lsyL.process(l);
                this.lsyR.process(r);
                const fl = this.lsyMode === 0 ? this.lsyL.low : this.lsyMode === 1 ? this.lsyL.band * 1.5 : this.lsyL.high;
                const fr = this.lsyMode === 0 ? this.lsyR.low : this.lsyMode === 1 ? this.lsyR.band * 1.5 : this.lsyR.high;
                if (++this.holdCount >= hold) {
                    this.holdCount = 0;
                    this.holdL = fl;
                    this.holdR = fr;
                }
                l += (this.holdL - l) * this.lsyAmount;
                r += (this.holdR - r) * this.lsyAmount;

                // Packets.
                if (this.packetPos === 0) {
                    const swap = this.prevL; this.prevL = this.curL; this.curL = swap;
                    const swapR = this.prevR; this.prevR = this.curR; this.curR = swapR;
                    this.packetLen = Math.round((0.008 + this.rng.next() * 0.022) * SR);
                    this.packetState = this.rng.next() < lossChance ? (this.rng.next() < 0.5 ? 1 : 2) : 0;
                    if (this.packetState) this.packetSide ^= 1;
                }
                this.curL[this.packetPos] = l;
                this.curR[this.packetPos] = r;
                if (this.packetState) {
                    const replacement = this.packetState === 1 ? 0 : (this.packetSide ? this.prevR[this.packetPos] : this.prevL[this.packetPos]);
                    if (this.packetSide) r = replacement; else l = replacement;
                }
                this.packetPos++;
                if (this.packetPos >= this.packetLen) this.packetPos = 0;
                L[i] = l;
                R[i] = r;
            }
        },
    });
};

registerWorkletProcessor("ribbit-bassdrum", bassdrumProcessor, workletParams(BASSDRUM_PARAMS));

export class RibbitBassDrum extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        const lsyMode = LSY_MODES.includes(options.lsy_mode) ? options.lsy_mode : "lowpass";
        super(audioContext, { name: "bassdrum", ...options }, {
            processor: "ribbit-bassdrum",
            params: BASSDRUM_PARAMS,
            lane: "1",
            sieve: "all",
            processorOptions: { lsy_mode: lsyMode },
        });
        this.llm_summary = "An inharmonic, non-ringing bass drum (the AE machine's voce 1 bd): body with pitch sweep, 70ms knock, click, asymmetric dirt; every hit varies (vary). Own rumble reverb (rvb, ducked by its own hits) and a degradation macro (lsy filter/decimation/dropouts at freq, pack = packet loss). dice=random rerolls it. Lane 1, every note.";
        this.lsy_mode = lsyMode;
        this.lastDice = null;
        this.options.lsy_mode = choiceOption(this, "lsy_mode", LSY_MODES, (value) => {
            this.node.post({ type: "lsy_mode", index: LSY_MODES.indexOf(value) });
        });
        // Not a stored setting but a gesture: any value rerolls. Reads back
        // as what the last roll was, so the console echoes something useful.
        this.options.dice = {
            get: () => this.lastDice ?? "none",
            set: () => this.dice(),
        };
    };

    // Rerolls every param within DICE_RANGES and the hidden lsy_mode.
    dice() {
        const now = this.audioContext.currentTime;
        const rolled = [];
        for (const [key, [low, high]] of Object.entries(DICE_RANGES)) {
            const value = low + Math.random() * (high - low);
            const param = this.params[key];
            param.audioParam.cancelScheduledValues(now);
            param.set(param.clamp(value));
            rolled.push(`${key}=${Number(value.toFixed(2))}`);
        }
        this.options.lsy_mode.set(LSY_MODES[Math.floor(Math.random() * LSY_MODES.length)]);
        this.lastDice = `${rolled.join(" ")} lsy_mode=${this.lsy_mode}`;
        return this.lastDice;
    };

    // `dice` is a gesture, not state: excluded from getOptions so a saved
    // session doesn't reroll the voice on load.
    getOptions() {
        const { dice, ...rest } = super.getOptions();
        return rest;
    };
};
