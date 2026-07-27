# Ribbit — LLM context overview

Ribbit is a browser Web Audio engine for live-coding music. It's UI-agnostic:
a host app drives it either by calling its methods directly or through its
built-in slash-command router. Commands create/control **tracks**
(each wrapping a **synth**), **buses** (plain channels with no synth, used as
shared send destinations — a sub-mix or a shared effect), **processors** (effects,
inserted into a track's/bus's/master's chain), **modulators** (continuous control
sources, e.g. an LFO, patched into any parameter), and **patches** (the connections
between a modulator/other source and a destination parameter), plus the
**master** bus, all playing on a shared, looping, lookahead-scheduled **clock**.
Conceptually closest to a tiny text-driven Max/MSP or SuperCollider.

A host app can layer natural language on top — translating free text into this
same command vocabulary or direct graph mutations via an LLM. Ribbit itself
stays NL-agnostic; that layer lives in the interface. (The reference host app,
NLLC — Natural Language Live Coding — that ribbit was extracted from has an
`Ollama()` stub for exactly this.)

## Object model

```
Ribbit                         top-level owner, one per page
├── audioContext             Web Audio AudioContext (suspended until /start)
├── clock: RibbitClock         lookahead scheduler; holds all "units"
├── master: RibbitChannel      final bus → audioContext.destination
├── tracks: RibbitTrack[]      extends RibbitChannel; each has .source = a synth
├── buses: RibbitChannel[]     plain channels (no synth), addressable send destinations
├── processors: RibbitProcessor[]   flat registry of every processor anywhere
├── modulators: RibbitModulator[]   flat registry of every modulator (e.g. an lfo)
├── patches: RibbitPatch[]     every active "patch cable" (source.output → depth → destParam)
└── states: {name: snapshot}      named snapshots captured by /save, applied by /recall (session.js)
```

- **`RibbitChannel`** (base of `master`, every `RibbitTrack`, and every bus): fader
  (`params.gain`, 0–1 position tapered onto the actual gain), pan (`params.pan`,
  -1..1), an ordered insert chain of processors, and a `sends` array — every
  place this channel's post-fader signal currently feeds. `_rewireChain()`
  connects `input → active processors in order → panner → gainNode`; from
  `gainNode`, each entry in `sends` is its own independent `{ id, destination,
  destName, params: { gain: RibbitParam } }` edge (`gainNode → sendGain →
  destination.input`), so one channel can feed several places at once at
  different levels (e.g. dry to master, a wet send to a reverb bus).
  `connect(destination, destName)` is sugar over this: it clears every existing
  send and adds a single one at gain 1 — the common case (a fresh track/bus
  feeds master alone) — while `addSend`/`removeSend` support the general
  multi-send case. A **bus** is just a plain `RibbitChannel` with no `.source`,
  created via `/add_bus`, existing purely to be a send destination other
  channels route into.
- **`RibbitSynth`** (base of `RibbitOscSynth`, `RibbitSampler`): produces sound. Has
  `events` (`RibbitEvent{beat,pitch,degree,velocity,duration}` — starts **empty**,
  populated via `add_event`), a `trigger(time, event, secondsPerBeat)` method the
  clock calls per-event, an `output` GainNode, `harmony` (the shared context, see
  below), and an `active` flag (transport pause, distinct from routing bypass).
- **`RibbitProcessor`** (base of `RibbitReverb`, `RibbitDelay`): effects, continuously
  in a channel's signal chain (no per-event trigger). Has `input`/`output`
  GainNodes, `params` (`{name: RibbitParam}`) as its console-facing control
  surface, and `active` as a *routing bypass* (handled by the owning channel).
- **`RibbitModulator`** (base of `RibbitLFO`, `RibbitRandomNotes`): a control
  source, structurally a processor's sibling (`params`, no per-event trigger)
  but never joins a channel's chain — it exists only to be patched somewhere.
  Two shapes: a **continuous** modulator (`RibbitLFO`) has a bipolar (`-1..1`-
  ish) `output` patched via `RibbitPatch` into an `AudioParam`, with a patch's
  own `depth` deciding how hard it pushes; an **event-generating** modulator
  (`RibbitRandomNotes`) instead implements `generateEvents(fromBeat, toBeat)`
  (called by the clock every tick with an absolute, non-loop-relative beat
  range) and owns `eventDestinations` (channels currently patched to it via
  the reserved `dest=<track>.notes` destination — `RibbitEventPatch`, not
  `RibbitPatch`), delivering generated `RibbitEvent`s straight to
  `destination.source.trigger(...)` — the same call a manually `add_event`'d
  note uses, running alongside it rather than replacing it.
