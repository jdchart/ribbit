import { RibbitModulator } from "../modulator.js";
import { RibbitParamSources } from "../param.js";
import { RibbitEvent } from "../event.js";
import { mulberry32, randomSeed } from "../random.js";

// The AE machine's sequencer: sixteen steps, eleven columns, and a 16×16
// Markov matrix deciding which step may follow which (manual chapters 6–10
// and 14). "A normal sequencer goes 1, 2, 3, 4. This one goes wherever the
// matrix lets it."
//
// **The grid.** Every step carries eleven independent properties, each an
// option holding sixteen comma-separated values:
//
//   trig     which lane answers: 0 rest, 1 bass drum, 2/3/4 the three
//            samplers, 5 the kit (through the sieve), 6 kick + big modal
//   note     0..127 — on lane 5 an *address*: it chooses which voices answer
//   vel      0..127
//   shift    micro-detune, 64 = none (±1.25 semitones)
//   metrics  the step's note value: 1/4 1/8 1/16 1/32 1/64 1/8t 1/16t 1/32t
//            1/8d 1/16d — irregular metrics make bars stop being bars
//   ratchet  retriggers inside the step, 1..8
//   ssize    multiplies the step length, 1..4
//   ratprob  chance (%) the ratchet actually fires
//   swing    per step (%): lengthens and shortens alternate steps of the walk
//   prob     chance (%) the step plays at all — thins without deleting
//   micro    pushes the event up to 25ms early/late (64 = centre) without
//            moving the clock
//
// A step becomes time exactly as the manual's chain says: note value ×
// s_size × swing, in beats — and the *clock itself* is what `elastictempo`
// bends, so everything in the session stretches together.
//
// **The matrix** (`matrix`, rows separated by `|`, each row the steps it may
// jump to, 1-based, `.` for none): when a row has several exits one is
// picked at random each pass. It can't get stuck — an empty row jumps to a
// random step. `shape=` loads the manual's four starting points (chain,
// returns, cells, wide) or clears/randomises it. With `rewrite=on` it edits
// itself every `every` steps: `morph=rewrite` redraws it (a clear before and
// after), `morph=mutate` removes one or two jumps and adds one or two (the
// grammar drifts — "the more musical of the two by a distance"); `density`
// is how many extra jumps per step a redraw adds on top of the chain.
//
// **Column animation** (`animate=note,metrics,…`): each listed column is a
// shift register — it rotates one position every step, and with chance
// `inject` a new value enters at the top. An injection on `note` or `shift`
// fires every `dicejumpers` listening to this sequencer (a change of note
// becomes a change of effect — wired in, as in the original). Animating
// `trig` draws the new family from `weights` (rest, voce 1, drum, sampler,
// bd·mat — proportions, not percentages): the macro control of the machine's
// character. Use it in short bursts and switch it off when it lands on an
// orchestration you like. `dispatch=` draws that orchestration by hand
// instead: sixteen heights 0..3 (rest, a sampler, the kit, kick/big modal)
// rewrite the trig column.
//
// **Where notes go.** Patch this into every AE voice's `notes`. Each event
// carries its lane, and each voice decides for itself (its `lane` and `sieve`
// options — see dsp/voice.js). Transposing the note column re-orchestrates
// the pattern; the full cycle of who answers repeats only after 840 notes.
// Events also carry `shift` (semitones), `noteNorm` (the note against the
// column's own range, which `slicer` reads) and `step`.
export const METRICS = {
    "1/4": 1, "1/8": 0.5, "1/16": 0.25, "1/32": 0.125, "1/64": 0.0625,
    "1/8t": 1 / 3, "1/16t": 1 / 6, "1/32t": 1 / 12, "1/8d": 0.75, "1/16d": 0.375,
};
const METRIC_NAMES = Object.keys(METRICS);
const STEPS = 16;

// Each numeric column: its range and default.
const COLUMNS = {
    trig: { min: 0, max: 6, fallback: 5 },
    note: { min: 0, max: 127, fallback: 48 },
    vel: { min: 0, max: 127, fallback: 100 },
    shift: { min: 0, max: 127, fallback: 64 },
    ratchet: { min: 1, max: 8, fallback: 1 },
    ssize: { min: 1, max: 4, fallback: 1 },
    ratprob: { min: 0, max: 100, fallback: 100 },
    swing: { min: 0, max: 100, fallback: 0 },
    prob: { min: 0, max: 100, fallback: 100 },
    micro: { min: 0, max: 127, fallback: 64 },
};
export const SEQ_COLUMNS = ["trig", "note", "vel", "shift", "metrics", "ratchet", "ssize", "ratprob", "swing", "prob", "micro"];
const MATRIX_SHAPES = ["chain", "returns", "cells", "wide", "clear", "random"];
const EVERY = [8, 16, 32, 64, 128];

