// Seeded randomness, shared by every generator that has to reproduce itself.
//
// Math.random() can't be seeded, and seedability is the whole reason a
// generated pattern survives a session round trip: `seed` plus the generator's
// shape options fully determine the output, so a saved session rebuilds the
// same bar rather than a new random one. Anything that should *not* survive a
// reload (euclidpercs' live `dropout` re-roll) deliberately uses Math.random()
// instead — the choice of generator is the choice of whether the result is
// part of the document.
//
// mulberry32: 32-bit state, fast, good enough distribution for musical
// decisions, and short enough to read. Extracted here when it reached a third
// caller (markovpercs, euclidpercs, patternvariator) — the same threshold that
// moved _stride() onto RibbitModulator.
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

// A fresh, unreproducible seed — what `seed=random` resolves to before being
// stored as a concrete number. Kept here so "what a seed looks like" is
// declared once.
export function randomSeed() {
    return Math.floor(Math.random() * 2 ** 31);
};

// One uniform draw in [min, max] — what a param's `=random` resolves to (see
// RibbitParam.randomValue). Math.random() rather than mulberry32 for the same
// reason randomSeed() uses it: the draw is resolved to a concrete number the
// moment the command runs and *that number* is what gets stored, so the
// result is already part of the document and has nothing left to reproduce.
//
// Uniform in the param's own user-facing domain, not the raw AudioParam one —
// a channel's gain is a 0-1 taper position and a random fader should be
// uniform in the units the range is declared in. Deliberately not
// logarithmic, even for a wide range like a filter's 40..16000: a rule that
// silently changes shape per param is much harder to predict than one that
// doesn't, and min=/max= is the answer when the full sweep is too wide.
export function randomInRange(min, max) {
    return min + Math.random() * (max - min);
};
