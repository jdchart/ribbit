# Source overview

All DSP/engine code lives in `src/`. Base classes
(`synth.js`, `processor.js`, `modulator.js`, `channel.js`, etc.) live directly
in this folder; non-base implementations live one level down, grouped by
kind — `synths/oscsynth.js`, `synths/sampler.js`, `processors/reverb.js`,
`processors/delay.js`, `modulators/lfo.js` — so adding a new one is "add a
file to the matching subfolder, plus one registry line in `ribbit.js`," with no
other file needing to change. Files below are listed roughly bottom-up
(dependencies first).

## `taper.js`

Pure math, no classes. `positionToGain(position)` / `gainToPosition(gain)`: an
exponential taper (`TAPER_K = 6`) between a linear 0–1 control position (fader,
`gain=` command param) and the actual 0–1 gain value, so equal position steps read
as equal loudness steps. Used by `RibbitChannel`'s `gain` param (see `param.js`
below) and by `MixerChannel.svelte`'s fader — both need to convert in both
directions.

## `param.js`

`RibbitParam` — the one class every rampable/patchable parameter is built from,
on every kind of object that has one: a channel's `gain`/`pan`, a processor's
own params, a modulator's own params, a patch's `depth`. Wraps a single raw
`AudioParam` plus:

- optional `decode`/`encode` — a value transform between the user-facing
  number and the actual `AudioParam` value (used by channel `gain`, whose
  user-facing 0–1 position is exponentially tapered via `taper.js` onto the
  underlying gain value; everything else defaults to identity).
- optional `min`/`max` — clamped by `.clamp(value)` (channel gain/pan use
  this; processor/modulator params default to unclamped).
- optional `onSet` — overrides the instant-set path for a param that has to
  fan a single value out across more than one node (`RibbitDelay`'s `time`
  writes both `delayL.delayTime` and `delayR.delayTime`, the latter offset for
  stereo width). Ramping/deferred `at=` scheduling still only animates the
  "primary" `.audioParam` directly — `onSet` only affects the plain
  instant-set case.

