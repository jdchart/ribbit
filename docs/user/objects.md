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
pan_spread=0.8 4b`, `at=cycle`, and an instant set all work, read fresh from
the next hit onward. (`automate=` and `/patch` reach them too, one hit at a
time — see [Modulating a synth param](#modulating-a-synth-param).)

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
`patternvariator` (or [`chorale`](#chorale--ribbitchorale), for generated
rather than authored harmony) at when you want harmony rather than drums.

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

All three ramp, so a phrase can open up or go dull under your hands:

```
/keys brightness=0.1 8b         # darken over 8 beats
/keys decay=0.4 4b              # and shorten the strings
```

> **A note on the top octave.** Each pluck is rendered into a buffer rather
> than built as a node graph — Web Audio forces any feedback loop containing a
> delay to a minimum length, which would cap the instrument around F#4. The
> trade-off is that pitch quantizes to a whole number of samples: accurate
> within a few cents up to C6, drifting to about a fifth of a semitone by G6.
> Inaudible in normal use, worth knowing if you write very high parts.

### `granular` — `RibbitGranular`

> A granular synth: one source recording (picked at random from a folder of
> the host's sample library) played back as a cloud of short overlapping
> grains, for sustained pad textures. Plays chords; degrees transpose the
> grains against the shared harmony context.

**A note here is not a playback.** Each note schedules dozens of overlapping
short slices — *grains* — taken from around a movable playhead in one source
recording, each sprayed in read position, pitch, timing and stereo placement.
Feed it a few seconds of foley (rain, a river, glass, birds) and what comes
out has no relationship to the recording's own rhythm: it's a sustained
texture whose character is the recording's timbre.

The structure is **two stages, and the split is the instrument**:

| Stage | Controls | What it shapes |
|---|---|---|
| Voice envelope | `attack`, `release` | the *note* — this is what makes it a pad |
| The cloud | `density`, `grain_size`, `spray`, `position`, `drift`, `pitch_spread`, `pan_spread` | the *texture* inside that note |

Polyphonic, like `karplus`: a chord is three clouds overlapping, with no voice
limit to run out of. An event's `degree` resolves against the shared harmony
context and sets each grain's playback rate relative to `root`; `pitch` is a
MIDI note. Transposition is a **tape-speed** gesture — pitch and grain content
move together, so a low note doesn't merely sound lower, it reads *slower*
through the material. That's most of why unpitched foley works as harmony.

| Constructor option | Default | Runtime **param** | Meaning |
|---|---|---|---|
| `density` | `30` | `density` | Grains per second. Low is a stuttering, pointillist texture; high is a solid wash. Clamped `1..200`. Rampable. |
| `grain_size` | `0.2` | `grain_size` | Seconds per grain. Below ~30ms the grain *rate* starts to be heard as a pitch of its own; above ~0.5s you hear the source's own movement inside each grain. Clamped `0.005..2`. Rampable. |
| `spray` | `0.25` | `spray` | How far, in seconds of source material, each grain may wander either side of the playhead. `0` is every grain reading the same instant (a frozen, almost tonal drone); a second or two smears a whole phrase into one chord. Clamped `0..10`. Rampable. |
| `position` | `0` | `position` | The playhead: where in the recording the cloud reads from, `0..1` across the whole buffer. Rampable — walking it across 16 beats is the signature gesture. |
| `drift` | `0.05` | `drift` | How fast the playhead moves *while a note is held*, in source seconds per second. `0` freezes it (the classic granular pad), `1` is natural speed, negative runs the material backwards through the note without reversing the grains themselves. Clamped `-2..2`. Rampable. |
| `pitch_spread` | `0.15` | `pitch_spread` | Random detune per grain, in semitones either way. A fraction of a semitone is chorus — the cheapest lushness there is; several semitones is a cloud that no longer agrees with itself about what note it's playing. Clamped `0..24`. Rampable. |
| `pan_spread` | `0.8` | `pan_spread` | Random stereo placement per grain (`1` = hard left to hard right). Wide by default: grains scattered across the field is most of what makes a cloud sound like a *space* rather than a sound. Clamped `0..1`. Rampable. |
| `attack` | `1.2` | `attack` | Seconds to reach full level. Capped at the written note's own length. Clamped `0..10`. Rampable. |
| `release` | `2` | `release` | Seconds to fall away after the written duration ends. Grains keep spawning through it, so the tail is granular too rather than a fade over a frozen cloud. Clamped `0..10`. Rampable. |

| Constructor option | Default | Runtime option | Meaning |
|---|---|---|---|
| `sample` | random | `sample` | The source recording. Either the literal `random` (re-roll within the current folder) or a path. Reports the **resolved** path, so a saved session restores the recording it was built with rather than rolling a new one. Not rampable. |
| `folder` | `"foley"` | `folder` | Which folder of the host's sample library rolls come from. Changing it re-rolls; setting it to its current value is a deliberate no-op. An unknown folder is rejected with the list of real ones. Not rampable. |
| `window` | `"hann"` | `window` | The fade applied to each grain, without which every one would click. `hann` is smooth at both ends (grains melt together), `tri` is a touch more present, `expo` gives each grain an attack so the cloud reads as a shimmer of tiny events. Not rampable. |
| `direction` | `"forward"` | `direction` | Which way grains read the source: `forward`, `reverse`, or `mixed` (each grain decides). Not rampable — see the memory note below. |
| `root` | `60` | `root` | Which MIDI note plays the source at its natural speed. Everything else transposes from here, so this is how a part written around degree 0 is placed where the material still sounds like itself: raise it and the whole part reads slower and deeper. Not rampable. |

```
/add_track name=pad synth=granular
/pad                            # which recording it landed on, and how long
/pad add_event beat=0 degree=0 duration=4
/pad position=0.9 16b           # walk the playhead through the recording
/pad spray=3 8b                 # smear a whole phrase into one chord
/pad grain_size=0.02 8b         # from a wash to a buzz
/pad sample=random              # a different recording
/pad window=expo at=cycle       # change the grain shape on the downbeat
```

Best driven by a `notes` [pattern](patterns.md) through `patternvariator` —
the `ambientchords` pack ships for exactly this. See `/code-editor/granular-pad`
for a three-track worked example, or [`chorale`](#chorale--ribbitchorale) for
sustained harmony generated rather than authored.

#### Sources, and why they're gain-matched

The source is chosen at random from the host's library the same way
`percsampler` fills a kit, through the same
[manifest](#where-the-samples-come-from) — the only difference is that any
folder works, not just the four drum categories.

A library of field recordings is **not mastered**: the shipped `foley` folder
runs from an unnormalized river recording peaking at −30dB to a texture at
full scale. So each source is **peak-normalized on load** (capped at 20×) and
the match is shown in the track's summary:

```
/pad
pad — gain=0.60 ... synth=granular("...") "Jonathan Kawchuk - Tidal Pool" 6.4s x20.0
```

Without it, `sample=random` would change a track's level by 30dB and every
mix decision would have to be redone after each roll. If a track is too loud
or quiet, the fix is its `gain`, not the source.

> **Console limitation, same as `percsampler`:** an explicit `sample=` path is
> really only settable from a session file, because sample paths contain `/`
> and spaces and the console's parser treats those as command and value
> boundaries. Ribbit rejects the truncated result rather than loading
> nonsense. Use `sample=random` at the console.

#### Cost

Every grain is three Web Audio nodes, and a note schedules its **whole cloud
up front**. `density` is therefore the CPU knob: 20–40 is a pad, 200 is a
stress test. A note that would need more than 400 grains gets a *thinner*
cloud spanning its full length rather than one that stops early.

`direction` other than `forward` builds a reversed copy of the buffer — Web
Audio has no backwards playback — which doubles what that track holds in
memory. It's built when you set the option, not per note, so the cost lands on
the command rather than on a note starting.

> **Big recordings load slowly.** Loading is fire-and-forget, like every
> sampler here: a note before the file arrives is silent rather than queued,
> and the summary says `(loading)` until it lands. The shipped `foley` folder
> contains recordings up to four minutes long.

### `tapepad` — `RibbitTapePad`

> A polyphonic pad played through a tape machine: detuned oscillator stacks
> into one shared transport (wow/flutter pitch drift) and one shared tape
> stage (saturation, bit crush, bandwidth, hiss). Built for slow, warped,
> lofi chords.

The structure is **two halves, and the split is the instrument**:

| Half | Controls | What it is |
|---|---|---|
| Per note | `cutoff`, `detune`, `pan_spread`, `sub`, `attack`, `release`, `waveform`, `voices` | ordinary subtractive voicing — a stack of oscillators, a filter, an envelope |
| The machine | `wow`, `wow_rate`, `flutter`, `sat`, `bits`, `hiss` | one tape transport and one tape stage, shared by every note and running all the time |

**The machine is shared, not per-voice, and that's the sound.** A tape
recorder has one capstan, so when it wavers the whole chord bends *together*.
Give every voice its own wobble instead and a chord smears into a chorus — a
lush effect, but not a warped recording. The same goes for saturation and
crush: they act on the summed chord, so the voices interfere with each other
on the way through. That intermodulation is where the dirt comes from.

It also has a practical consequence, and it's the one thing about this synth
worth designing around: because those six live on always-running nodes, they
are **continuous**. `/pad wow=60 8b` warps the tape *while a chord is
sustaining*. The per-note half behaves like every other synth param — read
once when a note is scheduled (see [below](#modulating-a-synth-param)).

Polyphonic, like `karplus` and `granular`: a chord is several stacks
overlapping, with no voice limit to run out of. An event's `degree` resolves
against the shared harmony context; `pitch` is a MIDI note.

| Constructor option | Default | Runtime **param** | Meaning |
|---|---|---|---|
| `cutoff` | `1400` | `cutoff` | Corner of the per-note lowpass, in Hz. Also swept by the envelope — the filter opens to `cutoff` across the attack and eases back over the tail, so a long chord breathes. Clamped `40..16000`. Rampable. |
| `detune` | `14` | `detune` | Spread between the stacked oscillators, in cents, widest pair first. The thickness control: `0` collapses the stack to one oscillator's worth of tone, past ~30 it stops being a chorus and starts being out of tune. Clamped `0..60`. Rampable. |
| `pan_spread` | `0.5` | `pan_spread` | How far apart the stack is panned. Shares its position with the detune spread — the sharp voice one side, the flat one the other — so widening it widens the beating too. No effect at `voices=1`. Clamped `0..1`. Rampable. |
| `sub` | `0.35` | `sub` | Level of a sine an octave below the note. Routed *past* the filter, so closing `cutoff` right down darkens the pad without hollowing out its bottom end. Clamped `0..1`. Rampable. |
| `attack` | `0.9` | `attack` | Seconds to reach full level. Capped per note at the written note's own length, so a 3-second swell inside a 1-second note peaks at 1 second rather than never arriving. Clamped `0..10`. Rampable. |
| `release` | `2.5` | `release` | Seconds to fall away after the written duration ends. This is what makes the chords overlap. Clamped `0..10`. Rampable. |
| `wow` | `18` | `wow` | Depth of the slow pitch wander, in cents. **Continuous** — ramps and patches move it mid-chord. Clamped `0..200`. Rampable. |
| `wow_rate` | `1` | `wow_rate` | How fast that wander runs, as a **multiplier**, not a frequency — the drift is a sum of five partials, so there's no single rate to name. `1` is the natural wobble. Continuous. Clamped `0.1..8`. Rampable. |
| `flutter` | `10` | `flutter` | Depth of the fast tremble, in cents. A separate control from `wow` because they're different faults — a warped reel versus a worn capstan — and much more of the first than the second is most of what "tape" means. Continuous. Clamped `0..200`. Rampable. |
| `hiss` | `0.15` | `hiss` | Level of the tape noise floor. Runs whether or not the track is playing, because a tape machine hisses when the music stops; set `0` if that isn't wanted. Continuous. Clamped `0..1`. Rampable. |
| `sat` | `1.4` | `sat` | Drive into the tape saturation curve. Louder as well as dirtier — the track's own `gain` is the balance control, the same trade [`saturator`](#saturator--ribbitsaturator) makes. Continuous. Clamped `1..20`. Rampable. |

| Constructor option | Default | Runtime option | Meaning |
|---|---|---|---|
| `waveform` | `"sawtooth"` | `waveform` | Shape of each oscillator in the stack: `sine`, `triangle`, `sawtooth`, `square`. Sawtooth has the most for the filter to work on; triangle is the mellow one. Not rampable. |
| `voices` | `3` | `voices` | Oscillators per note, `1..5`. Not a param because there's no such thing as 2.5 oscillators — the value indexes a stack, so sweeping it isn't a gesture. Not rampable. |
| `bits` | `12` | `bits` | Quantization depth of the crush stage, `3..16`. An option rather than a param because setting it rebuilds a lookup curve. **12 and above is effectively clean**; the range below that is where it sounds like a cheap sampler. Not rampable. |

```
/add_track name=pad synth=tapepad
/pad add_event beat=0 degree=0 duration=4
/pad wow=60 8b                  # warp the tape, slowly — mid-chord
/pad wow_rate=3 8b              # and make the warp faster
/pad bits=5                     # cheap sampler
/pad sat=6 4b                   # drive the tape harder
/pad cutoff=400 16b             # close it right down — the sub stays
/pad voices=5 detune=30         # thicker, and further out of tune
/pad hiss=0.6                   # tape noise as an instrument
/pad waveform=triangle at=cycle # swap the oscillator on the downbeat
```

Best driven by a `notes` [pattern](patterns.md) through `patternvariator` —
the `ambientchords` pack ships for exactly this. See `/code-editor/ambient-tape`
for a three-layer worked example, and `/code-editor/chorale-drift` for the same
synth driven by [`chorale`](#chorale--ribbitchorale) instead.

> **What isn't here: sample-rate reduction**, the other half of a real lofi
> stage. Holding each sample for N frames needs per-sample JavaScript, which
> in Web Audio means an `AudioWorklet` module the host would have to serve —
> and the engine deliberately never asks a host for anything but JSON. `bits`
> covers the audible half of the same idea.

### `chaossynth` — `RibbitChaosSynth`

> A chaotic two-voice cross-coupled feedback synthesizer, recreated from a
> Max/MSP patch. Ten control points, all `0..1`. A seed gives every MIDI note
> its own configuration of all ten — so **a note selects a timbre, not a
> pitch**.

Two identical voices, wired into each other. Each one is a sine oscillator
driven through an `atan` saturator into a resonant lowpass:

```
freq   = the other voice's output * cross, plus this voice's pitch
osc    = a sine at that frequency
driven = osc, amplified by drive (0..50dB)
sat    = atan(driven)                       <- bounded, whatever you do to it
out    = lowpass(sat, cutoff, res)
cutoff = derived from how loud `out` currently is, scaled by track
```

**Two nested feedback loops, and they're the whole instrument.** The inner one
is per voice and negative: the filter's cutoff is driven by that voice's own
loudness, so getting louder closes the filter, which makes it quieter, which
opens it again. It never settles — it hunts. The outer one runs between the
voices and acts on *frequency*: each oscillator's pitch is bent at audio rate
by the other's filtered output, so neither has a pitch of its own for more
than an instant. Small changes to the ten inputs give completely different
results. That is the point, not a defect.

Voice A is the left channel and voice B the right, matching the original
patch's two outlets. Polyphonic, like `karplus` and `granular`: each note
renders its own buffer, so a chord is several overlapping chaotic systems.

#### A note is a state

`seed` builds **one configuration of all ten inputs per MIDI note**, 0 to 127.
Playing note 60 always selects configuration 60 — in this session and in any
other session with the same seed. So any generator that emits notes becomes a
way to sequence *timbres*: point a `markovpercs` rhythm, a `chorale`
progression, or a hand-written pattern at a `chaossynth` and you get a
sequence of chaotic states rather than a melody.

`spread` decides how far a note may pull the ten params you set by hand. It's
a straight blend:

| `spread` | What a note plays |
|---|---|
| `0` | your ten params, exactly. Every note identical; the seed does nothing. |
| `0.5` | halfway between your params and that note's seeded configuration. |
| `1` | the seeded configuration outright; your params stop mattering. |

So the ten points stay individually addressable, rampable and patchable at
every setting — `spread` only decides how much the seed is allowed to argue
with them.

`pitch_track` restores as much conventional pitch behaviour as you want: at
`0` a note is purely an index, at `1` it is *also* added to both voices' base
pitch in semitones (an uncoupled voice at `a_pitch=1` then puts note 69 at
A440). `0.3` is enough that a rising line audibly rises.

| Constructor option | Default | Runtime **param** | Meaning |
|---|---|---|---|
| `a_cross` / `b_cross` | `0.12` / `0.18` | same | How hard the *other* voice bends this one's pitch. The chaos knob: at `0` the voices are two independent drones, and by `0.3` neither has a stable pitch. Clamped `0..1`. Rampable. |
| `a_drive` / `b_drive` | `0.45` / `0.4` | same | Gain into the saturator, `0..50dB`. Timbre rather than level — `atan` bounds the result either way, so this is how much of the sine survives as a sine. Clamped `0..1`. Rampable. |
| `a_pitch` / `b_pitch` | `0.55` / `0.62` | same | Base pitch, mapped onto MIDI `0..69` — so `1` is A440 and the useful drone range is the bottom two thirds. Whatever the coupling adds rides on top. Clamped `0..1`. Rampable. |
| `a_res` / `b_res` | `0.6` / `0.55` | same | Filter resonance. The ceiling is deliberate: this filter's cutoff is being modulated by its own output, and right at the top the loop screams. Clamped `0..1`. Rampable. |
| `a_track` / `b_track` | `0.5` / `0.55` | same | How much the voice's own loudness closes its filter — the inner loop's depth. `0` leaves the filter wide open and the voice is a plain saturated oscillator; `1` is the full sweep, and the voice breathes and stutters on its own. Clamped `0..1`. Rampable. |
| `spread` | `0.35` | `spread` | How far a note's seeded configuration pulls the ten above (see the table earlier). Clamped `0..1`. Rampable. |
| `pitch_track` | `0` | `pitch_track` | How much the note *also* transposes both voices, in semitones. Clamped `0..1`. Rampable. |
| `attack` | `0.01` | `attack` | Seconds to full level. Short by default — the interesting transient is the system winding up from silence, which a slow attack hides. Clamped `0..2`. Rampable. |
| `release` | `0.25` | `release` | Seconds to fall away after the written duration. Clamped `0.005..4`. Rampable. |

| Constructor option | Default | Runtime option | Meaning |
|---|---|---|---|
| `seed` | `1` | `seed` | Which set of 128 configurations is in force, or `random` to re-roll. Everything about the seeded half of the sound follows from this one number, which is what makes a saved session reproduce — the table is rebuilt from the seed on load, never stored. Not rampable. |
| `output` | `"stereo"` | `output` | `stereo` (A left, B right), `mono`, `a` or `b`. The last two put one voice on both channels, which is the fastest way to work out which half of a state is doing what. Not rampable. |

```
/add_track name=riff synth=chaossynth
/riff add_event beat=0 pitch=36 duration=0.75
/riff                        # the seed, and the ten values note 60 resolves to
/riff seed=random            # a whole new instrument, same notes
/riff spread=0 8b            # collapse to one sound
/riff spread=1 8b            # and past your params entirely
/riff a_cross=0.5 4b         # more coupling: pitch stops meaning anything
/riff a_track=0 4b           # kill the inner loop; the filter stays open
/riff a_res=0.95             # and now it rings
/riff pitch_track=1 8b       # make the notes behave like notes again
/riff output=a               # voice A only, both channels
/riff random                 # re-roll all ten control points at once
```

`/riff` on its own prints the seed and the ten values note 60 currently
resolves to, in param order — the line reads back as commands.

See `/code-editor/chaos-states` for a worked example: the same synth at
`spread` 0.6, 0.95 and 0, driven by hand-written notes, by `randomnotes`, and
by two LFOs respectively.

> **Notes are capped at 8 seconds**, and the inner loop is per-sample: about
> 5.6ms of JavaScript per 2-second note, so a chord of four long notes is
> ~22ms of work at schedule time. It renders into a buffer rather than
> building a node graph because both feedback loops are single-sample, and Web
> Audio forces any graph cycle to 128 samples of delay — which would make it a
> *different* system, not a slightly worse one.

> **It distorts at the top of its range.** With all ten inputs at `1` the
> output hard-clips; at the defaults it peaks around a third of full scale. A
> resonant lowpass has gain at its cutoff, and clipping there is the right
> trade — the alternative is a gain stage that makes every ordinary setting
> quieter to protect the extreme one.

### `czsynth` — `RibbitCZSynth`

> An emulation of the Casio CZ-101 (1984) — **phase distortion**, the
> synthesis behind most of what people mean by "the Boards of Canada sound".
> Ships **28 presets decoded from real sysex dumps**, and is the only synth in
> the engine with a preset library.

**There is no filter in it.** One cosine table is read with a phase that has
been bent by a piecewise-linear function, so a period still takes exactly one
period but is traversed unevenly — fast through part of it, slow or stopped
through the rest. The DCW envelope moves *how hard it is bent*:

```
DCW 0    the transfer function is the identity      -> a pure sine
DCW 50   half bent                                  -> harmonics appearing
DCW 99   fully bent                                 -> saw / square / pulse
```

That sounds uncannily like a filter opening, while being nothing of the sort.
At DCW `0` **every** waveform is a sine, whichever one is selected.

The architecture is the machine's: up to two *lines*, each a `DCO → DCW → DCA`
chain with its own eight-stage envelope on all three stages, summed and
detuned against each other. Polyphonic, like `karplus` and `granular` — each
note renders its own buffer. **Mono**, because the CZ-101 has one output; put
the width in the delay and reverb after it.

#### Presets are the base, params are modifiers

A CZ tone is three eight-stage envelopes per line — around ninety numbers,
which no console surface makes typable. So the tone comes from `preset`, and
the seven params are *modifiers over whatever is selected* rather than
absolutes. Choosing a preset never rewrites them, and they never have to be
re-applied when it changes.

The presets are recreations of the sounds on specific records, one group per
album — `twoism-pulse-epiano`, `orangey-flute`, `zander-two-bells`,
`turquoise-hexagon-sun-epiano`, `a03-bass` and so on. `/<track> preset=random`
rolls one; `/<track>` on its own prints which is loaded and what it resolved
to.

| Constructor option | Default | Runtime **param** | Meaning |
|---|---|---|---|
| `dcw` | `1` | `dcw` | Scales every level in both DCW envelopes. **The filter knob.** `0` is an undistorted sine whatever the waveform, `1` is the tone as dumped, above that pushes it past where the hardware's own envelope could reach. Clamped `0..2`. Rampable. |
| `env_time` | `1` | `env_time` | Multiplies the duration of every segment of all six envelopes at once. The fastest way to turn an electric piano into a pad. Clamped `0.05..8`. Rampable. |
| `detune` | `0` | `detune` | *Extra* cents between the two lines, added to the tone's own. Additive rather than absolute because most of these tones detune by a whole octave or two rather than by a few cents — replacing that would break them. Clamped `0..100`. Rampable. |
| `vib_depth` | `0` | `vib_depth` | Extra vibrato depth in cents, added to the tone's. Clamped `0..100`. Rampable. |
| `vib_rate` | `1` | `vib_rate` | Multiplier on the tone's vibrato rate. A multiplier rather than an absolute because every tone has a rate, so there is always something to scale. Clamped `0.1..4`. Rampable. |
| `pitch_env` | `1` | `pitch_env` | Scales the DCO (pitch) envelope's depth; `0` disables it. Only `a03-square-lead` has one that does anything audible. Clamped `0..4`. Rampable. |
| `key_follow` | `1` | `key_follow` | Scales both KEY FOLLOW amounts — how much faster high notes decay and how much darker they get. `0` makes the instrument behave identically at every pitch. Clamped `0..2`. Rampable. |

| Constructor option | Default | Runtime option | Meaning |
|---|---|---|---|
| `preset` | `"sixtyniner-sine-pad"` | `preset` | Which of the 28 tones is loaded, or `random` to roll one. Not rampable. |
| `wave` | `"preset"` | `wave` | `saw`, `square`, `pulse`, `doublesine`, `sawpulse`, `reso1`, `reso2`, `reso3` — or `preset` to use the tone's own. Overrides the waveform on **every** line, combination included. Not rampable. |
| `lines` | `"preset"` | `lines` | The LINE SELECT switch: `1`, `2`, `1+1` (line one doubled against itself), `1+2` (both) — or `preset`. Anything but `1` costs a second render pass per note. Not rampable. |
| `mod` | `"preset"` | `mod` | `none`, `ring` (the lines multiply instead of summing), `noise` (the second line's phase goes inharmonic) — or `preset`. Both need two lines to be audible, and no shipped tone uses either. Not rampable. |
| `octave` | `"preset"` | `octave` | The OCTAVE switch: `-1`, `0`, `1` — or `preset`. Not rampable. |

Every option **except `preset` itself** takes the sentinel `preset`, meaning
"whatever the tone says". That is what keeps the two layers from writing to
each other: choosing a new tone never silently clobbers an override, and an
override never has to be re-applied. Set one back to `preset` to give it back.

```
/add_track name=keys synth=czsynth preset=turquoise-hexagon-sun-epiano
/keys add_event beat=0 degree=0 duration=0.25
/keys                        # the preset, its waveform and both envelopes
/keys dcw=0 8b               # close it right down; every waveform is a sine
/keys dcw=1 8b               # and back
/keys dcw=2                  # past the hardware's own envelope
/keys wave=square            # override the waveform, preset untouched
/keys wave=preset            # give it back
/keys env_time=4 8b          # stretch every envelope; an epiano becomes a pad
/keys lines=1+2              # both lines, detuned as the tone specifies
/keys octave=-1
/keys preset=oirectine-epiano   # a combination wave, with a sub-octave
/keys preset=random
/keys random                 # re-roll all seven params at once
```

`/keys` prints the resolved preset and its album, the waveform, line select,
octave, detune, and both envelopes in the CZ's own `rate>level` units with `*`
marking the sustain step — so `DCW 67>0*` tells you at a glance that
`sixtyniner-sine-pad` really is just a sine.

See `/code-editor/cz-tapes` for a worked example: five `czsynth` tracks over a
dusty kit, with the effect routing taken from the notes that came with the
patches.

> **Three things behave unlike anything else in the engine**, all on purpose.
>
> `reso1`/`reso2`/`reso3` are **not phase distortion**. They are an inner sine
> hard-synced to the note and multiplied by a per-cycle window, so on those
> three `dcw` moves a *frequency*, not a brightness. Casio named them after
> the window shape ("resonant sawtooth/triangle/trapezoid"), which has
> confused people for forty years.
>
> A **combination** preset alternates two waveforms on successive periods
> rather than mixing them, so the shape repeats every two periods and a
> sub-octave appears under the note. `oirectine-epiano`,
> `kiteracer-shimmer` and `orange-hexagon-sun` are the three that do it.
>
> A note is mostly its **release**. Several of these tones attack instantly
> and then decay for seconds, so a short written `duration` is normal and the
> tail rings well past it — like `karplus`, and unlike most synths here.

> **The envelope rate-to-seconds curve is fitted, not documented.** Casio
> published the 0..99 rate scale but never what a rate means in time, and no
> teardown of the hardware has recovered it. The curve here was fitted against
> the shipped tones until they came out musically right for their names.
> `env_time` is the intended correction if a preset feels too fast or slow.

### Modulating a synth param

Most synth params (`percsampler`'s, `karplus`'s, `granular`'s, all of
`chaossynth`'s, all of `czsynth`'s, and six of `tapepad`'s) are **read in
JavaScript when a note is scheduled**. Every gesture reaches them —

| Gesture | |
|---|---|
| Instant set — `/pad density=60` | yes |
| Console ramp — `/pad position=0.9 16b` | yes |
| Deferred — `/pad window=expo at=cycle` | yes |
| Loop automation — `/pad automate=position to=0.9 duration=8` | yes |
| `/patch source=lfo1 dest=pad.position` | yes |
| `/save` / `/recall` | yes |

— but *when* they're read is the thing to design around. The value is sampled
**once per note**, at the moment that note is scheduled, not continuously. So
an LFO patched into `position` gives every grain cloud a different starting
point rather than sweeping a cloud already in flight, and an LFO cycling
faster than the notes arrive will alias into something arbitrary. Both are
useful; neither is a smooth sweep.

The same applies to `velocity`, `swing`, `probability` and `dropout` on an
event-generating modulator — patch an LFO into `dropout` and the pattern
thins and fills over the LFO's cycle, one event at a time.

For a granular track that evolves *within* a note, reach instead for a
non-zero `drift` (each held note walks its own playhead), or patch the LFO
into the track's `gain` or a send, which are continuous audio-graph params.

The exception is [`tapepad`](#tapepad--ribbittapepad), whose `wow`,
`wow_rate`, `flutter`, `hiss` and `sat` sit on always-running shared nodes
rather than being read per note — so those five belong in the *first* group,
alongside `gain` and every processor param, and a patch into them sweeps a
sustaining chord. Nothing in the command surface marks the difference; it's
listed per param in that section's tables.

`/save` records the param's own value, never the momentarily-modulated one —
a session file saved under a moving LFO reloads the way you set it up.

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

Nine processors, in two groups.

**Effects** — `reverb` and `delay` — add something *beside* your signal. The dry
path always runs at unity and the wet path is added on top, so `wet=0` means
"off" and `wet=1` means "as much again".

**Dynamics and tone** — `compressor`, `saturator`, `tilt`, `svf`, `comb`,
`limiter` and the
`goodenizer` that combines four of them — act *on* the signal itself. Where they
have a `mix` at all it's a true crossfade: `mix=1` is fully processed, `mix=0`
is fully bypassed, and `mix=0.5` is half of each. That difference is not
cosmetic. A compressor whose dry path ran at unity could never actually tame a
peak, because the untouched peak would sail straight through beside it.

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
| `stereoOffset` | `0.06`s | `stereoOffset` (option) | Extra delay time on the right channel for stereo width (`0..1`s). Runtime-settable option — not rampable, though `at=` works like anywhere else. |

`time` and `feedback` each drive both delay lines, and do so through ramps as
well as instant sets — `/delay time=0.75 8b` glides both channels together,
keeping the stereo offset intact the whole way.

### `compressor` — `RibbitCompressor`

> A dynamics compressor with makeup gain and a true dry/wet mix (turn mix down
> for parallel compression).

Turns down whatever is louder than `threshold`, so the whole thing can then be
turned up. `makeup` is the turning-up half — without it a compressor only ever
makes things quieter.

| Constructor option | Default | Runtime param | Meaning |
|---|---|---|---|
| `threshold` | `-18` | `threshold` | Level in dB above which reduction starts (`-100..0`). Lower means more of the signal gets compressed. |
| `ratio` | `4` | `ratio` | How hard it reduces past the threshold (`1..20`). `4` means 4dB in becomes 1dB out. |
| `attack` | `0.01`s | `attack` | How fast it clamps down (`0..1`). Short catches transients; long lets them through and squashes what follows. |
| `release` | `0.15`s | `release` | How fast it lets go (`0..1`). This is the one that decides whether compression sounds like glue or like pumping. |
| `knee` | `6` | `knee` | dB of softening around the threshold (`0..40`). `0` is an abrupt corner. |
| `makeup` | `1` | `makeup` | Output gain after compression (`0..8`, linear not dB). |
| `mix` | `1` | `mix` | Crossfade between untouched and compressed (`0..1`). |

Every one of these is a real param, so they ramp (`/compressor threshold=-40
4b`), automate, and can be `/patch` destinations. That last one is worth
knowing:

```
/master add_processor=compressor
/add_modulator type=lfo freq=0.5 name=pump
/patch source=pump dest=compressor.threshold depth=15
```

The threshold now moves in time, so the compressor breathes with the beat —
the sidechain-pumping trick, without needing a sidechain input.

Turning `mix` down gives **parallel compression**: a heavily squashed copy
blended under the untouched signal, which adds weight without flattening
dynamics. Set `threshold` very low and `ratio` high, then blend to taste.

A processor is named after its type (`add_processor=` takes no name), so this
one is addressed as `/compressor`; a second one on the same graph becomes
`/compressor_2`. On its own it reports live gain reduction, which is the only
way to see what it's actually doing:

```
compressor (p1): A dynamics compressor... [threshold=-38.000, ...] reducing -12.4 dB
```

### `saturator` — `RibbitSaturator`

> Waveshaping saturation: a drive stage into one of four transfer curves, from
> gentle tape warmth to a wavefolder.

Distortion, of the useful kind. `drive` pushes the signal into a fixed transfer
curve; `character` picks which curve.

| Constructor option | Default | Runtime param | Meaning |
|---|---|---|---|
| `drive` | `2` | `drive` | Pre-gain into the curve (`1..50`). This is the amount control — at `1` the stage is essentially clean. |
| `level` | `1` | `level` | Output trim (`0..2`). |
| `mix` | `1` | `mix` | Crossfade (`0..1`). Below `1` this is parallel distortion. |
| `character` | `soft` | `character` (option) | `soft`, `hard`, `fold` or `tape`. Rebuilds the curve — an option, not rampable, but schedulable like anything else (`character=fold at=cycle`). |
| `oversample` | `2x` | `oversample` (option) | `none`, `2x` or `4x`. Higher reduces aliasing at the cost of a little CPU. |

The four characters:

- **`soft`** — a `tanh` clipper. Peaks rounded off gradually. The safe one.
- **`hard`** — straight clipping with a sharp corner. Buzzy odd harmonics, no
  rounding. Below full scale it's the identity, so it's the most transparent of
  the four until `drive` actually pushes into it.
- **`fold`** — a wavefolder. Past its peak the curve turns around and comes back
  down, so a louder input gets a *different* shape rather than a flatter one.
  Inharmonic and metallic; nothing like the other three.
- **`tape`** — asymmetric soft clipping, adding even harmonics alongside the odd
  ones.

**`drive` is the amount; `character` is the flavour.** The curves are normalized
so that at `drive=1` the stage passes signal through very nearly untouched, and
everything you hear comes from raising `drive`. That's deliberate — it means the
stage is safe to leave in a chain that isn't asking for dirt.

```
/keys add_processor=saturator
/saturator drive=12 character=tape     tape warmth, pushed
/saturator drive=25 character=fold     metallic and inharmonic
/saturator mix=0.4                     parallel distortion
/saturator drive=1                     back to clean
```

Each character has its own output level at high drive — a wavefolder ends up
quieter than a clipper, which is true of real ones too. That's what `level` is
for.

### `tilt` — `RibbitTilt`

> A tilt EQ: one control trading low end against high end around a pivot
> frequency.

One knob. Negative is darker and fuller, positive is brighter and thinner, zero
is flat. A low shelf and a high shelf pivot around the same frequency, moving in
opposite directions.

| Constructor option | Default | Runtime param | Meaning |
|---|---|---|---|
| `tone` | `0` | `tone` | The tilt (`-1..1`). Each end swings up to ±12dB, which is fixed. |
| `pivot` | `800`Hz | `pivot` | Where the see-saw pivots (`100..8000`). Below it gets one direction, above it the other. |

There's no `mix` — an EQ blended with its own dry signal is just a weaker EQ,
and `tone=0` is already "no effect".

Most of what people mean by a mix sounding wrong is a broad tonal tilt rather
than anything narrow, which is why this is the one EQ shape worth having before
any other. Both params ramp, so it doubles as a sweep:

```
/master add_processor=tilt
/tilt tone=-0.7 8b        slowly pull everything dark
/tilt tone=0.5 4b         and back up bright
/tilt pivot=2500          move where the trade happens
```

### `svf` — `RibbitSVF`

> A state-variable filter: one cutoff and resonance read out as a lowpass,
> highpass, bandpass or notch.

The filter. `tilt` is the one you reach for when a mix sounds wrong; this is
the one you *play* — sweep it with an LFO, close it over eight bars, ring it at
high resonance.

| Constructor option | Default | Runtime param | Meaning |
|---|---|---|---|
| `cutoff` | `1000`Hz | `cutoff` | Where the filter acts (`20..18000`). |
| `resonance` | `1` | `resonance` | Emphasis at the cutoff (`0.1..30`). High values ring, and get **loud** — a resonant filter has real gain there. |
| `mix` | `1` | `mix` | Dry/wet crossfade (`0..1`). A true crossfade, so `mix=0.5` is parallel filtering — a notch at half mix is a gentle scoop rather than a hole. |
| `mode` | `lowpass` | `mode` (option) | Which response comes out: `lowpass`, `highpass`, `bandpass`, `notch`. Not rampable — but `at=` works, so `/filt mode=highpass at=cycle` switches on the downbeat. |

Both `cutoff` and `resonance` are ordinary rampable params and valid patch
destinations, which is the whole point:

```
/lead add_processor=svf
/svf cutoff=300 mode=lowpass
/svf cutoff=6000 8b                  open it over 8 beats
/add_modulator type=lfo name=sweep freq=0.2
/patch source=sweep dest=svf.cutoff depth=2000
```

### `comb` — `RibbitComb`

> A comb filter: the signal plus a very short delayed copy of itself,
> feedforward (notches, flanger-like) or feedback (peaks, a ringing resonator).

A delay so short you hear it as tone rather than as an echo. Summing a signal
with a copy of itself reinforces every frequency whose period divides the delay
and cancels the ones in between — a rake of peaks and notches at multiples of
1/`time`.

| Constructor option | Default | Runtime param | Meaning |
|---|---|---|---|
| `time` | `0.008`s | `time` | Delay length (`0.0002..0.05`s, i.e. 20Hz–5kHz as a comb frequency). Patch an LFO here and the feedforward mode is a flanger. |
| `feedback` | `0.7` | `feedback` | How much copy (`-0.95..0.95`). **Bipolar**: a negative value inverts the copy, putting every peak where a notch was — the hollow, half-an-octave-down version of the same setting. |
| `tone` | `8000`Hz | `tone` | A lowpass on the delayed copy (`200..18000`). In feedback mode it's inside the loop, so each repeat is darker than the last and the ring decays like a plucked string. |
| `mix` | `1` | `mix` | Dry/wet crossfade (`0..1`). |
| `mode` | `feedback` | `mode` (option) | `feedback` (the copy recirculates — peaks, and it rings with a pitch of its own) or `feedforward` (one copy — notches, the body of a flanger). |

```
/pad add_processor=comb
/comb mode=feedforward feedback=-0.8
/add_modulator type=lfo name=flange freq=0.15
/patch source=flange dest=comb.time depth=0.004
```

**In `mode=feedback`, `time` can't go below about 3ms** (a comb frequency of
~344Hz), and asking for less silently resonates at that floor instead. Web
Audio forces any feedback loop to at least one processing block, and that's how
long a block is. `/comb` says so:

```
/comb
comb (p1): ... [comb 2000Hz — but feedback can't go above the feedback floor 345Hz,
so it is resonating there; use mode=feedforward for higher]
```

`mode=feedforward` is in no loop and combs the whole range, so that's the mode
for anything above a few hundred Hz.

### `limiter` — `RibbitLimiter`

> A loudness ceiling: a boost stage into a fast, high-ratio compressor that
> holds the output near a set level.

`boost` drives the signal up, `ceiling` holds whatever comes out under a level.
That pairing is the point — a limiter on its own only makes things quieter, and
it's the boost underneath that turns "nothing clips" into "everything is loud
and even".

| Constructor option | Default | Runtime param | Meaning |
|---|---|---|---|
| `boost` | `1` | `boost` | Pre-gain into the limiter (`0..8`, linear). Raise this to get louder; the ceiling stops it running away. |
| `ceiling` | `-1` dB | `ceiling` | Where the output is held (`-40..0`). |
| `release` | `0.1`s | `release` | How fast it lets go (`0.01..1`). |

Ratio, knee and attack are fixed and not exposed — a limiter with those
adjustable is just a compressor, and `compressor` already exists.

**It is honestly a fast compressor, not a lookahead brickwall.** Web Audio
offers no lookahead, so a fast enough transient can still poke a little past
the ceiling. Treat `ceiling` as "about here" rather than a guarantee, which is
why it defaults to `-1` and not `0`. `/limiter` reports live reduction.

### `goodenizer` — `RibbitGoodenizer`

> The whole chain in one box: compressor into saturator into tilt EQ into
> limiter. Makes anything louder and more even; raise `drive=` for dirt.

Put it on master and stop thinking about it. It builds one of each of the four
processors above and chains them in that order:

```
compress → saturate → tilt → limit
```

The order is the argument it makes. Compression first, so the saturator gets a
level that barely moves — that's what keeps distortion character *consistent*
instead of lurching between clean and fried as the music gets busier, and it's
most of what "evenly mixed" actually means. Tilt after the saturator, because
saturation adds its own top end and you want to voice what came out. Limiter
last, always, since anything after it could undo it.

| Constructor option | Default | Runtime param | From |
|---|---|---|---|
| `threshold` | `-20` | `threshold` | compressor |
| `ratio` | `4` | `ratio` | compressor |
| `attack` | `0.01` | `attack` | compressor |
| `release` | `0.12` | `release` | compressor |
| `makeup` | `1.4` | `makeup` | compressor |
| `drive` | `1` | `drive` | saturator |
| `character` | `soft` | `character` (option) | saturator |
| `oversample` | `2x` | `oversample` (option) | saturator |
| `tone` | `0.15` | `tone` | tilt |
| `pivot` | `900` | `pivot` | tilt |
| `ceiling` | `-1` | `ceiling` | limiter |
| `mix` | `1` | `mix` | its own crossfade over the whole chain |

**`drive` defaults to `1`, meaning the saturation stage is present but clean.**
That's on purpose. Compression, tilt and limiting make a mix *more like itself*
— louder, steadier, better balanced. Saturation makes it into something else,
and something that alters timbre by default isn't something you want on every
session. It waits to be asked:

```
/master add_processor=goodenizer
/goodenizer                       live reduction from both its compressor and limiter
/goodenizer mix=0                 hear the mix with nothing on it
/goodenizer mix=1 2               fade the treatment back in over 2 seconds
/goodenizer drive=9               stop being polite
/goodenizer character=fold        and get strange
/goodenizer drive=1               back to clean
```

Some controls are deliberately *not* exposed here: the children's own `mix`, the
saturator's `level`, the limiter's `boost`. Each would be a second way to set
the same balance. Use the four processors individually when you want them.

It is a **composite, not a separate implementation** — `/goodenizer threshold=`
and a standalone `/compressor threshold=` are the same control on two different
compressors, running the same code. So anything true of the four above is true
here.

**When to use which:** reach for the four individually when you want one thing
(parallel compression on a drum bus, a wavefolder on a lead, a tilt to fix a
dull mix); reach for the `goodenizer` when you want the whole thing to sound
good and would rather not decide. Every session that ships with ribbit runs one
on master, named `glue`. The `goodenizer-demo` session tours all five.

## Modulators (`type=` on `/add_modulator`)

A modulator is a standalone control source — created and addressed like a
processor, but it never joins any channel's chain. On its own it does
nothing audible; it only matters once patched into a parameter with
`/patch` — see [commands.md](commands.md#modulators-and-patches).

There are eight, in three shapes. `lfo` and `cv` both produce a **continuous
signal** patched into a parameter (`lfo` moves by itself, `cv` holds
whatever you set); `randomnotes`, `markovpercs`, `euclidpercs`,
`patternvariator` and `chorale` instead generate **discrete notes** and patch
into a track's synth rather than a parameter. `randomgestures` is the odd one
out: it is patched **nowhere at all**, and instead roams the session by itself,
gliding parameters wherever you point it.

The five generators differ in *what decides whether a note happens*:

| Generator | Decides from | Repeats? |
|---|---|---|
| `randomnotes` | a fresh dice roll at each slot | never — no two bars alike |
| `markovpercs` | the previous step (a Markov chain) | yes, one fixed pattern until reseeded |
| `euclidpercs` | the step's own index (euclidean distribution) | yes, exactly — it can hold a downbeat |
| `patternvariator` | **a file you wrote**, plus seeded variation | yes, one fixed take until reseeded |
| `chorale` | a voice's held note having elapsed | yes, exactly — nothing random is involved at all |

Three distinctions matter here. First, `markovpercs` has no notion of where in
the bar it is, so it produces convincing *texture* but can't place a kick on
every beat; `euclidpercs` decides each step from its position, so it can.
They're designed to be used together — a euclidean backbone with a Markov layer
adding ghost notes around it.

Second, `patternvariator` is the only one whose material is **authored rather
than derived**. The others invent a pattern from a rule; this one plays
something you wrote in a file and varies it. Reach for it when you know what
you want to hear, and for the others when you want to be surprised.

Third, `chorale` is the only one that isn't making a *rhythm* at all. The
other four place short hits on a grid; this one holds long overlapping notes
and moves them through chords, so it's the one to reach for when you want
harmony rather than events.

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
| `value` | `0` | `value` | The held output level. Rampable and deferrable (`value=1 4b`, `value=0 at=cycle`) and a valid `automate=` target like any other param. Deliberately **unbounded** — real control voltage has no fixed range, and a patch's own `depth` is what scales it for a given destination. Being unbounded is also why it's one of the three params `random` can't draw for without explicit bounds (`/cv1 value=random min=-1 max=1`) — see [commands.md](commands.md#randomizing). |

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
— most naturally [`karplus`](#karplus--ribbitkarplus),
[`granular`](#granular--ribbitgranular), [`tapepad`](#tapepad--ribbittapepad)
or [`czsynth`](#czsynth--ribbitczsynth), the four that play chords. A `notes`
pattern also works on [`chaossynth`](#chaossynth--ribbitchaossynth), where its
pitches select states rather than pitches — an authored figure played as a
sequence of timbres.

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

Four example sessions ship with the reference app: `pattern-drums` (two
variators over a split kit, one of them phasing), `pattern-chords` (chords and
a melody on two `karplus` tracks), `granular-pad` (three variators over
the `ambientchords` pack, driving granular clouds), and `ambient-tape` (the
same pack again, driving three `tapepad` layers over a dusty beat).

### `chorale` — `RibbitChorale`

Sustained, overlapping harmony: several long-held voices moving through a
chord progression in a mode. The other four generators place short hits on a
grid; this one holds notes for longer than it takes to play the next, so the
texture never gaps. Drives any polyphonic synth — `tapepad`, `karplus`,
`granular`, `czsynth`, or `chaossynth` (where its chord tones select states, so the
progression becomes a slowly-turning set of timbres).

It is the only generator with **no rhythm and nothing random in it**. Every
note is a pure function of the absolute beat, so the same bar comes out on
every pass and after any `/stop` `/start`, and there is no `seed` to re-roll.
It's a bed to put other things on, not a pattern that develops.

Two clocks run underneath, and keeping them independent is the whole point:

- the **chord clock** (`chord_beats`) advances the progression one entry;
- the **voice clock** (`note_beats`) re-attacks each voice.

Nothing lines them up. A voice that attacked before a chord change holds its
old note across it, which is where the suspensions come from. Make
`note_beats` divide `chord_beats` evenly to turn that off.

Voice leading is **positional, not remembered**. Each voice has a fixed
register anchor spread across `spread` octaves, and always takes chord tone
`voice number % chord_size`, placed in whichever octave is nearest its anchor.
So the chord is always fully voiced, and when it changes each voice moves the
smallest interval that keeps it in its own register — which is what makes this
sound like harmony rather than arpeggios.

| Param | Range | Meaning |
|---|---|---|
| `velocity` | `0..1` | Peak gain per note, with a gentle rolloff towards the top voice. |
| `note_beats` | `0.25..64` | How often each voice re-attacks. |
| `overlap` | `0..2` | How much longer a note holds than its own period. This is what makes the pad continuous rather than gapped; at `0` each note ends exactly as the next begins. |
| `spread` | `0..4` | Octaves between the lowest and highest voice. |
| `stagger` | `0..1` | `1` spreads the voices' entries evenly across one period (a continuous wash); `0` attacks them together (block chords). |

| Option | Meaning |
|---|---|
| `mode` | `ionian`, `dorian`, `phrygian`, `lydian`, `mixolydian`, `aeolian`, `locrian`, `harmonicminor`, `pentatonic`, `wholetone`. |
| `progression` | Comma-separated mode steps, one per chord — `0,5,3,4` is i–VI–IV–V. |
| `chord_size` | Tones per chord: `3` a triad, `4` a seventh, `5` a ninth. |
| `stack` | Mode steps between chord tones: `2` tertian (ordinary chords), `3` quartal, `4` open fifths, `1` clusters. |
| `chord_beats` | How long each chord lasts. |
| `transpose` | Degrees added to every note — how a second instance becomes an octave-up layer. |
| `voices` | How many voices sing. More than `chord_size` wraps back to the root. |

`/<name>` prints the whole progression as actually voiced, which is the thing
worth seeing — the mode and the progression steps only say how the chords were
*derived*.

```
/add_track name=pad synth=tapepad
/add_modulator type=chorale name=bed mode=aeolian progression=0,5,3,4
/patch source=bed dest=pad.notes
/bed                           # aeolian | 0: 0,3,19,22 | 5: -4,12,15,19 | ...
/bed spread=3 16b              # fan the voices apart over an octave and a half
/bed stagger=0 8b              # collapse the wash into block chords
/bed overlap=1.4 8b            # notes hold nearly twice their period
/bed mode=lydian               # same progression, brighter
/bed stack=4                   # open fifths instead of thirds
/bed progression=0,3,5,1       # rewrite the changes
/bed chord_beats=32 at=cycle   # half as much harmonic motion
```

A param is read when a voice *attacks*, not continuously, so a ramp or a patch
on `spread` or `note_beats` arrives voice by voice as each one re-enters — the
pad revoices itself over a cycle rather than sliding. `chord_beats` is an
**option** for the opposite reason: the current chord is found by dividing the
absolute beat by it, so ramping it would renumber every chord boundary
underneath the music rather than slowing the progression down. Set it, with
`at=cycle` if you want it on a boundary.

Two things worth knowing. `mode` degrees are semitones only while the harmony
context keeps its default chromatic scale (see [Events](#events)); set a
non-chromatic `/harmony scale=` and they resolve as steps of *that* scale.
And more `voices` than `chord_size` wraps back to the root, which is an octave
doubling when `spread` is wide enough to separate them and a wasted unison
when it isn't — six voices want `spread=3`, four are happy at `1`.

The `chorale-drift` example session runs three of them at once: close sevenths
on a `tapepad`, ninths an octave up, and a one-voice bass line, with the first
patched into two tracks so a pad and a `karplus` sing the identical voicing.

### `randomgestures` — `RibbitRandomGestures`

> Roams the live session and glides random parameters to new values — a
> seeded, self-playing hand on the controls.

**This one takes no patch.** Create it and it starts working:

```
/add_modulator type=randomgestures name=drift
/drift gesture_beats=8 glide=6 depth=0.2
/start
```

Every `gesture_beats` beats it picks one parameter somewhere in the session and
ramps it, over `glide` beats, to a new value near where it currently sits.
Because `glide` can be longer than `gesture_beats`, several parameters can be
moving at once — which is the difference between this sounding like a player
and like a randomizer.

| Constructor option | Default | Runtime param | Meaning |
|---|---|---|---|
| `gesture_beats` | `4` | `gesture_beats` | Beats between gestures (`0.25..64`). |
| `glide` | `2` | `glide` | How long one gesture takes, in beats (`0..64`). |
| `depth` | `0.3` | `depth` | How far a gesture may move a param, as a fraction of that param's own range, either side of where it is (`0..1`). A bounded random *walk*, not unrelated jumps: at `0.05` it breathes, at `1` any gesture can land anywhere. |
| `probability` | `1` | `probability` | Chance a due gesture actually fires (`0..1`). Below 1 the gestures stop being metronomic without changing the interval. |
| `seed` | random | `seed` (option) | The whole sequence follows from this. `seed=random` re-rolls; `/stop` `/start` replays the same take from the top. |
| `scope` | `all` | `scope` (option) | Which kinds of object are in play: `all`, `tracks`, `buses`, `processors`, `modulators`, `master`. |
| `targets` | `""` | `targets` (option) | A comma-separated list of object names, overriding `scope`. **A group name expands to its members**, which is the tidy way to aim it. |
| `params` | `""` | `params` (option) | A comma-separated list of param *names*: `params=cutoff` sweeps filters and nothing else. Empty means every eligible param. |

**What it's allowed to touch is the same set the bulk `random` command
touches** — any param with a declared range whose `.r` flag is on (see
[Which params a bulk `random` touches](commands.md#which-params-a-bulk-random-touches)).
So faders are out of bounds by default, and `/lead cutoff.r=false` protects one
param from both at once. There's no second opt-out list to learn.

Aim it with a group, and check what's in range before you start:

```
/add_group name=pads members=pad1,pad2
/drift targets=pads
/drift
drift: ... [24 params in range · 9 gestures · last: pad1.cutoff 812.400 -> 2140.118 over 2b]
```

`0 params in range` means it will do nothing at all — usually a `params=` name
that nothing in `targets=` actually has.

One caveat about reproducibility: the seed fixes the sequence of *choices*, but
each choice is made among whatever exists at that moment, so adding a track
mid-take renumbers everything after it. Same session, same seed, same
performance.

## Groups (`/add_group`)

A group is a name standing for several other names — say it once, and every
member gets it:

```
/add_group name=drums members=kick,snare,hats
/drums gain=0 4b at=cycle
```

It holds no audio and changes nothing about the signal path (that's what a
[bus](#buses-add_bus) is for) — it only saves you typing the same command at
four objects. Members can be tracks, buses, `master`, processors, modulators,
or other groups. Full reference: [commands.md](commands.md#groups).

## Mute and solo

Every channel — track, bus, or master — has `mute`/`unmute`, and everything
except master has `solo`/`unsolo`:

```
/kick mute            silence it; the fader doesn't move
/kick unmute
/lead solo            hear only lead (and anything it feeds, or that feeds it)
/lead unsolo
```

`mute` is not "turn the fader down". The fader keeps its position and its saved
value, a `gain` ramp already in flight keeps running underneath, and unmuting
puts you back exactly where you were. It silences the channel's **sends** too,
so a muted track feeds a reverb bus nothing.

`solo` is a property of the whole session rather than of one channel. Anything
that can reach a soloed channel through sends, or be reached from one, stays
audible — so soloing a track keeps its reverb bus working, and soloing that bus
keeps the tracks feeding it playing. Several channels can be soloed at once.
Master refuses `solo` (everything already goes through it).

Both are deferrable (`/kick mute at=cycle`), both show in `/tracks` as
`kick [muted]` / `[solo]` / `[silenced by solo]`, both round-trip in a session
file, and both are the M/S buttons on each mixer strip.

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

It's also the one param in the engine that ships **excluded** from the bulk
`random` command (`/lead random` leaves it alone, though `/lead gain=random`
still works). A drawn fader position isn't a new sound, it's a track that
disappeared, and on a whole-object roll that reads as the command having
broken the mix. `/lead gain.r=true` opts it back in — see
[commands.md](commands.md#randomizing).
