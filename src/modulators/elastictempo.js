import { RibbitModulator } from "../modulator.js";
import { RibbitParamSources } from "../param.js";
import { mulberry32, randomSeed } from "../random.js";

// The clock in arcs — the AE machine's elastic tempo (`aem_warp_CLOCK`,
// chapter 11): "it thins out, accelerates, brakes, and relaunches at a tempo
// mathematically related to the one it left". Metric modulation, made
// automatic; the manual traces it to a Teletype habit (`M RRND 150 2000`, a
// metro that re-rolls its interval every tick) with the blind roll replaced by
// a grammar.
//
// While `on`, every `epoch` sixteenth-steps an episode starts with chance
// `prob`. An episode is four phases, each a glide of the session's bpm:
//   sparse    slows down — the pattern opens up
//   accel     speeds up past where it started
//   brake     pulls back
//   relaunch  settles onto a plateau and holds it until the next episode
// Plateaus are only ever 0.5, 2/3, 3/4, 4/3, 3/2 or 2 × the *base* tempo
// (the bpm when it was switched on) — exact ratios, so the new tempo is
// musically related to the old — or, with chance `grid`, the base itself.
// `amt` is how far the tempo may move in the arcs, `len` scales all four
// phases, `fire=now` starts one immediately. `on=off` returns the clock to the
// base tempo.
//
// It drives the clock directly (the one other thing that does is `/clock
// bpm=`, and while this runs its episodes win), so every track, generator and
// automation in the session stretches together — which is the point: it's the
// clock that breathes, not one part.
//
// Recipes (manual): obvious — amt 0.6, epoch 32, prob 100, grid 20. Subtle —
// amt 0.25, grid 80.
const PLATEAUS = [0.5, 2 / 3, 0.75, 4 / 3, 1.5, 2];
const STEP = 0.25;
// Phase lengths in sixteenth-steps (× len), and where each phase aims as a
// fraction of amt: sparse down, accel past the start, brake back.
const PHASES = [["sparse", 16, -0.45], ["accel", 16, 0.55], ["brake", 8, -0.2], ["relaunch", 8, null]];

