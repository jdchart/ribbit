import { RibbitWorkletProcessor } from "../dsp/effect.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams, toggleOption, isOn } from "../dsp/spec.js";

// A magnetic transport and a spring tank — the AE machine's Oxide
// (`aemd_tape`), on the looper's return. "It can slow the tape almost to a
// standstill, and it can let the recording wear out and never come back."
// With `tape` and `spring` both off it isn't there at all: a bit-exact bypass.
//
// **`spool`** is the speed of the transport (1 nominal, down to 0.02 — a
// stationary tape plays nothing). Below 1, three things happen at once
// because they share a cause: the pitch drops, the top end goes (high
// frequency response depends on tape speed across the head), and wow/flutter
// deepen (a slow transport is an uneven one). It's in series with the
// looper's own `speed`, so the two multiply.
//
// **`wear` and `disint`: the loop consuming itself.** `wear` alone is how worn
// the tape is. Switch `disint` on and it becomes a process: the tape sheds
// oxide pass after pass and it doesn't come back — only `disint=off` restores
// it (a fresh reel). What's lost is paired, which is why it reads as
// material rather than as an EQ: the top end *and* the level fall together
// (the manual's table — 72% oxide: 9.7kHz, 77%; 50%: 6.2kHz, 59%; 30%:
// 3.4kHz, 43%; 15%: 1.6kHz, 30%; 5%: 580Hz, 22%; 2%: 350Hz, 20%, where it
// stops — a dark residue, not silence). Along the way dropouts arrive, deeper
// and more often; hiss rises ~9dB; wow deepens by half again. The music sinks
// while the noise climbs to meet it.
//
// **`wear` is the clock.** It sets both how worn the tape starts and how fast
// it wears, with the manual's measured timings: 0.02 finishes in 10.6
// minutes, 0.05 in 4.1, 0.1 in 1.9, 0.15 in 73s, 0.2 in 52s, 0.3 in 31s,
// 0.5 in 14s. describeState() is *Time to Degradation*: with disint on it
// counts down to the residue (and recalculates if you move wear mid-run); off,
// it quotes what a full run would take. The recording itself is never harmed —
// the wear lives here, not in the loop.
//
// `wow` (0.6Hz sway, 6Hz tremble, slow drift), `sat` (asymmetric, level
// compensated), `tone` (the heads: the ceiling spool pulls down), `hiss`
// (part follows the signal like bias noise, part is always there — the part
// that surfaces in a disintegration), `trim` (0..6, the attendant's gain —
// past 1 a soft saturation of its own; inactive with tape off).
//
// **`spring`** switches in a pair of spring tanks, modelled by dispersion
// (chains of allpasses: high frequencies travel the coil faster, hence the
// metallic chirp), band-limited from ~140Hz up, the two channels a few
// percent apart and cross-fed. `spring_mix`, `size` (length and decay: guitar
// amp to a room made of wire), `color` (brightness and dispersion density).
export const OXIDE_PARAMS = {
    spool: { value: 1, min: 0.02, max: 1 },
    wear: { value: 0.05, min: 0.02, max: 0.5 },
    wow: { value: 0.2, min: 0, max: 1 },
    sat: { value: 0.2, min: 0, max: 1 },
    tone: { value: 0.7, min: 0, max: 1 },
    hiss: { value: 0.15, min: 0, max: 1 },
    trim: { value: 1, min: 0, max: 6 },
    spring_mix: { value: 0.3, min: 0, max: 1 },
    size: { value: 0.5, min: 0, max: 1 },
    color: { value: 0.5, min: 0, max: 1 },
};

