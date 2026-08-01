# Ribbit — type catalog

Every synth, processor and modulator the engine registers, with its control
surface. This is the **index**: read it to find out what exists and which
existing type is the closest model for something new, then open that one file
rather than reading the whole `src/` tree.

Conventions used below:

- **params** are `RibbitParam`s: rampable (`wet=0.5 4b`), automatable
  (`automate=wet`), and valid `/patch` destinations (`dest=reverb.wet`). A
  **synth's** params, and `velocity`/`swing`/`probability`/`dropout` on an
  event generator, are read once per note rather than continuously — so all
  of the above reach them, but note by note rather than as a smooth sweep.
- **options** are discrete settings with no `AudioParam` behind them. They
  **cannot be ramped**, but — like every other command — they **can be
  scheduled** with `at=beat` / `at=cycle` (`/rhy seed=20 at=cycle`).
- A range in brackets is the param's clamp. Options list their `choices` where
  they have a fixed set.

Registered in `src/ribbit.js` (`SYNTH_TYPES` / `PROCESSOR_TYPES` /
`MODULATOR_TYPES`); the source files live in `src/synths/`,
`src/processors/`, `src/modulators/`.

---

## Synths (6)

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

### `karplus` — `src/synths/karplus.js`
A polyphonic Karplus-Strong plucked string: a noise burst circulated through a
feedback delay line one wavelength long. Each note renders its own
`AudioBuffer` in JS rather than building a node graph — a Web Audio feedback
loop containing a `DelayNode` is forced to at least one render quantum of
delay, which would cap the fundamental at about 375Hz. Notes ring for their
natural decay; a written `duration` shorter than that reads as the player
damping the string.

- **params** — `damping` [0..1], `decay` [0.05..8] (seconds to -60dB, pitch-compensated), `brightness` [0..1]
- **options** — `excitation` (noise, pulse)
- **note** — the only synth that plays chords, so it's the model for anything
  polyphonic; pitch quantizes above C6 (see the source comment)

### `granular` — `src/synths/granular.js`
One source recording — picked at random from a folder of the host's sample
library, `foley` by default — played back as a cloud of short overlapping
grains rather than as a sample. Built for sustained pad textures out of
unpitched material: a note is `voice envelope x sum of grains`, so
`attack`/`release` shape the note while `density`/`grain_size`/`spray` shape
the cloud. Polyphonic (a chord is several overlapping clouds); a degree
resolves against the harmony context and sets each grain's playback rate
relative to `root`, so transposition is a tape-speed gesture.

- **params** — `density` [1..200] grains/sec, `grain_size` [0.005..2] s,
  `spray` [0..10] s of read-position scatter, `position` [0..1] playhead,
  `drift` [-2..2] playhead speed while held, `pitch_spread` [0..24] semitones,
  `pan_spread` [0..1], `attack` [0..10] s, `release` [0..10] s
- **options** — `sample` (resolved path, or `random` to re-roll), `folder`,
  `window` (hann, tri, expo), `direction` (forward, reverse, mixed),
  `root` (MIDI note played at natural speed)
- **also** — `describeState()` prints the source, its length and any gain
  match; requires the host-served `/samples/manifest.json` (same contract
  `percsampler` uses, read through the shared `src/samples.js`)
- **note** — sources are **gain-matched on load** (peak-normalized, capped at
  20x), because a library of field recordings spans ~30dB and `sample=random`
  would otherwise be a loudness lottery. Every grain is 3 nodes and a note
  schedules its whole cloud up front, so `density` is the CPU knob; past 400
  grains a note thins rather than truncating. `direction` other than `forward`
  builds a reversed copy of the buffer (Web Audio has no backwards playback),
  doubling what that instance holds in memory.

### `tapepad` — `src/synths/tapepad.js`
A polyphonic pad played through a tape machine. Two halves, and the split is
the design: **per note**, a stack of detuned oscillators panned apart through
one lowpass and one slow attack/release envelope (ordinary subtractive
voicing); **shared and persistent**, one *transport* — wow and flutter drift
signals fanning into every live oscillator's `detune` — and one *tape stage*
(saturation → bit crush → bandwidth limit, with hiss joining after the curves)
that the summed chord runs through. Built for slow, warped, lofi chords.

- **params** — `cutoff` [40..16000] Hz, `detune` [0..60] cents,
  `pan_spread` [0..1], `sub` [0..1] (sine an octave down, routed *past* the
  filter), `attack` [0..10] s, `release` [0..10] s, `wow` [0..200] cents,
  `wow_rate` [0.1..8] (multiplier, not Hz), `flutter` [0..200] cents,
  `hiss` [0..1], `sat` [1..20]