export class RibbitElasticTempo extends RibbitModulator {
    constructor(audioContext, {
        name = "elastictempo",
        engine = null,
        on = "off",
        base_bpm,
        seed,
        amt = 0.6,
        epoch = 64,
        prob = 60,
        grid = 50,
        len = 1,
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "The AE machine's elastic tempo: while on, every epoch steps an episode may start (prob%) — the session bpm glides through sparse (slower), accel (past the start), brake and relaunch, landing on a plateau of 0.5, 2/3, 3/4, 4/3, 3/2 or 2 x the base tempo (or back on base with grid%). amt = how far it moves, len scales the phases, fire=now starts one. Bends the clock itself, so the whole session stretches.";
        this.engine = engine;
        this.on = String(on) === "on" || on === true;
        this.baseBpm = Number.isFinite(Number(base_bpm)) ? Number(base_bpm) : null;
        this.seed = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : randomSeed();
        this._random = mulberry32(this.seed);
        this.episode = null;     // { segments: [{name, t0, t1, from, to}] }
        this.phase = "steady";
        this.plateau = 1;
        this._nextStep = null;
        this._stepCount = 0;
        this.history = [];

        this.options = {
            on: {
                get: () => (this.on ? "on" : "off"),
                set: (value) => {
                    const next = ["on", "true", "1"].includes(String(value).trim());
                    if (next && !this.on) this.baseBpm = this.engine?.clock.bpm ?? this.baseBpm;
                    if (!next && this.on) this._restore();
                    this.on = next;
                },
                choices: ["on", "off"],
            },
            // The tempo the plateaus are ratios of. Captured when switched on;
            // saved so a reload returns to the same grammar.
            base_bpm: {
                get: () => this.baseBpm ?? this.engine?.clock.bpm ?? 120,
                set: (value) => {
                    const n = Number(value);
                    if (!(n > 0)) throw new Error(`invalid base_bpm "${value}"`);
                    this.baseBpm = n;
                },
            },
            fire: {
                get: () => "-",
                set: () => this._start(this.audioContext.currentTime),
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
        this.params = {
            amt: this._paramSources.create(amt, { min: 0, max: 1 }),
            epoch: this._paramSources.create(epoch, { min: 8, max: 512 }),
            prob: this._paramSources.create(prob, { min: 0, max: 100 }),
            grid: this._paramSources.create(grid, { min: 0, max: 100 }),
            len: this._paramSources.create(len, { min: 0.25, max: 3 }),
        };
    };

    getOptions() {
        const { fire, ...rest } = super.getOptions();
        return rest;
    };

    dispose() {
        this._paramSources.dispose();
    };

    onClockStart() {
        this._nextStep = null;
        this._stepCount = 0;
    };

    _restore() {
        this.episode = null;
        this.phase = "steady";
        this.plateau = 1;
        if (this.engine && this.baseBpm) this.engine.clock.setBpm(this.baseBpm);
    };

    // Lays out one episode as four linear segments in AudioContext time,
    // each phase's length computed at the tempo it starts from.
    _start(time) {
        if (!this.engine) return;
        const base = this.baseBpm ?? this.engine.clock.bpm;
        this.baseBpm = base;
        const amt = this.params.amt.get();
        const len = this.params.len.get();
        let from = this.engine.clock.bpm;
        let t = time;
        const segments = [];
        let landing = 1;
        if (this._random() * 100 >= this.params.grid.get()) landing = PLATEAUS[Math.floor(this._random() * PLATEAUS.length)];
        for (const [name, steps, aim] of PHASES) {
            const target = aim === null ? base * landing : base * this.plateau * (1 + aim * amt);
            const seconds = (steps * len * STEP * 60) / ((from + target) / 2);
            segments.push({ name, t0: t, t1: t + seconds, from, to: target });
            t += seconds;
            from = target;
        }
        this.episode = { segments };
        this.plateau = landing;
        this.history.push(landing);
        if (this.history.length > 8) this.history.shift();
    };

    onSchedule(fromBeat, toBeat, secondsPerBeat, clock) {
        if (!this.on) return;
        if (!this.baseBpm) this.baseBpm = clock.bpm;
        // Episode starts, counted in sixteenth-steps.
        if (this._nextStep === null || this._nextStep < fromBeat) this._nextStep = Math.ceil(fromBeat / STEP) * STEP;
        const epoch = Math.max(8, Math.round(this.params.epoch.get()));
        while (this._nextStep < toBeat) {
            this._stepCount++;
            if (!this.episode && this._stepCount % epoch === 0 && this._random() * 100 < this.params.prob.get()) {
                this._start(clock.beatToTime(this._nextStep));
            }
            this._nextStep += STEP;
        }
        // Follow the envelope: set the bpm the current segment says, now.
        if (!this.episode) return;
        const now = this.audioContext.currentTime;
        const segment = this.episode.segments.find((s) => now >= s.t0 && now < s.t1);
        if (!segment) {
            const last = this.episode.segments[this.episode.segments.length - 1];
            if (now >= last.t1) {
                clock.setBpm(last.to);
                this.episode = null;
                this.phase = "steady";
            }
            return;
        }
        this.phase = segment.name;
        const f = (now - segment.t0) / (segment.t1 - segment.t0);
        const bpm = segment.from + (segment.to - segment.from) * f;
        if (Math.abs(bpm - clock.bpm) > 0.01) clock.setBpm(bpm);
    };

    describeState() {
        const bpm = this.engine?.clock.bpm ?? 0;
        const base = this.baseBpm ?? bpm;
        const factor = base ? bpm / base : 1;
        const ratio = (r) => ({ 0.5: "1/2", [2 / 3]: "2/3", 0.75: "3/4", [4 / 3]: "4/3", 1.5: "3/2", 2: "2", 1: "1" }[r] ?? r.toFixed(2));
        return `[${this.on ? this.phase : "off"} · ${bpm.toFixed(1)}bpm = ${factor.toFixed(3)}× base ${base.toFixed(1)}${this.history.length ? ` · plateaus ${this.history.map(ratio).join(" ")}` : ""}]`;
    };
};
