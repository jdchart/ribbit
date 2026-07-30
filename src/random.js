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
