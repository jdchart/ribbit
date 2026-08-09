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
- A range in brackets is the param's clamp. It doubles as the range
  `<param>=random` draws from, and having one at both ends is what qualifies a
  param for the bulk `/<object> random`. Options list their `choices` where
  they have a fixed set.

Registered in `src/ribbit.js` (`SYNTH_TYPES` / `PROCESSOR_TYPES` /
`MODULATOR_TYPES`); the source files live in `src/synths/`,
`src/processors/`, `src/modulators/`.

---

## Synths (8)

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

### `chaossynth` — `src/synths/chaossynth.js`
A chaotic two-voice cross-coupled feedback synthesizer, recreated from the
"chaotic synthesiser" subpatcher in `.claude/context/regression.maxpat` (where
a `fluid.mlpregressor~` predicted its ten inputs from a 2D pad). Two sine
oscillators, each driven through an `atan` saturator into a resonant lowpass,
with **two nested feedback loops**: per voice the filter's cutoff is driven by
that voice's own loudness (louder = darker, so it hunts rather than settles),
and between the voices each oscillator's pitch is bent at audio rate by the
other's filtered output. Renders per note into an `AudioBuffer` like `karplus`,
for a sharper version of the same reason — both loops are single-sample and a
Web Audio cycle is forced to 128, which makes it a *different* dynamical
system, and the envelope follower has no node equivalent at all. Polyphonic
(each trigger is its own chaotic system). Voice A is the left channel, voice B
the right.

**A MIDI note selects a state, not a pitch.** `seed` builds one configuration
of all ten inputs per MIDI note (0..127); playing note 60 always selects
configuration 60. So any note generator becomes a way to sequence *timbres* —
this is the only synth where that's the intended use.