function chainMatrix() {
    return Array.from({ length: STEPS }, (_, i) => [(i + 1) % STEPS]);
};

// The manual's four starting points.
function shapeMatrix(shape, random) {
    if (shape === "chain") return chainMatrix();
    if (shape === "clear") return Array.from({ length: STEPS }, () => []);
    if (shape === "returns") {
        // A chain that folds back every four: bars that return on themselves.
        return Array.from({ length: STEPS }, (_, i) => ((i + 1) % 4 === 0 ? [(i + 1) % STEPS, i - 3] : [(i + 1) % STEPS]));
    }
    if (shape === "cells") {
        // Five three-step cells, bridged: a rolling triplet feel against the grid.
        return Array.from({ length: STEPS }, (_, i) => {
            if (i === 15) return [0];
            const cellStart = Math.floor(i / 3) * 3;
            const last = cellStart + 2;
            return i === last ? [cellStart, Math.min(15, last + 1)] : [i + 1];
        });
    }
    if (shape === "wide") {
        // A wide permutation plus jumps of three: dense, no downbeat.
        return Array.from({ length: STEPS }, (_, i) => [(i * 7 + 3) % STEPS, (i + 3) % STEPS]);
    }
    // random: the chain plus one or two random exits per row.
    return Array.from({ length: STEPS }, (_, i) => {
        const row = new Set([(i + 1) % STEPS]);
        const extra = 1 + Math.floor(random() * 2);
        for (let k = 0; k < extra; k++) row.add(Math.floor(random() * STEPS));
        return [...row];
    });
};

function formatMatrix(matrix) {
    return matrix.map((row) => (row.length ? row.map((j) => j + 1).join(",") : ".")).join("|");
};

function parseMatrix(value) {
    const rows = String(value).split("|");
    if (rows.length !== STEPS) throw new Error(`invalid matrix — expected ${STEPS} rows separated by |, each the steps (1-16) it may jump to, or . for none`);
    return rows.map((row) => {
        const text = row.trim();
        if (text === "." || text === "") return [];
        const targets = text.split(",").map(Number);
        if (targets.some((t) => !Number.isInteger(t) || t < 1 || t > STEPS)) throw new Error(`invalid matrix row "${row}" — expected step numbers 1-${STEPS}`);
        return [...new Set(targets.map((t) => t - 1))];
    });
};

function parseColumn(name, value) {
    const entries = String(value).split(",").map((entry) => entry.trim());
    if (name === "metrics") {
        const bad = entries.find((entry) => !METRIC_NAMES.includes(entry));
        if (bad !== undefined) throw new Error(`invalid metric "${bad}" — expected ${METRIC_NAMES.join(", ")}`);
        return padColumn(entries, "1/16");
    }
    const { min, max, fallback } = COLUMNS[name];
    const numbers = entries.map(Number);
    if (numbers.some((n) => !Number.isFinite(n))) throw new Error(`invalid ${name} "${value}" — expected up to ${STEPS} comma-separated numbers ${min}..${max}`);
    return padColumn(numbers.map((n) => Math.max(min, Math.min(max, Math.round(n)))), fallback);
};

// A shorter list repeats to fill sixteen steps — `note=36,37` alternates.
function padColumn(values, fallback) {
    if (values.length === 0) return new Array(STEPS).fill(fallback);
    return Array.from({ length: STEPS }, (_, i) => values[i % values.length]);
};

