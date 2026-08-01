// The pattern file format, and the loader for a host-served pattern library.
//
// A *pattern* is a hand-written musical fragment — a drum rhythm, a chord
// progression, a melody — living as JSON in the host's static folder. It is
// deliberately not a saved session: a session is a whole graph captured by the
// engine, while a pattern is source material a human types into a text editor
// and a generator reads. That difference is what drives every choice here:
// the format optimizes for being *written by hand*, not for round-tripping.
//
// Two kinds share one grid. `kind: "drums"` writes one character lane per
// percussion category; `kind: "notes"` writes one token per step, a token
// being comma-separated scale degrees. A melody is just a notes pattern with
// one degree per step, which is why there is no third kind for it.
//
// Everything below is tolerant on input and strict on error: a lane may use
// any of several rest characters, spaces are ignored entirely, lanes may be
// different lengths — but an unparseable token throws with the offending text
// quoted, because a silently-dropped note in a hand-edited file is the one
// failure mode that wastes an afternoon.

import { libraryUrl, fetchJSON, createLibraryCache } from "./library.js";
import { PERC_CATEGORIES } from "./synths/percsampler.js";

// Where the host publishes "what pattern packs exist". Exactly the contract
// RibbitPercSampler already defines for /samples/manifest.json, and for the
// same reason: a browser can't list a directory over HTTP, so choosing a
// pattern by name is only possible if the host says what there is to choose
// from. Shape: { <pack>: ["<pack>/<name>.json", ...], ... }, each entry a path
// relative to the same "/patterns/" prefix the files are served under.
// Reference implementation: nllc/src/routes/patterns/manifest.json/+server.js.
const MANIFEST_URL = "/patterns/manifest.json";

// Rest characters. Several, because different people reach for different ones
// and there is no reason to make anybody look this up.
const RESTS = new Set([".", "-", "_", "~"]);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// One drum lane: a character string where each character is one step.
//
//   x    a hit
//   X    an accented hit (louder)
//   g    a ghost note (much quieter)
//   0-9  a hit on that variant slot within the category
//   . - _ ~   a rest
//   space     ignored entirely
//
// Spaces being ignored is the single most useful thing in this format: it
// lets "x..x ..x. ..x. .x.." be written with visible bar groupings and read
// back at a glance, which is most of what "easily editable" means for a grid.
function parseDrumLane(text, laneName) {
    const cells = [];
    for (const char of String(text)) {
        if (char === " ") continue;
        if (RESTS.has(char)) { cells.push(null); continue; }
        if (char === "x") { cells.push({ variant: null, gain: 1 }); continue; }
        if (char === "X") { cells.push({ variant: null, gain: 1.3 }); continue; }
        if (char === "g") { cells.push({ variant: null, gain: 0.45 }); continue; }
        if (char >= "0" && char <= "9") { cells.push({ variant: Number(char), gain: 1 }); continue; }
        throw new Error(`unknown character "${char}" in ${laneName} lane — expected x, X, g, 0-9, or a rest (${[...RESTS].join(" ")})`);
    }
    return cells;
};

// One notes step: "." for a rest, or comma-separated scale degrees struck
// together ("0,3,7" is a triad; "0" alone is a melody note). Degrees are
// integers and may be negative — they resolve against the shared harmony
// context at trigger time, so a pattern is key-agnostic and /harmony retunes
// it live.
function parseNoteToken(token, index) {
    const text = String(token).trim();
    if (text === "" || (text.length === 1 && RESTS.has(text))) return null;

    const degrees = text.split(",").map((part) => {
        const value = Number(part.trim());
        if (!Number.isFinite(value)) {
            throw new Error(`unknown degree "${part.trim()}" at step ${index} — expected a whole number (may be negative) or a rest`);
        }
        return Math.round(value);
    });
    return { degrees };
};

