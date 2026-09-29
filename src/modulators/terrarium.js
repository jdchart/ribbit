import { RibbitModulator } from "../modulator.js";
import { RibbitParamSources, addressableParams } from "../param.js";
import { mulberry32, randomSeed } from "../random.js";

// A chaotic system with wandering agents that borrow parameters anywhere in
// the machine and always give them back — the AE machine's Terrarium
// (`aemd_terra`, chapter 45), "the deepest and least predictable module".
//
// A Lorenz attractor runs in the background (σ 10, β 8/3, `rho` the regime).
// `wanderers` agents follow it. An idle agent grabs a target with chance
// `grab` — which one depends on *where the trajectory is*: its lobe and height
// select a region, and a shuffled map ties regions to params. While it holds
// the target (a random `hold_min..hold_max` ms) it moves it by its own
// coordinate of the trajectory, up to `depth` of the param's range, smoothed
// by `glide` (low glitchy, high fluid). Then it releases it **to exactly the
// value it found** — nothing you set is ever lost. Each time the trajectory
// crosses from one lobe to the other the map is reshuffled with chance
// `scramble`, so the same movement never controls the same thing twice.
//
// `rho`: below 1 the system dies and modulation stops; 1..24.7 it settles to
// a fixed point (Terrarium goes quiet — a graceful off); ~28 full chaos, the
// butterfly (default); above, other regimes, some almost periodic. When the
// trajectory stops moving for half a second it notices, releases everything
// and waits. `speed` is how fast the whole system evolves.
//
// What it may grab is the pool `randomgestures` and `/x random` use (a
// ranged param with `.r` on), split into voices (tracks) and effects
// (processors): `balance` 0 voices only .. 1 effects only, and `fx_wt` scales
// the effects' share (at 0, the default, no effect is ever grabbed). `safety`
// shrinks the movement of delicate params — anything that is a level, a pitch
// or a tuning. `mode=modulo` grabs whole modules (every param of one object)
// instead of single params; `targets` narrows the pool to named objects or
// groups.
//
// **`hold=on` is the sculpting switch**: a released param stays where the
// agent left it. Leave it for a few minutes and the machine has rewritten its
// own settings — store the result before touching anything. `panic=now`
// releases everything at once and switches it off; `reset=now` returns the
// attractor to its start.
//
// **The pattern shuffler** (`terra_control`): name a `markovseq` in `shuffle`
// and, on each lobe crossing, with chance `sh`, its grid is reordered —
// `shuffle_cols` (default all) with `coupled=on` moving whole steps, `off`
// letting notes, velocities and ratchets recombine. Variations of the pattern
// arrive at the attractor's irregular pace rather than every four bars.
//
// Don't run it alongside per-param modulators on the same params — both write
// the same places and fight.
const DELICATE = /gain|level|pitch|tune|root|freq|oct|out|note/;
const MODES = ["param", "modulo"];