export class RibbitMarkovSeq extends RibbitModulator {
    constructor(audioContext, {
        name = "markovseq",
        engine = null,
        seed,
        matrix,
        shape,
        rewrite = "off",
        every = 32,
        density = 1,
        morph = "mutate",
        animate = "",
        weights = "10,0,51,15,25",
        inject = 0.25,
        ...rest
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "The AE machine's sequencer: 16 steps x 11 columns (trig lane 0-6, note, vel, shift, metrics, ratchet, ssize, ratprob, swing, prob, micro), walked through a 16x16 Markov matrix (shape=chain|returns|cells|wide; rewrite=on rewrites or mutates it every N steps). animate=<columns> turns columns into shift registers (trig draws from weights). Patch into every AE voice's notes: each event carries a lane and each voice's sieve decides who answers, so transposing the note column re-orchestrates.";
        this.engine = engine;
        this.seed = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : randomSeed();
        this._random = mulberry32(this.seed);

        this.columns = {
            trig: padColumn([5], 5),
            note: [36, 39, 42, 45, 37, 51, 38, 59, 36, 47, 50, 53, 57, 43, 41, 63],
            vel: [110, 70, 90, 60, 100, 70, 85, 65, 110, 70, 90, 60, 100, 75, 85, 95],
            shift: padColumn([64], 64),
            metrics: padColumn(["1/16"], "1/16"),
            ratchet: padColumn([1], 1),
            ssize: padColumn([1], 1),
            ratprob: padColumn([100], 100),
            swing: padColumn([0], 0),
            prob: padColumn([100], 100),
            micro: padColumn([64], 64),
        };
        for (const column of SEQ_COLUMNS) {
            if (rest[column] !== undefined) this.columns[column] = parseColumn(column, rest[column]);
        }
        this.matrix = matrix ? parseMatrix(matrix) : shapeMatrix(MATRIX_SHAPES.includes(shape) ? shape : "chain", this._random);
        this.rewrite = String(rewrite) === "on" || rewrite === true;
        this.every = EVERY.includes(Number(every)) ? Number(every) : 32;
        this.density = Math.max(0, Math.min(4, Math.round(Number(density) || 0)));
        this.morph = morph === "rewrite" ? "rewrite" : "mutate";
        this.animated = new Set(String(animate).split(",").map((c) => c.trim()).filter((c) => SEQ_COLUMNS.includes(c)));
        this.weights = this._parseWeights(weights);

        this._reset();

        this.options = {
            seed: {
                get: () => this.seed,
                set: (value) => {
                    this.seed = String(value).trim().toLowerCase() === "random" ? randomSeed() : Math.floor(Number(value));
                    if (!Number.isFinite(this.seed)) throw new Error(`invalid seed "${value}" — expected a number or random`);
                    this._random = mulberry32(this.seed);
                },
            },
        };
        for (const column of SEQ_COLUMNS) {
            this.options[column] = {
                get: () => this.columns[column].join(","),
                set: (value) => { this.columns[column] = parseColumn(column, value); },
            };
        }
        Object.assign(this.options, {
            matrix: {
                get: () => formatMatrix(this.matrix),
                set: (value) => { this.matrix = parseMatrix(value); },
            },
            // A gesture over `matrix`: one of the manual's starting shapes.
            shape: {
                get: () => "-",
                set: (value) => {
                    const text = String(value).trim();
                    if (!MATRIX_SHAPES.includes(text)) throw new Error(`invalid shape "${value}" — expected ${MATRIX_SHAPES.join(", ")}`);
                    this.matrix = shapeMatrix(text, this._random);
                },
                choices: MATRIX_SHAPES,
            },
            rewrite: {
                get: () => (this.rewrite ? "on" : "off"),
                set: (value) => { this.rewrite = ["on", "true", "1"].includes(String(value).trim()); },
                choices: ["on", "off"],
            },
            every: {
                get: () => this.every,
                set: (value) => {
                    const n = Number(value);
                    if (!EVERY.includes(n)) throw new Error(`invalid every "${value}" — expected ${EVERY.join(", ")}`);
                    this.every = n;
                },
                choices: EVERY.map(String),
            },
            density: {
                get: () => this.density,
                set: (value) => { this.density = Math.max(0, Math.min(4, Math.round(Number(value) || 0))); },
            },
            morph: {
                get: () => this.morph,
                set: (value) => {
                    if (!["rewrite", "mutate"].includes(value)) throw new Error(`invalid morph "${value}" — expected rewrite or mutate`);
                    this.morph = value;
                },
                choices: ["mutate", "rewrite"],
            },
            animate: {
                get: () => [...this.animated].join(",") || "none",
                // `none` clears it (an empty value is a console error).
                set: (value) => {
                    const list = String(value).split(",").map((c) => c.trim()).filter((c) => c && c !== "none");
                    const bad = list.find((c) => !SEQ_COLUMNS.includes(c));
                    if (bad) throw new Error(`invalid column "${bad}" — expected ${SEQ_COLUMNS.join(", ")}`);
                    this.animated = new Set(list);
                },
            },
            weights: {
                get: () => this.weights.join(","),
                set: (value) => { this.weights = this._parseWeights(value); },
            },
            // A gesture: sixteen heights 0..3 rewrite the trig column —
            // 0 rest, 1 a sampler (picked for you), 2 the kit, 3 kick/big modal.
            dispatch: {
                get: () => "-",
                set: (value) => {
                    const heights = parseColumn("trig", value).map((h) => Math.min(3, h));
                    this.columns.trig = heights.map((h) => (h === 0 ? 0 : h === 1 ? 2 + Math.floor(this._random() * 3) : h === 2 ? 5 : 6));
                },
            },
        });

        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            // Chance per step that an animated column injects a new value.
            inject: this._paramSources.create(inject, { min: 0, max: 1 }),
        };
    };

