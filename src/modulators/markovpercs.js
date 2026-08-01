import { RibbitModulator } from "../modulator.js";
import { RibbitParamSources } from "../param.js";
import { RibbitEvent } from "../event.js";
import { PERC_CATEGORIES } from "../synths/percsampler.js";
import { mulberry32, randomSeed } from "../random.js";

// Chain states: a rest, or one of PERC_CATEGORIES. Index 0 is the rest, so
// state n>0 is PERC_CATEGORIES[n - 1].
const STATES = ["rest", ...PERC_CATEGORIES];

// Row = state just played, column = state played next, in STATES order
// ([rest, kicks, snares, hats, percs]). Every row sums to 1.
//
// These are named for the *texture* a first-order chain can actually produce,
// not for genre patterns. It's worth being blunt about why there's no
// "fourfloor" here: a first-order chain's only input is the previous step, so
// it has no idea where in the bar it is and cannot place a kick on every
// downbeat except by accident. A grid-position-driven generator (euclidean,
// step-string) is the right tool for that, and is exactly the kind of second
// generator this modulator's slot-index contract is designed to share the
// drum sampler with.
const STYLES = {
    // Long silences broken by isolated hits.
    sparse: [
        [0.72, 0.08, 0.05, 0.10, 0.05],
        [0.70, 0.05, 0.10, 0.10, 0.05],
        [0.75, 0.08, 0.02, 0.10, 0.05],
        [0.65, 0.08, 0.07, 0.15, 0.05],
        [0.70, 0.05, 0.05, 0.10, 0.10],
    ],
    // Hats beget hats: continuous runs with other voices punctuating.
    rolling: [
        [0.25, 0.15, 0.05, 0.50, 0.05],
        [0.15, 0.05, 0.10, 0.65, 0.05],
        [0.15, 0.10, 0.05, 0.65, 0.05],
        [0.20, 0.08, 0.07, 0.60, 0.05],
        [0.20, 0.10, 0.05, 0.55, 0.10],
    ],
    // Low self-transition everywhere: a voice rarely repeats, so hits keep
    // landing on a different part of the kit.
    broken: [
        [0.30, 0.25, 0.15, 0.20, 0.10],
        [0.25, 0.02, 0.30, 0.28, 0.15],
        [0.30, 0.25, 0.02, 0.28, 0.15],
        [0.28, 0.25, 0.20, 0.07, 0.20],
        [0.30, 0.22, 0.20, 0.20, 0.08],
    ],
    // Kick-dominant, everything else incidental.
    kickheavy: [
        [0.30, 0.45, 0.05, 0.15, 0.05],
        [0.25, 0.40, 0.10, 0.20, 0.05],
        [0.30, 0.40, 0.05, 0.20, 0.05],
        [0.25, 0.45, 0.08, 0.17, 0.05],
        [0.30, 0.40, 0.10, 0.15, 0.05],
    ],
    // Uniform: every state equally likely from every state.
    chaotic: [
        [0.20, 0.20, 0.20, 0.20, 0.20],
        [0.20, 0.20, 0.20, 0.20, 0.20],
        [0.20, 0.20, 0.20, 0.20, 0.20],
        [0.20, 0.20, 0.20, 0.20, 0.20],
        [0.20, 0.20, 0.20, 0.20, 0.20],
    ],
};


// Picks an index from one transition row. Walks the cumulative distribution
// and falls back to the last index, so a row that sums to slightly under 1
// (a hand-edited table, floating-point drift) degrades to "pick the last
// state" rather than returning undefined.
function pickState(row, random) {
    const roll = random();
    let cumulative = 0;
    for (let i = 0; i < row.length; i++) {
        cumulative += row[i];
        if (roll < cumulative) return i;
    }
    return row.length - 1;
};

