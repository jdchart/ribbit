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
├── groups: RibbitGroup[]      named sets of other objects' names; hold no audio (group.js)
├── recorder: RibbitRecorder   audio capture to downloadable WAV; not a clock unit (recorder.js)
└── states: {name: snapshot}      named snapshots captured by /save, applied by /recall (session.js)
```

Lifecycle: `start()`/`stop()` resume/suspend the context and start/stop the
clock (what `/start` and `/stop` call); `dispose()` is the permanent
counterpart, for a host discarding the engine — it stops the clock, calls the
duck-typed `dispose()` on every live synth/modulator, cancels every
in-flight deferred timer (`ribbit._deferredTimers`, populated by
`automation.js`'s `scheduleAt` — see below), and `close()`s the
`AudioContext`, returning that promise. It matters because neither the context
nor the clock's self-rescheduling `setTimeout` is owned by the object graph:
dropping the last reference to a `Ribbit` does *not* stop it making sound, so
a host that unmounts without calling `dispose()` leaves the session audibly
running (this is exactly what `SessionPage.svelte`'s `onMount` cleanup is for).

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
  **Mute and solo** are also here. `muteGain` sits between the panner and
  `gainNode`, so muting is *not* "set gain to 0": the fader keeps its position
  and its saved value, an in-flight gain ramp keeps running underneath, and
  because the node is upstream of `gainNode` the sends go quiet with it.
  `setMuted`/`setSoloed` set a flag and call `_applyAudible()`, the one place
  that decides (`audible = !muted && !_soloSilenced`) and ramps `muteGain` over
  10ms to avoid a click. Solo can't be applied locally, so `setSoloed` calls
  `Ribbit.updateSolo()` through the channel's `engine` back-reference:
  that walks the **sends graph** in both directions from every soloed channel
  and silences only what can neither reach a soloed channel nor be reached from
  one, which is what keeps a soloed track's reverb bus (and a soloed bus's
  feeder tracks) alive. Master is never silenced by solo and refuses `solo`.
- **`RibbitSynth`** (base of `RibbitOscSynth`, `RibbitSampler`,
  `RibbitPercSampler`, `RibbitKarplus`, `RibbitGranular`): produces sound. Has
  `events` (`RibbitEvent{beat,pitch,degree,velocity,duration}` — starts **empty**,
  populated via `add_event`), a `trigger(time, event, secondsPerBeat)` method the
  clock calls per-event, an `output` GainNode, `harmony` (the shared context, see
  below), and an `active` flag (transport pause, distinct from routing bypass).
- **`RibbitProcessor`** (base of `RibbitReverb`, `RibbitDelay`,
  `RibbitCompressor`, `RibbitSaturator`, `RibbitTilt`, `RibbitSVF`,
  `RibbitComb`, `RibbitLimiter`,
  `RibbitGoodenizer`): effects, continuously
  in a channel's signal chain (no per-event trigger). Has `input`/`output`
  GainNodes, `params` (`{name: RibbitParam}`) as its console-facing control
  surface, and `active` as a *routing bypass* (handled by the owning channel).
  Two things live on the base class for the dynamics/tone processors.
  `createCrossfade(mix)` builds a **true** dry/wet fade (dry = 1 - mix)
  rather than reverb/delay's dry-at-unity-plus-wet — the distinction is
  whether a processor *adds* to a signal or *acts on* it, and a compressor
  whose dry path runs at unity can never tame a peak. It drives both gains
  from one `ConstantSourceNode` offset (once directly, once through a -1
  inverter, both summing onto the gains' intrinsic values) specifically so a
  *ramp* moves both sides — `RibbitParam`'s `onSet` only overrides the
  instant-set path. **No shipped param uses `onSet` any more**: `RibbitDelay`'s
  `time`/`feedback` were the last two and are now constants summed into both
  delay lines (with `stereoOffset` a second constant added to the R side, which
  is why an offset needed a summed node rather than a scaler).
  `dispose()` is the duck-typed teardown a synth/modulator already
  had, now called by `removeProcessor`/`Ribbit.dispose`: those
  `ConstantSourceNode`s are running sources reaching `audioContext
  .destination` through their own muted sinks, so unwiring a processor from
  a chain doesn't stop them.
  **`RibbitGoodenizer` is the one composite** — it builds a compressor,
  saturator, tilt and limiter, chains them, and republishes their *actual*
  `RibbitParam`/option objects under its own `params`/`options`. The children
  are constructed directly rather than via `createProcessor`, so they're
  never registered, never addressable, and never in an insert chain. Nothing
  is reimplemented, so `/glue threshold=` and a standalone `/compressor
  threshold=` cannot drift.
- **`RibbitModulator`** (base of `RibbitLFO`, `RibbitCV`, `RibbitRandomNotes`,
  `RibbitMarkovPercs`, `RibbitEuclidPercs`, `RibbitPatternVariator`,
  `RibbitChorale`, `RibbitRandomGestures`): a
  control source, structurally a processor's sibling (`params`, no per-event
  trigger) but never joins a channel's chain — it exists only to be patched
  somewhere.
  Three shapes: a **continuous** modulator (`RibbitLFO`, `RibbitCV` — the
  latter a `ConstantSourceNode` holding one unbounded, rampable/automatable
  `value` that never moves on its own, the minimal implementation of the base
  class) has a bipolar (`-1..1`-
  ish) `output` patched via `RibbitPatch` into an `AudioParam`, with a patch's
  own `depth` deciding how hard it pushes; an **event-generating** modulator
  (`RibbitRandomNotes`, `RibbitMarkovPercs`, `RibbitEuclidPercs`,
  `RibbitPatternVariator`) instead implements
  `generateEvents(fromBeat, toBeat)`
  (called by the clock every tick with an absolute, non-loop-relative beat
  range) and uses `eventDestinations` (channels currently patched to it via
  the reserved `dest=<track>.notes` destination — `RibbitEventPatch`, not
  `RibbitPatch`), delivering generated `RibbitEvent`s straight to
  `destination.source.trigger(...)` — the same call a manually `add_event`'d
  note uses, running alongside it rather than replacing it.
  The third shape is **session-acting** (`RibbitRandomGestures`, the only one):
  it publishes nothing and is patched nowhere. It holds `engine` (injected by
  `createModulator` the way `harmony` is injected into a synth), implements the
  clock's `onSchedule(fromBeat, toBeat, secondsPerBeat, clock)` hook, and ramps
  other objects' `AudioParam`s directly via `scheduleRamp`. Its eligible set is
  exactly `RibbitParam.canRandomize` — the same params bulk `/<object> random`
  touches — so `<param>.r=false` opts out of both at once.
  Two things live on the **base** class for every modulator, event-generating
  or not: `eventDestinations` (an empty array — `patch.js` and
  `Ribbit._createEventPatch` index into it directly, so a generator that forgot
  to initialize it failed at patch time with an unattributable "cannot read
  properties of undefined") and `_stride()`, which asks the patched destination
  how many sample slots one drum category occupies (`RibbitPercSampler`
  publishes `slotsPerCategory`) and falls back to the subclass's own
  `per_category`. `_stride` describes the *destination*, not the generation
  strategy, which is why all three percussion generators share one copy and why
  a pattern written for a 4-slot kit sounds identical on a 1- or 8-slot one.
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
  **Two readers, and the distinction matters:** `get()` is the *intrinsic*
  value (display, `/save`), `getModulated()` is the value including patches
  (anything acting on it at trigger time). See the JS-read entry under
  "Engine limitations".
- **`RibbitParamSources`** (`param.js`): the factory for a param that wants
  `RibbitParam`'s whole surface (ramp/`at=`/`automate=`/be a `/patch`
  destination) but has no `AudioParam` in the audio graph to hang off —
  `RibbitRandomNotes.probability`, `RibbitMarkovPercs.swing`,
  `RibbitEuclidPercs.dropout`, `RibbitPercSampler.pan_spread`. It invents one
  from a `ConstantSourceNode`'s `.offset`, and exists as a shared class
  because of a Web Audio quirk that isn't obvious: a node with no path into
  the rendered graph can have its `setValueAtTime` automation silently never
  reflected in later `.value` reads, so each source must be routed through a
  muted (`gain: 0`) sink into `audioContext.destination`. Usage is
  `this._paramSources = new RibbitParamSources(audioContext)`, then
  `this._paramSources.create(value, { min, max })` per param, and
  `this._paramSources.dispose()` from the owner's own `dispose()` (required —
  those sinks aren't reachable from `this.output`).
- **Options** (the non-rampable counterpart): every synth/processor/
  modulator also has a declarative `this.options` map — `{ key: { get(),
  set(value), choices? } }` — for runtime settings with no `AudioParam`
  behind them (`RibbitOscSynth`/`RibbitLFO.waveform`, `RibbitRandomNotes.scale`,
  `RibbitReverb.duration`/`decay`, `RibbitDelay.stereoOffset`,
  `RibbitSampler.samples`). One declaration drives console set (`applyOptions`
  in `commands.js` — rejects ramp specs, validates against `choices`, defers
  via `runAt` when `at=` is given), help text, ghost-text value completion,
  and session round-tripping: the base classes' `getOptions()` is *derived*
  from this map (same keys the constructor accepts back), so subclasses no
  longer override it.
  **Non-rampable does not mean non-schedulable**: an option can't be ramped
  (there's no curve to draw, and a half-applied waveform is meaningless) but
  it can be deferred to a boundary like anything else. Choosing param vs.
  option is a question about whether *sweeping* the value is musical, not
  about whether it can be scheduled.
- **`RibbitClock`**: `setTimeout`-based lookahead scheduler (25ms lookahead, 100ms
  schedule-ahead window), loops every `loopLengthBeats` (default 4) beats — both
  `bpm` and `loopLengthBeats` are runtime-mutable (`/clock bpm= num_beats=`), and
  `bpm` can also be ramped over time (`rampBpm`, via a stepped timer rather than
  native `AudioParam` automation, since bpm isn't one). Treats synths, channels,
  processors, and modulators uniformly as "units" — anything with
  `events`/`automation`/`trigger()`/`active`, plus four optional duck-typed
  hooks: `generateEvents(fromBeat, toBeat)` (event-generating modulators, see
  above), `onSchedule(fromBeat, toBeat, secondsPerBeat, clock)` (the same
  absolute beat range, for a unit that acts on the session rather than
  producing events — `RibbitRandomGestures` is the only consumer, and gets the
  clock so it can turn a beat into a precise time to schedule a ramp at),
  `onClockStart()` (called by `start()` — a (re)start rewinds
  absolute beats to 0, so a unit with its own absolute-beat state, e.g.
  `RibbitRandomNotes`' candidate cursor, resets it there), and
  `onCycle(cycleIndex)` (called when a new loop index is first scheduled — the
  hook for "change something every N cycles", e.g. regenerating a pattern).
  `onCycle` fires one lookahead window *before* that cycle's events are read,
  which is what a regenerating unit needs; `cycleIndex` is monotonic but **not
  necessarily contiguous**, since a stall skips cycles rather than replaying
  them (regenerating for cycles nobody will hear is worse than landing on the
  current one). **No shipped type consumes `onCycle` yet** — every generator
  indexes `generateEvents` straight off the absolute beat, which sidesteps
  needing it, and `patternvariator` deliberately regenerates only on reseed.
  (`onSchedule`, added alongside it, does have a consumer.) Its own `_tick()` is wrapped in a
  try/catch so one bad event/param can only drop a single scheduling pass, never
  permanently kill the engine. Also exposes `nextBeatTime()`/`nextCycleTime()`,
  the anchors for deferred console ramps/instant sets (see below).
- **`RibbitAutomationEvent`**: a parameter ramp targeting a real `AudioParam`
  (`from → to` over `duration` beats, `curve: linear|exponential|target`, `once`
  for non-repeating ramps like a fade-in), matched against loop-relative beat
  position by the clock. Authored from the console via `automate=<param>
  to= [from= beat= duration= curve= once]` on any channel (gain/pan **and a
  track's synth's own params**, via `addressableParams()`), processor, or
  modulator, listed/removed via
  `automations`/`remove_automation=<n>`/`clear_automation`, and captured in
  `/save`/session files (each console-authored event records its
  `paramKey`, so it serializes by name — see session.js). Distinct from a
  **console ramp** (`/track_1 gain=0 3`),
  which is a one-off `scheduleRamp()` call anchored to an absolute time
  (immediate by default, or the next beat/cycle with `at=beat`/`at=cycle`) and
  never touches a unit's `.automation` array — see `automation.js`.
- **`at=beat` / `at=cycle` is universal, with exactly one exception.** It is a
  property of *when a command takes effect*, not of whether the thing being
  changed is rampable, and **every mutating command honors it** — a param ramp,
  a plain instant set, an option (`/rhy seed=20 at=cycle`), `/harmony root=`, a
  track's `start`/`stop`, `synth=`, routing (`out=`/`add_send=`/
  `remove_send=`), `add_processor=`/`remove_processor=`, event editing
  (`add_event`/`remove_event=`/`clear_events`), the `automate=` family,
  `remove_self`, `/patch`/`/unpatch`, `/save`/`/remove_state`, and
  `/start`/`/stop`. Read-only listing commands have nothing to schedule.
  **The exception is object creation** — `/add_track`, `/add_bus`,
  `/add_modulator` **refuse `at=` with an error** (`refusesAt` in
  `commands.js`). Everywhere else `at=` answers "when should this change take
  effect", but a creation's effect is *a name starting to exist*: a deferred
  creation can't report the name it will get (which is the command's entire
  output, and auto-generated names aren't known until construction), isn't
  addressable by a later command on the same line
  (`/add_track name=x at=cycle /x gain=0.5` silently half-works), and isn't
  audible anyway, since a fresh track/bus/modulator makes no sound until
  something is wired into it. Create now, defer the wiring — `/patch`,
  `add_processor=` and `start`/`stop` all take `at=`, and that was the useful
  gesture all along. Refusing loudly, rather than silently dropping it, is the
  same principle that motivated making `at=` universal in the first place.
  Three mechanisms sit behind that one keyword, picked by what's being
  changed: an `AudioParam` ramp gets `scheduleRamp`, a plain param set gets
  `setValueAtTime` (`setInstant`), and everything else — options, structural
  changes — gets `commands.js`'s `runAt`, which defers via `automation.js`'s
  `scheduleAt` timer.
  Two consequences worth knowing. **Validation happens before the defer,
  never inside it** (`/rhy style=nonsense at=cycle` is an ordinary command
  error, and unknown `synth=`/`add_processor=` types are checked eagerly
  rather than left to the constructor to throw) — a throw from a bare timer
  has no command left to report to. And a deferred command returns a "will
  happen" line immediately, then reports what actually happened later through
  `ribbit.notify()` (see below), including failures.
- **Harmony context** (`nllc.harmony`, from `harmony.js`): one shared
  `{ root, scale }` object threaded into every synth. `RibbitEvent.degree` is
  resolved against it *at trigger time* (not when authored), so changing the
  context retunes already-scheduled patterns live. `scale` defaults to
  chromatic (degree ≈ semitone offset); `/harmony root= scale=` changes both
  at runtime (mutating the object in place, never replacing it — synths hold
  a reference). Chord/progression logic on top of this is not built.

## Type registries (extend here, nowhere else, for new types)

**`docs/llm/catalog.md` is the short list of every registered type with its
params and options, plus a "which one to copy" table** — read that before
opening any source file, and update it whenever a type is added or removed.

`src/ribbit.js`:
```js
const SYNTH_TYPES = { oscsynth: RibbitOscSynth, sampler: RibbitSampler, percsampler: RibbitPercSampler, karplus: RibbitKarplus, granular: RibbitGranular, tapepad: RibbitTapePad, chaossynth: RibbitChaosSynth, czsynth: RibbitCZSynth };
const PROCESSOR_TYPES = { reverb: RibbitReverb, delay: RibbitDelay, compressor: RibbitCompressor, saturator: RibbitSaturator, tilt: RibbitTilt, svf: RibbitSVF, comb: RibbitComb, limiter: RibbitLimiter, goodenizer: RibbitGoodenizer };
const MODULATOR_TYPES = { lfo: RibbitLFO, randomnotes: RibbitRandomNotes, cv: RibbitCV, markovpercs: RibbitMarkovPercs, euclidpercs: RibbitEuclidPercs, patternvariator: RibbitPatternVariator, chorale: RibbitChorale, randomgestures: RibbitRandomGestures };
```

Non-base implementations live one folder down from `src/`, grouped by
kind — `synths/oscsynth.js`, `synths/sampler.js`; `processors/reverb.js`,
`processors/delay.js`; `modulators/lfo.js` — while the base classes
(`synth.js`, `processor.js`, `modulator.js`, `channel.js`, etc.) stay directly
in `src/`. A new synth/processor/modulator file goes in the matching
subfolder (imports the base class as `../synth`/`../processor`/`../modulator`)
and is registered in `ribbit.js` exactly as above — nothing else needs to change.
There is no folder for buses; a bus is just a plain `RibbitChannel`, not a new
class.

**Three** types carry a **host contract** beyond the registry, and they have
the same shape — a browser can't list a directory over HTTP, so anything that
chooses from the host's library needs the host to publish what there is to
choose from. `RibbitPatternVariator` is one; see the pattern-format section
below. The other two are the sample readers: `RibbitPercSampler` fills its kit
at random, and `RibbitGranular` picks one source recording at random, both
from GET `/samples/manifest.json` (overridable per instance via the
`manifest_url` constructor option) returning `{ kicks: [...], snares: [...],
hats: [...], percs: [...], <any other folder>: [...] }`, each entry a path
relative to the same `/samples/` prefix the audio files are served under. The
four percussion categories are always present because percsampler's slot
arithmetic depends on them; **every other folder is free-form**, so adding
`static/samples/<folder>/` is the whole workflow for a new granular source
library. In NLLC that's `src/routes/samples/manifest.json/+server.js`.
A missing manifest degrades to an empty kit / no source plus a
`console.warn`, never a throw.
**Both readers go through `src/samples.js`** (`fetchSampleManifest`,
`resolvedSampleManifest`, `sampleName`, `sampleUrl`) rather than fetching
themselves — the samples counterpart to `pattern.js`. Both of those sit on
**`src/library.js`**, which owns the two things they'd otherwise each copy:
`createLibraryCache()` (per-URL caching in both promise *and* resolved form —
the latter so a re-roll completes *synchronously* and the console echoes what
it just chose rather than what it replaced) and `libraryUrl()`, which
deliberately avoids bare `encodeURIComponent` — that escapes characters legal
in a path segment, so a `,` becomes `%2C` and 404s against a static file
server. The copies had already drifted once; there is now one.
*Removing* a type is not that in reverse — see
`docs/llm/removing-types.md`, since docs, code-comment examples, host-app demo
routes, and saved session JSON (which stores a `.type` key that will then fail
to load) all accumulate references over a type's life.

## Patterns (`pattern.js`)

A **pattern** is a hand-written musical fragment — a drum rhythm, a chord
progression, a melody — living as JSON in the host's static folder and read by
`RibbitPatternVariator`. It is deliberately *not* a saved session: a session is
a whole graph captured by the engine, while a pattern is source material a
human types into a text editor. That difference drives every choice in the
format — it optimizes for **being written by hand**, not for round-tripping.

One grid, two token languages, selected by `kind`. There is no third kind for
melodies: a melody is a `notes` pattern with one degree per step.

```json
{ "name": "boom bap", "kind": "drums", "step_beats": 0.25,
  "lanes": { "kicks":  "x... ..x. ..x. ....",
             "snares": ".... x... .... x...",
             "hats":   "x.x." } }