    _parseWeights(value) {
        const weights = String(value).split(",").map(Number);
        if (weights.length !== 5 || weights.some((w) => !(w >= 0))) {
            throw new Error(`invalid weights "${value}" — expected five non-negative numbers: rest, voce1, drum, smp, bdmat`);
        }
        return weights;
    };

    _reset() {
        this.cursor = 0;          // the step about to play
        this.nextBeat = null;     // absolute beat it plays at
        this.walkCount = 0;
        this.position = 0;        // the step last played (for display)
        this.injections = 0;
    };

    dispose() {
        this._paramSources.dispose();
    };

    onClockStart() {
        this._random = mulberry32(this.seed);
        this._reset();
    };

    // Gestures (dispatch, shape) aren't state; everything else round-trips.
    getOptions() {
        const { dispatch, shape, ...rest } = super.getOptions();
        return rest;
    };

    stepBeats(step, parity) {
        const base = METRICS[this.columns.metrics[step]] ?? 0.25;
        const swing = this.columns.swing[step] / 100 / 3;
        return base * this.columns.ssize[step] * (parity ? 1 + swing : 1 - swing);
    };

    generateEvents(fromBeat, toBeat, secondsPerBeat = 0.5) {
        if (this.nextBeat === null || this.nextBeat < fromBeat - 4) this.nextBeat = Math.max(0, fromBeat);
        const events = [];
        const notes = this.columns.note.filter((_, i) => this.columns.trig[i] > 0);
        const low = notes.length ? Math.min(...notes) : 0;
        const high = notes.length ? Math.max(...notes) : 127;
        let guard = 0;
        while (this.nextBeat < toBeat && guard++ < 256) {
            const step = this.cursor;
            const length = this.stepBeats(step, this.walkCount & 1);
            const beat = this.nextBeat;
            this.position = step;
            const trig = this.columns.trig[step];
            if (trig > 0 && this._random() * 100 < this.columns.prob[step]) {
                const note = this.columns.note[step];
                const microBeats = ((this.columns.micro[step] - 64) / 64) * 0.025 / secondsPerBeat;
                const ratchets = this.columns.ratchet[step] > 1 && this._random() * 100 < this.columns.ratprob[step] ? this.columns.ratchet[step] : 1;
                for (let r = 0; r < ratchets; r++) {
                    const event = new RibbitEvent({
                        beat: Math.max(fromBeat, beat + (length * r) / ratchets + microBeats),
                        pitch: note,
                        velocity: this.columns.vel[step] / 127 * (r === 0 ? 1 : 0.8),
                        duration: (length / ratchets) * 0.9,
                    });
                    event.lane = trig;
                    event.shift = ((this.columns.shift[step] - 64) / 64) * 1.25;
                    event.noteNorm = high > low ? (note - low) / (high - low) : 0.5;
                    event.step = step;
                    events.push(event);
                }
            }
            this.nextBeat += length;
            this.walkCount++;
            this._advance(beat);
        }
        return events;
    };

    // After a step: where to go next, then the animations and rewrites that
    // happen "every step".
    _advance(beat) {
        const row = this.matrix[this.cursor];
        this.cursor = row.length ? row[Math.floor(this._random() * row.length)] : Math.floor(this._random() * STEPS);
        if (this.animated.size) this._animate(beat);
        if (this.rewrite && this.walkCount % this.every === 0) this._rewriteMatrix();
    };