- **params** — the ten control points, all [0..1] because that is what the
  original patch's multislider was, each scaled internally:
  `a_cross`/`b_cross` (how hard the other voice FMs this one — the chaos knob),
  `a_drive`/`b_drive` (0..50dB into the saturator), `a_pitch`/`b_pitch` (base
  pitch, mapped onto MIDI 0..69), `a_res`/`b_res` (resonance, ×0.96),
  `a_track`/`b_track` (how much the voice's own loudness closes its filter).
  Plus `spread` [0..1] (lerp from the params toward the note's seeded state:
  0 = params only and every note identical, 1 = the seeded state outright),
  `pitch_track` [0..1] (how much the note *also* transposes both voices, in
  semitones — 0 makes a note a pure index), `attack` [0..2] s,
  `release` [0.005..4] s
- **options** — `seed` (or `random`), `output` (stereo, mono, a, b — `a`/`b`
  put one voice on both channels, the fastest way to hear which half of a
  state does what)
- **also** — `describeState()` prints the seed and the ten values note 60
  resolves to, in param order, so the line reads back as commands
- **note** — notes are capped at 8 seconds (`MAX_NOTE_SECONDS`); the inner loop
  is per-sample and costs well over `karplus`'s — **measured ~5.6ms per
  2-second note**, so a chord of four long notes is ~22ms of the 100ms
  scheduling window and is the way to make this expensive. Output hard-clips
  at the top of the range (peak is exactly 1.0 with all ten inputs at 1, ~0.35
  at the defaults): a resonant lowpass has gain at cutoff, and distorting
  there beats making every ordinary setting quieter. Two documented
  substitutions for Max
  objects with no Web Audio equivalent: `lores~` → a Chamberlin state-variable
  filter (its cutoff is remodulated every 64 samples and a biquad recomputing
  coefficients that fast can go unstable), and `fluid.loudness~` → a one-pole
  RMS follower read at the patch's own 64-sample hop. Events in the shipped
  session use `pitch` rather than `degree` on purpose — a degree is resolved
  against `/harmony`, so moving the root would silently renumber every state.

### `czsynth` — `src/synths/czsynth.js`
An emulation of the Casio CZ-101 (1984) — phase distortion, the synthesis
behind the Boards of Canada palette. **There is no filter in it.** One cosine
table is read with a phase bent by a piecewise-linear transfer function, so a
period still takes exactly one period but is traversed unevenly; the DCW
envelope moves how hard it is bent, which sounds like a filter opening while
being nothing of the sort. At DCW 0 every waveform is a pure sine. Renders per
note into an `AudioBuffer` like `karplus`/`chaossynth` (a per-sample
nonlinearity whose *shape* is moving has no node equivalent —
`WaveShaperNode` reshapes amplitude, not phase, from a fixed array).
Polyphonic; **mono output**, because the CZ-101 has one.

The machine's architecture: up to two *lines*, each `DCO → DCW → DCA` with an
eight-stage envelope on all three, summed and detuned against each other.

**The only synth with a preset library**, which is a consequence of the format
rather than a preference: a tone is ~90 numbers. `src/synths/cz-tones.js`
carries **28 Boards of Canada patches decoded from sysex dumps**
(`.claude/context/Casio CZ 101/syx/`, one folder per record). Params are
*modifiers over* whichever tone is selected, never absolutes — so choosing a
preset never has to reach in and rewrite them.

- **params** — `dcw` [0..2] (scales both DCW envelopes; **the filter knob** —
  0 is a sine, 1 is the tone as dumped), `env_time` [0.05..8] (multiplies every
  segment of all six envelopes), `detune` [0..100] extra cents between lines
  (*added* to the tone's, which is often a whole octave), `vib_depth` [0..100]
  extra cents, `vib_rate` [0.1..4] multiplier, `pitch_env` [0..4],
  `key_follow` [0..2] (how much faster/darker high notes get)
- **options** — `preset` (28 names, or `random`), `wave` (saw, square, pulse,
  doublesine, sawpulse, reso1, reso2, reso3), `lines` (1, 2, 1+1, 1+2),
  `mod` (none, ring, noise), `octave` (-1, 0, 1)
- **also** — `describeState()` prints the resolved preset, waveform, lines,
  octave, detune and both envelopes in the CZ's own `rate>level` units with
  `*` on the sustain step
- **note** — every option **except `preset`** takes the sentinel **`preset`**,
  meaning "whatever the tone says". That is what keeps the two layers from
  writing to each other, and it's the pattern to copy for any future
  preset-backed type. Three genuine oddities: `reso1`/`reso2`/`reso3` are *not*
  phase distortion (an inner sine hard-synced to the note through a per-cycle
  window — so `dcw` there moves a **frequency**, not a brightness); a
  *combination* preset alternates two waveforms on successive periods rather
  than mixing them, which puts a sub-octave under the note; and output is
  trimmed by half, because these waveforms are peak-to-peak 2 by construction
  and the DC-heavy ones (pulse, doublesine) peak at 2 from zero once the DC
  blocker has run. Cost is ~0.35ms per second of audio per line (a 3s two-line
  note is ~1.9ms); `MAX_NOTE_SECONDS` caps a render at 12s. The envelope
  **rate-to-seconds curve is fitted, not documented** — Casio never published
  it and no teardown has recovered it; `env_time` is the intended correction.

---

## Processors (9)

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

### `svf` — `src/processors/svf.js`
A state-variable filter: one cutoff and one resonance, read out as a lowpass,
highpass, bandpass or notch. The sound-design filter (`tilt` is the mix one) —
this is what you sweep with an LFO or close over eight bars. Both params are
real `AudioParam`s on a single `BiquadFilterNode`, so they ramp, defer and take
a patch natively with nothing to fan out.

- **params** — `cutoff` [20..18000] Hz, `resonance` [0.1..30] (Q),
  `mix` [0..1] (a true crossfade — a filter's job is to remove something, and
  a dry path at unity would let it through; `mix=0.5` is parallel filtering)
- **options** — `mode` (lowpass, highpass, bandpass, notch)
- **note** — one node with its `type` switched, not four in parallel with a
  morph between them. A continuous morph is the obvious extension and would
  cost four biquads per channel for a control almost nobody sweeps; `mode`
  still schedules on a boundary (`/filt mode=highpass at=cycle`) like any
  option. Resonance near the top has real gain at cutoff and is the fastest
  way to overload a channel.

### `comb` — `src/processors/comb.js`
A comb filter: the signal summed with a very short delayed copy of itself —
peaks and notches at multiples of `1/time`. Two shapes, and they sound
different: **feedforward** (`y = x + a·x[n-d]`, one copy, notches — the body of
a flanger, so patch an LFO into `time`) and **feedback** (`y = x + a·y[n-d]`,
recirculating, peaks, and it rings with a pitch of its own). Both are built and
left running; `mode` picks which reaches the wet gain.

- **params** — `time` [0.0002..0.05] s (20Hz–5kHz as a comb frequency),
  `feedback` [-0.95..0.95] (**bipolar** — a negative coefficient inverts the
  copy and puts every peak where a notch was), `tone` [200..18000] Hz (a
  lowpass on the delayed copy; inside the loop in feedback mode, so each pass
  is darker than the last), `mix` [0..1]
- **options** — `mode` (feedback, feedforward)
- **also** — `describeState()` prints the comb frequency and the feedback floor
- **note** — **the feedback branch can't resonate above ~344Hz** (48kHz:
  ~375Hz). A Web Audio cycle must contain a `DelayNode` and the spec forces one
  to at least a render quantum — the same wall `karplus` hit and answered by
  rendering into a buffer, which a live insert can't do. The feedforward branch
  is in no loop and combs the whole range. A `time` below the floor silently
  resonates at the floor instead of erroring, which is why `describeState()`
  says so.

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

## Modulators (8)

A control source, never in a channel's chain — it exists to be patched
somewhere. Two distinct shapes:

- **continuous** (`lfo`, `cv`): a bipolar signal on `.output`, patched into an
  `AudioParam` via `/patch source=<mod> dest=<name.param> depth=`.
- **event-generating** (`randomnotes`, `markovpercs`, `euclidpercs`,
  `patternvariator`, `chorale`):
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

### `chorale` — `src/modulators/chorale.js`
Sustained, overlapping harmony: several long-held voices moving through a
chord progression in a mode. **The only generator with no rhythm and nothing
random in it** — every note is a pure function of the absolute beat, so the
texture is identical on every pass and after any `/stop /start`. Drives any
polyphonic synth (`tapepad`, `karplus`, `granular`).

Two independent clocks: the **chord clock** (`chord_beats`) advances the
progression, the **voice clock** (`note_beats`) re-attacks each voice. Because
they don't line up, a voice holds its old note across a chord change — that
overhang is where the suspensions come from. Voice leading is **positional,
not remembered**: each voice has a fixed register anchor spread across
`spread` octaves and always takes chord tone `v % chord_size` placed in the
nearest octave, so the chord is always fully voiced and each voice moves the
smallest interval that keeps it in its own register. More `voices` than
`chord_size` wraps back to the root, which is an octave doubling when `spread`
is wide enough to separate them and a wasted unison when it isn't — six voices
want `spread=3`, four are happy at 1.

- **params** — `velocity` [0..1], `note_beats` [0.25..64] (voice re-attack
  period), `overlap` [0..2] (hold time as a multiple of the period beyond it —
  this is what makes it continuous rather than gapped), `spread` [0..4]
  octaves between the lowest and highest voice, `stagger` [0..1] (1 spreads
  the voices' entries evenly across one period, 0 makes them block chords)
- **options** — `mode` (ionian, dorian, phrygian, lydian, mixolydian, aeolian,
  locrian, harmonicminor, pentatonic, wholetone), `progression`
  (comma-separated mode steps, e.g. `0,5,3,4`), `chord_size` (3 = triad,
  4 = seventh, 5 = ninth), `stack` (1..4 mode steps between chord tones;
  2 = tertian, 3 = quartal, 4 = open fifths), `chord_beats`, `transpose`
  (degrees — how a second instance becomes an octave-up layer), `voices`
- **also** — `describeState()` prints the whole progression as actually voiced
- **note** — a param is read when a voice *attacks*, not continuously, so a
  ramp or patch on `spread`/`note_beats` arrives voice by voice as each one
  re-enters: the pad revoices itself over a cycle rather than sliding.
  `chord_beats` is an **option** for the opposite reason — the current chord is
  derived by dividing the absolute beat by it, so ramping it would renumber
  every chord boundary underneath the music rather than slowing the
  progression down.

### `randomgestures` — `src/modulators/randomgestures.js`
Roams the live session and glides random parameters to new values — a seeded,
self-playing hand on the controls. **The only modulator that isn't patched into
anything**: it holds the engine (handed to it at construction, the way a synth
is handed the harmony context), enumerates what is currently modulatable, and
ramps real `AudioParam`s directly. A patch cable gives you one destination
chosen by hand; this gives you the whole patch, drifting.

What it may touch is not a new concept: exactly the set the bulk
`/<object> random` draws from — a param with a declared range whose `.r` flag
is on (`RibbitParam.canRandomize`). So a channel's fader is out by default and
`/lead cutoff.r=false` takes one param off the table for both at once. There is
deliberately no second opt-out list.

- **params** — `gesture_beats` [0.25..64] (interval), `glide` [0..64] beats
  (how long one gesture takes — longer than the interval means several params
  in motion at once, which is what makes it sound like a performer),
  `depth` [0..1] (how far one gesture may move a param, as a fraction of that
  param's own range, either side of where it currently sits — a bounded random
  *walk*, not unrelated jumps), `probability` [0..1] (rolled per due gesture)
- **options** — `seed` (or `random`), `scope` (all, tracks, buses, processors,
  modulators, master), `targets` (comma-separated object names, overriding
  `scope`; **a group name expands to its members**, which is the intended way
  to aim it), `params` (comma-separated param names, e.g. `params=cutoff`)
- **also** — `describeState()` prints how many params are in range and the last
  gesture; sets `lastEventTime`, so the mixer strip flashes per gesture
- **note** — it rides a **new clock hook, `onSchedule(fromBeat, toBeat,
  secondsPerBeat, clock)`** (clock.js), the third thing a unit can do with a
  scheduling window after playing events and generating notes. Seeded and
  repeatable, and `/stop /start` replays the take from the top — with the
  caveat that a gesture is a choice *among what currently exists*, so adding a
  track mid-take renumbers everything after it.

---

## Groups

Not a type — a name that stands for several other names (`src/group.js`,
`/add_group name=drums members=kick,snare,hats`). Every key on the line that
isn't the group's own is forwarded verbatim to each member's own command
handler, so `/drums gain=0 4b at=cycle` fades all of them on the same boundary
and `/drums random` rolls all of them. `groupCommand` knows nothing about gain
or synths, which is why groups work with commands written before they existed.

**Not a bus.** A bus sums signal, and routing four tracks into one changes what
you hear (one fader, one insert chain, one pan). A group changes nothing about
the graph. The two compose: a group of the tracks that already send to a drum
bus is the normal arrangement.

Members are **names**, resolved fresh per command — so a group can be written
before its members exist, survives `/recall` tearing a member down and
rebuilding it, and marks a member that no longer resolves as `(missing)` rather
than quietly shrinking. Groups can nest (cycles are entered once and stopped).
`remove_self` deletes the group and leaves its members alone.

## Mute and solo

Every channel (track, bus, master) has `mute` / `unmute` and — master aside —
`solo` / `unsolo`, deferrable like any other command. Mute is its own node
between the panner and the fader, **not** "set gain to 0": the fader keeps its
position and its saved value, an in-flight gain ramp keeps running underneath,
and unmuting returns exactly where the channel was. Being upstream of the fader
takes the sends with it, so a muted track feeds a reverb bus nothing.

Solo is a whole-session state (`Ribbit.updateSolo`), not a per-channel flag: a
channel stays audible if it can reach a soloed channel, or be reached from one,
through sends. Solo a track and its reverb bus keeps working; solo the bus and
the tracks feeding it keep playing. Both round-trip in a session file (written
only when true) and both show in `/tracks` and on the mixer's M/S buttons.

## Recording

`engine.recorder` (`src/recorder.js`) — not a registered type, so it has no
params or options; three plain settings instead, carried by `/record` and
`/recording`:

- `mode` — `stereo` (tap master alone, one `.wav`) or `multitrack` (tap every
  track, then every bus, then master; one `.wav` each, downloaded as a `.zip`).
  Can't change mid-take.
- `bits` — `32` (IEEE float, lossless, survives going over 0dBFS) or `16`
  (PCM, half the size, clamps).
- `max_minutes` — safety stop, default 5. A take is raw float audio in memory.

`/record` and `/stop_record` both take `at=`, which is the point of typing them
rather than clicking. Taps read each channel's `output`, so they are
post-fader/pan/mute and a muted channel records silence. Capture is an
`AudioWorkletProcessor` compiled from an inline blob URL — the engine's only
worklet, and the file to copy if a type ever needs one (e.g. a sample-accurate
`getModulated`). A take is deliberately **not** in a session snapshot.

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
| synthesizes into a buffer rather than a node graph | `karplus`, then `chaossynth` (the per-sample, control-rate-inner-loop version) |
| needs feedback tighter than a render quantum, or an envelope follower in the loop | `chaossynth` |
| treats a MIDI note as something other than a pitch | `chaossynth` (a state index), `sampler`/`percsampler` (a slot) |
| has many controls that should vary per note from one seed | `chaossynth` (`seed` + `spread`) |
| ships a preset library, or has more state than a console can type | `czsynth` (data module + a `preset` option, params as modifiers) |
| needs an option that means "don't override the preset" | `czsynth` (the `preset` sentinel on every other option) |
| distorts phase rather than amplitude, or needs a moving nonlinearity | `czsynth` |
| models a specific piece of hardware from its sysex format | `czsynth` |
| is a straightforward effect | `reverb` |
| is a filter, or anything with one live `AudioParam` per control | `svf` (the smallest processor with real params) |
| needs a param that *ramps* across several nodes | `tilt`, `delay`, `comb`, or `RibbitProcessor.createCrossfade` |
| has a feedback loop, or two structures switched between | `comb` |
| acts on the signal rather than adding to it (needs a real dry/wet crossfade) | `compressor` |
| rebuilds a curve/table from a discrete setting | `saturator` (`character`), `reverb` |
| combines existing processors rather than adding DSP | `goodenizer` (the only composite) |
| is a continuous control source | `cv` (minimal), then `lfo` |
| generates notes continuously | `randomnotes` |
| generates a fixed, looping pattern | `markovpercs` |
| generates from grid position | `euclidpercs` |
| plays or varies hand-authored material | `patternvariator` |
| generates sustained/overlapping notes rather than hits | `chorale` |
| needs chords, modes or voice leading | `chorale` |
| must be exactly reproducible without a seed (derived purely from the beat) | `chorale` |
| modulates the session rather than one destination (needs no patch) | `randomgestures` (also the only user of the clock's `onSchedule` hook, and of the injected `engine`) |
| reads a host-served library (manifest) | `percsampler`, `granular` (both via `src/samples.js`), `patternvariator` (`src/pattern.js`) |
| needs a param with no natural `AudioParam` | any of the last three — all use `RibbitParamSources` (`src/param.js`) |

Step-by-step guides: `building-synths.md`, `building-processors.md`,
`building-modulators.md`. Removing one: `removing-types.md`.

> **Keep this file current.** A new or removed synth/processor/modulator must
> be added or deleted here in the same change that touches
> `src/ribbit.js`'s registries — this catalog is what later readers (and
> LLMs) consult *instead of* reading every source file, so a stale entry is
> worse than no entry.
