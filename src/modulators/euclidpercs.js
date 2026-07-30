import { RibbitModulator } from "../modulator.js";
import { RibbitParamSources } from "../param.js";
import { RibbitEvent } from "../event.js";
import { PERC_CATEGORIES } from "../synths/percsampler.js";
import { mulberry32, randomSeed } from "../random.js";

// Bjorklund's algorithm: distribute `pulses` hits as evenly as possible over
// `steps` slots. Repeatedly pairs off the "hit" groups with the "gap" groups
// until at most one ungrouped remainder is left; what falls out is the
// maximally-even distribution — which turns out to be a startling number of
// the world's traditional rhythms (Toussaint's "The Euclidean Algorithm
// Generates Traditional Musical Rhythms").
//
// E(3,8) = x..x..x. (tresillo), E(5,8) = x.xx.xx. (cinquillo),
// E(5,16) = x..x..x..x..x... (bossa), E(4,16) = four-on-the-floor.
//
// The result always starts on a hit; `rotate` (see _layer) is what moves the
// phase, and is why a backbeat snare is E(2,16) rotated by 4 rather than a
// separate concept.
function euclid(pulses, steps) {
    if (steps <= 0) return [];
    if (pulses <= 0) return new Array(steps).fill(false);
    if (pulses >= steps) return new Array(steps).fill(true);

    let groups = Array.from({ length: pulses }, () => [true]);
    let remainder = Array.from({ length: steps - pulses }, () => [false]);

    while (remainder.length > 1) {
        const pairs = Math.min(groups.length, remainder.length);
        const merged = [];
        for (let i = 0; i < pairs; i++) merged.push([...groups[i], ...remainder[i]]);
        // Whichever side had leftovers becomes the next remainder; the loop
        // ends when at most one is left, which is Bjorklund's terminating
        // condition.
        const leftover = groups.length > pairs ? groups.slice(pairs) : remainder.slice(pairs);
        groups = merged;
        remainder = leftover;
    }

    return [...groups, ...remainder].flat();
};

// Starting points, not genres — each sets the grid length plus a pulse count
// and rotation per category, and every one of those stays individually
// overridable afterwards (/euc kicks=3). The point of shipping these is that
// the useful euclidean rhythms are *specific small integers*, and nobody
// should have to rediscover that a backbeat is E(2,16) rotated 4.
//
// Note what's possible here that RibbitMarkovPercs structurally cannot do:
// "fourfloor" really is a kick on every downbeat, every pass, because each
// step is decided by its own index rather than by whatever preceded it.
const PRESETS = {
    // The canonical grid: kick on all four beats, snare on 2 and 4, eighth hats.
    fourfloor: { steps: 16, kicks: 4, snares: 2, hats: 8, percs: 0, kicks_rotate: 0, snares_rotate: 4, hats_rotate: 0, percs_rotate: 0 },
    // Kick on 1 and 3 instead of all four — leaves room underneath.
    backbeat: { steps: 16, kicks: 2, snares: 2, hats: 8, percs: 0, kicks_rotate: 0, snares_rotate: 4, hats_rotate: 0, percs_rotate: 0 },
    // E(3,8) over an 8-step grid: 2 beats long against a 4-beat loop, so it
    // states itself twice per bar rather than phasing.
    tresillo: { steps: 8, kicks: 3, snares: 0, hats: 4, percs: 2, kicks_rotate: 0, snares_rotate: 0, hats_rotate: 0, percs_rotate: 2 },
    // E(5,16) — the bossa-nova rhythm, with a countering percs line.
    bossa: { steps: 16, kicks: 5, snares: 0, hats: 8, percs: 2, kicks_rotate: 0, snares_rotate: 0, hats_rotate: 0, percs_rotate: 6 },
    // A 12-step grid with 4/3/6/5 pulses: four layers whose cycles only
    // realign every 12 steps, which is the whole reason to use a grid
    // generator with independent layers per category.
    polyrhythm: { steps: 12, kicks: 4, snares: 3, hats: 6, percs: 5, kicks_rotate: 0, snares_rotate: 1, hats_rotate: 0, percs_rotate: 2 },
    // Wide open — mostly space, for layering something else on top.
    sparse: { steps: 16, kicks: 2, snares: 1, hats: 3, percs: 2, kicks_rotate: 0, snares_rotate: 4, hats_rotate: 2, percs_rotate: 9 },
};


function wholeNumber(value, key, minimum) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed) || parsed < minimum) {
        throw new Error(`invalid ${key} "${value}" — expected a whole number >= ${minimum}`);
    }
    return parsed;
};

function unitNumber(value, key) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(`invalid ${key} "${value}" — expected a number between 0 and 1`);
    }
    return parsed;
};