    _animate(beat) {
        const inject = this.params.inject.get();
        let fired = false;
        for (const column of this.animated) {
            const values = this.columns[column];
            values.unshift(values.pop());
            if (this._random() < inject) {
                values[0] = this._injectValue(column);
                if (column === "note" || column === "shift") fired = true;
            }
        }
        if (fired) {
            this.injections++;
            this._fireJumpers(beat);
        }
    };

    _injectValue(column) {
        const random = this._random;
        if (column === "metrics") return METRIC_NAMES[Math.floor(random() * METRIC_NAMES.length)];
        if (column === "trig") {
            const total = this.weights.reduce((a, b) => a + b, 0) || 1;
            let pick = random() * total;
            const family = this.weights.findIndex((w) => (pick -= w) < 0);
            return [0, 1, 5, 2 + Math.floor(random() * 3), 6][Math.max(0, family)];
        }
        if (column === "note") {
            // Near the column's own material, so a pattern drifts rather than
            // scattering across the keyboard.
            const existing = this.columns.note[Math.floor(random() * STEPS)];
            return Math.max(24, Math.min(96, existing + Math.round((random() * 2 - 1) * 7)));
        }
        const { min, max } = COLUMNS[column];
        if (column === "shift" || column === "micro") return Math.round(64 + (random() * 2 - 1) * 40);
        return Math.round(min + random() * (max - min));
    };

    _fireJumpers(beat) {
        if (!this.engine) return;
        const time = this.engine.clock.beatToTime(beat);
        for (const modulator of this.engine.modulators) {
            if (typeof modulator.fireFrom === "function") modulator.fireFrom(this.name, time);
        }
    };

    _rewriteMatrix() {
        const random = this._random;
        if (this.morph === "rewrite") {
            this.matrix = chainMatrix().map((row) => {
                const exits = new Set(row);
                for (let k = 0; k < this.density; k++) exits.add(Math.floor(random() * STEPS));
                return [...exits];
            });
            return;
        }
        // mutate: take away one or two jumps (never a row's last exit) and
        // add one or two.
        const removals = 1 + Math.floor(random() * 2);
        for (let k = 0; k < removals; k++) {
            const i = Math.floor(random() * STEPS);
            if (this.matrix[i].length > 1) this.matrix[i].splice(Math.floor(random() * this.matrix[i].length), 1);
        }
        // Removals can't take a row's last exit but additions always land, so
        // left alone mutation only ever densifies; hold it near the density
        // a rewrite would draw.
        const total = this.matrix.reduce((sum, row) => sum + row.length, 0);
        const ceiling = STEPS * (1 + this.density) + 2;
        const additions = total >= ceiling ? 0 : 1 + Math.floor(random() * 2);
        for (let k = 0; k < additions; k++) {
            const i = Math.floor(random() * STEPS);
            const j = Math.floor(random() * STEPS);
            if (!this.matrix[i].includes(j)) this.matrix[i].push(j);
        }
    };

    // Terrarium's pattern shuffler: reorders the rows of the given columns
    // (all when empty). `coupled` applies one permutation to every column, so
    // each step moves whole; otherwise each column gets its own and notes,
    // velocities and ratchets recombine into new events.
    shuffle(columns = [], coupled = true, random = this._random) {
        const selected = columns.length ? columns.filter((c) => SEQ_COLUMNS.includes(c)) : SEQ_COLUMNS;
        const permutation = () => {
            const order = Array.from({ length: STEPS }, (_, i) => i);
            for (let i = STEPS - 1; i > 0; i--) {
                const j = Math.floor(random() * (i + 1));
                [order[i], order[j]] = [order[j], order[i]];
            }
            return order;
        };
        const shared = permutation();
        for (const column of selected) {
            const order = coupled ? shared : permutation();
            const values = this.columns[column];
            this.columns[column] = order.map((i) => values[i]);
        }
    };

    describeState() {
        const lanes = this.columns.trig.map((t) => (t === 0 ? "." : String(t))).join("");
        const exits = this.matrix.reduce((sum, row) => sum + row.length, 0);
        return `[step ${this.position + 1} · trig ${lanes} · ${exits} exits${this.rewrite ? ` · ${this.morph} every ${this.every}` : ""}${this.animated.size ? ` · animating ${[...this.animated].join(",")}` : ""}]`;
    };
};