// Turns raw pattern JSON into the shape a generator consumes. Kept separate
// from loading so a pattern can also be built inline (tests, a host embedding
// one directly) without a fetch.
export function parsePattern(raw, { source = "pattern" } = {}) {
    if (!raw || typeof raw !== "object") throw new Error(`${source}: not an object`);

    const kind = raw.kind ?? (raw.lanes ? "drums" : "notes");
    if (kind !== "drums" && kind !== "notes") {
        throw new Error(`${source}: unknown kind "${raw.kind}" — expected "drums" or "notes"`);
    }

    const stepBeats = Number(raw.step_beats ?? (kind === "drums" ? 0.25 : 1));
    if (!Number.isFinite(stepBeats) || stepBeats < 0.03125) {
        throw new Error(`${source}: invalid step_beats "${raw.step_beats}" — expected a number >= 0.03125`);
    }

    const pattern = {
        name: raw.name ?? source,
        kind,
        stepBeats,
        // Per-note length in beats. Only meaningful for pitched material — a
        // drum hit plays its whole sample regardless.
        duration: Number(raw.duration ?? stepBeats),
        velocity: Number(raw.velocity ?? (kind === "drums" ? 0.9 : 0.7)),
        lanes: {},
        sequence: [],
    };

    if (kind === "drums") {
        const unknown = Object.keys(raw.lanes ?? {}).filter((lane) => !PERC_CATEGORIES.includes(lane));
        if (unknown.length) {
            throw new Error(`${source}: unknown lane${unknown.length === 1 ? "" : "s"} ${unknown.map((l) => `"${l}"`).join(", ")} — expected ${PERC_CATEGORIES.join(", ")}`);
        }
        for (const category of PERC_CATEGORIES) {
            const lane = raw.lanes?.[category];
            if (lane === undefined) continue;
            const cells = parseDrumLane(lane, category);
            if (cells.length) pattern.lanes[category] = cells;
        }
        if (Object.keys(pattern.lanes).length === 0) throw new Error(`${source}: no lanes — expected at least one of ${PERC_CATEGORIES.join(", ")}`);
    } else {
        const sequence = raw.sequence ?? raw.steps;
        if (!Array.isArray(sequence)) throw new Error(`${source}: "sequence" must be an array of step tokens`);
        pattern.sequence = sequence.map(parseNoteToken);
        if (pattern.sequence.length === 0) throw new Error(`${source}: "sequence" is empty`);
    }

    // Declared length wins; otherwise the longest lane (or the sequence)
    // decides. Inferring by default is what keeps a hand-edited file from
    // silently desyncing from a `steps` count somebody forgot to update — and
    // since each lane cycles at its own length (see cellAt below), a lane
    // shorter than the pattern simply repeats rather than leaving a hole.
    const declared = raw.steps === undefined ? null : Math.floor(Number(raw.steps));
    if (declared !== null && (!Number.isFinite(declared) || declared < 1)) {
        throw new Error(`${source}: invalid steps "${raw.steps}" — expected a whole number >= 1`);
    }
    pattern.steps = declared ?? (kind === "drums"
        ? Math.max(...Object.values(pattern.lanes).map((lane) => lane.length))
        : pattern.sequence.length);

    return pattern;
};

// Reads one lane/sequence position, wrapping at that lane's own length rather
// than the pattern's. This is what makes `hats: "x.x."` span a 16-step pattern
// by repeating, and what gives polymeter (a 16-step kick against a 6-step hat)
// for free — you write only as much as the part actually needs.
export function cellAt(cells, step) {
    if (!cells || cells.length === 0) return null;
    return cells[((step % cells.length) + cells.length) % cells.length];
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

// The same two-level cache samples.js uses for its manifest, from the same
// shared helper — caching the *promise* collapses concurrent requests from
// several generators built together, and the separately *resolved* copy means
// a live re-roll (`pattern=random`) completes synchronously, so the console
// echoes the pattern it just chose rather than the one it replaced.
const manifests = createLibraryCache();

// Pattern files get their own cache with the same shape: the loaded value is
// the *parsed* pattern rather than raw JSON, so a reseed pays the parse once.
const patterns = createLibraryCache();

export function fetchPatternManifest(url = MANIFEST_URL) {
    return manifests.get(url);
};

export function resolvedPatternManifest(url = MANIFEST_URL) {
    return manifests.resolved(url);
};

// Every pack name in a manifest, and every pattern path within one pack.
// Used by the modulator for validation and by the console's completion.
export function packNames(manifest) {
    return Object.keys(manifest ?? {});
};

export function patternPaths(manifest, pack) {
    return (manifest ?? {})[pack] ?? [];
};

// "hiphopdrums/boom-bap.json" -> "boom-bap". The name a user types.
export function patternName(path) {
    return String(path).replace(/^.*\//, "").replace(/\.\w+$/, "");
};

// Loads and parses one pattern file, cached by URL — a pattern file is static
// for the life of the page, and re-reading it on every reseed would be a
// network round trip inside what should be an instant gesture.
export function fetchPattern(path, { base = "/patterns" } = {}) {
    return patterns.get(libraryUrl(path, base), async (url) =>
        parsePattern(await fetchJSON(url), { source: patternName(path) }));
};
