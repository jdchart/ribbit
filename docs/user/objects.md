# Synths and processors

## Synths (`synth=` on `/add_track` or a channel)

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

There are three, in two shapes. `lfo` and `cv` both produce a **continuous
signal** patched into a parameter (`lfo` moves by itself, `cv` holds
whatever you set); `randomnotes` instead generates **discrete notes** and
patches into a track's synth rather than a parameter.

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

## Events

A synth's pattern is a list of events, authored with `/track_1 add_event ...`
(see [commands.md](commands.md)) — a fresh track's synth starts with none.
Each event has:

| Field | Default | Meaning |
|---|---|---|
| `beat` | `0` | Loop-relative position (`0` to the clock's `num_beats`, see [commands.md](commands.md#top-level-commands)). |
| `pitch` | `60` if neither `pitch=` nor `degree=` given | A raw MIDI note number (`oscsynth`) or sample-slot index (`sampler`). |
| `degree` | — | A scale-degree, resolved against the shared harmony context **at the moment the note is triggered**, not when `add_event` was run. Only meaningful for `oscsynth`; `sampler` ignores it. |
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
