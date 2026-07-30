# Patterns: the format, the loader, and extending both

This is the developer's view of `src/pattern.js`. If you only want to *write* a
pattern file, [docs/user/patterns.md](../user/patterns.md) is the page you
want — this one is about the code underneath it, and about changing the format.

---

## Why patterns are not sessions

Ribbit already had a JSON serialization format before this one: `session.js`.
It would have been reasonable to ask why patterns don't reuse it, so it's worth
being explicit.

A **session** is a whole audio graph, captured *by the engine*, in order to be
restored *by the engine*. Nothing is expected to read or write it by hand; it's
optimized for round-tripping without loss.

A **pattern** is source material, written *by a person*, in a text editor,
that the engine only ever reads. It is never written back out. That inverts
every design pressure:

| | session.js | pattern.js |
|---|---|---|
| Author | the engine | a human |
| Direction | read **and** written | read only |
| Optimized for | lossless round-trip | being typed and re-typed |
| Redundancy | fine (it's generated) | a liability (it desyncs) |
| Unknown input | shouldn't happen | happens constantly |

Everything below follows from the right-hand column: characters instead of
objects, inference instead of declaration, several spellings of "rest", and
errors that name the exact offending character.

---

## The parsed shape

`parsePattern(raw, { source })` turns file JSON into what a generator consumes.
It's exported separately from loading so a pattern can be built inline — in a
test, or by a host embedding one directly — without a fetch.

```js
{
  name: "boom bap",
  kind: "drums",              // or "notes"
  stepBeats: 0.25,
  steps: 16,                  // resolved, never null
  duration: 0.25,             // notes: per-note length in beats
  velocity: 0.9,
  lanes: {                    // drums only
    kicks: [ {variant: null, gain: 1}, null, null, ... ],
  },
  sequence: [                 // notes only
    { degrees: [0, 3, 7] }, null, ...
  ],
}
```

Two things worth noting about the cell shapes:

- A drum cell carries **`variant` and `gain`, not a slot number**. Resolving
  `category * stride + variant` happens at delivery time against whatever the
  generator is patched into (`RibbitModulator._stride()`), which is what lets
  one pattern drive a 1-slot and an 8-slot kit identically. A pattern that
  baked in slot numbers would silently mean something different on each kit.
- `variant: null` means *unspecified* — the author wrote `x`, not `3`. That's
  distinct from `variant: 0`, and the distinction is what lets
  `patternvariator` re-pick a slot for an unspecified hit without overriding a
  deliberate choice.

---

## Reading a lane: `cellAt`

```js
export function cellAt(cells, step) {
    if (!cells || cells.length === 0) return null;
    return cells[((step % cells.length) + cells.length) % cells.length];
};
```

Three lines, and the whole of the "each lane cycles at its own length"
behaviour. The double modulo handles negative step indices, which matter
because `generateEvents` works in absolute beats and nothing guarantees those
start at zero.

Note it wraps at **`cells.length`, not `pattern.steps`**. That's the deliberate
choice: it gives a short lane free repetition and a mismatched lane free
polymeter, and it means a generator never has to expand lanes to a common
length before playing them.

---

## Inference over declaration

`steps` is optional and defaults to the longest lane (or the sequence length).
This is the single most important decision in the format for hand-editability.

A declared `steps` is a second copy of information already present in the
lanes, and any duplicated fact will eventually disagree with itself. Someone
adds four steps to a kick lane, doesn't update `steps`, and the pattern
silently truncates. Making the count derived removes the failure mode rather
than documenting it.

Same reasoning applies to `kind`, which is inferred from whether `lanes` or
`sequence` is present, and to `duration`, which defaults to `stepBeats`.

---

## Tolerant input, strict errors

The two halves are not in tension — they're the same principle applied to
different things.

**Tolerant** about anything that is purely notational: four rest characters
(`.` `-` `_` `~`), spaces ignored anywhere, lanes of any length, omitted lanes,
omitted fields. None of these carry meaning, so rejecting them would be
rejecting a preference.

**Strict** about anything that might be a mistake:

```js
throw new Error(`unknown character "${char}" in ${laneName} lane — expected x, X, g, 0-9, or a rest (${[...RESTS].join(" ")})`);
```

Every error quotes the offending text and lists what was expected. The rule
this encodes: **a hand-edited file that half-loads is worse than one that
doesn't load at all.** A silently dropped note is invisible until you're
wondering why the third bar sounds wrong; a thrown error is visible in the
console immediately, with the character in it.

There is no partial or lenient parse mode, and adding one would be a mistake
for the same reason.

---

## Loading and the host contract

The engine can't list a directory over HTTP, so the host publishes what exists:

```
GET /patterns/manifest.json
{ "hiphopdrums": ["hiphopdrums/boom-bap.json", ...], "darkchords": [...] }
```

Each entry is a path relative to the `/patterns/` prefix the files are served
under. Reference implementation:
`nllc/src/routes/patterns/manifest.json/+server.js`.

This is deliberately the **same contract shape** as
`percsampler`'s `/samples/manifest.json` — same problem, same solution, one
rule for a host author to learn instead of two. The one difference: sample
categories are fixed (they map onto `percsampler`'s four hardcoded slot
groups, and a fifth would be meaningless), whereas **pack names are not** —
a pack is just a folder, so any subdirectory becomes one.

### Caching

Three caches, mirroring `percsampler`:

```js
const manifestCache = new Map();      // in-flight + settled promises
const resolvedManifests = new Map();  // the same data, synchronously readable
const patternCache = new Map();       // parsed patterns, by URL
```

Caching the **promise** collapses concurrent requests — several variators
constructed together from one session file share a single fetch. Keeping a
separately **resolved** copy is what makes a live re-pick (`pattern=random`)
complete *synchronously*, so the console echoes the pattern it just chose
rather than the one it replaced. Awaiting an already-settled promise still
costs a microtask, and a microtask is long enough for the command to have
returned.

A failure is not cached — the entry is deleted so a later attempt can retry.

---

## Extending the format

### Adding a drum lane character

One place, `parseDrumLane`:

```js
if (char === "f") { cells.push({ variant: null, gain: 1, flam: true }); continue; }
```

Then teach the consumer about the new cell field. Note the error message lists
accepted characters by interpolating `RESTS` but hardcodes the rest — update
that string too, or the error will lie.

Prefer a new **cell field** over a new top-level field. A character is a
property of one hit; anything that reads `pattern.something` to decide what a
hit means is a fact stored away from the thing it describes.

### Adding a note token form

`parseNoteToken` currently handles rests and comma-separated degrees. A tie
(`"~"` extending the previous note) is the obvious next one, and it's the
reason `~` is in `RESTS` rather than parsed as its own thing today — it reads
as a rest, which is the closest wrong answer, and can be promoted later
without invalidating existing files.

Anything with *duration* semantics needs care: `duration` is currently a
per-pattern constant, so a per-note length would be the first thing to make it
per-cell.

### Adding a third `kind`

Possible, but think first about whether it's really a kind. The format has two
because `drums` and `notes` differ in **what a token means** — a slot index
versus a scale degree, resolved against completely different things. Melodies
aren't a third kind because a melody is a `notes` pattern with one degree per
step; nothing in the parser or the generator would differ.

If you do add one, the touch points are: the `kind` validation in
`parsePattern`, the `steps` inference at the bottom of it, and every
`kind === "drums"` branch in `patternvariator.js` (`_regenerate`,
`generateEvents`, `describeState`).

### Adding a variation operator

That's `patternvariator.js`, not `pattern.js` — the format describes material,
the modulator decides what to do with it. Operators live in two weight tables:

```js
const RHYTHM = { skip: 0.30, displace: 0.18, revariant: 0.60 };
const MELODY = { skip: 0.18, invert: 0.45, octave: 0.20, neighbour: 0.25, passing: 0.12 };
```

Each is a probability at `variation=1`, scaled linearly by the current amount.
Two constraints any new operator should respect:

1. **Transform existing material; never invent.** Pitched operators draw from
   `pitchCollection(sequence)` — the pattern's own pitch classes — rather than
   the harmony context's full scale, which is why a variation stays
   recognisably a version of the source instead of wandering off.
2. **Keep the weights well under 1.** At full strength roughly two thirds of a
   source rhythm still survives. That's the design target, not a limitation: a
   "variation" that leaves nothing of the original is just a different pattern.

Every operator must draw from the seeded `random()` passed in, in a fixed
order — the reproducibility guarantee (same seed + same options ⇒ same take,
across a session save/load) depends on the draw sequence being deterministic.
Adding a conditional draw in the middle of the sequence changes every take that
follows it.

---

## Testing a format change

There's no test framework in this repo (console-output smoke checks only), but
patterns are unusually easy to check offline because parsing and generation are
pure. A stub `AudioContext` — `createGain`, `createConstantSource`,
`destination` — plus a `globalThis.fetch` that reads `static/patterns/` off
disk is enough to exercise the real shipped packs in Node, with no browser.

Worth asserting when you change anything here:

- every shipped pattern still parses (a format change that breaks existing
  files is the main risk);
- `variation=0` reproduces the source **exactly** — the cleanest single check
  that parsing and generation agree;
- the same seed and amount produce identical takes;
- for drums, that `per_category=1` collapses every category onto slots 0–3,
  which is `_stride()` working;
- for notes, that no varied pitch class falls outside
  `pitchCollection(source)`.

Then load a session that uses it via the `run` skill. The offline checks above
never exercise patching, which is exactly where the last real bug here lived.

---

## See also

- [docs/user/patterns.md](../user/patterns.md) — the format from the author's
  side.
- [creating-a-modulator.md](creating-a-modulator.md) — the modulator that
  consumes patterns, and the event-generating contract generally.
- [architecture.md](architecture.md) — where `pattern.js` sits in the engine.
