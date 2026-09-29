import { RibbitModulator } from "../modulator.js";
import { RibbitParamSources } from "../param.js";
import { scheduleRamp } from "../automation.js";
import { mulberry32, randomSeed } from "../random.js";

// The probability jumpers and the DICE — the AE machine's chapter 12. "Seven
// small modules sit and wait. When they receive a signal they throw dice and
// rewrite effect parameters, in tune where it matters."
//
// Each jumper owns one effect, and an effect knows its own musically sensible
// jump (see RibbitWorkletProcessor.jump): Cascade picks a delay time *in tune*
// and a new interval, Notverb throws a freeze for a while, Glaze re-rolls
// grain size and scatter, Drive a tuned delay time and a drive, Resonators a
// new root, Spectra rate/jump/grain/metal/octave, Breathe duck depths and a
// duck. Anything else named in `targets` without a jump of its own gets a
// small random walk of its rangeable params.
//
// **Two triggers**, as in the original. `dice` is the percentage chance, on
// every step (`step_beats`, a sixteenth by default), that *all* jumpers fire
// together — 0 nothing moves; 5–15 occasional surprises; 25–40 the effects
// become an instrument; 60+ constant reconfiguration. And the note-injection
// link: a `markovseq` named in `listen` fires every jumper whenever its
// animation injects a new note or shift — a change of note becomes a change
// of effect.
//
// Then each jumper rolls its own `probs` entry (`cascade:40,notverb:25`, %,
// default 50) before it moves. **Tuned** means: a delay time is a period of a
// note of the resonators' root and scale when a `resonators` processor
// exists (so moving that root retunes every echo), else of `/harmony`.
//
// The dice value is saved; the roll never is.
export class RibbitDiceJumpers extends RibbitModulator {
    constructor(audioContext, {
        name = "dicejumpers",
        engine = null,
        targets = "",
        probs = "",
        listen = "",
        seed,
        dice = 0,
        step_beats = 0.25,
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "The AE machine's probability jumpers: dice = % chance per step that every jumper fires; each targeted effect then rolls its own probs entry and jumps in its own musical way (cascade/drivenet pick delay times in tune with resonators' root, notverb throws a timed freeze, glaze/spectra/breathe/resonators re-roll their own). listen=<markovseq> also fires them on every note injection. targets defaults to every effect that can jump.";
        this.engine = engine;
        this.targetNames = String(targets).split(",").map((t) => t.trim()).filter(Boolean);
        this.probs = this._parseProbs(probs);
        this.listen = String(listen).split(",").map((t) => t.trim()).filter(Boolean);
        this.seed = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : randomSeed();
        this._random = mulberry32(this.seed);
        this._next = null;
        this.fires = 0;
        this.lastFire = null;

        const list = (field) => ({
            get: () => this[field].join(","),
            set: (value) => { this[field] = String(value).split(",").map((t) => t.trim()).filter(Boolean); },
        });
        this.options = {
            // Which effects the jumpers own (comma names). Empty: every
            // processor that implements jump().
            targets: list("targetNames"),
            probs: {
                get: () => Object.entries(this.probs).map(([k, v]) => `${k}:${v}`).join(","),
                set: (value) => { this.probs = this._parseProbs(value); },
            },
            // markovseq name(s) whose note injections fire every jumper.
            listen: list("listen"),
            seed: {
                get: () => this.seed,
                set: (value) => {
                    this.seed = String(value).trim().toLowerCase() === "random" ? randomSeed() : Math.floor(Number(value));
                    if (!Number.isFinite(this.seed)) throw new Error(`invalid seed "${value}"`);
                    this._random = mulberry32(this.seed);
                },
            },
        };

        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            dice: this._paramSources.create(dice, { min: 0, max: 100 }),
            step_beats: this._paramSources.create(step_beats, { min: 0.0625, max: 4 }),
        };
    };

    _parseProbs(value) {
        const probs = {};
        for (const entry of String(value ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
            const [key, amount] = entry.split(":");
            const n = Number(amount);
            if (!key || !Number.isFinite(n)) throw new Error(`invalid probs entry "${entry}" — expected <effect>:<percent>`);
            probs[key] = Math.max(0, Math.min(100, n));
        }
        return probs;
    };

    dispose() {
        this._paramSources.dispose();
    };

    onClockStart() {
        this._next = null;
    };

    onSchedule(fromBeat, toBeat, secondsPerBeat, clock) {
        const step = Math.max(0.0625, this.params.step_beats.get());
        if (this._next === null || this._next < fromBeat) this._next = Math.ceil(fromBeat / step) * step;
        const dice = this.params.dice.get();
        while (this._next < toBeat) {
            if (dice > 0 && this._random() * 100 < dice) this.fire(clock.beatToTime(this._next));
            this._next += step;
        }
    };

    // The note-injection link (called by markovseq).
    fireFrom(sequencer, time) {
        if (this.listen.includes(sequencer)) this.fire(time);
    };

    _targets() {
        if (!this.engine) return [];
        if (this.targetNames.length) return this.targetNames.map((name) => this.engine._resolveObject(name)).filter(Boolean);
        return this.engine.processors.filter((p) => typeof p.jump === "function");
    };

    // The shared tuning: resonators' root/scale if there is one, /harmony's
    // otherwise.
    _tuning() {
        const resonators = this.engine?.processors.find((p) => typeof p.tuning === "function");
        if (resonators) return resonators.tuning();
        return this.engine ? { root: this.engine.harmony.root, scale: this.engine.harmony.scale } : null;
    };

    // Every jumper rolls its own probability, then jumps.
    fire(time) {
        const tuning = this._tuning();
        const moved = [];
        for (const target of this._targets()) {
            const chance = this.probs[target.name] ?? 50;
            if (this._random() * 100 >= chance) continue;
            if (typeof target.jump === "function") target.jump(this._random, time, tuning);
            else this._walk(target, time);
            moved.push(target.name);
        }
        this.fires++;
        this.lastFire = moved.length ? moved.join(",") : "nothing (every roll missed)";
        this.lastEventTime = time;
    };

    // A target with no jump of its own: nudge its rangeable params.
    _walk(target, time) {
        const params = target.source?.params ? { ...target.source.params, ...target.params } : target.params;
        for (const param of Object.values(params ?? {})) {
            if (!param.canRandomize || this._random() > 0.4) continue;
            const span = param.max - param.min;
            const next = param.clamp(param.get() + (this._random() * 2 - 1) * 0.25 * span);
            scheduleRamp(this.audioContext, param.audioParam, param.audioParam.value, param.encode(next), 0.02, { startTime: time });
        }
    };

    describeState() {
        const count = this._targets().length;
        return `[${count} jumper${count === 1 ? "" : "s"}${this.listen.length ? ` · listening to ${this.listen.join(",")}` : ""}${this.fires ? ` · ${this.fires} throws · last moved ${this.lastFire}` : ""}]`;
    };
};
