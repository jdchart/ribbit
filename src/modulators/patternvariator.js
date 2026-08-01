import { RibbitModulator } from "../modulator.js";
import { RibbitParamSources } from "../param.js";
import { RibbitEvent } from "../event.js";
import { PERC_CATEGORIES } from "../synths/percsampler.js";
import { mulberry32, randomSeed } from "../random.js";
import {
    cellAt,
    fetchPattern,
    fetchPatternManifest,
    packNames,
    patternName,
    patternPaths,
    resolvedPatternManifest,
} from "../pattern.js";

const MANIFEST_URL = "/patterns/manifest.json";

// How often a rest turns into a ghost note, per category, at variation=1.
// Weighted by how much a stray hit costs: an unplanned kick moves the whole
// track's centre of gravity, while an extra hat is what a human drummer does
// without noticing. This is the difference between "varied" and "wrong".
const GHOST_CHANCE = { kicks: 0.04, snares: 0.10, hats: 0.18, percs: 0.12 };

// Probability weights for each variation operator at variation=1. Kept
// together, and deliberately well under 1: variation is supposed to produce a
// recognisable relative of the source pattern, not a different pattern. Even
// at full strength roughly two thirds of the source survives untouched.
const RHYTHM = { skip: 0.30, displace: 0.18, revariant: 0.60 };
const MELODY = { skip: 0.18, invert: 0.45, octave: 0.20, neighbour: 0.25, passing: 0.12 };

// How far from the harmony root, in semitones, a varied voice may end up.
// Two octaves either side — wide enough for genuinely open voicings, narrow
// enough that a chord still reads as one chord.
const REGISTER_LIMIT = 24;

// The pattern's own pitch-class vocabulary — every degree it actually uses,
// reduced to one octave and sorted. This is the "identify the scale" step, and
// it is what keeps a variation inside the music: substitutions are drawn from
// here rather than from the harmony context's full scale, so a pattern built
// on a four-note minor cell stays inside that cell instead of wandering into
// notes its composer never chose.
function pitchCollection(sequence) {
    const classes = new Set();
    for (const step of sequence) {
        if (!step) continue;
        for (const degree of step.degrees) classes.add(((degree % 12) + 12) % 12);
    }
    return [...classes].sort((a, b) => a - b);
};

// The nearest *other* member of the collection to `degree`, keeping it in the
// same register — a neighbour tone. Ties break upward, which sounds like a
// passing tone rather than a fall.
function neighbourDegree(degree, collection, random) {
    if (collection.length < 2) return degree;
    const octave = Math.floor(degree / 12) * 12;
    const pitchClass = ((degree % 12) + 12) % 12;
    const others = collection.filter((c) => c !== pitchClass);
    if (others.length === 0) return degree;

    // Sort by circular distance, then pick between the two closest so the
    // choice is a neighbour rather than always the same one.
    const ranked = others
        .map((c) => ({ c, d: Math.min(((c - pitchClass) + 12) % 12, ((pitchClass - c) + 12) % 12) }))
        .sort((a, b) => a.d - b.d);
    const pick = ranked[Math.min(ranked.length - 1, Math.floor(random() * Math.min(2, ranked.length)))];
    return octave + pick.c;
};