{ "name": "minor drift", "kind": "notes", "step_beats": 1, "duration": 2,
  "sequence": ["0,3,7", ".", "-4,0,3", ".", "3,7,10", ".", "-2,2,5", "."] }
```

- **`drums`** — one character lane per `PERC_CATEGORIES` entry. `x` hit, `X`
  accent, `g` ghost, `0`-`9` a specific variant slot within the category,
  `.`/`-`/`_`/`~` rest, and **spaces are ignored entirely** so a bar can be
  grouped visibly. Slots resolve through `_stride()`, so this drives a
  `percsampler` including a split kit.
- **`notes`** — one token per step, a token being comma-separated scale
  degrees (`"0,3,7"` a triad, `"0"` a single note, `"."` a rest). Degrees
  resolve against the shared harmony context at *trigger* time, so `/harmony`
  retunes a loaded pattern live.
- **Each lane cycles at its own length.** `"hats": "x.x."` spans a 16-step
  pattern by repeating, and a 6-step lane against a 16-step one gives
  polymeter for free — you write only as much as a part actually needs.
- **`steps` is inferred** from the longest lane (or the sequence) unless
  declared, so there's no count to silently desync from the thing it describes.
- Parsing is **tolerant on input, strict on error**: several rest characters
  are accepted and lanes may differ in length, but an unparseable token throws
  with the offending text quoted — a silently-dropped note in a hand-edited
  file is the failure mode that wastes an afternoon.

**Host contract:** `GET /patterns/manifest.json` → `{ <pack>: ["<pack>/<name>.json", ...] }`,
each entry relative to the same `/patterns/` prefix the files are served under.
Deliberately the same shape as `/samples/manifest.json` — one rule to learn,
not two. The one difference is that pack names are *not* fixed (sample
categories map onto percsampler's four hardcoded slot groups; a pack is just a
folder), so adding a directory is the whole workflow. Reference implementation:
`nllc/src/routes/patterns/manifest.json/+server.js`. Manifests and parsed
patterns are cached per URL, both as promise and resolved form, for the same
reason `percsampler` does it: a live re-roll must complete synchronously or the
console echoes the pattern it just replaced.

## Sessions and states (`session.js`, full detail: `docs/dev/architecture.md`)

`session.js` (three exports, all closing over a live `Ribbit`, no state of
their own) is the whole-session (de)serialization layer:

- `snapshotSession(nllc)`/`sessionToJSON(nllc)` — a pure JSON snapshot:
  clock/harmony, master/every bus/every track (`params`/`processors`/`sends`;
  a track also its synth's `type`/`options`/`params`/`events`), every
  modulator, every patch, and every group (`{name, members}`). A channel's
  `muted`/`soloed` are written **only when true**, and `groups` is omitted
  when empty, so a session that uses neither serializes byte-identically to
  how it did before they existed. `_soloSilenced` is never written: it's
  derived from everyone else's `soloed` and recomputed on load.
  Every rampable value comes from `RibbitParam.get()`.
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
  exists → modulators → patches → groups last (both name-resolved against
  everything already built). Any object whose requested name was already taken
  (a duplicate in the file, or a reserved command name — `_uniqueName`
  de-duplicates past both) is recorded in a **rename map**, and every later
  reference to it — a send's destination, a patch's endpoints, a group's
  members — is rewritten through it, with a `notify()` saying so. A `/save`d
  state inside the same file is a whole nested snapshot reconciled by name at
  `/recall` time and is *not* rewritten. Backs `/load_session` and `/code-editor/<slug>`'s auto-load
  (same call, just fed a `fetch()`ed static JSON instead of a picked file).
  Both this and `applySnapshot` first call `assertKnownTypes`, which checks
  every `.type` in the snapshot against the live registries and throws
  listing all unknown ones at once **before anything is built or torn
  down** — neither rebuild path is atomic, so without it one dead type
  (the normal consequence of removing a shipped type) would throw halfway
  through and leave a graph that is neither the old session nor the new
  one. It's a clean failure, not a recovery: there's no lenient/partial
  load, so such a file stays unloadable until the JSON is hand-edited.
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
  only by the time it fires). That deferral goes through
  `automation.js`'s `scheduleAt(ribbit, time, fn)`, which — unlike its
  siblings `scheduleRamp`/`setInstant`, which take a bare `audioContext` —
  takes the whole engine, because it needs an *owner*: everything else in
  that module hands work to the browser's audio thread where closing the
  context cancels it, but a `setTimeout` survives `dispose()` and would
  otherwise fire against a closed context. It registers its timer id in
  `ribbit._deferredTimers` (self-removing when it fires) so `dispose()` can
  cancel it.

`nllc.states` (`{ name: snapshot }`) holds named snapshots captured by
`/save`; `sessionToJSON` includes it so a whole-session file also restores
what you could `/recall`.

A session file may also carry a **`readme`** — an array of lines (or one
`\n`-joined string) describing what the session is and which commands to try.
`loadSession` normalizes it onto `ribbit.readme` and pushes it through
`ribbit.notify(..., "readme")` once the graph exists, so it prints in the host
console on open; `sessionToJSON` writes it back out, so `/save_json`
round-trips it. It is deliberately **not** part of `snapshotSession` — it
describes the session as a document, so a `/save`'d state carries no copy —
and `clearSession` resets it, so loading a file without one can't leave the
previous session's attached.

**Host message channel.** `ribbit.onMessage` is an optional host-supplied
`(text, kind) => void`; `ribbit.notify(text, kind = "deferred")` calls it, or
falls back to `console.log`. It exists because not all output can be the
return value of a command: deferred `at=` work reports back long after its
command returned (`kind: "deferred"`), and a session auto-loaded from a URL
never had a command at all (`kind: "readme"`). Without it, a deferred failure
would vanish silently — worse than an immediate one, since the user has
already been told the change was scheduled.

## Command surface (full detail: `docs/user/commands.md`)

`/name key=val ...` where `name` is a top-level command (`start`, `stop`,
`add_track`, `tracks`, `add_bus`, `buses`, `clock`, `harmony`,
`add_modulator`, `modulators`, `patch`, `unpatch`, `patches`, `add_group`,
`groups`, `record`, `stop_record`, `save_record`, `clear_record`, `recording`,
`save`,
`recall`, `remove_state`, `states`, `save_session`, `load_session` — see
[Sessions and states](#sessions-and-states-sessionjs-full-detail-docsdevarchitecturemd)
above), `master`, a track's name, a bus's name, a processor's name, a
modulator's name, or a group's name. Channels (tracks,
buses, master) support `gain=`, `pan=`, `mute`/`unmute`, `solo`/`unsolo`
(master refuses `solo`; both also take an explicit value, so `mute=false` is
`unmute`), `add_event`, `events`,
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
to introspect.
A **group** (`/add_group name=drums members=kick,snare,hats`) is a name
standing for several other names. `groupCommand` consumes only `members=`,
`add_member=`, `remove_member=`, `remove_self` and `help`, and forwards every
other key — `at=` included — verbatim to each member's own handler via the
router's `objectHandler`, so `/drums gain=0 4b at=cycle` fades all of them on
one boundary and `/drums random` rolls all of them. It has no per-command
knowledge of what it forwards, which is why groups work with commands written
before they existed. Members are **names**, resolved fresh per command (so a
group survives a `/recall` that rebuilds a member; one that no longer resolves
prints as `(missing)`), may name another group (cycles are entered once), and
are validated at `add_group`/`members=` time rather than at use. Channels, processors, and modulators all take the
loop-automation family: `automate=<param> to= [from= beat= duration= curve=
once]` (beats, loop-relative, replayed every pass — the pattern-position
sibling of a one-off console ramp), `automations` (indexed list),
`remove_automation=<n>`, `clear_automation`. `events` on a track lists its
synth's pattern with indices; `remove_event=<n>` deletes one. `/harmony
[root=] [scale=]` reports/mutates the shared harmony context in place
(retunes playing `degree=` patterns immediately, since degrees resolve at
trigger time).
Every addressable object (channel, processor, modulator) answers no-args with
a condensed one-line summary and `help` with the full reference. An object
may also implement an optional duck-typed `describeState()`, appended to that
summary line, for state that is neither a param nor an option
(`RibbitMarkovPercs` prints its generated pattern, e.g. `.sk.HhshSp.s...k`,
since its options only describe how the rhythm was derived). A **synth** can
implement it too — `channelSummary` reaches it through `channel.source`, since
a synth isn't separately addressable — which is how a `granular` track reports
the recording it randomly landed on. Then — every
param's value/range plus every command it accepts, each with a usage note
(`channelHelp`/`paramObjectHelp` in `commands.js`; a param's range is omitted
when it was never given `min`/`max` bounds, e.g. a patch's `depth` —
deliberately unbounded, since a negative depth inverts the modulation).

**Randomizing.** Any param takes the literal value `random` in place of a
number (`/lead cutoff=random`), drawn uniformly from its declared range;
line-level `min=`/`max=` narrow it, either alone falling back to the param's
own bound. It resolves in `applyParams` before the ramp/instant branch, so it
ramps (`cutoff=random 4b`) and defers (`at=cycle`) like any other value — the
draw happens at command time, so a deferred one reports its actual number.
The bare flag `random` on any object rolls every included param at once
(`randomizeAll` synthesizes an all-`random` input and reuses `applyParams`);
`random=4b` ramps the whole roll. On a channel it covers `addressableParams`
— the channel's params *and* its synth's. Per-param inclusion is the `.r`
attribute (`/lead cutoff.r=false`), the only dotted key the grammar accepts,
persisted as `no_random` (see `session.js`). A param needs `min` *and* `max`
finite to be drawable at all: only `patch.depth`, `cv.value` and a send's
`gain` fail that, and naming one explicitly errors with a request for bounds.
Channel `gain` is the only param that ships `randomizable: false`. Options are
excluded entirely — they have their own `seed=random`/`samples=random`.
`/clock` supports `bpm=` (rampable) and `num_beats=` (deliberately not
rampable — rejected with a message if given a ramp spec).

`/add_modulator type=lfo freq=2 name=lfo1` creates a modulator; `/patch
source=lfo1 dest=reverb.wet depth=0.2` patches it into a param (creates and
returns an id like `x1`); `/patch id=x1 depth=0.5` adjusts an existing
patch's depth afterward; `/unpatch id=x1` removes it. Removing a modulator,
track, or processor automatically cascade-removes any patch touching it as
either endpoint.

An event-generating modulator (`randomnotes`, which re-rolls continuously —
`/add_modulator type=randomnotes probability=0.7 min_gap=0.5
scale=0,2,4,5,7,9,11 name=rand1`; `markovpercs`, which generates one fixed
pattern and loops it until reseeded — `/add_modulator type=markovpercs
style=broken seed=31415 name=rhy`; or `chorale`, which holds overlapping
sustained voices through a chord progression — `/add_modulator type=chorale
mode=aeolian progression=0,5,3,4 name=bed`) patches into a track's synth instead of a
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

**Recording** (`recorder.js`, `engine.recorder`). `/record` starts,
`/stop_record` stops (both take `at=`, which is the point — a take bounded by
cycle boundaries is a whole number of loops), `/save_record` encodes and
downloads, `/clear_record` discards, `/recording` reports and carries the
three settings: `mode=stereo|multitrack`, `bits=32|16`, `max_minutes=<n>`.
Capture is an `AudioWorkletProcessor` compiled from an inline blob URL (no
separate asset for a bundler to special-case), one node per tap, buffering
4096 frames and transferring `ArrayBuffer`s to the main thread. Taps read each
channel's `output` — post-fader/pan/mute. `stereo` taps master alone;
`multitrack` taps every track, then every bus, then master, and all nodes are
created in one synchronous block so the files are sample-aligned. WAV is
written here (32-bit IEEE float, or 16-bit PCM with clamping); multitrack is
packed into a store-only ZIP written inline (CRC32 + local/central headers).
`/record` is the only command besides `/load_session` that is **async**: the
worklet module is awaited *before* `at=` resolves, so the deferred start
itself is synchronous — a rejection inside a bare `scheduleAt` timer has no
command left to report against. A take is deliberately absent from
`snapshotSession`/`sessionToJSON`: it is the output of a performance, not part
of its description. `Ribbit.dispose()` calls `recorder.dispose()`, since an
unflushed recorder holds timers and an unsaved take holds hundreds of MB.

`recall name=<state>` reuses this exact same trailing-duration-on-a-`key=value`
mechanism for its own `name=` param (`recall name=verse1 4b at=cycle`) rather
than inventing a second ramp syntax — `isRamp(params.name)` is true whenever
a duration was given, exactly like any other param.

`gain=`/`pan=`/any processor or modulator param accept a trailing duration to
ramp instead of setting instantly: `gain=0 3` (3 seconds) or `gain=0 4b` (4
beats). Add `at=beat`/`at=cycle` to defer to the next beat/loop boundary
instead of firing immediately (the default). That applies to *every* mutating
command, not just ramps — see the `at=` entry in the object model above —
so `gain=0 at=beat` jumps to 0 exactly on the next beat, `/lead
waveform=square at=beat` swaps the oscillator there, and `/hats stop at=cycle`
drops the part at the top of the next bar. Several `/name ...` commands can be typed
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
it, differing only in an optional `sessionUrl` prop:
`routes/code-editor/+page.svelte` (`<SessionPage />`, a blank session) and
`routes/code-editor/[session]/+page.svelte` (`<SessionPage
sessionUrl="/sessions/<slug>.json" />`, which `fetch()`es that static JSON
once the engine exists and calls `session.js`'s `loadSession` on it — the
same call `/load_session` makes with a picked file, minus the file picker;
a missing/unparseable file leaves an empty session and shows a banner).
The slug isn't validated against a file list, so any `.json` dropped into
`static/sessions/` gets a route for free.
`routes/+page.svelte` (the homepage) links to the blank session, offers a
dropdown of every session in `static/sessions/` (enumerated server-side by
`+page.server.js`, which also parses each to show a one-line summary — a
browser can't list a static directory over HTTP), and hosts an audio-options
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
so a `/clock` change shows even while stopped; `Recorder.svelte` — REC,
a duration/channel readout, an ST/MT mode toggle disabled while recording,
and Save/× — and Save JSON/Load JSON
buttons; every one of these runs its console command through the same path as
typing, so the result lands in the scrollback), then Tracks/Buses/Master side
by side in one row (Tracks grows to
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
  modulator (`randomnotes`, `markovpercs`, `euclidpercs`) can patch into a
  track's `.notes` and feed it generated notes alongside — never replacing —
  a synth's manually-authored `events`. Several generators may feed the same
  track (only an exact duplicate source→dest patch is rejected), which is how
  a fixed backbone plus a decorating layer is built. Three generation shapes
  exist: continuously re-rolled (`randomnotes`, never repeats),
  generate-once-then-loop from a Markov chain (`markovpercs`, fixed until
  reseeded), and grid-position-driven (`euclidpercs`, euclidean/Bjorklund —
  each hit decided by its own step index, so it can hold a downbeat, which is
  precisely what a first-order chain structurally cannot do). Still missing:
  a step-string parser (`kicks=x..x..x.`), which would slot into the same
  contract. No per-cycle/every-N-cycle regeneration hook exists either,
  Five generation shapes now exist. The fourth is **hand-authored material,
  varied** (`patternvariator`) — the only one whose input is a file a person
  wrote rather than a rule. The fifth is **sustained harmony** (`chorale`) —
  the only one that isn't producing a rhythm at all, and the only one with no
  randomness anywhere in it: every note is a pure function of the absolute
  beat, so there is no seed and nothing to reproduce. A step-string parser is no longer a gap: the
  `drums` pattern kind *is* one (`kicks: "x..x..x."`), it just lives in a file
  rather than on the command line, since sixteen characters don't survive
  `splitCommands`.
  An `onCycle(cycleIndex)` clock hook now exists for per-N-cycle regeneration
  (see `RibbitClock`), but **nothing consumes it yet** —
  `generateEvents(fromBeat, toBeat)`'s absolute-beat design sidesteps needing
  it for every generator, and `patternvariator` regenerates only on reseed
  by deliberate choice: a pattern that quietly rewrites itself while you're
  working on something else is very hard to play with.
- The harmony context is a live key/scale (`/harmony root= scale=`), not a
  full harmony *system* — no per-track scale overrides, just the one shared
  context every `degree=` resolves against. Chords and progressions exist only
  *inside* `chorale` (its `mode`/`progression`/`chord_size`/`stack` options),
  which emits plain degrees like anything else; nothing else in the engine
  knows what chord is currently sounding, and there is no shared notion of
  "the current chord" a second generator could follow.
- **`patternvariator` never invents material outside its source.** Rhythms
  lose hits, gain ghosts, or nudge one step; pitched material is varied against
  the pattern's *own* pitch-class vocabulary (inversion, octave displacement,
  neighbour tones drawn from the degrees the pattern already uses) rather than
  the harmony context's full scale. Voices are folded back inside ±24 semitones
  so inversion and octave displacement landing on the same note can't spread a
  chord across three octaves. At `variation=1` roughly two thirds of a source
  rhythm still survives — that's the intent, not a limit.
- **`karplus` renders each note into an `AudioBuffer`** rather than building a
  feedback node graph, because Web Audio forces any cycle containing a
  `DelayNode` to at least one render quantum of delay (capping the fundamental
  around 375Hz). Consequence: pitch quantizes to a whole number of samples, so
  error stays within ~6 cents to C6 and widens to ~22 cents by G6. Nothing is
  cached — a fresh noise burst per pluck is the point.
- **`chaossynth` renders per note too, and for a sharper version of the same
  reason.** It's a recreation of a Max/MSP patch (`.claude/context/
  regression.maxpat`): two cross-coupled voices, each an oscillator through an
  `atan` saturator into a resonant lowpass whose cutoff is driven by that
  voice's own loudness. Both feedback loops are **single-sample** — a 128-sample
  lag in the cross coupling makes it a different dynamical system, not a
  slightly worse one — and the envelope follower in the inner loop has no node
  equivalent at all. Two substitutions are deliberate and documented in the
  source: `lores~` → a Chamberlin SVF (its cutoff is remodulated every 64
  samples, and a biquad recomputing coefficients that fast can go unstable),
  and `fluid.loudness~` → a one-pole RMS follower read at the patch's own
  `@hopsize 64`. Costs ~5.6ms per 2-second note (measured), capped at 8s.
- **`czsynth` renders per note for the clearest version of that reason yet:**
  phase distortion is a per-sample nonlinearity whose *shape* is moved by an
  envelope, and `WaveShaperNode` reshapes amplitude from a fixed array. A
  linear phase ramp is bent by a piecewise-linear transfer function and read
  out of a cosine table; the DCW envelope morphs that function between the
  identity (so DCW 0 is a sine for *every* waveform) and its bent extreme.
  Two lines, each `DCO → DCW → DCA` with an eight-stage envelope on all three.
  ~0.35ms per second of audio per line, capped at 12s; mono, because the
  CZ-101 is. Three things that look like bugs and aren't: `reso1/2/3` are hard
  sync through a per-cycle window rather than phase distortion (so `dcw` moves
  a frequency there), a *combination* preset alternates two waveforms per
  period and so sounds a sub-octave, and the envelope rate-to-seconds curve is
  **fitted** because Casio never published one.
- **`czsynth` is the only synth with a preset library**, because a CZ tone is
  ~90 numbers. `synths/cz-tones.js` holds 28 patches decoded from sysex; every
  `param` is a modifier over the selected tone, and every option but `preset`
  takes the sentinel `"preset"` meaning "use the tone's value" — which is what
  stops the two layers writing to each other.
- **`chaossynth` is the one synth where a MIDI note isn't a pitch.** `seed`
  builds one configuration of all ten control points per MIDI note (0..127), so
  a note selects a *state*; `spread` lerps from the hand-set params toward that
  note's configuration (0 = params only, 1 = seeded state outright), and
  `pitch_track` decides how much the note additionally transposes. The
  consequence worth knowing: **any** event generator becomes a timbre
  sequencer when patched at it. Its events use `pitch` rather than `degree` in
  the shipped session on purpose — a degree resolves against `/harmony`, so
  moving the root would silently renumber every state.
- Synth-level rampable `params` are live on `percsampler`
  (`dynamics`/`pan_spread`/`speed_spread`), `karplus`
  (`damping`/`decay`/`brightness`), `granular` (nine), `tapepad` (eleven),
  `chaossynth` (fourteen) and `czsynth` (seven); `oscsynth`/`sampler` declare none. `channelCommand` routes them through the
  track's own name (`/hats pan_spread=0.8 4b`), `_resolveDest` falls back to
  `channel.source.params` so they work as `/patch` destinations
  (`dest=hats.pan_spread`), and `addressableParams()` does the same for
  `automate=` — but see the next entry for *when* a patched value is read.
- **A JS-read param reads its patches through `getModulated()`, not `get()`.**
  `RibbitParam.get()` returns `audioParam.value`, which by spec is the
  *intrinsic* value: automation is reflected in it, an incoming node
  connection never is. So every param whose owner reads it in JavaScript at
  trigger time — most **synth** params, and `velocity`/`swing`/`probability`/
  `dropout` on an **event-generating** modulator — calls `getModulated()`
  instead, which reads the summed value off an `AnalyserNode` tapping the
  backing `ConstantSourceNode`'s **output** (built lazily by
  `RibbitParamSources.create`, on the first patch to land there; `RibbitPatch`
  announces itself via `attachPatch`/`detachPatch`). Params *consumed as
  audio* never needed this and are unchanged: channel `gain`/`pan`, every
  processor param, `RibbitLFO.freq`, `RibbitCV.value`, a patch's own `depth`.
  **The two readers must stay separate**: `snapshotSession` calls `get()` on
  everything, and saving a momentarily-modulated value would corrupt every
  session file. The tap is one render quantum behind, so a patched param read
  at trigger time is the modulator's value at *command* time, not note time.
- **A synth's params need not all be the JS-read kind.** `tapepad` is the
  worked example: five of its eleven (`wow`/`wow_rate`/`flutter`/`hiss`/`sat`)
  wrap real single-node `AudioParam`s on persistent shared nodes, so they are
  *continuous* — a ramp or a patch moves them during a sustained chord — while
  the six on `RibbitParamSources` are read once per trigger and so move note by
  note. Nothing in the command surface distinguishes them; the difference is
  only in *when* the change is heard. Consequence worth knowing when testing:
  `getModulated()` on one of the continuous five returns the intrinsic value,
  because a param wrapping a real audio node's `AudioParam` has no tap and
  doesn't need one — the summing happens in the graph, not in JS.
- **`automate=` reaches a track's synth params**, via `addressableParams()`
  (`param.js`) — the one place that knows a channel's surface includes its
  synth's. Used by `automate=`, the `automations` listing, completion, and
  session serialize/rebuild, so all five agree. `setTrackSynth` re-aims any
  automation the new synth also declares by name and drops the rest, rather
  than leaving the clock ramping a param on a disposed synth.
- `/save`/session files capture loop automation by param name — but an
  `RibbitAutomationEvent` constructed in code against a bare `AudioParam`
  (no `paramKey`) is skipped, and a rebuilt `once` event fires once more
  after a load/recall.
- `/recall` matches modulators by name only (processors by name+type; a
  type-changed *track* synth is swapped back properly) — a modulator whose
  name survived but whose type changed since the save keeps its live type,
  with saved params/options applied only where the names still fit.
- `RibbitSampler`/`RibbitPercSampler`/`RibbitGranular` sample loading is
  unawaited fire-and-forget; a trigger before load completes silently no-ops
  (also true after a runtime `samples=`/`sample=` swap). The latter two
  additionally depend on a host-served manifest (`/samples/manifest.json` by
  default, see the type note above) to know what they may pick from — no
  manifest means an empty kit / no source and a `console.warn`, not an error.
  `RibbitGranular` is the one that makes file *size* matter: it holds a whole
  decoded recording (the shipped library has four-minute ones), doubled if
  `direction` is not `forward`, since Web Audio has no backwards playback so a
  reversed copy must be built. It peak-normalizes each source on load (capped
  20x) because an unmastered library spans ~30dB and a random roll would
  otherwise invalidate every mix decision. Its per-note cost is a whole cloud
  of grains at 3 nodes each, scheduled up front and capped at 400 (over
  budget, the cloud thins rather than truncating).
- `splitCommands` (multi-command-per-line) assumes no param value contains a
  literal `/`; none currently do, but a value that did would be mis-split.
- A session naming a removed type fails cleanly (`assertKnownTypes`, see
  the sessions section) but is never *repaired*: there's no partial/lenient
  load, so a file saved outside the repo before a type was removed has to
  be hand-edited. That's the standing cost of removing a shipped type (see
  `docs/dev/removing-a-type.md`).
- A `comb` in `mode=feedback` **cannot resonate above ~344Hz** (~375 at 48k):
  a Web Audio cycle must contain a `DelayNode`, and the spec floors that at one
  render quantum — the same wall `karplus` answered by rendering into a buffer,
  which a live insert can't do. `mode=feedforward` is in no loop and combs the
  whole range; `describeState()` reports when `time` is under the floor.
- Mute/solo (like every other ramp) **don't take effect while the engine is
  stopped**: the 10ms declick ramp can't advance against a frozen
  `currentTime`. It lands the moment the transport starts, and nothing is
  audible in between, but a stopped channel reported as muted still reads
  `muteGain.gain.value === 1`.
- `RibbitLimiter` (and the `goodenizer`'s limiter stage) is a fast, high-ratio
  `DynamicsCompressorNode`, **not a lookahead brickwall** — Web Audio offers no
  lookahead, so a fast enough transient can exceed `ceiling`. Treat it as
  "about here", which is why it defaults to `-1` rather than `0`.
- `RibbitSaturator`'s curves are normalized to unity *slope at the origin*, so
  each `character` has a different output level once `drive` pushes into the
  bend (a wavefolder ends up quieter than a clipper). `level` is the trim.
  Switching `character` at high drive therefore changes loudness as well as
  timbre; this is intended, not compensated.
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
- `docs/llm/catalog.md` — the short index of every registered synth,
  processor and modulator with its params/options and a "which one to copy"
  table. Start here; it replaces reading `src/` to find out what exists.
- `docs/llm/building-synths.md`, `building-processors.md`,
  `building-modulators.md`, `adding-commands.md` — condensed, code-skeleton
  versions of the `docs/dev` tutorials for use as LLM context when the task is
  specifically "add a new X". `removing-types.md` is the counterpart for
  "remove an existing X".