- **options** — `waveform` (sine, triangle, sawtooth, square), `voices` (1..5),
  `bits` (3..16; 12 and up is effectively clean)
- **note** — the **only synth with params of both kinds**, and so the model for
  that: `wow`/`wow_rate`/`flutter`/`hiss`/`sat` wrap real single-node
  `AudioParam`s and are therefore *continuous* (a ramp or patch moves them
  mid-chord), while the six on `RibbitParamSources` are read once per trigger
  and so move note by note. Sharing one transport rather than one per voice is
  what makes the first group possible — and is also the sound: a chord bends
  together like tape, instead of smearing into a chorus.
- **also** — hiss runs whether or not the track is playing (a tape machine
  hisses when the music stops); `hiss=0` if that isn't wanted. `sat` gets
  louder as well as dirtier, by the same unity-slope-at-origin curve
  convention `saturator` uses. Sample-rate reduction is deliberately absent —
  it needs an `AudioWorklet` module for the host to serve, and the engine only
  ever asks hosts for JSON manifests.

---

## Processors (7)

An effect in a channel's insert chain (`/<channel> add_processor=<type>`).
Addressed by its own name. No per-event trigger.

They fall into two groups. `reverb`/`delay` are **effects** — they add
something beside the signal, so dry stays at unity and `wet` is added on top.
The five below are **dynamics and tone** — they act on the signal itself, so
where they have a `mix` at all it's a true crossfade (dry = 1 - mix, via
`RibbitProcessor.createCrossfade`), because a compressor whose dry path runs
at unity can't tame anything.

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

### `compressor` — `src/processors/compressor.js`
Web Audio's `DynamicsCompressorNode` plus makeup gain and a true dry/wet mix.
Turn `mix` down for parallel (New York) compression.

- **params** — `threshold` [-100..0] dB, `ratio` [1..20], `attack` [0..1],
  `release` [0..1], `knee` [0..40], `makeup` [0..8], `mix` [0..1]
- **options** — none
- **also** — `describeState()` prints live gain reduction; `threshold` is a
  patch destination, which is how you get a pumping compressor
  (`/patch source=lfo1 dest=comp.threshold depth=12`)

### `saturator` — `src/processors/saturator.js`
Waveshaping distortion: a drive stage into a fixed transfer curve.

- **params** — `drive` [1..50], `level` [0..2], `mix` [0..1]
- **options** — `character` (soft, hard, fold, tape), `oversample` (none, 2x, 4x)
- **note** — `drive` is a pre-gain (a real `AudioParam`, so it ramps) while the
  curve *shape* is an option, since it rebuilds a `Float32Array`. Curves are
  normalized to **unity slope at the origin**, not unity peak, so `drive=1` is
  near-transparent and all the dirt comes from `drive` — see the long comment
  on `buildCurve`, which is the one thing to read before touching this file.
  `fold` is a wavefolder and behaves nothing like the other three.

### `tilt` — `src/processors/tilt.js`
A tilt EQ: a low shelf and a high shelf pivoting around one frequency, moved
in opposite directions by a single control. Negative is darker, positive
brighter, zero flat. No `mix` — an EQ blended with its dry signal is just a
weaker EQ.

- **params** — `tone` [-1..1] (±12dB, fixed), `pivot` [100..8000] Hz
- **options** — none

### `limiter` — `src/processors/limiter.js`
A loudness ceiling: `boost` into a fast, high-ratio compressor. Honestly a
fast compressor, not a lookahead brickwall (Web Audio has no lookahead), so
treat `ceiling` as "about here". Ratio/knee/attack are fixed — a limiter with
those exposed is just `compressor`.

- **params** — `boost` [0..8], `ceiling` [-40..0] dB, `release` [0.01..1]
- **options** — none
- **also** — `describeState()` prints live gain reduction

### `goodenizer` — `src/processors/goodenizer.js`
All four of the above in one box, in order: compress → saturate → tilt →
limit. Drop it on master and everything gets louder and more even.
**A composite, not a sixth implementation** — it constructs one of
each (never registered, never addressable) and republishes their *actual*
`RibbitParam` objects, so `/glue threshold=` and `/compressor threshold=` are
the same control on two compressors rather than two code paths.

