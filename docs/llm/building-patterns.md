# LLM context: writing and extending patterns

Full versions: `docs/user/patterns.md` (authoring), `docs/dev/creating-a-pattern.md`
(internals). This is the condensed recipe.

A **pattern** is hand-written musical material in JSON, living in the host's
static folder, loaded by the `patternvariator` modulator. It is *not* a session:
a session is written by the engine for the engine, a pattern is written by a
person and only ever read. Every design choice below follows from that.

## Format

Two kinds, one grid. `kind` decides what a token means. There is **no third
kind for melodies** — a melody is a `notes` pattern with one degree per step.

```json
{ "name": "boom bap", "kind": "drums", "step_beats": 0.25, "velocity": 0.9,
  "lanes": { "kicks":  "x... ..x. ..x. ....",
             "snares": ".... x... .... x...",
             "hats":   "x.x." } }

{ "name": "minor drift", "kind": "notes", "step_beats": 1, "duration": 2,
  "sequence": ["0,3,7", ".", "-4,0,3", ".", "3,7,10", ".", "-2,2,5", "."] }
```

**drums** — one lane per `PERC_CATEGORIES` entry (`kicks`, `snares`, `hats`,
`percs`; `percs` is the catch-all: claves, cymbals, shakers, rims). Characters:

| | |
|---|---|
| `x` | hit |
| `X` | accent (louder) |
| `g` | ghost (much quieter) |
| `0`-`9` | hit on that variant slot within the category |
| `.` `-` `_` `~` | rest |
| space | **ignored entirely** — grouping aid only |

**notes** — one token per step; a token is comma-separated **scale degrees**
(`"0,3,7"` a triad, `"0"` a note, `"."` a rest, negatives fine). Degrees
resolve against the shared harmony context at *trigger* time, so `/harmony
root=57` retunes a loaded pattern live. Default scale is chromatic, so a degree
is a semitone: minor triad `0,3,7`, major `0,4,7`, min7 `0,3,7,10`, maj7
`0,4,7,11`, dom7 `0,4,7,10`, half-dim `0,3,6,10`, sus4 `0,5,7`.

Fields: `kind` (inferred), `name`, `step_beats` (0.25 = sixteenths), `steps`
(**inferred — leave it out**), `velocity`, `duration` (notes only), `lanes` /
`sequence`.

## Three rules that carry most of the design

1. **Each lane cycles at its own length** (`cellAt` wraps at `cells.length`,
   not `pattern.steps`). `"hats": "x.x."` spans a 16-step pattern by repeating;
   a 6-step lane against a 16-step one gives polymeter for free. Write only
   what the part needs.
2. **Inference over declaration.** `steps` derives from the longest lane,
   `kind` from which key is present, `duration` from `step_beats`. Any
   duplicated fact eventually disagrees with itself — a `steps` count somebody
   forgot to update silently truncates the pattern.
3. **Tolerant input, strict errors.** Four rest spellings, free spaces, any
   lane length — but an unreadable token throws quoting the offending
   character (`unknown character "q" in kicks lane — expected x, X, g, 0-9, or
   a rest (. - _ ~)`). No lenient/partial parse: a hand-edited file that
   half-loads is worse than one that doesn't load.

## Cell shapes (what a generator consumes)

```js
// drums lane cell
{ variant: 3 | null, gain: 1 }   // null = author wrote `x`, not a digit
// notes sequence cell
{ degrees: [0, 3, 7] }
// either: null == rest
```

A drum cell holds **`variant`, never a finished slot number** — `category *
stride + variant` is resolved at delivery via `RibbitModulator._stride()`, which
is what makes one pattern sound identical on a 1-slot and an 8-slot kit.
`variant: null` (unspecified) is deliberately distinct from `variant: 0`, so a
variator can re-pick a slot without overriding a deliberate choice.

## Host contract

```
GET /patterns/manifest.json
{ "<pack>": ["<pack>/<name>.json", ...] }
```

Paths relative to the `/patterns/` prefix. Same shape as `percsampler`'s
`/samples/manifest.json` on purpose — one rule, not two. Difference: pack names
are **not** fixed (a pack is just a folder), so dropping in
`static/patterns/<pack>/<name>.json` and refreshing is the whole workflow.
Reference: `nllc/src/routes/patterns/manifest.json/+server.js`.
Manifests and parsed patterns are cached per URL as **both** promise and
resolved value — the promise collapses concurrent fetches, the resolved copy
makes a live re-pick synchronous so the console echoes the pattern it just
chose rather than the one it replaced.

## Extending

- **New lane character** → `parseDrumLane` in `pattern.js`; prefer a new *cell
  field* over a new top-level field, and update the error string (it hardcodes
  the accepted list).
- **New note token form** → `parseNoteToken`. A tie is the obvious next one;
  `~` currently parses as a rest precisely so it can be promoted later without
  invalidating existing files. Anything with per-note duration needs `duration`
  moved from per-pattern to per-cell first.
- **New `kind`** → probably not: the two exist because a token means a *slot
  index* vs. a *scale degree*, resolved against different things. Touch points
  if you do: `kind` validation and `steps` inference in `parsePattern`, plus
  every `kind === "drums"` branch in `patternvariator.js` (`_regenerate`,
  `generateEvents`, `describeState`).
- **New variation operator** → `patternvariator.js`, not `pattern.js`. Weights
  live in `RHYTHM` / `MELODY` (probability at `variation=1`, scaled linearly).
  Two constraints: **transform existing material, never invent** (pitched
  operators draw from `pitchCollection(sequence)`, the pattern's own pitch
  classes, not the harmony scale), and **keep weights well under 1** (~2/3 of a
  source rhythm survives at full strength — that's the target). Draws must come
  from the seeded `random()` in a fixed order, or reproducibility across a
  save/load breaks.

## Checking a change

Parsing and generation are pure, so a stub `AudioContext` (`createGain`,
`createConstantSource`, `destination`) plus a `globalThis.fetch` reading
`static/patterns/` off disk exercises the real shipped packs in Node. Assert:
every shipped pattern still parses; `variation=0` reproduces the source
*exactly*; same seed+amount ⇒ identical take; `per_category=1` collapses drums
onto slots 0-3; no varied pitch class falls outside `pitchCollection(source)`.
**Then load a session via the `run` skill** — offline checks never exercise
patching, which is where the last real bug here lived
(`eventDestinations` missing broke every `.notes` patch at load time).
