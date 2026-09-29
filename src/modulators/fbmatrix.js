import { RibbitModulator } from "../modulator.js";
import { RibbitParamSources } from "../param.js";
import { mulberry32, randomSeed } from "../random.js";

// Six effects arranged so each can feed the others — the AE machine's
// feedback matrix (`aemd_fbmatrix`, chapter 40), "the module that turns the
// effect section into an ecosystem": the reverb tail feeds the granulator,
// which feeds the delay, which feeds the resonators.
//
// In ribbit the effects are buses, so this is a modulator that owns *audio*:
// it taps each listed bus's output and sends it, shaped and delayed, into the
// inputs of the others. Each path is
//     bus.out → highpass (`hp`) → lowpass (`damp`) → saturation (`drive`)
//             → delay (`dtime`) → gain → other bus.in
// The delay is also what makes the cycle legal (Web Audio insists on one in
// every loop); a long `dtime` is a slow ping-pong between effects.
//
// **It cannot run away**: the routing matrix has a zero diagonal (no effect
// feeds itself) and every row sums to one, so `rot` changes *who* feeds whom
// without changing the total energy; the gains are `depth` × `g` (a ceiling
// below one), and if any tap's level passes `mute` the whole matrix ducks
// out for two seconds. "Cannot explode is not the same as cannot get loud" —
// come up from `depth=0`.
//
// `rot` walks the routing through its rotations (each effect feeding the
// next one along, then the one after…), blending between neighbours.
// `dice=now` deals a random safe matrix instead (`dice=off` returns to
// `rot`); `auto=on` re-deals every
// `sec` seconds, gliding between configurations. `buses` names the effect
// buses (default: every bus carrying an effect).
export class RibbitFBMatrix extends RibbitModulator {
    constructor(audioContext, {
        name = "fbmatrix",
        engine = null,
        buses = "",
        auto = "off",
        seed,
        depth = 0,
        rot = 0,
        g = 0.8,
        drive = 0.2,
        hp = 120,
        damp = 6000,
        dtime = 0.05,
        mute = 0.9,
        sec = 20,
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "The AE machine's feedback matrix: routes every listed effect bus's output (highpassed, damped, driven, delayed by dtime) into the inputs of the others. Zero diagonal, rows sum to one, gains depth x g < 1, and a mute cutout — it can get loud but can't run away. rot rotates who feeds whom; dice=now deals a random matrix, auto=on re-deals every sec. Start at depth=0.";
        this.engine = engine;
        this.busNames = String(buses).split(",").map((b) => b.trim()).filter(Boolean);
        this.auto = String(auto) === "on";
        this.seed = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : randomSeed();
        this._random = mulberry32(this.seed);
        this.dealt = null;       // a dice-dealt matrix, when there is one
        this.paths = [];         // built audio paths
        this.buses = [];
        this.mutedUntil = 0;
        this._nextDeal = null;

        this.options = {
            buses: {
                get: () => this.busNames.join(","),
                set: (value) => {
                    this.busNames = String(value).split(",").map((b) => b.trim()).filter(Boolean);
                    this._teardown();
                },
            },
            auto: {
                get: () => (this.auto ? "on" : "off"),
                set: (value) => { this.auto = ["on", "true", "1"].includes(String(value).trim()); },
                choices: ["on", "off"],
            },
            // Deals a random safe matrix; `dice=off` goes back to `rot`.
            dice: {
                get: () => (this.dealt ? "dealt" : "off"),
                set: (value) => {
                    if (String(value).trim() === "off") this.dealt = null;
                    else this._deal();
                },
            },
            seed: {
                get: () => this.seed,
                set: (value) => {
                    this.seed = String(value).trim().toLowerCase() === "random" ? randomSeed() : Math.floor(Number(value));
                    this._random = mulberry32(this.seed);
                },
            },
        };

        this._paramSources = new RibbitParamSources(audioContext);
        const p = (value, min, max) => this._paramSources.create(value, { min, max });
        this.params = {
            depth: p(depth, 0, 1),
            rot: p(rot, 0, 1),
            g: p(g, 0, 0.95),
            drive: p(drive, 0, 1),
            hp: p(hp, 20, 1000),
            damp: p(damp, 500, 16000),
            dtime: p(dtime, 0.003, 0.5),
            mute: p(mute, 0.1, 2),
            sec: p(sec, 1, 120),
        };
    };

    getOptions() {
        const { dice, ...rest } = super.getOptions();
        return rest;
    };

    _resolveBuses() {
        const engine = this.engine;
        if (!engine) return [];
        if (this.busNames.length) return this.busNames.map((name) => engine.buses.find((b) => b.name === name)).filter(Boolean);
        return engine.buses.filter((bus) => bus.processors.length > 0);
    };

    // One path per ordered pair (i → j, i ≠ j), plus a level meter per tap.
    _build(buses) {
        this._teardown();
        const ctx = this.audioContext;
        this.buses = buses;
        this.taps = buses.map((bus) => {
            const hp = ctx.createBiquadFilter();
            hp.type = "highpass";
            const lp = ctx.createBiquadFilter();
            lp.type = "lowpass";
            const shaper = ctx.createWaveShaper();
            const delay = ctx.createDelay(1);
            const meter = ctx.createAnalyser();
            meter.fftSize = 256;
            bus.output.connect(hp);
            hp.connect(lp).connect(shaper).connect(delay);
            bus.output.connect(meter);
            return { bus, hp, lp, shaper, delay, meter, buffer: new Float32Array(256) };
        });
        this.paths = [];
        for (let i = 0; i < buses.length; i++) {
            for (let j = 0; j < buses.length; j++) {
                if (i === j) continue;
                const gain = ctx.createGain();
                gain.gain.value = 0;
                this.taps[i].delay.connect(gain).connect(buses[j].input);
                this.paths.push({ i, j, gain });
            }
        }
        this._drive = null;
    };

    _teardown() {
        for (const path of this.paths) path.gain.disconnect();
        for (const tap of this.taps ?? []) {
            try { tap.bus.output.disconnect(tap.hp); } catch { /* bus already gone */ }
            try { tap.bus.output.disconnect(tap.meter); } catch { /* bus already gone */ }
            tap.hp.disconnect();
            tap.lp.disconnect();
            tap.shaper.disconnect();
            tap.delay.disconnect();
        }
        this.paths = [];
        this.taps = [];
        this.buses = [];
    };

    dispose() {
        this._teardown();
        this._paramSources.dispose();
    };

    // The routing: a circulant (each effect feeds the one `shift` along),
    // blended between neighbouring shifts by rot — rows sum to one, the
    // diagonal is always zero.
    _matrix(n) {
        if (this.dealt && this.dealt.length === n) return this.dealt;
        const m = Array.from({ length: n }, () => new Array(n).fill(0));
        if (n < 2) return m;
        const position = 1 + this.params.rot.get() * (n - 2);
        const s0 = Math.floor(position), s1 = Math.min(n - 1, s0 + 1);
        const w = position - s0;
        for (let i = 0; i < n; i++) {
            m[i][(i + s0) % n] += 1 - w;
            m[i][(i + s1) % n] += w;
        }
        return m;
    };

    // A random safe matrix: sparse, zero diagonal, rows normalised.
    _deal() {
        const n = Math.max(2, this._resolveBuses().length);
        this.dealt = Array.from({ length: n }, (_, i) => {
            const row = new Array(n).fill(0);
            for (let j = 0; j < n; j++) if (j !== i && this._random() < 0.5) row[j] = this._random();
            if (row.every((v) => v === 0)) row[(i + 1) % n] = 1;
            const sum = row.reduce((a, b) => a + b, 0);
            return row.map((v) => v / sum);
        });
    };

    onSchedule(fromBeat, toBeat, secondsPerBeat, clock) {
        const buses = this._resolveBuses();
        const changed = buses.length !== this.buses.length || buses.some((bus, i) => bus !== this.buses[i]);
        if (changed) this._build(buses);
        if (this.paths.length === 0) return;
        const ctx = this.audioContext;
        const now = ctx.currentTime;

        if (this.auto) {
            if (this._nextDeal === null) this._nextDeal = now + this.params.sec.get();
            if (now >= this._nextDeal) {
                this._deal();
                this._nextDeal = now + this.params.sec.get();
            }
        }

        // Safety cutout: any tap over `mute` ducks the matrix for 2s.
        const ceiling = this.params.mute.get();
        for (const tap of this.taps) {
            tap.meter.getFloatTimeDomainData(tap.buffer);
            let peak = 0;
            for (const x of tap.buffer) peak = Math.max(peak, Math.abs(x));
            if (peak > ceiling) this.mutedUntil = now + 2;
        }

        // Shape the circulating signal.
        const drive = this.params.drive.get();
        if (this._drive !== drive) {
            this._drive = drive;
            const curve = new Float32Array(1024);
            const k = 1 + drive * 6;
            for (let i = 0; i < 1024; i++) {
                const x = (i / 1023) * 2 - 1;
                curve[i] = Math.tanh(x * k) / Math.tanh(k);
            }
            for (const tap of this.taps) tap.shaper.curve = curve;
        }
        for (const tap of this.taps) {
            tap.hp.frequency.setTargetAtTime(this.params.hp.get(), now, 0.05);
            tap.lp.frequency.setTargetAtTime(this.params.damp.get(), now, 0.05);
            tap.delay.delayTime.setTargetAtTime(this.params.dtime.get(), now, 0.05);
        }
        const matrix = this._matrix(this.taps.length);
        const level = now < this.mutedUntil ? 0 : this.params.depth.get() * this.params.g.get();
        const glide = this.auto ? 0.6 : 0.05;
        for (const path of this.paths) path.gain.gain.setTargetAtTime(level * matrix[path.i][path.j], now, glide);
    };

    describeState() {
        const names = this.buses.map((b) => b.name);
        if (names.length < 2) return "[needs two or more effect buses]";
        const m = this._matrix(names.length);
        const routes = names.map((name, i) => `${name}→${names[m[i].indexOf(Math.max(...m[i]))]}`).join(" ");
        return `[${routes}${this.mutedUntil > this.audioContext.currentTime ? " · MUTED (too loud)" : ""}${this.dealt ? " · dealt" : ""}]`;
    };
};