// An event-generating modulator that plays a *hand-written* pattern and
// varies it — the third generation shape, alongside randomnotes (rolls live,
// never repeats) and markovpercs/euclidpercs (derive a pattern from rules).
//
// The premise is different from all three: the material is authored by a human
// in a JSON file (see pattern.js for the format), and this modulator's job is
// to keep it from being identical on every pass without letting it stop being
// itself. So every operator here is a *transformation of existing material*,
// never an invention:
//
//   - a rhythm can lose a hit, gain a ghost, or nudge a hit to a neighbouring
//     step, but the grid and the backbone stay where the author put them;
//   - a melody or chord is varied against the pattern's own interval and
//     pitch-class vocabulary (see pitchCollection) — inversion, octave
//     displacement, a neighbour tone drawn from the notes the pattern already
//     uses — so the result is recognisably a version of the source.
//
// Everything is seeded, and — like markovpercs, and unlike euclidpercs'
// live dropout — the variation is generated **once and then loops until
// something reseeds it**. `seed=random` is the "give me another take"
// gesture. That was a deliberate choice over regenerating on a cycle
// boundary: a pattern that quietly rewrites itself while you're working on
// something else is very hard to play with.
//
// Drum patterns store a category and a variant within it, never a finished
// slot number; the slot arithmetic happens at delivery against whatever it's
// patched into, so one pattern drives a percsampler with 1 slot per category
// or 8. See RibbitModulator._stride().
export class RibbitPatternVariator extends RibbitModulator {
    constructor(audioContext, {
        name = "patternvariator",
        pack = null,
        pattern = null,
        seed,
        variation = 0.3,
        density = 1,
        step_beats,
        transpose = 0,
        per_category = 4,
        velocity = 1,
        swing = 0,
        manifest_url = MANIFEST_URL,
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "Plays a hand-written pattern from the host's pattern library (drum lanes, or chords/melodies as scale degrees) and generates seeded variations on it; feeds any synth via /patch dest=<track>.notes.";

        this.manifestUrl = manifest_url;
        this.pack = pack === null ? null : String(pack);
        this.patternName = pattern === null ? null : String(pattern);
        this.variation = Math.min(1, Math.max(0, Number(variation)));
        this.density = Math.min(1, Math.max(0, Number(density)));
        this.transpose = Math.floor(Number(transpose) || 0);
        this.perCategory = Math.max(1, Math.floor(per_category));
        this.stepBeatsOverride = step_beats === undefined ? null : Math.max(0.03125, Number(step_beats));
        // Same rule as markovpercs: an unseeded instance still resolves to a
        // concrete seed immediately, or getOptions() would have nothing to
        // save and a reload couldn't reproduce the take.
        this.seed = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : randomSeed();

        // The loaded source (null until the fetch lands) and the varied copy
        // actually played. Kept separate so a reseed re-varies without
        // re-fetching, and so describeState can show what's playing.
        this.source = null;
        this.varied = null;
        this.loadError = null;
        // Bumped by every selection change, so an in-flight fetch that lands
        // after a newer choice drops itself rather than overwriting it — the
        // same guard percsampler uses for an async kit roll.
        this._generation = 0;

        this._load();

        this.options = {
            // Which pack (folder) to draw from. "random" picks one from the
            // manifest. Changing it re-picks the pattern too, since a pattern
            // name is only meaningful inside its pack.
            pack: {
                get: () => this.pack ?? "",
                set: (value) => this._select(String(value), null),
            },
            // Which pattern within the pack, by bare name ("boom-bap", not
            // "hiphopdrums/boom-bap.json"). "random" re-picks. get() always
            // reports the concrete name in use — the same rule percsampler's
            // `samples` follows, and for the same reason: a session that saved
            // the word "random" would load as a different pattern.
            pattern: {
                get: () => this.patternName ?? "",
                set: (value) => this._select(this.pack, String(value)),
            },
            seed: {
                get: () => this.seed,
                set: (value) => {
                    if (typeof value === "string" && value.trim().toLowerCase() === "random") {
                        this.seed = randomSeed();
                    } else {
                        const parsed = Number(value);
                        if (!Number.isFinite(parsed)) throw new Error(`invalid seed "${value}" — expected a number or "random"`);
                        this.seed = Math.floor(parsed);
                    }
                    this._regenerate();
                },
            },
            // How far from the source to stray, 0..1. An option rather than a
            // param on purpose: it's an input to the seeded generation, not
            // something read per note, so ramping it would mean the pattern
            // silently rewriting itself mid-phrase — exactly what "re-roll
            // only when reseeded" is meant to prevent. Setting it regenerates
            // deterministically, so the same seed and amount always give the
            // same take.
            variation: {
                get: () => this.variation,
                set: (value) => { this.variation = unit(value, "variation"); this._regenerate(); },
            },
            // Thins the result without changing its character — every surviving
            // event keeps its place with this probability. Same meaning as
            // markovpercs' density.
            density: {
                get: () => this.density,
                set: (value) => { this.density = unit(value, "density"); this._regenerate(); },
            },
            // Overrides the pattern file's own grid resolution, so one pattern
            // can be played at half or double time without editing the file.
            step_beats: {
                get: () => this._stepBeats(),
                set: (value) => {
                    const parsed = Number(value);
                    if (!Number.isFinite(parsed) || parsed < 0.03125) throw new Error(`invalid step_beats "${value}" — expected a number >= 0.03125`);
                    this.stepBeatsOverride = parsed;
                },
            },
            // Shifts pitched material by whole scale *degrees*, not semitones
            // — degrees resolve against the shared harmony context, so this
            // stays diatonic and a pattern transposed by 2 is still in key.
            // Ignored for drum patterns, where a degree is a slot index.
            transpose: {
                get: () => this.transpose,
                set: (value) => {
                    const parsed = Math.floor(Number(value));
                    if (!Number.isFinite(parsed)) throw new Error(`invalid transpose "${value}" — expected a whole number`);
                    this.transpose = parsed;
                },
            },
            per_category: {
                get: () => this.perCategory,
                set: (value) => {
                    const parsed = Math.floor(Number(value));
                    if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`invalid per_category "${value}" — expected a whole number >= 1`);
                    this.perCategory = parsed;
                    this._regenerate();
                },
            },
        };

        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            // Read fresh per note, so both are live and rampable even though
            // the pattern itself is fixed — the two things you actually want
            // to ride during a take.
            velocity: this._paramSources.create(velocity, { min: 0, max: 1 }),
            swing: this._paramSources.create(swing, { min: 0, max: 0.5 }),
        };
    };

    dispose() {
        this._paramSources.dispose();
    };

    _stepBeats() {
        return this.stepBeatsOverride ?? this.source?.stepBeats ?? 0.25;
    };

    // Changes the selection, rolling back if the new one doesn't validate.
    // Without this, `/var pack=nope` would leave `pack` set to "nope" after
    // throwing, so the *next* command would report the stale bad pack instead
    // of its own problem — a failed set has to leave the object exactly as it
    // found it.
    _select(pack, pattern) {
        const previousPack = this.pack;
        const previousPattern = this.patternName;
        this.pack = pack;
        this.patternName = pattern;
        try {
            this._load();
        } catch (error) {
            this.pack = previousPack;
            this.patternName = previousPattern;
            throw error;
        }
    };

    // Resolves pack/pattern against the host manifest and loads the file.
    // Synchronous when the manifest has already been seen (every reseed after
    // the first), which is what lets the console echo the pattern it just
    // picked rather than the one it replaced — the same trick, and the same
    // reason, as RibbitPercSampler._randomize.
    _load() {
        const cached = resolvedPatternManifest(this.manifestUrl);
        if (cached) {
            this._loadFrom(cached);
            return;
        }
        this._resolved = (async () => {
            let manifest;
            try {
                manifest = await fetchPatternManifest(this.manifestUrl);
            } catch (error) {
                this.loadError = `couldn't read pattern manifest at ${this.manifestUrl} — ${error.message}`;
                console.warn(`${this.name}: ${this.loadError} No pattern loaded.`);
                return;
            }
            // _loadFrom validates the pack/pattern names and throws on an
            // unknown one. On the synchronous path above that becomes an
            // ordinary command error; here there's no command left to throw
            // to, so it's recorded and warned instead of becoming an
            // unhandled rejection.
            try {
                this._loadFrom(manifest);
            } catch (error) {
                this.loadError = error.message;
                console.warn(`${this.name}: ${error.message}`);
            }
        })();
    };

    _loadFrom(manifest) {
        const packs = packNames(manifest);
        if (packs.length === 0) {
            this.loadError = `pattern manifest at ${this.manifestUrl} is empty`;
            console.warn(`${this.name}: ${this.loadError}`);
            return;
        }

        // A missing or "random" pack/pattern is resolved to a concrete one
        // here and stored, so getOptions() never reports a word that would
        // load as something else next time.
        const random = mulberry32(this.seed);
        if (this.pack && this.pack !== "random" && !packs.includes(this.pack)) {
            throw new Error(`unknown pack "${this.pack}" — expected ${packs.join(", ")}`);
        }
        if (this.pack === null || this.pack === "random") {
            this.pack = packs[Math.floor(random() * packs.length)];
        }

        const paths = patternPaths(manifest, this.pack);
        if (paths.length === 0) {
            this.loadError = `pack "${this.pack}" has no patterns`;
            console.warn(`${this.name}: ${this.loadError}`);
            return;
        }

        const names = paths.map(patternName);
        let path;
        if (this.patternName === null || this.patternName === "random") {
            path = paths[Math.floor(random() * paths.length)];
            this.patternName = patternName(path);
        } else {
            const index = names.indexOf(this.patternName);
            if (index === -1) {
                throw new Error(`unknown pattern "${this.patternName}" in pack "${this.pack}" — expected ${names.join(", ")}`);
            }
            path = paths[index];
        }

        const generation = ++this._generation;
        this._loading = fetchPattern(path).then((parsed) => {
            // Something changed the selection while this was in flight; that
            // choice is newer, so drop this one. Same generation guard
            // percsampler uses for a kit roll.
            if (generation !== this._generation) return;
            this.source = parsed;
            this.loadError = null;
            this._regenerate();
        }).catch((error) => {
            this.loadError = `couldn't load pattern "${this.patternName}" — ${error.message}`;
            console.warn(`${this.name}: ${this.loadError}`);
        });
    };

    // Builds the varied copy from the source. Fully determined by seed +
    // variation + density + per_category, so the same options always give the
    // same take and a saved session reproduces it exactly.
    _regenerate() {
        if (!this.source) return;
        const random = mulberry32(this.seed);
        this.varied = this.source.kind === "drums"
            ? { kind: "drums", lanes: this._varyRhythm(random) }
            : { kind: "notes", sequence: this._varyMelody(random) };
    };

    // Each lane is varied *in place, at its own length* rather than expanded to
    // the pattern's length. That preserves the format's promise that a short
    // lane cycles on its own (a 6-step hat against a 16-step kick stays
    // polymetric), at the cost of a short lane varying identically on each
    // repetition — which is the right trade, since the repetition is the
    // point of writing it short.
    _varyRhythm(random) {
        const lanes = {};
        for (const category of PERC_CATEGORIES) {
            const source = this.source.lanes[category];
            if (!source) continue;

            const out = new Array(source.length).fill(null);
            const ghostChance = (GHOST_CHANCE[category] ?? 0.1) * this.variation;

            for (let step = 0; step < source.length; step++) {
                const cell = source[step];

                if (!cell) {
                    // A rest may pick up a ghost note — quiet, and only ever
                    // where the author left space.
                    if (random() < ghostChance && !out[step]) {
                        out[step] = { variant: Math.floor(random() * this.perCategory), gain: 0.4 };
                    }
                    continue;
                }

                if (random() < RHYTHM.skip * this.variation) continue;

                // Which sample slot within the category this hit uses. Changing
                // it is the cheapest possible variation — the rhythm is
                // identical, the kit isn't.
                const variant = random() < RHYTHM.revariant * this.variation
                    ? Math.floor(random() * this.perCategory)
                    : (cell.variant ?? 0);
                const moved = { variant, gain: cell.gain };

                // Nudge to an adjacent step, but only into space the author
                // left empty — displacing onto another hit would delete it,
                // which is a bigger edit than this operator is meant to make.
                if (random() < RHYTHM.displace * this.variation) {
                    const target = step + (random() < 0.5 ? -1 : 1);
                    const wrapped = ((target % source.length) + source.length) % source.length;
                    if (!source[wrapped] && !out[wrapped]) {
                        out[wrapped] = moved;
                        continue;
                    }
                }

                out[step] = moved;
            }

            // Global thinning, applied after variation so density and
            // variation compose rather than fight.
            if (this.density < 1) {
                for (let step = 0; step < out.length; step++) {
                    if (out[step] && random() >= this.density) out[step] = null;
                }
            }

            lanes[category] = out;
        }
        return lanes;
    };

    // Pitched variation works against the pattern's own vocabulary (see
    // pitchCollection) rather than the harmony context's full scale, so a
    // four-note cell stays a four-note cell. Chord shape is varied by
    // *revoicing* — inversion and octave displacement move a note without
    // changing which note it is, which is why they're the strongest-weighted
    // operators here: they alter the sound a lot and the harmony not at all.
    _varyMelody(random) {
        const source = this.source.sequence;
        const collection = pitchCollection(source);
        const out = source.map((step) => (step ? { degrees: [...step.degrees] } : null));

        for (let step = 0; step < out.length; step++) {
            const cell = out[step];

            if (!cell) {
                // A passing tone in a gap, drawn from the collection and
                // placed between the surrounding notes so it connects them
                // rather than interrupting.
                if (random() < MELODY.passing * this.variation) {
                    const before = lastNoteBefore(out, step);
                    const after = nextNoteAfter(source, step);
                    if (before !== null && after !== null) {
                        const middle = Math.round((before + after) / 2);
                        out[step] = { degrees: [neighbourDegree(middle, collection, random)] };
                    }
                }
                continue;
            }

            if (random() < MELODY.skip * this.variation) {
                out[step] = null;
                continue;
            }

            const degrees = cell.degrees;

            // Inversion: move the lowest voice up an octave or the highest
            // down. Only meaningful for an actual chord.
            if (degrees.length > 1 && random() < MELODY.invert * this.variation) {
                if (random() < 0.5) {
                    const lowest = degrees.indexOf(Math.min(...degrees));
                    degrees[lowest] += 12;
                } else {
                    const highest = degrees.indexOf(Math.max(...degrees));
                    degrees[highest] -= 12;
                }
            }

            // Octave displacement of one voice — the melodic equivalent, and
            // the one operator that works on a single note as well as a chord.
            if (random() < MELODY.octave * this.variation) {
                const index = Math.floor(random() * degrees.length);
                degrees[index] += random() < 0.5 ? 12 : -12;
            }

            // Neighbour substitution: swap one degree for another the pattern
            // already uses. This is the only operator that changes the
            // harmony, hence the modest weight.
            if (random() < MELODY.neighbour * this.variation) {
                const index = Math.floor(random() * degrees.length);
                degrees[index] = neighbourDegree(degrees[index], collection, random);
            }

            // Inversion and octave displacement can both land on the same
            // voice, which compounds to nearly three octaves of displacement
            // from a source note — an open voicing stops sounding like a
            // voicing and starts sounding like two unrelated parts. Fold
            // anything past two octaves back, which keeps the pitch class
            // (and so the harmony) while restoring a playable register.
            cell.degrees = degrees.map((degree) => {
                let folded = degree;
                while (folded > REGISTER_LIMIT) folded -= 12;
                while (folded < -REGISTER_LIMIT) folded += 12;
                return folded;
            });
            cell.degrees = [...new Set(cell.degrees)].sort((a, b) => a - b);
        }

        if (this.density < 1) {
            for (let step = 0; step < out.length; step++) {
                if (out[step] && random() >= this.density) out[step] = null;
            }
        }

        return out;
    };

    // Called by RibbitClock once per tick with an absolute (non-loop-relative)
    // beat range. Indexed straight off the absolute step number like every
    // other generator here, so it needs no cursor and realigns by itself after
    // a /stop /start.
    generateEvents(fromBeat, toBeat) {
        if (!this.varied) return [];

        const stepBeats = this._stepBeats();
        const stride = this._stride();
        const velocity = this.params.velocity.getModulated();
        const swing = this.params.swing.getModulated();
        const events = [];

        // 1e-9 absorbs float error in beat arithmetic, so a step landing
        // exactly on fromBeat isn't dropped by a rounding hair.
        for (let step = Math.ceil(fromBeat / stepBeats - 1e-9); step * stepBeats < toBeat; step++) {
            // Swing pushes odd steps late by a fraction of a step; even steps
            // stay put so the pulse itself doesn't drift.
            const beat = step * stepBeats + (step % 2 === 1 ? swing * stepBeats : 0);

            if (this.varied.kind === "drums") {
                for (let category = 0; category < PERC_CATEGORIES.length; category++) {
                    const cell = cellAt(this.varied.lanes[PERC_CATEGORIES[category]], step);
                    if (!cell) continue;
                    events.push(new RibbitEvent({
                        beat,
                        pitch: category * stride + ((cell.variant ?? 0) % stride),
                        velocity: Math.min(1, velocity * this.source.velocity * cell.gain),
                    }));
                }
            } else {
                const cell = cellAt(this.varied.sequence, step);
                if (!cell) continue;
                for (const degree of cell.degrees) {
                    // degree, not pitch: it resolves against the shared
                    // harmony context at trigger time, so /harmony root=
                    // retunes a loaded pattern live.
                    events.push(new RibbitEvent({
                        beat,
                        degree: degree + this.transpose,
                        velocity: Math.min(1, velocity * this.source.velocity),
                        duration: this.source.duration,
                    }));
                }
            }
        }

        return events;
    };

    // Appended to the console's one-line summary. The options say which file
    // was loaded and how hard it was varied, which tells you nothing about
    // what you're about to hear — this shows the actual result, the same
    // reasoning behind markovpercs' and euclidpercs' describeState.
    describeState() {
        if (this.loadError) return `!! ${this.loadError}`;
        if (!this.varied) return "loading...";

        if (this.varied.kind === "drums") {
            return "\n" + PERC_CATEGORIES
                .filter((category) => this.varied.lanes[category])
                .map((category) => {
                    const row = this.varied.lanes[category]
                        .map((cell) => (cell ? (cell.gain >= 1.2 ? "X" : cell.gain < 0.6 ? "g" : "x") : "."))
                        .join("");
                    return `  ${category.padEnd(7)}${row}`;
                })
                .join("\n");
        }

        return this.varied.sequence
            .map((cell) => (cell ? cell.degrees.map((d) => d + this.transpose).join(",") : "."))
            .join(" ");
    };
};

// Bounds check shared by the 0..1 options above.
function unit(value, key) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(`invalid ${key} "${value}" — expected a number between 0 and 1`);
    }
    return parsed;
};

// The nearest note either side of a gap, for placing a passing tone. Looks at
// the *varied* array behind and the *source* ahead, since everything after the
// current step hasn't been varied yet.
function lastNoteBefore(cells, step) {
    for (let i = step - 1; i >= 0; i--) {
        if (cells[i]) return Math.max(...cells[i].degrees);
    }
    return null;
};

function nextNoteAfter(cells, step) {
    for (let i = step + 1; i < cells.length; i++) {
        if (cells[i]) return Math.min(...cells[i].degrees);
    }
    return null;
};