// An event-generating modulator (see RibbitRandomNotes for how the .notes
// patch mechanism works) that drives a RibbitPercSampler from *grid position*
// rather than from what happened on the previous step.
//
// This is the deliberate counterpart to RibbitMarkovPercs. That one asks
// "given a kick just played, what's likely next?", which produces convincing
// texture but can never guarantee a hit lands on the downbeat — a first-order
// chain has no idea where in the bar it is. This one asks "is step 8 a kick?"
// and answers from the euclidean distribution alone, so its output is exactly
// as repeatable as a drum machine's. The two are designed to be used
// together: this holds the backbone, that adds ghost notes around it.
//
// The other structural difference is that the four categories are
// *independent layers* here, not one voice at a time. A markov step is a kick
// OR a snare OR a rest; a euclidean step can be a kick AND a hat, which is
// what makes a real kit pattern possible at all.
//
// Randomization is layered on top without ever moving a hit off the grid:
//   - `variation` (option, seeded, fixed) picks which *sample slot* within a
//     category each hit uses, so repeated kicks aren't literally identical.
//   - `dropout` (param, live, rampable) skips hits per pass, so the pattern
//     breathes. This one re-rolls every pass on purpose — it's the only
//     non-reproducible thing here, and it's decoration, never structure.
//
// Like RibbitMarkovPercs, the pattern stores a category and a variant within
// it, never a finished slot number; the slot arithmetic happens at delivery
// against whatever it's patched into. See _stride().
export class RibbitEuclidPercs extends RibbitModulator {
    constructor(audioContext, {
        name = "euclidpercs",
        preset = "fourfloor",
        steps,
        step_beats = 0.25,
        variation = 0,
        seed,
        per_category = 4,
        velocity = 1,
        swing = 0,
        dropout = 0,
        ...layerOptions
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "Generates a repeatable drum grid: one euclidean rhythm per category (kicks/snares/hats/percs), each with its own pulse count and rotation; feeds a percsampler via /patch dest=<track>.notes.";

        this.preset = PRESETS[preset] ? preset : "fourfloor";
        const base = PRESETS[this.preset];

        // An explicitly-passed value always beats the preset's. That's what
        // makes getOptions() round-trip: a session stores both the preset
        // name and the concrete pulse counts, and reloading must reproduce
        // the edited pattern rather than snapping back to the preset.
        this.steps = steps === undefined ? base.steps : Math.max(1, Math.floor(steps));
        this.stepBeats = Math.max(0.03125, Number(step_beats) || 0.25);
        this.pulses = {};
        this.rotate = {};
        for (const category of PERC_CATEGORIES) {
            this.pulses[category] = Math.max(0, Math.floor(layerOptions[category] ?? base[category]));
            this.rotate[category] = Math.floor(layerOptions[`${category}_rotate`] ?? base[`${category}_rotate`] ?? 0);
        }

        this.variation = Math.min(1, Math.max(0, Number(variation) || 0));
        this.perCategory = Math.max(1, Math.floor(per_category));
        // Same reasoning as RibbitMarkovPercs: an unseeded instance still
        // gets a concrete seed, so getOptions() has something to save.
        this.seed = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : randomSeed();

        this._regenerate();

        this.options = {
            // Setting a preset replaces every pulse count and rotation
            // wholesale (and the grid length) — it's a "start again from
            // here" gesture, not a modifier layered over current edits.
            preset: {
                get: () => this.preset,
                set: (value) => {
                    this.preset = value;
                    const next = PRESETS[value];
                    this.steps = next.steps;
                    for (const category of PERC_CATEGORIES) {
                        this.pulses[category] = next[category];
                        this.rotate[category] = next[category + "_rotate"] ?? 0;
                    }
                    this._regenerate();
                },
                choices: Object.keys(PRESETS),
            },
            steps: {
                get: () => this.steps,
                set: (value) => {
                    this.steps = wholeNumber(value, "steps", 1);
                    this._regenerate();
                },
            },
            // Grid resolution in beats: 0.25 is sixteenths, 0.5 eighths.
            // steps * step_beats is the pattern's length, deliberately
            // independent of the clock's loop length so a 12-step grid over a
            // 4-beat loop phases rather than locking (see the polyrhythm
            // preset).
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
            // How often a hit uses a sample slot other than its category's
            // first one. 0 means every kick is the same kick; 1 spreads hits
            // across the whole category. Seeded, so it's part of the fixed
            // pattern rather than something that changes under you.
            variation: {
                get: () => this.variation,
                set: (value) => {
                    this.variation = unitNumber(value, "variation");
                    this._regenerate();
                },
            },
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
            // Only consulted when the destination doesn't publish its own
            // slot layout (see _stride).
            per_category: {
                get: () => this.perCategory,
                set: (value) => {
                    const parsed = wholeNumber(value, "per_category", 1);
                    if (parsed === this.perCategory) return;
                    this.perCategory = parsed;
                    this._regenerate();
                },
            },
        };

        // One pulse-count and one rotation option per category, built from
        // PERC_CATEGORIES rather than written out eight times — so a category
        // added to the sampler shows up here automatically instead of
        // silently going undrivable.
        for (const category of PERC_CATEGORIES) {
            this.options[category] = {
                get: () => this.pulses[category],
                set: (value) => {
                    // Capped at `steps`: more pulses than slots is just "every
                    // slot", and letting it exceed silently would make
                    // kicks=99 look like it did something.
                    this.pulses[category] = Math.min(this.steps, wholeNumber(value, category, 0));
                    this._regenerate();
                },
            };
            this.options[`${category}_rotate`] = {
                get: () => this.rotate[category],
                set: (value) => {
                    this.rotate[category] = wholeNumber(value, `${category}_rotate`, 0);
                    this._regenerate();
                },
            };
        }

        // Live, rampable controls — read fresh on every generateEvents call,
        // so ramping them audibly does something to the pattern already
        // playing. Everything that shapes the grid itself is an option
        // instead, because ramping a value only consulted at regeneration
        // time would look like a control that does nothing.
        //
        // Backed by silent ConstantSourceNodes; see RibbitParamSources in
        // param.js for the Web Audio quirk that makes the muted sink
        // necessary.
        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            velocity: this._paramSources.create(velocity, { min: 0, max: 1 }),
            swing: this._paramSources.create(swing, { min: 0, max: 0.5 }),
            // Probability that any given hit is skipped on any given pass.
            // Capped at 0.9 rather than 1 for the same reason percsampler's
            // dynamics is: "thins the pattern out" is a useful control,
            // "silences it entirely" is what gain= is for.
            dropout: this._paramSources.create(dropout, { min: 0, max: 0.9 }),
        };

    };