export class RibbitTerrarium extends RibbitModulator {
    constructor(audioContext, {
        name = "terrarium",
        engine = null,
        seed,
        mode = "param",
        hold = "off",
        targets = "",
        shuffle = "",
        shuffle_cols = "",
        coupled = "on",
        rho = 28,
        wanderers = 2,
        depth = 0.3,
        speed = 1,
        hold_min = 60,
        hold_max = 700,
        grab = 70,
        scramble = 80,
        safety = 0.6,
        glide = 0.85,
        balance = 0.5,
        fx_wt = 0,
        sh = 0,
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "The AE machine's Terrarium: a Lorenz attractor (rho = regime: <1 dies, 1-24.7 settles, ~28 chaos) whose agents (wanderers) grab params anywhere in the session, move them by the trajectory (depth, glide), hold them hold_min..hold_max ms, and put them back exactly — unless hold=on, which sculpts permanently. Lobe crossings reshuffle which region grabs what (scramble) and can shuffle a markovseq's grid (shuffle=<seq>, sh%). balance/fx_wt voices vs effects, safety protects levels and pitches, mode=modulo grabs whole modules, panic=now releases all.";
        this.engine = engine;
        this.seed = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : randomSeed();
        this._random = mulberry32(this.seed);
        this.mode = MODES.includes(mode) ? mode : "param";
        this.holdOn = String(hold) === "on";
        this.targetNames = String(targets).split(",").map((t) => t.trim()).filter(Boolean);
        this.shuffleTarget = String(shuffle).trim();
        this.shuffleColumns = String(shuffle_cols).split(",").map((t) => t.trim()).filter(Boolean);
        this.coupled = String(coupled) !== "off";
        this.active = true;
        this._resetAttractor();
        this.agents = [];
        this.map = [];
        this.stillFor = 0;
        this.collapsed = false;
        this.crossings = 0;
        this.shuffles = 0;
        this.lastTime = null;
        this.grabs = 0;

        const list = (field) => ({
            get: () => this[field].join(","),
            set: (value) => { this[field] = String(value).split(",").map((t) => t.trim()).filter(Boolean); },
        });
        this.options = {
            mode: {
                get: () => this.mode,
                set: (value) => {
                    if (!MODES.includes(value)) throw new Error(`invalid mode "${value}" — expected param or modulo`);
                    this.mode = value;
                },
                choices: MODES,
            },
            hold: {
                get: () => (this.holdOn ? "on" : "off"),
                set: (value) => { this.holdOn = ["on", "true", "1"].includes(String(value).trim()); },
                choices: ["on", "off"],
            },
            targets: list("targetNames"),
            shuffle: {
                get: () => this.shuffleTarget,
                set: (value) => { this.shuffleTarget = String(value).trim(); },
            },
            shuffle_cols: list("shuffleColumns"),
            coupled: {
                get: () => (this.coupled ? "on" : "off"),
                set: (value) => { this.coupled = String(value).trim() !== "off"; },
                choices: ["on", "off"],
            },
            seed: {
                get: () => this.seed,
                set: (value) => {
                    this.seed = String(value).trim().toLowerCase() === "random" ? randomSeed() : Math.floor(Number(value));
                    this._random = mulberry32(this.seed);
                },
            },
            panic: {
                get: () => "-",
                set: () => {
                    this.releaseAll(true);
                    this.active = false;
                },
            },
            reset: {
                get: () => "-",
                set: () => {
                    this._resetAttractor();
                    this.collapsed = false;
                    this.active = true;
                },
            },
        };

        this._paramSources = new RibbitParamSources(audioContext);
        const p = (value, min, max) => this._paramSources.create(value, { min, max });
        this.params = {
            rho: p(rho, 0.5, 60),
            wanderers: p(wanderers, 1, 16),
            depth: p(depth, 0, 1),
            speed: p(speed, 0.05, 4),
            hold_min: p(hold_min, 10, 8000),
            hold_max: p(hold_max, 10, 8000),
            grab: p(grab, 0, 100),
            scramble: p(scramble, 0, 100),
            safety: p(safety, 0, 1),
            glide: p(glide, 0, 0.98),
            balance: p(balance, 0, 1),
            fx_wt: p(fx_wt, 0, 1),
            sh: p(sh, 0, 100),
        };
    };

    getOptions() {
        const { panic, reset, ...rest } = super.getOptions();
        return rest;
    };

    dispose() {
        this.releaseAll(true);
        this._paramSources.dispose();
    };

    _resetAttractor() {
        this.x = 0.1; this.y = 0; this.z = 0;
        this.lastSign = 1;
        this.stillFor = 0;
    };

    // The pool: every rangeable, `.r`-on param on tracks (voices) and
    // processors (effects) — never modulators, never itself.
    _pool() {
        const engine = this.engine;
        if (!engine) return { voices: [], effects: [] };
        let objects;
        if (this.targetNames.length) {
            objects = [];
            const seen = new Set();
            const expand = (name) => {
                if (seen.has(name)) return;
                seen.add(name);
                const object = engine._resolveObject(name);
                if (object) objects.push(object);
                else for (const member of engine._resolveGroup?.(name)?.members ?? []) expand(member);
            };
            for (const name of this.targetNames) expand(name);
        } else {
            objects = [...engine.tracks, ...engine.processors];
        }
        const voices = [], effects = [];
        for (const object of objects) {
            if (engine.modulators.includes(object)) continue;
            const isEffect = engine.processors.includes(object);
            const entries = Object.entries(addressableParams(object) ?? {}).filter(([, param]) => param.canRandomize);
            if (entries.length === 0) continue;
            (isEffect ? effects : voices).push({ object, entries });
        }
        return { voices, effects };
    };

    // Picks what a region controls, via the shuffled map.
    _choose(region) {
        const { voices, effects } = this._pool();
        const fxShare = this.params.balance.get() * this.params.fx_wt.get();
        const voiceShare = 1 - this.params.balance.get();
        const total = fxShare + voiceShare;
        if (total <= 0) return null;
        const random = this._random;
        const fromEffects = effects.length && (voices.length === 0 || random() * total < fxShare);
        const bucket = fromEffects ? effects : voices;
        if (bucket.length === 0) return null;
        while (this.map.length < 64) this.map.push(this.map.length);
        const slot = this.map[region % this.map.length];
        const module = bucket[slot % bucket.length];
        const held = new Set(this.agents.flatMap((agent) => agent.targets.map((t) => t.param)));
        const free = module.entries.filter(([, param]) => !held.has(param));
        if (free.length === 0) return null;
        if (this.mode === "modulo") return free.map(([key, param]) => ({ key, param, object: module.object }));
        const [key, param] = free[Math.floor(slot / bucket.length + random() * free.length) % free.length];
        return [{ key, param, object: module.object }];
    };

    _reshuffle() {
        for (let i = this.map.length - 1; i > 0; i--) {
            const j = Math.floor(this._random() * (i + 1));
            [this.map[i], this.map[j]] = [this.map[j], this.map[i]];
        }
    };

    releaseAll(immediate = false) {
        for (const agent of this.agents) this._release(agent, immediate);
        this.agents = this.agents.filter((agent) => agent.targets.length);
    };

    _release(agent, immediate) {
        const now = this.audioContext.currentTime;
        for (const target of agent.targets) {
            if (this.holdOn && !immediate) continue;
            const audioParam = target.param.audioParam;
            audioParam.cancelScheduledValues(now);
            audioParam.setValueAtTime(audioParam.value, now);
            audioParam.linearRampToValueAtTime(target.param.encode(target.original), now + (immediate ? 0.02 : 0.25));
        }
        agent.targets = [];
    };

    onSchedule(fromBeat, toBeat, secondsPerBeat, clock) {
        const now = this.audioContext.currentTime;
        const elapsed = this.lastTime === null ? 0 : Math.min(0.2, Math.max(0, now - this.lastTime));
        this.lastTime = now;
        if (!this.active || elapsed === 0) return;

        // Integrate Lorenz: RK2 steps of at most 0.005 time units.
        const rho = this.params.rho.get();
        const total = elapsed * this.params.speed.get() * 0.9;
        const n = Math.max(1, Math.ceil(total / 0.005));
        const h = total / n;
        let speed = 0;
        for (let i = 0; i < n; i++) {
            const { x, y, z } = this;
            const dx = 10 * (y - x), dy = x * (rho - z) - y, dz = x * y - (8 / 3) * z;
            const mx = x + 0.5 * h * dx, my = y + 0.5 * h * dy, mz = z + 0.5 * h * dz;
            this.x = x + h * 10 * (my - mx);
            this.y = y + h * (mx * (rho - mz) - my);
            this.z = z + h * (mx * my - (8 / 3) * mz);
            speed = Math.hypot(dx, dy, dz);
        }
        if (!Number.isFinite(this.x)) this._resetAttractor();

        // Collapse: a trajectory that's stopped moving has died or settled.
        if (speed < 0.5) {
            this.stillFor += elapsed;
            if (this.stillFor > 0.5 && !this.collapsed) {
                this.collapsed = true;
                this.releaseAll(true);
            }
            return;
        }
        this.stillFor = 0;
        if (this.collapsed) this.collapsed = false;

        // Lobe crossing: reshuffle the map; maybe shuffle the pattern.
        const sign = this.x >= 0 ? 1 : -1;
        if (sign !== this.lastSign) {
            this.lastSign = sign;
            this.crossings++;
            if (this._random() * 100 < this.params.scramble.get()) this._reshuffle();
            if (this.shuffleTarget && this._random() * 100 < this.params.sh.get()) {
                const sequencer = this.engine?._resolveObject(this.shuffleTarget);
                if (sequencer?.shuffle) {
                    sequencer.shuffle(this.shuffleColumns, this.coupled, this._random);
                    this.shuffles++;
                }
            }
        }

        // Agents.
        const count = Math.round(this.params.wanderers.get());
        while (this.agents.length < count) this.agents.push({ targets: [], until: 0, axis: this.agents.length % 3 });
        while (this.agents.length > count) this._release(this.agents.pop(), false);
        const depth = this.params.depth.get();
        const safety = this.params.safety.get();
        const glide = this.params.glide.get();
        const timeConstant = 0.005 + glide * glide * 0.6;
        const holdMin = this.params.hold_min.get(), holdMax = this.params.hold_max.get();
        const region = (this.x >= 0 ? 32 : 0) + Math.max(0, Math.min(31, Math.floor(this.z / 1.6)));
        const coords = [this.x / 20, this.y / 27, (this.z - 25) / 25];
        for (const agent of this.agents) {
            if (agent.targets.length && now >= agent.until) this._release(agent, false);
            if (!agent.targets.length) {
                if (this._random() * 100 >= this.params.grab.get() * elapsed * 4) continue;
                const chosen = this._choose(region + agent.axis * 7);
                if (!chosen) continue;
                agent.targets = chosen.map((t) => ({ ...t, original: t.param.get() }));
                agent.until = now + (holdMin + this._random() * Math.max(0, holdMax - holdMin)) / 1000;
                this.grabs++;
                this.lastGrab = chosen.map((t) => `${t.object.name}.${t.key}`).join(" ");
            }
            const c = Math.max(-1, Math.min(1, coords[agent.axis]));
            for (const target of agent.targets) {
                const param = target.param;
                const scale = DELICATE.test(target.key) ? 1 - safety : 1;
                const value = param.clamp(target.original + c * depth * scale * (param.max - param.min));
                param.audioParam.setTargetAtTime(param.encode(value), now, timeConstant);
            }
        }
        this.lastEventTime = now;
    };

    describeState() {
        const { voices, effects } = this._pool();
        const held = this.agents.reduce((sum, agent) => sum + agent.targets.length, 0);
        const regime = this.params.rho.get() < 1 ? "dead" : this.params.rho.get() < 24.7 ? "settling" : "chaotic";
        return `[${this.active ? (this.collapsed ? "collapsed" : regime) : "panicked"} · pool ${voices.length} voices, ${effects.length} effects · holding ${held}${this.grabs ? ` · ${this.grabs} grabs, last ${this.lastGrab}` : ""}${this.shuffles ? ` · ${this.shuffles} shuffles` : ""}${this.holdOn ? " · HOLD (sculpting)" : ""}]`;
    };
};
