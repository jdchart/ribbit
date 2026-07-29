# Ribbit — type catalog

Every synth, processor and modulator the engine registers, with its control
surface. This is the **index**: read it to find out what exists and which
existing type is the closest model for something new, then open that one file
rather than reading the whole `src/` tree.

Conventions used below:

- **params** are `RibbitParam`s: rampable (`wet=0.5 4b`), automatable
  (`automate=wet`), and valid `/patch` destinations (`dest=reverb.wet`).
- **options** are discrete settings with no `AudioParam` behind them. They
  **cannot be ramped**, but — like every other command — they **can be
  scheduled** with `at=beat` / `at=cycle` (`/rhy seed=20 at=cycle`).
- A range in brackets is the param's clamp. Options list their `choices` where
  they have a fixed set.

Registered in `src/ribbit.js` (`SYNTH_TYPES` / `PROCESSOR_TYPES` /
`MODULATOR_TYPES`); the source files live in `src/synths/`,
`src/processors/`, `src/modulators/`.

---

## Synths (3)

A synth makes sound and is owned by a track (`/add_track synth=<type>`). Its
params and options are addressed through the track's name — the synth is not
separately addressable.

### `oscsynth` — `src/synths/oscsynth.js`
A basic subtractive voice: one oscillator per note into a gain envelope. The
simplest possible synth, and the right file to copy for a new one.

- **params** — none
- **options** — `waveform` (sine, square, sawtooth, triangle)

### `sampler` — `src/synths/sampler.js`
Plays loaded samples; an event's `pitch` selects a slot (0 = first, wrapping
if out of range).

- **params** — none
- **options** — `samples` (comma-separated filenames)

### `percsampler` — `src/synths/percsampler.js`
A drum kit: 4 categories (`kicks`, `snares`, `hats`, `percs`) × `per_category`
slots, filled at random from the host's sample library. An event's `pitch`
picks a slot and wraps. Humanizes every hit. **The only synth with params**,
and so the model for any synth wanting rampable controls.

- **params** — `dynamics` [0..0.9], `pan_spread` [0..1], `speed_spread` [0..1]
- **options** — `samples` (or `random` to re-roll), `per_category`,
  `categories` (load only some, keeping the full slot layout — this is what
  lets one generator drive four separately-mixed drum tracks)
- **also** — publishes `slotsPerCategory` and `PERC_CATEGORIES`, the contract
  every drum generator resolves slots against; requires a host-served
  `/samples/manifest.json`

---

## Processors (2)

An effect in a channel's insert chain (`/<channel> add_processor=<type>`).
Addressed by its own name. No per-event trigger.

### `reverb` — `src/processors/reverb.js`
Convolution against a generated impulse response, added on top of the dry
signal.

- **params** — `wet` [0..2]
- **options** — `duration` (IR length, seconds), `decay`

### `delay` — `src/processors/delay.js`
Stereo delay: independent L/R lines with cross-feedback (ping-pong) and a
small inter-channel offset for width.

- **params** — `time` [0..5], `feedback` [0..0.95], `wet` [0..2]
- **options** — `stereoOffset`
- **note** — `time`/`feedback` fan out across two nodes, so ramps and `at=`
  animate only the primary one (see the limitations in `overview.md`)

---

## Modulators (5)

A control source, never in a channel's chain — it exists to be patched
somewhere. Two distinct shapes:

- **continuous** (`lfo`, `cv`): a bipolar signal on `.output`, patched into an
  `AudioParam` via `/patch source=<mod> dest=<name.param> depth=`.
- **event-generating** (`randomnotes`, `markovpercs`, `euclidpercs`):
  implements `generateEvents(fromBeat, toBeat)` and is patched into a track's
  reserved `.notes` destination (`/patch source=<mod> dest=<track>.notes`, no
  `depth`). Generated notes run *alongside* a synth's authored `events`, never
  replacing them. Several generators may feed the same track.

### `lfo` — `src/modulators/lfo.js`
A low-frequency oscillator: continuous bipolar (-1..1) control at a given rate.

- **params** — `freq` [0..20000]
- **options** — `waveform` (sine, square, sawtooth, triangle)

### `cv` — `src/modulators/cv.js`
A held value with no waveform or rate — set, ramp, or automate it. The modular
equivalent of a manual offset. The **minimal implementation of the base
class**, and the smallest example to copy.

- **params** — `value` (unbounded)
- **options** — none

### `randomnotes` — `src/modulators/randomnotes.js`
Rolls the dice at each candidate slot on a fixed-spacing grid, so it **never
repeats**. Picks scale degrees, resolved against the shared harmony context at
trigger time.

- **params** — `probability` [0..1], `min_gap` [0.0625..16]
- **options** — `scale` (comma-separated degrees)

### `markovpercs` — `src/modulators/markovpercs.js`
A first-order Markov chain over `[rest, kicks, snares, hats, percs]`, walked
**once** from a seeded PRNG into a fixed pattern that loops until reseeded.
Good at *texture*; structurally cannot place a hit at a known bar position,
because its only input is the previous step. Drives a `percsampler`.

- **params** — `velocity` [0..1], `swing` [0..0.5]
- **options** — `style` (sparse, rolling, broken, kickheavy, chaotic), `seed`
  (or `random`), `steps`, `step_beats`, `density`, `per_category`
- **also** — `describeState()` prints the pattern (`.sk.HhshSp.s...k`)

### `euclidpercs` — `src/modulators/euclidpercs.js`
One euclidean rhythm (Bjorklund) **per category**, each with its own pulse
count and rotation, over a shared step grid. Every hit is decided by its own
step index, so the pattern is exactly repeatable — this is the generator that
*can* hold a downbeat. The four categories are independent layers, so a step
can be a kick **and** a hat. Drives a `percsampler`.

- **params** — `velocity` [0..1], `swing` [0..0.5], `dropout` [0..0.9] (live,
  re-rolled per pass; only ever removes a hit, never moves one)
- **options** — `preset` (fourfloor, backbeat, tresillo, bossa, polyrhythm,
  sparse), `steps`, `step_beats`, `variation` (seeded spread across a
  category's sample slots), `seed` (or `random`), `per_category`, and per
  category: `kicks`/`snares`/`hats`/`percs` (pulse counts) plus
  `kicks_rotate`/`snares_rotate`/`hats_rotate`/`percs_rotate`
- **also** — `describeState()` prints the grid, one row per category

---

## Which one to copy

| If the new type… | start from |
| --- | --- |
| is a simple synth voice | `oscsynth` |
| loads audio files | `sampler`, then `percsampler` |
| is a synth needing rampable params | `percsampler` (the only one) |
| is a straightforward effect | `reverb` |
| has a param spanning several nodes | `delay` (`onSet`) |
| is a continuous control source | `cv` (minimal), then `lfo` |
| generates notes continuously | `randomnotes` |
| generates a fixed, looping pattern | `markovpercs` |
| generates from grid position | `euclidpercs` |
| needs a param with no natural `AudioParam` | any of the last three — all use `RibbitParamSources` (`src/param.js`) |

Step-by-step guides: `building-synths.md`, `building-processors.md`,
`building-modulators.md`. Removing one: `removing-types.md`.

> **Keep this file current.** A new or removed synth/processor/modulator must
> be added or deleted here in the same change that touches
> `src/ribbit.js`'s registries — this catalog is what later readers (and
> LLMs) consult *instead of* reading every source file, so a stale entry is
> worse than no entry.
