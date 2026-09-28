# Command reference

## Syntax

```
/name [key=value ...]
```

- `name` is either a top-level command, or the name of an existing track, the
  master channel, a bus, a processor, a modulator, or a group.
- A bare `key` with no `=` is a boolean flag: `/reverb help` sets `params.help = true`.
  Every track, bus, master, processor, and modulator understands `help` this
  way — see [Getting help](#getting-help) below.
- Values are parsed automatically: `0.5` / `-2` → number, `true`/`false` → boolean,
  anything else → string. Quote a value to include spaces or force it to be a
  string: `name="lead synth"`.
- Whitespace around `=` is optional — `gain=0.5`, `gain = 0.5`, and `gain =0.5` all
  parse the same.
- A value can be followed by a bare duration to turn a set into a ramp, e.g.
  `gain=0.5 3` (over 3 seconds) or `gain=0.5 4b` (over 4 beats) — see
  [Ramps](#ramps) below.
- The literal value `random` on any param draws one value from its range
  instead of naming a number: `/lead cutoff=random`. See
  [Randomizing](#randomizing).
- A key may carry one dotted suffix naming an *attribute* of a param rather
  than the param itself. Only `.r` exists: `/lead cutoff.r=false` excludes
  `cutoff` from the bulk `random` command (see [Randomizing](#randomizing)).
- `at=beat` or `at=cycle` anywhere in a command defers it to the next beat or
  loop boundary. This works on *every* command that changes something, not
  only ramps — see [Scheduling with `at=`](#scheduling-with-at).
- Several commands can be typed on one line and run together, e.g.
  `/track_1 gain=0 8 /reverb wet=0.9 6b` — the line is split on each `/name`
  that starts a word, and every segment runs in the same call, so they
  schedule off the same instant. A `/` inside a value doesn't split
  (`sample=foley/rain.wav`), and a quoted value can hold spaces too:
  `/pad sample="foley/Hlessi - Texture 12.wav"`.
- Every command must start with `/`; anything else is rejected without side effects.
- A `key=` with nothing after it is an error (`missing value for "gain="`),
  not an empty value — `Number("")` would otherwise silently coerce to `0`,
  turning a slip of the Enter key into a muted track. An explicitly-quoted
  empty string (`name=""`) still parses as one.
- Errors (unknown command, bad syntax, unknown param, a value that isn't
  actually a valid number, etc.) are returned as a plain string in the
  console log rather than thrown — nothing crashes the session, and a bad
  value is rejected outright rather than silently corrupting state (e.g.
  `/clock bpm=notanumber` reports an error and leaves `bpm` untouched, rather
  than setting it to `NaN`).

## Getting help

Every track, bus, master, processor, modulator, and group responds to three
"introspect, don't change anything" forms:

| Form | Shows |
|---|---|
| `/name` (no params) | A one-line summary: current param values, and (for a channel) its inserts/sends/synth. |
| `/name help` | The full reference: every param with its current value and range, plus every command that object accepts, each with a short usage note. |
| `/tracks`, `/buses`, `/modulators`, `/groups` | The one-line summary for every object of that kind, one per line. |

```
/track_1
track_1 — gain=0.80 pan=0.00 inserts=[p1:reverb] sends=[s1:master(1.00)] synth=oscsynth("...")

/track_1 help
track_1 — gain=0.80 pan=0.00 inserts=[p1:reverb] sends=[s1:master(1.00)] synth=oscsynth("...")

params:
  gain=0.800 (range 0..1)  [no random: .r=false]
  pan=0.000 (range -1..1)

commands:
  gain=<val> / pan=<val>           set instantly; add a trailing duration to ramp, e.g. gain=0 3 (3s) or gain=0 4b (4 beats)
  <param>=random [min= max=]       draw one value in the param's range (or between min= and max=); ramps and defers like any other value, e.g. cutoff=random 4b at=cycle
  random [=<duration>]             draw a new value for EVERY param above that isn't marked [no random] — this channel's and its synth's; random=4b glides there instead of jumping
  <param>.r=true|false             include/exclude one param from that bulk random (saved with the session)
  at=beat|cycle                    defer ANY command on this line — a set, a ramp, or a discrete change like start/stop/synth=/an option — to the next beat/loop boundary instead of firing now
  synth=<type>                     swap this track's synth (oscsynth, sampler, percsampler, karplus, granular, tapepad, chaossynth, czsynth)
  mute / unmute                    silence this channel (and its sends) without moving the fader; mute=false also unmutes
  solo / unsolo                    hear only the soloed channels — anything sending into one, or fed by one, stays audible too
  add_event beat= pitch=|degree= velocity= duration=   append a note event (all optional except beat)
  ...
```

A param whose range was never declared (e.g. a patch's `depth`, which is
deliberately unbounded — a negative depth inverts the modulation) shows just
its current value, with no `(range ...)` suffix. A trailing `[no random: ...]`
marks a param the bulk `random` command skips, and says which of the two
reasons applies — see [Randomizing](#randomizing). `help` works identically on master, any bus, any
processor, and any modulator — the exact command list shown differs by kind
(see the [Channel](#channel-commands-master-or-any-trackbus-by-name),
[Processor](#processor-commands-any-processor-by-nameid-derived-name-eg-reverb-delay),
and [Modulator](#modulator-commands-any-modulator-by-name-eg-lfo1) sections
below).

## Top-level commands

| Command | Effect |
|---|---|
| `/start` | Resumes the `AudioContext` and starts the clock. |
| `/stop` | Suspends the `AudioContext` and stops the clock. `/stop at=cycle` lets the current loop finish first. |
| `/add_track [name=] [synth=] [out=] [...synth options]` | Creates a track. `name` defaults to `"track"` (de-duplicated as `track_2`, `track_3`, ... if taken by *any* existing object or reserved command name — see [Names](#names); pass `name=` explicitly for a nicer name). `synth` selects the synth type (default `oscsynth`; see [objects.md](objects.md)). `out` sets where its one default send feeds (default `master`; see [Buses and sends](#buses-and-sends)). Any other params are passed straight to the synth's constructor (e.g. `synth=oscsynth waveform=square`). A fresh track's synth starts with **no events** — see `add_event` below. **Refuses `at=`** — see [The one exception](#the-one-exception-creating-things). |
| `/tracks` | Lists every track's summary line (same format as running a track command with no params). |
| `/add_bus [name=] [out=]` | Creates a bus — an empty channel (fader/pan/inserts/sends, no synth) that exists purely to be a shared send destination for other tracks/buses (see [Buses and sends](#buses-and-sends)). `name` defaults to `"bus"` (de-duplicated, like tracks). `out` sets where its one default send feeds (default `master`). **Refuses `at=`** — see [The one exception](#the-one-exception-creating-things). |
| `/buses` | Lists every bus's summary line. |
| `/clock [bpm=] [num_beats=]` | With no params, reports the current `bpm=... num_beats=...`. `bpm=<n>` changes tempo (glitch-free while running — the current playback position is preserved); it also accepts a trailing ramp duration (`/clock bpm=140 8`, ramps tempo smoothly over 8 seconds) and `at=beat`/`at=cycle` to defer the start — see [Ramps](#ramps). `num_beats=<n>` changes the loop length in beats (defaults to 4) and is **not** rampable (a shifting loop length has no sensible meaning — a ramp spec there is rejected with a message), though it still accepts `at=` like anything else. Both are runtime-mutable at any time. |
| `/harmony [root=] [scale=]` | With no params, reports the shared harmony context (`root=60 scale=0,1,2,...`). `root=<midi note>` moves the key's root; `scale=<comma-separated degrees>` (e.g. `scale=0,2,4,5,7,9,11` for major) changes which semitone offsets the scale contains. Because every event's `degree=` (and every `randomnotes` stream) resolves against this context **at trigger time**, a change retunes already-playing patterns live, mid-loop — see [objects.md](objects.md#events). Neither is rampable, but both take `at=beat`/`at=cycle` — `/harmony root=64 at=cycle` is the usual way to change key, landing it on the downbeat. |
| `/add_modulator [type=] [name=] [...modulator options]` | Creates a modulator — a continuous control source you can patch into any parameter (see [Modulators and patches](#modulators-and-patches) below). `type` defaults to `lfo`. Any other params are passed to the modulator's constructor (e.g. `type=lfo freq=2 name=lfo1`). **Refuses `at=`** — see [The one exception](#the-one-exception-creating-things). |
| `/modulators` | Lists every modulator's summary line (same format as running a modulator command with no params/`help`). |
| `/patch source=<name> dest=<name.param> [depth=]` | Creates a patch — see [Modulators and patches](#modulators-and-patches). |
| `/patch id=<id> [depth=]` | Adjusts an existing patch's depth (rampable, `at=` deferrable). With no `depth=`, reports the patch's summary. |
| `/unpatch id=<id>` | Removes a patch. Takes `at=` (`/unpatch id=x1 at=cycle`). |
| `/patches` | Lists every active patch, e.g. `x1: lfo1 -> reverb.wet (depth 0.20)` — or, for an event-generating modulator's patch into a synth, `x2: rand1 -> lead.notes (generated notes)` (see [Event-generating modulators](#event-generating-modulators-patching-notes-into-a-synth)). |
| `/add_group [name=] [members=a,b,c]` | Creates a group — a name that stands for several other names, so one command can drive all of them (see [Groups](#groups)). `members` is a comma-separated list (no spaces) of tracks, buses, `master`, processors, modulators, or other groups; every name must already exist. **Refuses `at=`** — see [The one exception](#the-one-exception-creating-things). |
| `/groups` | Lists every group and its members, e.g. `drums — 3 members: kick, snare, hats`. |
| `/save name=<state>` (or `/save <state>`) | Captures everything live (clock, harmony, master/buses/tracks and their inserts/sends and mute/solo state, modulators, patches, groups) under `<state>`, held in memory — see [Session and states](#session-and-states). A bare leading value is shorthand for `name=`: `/save 1` and `/save name=1` are equivalent (works for non-numeric names too, e.g. `/save verse1`). |
| `/recall name=<state> [<duration>] [at=beat\|cycle]` (or `/recall <state> ...`) | Reconciles the live session toward a saved state — matching objects ramp in place, appearing/disappearing ones fade in/out, rather than a hard cut. A trailing duration on `name=` ramps the whole change over that long, e.g. `name=verse1 3` (3s) or `name=verse1 4b` (4 beats) — same convention as any other ramp (see [Ramps](#ramps)); with none, every change still happens (deferred to `at=` if given), just as an instant jump. Same bare-leading-value shorthand as `/save`: `/recall 1 4b at=cycle` is `/recall name=1 4b at=cycle`. |
| `/remove_state name=<state>` | Deletes a saved state. |
| `/states` | Lists every saved state's name. |
| `/save_session` (alias: `/save_json`) | Downloads the whole live session, including every saved state, as a `.json` file. The mixer's Transport bar has a "Save JSON" button that runs this same command (see [The mixer](../user/tutorial.md#the-mixer)). |
| `/load_session` (alias: `/load_json`) | Opens a file picker and hard-rebuilds the session (tearing down everything live first) from the chosen `.json` file. The Transport bar's "Load JSON" button runs this same command. |
| `/record [mode=] [bits=] [max_minutes=]` | Starts recording the session's audio output. Takes `at=beat`/`at=cycle`, which is the point — `/record at=cycle` starts the take on the downbeat. Any settings given are applied first (same keys as `/recording` below). See [Recording](#recording). |
| `/stop_record` | Stops recording. Takes `at=` too, so `/record at=cycle` … `/stop_record at=cycle` captures a whole number of cycles. |
| `/save_record` | Encodes the take and downloads it — one `.wav` in `stereo` mode, a `.zip` of one `.wav` per channel in `multitrack`. |
| `/clear_record` | Discards the take and frees the memory it was holding. |
| `/recording [mode=] [bits=] [max_minutes=]` | With no params, reports the recorder's state (`idle`, or the take's length/channel count/memory). `mode=stereo\|multitrack` picks what gets tapped, `bits=32\|16` the WAV sample format, `max_minutes=<n>` the safety stop. `/record help` prints the whole reference. |

## Channel commands (`/master`, or any track/bus by name)

Run with no parameters to get a one-line summary, or with `help` for the full
reference (every command below, with its own usage note — see
[Getting help](#getting-help)):

```
track_1 — gain=0.80 pan=0.00 inserts=[p1:reverb] sends=[s1:master(1.00)] synth=oscsynth("...") (stopped)
```

`(stopped)` only appears if the track's synth has been paused via `stop`. A
bus has the same shape, minus the trailing `synth=...` (it has none). A
bracketed state after the name — `track_1 [muted]`, `[solo]`, or
`[silenced by solo]` — appears when one applies; the last of those is the
answer to "why is this track quiet when its fader is up".

| Param | Effect |
|---|---|
| `gain=<0..1>` | Sets the channel's fader position (clamped, exponentially tapered onto actual output level for perceptually-even steps — see [objects.md](objects.md#gain-taper)). Rampable and `at=` deferrable — see [Ramps](#ramps). Can also be a patch destination (`track_1.gain`, `bus1.gain`). |
| `pan=<-1..1>` | Sets stereo pan (clamped). Also rampable/deferrable/patchable, same as `gain=`. |
| `<param>=random [min=] [max=]` | Draws one value for that param instead of naming a number — works on `gain`, `pan`, and any of the track's synth params. Rampable and `at=` deferrable like any other value. `min=`/`max=` narrow the range for every `=random` on that line; either alone falls back to the param's own declared bound. See [Randomizing](#randomizing). |
| `random [=<duration>]` | Draws a new value for **every** param on this channel *and* its synth that isn't excluded — see [Randomizing](#randomizing). A duration ramps them all instead of jumping: `/lead random=4b`. |
| `<param>.r=true\|false` | Includes/excludes one param from the bulk `random` above. Saved with the session. `gain` ships excluded; everything else ships included. |
| `add_event [beat=] [pitch=\|degree=] [velocity=] [duration=]` | Appends one event to the track's synth. All fields optional (defaults: `beat=0`, `pitch=60` if neither `pitch=` nor `degree=` given, `velocity=1`, `duration=0.25`). `pitch=` is a raw MIDI note (or, for `sampler`/`percsampler`, a slot index); `degree=` is a scale-degree resolved against the shared harmony context *at trigger time* instead — see [objects.md](objects.md#events). A `beat` at or past the current loop length is accepted (it starts sounding if `num_beats` is later raised past it) but flagged with a warning, since it won't fire until then. Not valid on master or a bus (neither has a synth). |
| `events` | Lists the track's synth's events, one per line with an index: `0: beat=0 pitch=60 velocity=1 duration=0.25`. The index is the handle `remove_event=` takes. Not valid on master or a bus. |
| `remove_event=<n>` | Removes one event by its `events` index. Out-of-range indices are rejected with a pointer back to `events`. Not valid on master or a bus. |
| `clear_events` | Empties the track's synth's event list. Not valid on master or a bus. |
| `set_events=<b:p:d:v,…>` | Replaces the whole pattern in one line: `beat:pitch[:duration[:velocity]]`, comma-separated; pitch `d<n>` is a scale degree. `events` prints the current pattern in this form too. A `pianoroll` modulator takes this and the four above. |
| `automate=<param> to=<val> [from=] [beat=] [duration=] [curve=] [once]` | Adds **loop-position automation** on `gain` or `pan` — a ramp anchored to a beat *within the loop*, replayed every pass (unlike a one-off console ramp like `gain=0 3`, which fires once from "now"). `beat` (default 0) and `duration` (default 1) are in beats; `from` defaults to the param's current value; `curve` is `linear` (default), `exponential`, or `target`; the bare flag `once` makes it fire a single time ever instead of every loop. See [Loop automation](#loop-automation) below. |
| `automations` | Lists this channel's automation events with indices (the handle `remove_automation=` takes). |
| `remove_automation=<n>` / `clear_automation` | Removes one automation event by index / removes them all. |
| `mute` / `unmute` | Silences (or restores) this channel without touching the fader — the position stays where it is, an in-flight `gain` ramp keeps running underneath, and unmuting returns exactly where you were. It also takes the channel's **sends** with it, so a muted track feeds a reverb bus nothing. `mute=false` is the same as `unmute`. Deferrable: `/kick mute at=cycle`. Valid on master and buses too. |
| `solo` / `unsolo` | Hears only the soloed channels. Anything that can *reach* a soloed channel through sends, or be reached from one, stays audible too — so soloing a track keeps its reverb bus working, and soloing that bus keeps the tracks feeding it playing. Several channels can be soloed at once. `solo=false` is `unsolo`. Refused on master (everything already goes through it). |
| `start` | Resumes the track's own synth (its events/automation resume being scheduled). Not valid on master or a bus. |
| `stop` | Pauses the track's own synth without touching routing or other tracks. Not valid on master or a bus. |
| `synth=<type>` | Swaps the track's synth to a new instance of `<type>` (see [objects.md](objects.md)), discarding the old one's state (including its events — re-`add_event` afterward). Not valid on master or a bus (neither has a synth). Only the type is passed through this command — extra constructor options currently require creating the track fresh via `/add_track`. |
| `add_processor=<type>` | Creates a new processor of `<type>` and appends it to this channel's insert chain. Returns its assigned name and id, e.g. `added reverb (p1)`. Types: `reverb`, `delay`, `compressor`, `saturator`, `tilt`, `svf`, `comb`, `limiter`, `goodenizer` (see [objects.md](objects.md)). The processor is named after its type — a second one of the same type becomes e.g. `compressor_2` — and `add_processor=` takes no name of its own. |
| `remove_processor=<id>` | Removes the processor with that id from this channel's chain (and destroys it, along with any patch touching it). |
| `bypass=<id>` / `enable=<id>` | Routes the chain around that insert without removing it (its params and automation are kept), or puts it back. The mixer's insert buttons and lilypad's insert headers do the same. |
| `out=<name>` | Replaces **every** current send with a single one to `<name>` (a track, bus, or `master`), at gain 1 — see [Buses and sends](#buses-and-sends). Not available on master: its one send to the actual speakers has no addressable name, so nothing typed at the console could ever wire it back (`remove_send=` refuses that same send for the same reason — `add_send=` on master stays allowed). |
| `add_send=<name> [send_gain=<0-1>]` | Adds one more send to `<name>` without disturbing existing ones (`send_gain` defaults to `1`). Returns the new send's id, e.g. `added send s2 -> bus1 (gain 0.40)`. |
| `remove_send=<id>` | Removes one send by id, leaving the others untouched. |
| `send=<id> [send_gain=<value>]` | With no `send_gain=`, reports that send's current destination/gain. With `send_gain=`, sets it (rampable/`at=` deferrable, like any param). |
| `remove_self` | Removes the track/bus entirely (and all of its inserts and sends, and any patch or send elsewhere pointing at it). Not valid on master. |

A track's synth's own params and options are addressable straight off the
track — the synth isn't a named object of its own, so its channel is where
its surface lives: `/lead waveform=square` switches the oscillator shape
from the next note on (see [objects.md](objects.md) for each synth type's
options, and [Params vs. options](#params-vs-options) below for how an
option differs from a param). `/lead help` lists them under
"synth params/options".

Multiple params can be combined in one command: `/track_1 gain=0.5 pan=-0.2`.
A key that's neither a channel param, a synth param/option, nor one of the
commands above is reported as `unknown param "..."` rather than silently
ignored — a typo (`gian=0.5`) errors instead of printing the summary as if
nothing was asked.

## Processor commands (any processor by name/id-derived name, e.g. `/reverb`, `/delay`)

Run with no parameters for a one-line summary, or with `help` for the full
reference (every param plus every command, see
[Getting help](#getting-help)):

```
/reverb
reverb (p1): A simple algorithmic reverb: convolution against a generated impulse response, added on top of the dry signal. [wet=0.300]
```

| Param | Effect |
|---|---|
| `<param name>=<value>` | Sets that processor's parameter (see [objects.md](objects.md) for each type's params). Unknown param names are reported per-key without aborting the rest of the command. Also rampable/deferrable/patchable — see [Ramps](#ramps) and [Modulators and patches](#modulators-and-patches). |
| `<option name>=<value>` | Sets one of the processor's **options** — non-rampable settings with no AudioParam behind them, e.g. `/reverb duration=4` regenerates the impulse response in place. See [Params vs. options](#params-vs-options). |
| `<param>=random [min=] [max=]` / `random [=<duration>]` / `<param>.r=true\|false` | Draw one param, draw them all, or change which are included — identical to the channel versions, see [Randomizing](#randomizing). |
| `automate=<param> to= [from= beat= duration= curve= once]` | Loop-position automation on any of its params, plus `automations`/`remove_automation=<n>`/`clear_automation` — identical to the channel version, see [Loop automation](#loop-automation). |
| `remove_self` | Removes this processor from whatever channel it's inserted into (and any patch touching it). |

## Modulator commands (any modulator by name, e.g. `/lfo1`)

Work exactly like processor commands — no parameters for a one-line summary,
`help` for the full reference; set any param (rampable, deferrable,
patchable, randomizable, same as a processor) or option (`/lfo1 waveform=square`,
`/rand1 scale=0,3,5,7,10` — see [Params vs. options](#params-vs-options));
`automate=`/`automations`/`remove_automation=`/`clear_automation` work the
same as on a processor; `remove_self` removes it (and any patch
touching it, whether it's the patch's source or — if you've patched
something *into* the modulator, e.g. FM-modulating an LFO's own `freq` — its
destination).

```
/lfo1
lfo1: A low-frequency oscillator: a continuous bipolar (-1..1) control signal at a given rate, for patching into any parameter. [freq=2.000]
```

See [objects.md](objects.md#modulators-type-on-add_modulator) for available modulator types and their params.

## Buses and sends

Every track (and master) always has at least one **send** — where its
post-fader signal actually goes. By default a fresh track's one send feeds
`master`, exactly as before. A **bus** is an empty channel (fader, pan,
inserts — no synth) that exists purely to be a send *destination*: a shared
reverb send, a drum sub-mix, anything you'd route more than one track into
before it reaches master.

```
/add_bus name=fx1
/track_1 add_send=fx1 send_gain=0.3
/drums add_send=fx1 send_gain=0.15
```

Now both `track_1` and `drums` still feed `master` (their original default
send, untouched) *and* feed `fx1` at their own independent levels — `fx1`
itself still feeds `master` too (its own default send), so anything on it
(e.g. a reverb) reaches the output once, mixed in with everything else.

If you want a channel to feed exactly one place instead of adding sends one
at a time, `out=` replaces all of them in one step:

```
/track_1 out=fx1     track_1 now feeds fx1 alone — its old send to master is gone
```

Adjust or remove an existing send by its id (shown when it's created, or via
a channel's own summary):

```
/track_1 send=s2 send_gain=0.5 3   ramp that send's own gain to 0.5 over 3 seconds
/track_1 remove_send=s2
```

A bus is otherwise a normal channel — it can hold processors
(`/fx1 add_processor=reverb`), be a patch destination (`bus1.gain`), and be
removed (`remove_self`), which also cleans up every other channel's send
that was feeding into it, the same way removing a patch's endpoint does.

## Groups

A **group** is a name that stands for several other names. Everything you
type at it is run against each member, exactly as if you had typed it at each
of them in turn:

```
/add_group name=drums members=kick,snare,hats
/drums gain=0.4              set all three faders
/drums gain=0 4b at=cycle    fade all three out together, on the next loop boundary
/drums mute                  drop the whole kit
/drums random                roll every member's params
```

Members can be tracks, buses, `master`, processors, modulators, or other
groups (`/add_group name=all members=drums,pads`) — anything addressable.
`members=` takes a comma-separated list with **no spaces**, and every name has
to exist already.

A group is **not** a bus. A bus sums audio: routing four tracks into one gives
you one fader, one insert chain, one pan, and changes what you hear. A group
changes nothing about the signal path — it just addresses several things at
once, and each keeps its own everything. The two work together: a group of the
four drum tracks that already send to a drum bus is the normal arrangement.

| Command | Effect |
|---|---|
| `members=a,b,c` | Replaces the membership. |
| `add_member=<name>` / `remove_member=<name>` | Adds or drops one member. |
| `remove_self` | Deletes the group. **Its members are untouched** — to delete those, address them individually. |
| `help` | The group's own reference, plus its current membership. |

Everything else on the line is forwarded, `at=` included, so all the members
land on the same boundary. A key a given member doesn't understand is reported
by that member (`/drums cutoff=800` on a kit where only one track's synth has
a `cutoff` sets that one and reports `unknown param` for the rest) — which
makes a mixed group perfectly usable, just noisier.

Members are stored as **names**, looked up fresh each time. So a group written
before its members exist is fine, a member that gets torn down and rebuilt by
`/recall` rejoins automatically, and one that's gone for good shows as
`kick(missing)` in the listing rather than quietly vanishing.

## Modulators and patches

A **modulator** is a standalone control source — created and addressed just
like a processor, but it never sits in any channel's signal chain. Eight
types ship: `lfo` (a low-frequency oscillator, the default), `cv` (a held
value you set/ramp yourself), five that generate notes rather than a
signal — `randomnotes`, `markovpercs`, `euclidpercs`, `patternvariator` and
`chorale` (see
[below](#event-generating-modulators-patching-notes-into-a-synth)) — and
`randomgestures`, which is patched **nowhere**: it roams the session on its
own and glides random parameters (see [objects.md](objects.md)).
Full reference: [objects.md](objects.md#modulators-type-on-add_modulator).
A modulator only matters once you **patch** it somewhere:

```
/add_modulator type=lfo freq=2 name=lfo1
/patch source=lfo1 dest=reverb.wet depth=0.2
```

This wobbles `reverb`'s `wet` parameter up and down at 2Hz, by up to ±0.2
around whatever its current value already is (including any ramp/pattern
automation already applied to it — the modulator adds on top, it doesn't
override). `depth` (default `1`) is how far the modulator's own `-1..1`
signal is scaled before reaching the destination — it lives on the *patch*,
not the modulator, so the same modulator can drive several destinations at
different amounts:

```
/patch source=lfo1 dest=track_1.gain depth=0.1
```

A destination is always `name.param` — `name` is any track, any bus, `master`,
any processor, or any modulator; `param` is one of that object's own params
(`gain`/`pan` for a channel, whatever `params` keys a processor/modulator
exposes, e.g. `wet`, `freq`).

> **A patch reaches every param, but not at the same moment.** For a param the
> audio graph itself consumes — channel `gain`/`pan`, every processor param,
> `lfo`'s `freq`, `cv`'s `value`, a patch's own `depth` — the modulation is
> continuous and sample-accurate. For a param read when a **note is
> scheduled** — every **synth** param (`granular`'s `position`,
> `percsampler`'s `pan_spread`, `karplus`'s `brightness`) and `velocity`/
> `swing`/`probability`/`dropout` on an event-generating modulator — the value
> is sampled once per note, at the moment the note is scheduled. So an LFO
> into `position` moves each new grain cloud rather than sweeping one that's
> already playing, and an LFO faster than the notes it modulates will alias.
>
> A synth can have some of each. `tapepad`'s `wow`, `wow_rate`, `flutter`,
> `hiss` and `sat` sit on always-running shared nodes, so they're in the first
> group — patched or ramped, they move *during* a held chord — while its
> `cutoff`, `detune`, `sub` and the rest are in the second. Nothing in the
> command surface tells them apart; the difference is only when you hear it.

A source can be a modulator, but also any
object with an output signal — a track, bus, or master's post-fader level, or
a processor's post-effect signal — letting one track's level modulate another
parameter (a basic sidechain).

Every patch gets a compact id (`x1`, `x2`, ...) shown when it's created and
in `/patches`. Adjust its depth later, or remove it:

```
/patch id=x1 depth=0.5 2      ramp the depth to 0.5 over 2 seconds
/unpatch id=x1
```

Removing the modulator or either endpoint (a track, processor, or the whole
channel) automatically removes any patch that depended on it — a patch never
outlives what it was connected to.

### Event-generating modulators: patching notes into a synth

A modulator that **generates discrete notes** (`randomnotes`, `markovpercs`,
`euclidpercs`, `patternvariator` and `chorale` — see
[objects.md](objects.md#modulators-type-on-add_modulator))
instead of a continuous signal can be patched straight into a track's control
input, alongside — not instead of — anything you `add_event`'d by hand:

```
/add_track name=lead
/add_modulator type=randomnotes name=rand1 probability=0.7 min_gap=0.5 scale=0,2,4,5,7,9,11
/patch source=rand1 dest=lead.notes
```

Note `depth` is meaningless on a `.notes` patch and is omitted. Several
generators can feed one track, and one generator can feed several — a
`chorale` patched into two tracks plays both the identical voicing:

```
/add_track name=pad synth=tapepad
/add_track name=glass synth=karplus
/add_modulator type=chorale name=bed mode=aeolian progression=0,5,3,4
/patch source=bed dest=pad.notes
/patch source=bed dest=glass.notes
```

`lead` now plays whatever `rand1` generates, on top of any events already on
its own pattern. The destination is the reserved param name `.notes` (a
track's synth, not a numeric param) rather than the usual `name.param` —
`/patch` recognizes it automatically, so no separate command is needed. Only
an event-generating modulator can be the source of a `.notes` patch, and only
a track (something with a synth) can be the destination — patching into
master or a bus is rejected with a clear error, since neither has anywhere to
put a note. There's no `depth=` for this kind of patch (`/patches` shows
`generated notes` in its place) — the modulator's own params already shape
what it generates. Patching the same modulator into the same track's
`.notes` twice is rejected (unlike two parallel `RibbitPatch` cables into one
param, which sum meaningfully, a duplicate here would only double-fire every
generated note). `/unpatch id=<id>` removes it like any other patch; the
target track's own `add_event`/`clear_events` pattern is completely
unaffected either way.

## Session and states

The whole live session — clock/harmony, master/every bus/every track (each
with its own gain/pan/mute/solo/inserts/sends/loop-automation), every
modulator, every patch, and every group — can be captured, restored, saved to
a file, and loaded back.
A track's synth round-trips too: its type, params, options (waveform, ...),
and events all come back, and `/recall` swaps the synth back if you changed
its type after saving.

**States** are named snapshots kept in memory for the rest of the session
(they don't survive a page reload on their own — see `/save_session` below
for that):

```
/save name=verse1
... change some things ...
/save name=chorus1
/recall name=verse1 4b at=cycle    glide back to verse1 over 4 beats, starting at the next loop
```

`/recall` doesn't tear the session down and rebuild it — it diffs the live
session against the saved one and reconciles the difference: a track/bus/
modulator/patch/processor present in both ramps its params toward the saved
values (or jumps instantly if no duration is given); one only in the saved
state is created and fades in (its gain/depth ramping up from 0); one only
live fades out (ramping to 0) and is removed once that fade completes,
instead of cutting off mid-note. This makes `/recall` safe to use as a live
"snapshot scene" tool — e.g. bouncing between a few saved arrangements of the
same tracks with a bar-aligned crossfade (`4b at=cycle`), rather than a
destructive reload.

`/save_session` and `/load_session` work with actual files (see
[Top-level commands](#top-level-commands) above) — a session file is a plain
`.json` containing the same snapshot shape as a `/save`d state, plus every
state currently saved, so loading one back also restores what you could
`/recall`. Unlike `/recall`, `/load_session` is a hard reset: everything live
is torn down first and rebuilt fresh from the file, since loading a whole
session is a cold-start operation, not something you'd want to hear glide
into place.

## Recording

A session file describes how to *make* the sound; a recording is the sound
itself. `/record` captures the engine's audio output to a WAV you can drop
into a DAW or send to someone.

```
/record at=cycle              start on the next downbeat
/recording                    recording 12.4s across 1 channel (2.1MB) mode=stereo bits=32 max_minutes=5
/stop_record at=cycle         stop on a boundary, so the take is whole cycles
/save_record                  saved ribbit-2026-08-07_15-42-03.wav (12.5s, 4.3MB)
```

**Two modes.** `mode=stereo` (the default) taps master only and downloads one
`.wav` — what you heard. `mode=multitrack` taps *every track, every bus, and
master* as its own stereo file, all downloaded together in one `.zip`
(`01-kick.wav`, `02-hats.wav`, …, numbered so they sort into mixer order):

```
/recording mode=multitrack
/record
/stop_record
/save_record                  saved ribbit-2026-08-07_15-42-04.zip — 4 files, 24.0s (5.6MB)
```

The mode can't be changed mid-take — the layout decides how many files the
take has, so `/stop_record` first.

**Two settings beyond the mode.** `bits=32` (the default) writes 32-bit float
WAV: lossless, and unbothered by a master that runs past 0dBFS, which a live
session regularly does. `bits=16` writes ordinary PCM — half the size and
playable by anything, at the cost of hard-clipping anything over full scale.
`max_minutes=<n>` (default 5) is a safety stop: a take is raw audio held in
memory, and a forgotten recording will eat the tab. `/recording` reports how
much it is currently holding for that reason, and hitting the limit stops the
recording rather than the browser.

Four things worth knowing:

- **Taps are post-fader, post-pan, post-mute.** A channel records exactly what
  it is contributing to the mix, so a muted or soloed-out track records
  silence. That's the honest answer, not a bug — it contributed silence.
- **The channel list is fixed when recording starts.** A track added halfway
  through a multitrack take isn't in it.
- **Nothing is captured while the engine is stopped.** A suspended
  `AudioContext` renders no audio at all, so `/stop` mid-take doesn't leave a
  gap of silence in the file — it leaves nothing, and the take's two halves
  are butt-joined. `/recording` says so while the engine is stopped.
- **A take is not part of the session.** `/save_session` doesn't carry it and
  `/load_session` doesn't clear it — save the two separately.

`/record help` prints all of the above as a reference. The mixer's Transport
bar has the same controls as buttons (see
[The mixer](tutorial.md#the-mixer)).

## Ramps

Give `gain=`, `pan=`, any processor param, any modulator param, a send's
`send_gain=`, `/clock bpm=`, or a patch's `depth=` a trailing duration to ramp
to the value over time instead of setting it instantly:

```
/track_1 gain=0 3        ramp gain to 0 over 3 seconds
/track_1 gain=0.8 4b     ramp gain to 0.8 over 4 beats (b = beats, no suffix = seconds)
/reverb wet=0.9 6b       ramps work on any processor param the same way
/lfo1 freq=10 3          ...and any modulator param
/clock bpm=140 8         ...and tempo itself
```

Ramping is about *how a value travels* between two numbers. When it should
*start* is a separate control — see [Scheduling with `at=`](#scheduling-with-at),
which applies to far more than ramps.

## Randomizing

Any param accepts the literal value `random` in place of a number. It draws
one value uniformly from the param's declared range, and is otherwise an
ordinary value — so it ramps and defers like any other:

```
/lead cutoff=random              cutoff=7833.291
/lead cutoff=random 4b           glides to a drawn value over 4 beats
/lead cutoff=random at=cycle     drawn now, applied at the top of the next loop
/reverb wet=random               works on any processor or modulator param too
```

`min=`/`max=` narrow the draw. They apply to every `=random` on that line
(two params wanting different ranges are two lines), and either one alone
falls back to the param's own bound:

```
/lead cutoff=random min=200 max=2000    somewhere in the low-mids
/lead cutoff=random max=800             anywhere from the param's floor up to 800
```

The bare flag `random` draws a new value for **every** param on the object at
once. On a track that means the channel's params *and* its synth's:

```
/lead random           wow=97.199; flutter=64.025; cutoff=8476.183; ... ; pan=-0.061
/lead random=4b        the same roll, but glided over 4 beats instead of jumped
/lead random at=cycle  rolled now, landing on the downbeat
```

### Which params a bulk `random` touches

Every param carries an `r` flag, on by default, that decides whether the bulk
command includes it:

```
/lead cutoff.r=false   leave cutoff alone from now on
/lead cutoff.r=true    put it back
/master gain.r=true    opt master's fader in (it ships out — see below)
```

`/name help` marks anything the bulk command will skip:

- `[no random: .r=false]` — you turned it off. `gain` on every channel ships
  this way: a random fader isn't a new sound, it's a track that vanished.
  Everything else ships on.
- `[no random: unbounded]` — the param has no full range to draw from, so
  there's nothing to pick between. Only three params are like this: a patch's
  `depth`, a `cv` modulator's `value`, and a send's `send_gain`. Naming one
  explicitly still works, it just needs bounds: `/patch id=x1 depth=random
  min=0 max=1`. Without them you get
  `depth has no declared range — give min= and max= to randomize it`.

The `r` flags are saved with the session and restored by `/save`/`/recall`
and by loading a session file.

Two things worth knowing before leaning on this:

- **The draw is uniform over the declared range, which is a clamp, not a
  taste.** `lfo1 freq` is bounded `0..20000` because that's what the
  oscillator accepts, so `/lfo1 random` will almost never give you something
  that reads as an LFO. Wide ranges (`cutoff` at `40..16000`) skew bright for
  the same reason. `min=`/`max=` is the answer; the draw is deliberately not
  secretly logarithmic for some params and linear for others.
- **Options are not included.** `random` only touches params. A synth's
  `waveform`, a pattern's `seed`, a sampler's kit are discrete settings, and
  the ones worth re-rolling already have their own form: `seed=random`,
  `samples=random`, `pattern=random` (see
  [Params vs. options](#params-vs-options)).

## Scheduling with `at=`

A command takes effect the moment you hit Enter. Add `at=beat` or `at=cycle`
to make it land on the next beat boundary or the top of the next loop instead:

```
/track_1 gain=0 3 at=beat    ramp starts on the next beat, not immediately
/reverb wet=0.9 6b at=cycle  ramp starts at the top of the next loop
/track_1 gain=0.9 at=beat    plain jump to 0.9, exactly on the next beat
```

**`at=` works on every command that changes something** — not just ramps, and
not just params. Whether a value can be *ramped* and whether it can be
*scheduled* are separate questions, and only the first one depends on there
being an `AudioParam` behind it:

```
/rhy seed=20 at=cycle              reseed a rhythm generator on the downbeat
/lead waveform=square at=beat      swap the oscillator on the beat
/harmony root=64 at=cycle          change key at the top of the next loop
/hats stop at=cycle                drop a part at the end of the bar
/drums synth=sampler at=cycle      swap a synth
/track_1 add_processor=reverb at=cycle
/patch source=rhy dest=hats.notes at=cycle    bring a generator in on the bar
/track_1 clear_events at=cycle
/save v1 at=cycle                  snapshot at a clean point, not mid-gesture
```

Only the read-only listing commands (`/tracks`, `/patches`, `events`,
`automations`, `help`, ...) ignore it — there's nothing to schedule — and the
three creation commands actively refuse it (see
[The one exception](#the-one-exception-creating-things) below).

A deferred command replies twice. First, immediately, with what *will* happen:

```
> /hats stop at=cycle
hats will stop (next cycle)
```

Then, when it actually fires, with what happened — marked with a `·` since no
command directly preceded it:

```
· hats stopped
```

Errors are reported at the right time too. Anything checkable up front is
rejected as a normal error even when deferred (`/rhy style=nonsense at=cycle`
fails immediately), and anything that can only fail later reports on the `·`
line rather than disappearing.

An unrecognized `at=` value is reported as a warning and falls back to "now"
rather than silently misbehaving or aborting the command. Combine with the
multi-command-per-line syntax (see [Syntax](#syntax)) to fire several
scheduled changes together:
`/track_1 gain=0 8 at=cycle /reverb wet=0.9 6b at=cycle`.

### The one exception: creating things

`/add_track`, `/add_bus` and `/add_modulator` **refuse `at=`** with an error:

```
> /add_track name=x at=cycle
add_track can't be deferred — a deferred creation has no name to report and
isn't addressable until it fires. Create it now, then use at= on the command
that wires it up.
```

Everywhere else, `at=` answers "when should this change take effect". But a
creation's effect is *a name starting to exist*, and a name that will exist
later is unusable in every way that matters: the command can't tell you what it
created (which is its entire output, and an auto-generated name isn't known
until the object is built), and a later command on the same line can't refer to
it — `/add_track name=x at=cycle /x gain=0.5` would silently half-work.

Deferring it also buys nothing musical. A fresh track, bus or modulator makes
no sound until something is wired into it, so **create now and defer the
wiring** — `/patch`, `add_processor=` and `start`/`stop` all take `at=`, and
that's the gesture that was actually wanted:

```
/add_modulator type=euclidpercs name=grid
/patch source=grid dest=drums.notes at=cycle
```

Refusing loudly rather than quietly ignoring it is the point: an `at=` that
silently does nothing is the worst of the three possible behaviours.

## Params vs. options

Every addressable object exposes up to two kinds of setting, and `help`
lists them separately:

- A **param** (`gain`, `wet`, `freq`, `probability`, `dropout`, ...) is backed
  by a real Web Audio `AudioParam`: it can be ramped (`wet=0.9 6b`), patched
  into (`/patch dest=reverb.wet`), loop-automated (`automate=wet ...`), and
  randomized (`wet=random`, or in bulk via `random` — see
  [Randomizing](#randomizing)).
- An **option** (`waveform`, `scale`, a reverb's `duration`/`decay`, a
  delay's `stereoOffset`, a sampler's `samples`, a generator's `seed`/`preset`)
  is a plain setting with no AudioParam behind it — settable at runtime the
  exact same way (`/lfo1 waveform=square`, `/rand1 scale=0,3,5,7,10`,
  `/reverb duration=4`), but **not rampable, patchable, or loop-automatable**;
  a ramp spec on one is rejected with a message. An option with a fixed set of
  valid values (a waveform, a preset) rejects anything else and the console's
  ghost-text completes from that set.

The one thing options are **not** excluded from is scheduling: `at=beat` /
`at=cycle` works on them exactly as it does on a param (see
[Scheduling with `at=`](#scheduling-with-at)). "Not rampable" means there's no
curve to draw between two values — a half-applied waveform is meaningless — not
that the change can't be timed.

Which of the two a given value is is a design decision about whether *sweeping*
it is musical. `granular`'s `position` is a param because walking the playhead
across sixteen beats is the whole instrument; `markovpercs`' `style` is an
option because it's only consulted when the pattern regenerates, so a ramp
would look like a control that does nothing.

One caveat on the list above: a **synth's** params, and an event-generating
modulator's, are read in JavaScript once per note rather than continuously by
the audio graph. Everything works on them — ramps, `automate=`, `/patch` — but
a patch or a ramp moves them note by note rather than smoothly. See the note
under [Modulators and patches](#modulators-and-patches).

Both round-trip through `/save`/`/recall` and session files. See
[objects.md](objects.md) for every type's params and options.

## Loop automation

`automate=` attaches a parameter ramp to a **position in the loop**,
replayed on every pass — the missing third sibling to an instant set and a
one-off console ramp:

```
/track_1 automate=gain from=0.9 to=0.2 beat=2 duration=1
/reverb automate=wet to=1 beat=0 duration=2 curve=exponential
/lfo1 automate=freq to=12 beat=3 duration=0.5 once
```

The first fades `track_1` from 0.9 down to 0.2 starting at beat 2 of
*every* loop; a one-off console ramp (`gain=0.2 3`) would fire once, from
the moment you hit Enter. `beat`/`duration` are in beats; `from` defaults
to the param's current value; `curve` is `linear` (default), `exponential`,
or `target` (an asymptotic settle); the bare `once` flag fires it on its
first pass only (e.g. a fade-in) instead of every loop. `automations`
lists what's attached (with indices), `remove_automation=<n>` removes one,
`clear_automation` removes all. Automation rides *under* any patch on the
same param (a patched modulator adds on top of the automated value, same
as it does over a ramp).

Loop automation is captured by `/save`/`/recall` and session files (a
`once` event that already fired will fire once more after a recall/load —
"restore this state" restores the fade-in too).

## Names

Tracks, buses, the master channel, processors, modulators, and groups share
one flat command namespace — every object is addressable as `/name`, so no two
objects of *any* kind can share a name. Creation enforces this: a requested
name that's already taken (by any object, of any kind) is de-duplicated with
a numeric suffix (`clock_2`, `t1_2`, ...), exactly like the default names
(`track` → `track_2`) always were. Top-level command names (`start`,
`clock`, `save`, ...) and `master` are reserved the same way — an object can
never be created with a name the router would dispatch as a command first,
so nothing is ever silently unaddressable.

A name must look like a command token: letters, digits, and `_`, starting
with a letter or `_`. Anything else (spaces, dots — a dot would collide with
the `name.param` patch-destination syntax — or a purely numeric name, which
`/1` couldn't even parse) is rejected with an error at creation time.