// An event-generating modulator (like RibbitRandomNotes — see that file for
// how the .notes patch mechanism works) that produces *drum* rhythms for
// RibbitPercSampler.
//
// The key behavioural difference from randomnotes: randomnotes rolls the dice
// live at every candidate slot, so it never repeats itself. This generates a
// fixed pattern *once*, up front, and then loops that same pattern — the same
// hits on the same slots every pass — until something regenerates it. That
// makes it a rhythm you can build a track on rather than a permanent
// shimmer. Anything that changes the pattern's shape (style, seed, steps,
// step_beats, density) regenerates on set; `seed=random` is the plain "give
// me another one" gesture.
//
// The pattern stores a *category* and a *variant within that category*, not a
// finished slot number. The slot arithmetic (category * slotsPerCategory +
// variant) happens at delivery time against whatever it's patched into, so
// the same pattern maps correctly onto a percsampler with 1 slot per category
// or 8. See _stride().
export class RibbitMarkovPercs extends RibbitModulator {
    constructor(audioContext, {
        name = "markovpercs",
        style = "rolling",
        seed,
        steps = 16,
        step_beats = 0.25,
        density = 1,
        per_category = 4,
        velocity = 1,
        swing = 0,
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "Generates a fixed drum rhythm from a Markov chain over [rest, kicks, snares, hats, percs] and loops it until reseeded; feeds a percsampler via /patch dest=<track>.notes.";

        this.style = STYLES[style] ? style : "rolling";
        this.steps = Math.max(1, Math.floor(steps));
        this.stepBeats = Math.max(0.03125, Number(step_beats) || 0.25);
        this.density = Math.min(1, Math.max(0, Number(density)));
        this.perCategory = Math.max(1, Math.floor(per_category));
        // An unseeded instance still gets a concrete seed rather than staying
        // "random forever" — otherwise getOptions() would have nothing to
        // save and a reload couldn't reproduce the pattern.
        this.seed = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : randomSeed();

        this._regenerate();

        this.options = {
            style: {
                get: () => this.style,
                set: (value) => { this.style = value; this._regenerate(); },
                choices: Object.keys(STYLES),
            },
            // Accepts "random" as well as a number, so re-rolling a rhythm
            // live doesn't mean inventing a seed by hand. get() always
            // reports the concrete number in use, which is what round-trips.
            seed: {
                get: () => this.seed,
                set: (value) => {
                    if (typeof value === "string" && value.trim().toLowerCase() === "random") {
                        this.seed = randomSeed();
                    } else {
                        const parsed = Number(value);
                        if (!Number.isFinite(parsed)) {
                            throw new Error(`invalid seed "${value}" — expected a number or "random"`);
                        }
                        this.seed = Math.floor(parsed);
                    }
                    this._regenerate();
                },
            },
            steps: {
                get: () => this.steps,
                set: (value) => {
                    const parsed = Math.floor(Number(value));
                    if (!Number.isFinite(parsed) || parsed < 1) {
                        throw new Error(`invalid steps "${value}" — expected a whole number >= 1`);
                    }
                    this.steps = parsed;
                    this._regenerate();
                },
            },
            // Grid resolution in beats: 0.25 is sixteenths, 0.5 eighths. With
            // `steps` this also sets how long the pattern is before it
            // repeats (steps * step_beats beats) — deliberately independent
            // of the clock's own loop length, so a 3-beat rhythm over a
            // 4-beat loop phases rather than locking.
            step_beats: {
                get: () => this.stepBeats,
                set: (value) => {
                    const parsed = Number(value);
                    if (!Number.isFinite(parsed) || parsed < 0.03125) {
                        throw new Error(`invalid step_beats "${value}" — expected a number >= 0.03125`);
                    }
                    this.stepBeats = parsed;
                    this._regenerate();
                },
            },
            // Thins the pattern without changing its character: every hit the
            // chain produces survives with this probability. 1 leaves the
            // chain's own rest rate alone; 0 silences it entirely.
            density: {
                get: () => this.density,
                set: (value) => {
                    const parsed = Number(value);
                    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
                        throw new Error(`invalid density "${value}" — expected a number between 0 and 1`);
                    }
                    this.density = parsed;
                    this._regenerate();
                },
            },
            // Only consulted when the destination doesn't publish its own
            // (see _stride) — a fallback for driving a plain sampler whose
            // slot layout this can't ask about.
            per_category: {
                get: () => this.perCategory,
                set: (value) => {
                    const parsed = Math.floor(Number(value));
                    if (!Number.isFinite(parsed) || parsed < 1) {
                        throw new Error(`invalid per_category "${value}" — expected a whole number >= 1`);
                    }
                    this.perCategory = parsed;
                },
            },
        };

        // velocity/swing are the two things that genuinely apply *live*: both
        // are read fresh on every generateEvents call, so ramping them
        // (/drums1 velocity=0.2 4b) audibly does something to the pattern
        // already playing. Everything shaping the pattern itself is an option
        // above instead, because ramping a value only consulted at
        // regeneration time would look like a control that does nothing.
        //
        // Both ride real AudioParams backed by silent ConstantSourceNodes —
        // see RibbitParamSources in param.js for the Web Audio quirk that
        // makes the muted sink necessary.
        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            velocity: this._paramSources.create(velocity, { min: 0, max: 1 }),
            swing: this._paramSources.create(swing, { min: 0, max: 0.5 }),
        };

    };

    // Walks the chain once to build the fixed pattern: one entry per step,
    // either null (a rest) or { category, variant }. The variant is chosen
    // here, not at delivery, which is what makes a given hit land on the same
    // sample every pass instead of wandering around its category.
    _regenerate() {
        const table = STYLES[this.style];
        const random = mulberry32(this.seed);
        const pattern = [];
        let state = 0;

        for (let i = 0; i < this.steps; i++) {
            state = pickState(table[state], random);
            if (state === 0 || random() >= this.density) {
                // A thinned-out hit still counts as having happened for the
                // chain's own state — otherwise density would quietly warp
                // the transition statistics as well as the note count.
                pattern.push(null);
                continue;
            }
            pattern.push({ category: state - 1, variant: Math.floor(random() * this.perCategory) });
        }

        this.pattern = pattern;
    };

    // Called by RibbitClock once per tick with an absolute (non-loop-relative)
    // beat range — see clock.js. The pattern is indexed straight off the
    // absolute step number, so it needs no cursor of its own (unlike
    // randomnotes) and realigns by itself after a /stop /start.
    generateEvents(fromBeat, toBeat) {
        if (this.pattern.length === 0) return [];

        const stride = this._stride();
        const velocity = this.params.velocity.getModulated();
        const swing = this.params.swing.getModulated();
        const events = [];

        // 1e-9 absorbs the float error in beat arithmetic, so a step landing
        // exactly on fromBeat isn't dropped by a rounding hair.
        for (let step = Math.ceil(fromBeat / this.stepBeats - 1e-9); step * this.stepBeats < toBeat; step++) {
            const cell = this.pattern[((step % this.steps) + this.steps) % this.steps];
            if (!cell) continue;

            // Swing pushes every odd step late by a fraction of a step —
            // the usual shuffle feel. Even steps stay put, so the pulse
            // itself doesn't drift.
            const beat = step * this.stepBeats + (step % 2 === 1 ? swing * this.stepBeats : 0);
            // Hits that land on a whole beat read as accents; everything
            // between is played back a little softer. Cheap, but it's the
            // difference between a pattern that grooves and one that sounds
            // like a machine gun.
            const onBeat = Math.abs(Math.round(beat) - beat) < 1e-9;

            events.push(new RibbitEvent({
                beat,
                pitch: cell.category * stride + (cell.variant % stride),
                velocity: velocity * (onBeat ? 1 : 0.75),
            }));
        }

        return events;
    };

    // The generated pattern as one character per step — "k"/"s"/"h"/"p" for
    // the four categories, "." for a rest, uppercased where a step lands on a
    // whole beat. Picked up by commands.js's paramObjectSummary via the
    // optional describeState() hook, so `/rhy1` shows the actual rhythm: the
    // params and options only describe how it was *derived*, which tells you
    // nothing about what you're about to hear.
    describeState() {
        return this.pattern
            .map((cell, step) => {
                if (!cell) return ".";
                const letter = PERC_CATEGORIES[cell.category][0];
                return (step * this.stepBeats) % 1 === 0 ? letter.toUpperCase() : letter;
            })
            .join("");
    };

    dispose() {
        this._paramSources.dispose();
    };
};