`.get()`/`.set(value)`/`.clamp(value)` are the whole public surface;
`.audioParam` is public too, and is what `commands.js`'s `applyParams` reaches
into directly for ramping/deferred scheduling. Before this class existed, a
param's `.params` entry (a hand-written `{get,set}` closure) and its
same-named raw-`AudioParam` getter (e.g. a processor's `get wet()`) were two
independent things that had to be kept in sync by convention — `RibbitParam` is
the single source of truth for both, so there's nothing left that can drift
apart. A class that still exposes a getter like `get wet()` today (for use as
an `RibbitAutomationEvent` target, e.g. `reverb.wet` in a pattern-automation
call) does so as a thin delegate onto `this.params.wet.audioParam`, not a
second implementation.

## `event.js`

`RibbitEvent({ beat, pitch, degree, velocity = 1, duration = 0.25 })` — a plain
data object, one entry in a synth's `events` array. `beat` is loop-relative (0
to `loopLengthBeats`). `pitch` defaults to `60` only if neither `pitch` nor
`degree` is given (so a `degree`-only event doesn't also carry a stale default
pitch). No other behavior; synths interpret `pitch`/`degree`/`velocity`/
`duration` however they like (`RibbitOscSynth` treats `pitch` as a MIDI note and
resolves `degree` against the shared harmony context at trigger time, see
[harmony.js](#harmonyjs); `RibbitSampler` treats `pitch` as a sample-slot index
and ignores `degree` entirely).

## `harmony.js`

`createHarmonyContext()` returns `{ root, scale }` (default: root `60`, a
chromatic `scale` — every semitone). `resolveDegree(harmony, degree)` maps a
(possibly negative, possibly multi-octave) scale-degree to a MIDI note number,
wrapping into higher/lower octaves via `scale.length`.
`parseDegreeList(value, label)` validates a degree list from either an array
or the console's comma string — shared by the `/harmony scale=` command and
`RibbitRandomNotes`' `scale` option, so the two can't drift on what a list
accepts. Both `root` and `scale` are runtime-mutable via `/harmony`
(commands.js mutates the shared object in place — synths hold a reference);
chord/progression logic on top is still future work. `Ribbit` constructs one
shared instance and threads it into every synth (see
[architecture.md](architecture.md#harmony-context)).

## `automation.js`

`RibbitAutomationEvent({ beat, duration, target, from, to, curve, once })` — a
parameter ramp. `target` is a real `AudioParam` (e.g. `track.volume`,
`reverb.wet`, or any `RibbitParam`'s own `.audioParam`). A private `applyRamp(param,
time, endTime, from, to, curve)` is the one place that turns a curve name into
actual Web Audio ramp calls (`linearRampToValueAtTime` /
`exponentialRampToValueAtTime` / `setTargetAtTime` for `curve: "target"`, an
exponential approach useful for smoother/asymptotic moves). Two exported
functions call into it: `scheduleAutomationEvent(time, event, secondsPerBeat)`,
called directly by `RibbitClock` for loop-position pattern automation, and
`scheduleRamp(audioContext, param, from, to, durationSeconds, { startTime,
curve })`, called directly by the command router (via `commands.js`'s
`applyParams`) for one-off console ramps (`/track_1 gain=0 3`) — anchored to
an absolute time (`audioContext.currentTime` by default) rather than a
loop-relative beat, and never registered with the clock. See
[architecture.md](architecture.md#two-ramp-scheduling-paths-one-curve-implementation).

## `clock.js` — `RibbitClock`

The scheduler. See [architecture.md](architecture.md#the-clock-is-a-lookahead-scheduler-over-units)
for the full model. Key surface: `addUnit`/`removeUnit`, `start`/`stop`,
`setBpm(bpm)` (glitch-free — preserves the current playback beat across a
tempo change while running; also cancels any in-flight `rampBpm`),
`rampBpm(targetBpm, durationSeconds, { startTime })` (glides tempo over time —
bpm isn't a native `AudioParam`, so unlike a channel/processor param this
can't ride `linearRampToValueAtTime`; it steps `_applyBpm` repeatedly on a
short `setTimeout`, each step re-deriving `startTime` the same glitch-free way
`setBpm` always has), and `setLoopLengthBeats(beats)` (changes the loop
length; no rebasing needed since `_scheduleRange` reads it fresh every tick;
deliberately has no ramp equivalent — a fractional, constantly-shifting loop
length has no sensible meaning). All exposed via `/clock bpm= num_beats=`
(see [user/commands.md](../user/commands.md)). `beatToTime(beat)` converts a
beat position to an absolute `AudioContext` timestamp; `currentBeat()`,
`nextBeatTime()`, and `nextCycleTime()` compute the live playback position and
the next beat/loop-boundary timestamps — the anchor points a ramp's or a
deferred instant set's `startTime` uses for `at=beat`/`at=cycle`.

`_tick()` wraps its call to `_scheduleRange` in a try/catch: a single bad
event or param (e.g. a value that ends up passing a non-finite number into a
native `AudioParam` call, which throws) can only drop that one scheduling
pass — the `setTimeout` reschedule immediately after is unconditional, so one
bad command can never permanently kill the whole engine's scheduling loop.
This pairs with `commands.js`'s `toNumber()` guard (see below), which is the
first line of defense — reject bad input before it ever reaches an
`AudioParam` call — with the tick-level try/catch as a second, structural
line of defense for anything that gets through anyway.

`_scheduleRange` also has one more optional, duck-typed check per unit
beyond `events`/`automation`: if `unit.generateEvents` exists (an
event-generating modulator, e.g. `RibbitRandomNotes` — see
`modulators/randomnotes.js` below), it's called with an *absolute*
(non-loop-relative) beat range and whatever `RibbitEvent`s it returns get
delivered straight to `unit.eventDestinations` (every channel currently
`.notes`-patched to it — see `patch.js`/`ribbit.js` below) via
`destination.source.trigger(...)` — the exact same call a manually-authored
event uses. Each delivered note also stamps `unit.lastEventTime` (the
note's scheduled AudioContext time), which `ModulatorStrip.svelte` reads to
flash its "notes" dot. See
[architecture.md](architecture.md#event-generating-modulators-the-discrete-counterpart-to-a-patch)
for the full picture, including why this needed absolute rather than
loop-relative beats.

`start()` calls one more optional, duck-typed per-unit hook before the first
tick: `unit.onClockStart?.()`. A (re)start rewinds the absolute beat
position to 0, so any unit holding its own absolute-beat state (currently
just `RibbitRandomNotes`' candidate-grid cursor) must reset it there —
otherwise a `/stop` `/start` leaves that state stranded at a beat number the
clock won't reach again for a long time.

## `channel.js` — `RibbitChannel`

Base class for anything with a fader, pan, an insert chain, and one or more
sends: `master`, every `RibbitTrack`, and every bus are one of these. Owns
`input`/`panner`/`gainNode` nodes, the `processors` array, and the `sends`
array. `volume`/`pan` getters expose the underlying `AudioParam`s directly (so
they can be automation targets or bound straight into the UI); `output`
(aliasing `gainNode`, the post-fader signal) lets a channel double as a patch
source (see `patch.js`) the same way a synth's or processor's own `output`
can. `params` (`{ gain: RibbitParam, pan: RibbitParam }`, see `param.js`) is the
console/UI-facing surface `commands.js`'s `applyParams` uses — `gain` wraps
`gainNode.gain` through the position↔gain taper (`taper.js`), `pan` wraps
`panner.pan` directly, both clamped (`0..1` / `-1..1`).
`addProcessor`/`removeProcessor`/`setProcessorActive` all end by calling
`_rewireChain()`, which is the only place that actually connects/disconnects
the `input → panner → gainNode` portion of the chain — everything else just
mutates the `processors` array and lets rewiring follow. `_rewireChain()`
never touches `sends` — those hang directly off `gainNode`.

`addSend(destination, { destName, gain })` creates one more independent
`gainNode → sendGain → destination.input` edge (throws if `destination ===
this`) and returns `{ id, destination, destName, params: { gain: RibbitParam } }`;
`removeSend(id)` tears down and forgets one. `connect(destination, destName)`
is sugar over both: clear every existing send, add a single fresh one at gain
1 — the historical single-destination behavior, still the default for a
freshly-created track/bus. `destName` is display-only (what `channelSummary`
prints), resolved by whoever calls `addSend`/`connect` — `channel.js` itself
never resolves names.

## `track.js` — `RibbitTrack extends RibbitChannel`

Adds exactly one thing over `RibbitChannel`: a `.source` (a synth) whose `.output`
feeds the track's `.input`. `setSource(newSource)` is how `/track_1 synth=sampler`
swaps synths at runtime without touching the track's gain/pan/inserts. A
**bus** (created via `Ribbit.createBus`/`/add_bus`) is *not* an `RibbitTrack` — it's
a bare `RibbitChannel` with no `.source` at all, registered in `nllc.buses`
instead of `nllc.tracks`. It exists purely to be a named `destination` other
channels' sends can point at (see `channel.js` above and `ribbit.js` below).

## `synth.js` — `RibbitSynth` (base)

Minimal: `name`, `output` (a `GainNode` — subclasses connect their voices into
this), `events`/`automation` arrays, `params` (empty — see
[creating-a-synth.md](creating-a-synth.md) if you want a synth with runtime
params), `options` (declarative non-rampable runtime settings, `{ key: {
get(), set(value), choices? } }` — the console's `applyOptions` surface, and
what the base `getOptions()` derives session serialization from; subclasses
declare entries rather than overriding `getOptions()`), `active` (transport
pause flag, checked by the clock, not a bypass in the routing sense), and a
no-op `trigger()` for subclasses to override.

## `synths/oscsynth.js` — `RibbitOscSynth extends RibbitSynth`

One `OscillatorNode` + envelope `GainNode` per triggered note (see
[objects.md](../user/objects.md) for the envelope shape). `trigger()` resolves
`event.degree` via `resolveDegree(this.harmony, event.degree)` when present,
falling back to `event.pitch` otherwise. Starts with an empty `events` array —
see [commands.md](../user/commands.md) for `add_event`/`clear_events`.

## `synths/sampler.js` — `RibbitSampler extends RibbitSynth`

Loads its sample list (default `SAMPLE_FILES`, from `static/samples/`;
runtime-swappable via the `samples` option, whose setter re-runs the same
`_setSamples` path construction uses) into `slots` via `fetch` +
`decodeAudioData`, URL-encoding filenames since they contain spaces.
Loading is async and **not awaited** by anything (`this._loaded` is stored but
never checked before `trigger()` — a hit that lands before its buffer finishes
loading just silently no-ops, including right after a runtime swap). `trigger()` mod-wraps `event.pitch` into a valid
slot index (handles negative pitches correctly, not just `%`); `event.degree`
is ignored entirely (pitch is always a slot index here, never resolved against
harmony). Starts with an empty `events` array, same as `RibbitOscSynth`.

## `processor.js` — `RibbitProcessor` (base)

Mirrors `RibbitSynth`: `name`, `input`/`output` (both `GainNode`s — subclasses wire
their own DSP between them), `active` (routing bypass, read by
`Channel._rewireChain`), `params` (`{ paramName: RibbitParam }` — see `param.js`
— this *is* meant to be filled in by subclasses; it's the introspection
surface the command router uses for `/reverb wet=0.5` and `/reverb help`),
`options` (same declarative non-rampable-settings map as `RibbitSynth.options`
— `RibbitReverb` uses it for `duration`/`decay`, whose setters rebuild the
impulse response in place), and `automation`.

## `processors/reverb.js` — `RibbitReverb extends RibbitProcessor`

Convolution reverb against a synthetically-generated impulse response
(`buildImpulseResponse`: exponentially-decaying random noise per channel — no
external IR file). Parallel wet/dry: `input` connects straight to `output` (dry)
*and* to the convolver chain (wet, via `wetGain`). `params.wet` is an
`RibbitParam` wrapping `wetGain.gain`; `get wet()` is a thin alias onto
`params.wet.audioParam` (kept for use as an `RibbitAutomationEvent` target, e.g.
the demo bootstrap's fade-in).

## `processors/delay.js` — `RibbitDelay extends RibbitProcessor`

Stereo ping-pong delay: a `ChannelSplitter`/`ChannelMerger` pair around two
independent `DelayNode`s, cross-feeding each channel's output into the *other*
channel's delay line (`delayL → feedbackL → delayR`, and vice versa) rather than
back into itself, plus a small `stereoOffset` added to the right channel's delay
time for width. `time`/`feedback` are `RibbitParam`s whose `onSet` fans an
instant set out across both L/R nodes (`time` also adds `stereoOffset` to the
R side) — ramping/deferred `at=` scheduling still only animates the L side
directly, a pre-existing limitation unchanged by the `RibbitParam` consolidation.
`wet` is a plain single-node `RibbitParam`. Same `get time()`/`get feedback()`/
`get wet()` alias pattern as `RibbitReverb`.

## `modulator.js` — `RibbitModulator` (base)

Base class for every modulation source (see `modulators/lfo.js`). Structurally a
processor's sibling — it's named/addressable and has `params` the exact same
way — but it never sits in a channel's insert chain; it exists purely to be
patched (see `patch.js`) into some other object's parameter. `output` is a
plain `GainNode`; by convention a modulator's raw output is bipolar
(roughly `-1..1`), since a *patch*'s own `depth` (not the modulator) decides
how hard that signal pushes any given destination — the same modulator can
drive several destinations at different depths. Also has `options` (same
map as `RibbitSynth`/`RibbitProcessor` — `RibbitLFO.waveform`,
`RibbitRandomNotes.scale`) and an `automation` array + `addAutomation()`, so
a modulator's own params can be loop-automated exactly like a processor's
(`/lfo1 automate=freq ...`).

## `modulators/lfo.js` — `RibbitLFO extends RibbitModulator`

A continuously-running `OscillatorNode` (started once in the constructor,
never stopped) connected straight into `this.output` — a bipolar control
signal at `freq` Hz. `waveform` is a runtime option (its setter mutates
`osc.type` in place, which `OscillatorNode` allows live). `params.freq` is
an `RibbitParam` wrapping
`osc.frequency`; `get freq()` is the same kind of thin alias as a processor's
`get wet()`.

## `modulators/randomnotes.js` — `RibbitRandomNotes extends RibbitModulator`

The event-generating counterpart to `RibbitLFO` — see
[architecture.md](architecture.md#event-generating-modulators-the-discrete-counterpart-to-a-patch)
for the full model. Has no meaningful continuous `.output` (inherited but
unused); instead implements `generateEvents(fromBeat, toBeat)`, called by
`RibbitClock` every tick, and owns `this.eventDestinations = []` (every channel
currently `.notes`-patched to it, maintained by `RibbitEventPatch`'s
constructor/`disconnect()` — see `patch.js` below).

`probability`/`min_gap` are real `RibbitParam`s — same get/set/ramp/`at=`
machinery as anything else — backed by a `ConstantSourceNode.offset` each
rather than a plain object field, purely to get real `AudioParam` scheduling
"for free" for a value that isn't otherwise audio-rate. This surfaced a
genuine Web Audio quirk worth knowing about elsewhere: a `ConstantSourceNode`
with **no path into the actively-rendered graph** can have `setValueAtTime`-
scheduled automation (which every `/recall`, `at=`, or ramp rides — see
`automation.js`'s `setInstant`/`scheduleRamp`) silently never reflected back
in a later `.value` read, even though a *direct* `.value =` assignment (what
the constructor does for the initial value) always works regardless of
connectivity. `RibbitLFO`'s `freq` never hit this in practice only because the
mixer's `ModulatorStrip.svelte` happens to tap every modulator's `.output`
with an `AnalyserNode` for its meter, which incidentally keeps that
particular node's automation live — not a real fix, and not something a
class should rely on. `RibbitRandomNotes` instead routes each
`ConstantSourceNode` through its own muted (`gain: 0`, inaudible always)
sink into `audioContext.destination` (`_silentSink`), which reliably keeps
it live regardless of whether the mixer is even mounted. Those sinks aren't
reachable via `this.output`, so `Ribbit.removeModulator`'s generic
`modulator.output.disconnect()` alone wouldn't tear them down — `dispose()`
(called via the same duck-typed-optional-hook pattern as `generateEvents`
itself) stops both `ConstantSourceNode`s and disconnects their sinks.

`scale` (a list of candidate harmony-context degrees a generated note's pitch
is randomly picked from) isn't backed by any `AudioParam` at all — it's a
runtime *option* (`/rand1 scale=0,3,7`, parsed/validated by `harmony.js`'s
`parseDegreeList`, applied from the next generated note), declared in
`this.options` and round-tripped by the base `getOptions()`, same as
`RibbitLFO`'s `waveform`.

`onClockStart()` (a third duck-typed optional hook, called by
`RibbitClock.start()` on every registered unit) resets `_nextCandidateBeat` —
the candidate grid's cursor is an **absolute** beat number, and a clock
(re)start rewinds absolute beats to 0, so without this a `/stop` `/start`
would leave the cursor stranded at the pre-stop beat, generating nothing
until the clock caught back up to it. Any future unit holding its own
absolute-beat state needs the same hook.

## `patch.js` — `RibbitPatch` / `RibbitEventPatch`

`RibbitPatch`: one continuous "patch cable" — connects a source object's
`.output` (a modulator, but also a track/master's post-fader signal or a
processor's post-effect signal — anything with an `.output`) into a
destination `AudioParam`, through its own `depthGain` (attenuator) node —
`sourceObject.output → depthGain → destParam`. `depth` lives on the patch,
not either endpoint, specifically so the same source can drive several
destinations at different amounts, and `params.depth` (an `RibbitParam`
wrapping `depthGain.gain`) makes it rampable the exact same way a processor
param is. Stores `sourceObject`/`destObject` (plus display-only
`sourceName`/`destName` strings) so `Ribbit` can cascade-remove a patch when
either endpoint is itself torn down (see `ribbit.js`). `disconnect()` tears
down both Web Audio connections; it must run *before* the endpoint's own
blanket `.disconnect()` in `removeTrack`/`removeProcessor`/`removeModulator`,
since a specific-argument `.disconnect(node)` throws if that connection was
already severed by a bare `.disconnect()`.

`RibbitEventPatch`: the discrete counterpart, connecting an event-generating
modulator into a track instead of an `AudioParam` — see
[architecture.md](architecture.md#event-generating-modulators-the-discrete-counterpart-to-a-patch)
for the full model. No Web Audio node at all (nothing here is audio-rate) —
its constructor's only real side effect is pushing `destObject` onto
`sourceObject.eventDestinations`; `disconnect()` splices it back out.
`params` is `{}` (no `depth`), which `commands.js`'s `patchSummary` and
`session.js`'s `serializePatch`/`reconcilePatches` all check for before
assuming a patch has one.

## `commands.js`

No classes — a closure-based router. `parseCommand(text)` is the tokenizer
(regex-based key=value parser with quoting, optional `=` whitespace, and an
optional trailing duration token that turns a value into a ramp spec
`{ value, duration, unit }` — see [user/commands.md](../user/commands.md#syntax));
`isRamp()`/`rampSeconds()`/`resolveStartTime()` are the small shared helpers
every ramp-aware command uses to turn a ramp spec into a `scheduleRamp()`
call, including resolving `at=beat`/`at=cycle` against the clock.
`toNumber(raw, label)` converts a parsed value to a number, *throwing* (not
returning `NaN`) if it isn't finite — this is what turns a bad numeric param
into a clean caught error instead of silently writing `NaN` into persistent
engine state (e.g. `clock.bpm`). `setInstant(audioContext, param, value,
startTime)` writes a value onto an `AudioParam` via
`cancelScheduledValues`+`setValueAtTime` rather than a direct `.value =`
assignment, so a deferred (`at=`) *instant* set is possible, not just a
deferred ramp.

`applyParams(nllc, paramsMap, input, { startTime, label }, { reportUnknown })`
is the one function that knows how to get/set/ramp/defer any `RibbitParam` (see
`param.js`) against a parsed command value — shared by `channelCommand`
(gain/pan plus a track's synth's params), `paramObjectCommand` (every
processor/modulator param), and the `/patch` command (depth), replacing what
used to be three separate hand-rolled copies of the same
ramp/instant/`at=` branching. Its non-rampable sibling is
`applyOptions(object, input, exclude)` — applies keys naming entries in an
object's declarative `options` map (rejecting ramp specs, validating
against `choices`), with `exclude` = `compositeClaimedKeys(params)` so a
composite command's generic keys (`automate=`'s `duration=`, say) don't
also hit a same-named option (reverb's `duration`). The automate family —
`addAutomationCommand` (builds an `RibbitAutomationEvent` with encoded
values and a `paramKey`), `listAutomation` (indexed, decoded),
`removeAutomationCommand` — is likewise shared by both command shapes.

`channelCommand` and `paramObjectCommand` are the two shapes of object the
router knows how to talk to: `channelCommand` handles a track, a bus, or
master (gain/pan — and a track's synth's own params/options, routed through
the track's name — via `applyParams`/`applyOptions`, plus channel-specific
commands: `add_event`/`events`/`remove_event=`/`clear_events`, the automate
family, `synth=`/`add_processor=`, and routing: `out=`/`add_send=`/
`remove_send=`/`send=`+`send_gain=` against the channel's own `sends` — see
`channel.js`'s `addSend`/`removeSend`/`connect` above); `paramObjectCommand`
is shared by `processorCommand` and `modulatorCommand` (both are just
"addressed by name, expose `.params`/`.options`" — the only difference is
which `nllc.remove*` function gets called for `remove_self`).
`channelCommand`'s `remove_self` branch checks `nllc.buses.includes(channel)`
to call `removeBus` instead of `removeTrack` for a bus. Both commands end
with an unknown-key check against their consumed-key sets
(`CHANNEL_COMMAND_KEYS`/`PARAM_OBJECT_COMMAND_KEYS`) plus every
param/option surface they route to, so a typo'd key errors instead of
silently vanishing. Two console-only guards protect master's speakers
edge: `out=` is refused on master outright, and `remove_send=` refuses the
send whose destination is `audioContext.destination` (nothing typed at the
console could ever reconnect it).

Both dispatch to one of three outcomes: `channelSummary`/`paramObjectSummary`
(no params — condensed one-liner), `channelHelp`/`paramObjectHelp` (`help` —
every param's value+range via the shared `formatParamLine`, plus every
command that object kind accepts, spelled out with a usage note), or actually
applying whatever param/command was given. The help builders read
`nllc.synthTypes`/`processorTypes`/`modulatorTypes` (see `ribbit.js` below) to
list available `synth=`/`add_processor=`/`add_modulator` types without
hardcoding them.

`createCommandRouter(nllc)`
returns `{ executeCommand, suggest }` — `executeCommand` ties the above into
one function, first splitting one submitted line into multiple `/name ...`
segments (`splitCommands`, letting `/track_1 gain=0
8 /reverb wet=0.9 6b` run both together) before dispatching each — in order,
against top-level `commands`, `master`, `nllc.tracks`, `nllc.buses`,
`nllc.processors`, then `nllc.modulators`. See
[adding-commands.md](adding-commands.md).

`suggest(input, cursorPos)` is the console's ghost-text completion (consumed
by `CodeEditor.svelte` — see [architecture.md](architecture.md#console-suggestions-ghost-text-completion)),
returned alongside `executeCommand` (rather than attached to it as a
property) specifically so it can close over the same `commands` object —
`Object.keys(commands)` is the one list of top-level command names, read once
into `topLevelNames` right after `commands` is built, so a new top-level
command becomes suggestible for free with no second list to maintain.
`suggestCompletion(nllc, topLevelNames, input, cursorPos)` (module-level, not
part of the closure) does the actual work — anywhere in the line the cursor
sits at a token boundary, not just at the end (see `CodeEditor.svelte`'s
overlay technique in [architecture.md](architecture.md#console-suggestions-ghost-text-completion)).
Three token shapes: the `/name` itself (`addressableNames`: every track/bus/
processor/modulator/`master`, *then* top-level commands, deliberately in that
order rather than `executeOne`'s dispatch order, so typing `/trac` suggests
an actual track like `track_1` instead of the built-in `/tracks`); once
past the name, a bare param *key* for whatever channel/processor/modulator it
resolves to (`resolveKeywordsFor` → `channelKeywordsFor`/
`paramObjectKeywordsFor` — each object's own `params` *and* `options` keys,
a channel also its synth's, plus one of two small hand-maintained keyword
lists, `CHANNEL_ACTION_KEYWORDS`/`PARAM_OBJECT_ACTION_KEYWORDS`, for the
non-param commands like `add_event`/`automate=`/`remove_self`/`help`); or,
once a key's `=` has at least one typed character after it, its *value*,
for keys with an enumerable candidate set (`resolveValueCandidates`: type
names, `beat`/`cycle`, `linear`/`exponential`/`target` for `curve=`, an
object's param names for `automate=`, event/automation indices for
`remove_event=`/`remove_automation=`, existing ids/names/states, and any
option's declared `choices` — a waveform completes from its own list).
`pickBestMatch` returns the first candidate that extends the typed prefix —
no ranking or cycling among several matches yet (see
[adding-commands.md](adding-commands.md#keeping-suggestions-in-sync) for what
to update when adding a new channel/processor/modulator command).

## `ribbit.js` — `Ribbit`

The top-level object and factory/registry hub:

- `SYNTH_TYPES` / `PROCESSOR_TYPES` / `MODULATOR_TYPES` — the string-to-class
  registries that `synth=`/`add_processor=`/`add_modulator` command params
  (and `createSynth`/`createProcessor`/`createModulator`) look up against.
  **Adding a new synth, processor, or modulator class means adding one line
  here** (plus the import) — nothing else in the engine needs to know about it.
  `synthTypes`/`processorTypes`/`modulatorTypes` getters expose their keys
  read-only (`Object.keys(...)`) for callers outside this module — currently
  just `commands.js`'s `channelHelp`/`paramObjectHelp`, so `/track_1 help`
  can list available types without a second hardcoded copy of this list.
- `createTrack`/`createBus`/`createSynth`/`createProcessor`/`createModulator` —
  construct + register (with the clock, and with `tracks`/`buses`/
  `processors`/`modulators` for name-based lookup) in one call. `createSynth`
  also threads `this.harmony` (one shared context constructed once in the
  `Ribbit` constructor, see [harmony.js](#harmonyjs)) into every synth it
  builds. Both `createTrack` and `createBus` resolve an `out=` option (default
  `"master"`) via `_resolveObject` and call `channel.connect(destObject,
  destName)` to set up the one default send a fresh track/bus starts with.
- `setTrackSynth` — swap a track's synth at runtime (used by `/track_1
  synth=sampler`), correctly deregistering the old synth from the clock and
  registering the new one.
- `removeTrack`/`removeBus`/`removeProcessor`/`removeModulator` — the inverse
  of the `create*` methods above; each first calls
  `_removePatchesReferencing(object)` *and* `_removeSendsReferencing(object)`
  (see below) *before* disconnecting any of its own nodes, then handles its
  own teardown (`removeTrack`/`removeBus` also tear down the channel's own
  processor inserts and its own sends).
- `createPatch({ sourceName, destName, depth })` / `removePatch(patch)` — the
  modular-patching layer. `_resolveObject(name)` resolves a bare name against
  every addressable object (master, then tracks, buses, processors,
  modulators — the same order `executeOne`'s dispatch uses); `_resolveDest
  ("name.param")` splits on the dot and looks up
  `object.params[paramKey].audioParam` — one lookup for every kind of object,
  since channels/processors/modulators all expose `params` as `{ key:
  RibbitParam }` uniformly (see `param.js`). A `destName` ending in `.notes`
  (the reserved event-patch destination — see
  [architecture.md](architecture.md#event-generating-modulators-the-discrete-counterpart-to-a-patch))
  branches to `_createEventPatch` instead, which validates the source has a
  `generateEvents` method and the destination channel has a `.source` before
  building an `RibbitEventPatch` (`patch.js`) rather than an `RibbitPatch`.
  `_removePatchesReferencing(object)` cascade-removes any patch whose
  `sourceObject` or `destObject` is the object being torn down, so a patch
  never outlives either endpoint — this works uniformly across both patch
  kinds since both expose a `disconnect()` method, just with different
  teardown logic behind it. `_removeSendsReferencing(object)` is the same
  idea for sends: it walks every track, bus, and master and removes any send
  whose `destination` is the object being torn down, so a send never
  outlives the channel it fed into.
- `_uniqueName(base)` — validates `base` as an addressable name (must parse
  as a `/name` token: letters/digits/`_`, starting with a letter or `_` — no
  dots, which would collide with the `name.param` patch-destination syntax),
  then de-duplicates as `base`, `base_2`, `base_3`, ... against **one**
  shared namespace: every existing track, bus, processor, and modulator
  (`_allNames()`) plus `RESERVED_NAMES` (the module-level set of every
  top-level command name and `master`, exported so `commands.js` can
  sanity-check its own command keys against it at router build time). The
  router dispatches a bare `/name` against all of those in order, so a
  duplicate across kinds — or an object named after a command — would be
  permanently shadowed; de-duplicating globally at creation time makes that
  impossible. **A new top-level command must be added to `RESERVED_NAMES`
  too** (a `console.warn` at router construction catches a forgotten one).

## `session.js`

No classes — whole-session (de)serialization plus the diff-and-ramp
reconciler behind `/recall`. Three exports, all closing over a live `Ribbit`
instance rather than holding any state of their own:

- `snapshotSession(nllc)`/`sessionToJSON(nllc)` — a pure, JSON-serializable
  snapshot of everything live: clock/harmony, master/every bus/every track
  (each with `params`/`processors`/`sends`, a track also its synth's
  `type`/`options`/`params`/`events`), every modulator, every patch (an
  `RibbitEventPatch`'s missing `depth` is handled by `serializePatch` checking
  `patch.params.depth` before reading it, rather than assuming every patch is
  shaped like a regular `RibbitPatch` — same guard `reconcilePatches` below
  needs).
  `sessionToJSON` adds a `version` and `nllc.states` (see `/save` below) on
  top of the same shape `snapshotSession` returns. Every rampable value comes
  from `RibbitParam.get()` (see `param.js`) — already the decoded, user-facing
  number. Every constructible object (a synth, processor, or modulator) is
  tagged with the registry key that built it: `Ribbit.createSynth`/
  `createProcessor`/`createModulator` each set a `.type` string on the
  instance they return specifically so this module can serialize "which
  class to reconstruct" without reverse-deriving it from `instanceof`
  against `SYNTH_TYPES`/`PROCESSOR_TYPES`/`MODULATOR_TYPES`. Non-param
  runtime state (`RibbitReverb`'s `duration`/`decay`, `RibbitDelay`'s
  `stereoOffset`, `RibbitLFO`'s/`RibbitOscSynth`'s `waveform`, `RibbitSampler`'s
  `samples`, `RibbitRandomNotes`' `scale`) is captured by `getOptions()`,
  which the base classes derive from each object's declarative
  `this.options` map — a subclass never overrides it. Loop automation
  (every unit's `.automation`) is captured too: `serializeAutomation`
  stores each console-authored event by its `paramKey` with user-facing
  (decoded) from/to values, and `rebuildAutomation` re-resolves the param
  by name and re-encodes on load/recall — an event built in code against a
  bare `AudioParam` (no `paramKey`) is skipped, and a rebuilt `once` event
  fires once more.
- `loadSession(nllc, json)` — a hard rebuild: tears down every track/bus/
  modulator/patch and every processor on master, then reconstructs from
  scratch by calling the exact same `nllc.createTrack`/`createBus`/
  `addProcessor`/`addSend`/`createModulator`/`createPatch` the console itself
  uses — no second construction path to keep in sync. Order matters:
  buses/tracks first (with a throwaway default send), then every bus's/
  track's *real* saved sends once every possible destination by name
  actually exists, then modulators, then patches last, since a patch
  resolves both endpoints by name against whatever's already been built.
  This is the vehicle for `/load_session` (see `commands.js`) — a cold-start
  operation, so unlike `applySnapshot` below there's no attempt to be
  glitch-free.
- `applySnapshot(nllc, snapshot, { startTime, durationSeconds })` — the
  vehicle for `/recall`. Diffs the *live* session against a saved one
  (matched by `.name`, and for processors/modulators also by `.type`) and
  reconciles the difference rather than rebuilding: a matching object's
  params ramp toward the saved values via the same `scheduleRamp`/
  `setInstant` (`automation.js`) every console ramp already rides — no new
  scheduling primitive; an object only in the snapshot is created and its
  gain/depth ramped up from 0 (a fade-in); an object only live has its gain/
  depth ramped down to 0 and is torn down only once that fade completes (a
  fade-out), rather than cut instantly. Structural graph changes themselves
  (creating/removing a track, reordering a processor chain) can't ride
  native `AudioParam` scheduling the way a ramp can, so — the same
  compromise `RibbitClock.rampBpm` already makes for tempo — they're deferred
  via a plain `setTimeout` computed from `startTime`, while any param ramps
  on the same objects are still scheduled immediately (a future `AudioParam`
  value doesn't need its node connected into the graph yet at schedule time,
  only by the time it fires, which the paired `setTimeout` guarantees).

## Natural-language layer (host app, not ribbit)

Ribbit has no natural-language layer of its own — that belongs to the host
interface. The reference app (NLLC) keeps an `Ollama()` stub (`src/lib/scripts/
ollama.js` in that project) as the intended integration point for routing
natural-language input to ribbit's commands (or directly manipulating the
`Ribbit` graph). It targets exactly the command vocabulary
`createCommandRouter` exposes.
