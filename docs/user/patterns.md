# Writing patterns

A **pattern** is a short piece of music you write by hand, in a JSON file, and
hand to the engine to play: a drum rhythm, a chord progression, a melody.

It's the one part of ribbit that isn't typed into the console. Everything else
here is a live command; a pattern is a *file* you keep, edit in a text editor,
and reuse across sessions. The `patternvariator` modulator loads one and plays
it — and can generate endless variations on it without you rewriting anything.

This page is about writing the files. For the modulator that plays them, see
[objects.md](objects.md#patternvariator--ribbitpatternvariator). For where the files live in the
reference app, see the [nllc docs](../../../nllc/docs/user/README.md).

---

## Where patterns live

```
static/patterns/
├── hiphopdrums/          ← a "pack": just a folder of related patterns
│   ├── boom-bap.json
│   ├── dusty.json
│   └── halftime.json
├── darkchords/
│   ├── minor-drift.json
│   └── nocturne.json
├── ambientchords/        ← long, sparse, wide voicings for pads
│   ├── drone-fifths.json
│   ├── slow-bloom.json
│   └── halo.json
└── melodies/
    └── arp-cell.json
```

A **pack** is nothing more than a folder. Adding
`static/patterns/mypack/mypattern.json` and refreshing the page is the entire
workflow — no code change, no registration, no rebuild. The host lists the
folder for the engine (a browser can't read a directory over HTTP), which is
why a refresh is needed rather than nothing at all.

Then:

```
/add_modulator type=patternvariator name=p pack=mypack pattern=mypattern
/patch source=p dest=<track>.notes
```

---

## Two kinds of pattern

Every pattern is a grid of **steps**. What a step *means* depends on `kind`:

| `kind` | A step is | Drives |
|---|---|---|
| `"drums"` | a hit (or not) on each drum category | `percsampler` |
| `"notes"` | one or more scale degrees, played together | `karplus`, `granular`, `tapepad`, `czsynth`, `oscsynth`, anything pitched (including `chaossynth`, where the degrees select states rather than pitches) |

There is no separate kind for melodies — a melody is a `notes` pattern with one
degree per step. A chord is the same thing with several.

Two fields decide whether a `notes` pattern reads as a keyboard part or as a
pad, and they're independent of the notes themselves: `step_beats` (how far
apart the steps sit) and `duration` (how long each note lasts). A `duration`
**longer** than `step_beats` makes chords overlap and bleed into each other,
which is what the shipped `ambientchords` pack does throughout — `slow-bloom`
puts a chord every 2 beats and lets each ring for 5. That pack is written for
[`granular`](objects.md#granular--ribbitgranular), whose notes take seconds to
bloom and fade, but nothing about it is granular-specific — the same pack
drives three [`tapepad`](objects.md#tapepad--ribbittapepad) layers in the
`ambient-tape` session, for the same reason.

---

## Drum patterns

One **lane** per drum category, each lane a string of characters, one character
per step:

```json
{
  "name": "boom bap",
  "kind": "drums",
  "step_beats": 0.25,
  "velocity": 0.9,
  "lanes": {
    "kicks":  "x... ..x. ..x. ....",
    "snares": ".... x... .... x...",
    "hats":   "x.x. x.x. x.x. x.x."
  }
}
```

### The characters

| Character | Meaning |
|---|---|
| `x` | a hit |
| `X` | an accented hit (louder) |
| `g` | a ghost note (much quieter) |
| `0`–`9` | a hit using that **variant slot** within the category |
| `.` `-` `_` `~` | a rest — use whichever you find most readable |
| *space* | **ignored entirely** |

**Spaces being ignored is the most useful thing in this format.** It lets you
group a bar so you can see it:

```
"x... ..x. ..x. ...."     is exactly the same pattern as
"x.....x...x....."
```

Group in fours, in threes, however the music actually divides. Nothing but your
own eyes depends on it.

### The four lanes

`kicks`, `snares`, `hats`, `percs` — the same four categories `percsampler`
builds a kit from, and in that order. `percs` is the catch-all for everything
that isn't the other three: claves, cymbals, shakers, blocks, rimshots. You can
omit any lane you don't need.

### Variant slots (the digits)

A `percsampler` kit holds several samples *per category* — `per_category=3`
means three different kicks, three snares, and so on. Plain `x` always uses the
first one; a digit picks a specific one:

```json
"hats": "0.1. 0.2. 0.1. 0.3."
```

That's a hat on every other step, cycling through three different hat samples —
the cheapest way to stop a repeated hi-hat sounding like one sample pasted
sixteen times.

You rarely need to write these by hand: `patternvariator`'s `variation` option
re-picks slots for you. Use digits when you want a *specific* alternation.

### Lanes cycle at their own length

A lane shorter than the pattern simply repeats:

```json
"lanes": {
  "kicks":  "x... ..x. ..x. ....",
  "hats":   "x.x."
}
```

The hats lane is 4 steps long, so it plays 4 times across the 16-step bar. You
only write as much as the part actually needs.

This also gives you **polymeter** for free. A 6-step lane against a 16-step one
never lines up the same way twice:

```json
"lanes": {
  "kicks": "x... ..x. ..x. ....",
  "hats":  "x..x.."
}
```

---

## Note patterns (chords and melodies)

One token per step. A token is a comma-separated list of **scale degrees**:

```json
{
  "name": "minor drift",
  "kind": "notes",
  "step_beats": 1,
  "duration": 2,
  "velocity": 0.55,
  "sequence": [
    "0,3,7", ".", "-4,0,3", ".",
    "3,7,10", ".", "-2,2,5", "."
  ]
}
```

| Token | Meaning |
|---|---|
| `"0,3,7"` | three degrees struck together — a chord |
| `"0"` | a single note |
| `"-4"` | degrees can be negative (below the root) |
| `"."` | a rest |

### Degrees, not notes

A degree is an offset from the shared harmony context's root, resolved **when
the note plays**, not when you write it. With the default chromatic scale a
degree is a semitone, so `"0,3,7"` is a minor triad and `"0,4,7"` a major one.

The payoff is that a pattern is key-agnostic. Write it once, then:

```
/harmony root=57
```

and everything transposes live, mid-loop, including notes already scheduled.
Nothing in the file changes.

### Chord shapes in degrees

| Chord | Degrees |
|---|---|
| minor triad | `0,3,7` |
| major triad | `0,4,7` |
| minor 7th | `0,3,7,10` |
| major 7th | `0,4,7,11` |
| dominant 7th | `0,4,7,10` |
| half-diminished | `0,3,6,10` |
| suspended 4th | `0,5,7` |

To voice a chord lower, subtract: `"-12,0,3,7"` puts the root an octave down as
a pedal tone under the triad.

---

## Fields

| Field | Applies to | Default | Meaning |
|---|---|---|---|
| `kind` | both | inferred | `"drums"` or `"notes"`. Inferred from whether you wrote `lanes` or `sequence`. |
| `name` | both | filename | A label for the pattern. |
| `step_beats` | both | `0.25` drums, `1` notes | How long one step is, in beats. `0.25` is sixteenths, `0.5` eighths, `1` quarters. |
| `steps` | both | inferred | Pattern length in steps. **Leave it out** unless you specifically want a length other than the longest lane. |
| `velocity` | both | `0.9` drums, `0.7` notes | Base loudness for the whole pattern. |
| `duration` | notes | `step_beats` | How long each note is held, in beats. |
| `lanes` | drums | — | One string per category. |
| `sequence` | notes | — | One token per step. |

### On `steps`

It's inferred from your longest lane, and you should almost always let it be.
A declared `steps` that drifts out of step with the lanes underneath it is the
classic way to spend twenty minutes debugging a file — so the format is built
not to need one.

### On `step_beats` and pattern length

A pattern's length in beats is `steps × step_beats`, and it is **independent of
the clock's loop length**. A 16-step pattern at `step_beats=0.25` is 4 beats,
which fits a 4-beat loop exactly. Make it `step_beats=0.3` and it's 4.8 beats —
it will phase against the loop instead of locking to it. Both are useful; just
know which one you're doing.

---

## Errors

The parser is deliberately **generous about what it accepts and strict about
what it rejects**. Several rest characters work, spaces are free, lanes can be
any length — but anything it can't read is an error naming the exact offending
character, never a silently dropped note:

```
unknown character "q" in kicks lane — expected x, X, g, 0-9, or a rest (. - _ ~)
unknown lane "cowbell" — expected kicks, snares, hats, percs
unknown degree "banana" at step 1 — expected a whole number (may be negative) or a rest
```

A pattern that half-loads is worse than one that doesn't load, so it doesn't.

---

## A worked example

Say you want a half-time beat with a swung, phasing hat line and a rimshot
answering the snare.

**Start with the skeleton** — kick on 1, snare on beat 3 only (that's what makes
it half-time), straight eighth hats:

```json
{
  "name": "my halftime",
  "kind": "drums",
  "step_beats": 0.25,
  "lanes": {
    "kicks":  "x... .... .... ....",
    "snares": ".... .... x... ....",
    "hats":   "x.x. x.x. x.x. x.x."
  }
}
```

**Give the kick somewhere to go** — a second hit late in the bar pulls against
the snare:

```json
    "kicks":  "x... ..x. .... x...",
```

**Accent the snare, ghost the approach to it:**

```json
    "snares": ".... ...g X... ....",
```

**Make the hats phase** — drop to a 6-step lane so they never land the same way
twice, and vary the sample:

```json
    "hats":   "0.1.2.",
```

**Add the rimshot** on the `percs` lane, answering the snare a beat later:

```json
    "percs":  ".... .... .... x...",
```

Save it as `static/patterns/mybeats/my-halftime.json`, refresh, and:

```
/add_track name=dr synth=percsampler
/add_modulator type=patternvariator name=beat pack=mybeats pattern=my-halftime
/patch source=beat dest=dr.notes
/start
```

Then `/beat` to see what it's actually playing, and `/beat variation=0.5` to
start pulling it around.

---

## Next

- [objects.md](objects.md#patternvariator--ribbitpatternvariator) — the `patternvariator` modulator:
  `variation`, `density`, `seed`, `transpose`, and how variation actually
  works.
- [objects.md](objects.md#karplus--ribbitkarplus) — `karplus`, the polyphonic plucked string,
  which is what to point a chord pattern at.
- [objects.md](objects.md#granular--ribbitgranular) — `granular`, and what the
  `ambientchords` pack was written for.
- [objects.md](objects.md#tapepad--ribbittapepad) — `tapepad`, the third
  polyphonic synth: warped, lofi chords out of the same pack.
- [commands.md](commands.md) — the full command vocabulary.
- [../dev/creating-a-pattern.md](../dev/creating-a-pattern.md) — the format's
  internals, and how to extend it with a new token or a new kind.