// The manual's wear timings (seconds to the residue), log-log interpolated.
// (The worklet factory below carries its own copy: it can't see this module.)
const WEAR_TIMES = [[0.02, 636], [0.05, 246], [0.1, 114], [0.15, 73], [0.2, 52], [0.3, 31], [0.5, 14]];
export function wearFinishSeconds(wear) {
    const w = Math.max(0.02, Math.min(0.5, wear));
    for (let i = 0; i < WEAR_TIMES.length - 1; i++) {
        const [w0, t0] = WEAR_TIMES[i], [w1, t1] = WEAR_TIMES[i + 1];
        if (w <= w1) {
            const f = Math.log(w / w0) / Math.log(w1 / w0);
            return Math.exp(Math.log(t0) + f * (Math.log(t1) - Math.log(t0)));
        }
    }
    return 14;
};

export function oxideProcessor(Base, DSP) {
    const { SR, TAU, clamp, tanh, asym, SVF, OnePole, Delay, Allpass1, Follower, Rng, effectProcessor } = DSP;
    const RESIDUE = 0.02;
    const SHAPE = 1.78; // fitted to the manual's "notice / clearly old / finished" times
    const OXIDE_TABLE = [[1, 16000, 1], [0.72, 9700, 0.77], [0.5, 6200, 0.59], [0.3, 3400, 0.43], [0.15, 1600, 0.3], [0.05, 580, 0.22], [0.02, 350, 0.2]];
    const finish = (wear) => {
        const table = [[0.02, 636], [0.05, 246], [0.1, 114], [0.15, 73], [0.2, 52], [0.3, 31], [0.5, 14]];
        const w = clamp(wear, 0.02, 0.5);
        for (let i = 0; i < table.length - 1; i++) {
            if (w <= table[i + 1][0]) {
                const f = Math.log(w / table[i][0]) / Math.log(table[i + 1][0] / table[i][0]);
                return Math.exp(Math.log(table[i][1]) + f * (Math.log(table[i + 1][1]) - Math.log(table[i][1])));
            }
        }
        return 14;
    };
    const oxideLookup = (o, column) => {
        for (let i = 0; i < OXIDE_TABLE.length - 1; i++) {
            const a = OXIDE_TABLE[i], b = OXIDE_TABLE[i + 1];
            if (o >= b[0]) {
                const f = (o - b[0]) / (a[0] - b[0]);
                return b[column] + (a[column] - b[column]) * f;
            }
        }
        return OXIDE_TABLE[OXIDE_TABLE.length - 1][column];
    };

    class Shifter {
        constructor() {
            this.line = new Delay(Math.ceil(0.3 * SR));
            this.phase = 0;
        }
        process(x, ratio, window) {
            this.line.write(x);
            this.phase += (1 - ratio) / window;
            this.phase -= Math.floor(this.phase);
            const p2 = (this.phase + 0.5) % 1;
            const w1 = Math.sin(Math.PI * this.phase), w2 = Math.sin(Math.PI * p2);
            return this.line.readHermite(2 + this.phase * window) * w1 * w1 + this.line.readHermite(2 + p2 * window) * w2 * w2;
        }
    }

    class Spring {
        constructor(scale) {
            this.scale = scale;
            this.line = new Delay(Math.ceil(0.16 * SR));
            this.chain = [];
            for (let i = 0; i < 10; i++) this.chain.push(new Allpass1(0.6));
            this.hp = new OnePole(140);
            this.lp = new OnePole(4000);
            this.out = 0;
        }
    }

    const Processor = effectProcessor(Base, {
        setup() {
            this.tape = !!this.opts.tape;
            this.disint = !!this.opts.disint;
            this.spring = !!this.opts.spring;
            this.progress = 0;           // 0 fresh reel .. 1 residue
            this.shiftL = new Shifter();
            this.shiftR = new Shifter();
            this.toneL = new SVF(12000, 0.6);
            this.toneR = new SVF(12000, 0.6);
            this.rng = new Rng(0x0c1d);
            this.follower = new Follower(0.01, 0.2);
            this.hissL = new OnePole(7000);
            this.hissR = new OnePole(7000);
            this.dropGain = 1;
            this.dropTarget = 1;
            this.dropLeft = 0;
            this.wowPhase = 0;
            this.flutPhase = 0;
            this.drift = 0;
            this.springs = [new Spring(1), new Spring(1.031)];
            this.statusTimer = 0;
        },
        onMessage(m) {
            if (m.type === "flags") {
                if (m.disint === false && this.disint) this.progress = 0; // threads a fresh reel
                this.tape = m.tape;
                this.disint = m.disint;
                this.spring = m.spring;
            }
        },
        render(inL, inR, outL, outR, P, frames) {
            if (!this.tape && !this.spring) {
                // Bit-exact bypass.
                outL.set(inL);
                outR.set(inR);
                return;
            }
            const finishSeconds = finish(P.wear);
            if (this.disint) this.progress = Math.min(1, this.progress + frames / SR / finishSeconds);
            const start = 1 - 0.9 * P.wear;
            const oxide = this.disint ? start - (start - RESIDUE) * Math.pow(this.progress, SHAPE) : start;
            const worn = 1 - oxide;
            const oxideCut = oxideLookup(oxide, 1);
            const oxideLevel = oxideLookup(oxide, 2);
            const spool = P.spool;
            const ceiling = 3000 + 17000 * P.tone;
            const cutoff = Math.min(SR * 0.45, Math.min(ceiling * Math.pow(spool, 0.7), oxideCut));
            this.toneL.set(cutoff, 0.6);
            this.toneR.set(cutoff, 0.6);
            const wowCents = P.wow * 25 * (1 + 3 * (1 - spool)) * (1 + 0.5 * worn);
            const satGain = 1 + P.sat * 4;
            // Unity slope at rest (d/dx tanh(x+b) at 0 is 1 - tanh²b), so
            // sat thickens and compresses peaks rather than adding level.
            const satNorm = 1 / (satGain * (1 - Math.pow(tanh(0.2), 2)));
            const hissLevel = P.hiss * 0.012 * (1 + 1.8 * worn);
            const dropRate = 4 * Math.pow(worn, 1.5) / SR;
            const trim = P.trim;
            const springSize = 0.025 + 0.1 * P.size;
            const springFb = 0.3 + 0.55 * P.size;
            const springCoef = 0.45 + 0.4 * P.color;
            const springLp = 1800 + 4500 * P.color;
            for (const spring of this.springs) {
                spring.lp.set(springLp);
                for (const ap of spring.chain) ap.a = springCoef;
            }
            // One pass of one tank: the coil (a delay), its dispersion (the
            // allpass chain — the chirp), its bandwidth, its feedback.
            const runSpring = (spring, feed) => {
                let v = spring.line.read(springSize * spring.scale * SR);
                for (let k = 0; k < spring.chain.length; k++) v = spring.chain[k].process(v);
                v = spring.lp.lp(v);
                spring.line.write(feed + v * springFb);
                spring.out = v;
            };
            for (let i = 0; i < frames; i++) {
                let l = inL[i], r = inR[i];
                if (this.tape) {
                    this.wowPhase += 0.6 / SR;
                    this.flutPhase += 6 / SR;
                    this.drift += (this.rng.bi() - this.drift) * 0.00002;
                    const cents = wowCents * (Math.sin(TAU * this.wowPhase) + 0.3 * Math.sin(TAU * this.flutPhase) + this.drift * 2);
                    const ratio = spool * Math.pow(2, cents / 1200);
                    if (ratio < 0.9999 || ratio > 1.0001) {
                        l = this.shiftL.process(l, ratio, 0.09 * SR);
                        r = this.shiftR.process(r, ratio, 0.09 * SR);
                    }
                    l = asym(l * satGain, 0.2) * satNorm;
                    r = asym(r * satGain, 0.2) * satNorm;
                    l = this.toneL.process(l);
                    r = this.toneR.process(r);
                    // Dropouts: the coating no longer meets the head.
                    if (this.dropLeft > 0) {
                        if (--this.dropLeft === 0) this.dropTarget = 1;
                    } else if (this.rng.next() < dropRate) {
                        this.dropLeft = Math.round((0.008 + this.rng.next() * 0.032) * SR);
                        this.dropTarget = 1 - (0.3 + 0.7 * worn) * this.rng.next();
                    }
                    this.dropGain += (this.dropTarget - this.dropGain) * 0.004;
                    const env = this.follower.process((l + r) * 0.5);
                    const level = oxideLevel * this.dropGain;
                    const hissAmount = hissLevel * (0.5 + env * 4);
                    l = l * level + this.hissL.lp(this.rng.bi()) * hissAmount;
                    r = r * level + this.hissR.lp(this.rng.bi()) * hissAmount;
                    // The attendant's trim: clean to 1, a soft ceiling past it.
                    if (trim <= 1) {
                        l *= trim;
                        r *= trim;
                    } else {
                        l = tanh(l * trim * 0.8) / 0.8;
                        r = tanh(r * trim * 0.8) / 0.8;
                    }
                }
                if (this.spring) {
                    const a = this.springs[0], b = this.springs[1];
                    const feedA = a.hp.hp(l) + b.out * 0.3;
                    const feedB = b.hp.hp(r) + a.out * 0.3;
                    runSpring(a, feedA);
                    runSpring(b, feedB);
                    const m = P.spring_mix;
                    l = l * (1 - m * 0.5) + a.out * m;
                    r = r * (1 - m * 0.5) + b.out * m;
                }
                outL[i] = l;
                outR[i] = r;
            }
            this.statusTimer += frames;
            if (this.statusTimer > SR / 2) {
                this.statusTimer = 0;
                this.port.postMessage({ type: "status", oxide, remaining: this.disint ? (1 - this.progress) * finishSeconds : finishSeconds, running: this.disint });
            }
        },
    });
    return Processor;
};