- **`RibbitPatch`**: one connection — `source.output → depthGain → destParam`,
  literally a native Web Audio "connect a node into an AudioParam," which
  *adds* to whatever the destination's own value/ramp already is rather than
  overriding it. `depth` lives on the patch (an `RibbitParam`), not either
  endpoint, so one modulator can drive several destinations at different
  amounts. Source can be a modulator, or any object with an `.output`
  (a track/master's post-fader signal, a processor's post-effect signal).
  Destination is `"name.param"` (e.g. `"reverb.wet"`, `"track_1.gain"`,
  `"lfo1.freq"`), resolved against whatever object exposes that key in its
  own `params`. **`RibbitPatch` is only for continuous signals** — the discrete
  counterpart, `RibbitEventPatch` (destination `"track_1.notes"`, a reserved
  pseudo-param, not a real `params` key), connects an event-generating
  modulator into a track instead: no `AudioParam`, no `depthGain`, no
  `depth` — just bookkeeping (pushes the destination channel onto the
  source's own `eventDestinations`). `nllc.createPatch` branches on the
  destination string (`.endsWith(".notes")`) to build the right class.
- **`RibbitParam`** (`param.js`): the one class every rampable/patchable param
  (channel gain/pan, any processor param, any modulator param, patch depth)
  is built from — wraps one raw `AudioParam`, optional `decode`/`encode`
  (channel gain's exponential taper), `min`/`max` clamp, optional `onSet` for
  a param that fans out across more than one node (`RibbitDelay.time`). One
  shared `commands.js` function (`applyParams`) does get/set/ramp/defer for
  any of them — there is no per-object-kind duplicate of this logic.
- **Options** (the non-rampable counterpart): every synth/processor/
  modulator also has a declarative `this.options` map — `{ key: { get(),
  set(value), choices? } }` — for runtime settings with no `AudioParam`
  behind them (`RibbitOscSynth`/`RibbitLFO.waveform`, `RibbitRandomNotes.scale`,
  `RibbitReverb.duration`/`decay`, `RibbitDelay.stereoOffset`,
  `RibbitSampler.samples`). One declaration drives console set (`applyOptions`
  in `commands.js` — rejects ramp specs, validates against `choices`), help
  text, ghost-text value completion, and session round-tripping: the base
  classes' `getOptions()` is *derived* from this map (same keys the
  constructor accepts back), so subclasses no longer override it.
- **`RibbitClock`**: `setTimeout`-based lookahead scheduler (25ms lookahead, 100ms
  schedule-ahead window), loops every `loopLengthBeats` (default 4) beats — both
  `bpm` and `loopLengthBeats` are runtime-mutable (`/clock bpm= num_beats=`), and
  `bpm` can also be ramped over time (`rampBpm`, via a stepped timer rather than
  native `AudioParam` automation, since bpm isn't one). Treats synths, channels,
  processors, and modulators uniformly as "units" — anything with
  `events`/`automation`/`trigger()`/`active`, plus two optional duck-typed
  hooks: `generateEvents(fromBeat, toBeat)` (event-generating modulators, see
  above) and `onClockStart()` (called by `start()` — a (re)start rewinds
  absolute beats to 0, so a unit with its own absolute-beat state, e.g.
  `RibbitRandomNotes`' candidate cursor, resets it there). Its own `_tick()` is wrapped in a
  try/catch so one bad event/param can only drop a single scheduling pass, never
  permanently kill the engine. Also exposes `nextBeatTime()`/`nextCycleTime()`,
  the anchors for deferred console ramps/instant sets (see below).
- **`RibbitAutomationEvent`**: a parameter ramp targeting a real `AudioParam`
  (`from → to` over `duration` beats, `curve: linear|exponential|target`, `once`
  for non-repeating ramps like a fade-in), matched against loop-relative beat
  position by the clock. Authored from the console via `automate=<param>
  to= [from= beat= duration= curve= once]` on any channel (gain/pan),
  processor, or modulator, listed/removed via
  `automations`/`remove_automation=<n>`/`clear_automation`, and captured in
  `/save`/session files (each console-authored event records its
  `paramKey`, so it serializes by name — see session.js). Distinct from a
  **console ramp** (`/track_1 gain=0 3`),
  which is a one-off `scheduleRamp()` call anchored to an absolute time
  (immediate by default, or the next beat/cycle with `at=beat`/`at=cycle`) and
  never touches a unit's `.automation` array — see `automation.js`. `at=beat`/
  `at=cycle` also works on a plain (non-ramped) instant set, deferring it via
  `setValueAtTime` instead of applying it immediately.
- **Harmony context** (`nllc.harmony`, from `harmony.js`): one shared
  `{ root, scale }` object threaded into every synth. `RibbitEvent.degree` is
  resolved against it *at trigger time* (not when authored), so changing the
  context retunes already-scheduled patterns live. `scale` defaults to
  chromatic (degree ≈ semitone offset); `/harmony root= scale=` changes both
  at runtime (mutating the object in place, never replacing it — synths hold
  a reference). Chord/progression logic on top of this is not built.

## Type registries (extend here, nowhere else, for new types)

`src/ribbit.js`:
```js
const SYNTH_TYPES = { oscsynth: RibbitOscSynth, sampler: RibbitSampler };
const PROCESSOR_TYPES = { reverb: RibbitReverb, delay: RibbitDelay };
const MODULATOR_TYPES = { lfo: RibbitLFO, randomnotes: RibbitRandomNotes, cv: RibbitCV };
```

Non-base implementations live one folder down from `src/`, grouped by
kind — `synths/oscsynth.js`, `synths/sampler.js`; `processors/reverb.js`,
`processors/delay.js`; `modulators/lfo.js` — while the base classes
(`synth.js`, `processor.js`, `modulator.js`, `channel.js`, etc.) stay directly
in `src/`. A new synth/processor/modulator file goes in the matching
subfolder (imports the base class as `../synth`/`../processor`/`../modulator`)
and is registered in `ribbit.js` exactly as above — nothing else needs to change.
There is no folder for buses; a bus is just a plain `RibbitChannel`, not a new
class. *Removing* a type is not that in reverse — see
`docs/llm/removing-types.md`, since docs, code-comment examples, host-app demo
routes, and saved session JSON (which stores a `.type` key that will then fail
to load) all accumulate references over a type's life.

## Sessions and states (`session.js`, full detail: `docs/dev/architecture.md`)

`session.js` (three exports, all closing over a live `Ribbit`, no state of
their own) is the whole-session (de)serialization layer:

- `snapshotSession(nllc)`/`sessionToJSON(nllc)` — a pure JSON snapshot:
  clock/harmony, master/every bus/every track (`params`/`processors`/`sends`;
  a track also its synth's `type`/`options`/`params`/`events`), every
  modulator, every patch. Every rampable value comes from `RibbitParam.get()`.
  Every constructible object (synth/processor/modulator) carries a `.type`
  string (set by `Ribbit.createSynth`/`createProcessor`/`createModulator` —
  the registry key that built it, since nothing else records that after
  construction) and a `getOptions()` result (derived from the object's own
  `options` map — see the object-model section above; the same keys its
  constructor accepts back). Loop-position automation (`.automation` on
  channels/processors/modulators) is captured too, serialized by param
  *name* with user-facing values (`serializeAutomation`/`rebuildAutomation`)
  — the one exception is an automation event built in code against a bare
  `AudioParam` with no `paramKey`, which is skipped; everything the
  console's `automate=` creates round-trips. A rebuilt `once` event fires
  once more after a load/recall.
- `loadSession(nllc, json)` — hard rebuild: tears down every track/bus/
  modulator/patch and master's own processors, then reconstructs via the
  same `nllc.createTrack`/`createBus`/`addProcessor`/`addSend`/
  `createModulator`/`createPatch` the console itself uses. Order: buses/
  tracks (throwaway default send) → real sends once every destination name
  exists → modulators → patches last (name-resolved against everything
  already built). Backs `/load_session` and `/code-editor/demo`'s auto-load
  (same call, just fed a `fetch()`ed static JSON instead of a picked file).
- `applySnapshot(nllc, snapshot, { startTime, durationSeconds })` — the
  diff-and-ramp engine behind `/recall`: matched objects (by `.name`, and
  for processors also `.type`; modulators match on name alone) ramp params via the same
  `scheduleRamp`/`setInstant` (`automation.js`) every console ramp rides; an
  object only in the snapshot is created and its gain/depth ramped up from
  0 (fade-in); an object only live has its gain/depth ramped to 0 and is
  torn down only once that completes (fade-out) — never a hard cut.
  Structural graph changes (create/remove/reorder) can't ride native
  `AudioParam` scheduling, so — like `RibbitClock.rampBpm` already does for
  tempo — they're deferred via `setTimeout` computed from `startTime`, while
  param ramps on the same objects still schedule immediately (a future
  `AudioParam` value doesn't need its node connected yet at schedule time,
  only by the time it fires).

`nllc.states` (`{ name: snapshot }`) holds named snapshots captured by
`/save`; `sessionToJSON` includes it so a whole-session file also restores
what you could `/recall`.

## Command surface (full detail: `docs/user/commands.md`)

`/name key=val ...` where `name` is a top-level command (`start`, `stop`,
`add_track`, `tracks`, `add_bus`, `buses`, `clock`, `harmony`,
`add_modulator`, `modulators`, `patch`, `unpatch`, `patches`, `save`,
`recall`, `remove_state`, `states`, `save_session`, `load_session` — see
[Sessions and states](#sessions-and-states-sessionjs-full-detail-docsdevarchitecturemd)
above), `master`, a track's name, a bus's name, a processor's name, or a
modulator's name. Channels (tracks,
buses, master) support `gain=`, `pan=`, `add_event`, `events`,
`remove_event=`, `clear_events`, `start`,
`stop`, `synth=`, `add_processor=`, `remove_processor=`, `remove_self`, plus
routing: `out=<name>` (replace every current send with a single one to
`<name>`), `add_send=<name>` (optionally `send_gain=<0-1>`, default 1 — add
one more send without disturbing existing ones), `remove_send=<id>`, and
`send=<id>` (optionally `send_gain=<value>`, rampable/`at=` deferrable like
any param — report or adjust one existing send's own gain). A track's/bus's
own default send (created at creation time, or via `out=` with no
destination given) targets `master`. `add_event`/`clear_events`/`start`/
`stop`/`synth=` are no-ops (reported as "\<name\> has no synth") on master and
on any bus, since neither has a `.source`. A track also routes its synth's
own `params` and `options` keys through its name (`/lead waveform=square` —
the synth isn't separately addressable, its channel is its surface).
Processors and modulators support
their own `params` and `options` keys plus `remove_self`, and `help`/no-args
to introspect. Channels, processors, and modulators all take the
loop-automation family: `automate=<param> to= [from= beat= duration= curve=
once]` (beats, loop-relative, replayed every pass — the pattern-position
sibling of a one-off console ramp), `automations` (indexed list),
`remove_automation=<n>`, `clear_automation`. `events` on a track lists its
synth's pattern with indices; `remove_event=<n>` deletes one. `/harmony
[root=] [scale=]` reports/mutates the shared harmony context in place
(retunes playing `degree=` patterns immediately, since degrees resolve at
trigger time).
Every addressable object (channel, processor, modulator) answers no-args with
a condensed one-line summary and `help` with the full reference — every
param's value/range plus every command it accepts, each with a usage note
(`channelHelp`/`paramObjectHelp` in `commands.js`; a param's range is omitted
when it was never given `min`/`max` bounds, e.g. a patch's `depth` —
deliberately unbounded, since a negative depth inverts the modulation).
`/clock` supports `bpm=` (rampable) and `num_beats=` (deliberately not
rampable — rejected with a message if given a ramp spec).

`/add_modulator type=lfo freq=2 name=lfo1` creates a modulator; `/patch
source=lfo1 dest=reverb.wet depth=0.2` patches it into a param (creates and
returns an id like `x1`); `/patch id=x1 depth=0.5` adjusts an existing
patch's depth afterward; `/unpatch id=x1` removes it. Removing a modulator,
track, or processor automatically cascade-removes any patch touching it as
either endpoint.

An event-generating modulator (currently only `randomnotes` —
`/add_modulator type=randomnotes probability=0.7 min_gap=0.5
scale=0,2,4,5,7,9,11 name=rand1`) patches into a track's synth instead of a
param, via the reserved destination `dest=<track>.notes` (e.g. `/patch
source=rand1 dest=track_1.notes`) — no `depth=`, and it runs alongside,
never replacing, whatever `add_event` already put on that track. Only a
`generateEvents`-having source and a `.source`-having destination are
accepted, and a duplicate of an existing `.notes` patch is rejected (it
would only double-fire every generated note); anything else is a clean
error.

`/save`/`/recall` accept a bare leading value as shorthand for `name=`:
`/save 1` ≡ `/save name=1`, `/recall 1 4b at=cycle` ≡ `/recall name=1 4b
at=cycle`. `/save_session`/`/load_session` also have literal aliases
`/save_json`/`/load_json` (same handler; the mixer's Transport bar runs
these via two buttons).

`recall name=<state>` reuses this exact same trailing-duration-on-a-`key=value`
mechanism for its own `name=` param (`recall name=verse1 4b at=cycle`) rather
than inventing a second ramp syntax — `isRamp(params.name)` is true whenever
a duration was given, exactly like any other param.

`gain=`/`pan=`/any processor or modulator param accept a trailing duration to
ramp instead of setting instantly: `gain=0 3` (3 seconds) or `gain=0 4b` (4
beats). Add `at=beat`/`at=cycle` to defer the start to the next beat/loop
boundary instead of firing immediately (default) — this works for a plain
instant set too, not just a ramp (`gain=0 at=beat` jumps to 0 exactly on the
next beat rather than right now). Several `/name ...` commands can be typed
on one submitted line and they all dispatch together, e.g.
`/track_1 gain=0 8 /reverb wet=0.9 6b`. A bad numeric value (e.g.
`bpm=notanumber`) is rejected with a clean error rather than silently
becoming `NaN` and corrupting persistent state; so is an empty value
(`gain=` alone — `Number("")` would coerce to 0), a typo'd channel key
(`/track_1 gian=0.5` reports `unknown param "gian"` rather than printing
the summary), and an invalid object name (names must parse as a `/name`
token — letters/digits/`_`, no dots, which would collide with the
`name.param` patch syntax).

All addressable objects share **one flat name namespace** (the router
dispatches `/name` against commands, then master/tracks/buses/processors/
modulators in order): creation de-duplicates a requested name against every
existing object of every kind *plus* `RESERVED_NAMES` (`ribbit.js` — every
top-level command name and `master`), so nothing can be created already
shadowed and unaddressable. A new top-level command must be added to
`RESERVED_NAMES` (the router `console.warn`s at build time if forgotten).
Two related guards: `/master` refuses `out=` and refuses `remove_send=` of
its speakers send (that edge has no addressable name, so the console could
never wire it back), and `add_event` warns when `beat=` lands at/past the
current loop length (legal — it sounds if `num_beats` is later raised — but
otherwise silent).

## Interface

`src/lib/components/code-editor/SessionPage.svelte` owns the single `Ribbit`
instance (created client-side only, in `onMount`, since `AudioContext` needs
a browser) and the `{ executeCommand, suggest }` pair from
`createCommandRouter(nllc)`. Two route pages are both thin wrappers around
it, differing only in an optional `demoSessionUrl` prop:
`routes/code-editor/+page.svelte` (`<SessionPage />`, a blank session) and
`routes/code-editor/demo/+page.svelte` (`<SessionPage
demoSessionUrl="/sessions/demo.json" />`, which `fetch()`es that static JSON
once the engine exists and calls `session.js`'s `loadSession` on it — the
same call `/load_session` makes with a picked file, minus the file picker).
`routes/+page.svelte` (the homepage) links to both and hosts an audio-options
panel (output device via `navigator.mediaDevices`/`AudioContext.setSinkId`,
`AudioContext`'s `latencyHint`) that writes two `localStorage` keys
(`nllc:audioOutputDeviceId`, `nllc:audioLatencyHint`) — it never constructs
an `AudioContext` itself; `SessionPage` reads those keys in `onMount`, before
constructing `Ribbit({ latencyHint })` (a constructor-time-only option) and
applying the saved device via `setSinkId` right after (feature-detected,
best-effort — an unsupported browser or a since-unplugged device id just
falls back to the platform default).
`CodeEditor.svelte` is the text console. `Mixer.svelte` has a `Transport.svelte`
bar (engine on/off; a clock LED that pulses per beat inside a conic-gradient
ring that sweeps once per loop; beat/bpm readout — polled into local state
so a `/clock` change shows even while stopped; and Save JSON/Load JSON
buttons that run `/save_json`/`/load_json` through the same command path as
typing), then Tracks/Buses/Master side by side in one row (Tracks grows to
fill it and scrolls its own strips once they overflow, rather than pushing
Master onto a second row; Master is fixed-size, never collapsible or
resizable) and Modulators as its own full-width row below (collapsible, not
resizable). `MixerSection.svelte` is the shared collapse/resize chrome
around each of those four titled panels — it owns no domain content itself,
just whatever's passed as children. Titled sections show "none" when empty
except Master. Actual content: `MixerChannel.svelte` (one per track, one per
bus, plus master — a bus needs no changes to this component since it only
ever touches `gainNode`/`pan`/`processors`, all present on any
`RibbitChannel`; active processor-chain inserts render in the accent color,
bypassed ones dim/struck-through; a small pulsing dot appears next to
"gain"/"pan" when a patch is currently modulating that param; below the
inserts, a read-only list of the channel's sends with live gains, each
click-to-pasting `send=<id> send_gain=` into the console),
`ModulatorStrip.svelte` (one per modulator, with a live bipolar meter — an
event-generating modulator like `randomnotes` instead gets a "notes" dot
that lights on each delivered note, driven by the `lastEventTime` timestamp
the clock records on it, since its continuous `.output` is meaningless),
and `PatchList.svelte` (every active patch,
with its live depth and a remove control — "generated notes" in place of a
depth for an `RibbitEventPatch`, which has none) — all polled, read/write
views onto the same live audio-graph objects (fader ↔ `channel.params.gain`,
pan dial ↔ `channel.params.pan`, etc.). A track/bus strip (not master) also
has its own remove (×) button, mirroring `ModulatorStrip`'s, wired to
`nllc.removeTrack`/`removeBus` — the mixer's one other removal affordance
beyond `remove_self` on the console.
Console and mixer are two UIs on one shared state, not separate stores.
Routing *changes* (`out=`/`add_send=`/`remove_send=`) stay console-only —
the mixer's send badges display and tee up commands but don't mutate,
same scope choice already made for modulators/patches. `CodeEditor.svelte` also
owns command history (↑/↓ recall, shell-style) and exposes an
`insertAtCursor(text)` component export (reached via `bind:this` from
`SessionPage.svelte`, threaded down through `Mixer`/`MixerChannel`/`ModulatorStrip`
as an `onInsert` prop) — clicking a name or param label anywhere in the mixer
pastes it into the console at the current cursor. A processor's insert badge
keeps plain-click as its existing bypass toggle and layers shift+click on top
for "paste this id" instead of replacing it.

`CodeEditor.svelte` also renders contextual ghost-text completion, driven by
`suggest(input, cursorPos)` (`commands.js`'s `suggestCompletion`). Works
anywhere the cursor sits, not just at the end of the input (accepting
mid-line pushes later text over rather than only ever appending — the real
`<input>`'s glyphs are `color: transparent`, so the ghost overlay is the only
visible text layer, which is what makes this possible). Completes three
token shapes: the `/name` token itself (any addressable object or top-level
command); once past the name, a bare param key for whatever
channel/processor/modulator it resolves to; or, once a key's `=` has at
least one character typed after it, its *value* — but only for keys with a
small enumerable candidate list (`synth=`, `type=`, `at=`,
`add_processor=`, an existing object name for `out=`/`add_send=`/`source=`/
`dest=`, an existing state/patch/send id); an open-ended value (a number, a
freshly-chosen name) is left alone, and a **zero-character** value
deliberately suggests nothing (typing `type=` alone shows no suggestion) —
without that guard, pressing Enter right after `=` would silently accept
whichever candidate is listed first (e.g. `lfo`, the first
`MODULATOR_TYPES` key) instead of whatever was actually about to be typed.
There's no ranking/cycling among several matches, just the first one that
extends what's typed. Right arrow accepts a shown suggestion into the input;
Enter accepts *and* submits in one step. `↑`/`↓` normally recall command
history, but only when the input is empty (or mid-recall already) —
otherwise they're reserved for a not-yet-built suggestion-cycling feature
and do nothing.

## Known current limitations (don't assume otherwise)

- Ribbit has no natural-language layer — that lives in the host app (the NLLC
  reference app keeps an `Ollama()` stub for it; no NL-to-command wiring exists yet).
- Manual event authoring (`add_event`/`events`/`remove_event`/
  `clear_events`) and algorithmic generation coexist: an event-generating
  modulator (`randomnotes` today) can patch into a track's `.notes` and
  feed it a continuous stream of generated notes alongside — never
  replacing — a synth's manually-authored `events`. Still missing: any
  *other* kind of algorithmic generator (euclidean rhythms, step-string
  parsers, etc. — only probability/min-gap/scale-based random generation
  exists so far). No per-cycle/every-N-cycle regeneration hook exists
  either, though the clock's uniform "unit" contract would be the natural
  place to add one (an optional `onCycle(cycleIndex)` called at loop
  boundaries) if/when that's built — `generateEvents(fromBeat, toBeat)`'s
  own absolute-beat design already sidesteps needing this for
  probability-based generation specifically, since it isn't loop-relative
  at all.
- The harmony context is a live key/scale (`/harmony root= scale=`), not a
  full harmony *system* — no chords, progressions, or per-track scale
  overrides, just the one shared context every `degree=` resolves against.
- Neither synth type currently exposes any rampable `params` of its own
  (their runtime surface is options — `waveform`, `samples`); the
  `channelCommand` routing for synth params exists and is exercised the
  moment a synth declares one, but no ramping of synth-level values is
  demonstrable today.
- `/save`/session files capture loop automation by param name — but an
  `RibbitAutomationEvent` constructed in code against a bare `AudioParam`
  (no `paramKey`) is skipped, and a rebuilt `once` event fires once more
  after a load/recall.
- `/recall` matches modulators by name only (processors by name+type; a
  type-changed *track* synth is swapped back properly) — a modulator whose
  name survived but whose type changed since the save keeps its live type,
  with saved params/options applied only where the names still fit.
- `RibbitSampler` sample loading is unawaited fire-and-forget; a trigger before load
  completes silently no-ops (also true after a runtime `samples=` swap).
- `splitCommands` (multi-command-per-line) assumes no param value contains a
  literal `/`; none currently do, but a value that did would be mis-split.
- Ramping/deferred `at=` scheduling/loop automation on a multi-node param
  (`RibbitDelay`'s `time`/`feedback`) only animates the "primary" node
  directly — the other node (e.g. delay's R side) only gets updated
  correctly by a plain, immediate (non-ramped, non-deferred) instant set.
  Pre-existing limitation, unchanged by the `RibbitParam` consolidation.
- Send routing (`out=`/`add_send=`) only guards against a channel sending
  directly to itself (`addSend` throws) — a longer cycle (e.g. `bus1` sends to
  `bus2`, which sends back to `bus1`) isn't detected. Native Web Audio permits
  cycles only when a `DelayNode` sits somewhere in the loop; a pure-gain cycle
  is undefined/implementation-behavior rather than a clean error. Not
  currently validated.
- Everything is stereo (`RibbitChannel`'s pan uses a `StereoPannerNode`, which is
  always 2-channel in/out). Nothing else in the signal path hardcodes a
  channel count — `GainNode`s and sends adapt to whatever arrives — so mono
  channels or L/R-targeted sends aren't architecturally blocked, just not
  built: they'd need the panner made optional/pluggable per channel, and a
  send variant that routes through a `ChannelSplitterNode`/`ChannelMergerNode`
  pair instead of straight into `destination.input`.

## Detailed docs

- `docs/user/` — tutorial, full command reference, synth/processor/modulator
  reference.
- `docs/dev/` — architecture, file-by-file source walkthrough, tutorials for
  adding a synth/processor/modulator/command, and `removing-a-type.md` for
  taking one back out.
- `docs/llm/building-synths.md`, `building-processors.md`,
  `building-modulators.md`, `adding-commands.md` — condensed, code-skeleton
  versions of the `docs/dev` tutorials for use as LLM context when the task is
  specifically "add a new X". `removing-types.md` is the counterpart for
  "remove an existing X".
