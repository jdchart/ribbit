# Tutorial

Ribbit is a live-coding engine: you drive it with slash-commands (through its
built-in command router) that create and control tracks (synths/samplers),
processors (effects), and the master output, all playing in a loop against a
shared clock — like a very small, text-driven Ableton/Max-MSP.

## Running it

The commands below are exactly what `createCommandRouter(engine)` accepts, so any
host app with a text console will do. The reference host app in this workspace is
**nllc** — see its [docs](../../../nllc/docs/) to start it (`npm run dev`) and open
its console. It ships two sessions built on the same console+mixer page:

- **Blank session** — starts from nothing but the master channel. This is where the
  rest of this tutorial happens.
- **Demo session** — the same page, but it auto-loads a saved session on open: a
  couple of tracks, a reverb bus, an LFO patched into it, and a couple of saved
  states to `/recall` between. Open this one first if you just want to hear
  something immediately, or as a worked example to read once you've been through
  this tutorial — `/tracks`, `/buses`, `/modulators`, `/patches`, and `/states` all
  show you what it's made of.

(Output-device/latency options, the mixer pane, and the demo routes are the host
app's concern — the nllc docs cover them. Everything below is pure engine.)

## Your first sounds

Open `/code-editor`. It starts genuinely empty — no tracks, nothing playing — and the
engine itself is off. Create a track and give it something to play:

```
/add_track name=lead
/lead add_event beat=0 pitch=60
/lead add_event beat=2 pitch=64
```

`add_track` with no `synth=` defaults to `oscsynth` (a simple oscillator voice). A
fresh track's synth always starts with **no events** — silent until you author a
pattern onto it with `add_event`, which is what the two lines above just did (see
[Authoring events](#authoring-events) below for the full field list). Now start the
engine:

```
/start
```

You should hear `lead` loop. The mixer's master strip (far right) will show the
power light pulsing on each loop and a level meter.

Now add a drum track:

```
/add_track name=drums synth=sampler
```

This creates a second track using the sample-based synth instead of the default
oscillator — every track loops independently against the same clock. Like `lead`
above, `drums` starts silent until you author a pattern onto it (next section).

## Authoring events

Every track's synth has an event list you build up with `add_event`. For a
`sampler`, `pitch` selects a slot (0 = first sample, wrapping if out of range):

```
/drums add_event beat=0 pitch=0 velocity=0.9 duration=0.25
/drums add_event beat=1 pitch=2 velocity=0.8 duration=0.25
/drums add_event beat=2 pitch=0 velocity=0.9 duration=0.25
/drums add_event beat=3 pitch=2 velocity=0.8 duration=0.25
```

That's a basic four-on-the-floor kick/snare pattern (`pitch=0`/`pitch=2` are the
first two sample slots — see [objects.md](objects.md) for the full slot list).
Every field but `beat` is optional. For `oscsynth`, use `pitch=<midi note>` for a
raw pitch, or `degree=<n>` to use a scale-degree resolved against the shared
harmony context instead (see [objects.md](objects.md#events)):

```
/track_1 add_event beat=0 degree=0 velocity=0.6 duration=0.5
/track_1 add_event beat=2 degree=4 velocity=0.6 duration=0.5
```

Clear a track's pattern entirely with `/drums clear_events`.

## Tempo and loop length

The whole pattern loops over a fixed number of beats at a given tempo — both
adjustable at runtime with `/clock`:

```
/clock
```
```
bpm=120 num_beats=4
```

```
/clock bpm=140
/clock num_beats=8
```

Changing `num_beats` while the engine is running can shift where the loop
boundary currently falls — an accepted live-coding glitch, not a bug.

## Controlling tracks

Every track (and the master channel) is addressable by name. With no parameters, a
channel command just prints its current status:

```
/track_1
```
```
track_1 — gain=0.80 pan=0.00 inserts=[p1:reverb] synth=oscsynth("A basic subtractive synth voice...")
```

Set gain (0–1) and pan (-1 to 1):

```
/drums gain=0.6
/drums pan=-0.3
```

Pause and resume a single track without touching anything else (its events just stop
being scheduled — already-sounding notes finish naturally):

```
/drums stop
/drums start
```

List every track at once:

```
/tracks
```

Every track/bus/master/processor/modulator also answers `help` for the full
command and param reference, not just the one-line summary above — see
[Getting help](commands.md#getting-help).

## The console

Beyond just running whatever you type, the console (the left-hand pane)
gives you three shortcuts:

- **Suggestions**: as you type, a greyed-out completion appears right after
  your cursor — press `→` to accept it into the input (without running
  anything yet), or just press `Enter` to accept *and* run it in one step:

  ```
  > /trac█k_1              type "/trac", see "k_1" suggested in grey
  > /track_1 █              press → to accept — cursor lands right after, ready to keep typing
  > /track_1 ga█in=         type "ga", see "in=" suggested
  > /add_modulator type=r█andomnotes   values complete too, once you've typed at least one character
  ```

  This works anywhere in the line, not just at the end — accepting a
  suggestion in the middle can push already-typed text after it over, rather
  than only ever appending at the end. Three things get suggested: the
  `/name` token itself (any addressable object or top-level command); once
  you're past the name, a bare param key (`gain=`, `wet=`, `remove_self`,
  `help`, ...); or, once you've typed at least one character of a key's
  value, the value itself, but only for keys with a small known set of
  choices (`synth=`, `type=`, `at=`, `add_processor=`, an existing
  track/bus/processor/modulator name for `out=`/`add_send=`/`source=`/
  `dest=`, an existing state/patch/send id, ...) — an open-ended value (a
  number, a name you're inventing) is left alone. Typing a key's `=` with
  **nothing** after it yet shows no suggestion on purpose — narrow it to at
  least one character first, so pressing Enter right after `type=` doesn't
  silently accept whichever candidate happens to be listed first. If nothing
  matches what you've typed, no suggestion appears; keep typing and it'll
  pick up again as soon as something does.
- **History**: press `↑`/`↓` to recall previously submitted commands, like a
  shell. If you'd started typing something new when you press `↑`, that
  in-progress text is preserved — pressing `↓` back past your oldest recalled
  command returns you to it rather than losing it. `↑`/`↓` only recall
  history when the input is empty (or you're already mid-recall) — with
  something freshly typed in the box, they're reserved for suggestions
  instead (see above) and don't do anything on their own yet.
- **Click-to-paste**: clicking a track/bus/master/processor/modulator's name
  anywhere in the mixer (or a param label, e.g. "gain"/"pan" under a
  fader/pan dial, or a modulator's own param readout) inserts it at the
  console's current cursor position, ready to build a command around — click
  `track_1`, then click `gain`, and the console reads `track_1 gain=`, cursor
  right after the `=`.

## Ramps

Add a trailing duration to `gain=`/`pan=` (or any processor param, see
[Effects](#effects) below) to ramp instead of jumping instantly:

```
/drums gain=0 3        fade drums out over 3 seconds
/drums gain=0.6 4b      fade back in over 4 beats ("b" = beats, no suffix = seconds)
```

By default a ramp starts the instant you hit Enter. Add `at=beat` or `at=cycle`
to line it up with the next beat or the next loop boundary instead — handy for
keeping changes musically in time rather than landing mid-phrase:

```
/drums gain=0 4b at=cycle
```

You can also fire several commands from one line, all together:

```
/track_1 gain=0 8 /drums gain=0 8
```

## Options, loop automation, and harmony

Three more live controls, all of them console-first:

**Options** are runtime settings without an AudioParam behind them — set
them like a param, they just can't ramp. A track routes its synth's options
through its own name:

```
/lead waveform=square        the oscillator shape, from the next note on
/lfo1 waveform=triangle      an LFO reshapes in place
/rand1 scale=0,3,5,7,10      a randomnotes generator repicks from a new scale
/reverb duration=4           regenerates the reverb's impulse response
```

See [commands.md](commands.md#params-vs-options) and each type's table in
[objects.md](objects.md).

**Loop automation** attaches a ramp to a *position in the loop*, replayed
every pass — where `gain=0 3` fires once from "now", `automate=` is part of
the pattern:

```
/drums automate=gain from=0.8 to=0.3 beat=2 duration=2
/reverb automate=wet to=0.9 beat=0 duration=4 curve=exponential
/drums automations               list them (with indices)
/drums remove_automation=0       remove one
```

It's captured by `/save`/`/recall` and session files like everything else —
see [commands.md](commands.md#loop-automation).

**Harmony**: every event authored with `degree=` (and every `randomnotes`
stream) resolves against one shared key/scale *at the moment the note
fires*, so changing it retunes everything already playing, live:

```
/harmony                          root=60 scale=0,1,2,...
/harmony root=57 scale=0,2,3,5,7,8,10    A natural minor, mid-loop
```

Events you authored with a raw `pitch=` are unaffected — only `degree=`
listens to the harmony context. Similarly, `/lead events` lists a pattern
with indices and `remove_event=<n>` deletes a single note, so you can edit
a pattern without `clear_events`-ing the whole thing.

## Effects

Attach a processor to a track's insert chain:

```
/drums add_processor=delay
```

The router assigns it a default name (`delay`) and an id (e.g. `p2`), which is
addressable on its own:

```
/delay wet=0.5
/delay feedback=0.45
```

Run a processor with no arguments to see a one-line summary, or with `help`
for the full reference — every param (with its current value/range) and every
command it accepts:

```
/delay help
```
```
delay (p2): A stereo delay: independent left/right delay lines with cross-feedback (ping-pong) and a small time offset between channels for width.

params:
  time=0.375 (range 0..5)
  feedback=0.350 (range 0..0.95)
  wet=0.300 (range 0..2)

commands:
  <param>=<val>                    set instantly; add a trailing duration to ramp, e.g. wet=0.5 3 (3s) or wet=0.5 4b (4 beats)
  at=beat|cycle                    defer a set/ramp above to the next beat/loop boundary instead of firing now
  remove_self                      remove and delete this object
  ...
```

(A param that never declared bounds — e.g. a patch's `depth`, deliberately
unbounded so a negative value can invert the modulation — shows no
`(range ...)` suffix — see [objects.md](objects.md) and
[Getting help](commands.md#getting-help).)

Bypass it without removing it by clicking its name in the mixer's insert list (each
track strip shows its inserts as small buttons — click to toggle bypass, shown with
strikethrough when off), or remove it entirely:

```
/drums remove_processor=p2
```

## Buses and sends

Every track (and master) has at least one **send** — where its signal
actually goes, `master` by default. A **bus** is an empty channel (no synth)
that exists purely to be a shared send destination — useful once you want
more than one track running through the same reverb/delay, without repeating
that processor per track:

```
/add_bus name=fx1
/fx1 add_processor=reverb
/track_1 add_send=fx1 send_gain=0.3
/drums add_send=fx1 send_gain=0.15
```

`track_1` and `drums` still play dry through their original send to master
*and* now also feed `fx1` at their own levels — `fx1`'s own reverb reaches
the output through its own (default) send to master. Adjust or remove a send
by the id shown when it was created:

```
/track_1 send=s2 send_gain=0.5 3
/track_1 remove_send=s2
```

Or replace every send at once with `out=`, if you just want a track to feed
somewhere else entirely instead of adding another destination:

```
/track_1 out=fx1
```

See [commands.md](commands.md#buses-and-sends) for the full reference.

## Modulators and patching

So far every parameter change has been you typing a value or a ramp. A
**modulator** is a standalone control source that wobbles a parameter
continuously and automatically — the modular-synthesis piece of Ribbit. Create
one, then **patch** it into whatever you want it to affect:

```
/add_modulator type=lfo freq=2 name=lfo1
/patch source=lfo1 dest=reverb.wet depth=0.2
```

`lfo1` is now continuously wobbling `reverb`'s `wet` mix at 2Hz, by up to
±0.2 around whatever value it's already at (including any ramp you set on it
separately — the modulator adds on top, it doesn't fight your other
changes). `depth` controls how strongly it pushes that particular
destination; patch the same modulator somewhere else at a different depth
and it'll drive both at once:

```
/patch source=lfo1 dest=track_1.gain depth=0.1
```

Every patch gets a short id (`x1`, `x2`, ...), listed with `/patches`. Adjust
a patch's depth later, or remove it, without touching the modulator itself:

```
/patch id=x1 depth=0.5 2
/unpatch id=x1
```

A modulator's own params are rampable exactly like a processor's — `/lfo1
freq=8 3` glides its rate from 2Hz to 8Hz over 3 seconds. See
[commands.md](commands.md#modulators-and-patches) for the full reference, and
[objects.md](objects.md#modulators) for available modulator types.

## Algorithmic notes: event-generating modulators

`lfo` wobbles a *parameter*. A `randomnotes` modulator instead generates
*notes*, algorithmically, and feeds them into a track's synth — the
modular-synth "control voltage triggering notes" idea, applied to this app's
event system. Patch one into a track's reserved `.notes` destination instead
of a `name.param`:

```
/add_track name=lead
/add_modulator type=randomnotes name=rand1 probability=0.7 min_gap=0.5 scale=0,2,4,5,7,9,11
/patch source=rand1 dest=lead.notes
/start
```

`lead` now plays a wandering, probability-thinned stream of notes picked from
that scale — forever, not looping identically every cycle, since generation
tracks absolute time rather than a fixed pattern. Crucially, this runs
**alongside** anything you `add_event`'d onto `lead` by hand — generated and
authored notes both fire from the same synth, and `clear_events` only ever
touches the authored ones. Tune it live like any other param:

```
/rand1 probability=0.3 4       thin it out over 4 seconds
/rand1 min_gap=0.25 4b         and speed up the candidate grid over 4 beats
```

`/unpatch id=<id>` (or `/rand1 remove_self`) stops it. See
[commands.md](commands.md#event-generating-modulators-patching-notes-into-a-synth)
and [objects.md](objects.md#modulators) for the full reference.

## The mixer

At the top, the **Transport** bar has the engine on/off button, a pulsing
clock LED with the current beat/bpm readout — the LED blinks each beat, and
the thin ring around it sweeps once per loop, so both "where in the beat"
and "where in the cycle" read at a glance — and two buttons on the
right — **Save JSON**/**Load JSON** — that run the exact same
`/save_json`/`/load_json` commands you could type yourself (see
[Saving and loading](#saving-and-loading) below), just one click instead.

Below that, **Tracks**, **Buses**, and **Master** sit side by side in one
row — Tracks grows to fill the available width and scrolls its own strips
internally once there are enough to overflow, so a long track list can never
push Master out of view; Master always stays visible at a fixed size (it's
neither collapsible nor resizable — you'd never want to lose sight of it).
Tracks and Buses can each be collapsed (an arrow in their vertical label) or
dragged narrower/wider by a handle at their right edge — a collapsed section
keeps its label visible (rotated), so it still reads as "this is what's
hidden," not just a bare arrow. **Modulators** is its own full-width row
below that (collapsible, not resizable — a section that's already full-width
has nowhere for a resize handle to sensibly go), one tile per modulator (e.g.
`lfo1`, `rand1`) with a live meter and its params. **Patches**, at the very
bottom, lists every active patch cable with its live depth (or, for an
event-generating modulator's patch into a synth, "generated notes" in place
of a depth — see [Algorithmic notes](#algorithmic-notes-event-generating-modulators))
and a remove button.

Each track/bus strip mirrors and controls the same state the console does: a
vertical fader (gain, with a level meter next to it), a rotary pan dial
(click-drag vertically), and the insert-chain buttons below that (click to
toggle bypass — active inserts render in the accent color, bypassed ones dim
and struck-through; shift+click instead pastes that insert's id into the
console — see [The console](#the-console)). A track strip also shows its
synth's type (e.g. `oscsynth`) under its name, itself click-to-paste for
`synth=`. Dragging any of these updates the audio graph directly — the
console and mixer are just two views onto the same `Ribbit` instance, so a
`/track_1 gain=0.4` and dragging that track's fader do the same thing. If a
patch is currently modulating a strip's gain or pan, a small pulsing dot
appears next to that label (the fader/dial itself still only ever shows the
*base* value — a live-modulated `AudioParam` can't report its own
momentary value back through a plain read). Below the inserts, each strip
lists its **sends** (`→master 1.00`, `→fx1 0.30`, live gain included) —
click one and the console gets `send=s2 send_gain=` teed up, ready for a
value; adjusting routing itself stays a console action. Every strip's own
name, "gain"/"pan" labels, a modulator's name, and each of its param
readouts are also click-to-paste. A modulator tile and a patch row are
otherwise read-only in the mixer (control values from the console); their
live values still update in real time as you type commands. An
event-generating modulator's tile (e.g. `rand1`) swaps the bipolar meter —
which would read a flat 0, since it has no continuous output — for a dot
that lights up each time a generated note actually fires.

Toggle the whole mixer pane with the collapse arrow between the console and
mixer (it shrinks to a thin rail showing just the master power button, clock
LED, and level meter) — useful for maximizing the console when you're just
typing.

## Saving and loading

Two related but different things: **states** are named snapshots you flip
between while working, kept in memory; **session files** are the whole thing
written to (and read back from) an actual `.json` file on disk.

Capture where things stand right now under a name:

```
/save name=verse1
```

(A bare leading value is shorthand for `name=` — `/save verse1` works too,
and the same goes for `/recall` below.)

Change some things — mute the drums, bring a bus in, whatever — then jump
back:

```
/recall name=verse1
```

`/recall` doesn't hard-cut back to the saved state — it glides: anything that
changed ramps toward the saved value, anything that needs to be created fades
in, anything that needs to disappear fades out first. Give it a duration (the
same trailing-duration syntax as [Ramps](#ramps)) to control how long that
takes:

```
/recall name=verse1 4b at=cycle
```

That recalls `verse1` over 4 beats, starting at the top of the next loop —
handy for switching between a couple of saved arrangements of the same
tracks as a live "scene" tool, rather than a jarring jump. `/states` lists
every saved name; `/remove_state name=verse1` deletes one.

States only live in memory — reloading the page loses them, same as
everything else. `/save_session` writes the *entire* session (every track,
bus, processor, modulator, patch, and every state you've `/save`d) to a
downloaded `.json` file:

```
/save_session
```

`/load_session` opens a file picker and rebuilds the session from a chosen
file — unlike `/recall`, this is a hard reset: everything currently live is
torn down first, since loading an entirely different session from disk isn't
something you'd want to hear glide into place. This is also how
`/code-editor/demo` works under the hood, just automatic instead of picked by
hand — see [Running it](#running-it) above. The mixer's Transport bar has
Save JSON/Load JSON buttons that run these same two commands (`/save_json`/
`/load_json`, plain aliases for `/save_session`/`/load_session`) — see
[The mixer](#the-mixer).

See [commands.md](commands.md#session-and-states) for the full reference.

## Cleaning up

```
/track_1 remove_self
/fx1 remove_self
/lfo1 remove_self
/stop
```

`remove_self` works on tracks, buses, processors, and modulators (not
master) — removing any of them also removes any patch or send elsewhere that
was touching it, so there's nothing left to separately clean up with
`/unpatch`/`remove_send=` unless you're removing a specific one on its own.
`/stop` suspends the whole audio engine; `/start` resumes it.

## Audio options

The homepage (`/`) has a small panel for two things that only take effect
when a session page next starts its audio engine (changing them doesn't
affect a session already open in another tab):

- **Output device** — which speakers/interface the engine renders to.
  Browser device labels are hidden until you click "Show device names" (this
  briefly requests microphone permission, purely as the standard browser
  workaround for revealing output device names — nothing is recorded).
  Requires `AudioContext.setSinkId` support; not every browser has it yet,
  in which case the selector is disabled.
- **Latency** — "interactive" (the default) favors the lowest latency at
  the cost of more CPU; "playback" accepts higher latency for the fewest
  glitches; "balanced" sits in between. This is a Web Audio setting fixed at engine
  startup, so it can't be changed after a session page has already opened.

Both choices are remembered (in the browser, on this device) and applied the
next time you open `/code-editor` or `/code-editor/demo`.

See [commands.md](commands.md) for the full command reference and
[objects.md](objects.md) for every synth/processor/modulator type and its
parameters.