- **params** — `threshold` [-100..0], `ratio` [1..20], `attack` [0..1],
  `release` [0..1], `makeup` [0..8], `drive` [1..50], `tone` [-1..1],
  `pivot` [100..8000], `ceiling` [-40..0], `mix` [0..1]
- **options** — `character` (soft, hard, fold, tape), `oversample`
- **note** — the children's `mix`, the saturator's `level` and the limiter's
  `boost` are deliberately *not* republished (each would be a second way to
  set the same balance); use the atoms when you want them. `describeState()`
  prints both the compressor's and the limiter's reduction.
- **defaults** — `drive` defaults to **1**, i.e. the saturation stage present
  but clean. Compression, tilt and limiting make a mix *more like itself*;
  saturation makes it into something else, and a processor that alters timbre
  by default isn't one you can leave on every session. Every shipped session
  runs it this way; `drive=8 character=fold` is the other end of the box.

---

## Modulators (6)

A control source, never in a channel's chain — it exists to be patched
somewhere. Two distinct shapes:

- **continuous** (`lfo`, `cv`): a bipolar signal on `.output`, patched into an
  `AudioParam` via `/patch source=<mod> dest=<name.param> depth=`.
- **event-generating** (`randomnotes`, `markovpercs`, `euclidpercs`,
  `patternvariator`):
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

### `patternvariator` — `src/modulators/patternvariator.js`
Plays a **hand-written** pattern from the host's pattern library and generates
seeded variations on it — the only generator whose material is authored rather
than derived. Drives a `percsampler` (`kind: "drums"` patterns) or any pitched
synth (`kind: "notes"`, i.e. chords and melodies). Format and loader:
`src/pattern.js`; host contract: `GET /patterns/manifest.json`.

Every operator transforms existing material rather than inventing: a rhythm can
lose a hit, gain a ghost or nudge one step; a melody or chord is varied against
**the pattern's own pitch-class vocabulary** (inversion, octave displacement,
neighbour tones), so a variation stays recognisably a version of the source.
Generated once and looped until reseeded, like `markovpercs`.

- **params** — `velocity` [0..1], `swing` [0..0.5]
- **options** — `pack`, `pattern` (or `random` for either), `seed` (or
  `random`), `variation` [0..1], `density` [0..1], `step_beats`, `transpose`
  (scale degrees, pitched patterns only), `per_category`
- **also** — `describeState()` prints the varied result (a grid for drums, a
  token line for notes); `variation`/`density` are **options, not params**,
  because they feed seeded generation rather than being read per note

---

## Which one to copy

| If the new type… | start from |
| --- | --- |
| is a simple synth voice | `oscsynth` |
| is a subtractive/analogue voice with a filter and envelope | `tapepad` |
| has some params read per note and some read continuously | `tapepad` |
| needs persistent shared nodes alongside per-note ones | `tapepad` |
| loads audio files | `sampler`, then `percsampler` |
| is a synth needing rampable params | `percsampler`, `karplus` |
| is polyphonic / plays chords | `karplus`, `granular` |
| schedules many short nodes per note (a cloud, a swarm) | `granular` |
| plays sustained/pad material rather than one-shots | `granular` |
| synthesizes into a buffer rather than a node graph | `karplus` |
| is a straightforward effect | `reverb` |
| has a param spanning several nodes | `delay` (`onSet`) |
| needs a param that *ramps* across several nodes | `tilt`, or `RibbitProcessor.createCrossfade` |
| acts on the signal rather than adding to it (needs a real dry/wet crossfade) | `compressor` |
| rebuilds a curve/table from a discrete setting | `saturator` (`character`), `reverb` |
| combines existing processors rather than adding DSP | `goodenizer` (the only composite) |
| is a continuous control source | `cv` (minimal), then `lfo` |
| generates notes continuously | `randomnotes` |
| generates a fixed, looping pattern | `markovpercs` |
| generates from grid position | `euclidpercs` |
| plays or varies hand-authored material | `patternvariator` |
| reads a host-served library (manifest) | `percsampler`, `granular` (both via `src/samples.js`), `patternvariator` (`src/pattern.js`) |
| needs a param with no natural `AudioParam` | any of the last three — all use `RibbitParamSources` (`src/param.js`) |

Step-by-step guides: `building-synths.md`, `building-processors.md`,
`building-modulators.md`. Removing one: `removing-types.md`.

> **Keep this file current.** A new or removed synth/processor/modulator must
> be added or deleted here in the same change that touches
> `src/ribbit.js`'s registries — this catalog is what later readers (and
> LLMs) consult *instead of* reading every source file, so a stale entry is
> worse than no entry.