    // Builds one euclidean layer per category: the raw distribution, rotated,
    // with a sample variant baked into each hit. Variants are chosen here
    // rather than at delivery so a given hit lands on the same sample every
    // pass — the pattern is meant to be recognisable.
    _regenerate() {
        const random = mulberry32(this.seed);
        this.layers = {};

        for (const category of PERC_CATEGORIES) {
            const hits = euclid(Math.min(this.pulses[category], this.steps), this.steps);
            const rotation = ((this.rotate[category] % this.steps) + this.steps) % this.steps;
            this.layers[category] = hits.map((_, step) => {
                // Subtract, so rotate=4 moves the first hit *to* step 4 —
                // the reading anyone typing snares_rotate=4 expects. (Adding
                // shifts the other way, which is invisible on an evenly
                // spaced layer like E(2,16) but obviously wrong on a
                // single-pulse one.)
                if (!hits[(step - rotation + this.steps) % this.steps]) return null;
                // Two draws either way, so the variant stream doesn't shift
                // when `variation` changes — only which of the two is used.
                const roll = random();
                const pick = random();
                return { variant: roll < this.variation ? Math.floor(pick * this.perCategory) : 0 };
            });
        }
    };

    // Called by RibbitClock once per tick with an absolute (non-loop-relative)
    // beat range. Indexed straight off the absolute step number, so it needs
    // no cursor of its own and realigns by itself after a /stop /start.
    generateEvents(fromBeat, toBeat) {
        if (this.steps === 0) return [];

        const stride = this._stride();
        const velocity = this.params.velocity.get();
        const swing = this.params.swing.get();
        const dropout = this.params.dropout.get();
        const events = [];

        // 1e-9 absorbs float error in beat arithmetic, so a step landing
        // exactly on fromBeat isn't dropped by a rounding hair.
        for (let step = Math.ceil(fromBeat / this.stepBeats - 1e-9); step * this.stepBeats < toBeat; step++) {
            const index = ((step % this.steps) + this.steps) % this.steps;

            // Swing pushes odd steps late by a fraction of a step; even steps
            // stay put so the pulse itself doesn't drift.
            const beat = step * this.stepBeats + (step % 2 === 1 ? swing * this.stepBeats : 0);
            const onBeat = Math.abs(Math.round(beat) - beat) < 1e-9;

            for (let category = 0; category < PERC_CATEGORIES.length; category++) {
                const cell = this.layers[PERC_CATEGORIES[category]][index];
                if (!cell) continue;
                // Live, unseeded, and re-rolled every pass — the one
                // deliberately non-reproducible thing here. It can only ever
                // remove a hit, never move one, so the grid survives it.
                if (dropout > 0 && Math.random() < dropout) continue;

                events.push(new RibbitEvent({
                    beat,
                    pitch: category * stride + (cell.variant % stride),
                    velocity: velocity * (onBeat ? 1 : 0.75),
                }));
            }
        }

        return events;
    };

    // One row per category, since the layers are independent and a single
    // combined line would have to throw away every coincidence. "X" marks a
    // hit on a whole beat, "x" one between beats, "." a gap. Picked up by
    // commands.js's paramObjectSummary via the optional describeState() hook
    // — the options only say how the grid was derived, which tells you
    // nothing about what you're about to hear.
    describeState() {
        const rows = PERC_CATEGORIES.map((category) => {
            const row = this.layers[category]
                .map((cell, step) => {
                    if (!cell) return ".";
                    return (step * this.stepBeats) % 1 === 0 ? "X" : "x";
                })
                .join("");
            return `\n  ${category.padEnd(6)} ${row}`;
        });
        return rows.join("");
    };

    dispose() {
        this._paramSources.dispose();
    };
};
