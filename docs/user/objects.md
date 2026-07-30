# Synths and processors

## Synths (`synth=` on `/add_track` or a channel)

> **"Not rampable" below never means "can't be scheduled."** Options can't be
> ramped — there's no curve to draw between two discrete values — but every
> one of them accepts `at=beat` / `at=cycle` to land the change on a beat or
> loop boundary, exactly like a param. See
> [commands.md](commands.md#scheduling-with-at).


### `oscsynth` — `RibbitOscSynth` (default)

> A basic subtractive synth voice: single oscillator per note into a gain envelope.

One oscillator per triggered note: a short linear attack (5ms) into an exponential
decay over the note's duration.

| Constructor option | Default | Runtime option | Meaning |
|---|---|---|---|
| `waveform` | `"sawtooth"` | `waveform` | Any `OscillatorNode.type` value (`sine`, `square`, `sawtooth`, `triangle`). Runtime-settable as an **option** (`/lead waveform=square`, applies from the next note) — not rampable. |

Starts with **no events** — silent until you `add_event` onto it (see
[Events](#events) below): `/add_track name=lead synth=oscsynth waveform=square`
then `/lead add_event beat=0 pitch=60`. An event's `pitch` is a MIDI note
number; give `degree=` instead to use the shared harmony context.

### `sampler` — `RibbitSampler`

> A sample player: each event's pitch selects one of a fixed set of loaded sample
> slots to trigger (0 = first slot, wrapping if out of range).

Loads a fixed set of 6 drum one-shots from `static/samples` into indexed "slots" on
construction (async, fire-and-forget — a slot that hasn't finished loading yet
silently doesn't sound if triggered):

| Slot | Sample |
|---|---|
| 0 | kick02 |
| 1 | kick03 |
| 2 | distorted snare06 |
| 3 | distorted snare07 |
| 4 | hat13 |
| 5 | hat14 |

An event's `pitch` field selects the slot (modulo the slot count, so pitch `6` wraps
to slot `0`; negative pitches wrap correctly too). Starts with **no events** —
silent until you `add_event` onto it (see [Events](#events) below). `degree=`
doesn't apply here — the sampler always reads `pitch` as a slot index, never
resolves it against the harmony context.

| Constructor option | Default | Runtime option | Meaning |
|---|---|---|---|
| `samples` | the 6 files above | `samples` (option) | Comma-separated list of filenames under `static/samples` to load into slots, in order. Runtime-settable — `/drums samples="CLAUDE - kick02.wav,CLAUDE - hat13.wav"` (quoted, since these filenames contain spaces) swaps the slot list live; each slot is silent until its file finishes (re)loading, same fire-and-forget rule as construction. Not rampable. Round-trips through sessions. |

### `percsampler` — `RibbitPercSampler`

> A drum-kit sampler: 4 categories (kicks, snares, hats, percs) x per_category
> slots, filled at random from the host's sample library; an event's pitch
> picks a slot and wraps. Humanizes each hit (gain always; pan and playback
> speed by category).

Where `sampler` plays an arbitrary hand-listed set of files, this builds a
**structured drum kit**: four categories in a fixed order, `per_category`
slots each, filled at random from whatever the host has. That published
layout is the point — it's what lets a rhythm generator ask for "a snare"
without knowing which files were loaded.

**Slot layout** (with the default `per_category=4`):

| Slots | Category |
|---|---|
| 0–3 | kicks |
| 4–7 | snares |
| 8–11 | hats |
| 12–15 | percs |

In general, category *c* (in the order above) occupies slots
`c * per_category` to `c * per_category + per_category - 1`. An event's
`pitch` selects a slot and wraps in both directions. Unlike `sampler`, a
`degree=` event is accepted too — it's read as a slot index (never resolved
against harmony), so a generic generator like `randomnotes` can drive a kit
instead of being pinned to slot 0.

| Constructor option | Default | Runtime option | Meaning |
|---|---|---|---|
| `per_category` | `4` | `per_category` | Slots per category; total slots are always 4× this. Changing it **re-rolls** the kit, since it redefines every category's slot range. Setting it to the value it already has is a deliberate no-op. Not rampable. |
| `categories` | all four | `categories` | Which categories this instance actually loads, e.g. `categories=hats,percs`. Slot *indices never change* — unloaded categories keep silent placeholders. This is how one kit is split across several tracks; see [Splitting a kit across tracks](#splitting-a-kit-across-tracks). Order doesn't matter (it's normalized). Not rampable. |
| `samples` | random | `samples` | Either the literal `random` (re-roll every owned category) or an explicit comma-separated list of paths. Reports the **resolved** filenames, so a saved session restores the exact kit rather than rolling a new one. Not rampable. |

| Constructor option | Default | Runtime **param** | Meaning |
|---|---|---|---|
| `dynamics` | `0.25` | `dynamics` | How much each hit's level can fall below its event velocity: scaled by a random factor in `[1 - dynamics, 1]`. Applies to **every** category. Clamped to `0..0.9`, so the quietest possible hit is a tenth of its velocity — this adds dynamics, it never drops notes. Rampable. |
| `pan_spread` | `0.4` | `pan_spread` | Random stereo placement per hit, ± this much (`1` = hard left to hard right). **hats and percs only.** Rampable. |
| `speed_spread` | `0.1` | `speed_spread` | Random playback rate per hit, `1 ±` this much. **snares, hats and percs only.** Since this is a sampler, rate moves pitch and length together (tape behaviour) — it's what stops repeated hats sounding like one sample pasted sixteen times. Rampable. |

Kicks deliberately opt out of pan and speed so they keep anchoring the track;
snares hold the centre but may vary in pitch. These are the engine's first
**rampable synth params**, so they behave like any other param — `/hats
pan_spread=0.8 4b`, `at=cycle`, `automate=`, and they're valid `/patch`
destinations (`/patch source=lfo1 dest=hats.pan_spread depth=0.4`).

#### Generating a new kit

```
/hats samples=random                          # re-roll one track
/kick samples=random /snare samples=random    # several at once, one line
/hats per_category=2                          # re-rolls, and resizes
```

`/save name=good` captures the resolved filenames, so `/recall good` brings
back exactly those samples rather than a fresh roll.

#### Splitting a kit across tracks

Because slot indices are absolute regardless of which categories are loaded,
one generator can drive several restricted tracks and each takes only its own
share — no filtering or coordination needed. That's how each category gets
its own inserts, sends and fader:

```
/add_track name=kick  synth=percsampler categories=kicks
/add_track name=snare synth=percsampler categories=snares
/add_bus name=verb
/verb add_processor=reverb
/snare add_send=verb send_gain=0.35
/add_modulator type=markovpercs name=rhy per_category=4
/patch source=rhy dest=kick.notes
/patch source=rhy dest=snare.notes
```

A hit the track doesn't own lands on a placeholder slot and simply makes no
sound. See `/code-editor/percs-demo` for a worked four-track version.

#### Where the samples come from

Random selection needs to know what files exist, and a browser can't list a
directory over HTTP. So the host serves a manifest — `/samples/manifest.json`
by default, overridable with the `manifest_url` constructor option — shaped:

```json
{ "kicks": ["kicks/CLAUDE - kick01.wav"], "snares": [], "hats": [], "percs": [] }
```

Each entry is a path relative to the same `/samples/` prefix the audio files
are served under. In the NLLC app this is generated on request from
`static/samples/`; see `nllc/docs/dev/README.md`. A host that serves no
manifest gets an empty kit and a console warning, not an error — set
`samples=<list>` explicitly instead.

> **Console limitation:** an explicit `samples=` list is really only settable
> from a session file. Sample paths contain both `/` and spaces, and the
> console's parser treats `/` as the start of the next command and a space as
> the end of a value, so a pasted path is truncated. Ribbit rejects the
> truncated result rather than loading nonsense. Use `samples=random` at the
> console.

### `karplus` — `RibbitKarplus`

> A polyphonic Karplus-Strong plucked string: a noise burst through a feedback
> delay line, rendered per note. Plays chords and melodies; degrees resolve
> against the shared harmony context.

**The only polyphonic synth** — a chord is just several overlapping notes at
the same beat, with no voice limit to run out of. That makes it the natural
partner for a `notes` [pattern](patterns.md), and the thing to point
`patternvariator` at when you want harmony rather than drums.

Karplus-Strong is a physical model, and a strikingly simple one: fill a short
delay line with noise, then read it out repeatedly while feeding each sample
back in averaged with its neighbour. The noise burst is the pluck; the
averaging is the string losing its high harmonics first, which is what makes it
sound like a string rather than a filtered oscillator.

Notes **ring for their natural decay** rather than being cut off at the end of
the written note — that's how a plucked string behaves. A `duration` shorter
than the decay is instead read as *muting* the string: a short fade rather than
a hard stop.

| Constructor option | Default | Runtime **param** | Meaning |
|---|---|---|---|
| `damping` | `0.35` | `damping` | How fast the high harmonics are lost. `0` is a bright, almost metallic string; `1` a dull thud. Clamped `0..1`. Rampable. |
| `decay` | `2` | `decay` | Seconds for the note to fall by 60dB. Pitch-compensated, so a high note dies away at the same rate as a low one. Clamped `0.05..8`. Rampable. |
| `brightness` | `0.6` | `brightness` | Tone of the pluck *itself*, before the string gets hold of it — `1` is the raw burst, lower values pre-soften it. Distinct from `damping`, which governs what happens after. Clamped `0..1`. Rampable. |

| Constructor option | Default | Runtime option | Meaning |
|---|---|---|---|
| `excitation` | `"noise"` | `excitation` | What fills the delay line at the pluck. `noise` is the classic broadband burst; `pulse` is a single impulse, exciting the same harmonics in phase for a much cleaner, more harp-like attack. Not rampable. |

An event's `pitch` is a MIDI note number; `degree=` resolves against the shared
harmony context instead, which is what a `notes` pattern emits.

```
/add_track name=keys synth=karplus
/keys add_event beat=0 degree=0
/keys add_event beat=0 degree=3
/keys add_event beat=0 degree=7
/keys damping=0.9 8b            # let the strings go dull over 8 beats
/keys excitation=pulse at=cycle # cleaner attack from the next downbeat
```

All three params are valid `/patch` destinations, so an LFO on `brightness`
gives you a slowly-breathing string:

```
/add_modulator type=lfo name=sway freq=0.05
/patch source=sway dest=keys.brightness depth=0.25
```

> **A note on the top octave.** Each pluck is rendered into a buffer rather
> than built as a node graph — Web Audio forces any feedback loop containing a
> delay to a minimum length, which would cap the instrument around F#4. The
> trade-off is that pitch quantizes to a whole number of samples: accurate
> within a few cents up to C6, drifting to about a fifth of a semitone by G6.
> Inaudible in normal use, worth knowing if you write very high parts.

## Buses (`/add_bus`)

A bus is an empty channel — fader, pan, an insert chain, sends — with no
synth of its own. It exists purely to be a shared **send** destination other
tracks (or other buses) route into, e.g. a shared reverb/delay send, or a
sub-mix of several tracks routed through one set of processors before
reaching master:

```
/add_bus name=fx1
/track_1 add_send=fx1 send_gain=0.3
/fx1 add_processor=reverb
```

A fresh bus's own default send feeds `master`, same as a fresh track — set
`out=` at creation (`/add_bus name=fx1 out=drumbus`) to feed somewhere else
instead. See [commands.md](commands.md#buses-and-sends) for the full
`out=`/`add_send=`/`remove_send=`/`send=` reference.

## Processors (`add_processor=` on any channel)

### `reverb` — `RibbitReverb`

> A simple algorithmic reverb: convolution against a generated impulse response,
> added on top of the dry signal.

Convolves the (always-passed-through) dry signal against a synthetically-generated
impulse response — exponentially-decaying random noise, not a real-space recording.

| Constructor option | Default | Runtime param | Meaning |
|---|---|---|---|
| `duration` | `2.5`s | `duration` (option) | Length of the generated impulse response, in seconds (`0..20`). Runtime-settable option — `/reverb duration=4` regenerates the IR in place (a brief tail discontinuity is audible; that's inherent to swapping a convolution buffer). Not rampable. |
| `decay` | `3` | `decay` (option) | Exponent controlling how fast the impulse response decays. Runtime-settable option, regenerates the IR like `duration`. Not rampable. |
| `wet` | `0.3` | `wet` | Wet-signal mix level. Clamped to `0..2` (up to a 2× boost, never unbounded). |

### `delay` — `RibbitDelay`

> A stereo delay: independent left/right delay lines with cross-feedback
> (ping-pong) and a small time offset between channels for width.

Dry signal always passes through; the wet path splits to independent L/R delay
lines that feed back into *each other* (ping-pong) rather than themselves.

| Constructor option | Default | Runtime param | Meaning |
|---|---|---|---|
| `time` | `0.375`s | `time` | Base delay time (right channel is offset by `stereoOffset` above this). Clamped to `0..5` (the delay node's own maximum). |
| `feedback` | `0.35` | `feedback` | Cross-feedback amount (applied symmetrically to both channels). Clamped to `0..0.95` — at or past unity the cross-feeding lines recirculate a growing signal forever (a runaway loop, not an effect). |
| `wet` | `0.3` | `wet` | Wet-signal mix level. Clamped to `0..2`. |
| `stereoOffset` | `0.06`s | `stereoOffset` (option) | Extra delay time on the right channel for stereo width (`0..1`s). Runtime-settable option — not rampable. |

## Modulators (`type=` on `/add_modulator`)

A modulator is a standalone control source — created and addressed like a
processor, but it never joins any channel's chain. On its own it does
nothing audible; it only matters once patched into a parameter with
`/patch` — see [commands.md](commands.md#modulators-and-patches).

There are six, in two shapes. `lfo` and `cv` both produce a **continuous
signal** patched into a parameter (`lfo` moves by itself, `cv` holds
whatever you set); `randomnotes`, `markovpercs`, `euclidpercs` and
`patternvariator` instead generate **discrete notes** and patch into a track's
synth rather than a parameter.

The four generators differ in *what decides whether a hit happens*:

| Generator | Decides from | Repeats? |
|---|---|---|
| `randomnotes` | a fresh dice roll at each slot | never — no two bars alike |
| `markovpercs` | the previous step (a Markov chain) | yes, one fixed pattern until reseeded |
| `euclidpercs` | the step's own index (euclidean distribution) | yes, exactly — it can hold a downbeat |
| `patternvariator` | **a file you wrote**, plus seeded variation | yes, one fixed take until reseeded |

Two distinctions matter here. First, `markovpercs` has no notion of where in
the bar it is, so it produces convincing *texture* but can't place a kick on
every beat; `euclidpercs` decides each step from its position, so it can.
They're designed to be used together — a euclidean backbone with a Markov layer
adding ghost notes around it.

Second, `patternvariator` is the only one whose material is **authored rather
than derived**. The other three invent a pattern from a rule; this one plays
something you wrote in a file and varies it. Reach for it when you know what
you want to hear, and for the others when you want to be surprised.

Several generators may feed the same track (only an exact duplicate patch is
rejected).

### `lfo` — `RibbitLFO` (default)

> A low-frequency oscillator: a continuous bipolar (-1..1) control signal at
> a given rate, for patching into any parameter.

| Constructor option | Default | Runtime param | Meaning |
|---|---|---|---|
| `freq` | `1`Hz | `freq` | Oscillation rate. Rampable/deferrable like any param. Clamped to `0..20000` — deliberately allowed well past "low frequency", since patching an audio-rate LFO into a param is classic FM territory. |
| `waveform` | `"sine"` | `waveform` (option) | Any `OscillatorNode.type` value (`sine`, `square`, `sawtooth`, `triangle`). Runtime-settable option — the running oscillator switches shape in place. Not rampable. |

`/add_modulator type=lfo freq=2 name=lfo1` then `/patch source=lfo1
dest=reverb.wet depth=0.2` wobbles `reverb`'s wet mix at 2Hz.

### `cv` — `RibbitCV`

> A generic control-voltage source: a held value (no waveform, no rate) you
> set, ramp, or automate — the modular equivalent of a manual offset knob or
> a sample-and-hold's output.

The odd one out: `lfo` moves on its own, `cv` never does. Its output only
changes when you tell it to, which makes it useful for two things an `lfo`
can't do — **holding an offset** on a patched parameter, and **driving
several destinations from one control** (patch the same `cv` into three
places at different depths, then move all three with one command).

| Constructor option | Default | Runtime param | Meaning |
|---|---|---|---|
| `value` | `0` | `value` | The held output level. Rampable and deferrable (`value=1 4b`, `value=0 at=cycle`) and a valid `automate=` target like any other param. Deliberately **unbounded** — real control voltage has no fixed range, and a patch's own `depth` is what scales it for a given destination. |

```
/add_modulator type=cv name=cv1 value=0.5
/patch source=cv1 dest=reverb.wet depth=0.4
/cv1 value=1 8b              # ramp every destination it feeds, over 8 beats
```

Because a patch *adds* to the destination's own value rather than replacing
it (see [commands.md](commands.md#modulators-and-patches)), a `cv` at `0`
does nothing — it's the resting position, not an "off" switch. Negative
values are legal and push the destination the other way.

### `randomnotes` — `RibbitRandomNotes`

> Generates random note events (probability/min-gap/scale) and feeds a
> synth's control input via `/patch dest=<track>.notes` — doesn't touch
> manually-authored events.

Unlike `lfo`, this doesn't produce a continuous signal to patch into a
parameter — it generates discrete **notes**, algorithmically, and feeds them
straight into a track's synth via the reserved `.notes` patch destination
(see [commands.md](commands.md#event-generating-modulators-patching-notes-into-a-synth)),
running alongside — never replacing — anything you `add_event`'d by hand.

| Constructor option | Default | Runtime param | Meaning |
|---|---|---|---|
| `probability` | `0.5` | `probability` | Chance (0–1) that a candidate slot actually produces a note. Rampable/deferrable like any param. |
| `min_gap` | `1` beat | `min_gap` | Spacing (in beats) between candidate slots — both the fastest possible note rate and the grid `probability` thins out. Rampable/deferrable, clamped to `0.0625..16`. |
| `scale` | `0,2,4,5,7,9,11` | `scale` (option) | A comma-separated (or array) list of scale degrees a generated note's pitch is randomly picked from — resolved against the shared harmony context **at trigger time**, exactly like a manually `add_event`'d `degree=` (see [Events](#events) below). Runtime-settable option (`/rand1 scale=0,3,7`, applies from the next generated note) — not rampable. |

```
/add_track name=lead
/add_modulator type=randomnotes name=rand1 probability=0.7 min_gap=0.5 scale=0,2,4,5,7,9,11
/patch source=rand1 dest=lead.notes
```

Generation walks a `min_gap`-spaced grid of candidate beats forward forever
(not tied to the loop, so it doesn't repeat identically every pass); at each
slot, `probability` decides whether a note actually fires, and if so a random
entry from `scale` becomes that note's `degree`. With the default chromatic
harmony scale, `scale`'s numbers behave as plain semitone offsets from the
harmony root — the default `0,2,4,5,7,9,11` is therefore a major scale.

### `markovpercs` — `RibbitMarkovPercs`

> Generates a fixed drum rhythm from a Markov chain over [rest, kicks,
> snares, hats, percs] and loops it until reseeded; feeds a percsampler via
> `/patch dest=<track>.notes`.

A rhythm generator for [`percsampler`](#percsampler--ribbitpercsampler). It
walks a first-order Markov chain once across a step grid to build **one fixed
pattern**, then loops that pattern — the same hits on the same slots every
pass — until something regenerates it. That's the key difference from
`randomnotes`, which re-rolls forever and so never settles into a groove you
can build on.

The pattern stores a category and a variant *within* that category, not a
finished slot number; the slot arithmetic happens at delivery. So the same
pattern maps correctly onto a kit with 1 slot per category or 8, and it reads
`per_category` off whatever it's patched into when it can.

| Constructor option | Default | Runtime option | Meaning |
|---|---|---|---|
| `style` | `"rolling"` | `style` | Which transition table to use: `sparse`, `rolling`, `broken`, `kickheavy`, `chaotic`. Regenerates. Not rampable. |
| `seed` | random | `seed` | The PRNG seed. Accepts a number or the literal `random`. Reports the concrete number in use, so a saved session rebuilds the *same* rhythm. Regenerates. Not rampable. |
| `steps` | `16` | `steps` | Steps in the pattern. Regenerates. Not rampable. |
| `step_beats` | `0.25` | `step_beats` | Grid resolution in beats (`0.25` = sixteenths). With `steps` this sets the pattern's length before it repeats — `steps × step_beats` beats, deliberately independent of the clock's loop length, so a 3-beat rhythm over a 4-beat loop phases rather than locking. Regenerates. Not rampable. |
| `density` | `1` | `density` | Thins the pattern without changing its character: each hit the chain produces survives with this probability. `1` leaves the chain's own rest rate alone; `0` silences it. Regenerates. Not rampable. |
| `per_category` | `4` | `per_category` | Fallback slot stride, used only when the patched destination doesn't publish its own. Not rampable. |

| Constructor option | Default | Runtime **param** | Meaning |
|---|---|---|---|
| `velocity` | `1` | `velocity` | Base velocity for generated hits. Read fresh every tick, so ramping it audibly rides the pattern already playing. Clamped `0..1`. Rampable. |
| `swing` | `0` | `swing` | Delays every odd step by this fraction of a step — the usual shuffle feel. Even steps stay put, so the pulse doesn't drift. Clamped `0..0.5`. Rampable. |

Everything shaping the *pattern* is an option (setting it regenerates);
`velocity` and `swing` are params because they apply live to the pattern
already running. Hits landing on a whole beat are accented; everything
between is played a little softer.

The styles are named for the **texture** a chain produces, not for genres.
There's no `fourfloor` on purpose: a first-order chain's only input is the
previous step, so it has no idea where in the bar it is and can't reliably
place a kick on every downbeat. [`euclidpercs`](#euclidpercs--ribbiteuclidpercs)
is the tool for that, and shares the same slot-index contract — so both can
drive the same kit at once, which is exactly what the `euclid-ghosts` example
session does.

```
/add_track name=drums synth=percsampler
/add_modulator type=markovpercs name=rhy style=broken seed=31415 density=0.8
/patch source=rhy dest=drums.notes
/rhy                      # prints the pattern, e.g. .sk.HhshSp.s...k
/rhy seed=random          # a different rhythm
/rhy swing=0.3 8b         # ease into a shuffle over 8 beats
```

Querying it (`/rhy`, or the modulator list) prints the generated pattern as
one character per step — `k`/`s`/`h`/`p` per category, `.` for a rest,
uppercased where a step lands on a whole beat. The params and options only
describe how the rhythm was *derived*; this shows what you'll actually hear.

### `euclidpercs` — `RibbitEuclidPercs`

> Generates a repeatable drum grid: one euclidean rhythm per category
> (kicks/snares/hats/percs), each with its own pulse count and rotation; feeds
> a percsampler via `/patch dest=<track>.notes`.

The other rhythm generator for
[`percsampler`](#percsampler--ribbitpercsampler), and the deliberate
counterpart to [`markovpercs`](#markovpercs--ribbitmarkovpercs). It places
each category's hits with **Bjorklund's algorithm**: spread *n* pulses as
evenly as possible over the available steps. Every hit is decided by its own
step index, so the pattern is exactly repeatable — this is the generator that
can hold a downbeat.

Two structural differences from `markovpercs` worth knowing:

- **Each category is an independent layer.** A Markov step is a kick *or* a
  snare *or* a rest; a euclidean step can be a kick **and** a hat, which is
  what makes a real kit pattern possible.
- **Randomization decorates the grid rather than replacing it** — see
  `variation` and `dropout` below. Nothing can move a hit off its step.

Maximally-even distributions turn out to be a remarkable number of traditional
rhythms: E(3,8) is the tresillo, E(5,8) the cinquillo, E(5,16) the bossa-nova
pattern, E(4,16) four-on-the-floor.

| Constructor option | Default | Runtime option | Meaning |
|---|---|---|---|
| `preset` | `"fourfloor"` | `preset` | Sets the grid length plus every category's pulses and rotation at once: `fourfloor`, `backbeat`, `tresillo`, `bossa`, `polyrhythm`, `sparse`. A "start again from here" gesture — it replaces all of them, and individual settings applied afterwards win. Regenerates. Not rampable. |
| `steps` | from preset | `steps` | Steps in the grid. Regenerates. Not rampable. |
| `step_beats` | `0.25` | `step_beats` | Grid resolution in beats (`0.25` = sixteenths). With `steps` this sets the pattern's length — `steps × step_beats` beats, independent of the clock's loop length, so the 12-step `polyrhythm` preset phases against a 4-beat loop rather than locking. Regenerates. Not rampable. |
| `kicks`, `snares`, `hats`, `percs` | from preset | same | Pulse count for that category, capped at `steps`. `0` silences the layer. Regenerates. Not rampable. |
| `kicks_rotate`, `snares_rotate`, `hats_rotate`, `percs_rotate` | from preset | same | Rotates that layer forward: `snares_rotate=4` moves its first hit *to* step 4. This is how a backbeat is built — E(2,16) rotated by 4. Regenerates. Not rampable. |
| `variation` | `0` | `variation` | How often a hit uses a sample slot other than its category's first. `0` = every kick is the same kick; `1` = spread across the whole category. Seeded, so it's part of the fixed pattern. Regenerates. Not rampable. |
| `seed` | random | `seed` | PRNG seed for `variation`. Accepts a number or the literal `random`. Regenerates. Not rampable. |
| `per_category` | `4` | `per_category` | Fallback slot stride, used only when the patched destination doesn't publish its own. Not rampable. |

| Constructor option | Default | Runtime **param** | Meaning |
|---|---|---|---|
| `velocity` | `1` | `velocity` | Base velocity for generated hits. Read fresh every tick. Clamped `0..1`. Rampable. |
| `swing` | `0` | `swing` | Delays every odd step by this fraction of a step. Clamped `0..0.5`. Rampable. |
| `dropout` | `0` | `dropout` | Probability that any given hit is skipped **on any given pass** — the pattern breathes instead of machine-gunning. Re-rolled live, so unlike everything else here it isn't reproducible; it can only ever *remove* a hit, never move one, so the grid survives it. Capped at `0.9` (silencing a part is what `gain=` is for). Rampable — `/grid dropout=0.5 8b` opens the pattern up over 8 beats. |

Hits landing on a whole beat are accented; everything between is played a
little softer.

```
/add_track name=drums synth=percsampler
/add_modulator type=euclidpercs name=grid preset=fourfloor
/patch source=grid dest=drums.notes
/grid                          # prints the grid, one row per category
/grid preset=tresillo          # a different starting point
/grid kicks=3 kicks_rotate=2   # pulses and rotation, per category
/grid steps=12                 # change grid length; layers re-space themselves
/grid dropout=0.4 8b           # thin it out over 8 beats
/grid preset=bossa at=cycle    # swap the backbone on the next downbeat
```

Querying it (`/grid`, or the modulator list) prints the grid, one row per
category — `X` for a hit on a whole beat, `x` for one between beats, `.` for a
gap:

```
kicks  X...X...X...X...
snares ....X.......X...
hats   X.x.X.x.X.x.X.x.
percs  ..x..x..X..x..x.
```

Two example sessions ship with the reference app: `euclid-demo` (this
generator alone) and `euclid-ghosts` (a euclidean backbone with `markovpercs`
adding ghost notes on top).

### `patternvariator` — `RibbitPatternVariator`

> Plays a hand-written pattern from the host's pattern library (drum lanes, or
> chords/melodies as scale degrees) and generates seeded variations on it.

The only generator that plays material **you wrote**. It loads a pattern file
(see **[patterns.md](patterns.md)** for how to write one), then varies it — so
a part can stay recognisably itself while never being quite identical twice.

It drives either shape of material: a `drums` pattern feeds a
[`percsampler`](#percsampler--ribbitpercsampler) through the same slot contract
every other drum generator uses, and a `notes` pattern feeds any pitched synth
(most naturally [`karplus`](#karplus--ribbitkarplus), which plays chords).

**Selecting a pattern:**

| Constructor option | Default | Runtime option | Meaning |
|---|---|---|---|
| `pack` | random | `pack` | Which folder under `/patterns/` to draw from. `random` picks one. Changing it re-picks the pattern too, since a name only means something inside its pack. Not rampable. |
| `pattern` | random | `pattern` | Which pattern in the pack, by bare name (`boom-bap`, not `hiphopdrums/boom-bap.json`). `random` re-picks. Always *reports* the concrete name in use, so a saved session reloads the same pattern rather than rolling a new one. Not rampable. |

**Shaping the variation** — all options, all regenerating when set:

| Constructor option | Default | Runtime option | Meaning |
|---|---|---|---|
| `variation` | `0.3` | `variation` | How far from the source to stray, `0..1`. `0` plays the file exactly as written. Not rampable — see the note below. |
| `density` | `1` | `density` | Thins the result without changing its character: every surviving event keeps its place with this probability. `0` silences it. Not rampable. |
| `seed` | random | `seed` | PRNG seed. A number, or the literal `random` — the "give me another take" gesture. Not rampable. |
| `step_beats` | the file's own | `step_beats` | Overrides the pattern's grid resolution, so one file can be played at half or double time without editing it. Not rampable. |
| `transpose` | `0` | `transpose` | Shifts pitched material by whole scale **degrees** (not semitones), so it stays in key. Ignored for drum patterns, where a degree is a slot index. Not rampable. |
| `per_category` | `4` | `per_category` | Fallback slot stride, used only when the patched destination doesn't publish its own. Not rampable. |

**Live controls** — read fresh on every tick:

| Constructor option | Default | Runtime **param** | Meaning |
|---|---|---|---|
| `velocity` | `1` | `velocity` | Scales the pattern's own velocity. Clamped `0..1`. Rampable. |
| `swing` | `0` | `swing` | Delays every odd step by this fraction of a step. Clamped `0..0.5`. Rampable. |

> **Why `variation` isn't rampable.** It's an input to *seeded generation*, not
> a value read per note, so ramping it would mean the pattern quietly rewriting
> itself mid-phrase. Setting it re-rolls a reproducible take and then holds
> still. The same reasoning applies to `density` and `seed` — and it's the
> general rule for choosing param vs. option: params are read while playing,
> options are read while generating. (Every one of them still accepts
> `at=beat`/`at=cycle`, as always — *not rampable* never means *not
> schedulable*.)

**How variation actually works.** Every operation transforms material that's
already there; none invents anything new. That's what keeps a variation
recognisable rather than merely different.

For rhythms: a hit may be dropped, a rest may pick up a ghost note, a hit may
be nudged to a neighbouring step (only into space you left empty), and a hit's
sample slot may be re-picked. Ghost notes are weighted by category — an extra
hat is what a drummer does without noticing, an extra kick moves the whole
track's centre of gravity, so kicks get them far more rarely.

For chords and melodies: the pattern's **own notes** are read as its
vocabulary, and variation stays inside it — chords are inverted or a voice
octave-displaced (both change the sound a lot and the harmony not at all), a
degree may be swapped for a neighbouring one *drawn from the pattern itself*,
and a gap may pick up a passing tone between the notes either side. It won't
wander into notes your progression never used.

Even at `variation=1`, roughly two thirds of a source rhythm survives. That's
the design target: a "variation" that leaves nothing of the original is just a
different pattern.

Querying it (`/beat`) prints what it's actually playing — a grid for drums:

```
kicks  x.....x...x.....
snares ...x......g.x...
hats   x.x.xgx.x.x.x.x.
```

or a token line for notes:

```
0,3,7 . -4,0,3 . 3,7,10 . -2,2,5 .
```

```
/add_track name=drums synth=percsampler
/add_modulator type=patternvariator name=beat pack=hiphopdrums pattern=boom-bap
/patch source=beat dest=drums.notes
/beat                          # show the varied grid
/beat variation=0.8            # skips, ghosts, hits nudged off the grid
/beat seed=random              # another take at the same amount
/beat pattern=halftime         # a different pattern from the same pack
/beat density=0.6              # thin it without changing its character
/beat swing=0.18 4b            # ride the swing up over 4 beats
/beat pattern=dusty at=cycle   # swap on the next downbeat
```

Two example sessions ship with the reference app: `pattern-drums` (two
variators over a split kit, one of them phasing) and `pattern-chords`
(chords and a melody on two `karplus` tracks).

## Events

A synth's pattern is a list of events, authored with `/track_1 add_event ...`
(see [commands.md](commands.md)) — a fresh track's synth starts with none.
Each event has:

| Field | Default | Meaning |
|---|---|---|
| `beat` | `0` | Loop-relative position (`0` to the clock's `num_beats`, see [commands.md](commands.md#top-level-commands)). |
| `pitch` | `60` if neither `pitch=` nor `degree=` given | A raw MIDI note number (`oscsynth`) or sample-slot index (`sampler`, `percsampler`). |
| `degree` | — | A scale-degree, resolved against the shared harmony context **at the moment the note is triggered**, not when `add_event` was run. Only meaningful for `oscsynth`; `sampler` ignores it, and `percsampler` reads it as a slot index without resolving it. |
| `velocity` | `1` | 0–1, used as the note's peak gain. |
| `duration` | `0.25` | In beats, not seconds — the clock converts using the current tempo at trigger time. |

The harmony context (`root`/`scale`) defaults to chromatic — every semitone
is in the scale — so `degree` behaves as a plain semitone offset from `root`
(MIDI 60). Change either at runtime with `/harmony root=57
scale=0,2,3,5,7,8,10` (see [commands.md](commands.md#top-level-commands)).
Because `degree` resolves at trigger time rather than being baked in when
the event is authored, changing the key/scale retunes every already-playing
`degree=`-authored pattern (and every `randomnotes` stream) live, mid-loop —
a chord/progression system on top of this is still future work, but the key
and scale themselves are live controls today.

## Gain taper

Every channel's `gain=` command param is a linear 0–1 *fader position*, not a raw
gain value. It's mapped onto actual gain through an exponential taper
(`src/taper.js`) so that equal steps in position feel like
equal steps in loudness (the ear perceives loudness roughly logarithmically) —
`gain=0.5` is not "half as loud", it's the position that sounds like the halfway
point.