registerWorkletProcessor("ribbit-oxide", oxideProcessor, workletParams(OXIDE_PARAMS));

export class RibbitOxide extends RibbitWorkletProcessor {
    constructor(audioContext, options = {}) {
        const flags = { tape: isOn(options.tape, true), disint: isOn(options.disint, false), spring: isOn(options.spring, false) };
        super(audioContext, { name: "oxide", ...options }, {
            processor: "ribbit-oxide",
            params: OXIDE_PARAMS,
            processorOptions: flags,
        });
        this.llm_summary = "Tape transport and spring tank for the looper's return (the AE machine's oxide): spool slows the tape (pitch, top end and steadiness fall together), wear + disint=on make the tape shed oxide irreversibly (top end and level sink together, dropouts and hiss rise; wear 0.15 finishes in ~73s, 0.05 in ~4min); describeState counts down Time to Degradation. wow, sat, tone, hiss, trim (the attendant's gain, up to 6). spring=on adds a dispersive two-spring tank (spring_mix, size, color). tape and spring off = bit-exact bypass.";
        Object.assign(this, flags);
        this.status = null;
        const sendFlags = () => this.send({ type: "flags", tape: this.tape, disint: this.disint, spring: this.spring });
        this.options = {
            tape: toggleOption(this, "tape", sendFlags),
            // On: the tape starts wearing away. Off: a fresh reel.
            disint: toggleOption(this, "disint", sendFlags),
            spring: toggleOption(this, "spring", sendFlags),
        };
        this.onWorkletMessage = (message) => {
            if (message.type === "status") this.status = message;
        };
    };

    // Time to Degradation, read from the tape's actual state.
    describeState() {
        const format = (seconds) => (seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s` : `${seconds.toFixed(0)}s`);
        if (!this.tape && !this.spring) return "[bypassed]";
        if (!this.status) return `[a full run at wear ${this.params.wear.get().toFixed(2)} takes ${format(wearFinishSeconds(this.params.wear.get()))}]`;
        const { oxide, remaining, running } = this.status;
        return running
            ? `[disintegrating — oxide ${(oxide * 100).toFixed(0)}%, ${remaining > 0.5 ? `${format(remaining)} to the residue` : "at the residue"}]`
            : `[oxide ${(oxide * 100).toFixed(0)}% · a full run at this wear takes ${format(remaining)}]`;
    };
};
