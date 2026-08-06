# Source overview

All DSP/engine code lives in `src/`. Base classes
(`synth.js`, `processor.js`, `modulator.js`, `channel.js`, etc.) live directly
in this folder; non-base implementations live one level down, grouped by
kind — `synths/oscsynth.js`, `synths/sampler.js`, `synths/percsampler.js`,
`processors/reverb.js`,
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
  this; processor/modulator params default to unclamped). These also decide
  whether the param can be *randomized*: `.hasRange` is true only when both
  ends are finite, and `.randomValue({ min, max })` returns `null` otherwise
  rather than inventing a span. Only three params in the engine are unbounded
  enough to fail that — a patch's `depth`, `cv`'s `value`, a send's `gain`.
- optional `randomizable` (default `true`) — whether the bulk `/<object>
  random` command includes this param, surfaced on the console as
  `<param>.r=true|false` and persisted by `session.js` as `no_random`.
  `.canRandomize` is the two conditions together. Channel `gain` is the only
  thing in the engine that ships with it off.
- optional `onSet` — overrides the instant-set path for a param that has to
  fan a single value out across more than one node (`RibbitDelay`'s `time`
  writes both `delayL.delayTime` and `delayR.delayTime`, the latter offset for
  stereo width). Ramping/deferred `at=` scheduling still only animates the
  "primary" `.audioParam` directly — `onSet` only affects the plain
  instant-set case.

**`RibbitParamSources`** lives here too — the factory for a param that wants
all of the above but has no `AudioParam` in the audio graph to hang off
(`RibbitRandomNotes.probability`, `RibbitMarkovPercs.swing`,
`RibbitEuclidPercs.dropout`, `RibbitPercSampler.pan_spread`). It invents one
from a `ConstantSourceNode`'s `.offset`, and is a shared class rather than a
one-liner per call site because of a Web Audio quirk that has to be explained
somewhere: a node with no path into the rendered graph can have its
`setValueAtTime` automation silently never reflected in later `.value`
reads — even though a direct `.value =` assignment always works — so each
source is routed through a muted (`gain: 0`) sink into
`audioContext.destination`. Connected enough to stay live, silent enough
never to be heard.

```js
this._paramSources = new RibbitParamSources(audioContext);
this.params = {
    swing: this._paramSources.create(swing, { min: 0, max: 0.5 }),
};
dispose() { this._paramSources.dispose(); }
```

`min`/`max` are declared once and used twice — to clamp the initial value and
as the returned `RibbitParam`'s bounds. The owner **must** call
`dispose()`: those sinks reach `audioContext.destination` directly, so the
generic `output.disconnect()` in `removeModulator`/`removeTrack` never
touches them. This was open-coded in three classes before, each re-explaining
the quirk and keeping its own parallel `_sinks` array.

> **There are two readers, and picking the wrong one is a real bug.**
> `get()` returns the *intrinsic* value: `audioParam.value` reflects direct
> assignment and scheduled automation, but never the signals connected *into*
> the param — the summed "computed value" isn't readable from JS at all.
> `getModulated()` is the one that sees patches, by tapping an
> `AnalyserNode` on the backing `ConstantSourceNode`'s **output**, where the
> sum does become visible. The tap is built lazily, on the first patch to
> land (`RibbitPatch` calls `attachPatch`/`detachPatch`), so an unpatched
> param costs nothing and an unpatched read short-circuits to `get()`.
>
> **The rule:** anything deciding what to *do* with a value calls
> `getModulated()` — every synth's `trigger()`, every generator's
> `generateEvents()`. Anything *recording or displaying* the value calls
> `get()`. `snapshotSession` calls `get()` on everything, and saving "0.7,
> because an LFO happened to be up" would corrupt every session file. Params
> consumed by the audio graph itself (channel `gain`/`pan`, processor params,
> `RibbitLFO.freq`, `RibbitCV.value`, a patch's `depth`) never read either
> one — the graph does the summing. Because the tap reads the last rendered
> quantum, a patched value is one quantum old: fine for per-note reads,
> useless for sample-accurate work.

`.get()`/`.getModulated()`/`.set(value)`/`.clamp(value)` are the whole public
surface;
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

## `random.js`

`mulberry32(seed)` — a 32-bit seeded PRNG; `randomSeed()` — a fresh
unreproducible seed, which is what `seed=random` resolves to before being
stored as a concrete number; and `randomInRange(min, max)` — one uniform draw,
what a param's `=random` resolves to (see `RibbitParam.randomValue`).

`randomInRange` uses `Math.random()` for the same reason `randomSeed()` does,
and it is not the exception to the rule below: the draw resolves to a concrete
number the moment the command runs, and *that number* is what gets stored, so
the result is already part of the document with nothing left to reproduce.

Seedability is why a generated pattern survives a session round trip: `seed`
plus the generator's shape options fully determine the output, so a saved
session rebuilds the same bar rather than a new random one. The corollary is
that anything which should *not* survive a reload deliberately uses
`Math.random()` instead — `RibbitEuclidPercs`' live `dropout` re-roll is the
one example. **The choice of generator is the choice of whether the result is
part of the document.**

Extracted here on reaching a third caller (`markovpercs`, `euclidpercs`,
`patternvariator`) — the same threshold that moved `_stride()` onto
`RibbitModulator`.

## `library.js`

Everything `samples.js` and `pattern.js` both need to read the host's static
files, in one place. Exports `libraryUrl`, `fetchJSON` and
`createLibraryCache`. Two things worth knowing:

- **`libraryUrl` deliberately does not use bare `encodeURIComponent`.** That
  function is for query *values*: it escapes characters that are legal inside
  a path segment, and a static file server matches the raw path, so an escaped
  one is simply a different, nonexistent file. The comma is the one that bites
  — `Cala Llombards, Sea Urchins.wav` serves fine literally and 404s as
  `%2C`. The RFC 3986 sub-delims (plus `:` and `@`) are put back after
  encoding. This was latent in `percsampler` from the start, invisible until a
  library contained a filename with a comma, and *separately* latent in
  `fetchPattern` — the two copies had already drifted, which is why there is
  now only one.
- **`createLibraryCache()` is the two-level cache.** A file is cached per URL
  as a *promise* (collapsing concurrent construction — several sample-backed
  tracks built together share one request) and, once settled, as a *resolved
  value*. The second layer is what lets a re-roll take a **synchronous** path:
  awaiting even a settled promise costs a microtask, which is long enough for
  `applyOptions` to have printed its confirmation line, so a re-roll would
  otherwise echo the sample it just replaced. A failure isn't cached, so a
  later attempt can retry. `get(url, load)` takes an optional loader for a
  caller whose cached value is *derived* from the response — `pattern.js`
  caches the parsed pattern, so a reseed pays the parse once.

## `samples.js`

The host's sample library: what files it serves, and how a synth finds out.
The samples counterpart to `pattern.js` below — a shared *loader*, not a type,
so that `synths/percsampler.js` and `synths/granular.js` share one fetch and
one set of naming rules instead of each inventing their own. The caching and
URL building come from `library.js` above; what's left here is
`SAMPLE_MANIFEST_URL`, `sampleName`, `sampleFolders`, and thin wrappers
(`sampleUrl`, `fetchSampleManifest`, `resolvedSampleManifest`) that bind the
`/samples` base.

**Folders aren't fixed.** The four percussion categories are a `percsampler`
concept, not a manifest one; anything else the host publishes is an ordinary
folder that `granular` can read by name.

## `pattern.js`

The hand-written pattern format, and the loader for a host-served pattern
library. Consumed by `modulators/patternvariator.js`; see
[creating-a-pattern.md](creating-a-pattern.md) for the full treatment and
[../user/patterns.md](../user/patterns.md) for the authoring side.

The distinction that drives every decision in this file: a **session** is
written by the engine for the engine, while a **pattern** is written by a
person and only ever read. So the format optimizes for being typed and
re-typed, not for lossless round-tripping.

`parsePattern(raw, { source })` returns `{ name, kind, stepBeats, steps,
duration, velocity, lanes, sequence }`, and is exported separately from loading
so a pattern can be built inline without a fetch. Two kinds share one grid:
`drums` (a character lane per `PERC_CATEGORIES` entry) and `notes` (one token
per step, comma-separated scale degrees). A melody is a `notes` pattern with
one degree per step, which is why there's no third kind.

Three properties worth knowing before editing:

- **`cellAt(cells, step)` wraps at the lane's own length, not the pattern's.**
  Three lines, and the whole of "each lane cycles independently" — a short lane
  repeats, a mismatched one gives polymeter, and no generator ever has to
  expand lanes to a common length. Double modulo, since `generateEvents` works
  in absolute beats that aren't guaranteed non-negative.
- **Inference over declaration.** `steps` derives from the longest lane, `kind`
  from which key is present, `duration` from `stepBeats`. A declared `steps` is
  a second copy of a fact the lanes already carry, and duplicated facts
  eventually disagree — silently truncating the pattern.
- **Tolerant input, strict errors.** Four rest spellings, spaces ignored
  anywhere, any lane length; but an unreadable token throws quoting the
  offending character. There is no lenient parse mode, deliberately: a
  hand-edited file that half-loads is worse than one that doesn't load.

A drum cell holds `{ variant, gain }`, **never a finished slot number** —
`category * stride + variant` resolves at delivery via `_stride()`. And
`variant: null` (the author wrote `x`) is deliberately distinct from
`variant: 0`, so a variator can re-pick an unspecified slot without overriding a
deliberate one.

Loading goes through `library.js` — two `createLibraryCache()` instances, one
for the manifest and one for pattern files, the latter caching the *parsed*
pattern so a reseed pays the parse once. Host contract:
`GET /patterns/manifest.json` → `{ <pack>: ["<pack>/<name>.json"] }`.

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

`setInstant(audioContext, param, value, startTime)` writes a value at a
(possibly future) time instead of assigning `.value`, so `at=beat`/`at=cycle`
can defer a plain set the way `scheduleRamp` defers a ramp.

`scheduleAt(ribbit, time, fn)` is the escape hatch for work that can't ride
native `AudioParam` scheduling at all — structural graph changes
(`applySnapshot`'s create/remove/reorder) and plain non-`AudioParam` numbers
(`RibbitClock.loopLengthBeats` for `/clock num_beats= at=`). Note it takes the
whole `ribbit`, not an `audioContext` like its siblings above, and that
asymmetry is deliberate: everything else in this module hands work to the
browser's audio thread, where closing the context cancels it, but a
`setTimeout` outlives `Ribbit.dispose()` and would then run against a closed
context. It registers its timer id in `ribbit._deferredTimers` (removing
itself when it fires) so `dispose()` can cancel whatever is still in flight.

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

A third optional hook, `unit.onCycle?.(cycleIndex)`, fires inside
`_scheduleRange` the first time a given loop index is scheduled — the seam for
"change something every N cycles" (a generator re-rolling, a section
advancing). Two properties matter. It fires **a lookahead window early**, in
the same pass that schedules that cycle's first events, which is exactly what a
regenerating unit needs: it has to have rewritten its pattern *before* that
pattern is read. And `cycleIndex` is monotonic but **not necessarily
contiguous** — if a stall swallowed whole cycles the skipped ones aren't
replayed, since regenerating N times for cycles nobody will hear is strictly
worse than landing on the current one. `_notifiedCycle` tracks the high-water
mark and resets to `-1` in `start()`, so a restart re-announces cycle 0.

**Nothing currently implements it.** All five generators index `generateEvents`
straight off the absolute step number, which sidesteps needing a boundary
notification at all, and `RibbitPatternVariator` regenerates only on reseed by
deliberate design. It's an unused seam rather than dead code — the natural
consumer is a future every-N-cycles generator.

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

## `synths/percsampler.js` — `RibbitPercSampler extends RibbitSynth`

A structured drum kit rather than a flat sample list. `PERC_CATEGORIES`
(`["kicks","snares","hats","percs"]`, exported) times `perCategory` gives the
slot layout, and that layout is a **published contract** — `modulators/
markovpercs.js` codes against it, and the `slotsPerCategory` getter is what
lets a generator read the stride off its destination instead of hardcoding
it. Deliberately not a subclass of `RibbitSampler`: it shares only the
fetch/decode idiom, and inheriting would put the parent's flat slot list in
tension with this one's category structure.

Three things worth knowing before editing it:

- **The manifest.** Random selection needs to know what files exist, which a
  browser can't discover, so the host serves `/samples/manifest.json`
  (per-instance `manifest_url`). The fetching, caching and naming all live in
  **`samples.js`** (see above) rather than here, since `granular` reads the
  same library — this file just calls `fetchSampleManifest` /
  `resolvedSampleManifest` and picks from the four keys it cares about.
- **Placeholders keep slot indices absolute.** A category outside
  `this.categories` still occupies its slots, filled with `null`. That's the
  whole mechanism behind splitting a kit across tracks: a generator emits
  index 6 for "snare variant 2" regardless of who's listening, and a
  hats-only track lands on a placeholder and no-ops via the existing
  `if (!slot?.buffer) return`.
- **`_generation` guards against stale rolls.** A roll resolves
  asynchronously and *replaces* the whole slot list; without the counter, a
  roll you rejected followed immediately by an explicit `samples=` would win
  on arrival. Note `per_category`/`categories` setters return early when
  unchanged — that's load-bearing, not an optimization: `applyOptionsSnapshot`
  replays options in declaration order, so `/recall` sets `samples` and then
  `per_category`, and an unconditional re-roll there would discard the kit it
  just restored.

`trigger()` is also the engine's only per-hit randomizer: `dynamics` scales
gain on every category, while `pan_spread` and `speed_spread` apply per the
`RANDOMIZATION` table (kicks opt out of both so they keep anchoring the
track). The `StereoPannerNode` is built only when it would do something.
These are the engine's first rampable **synth** params, so this is also the
first exercise of `channelCommand`'s synth-param routing. They're read with
`getModulated()`, which is what makes `dest=hats.pan_spread` a working patch
destination (`_resolveDest` falls back to `channel.source.params` to resolve
it) — sampled once per hit, so a patched LFO varies the spread hit by hit.
See `param.js` above.

## `synths/karplus.js` — `RibbitKarplus extends RibbitSynth`

A polyphonic Karplus-Strong plucked string, and the **only polyphonic synth** —
a chord is several overlapping one-shot `BufferSource`s, so there's no voice
allocator to run out.

The one decision that shapes the file: **each note is rendered into an
`AudioBuffer` by a JS loop, not built as a node graph.** The obvious Web Audio
implementation — `DelayNode` → lowpass → gain → back into the delay — doesn't
work above a few hundred Hz, because the spec requires any cycle containing a
`DelayNode` to impose at least one render quantum (128 samples) of delay. At
48kHz that floors the delay line at 2.7ms and caps the fundamental around
375Hz, roughly F#4 — the middle of the range you'd actually play. Rendering
directly is exact at every pitch, needs no `AudioWorklet` module for the host
to serve (the engine asks hosts for JSON manifests and nothing else), and costs
well under a millisecond per note.

Three consequences worth knowing:

- **Pitch quantizes** to a whole number of samples (`Math.round(sampleRate /
  freq)`). Measured error stays inside ~6 cents to C6 and widens to ~22 cents
  by G6 (a 31-sample line). The fix is a fractional delay with interpolated
  read-back; judged not worth the inner-loop cost for the top octave.
- **Nothing is cached.** Rendering is cheap next to the 100ms scheduling
  window, and a fresh noise burst per pluck is the point — a cache would make
  every repeat of a note bit-identical, which is exactly the mechanical quality
  the noise excitation exists to avoid.
- **Decay is pitch-compensated.** `feedback = 0.001 ** (1 / roundTrips)`, where
  `roundTrips = ringSeconds * sampleRate / lineLength`. Without that, a high
  note — whose line is short and therefore loops far more often per second —
  would die away much faster than a low one.

`damping`/`decay`/`brightness` are params (via `RibbitParamSources`, since
there's no `AudioParam` in the graph to hang them off) rather than options
because sweeping them is musical; each is read fresh per trigger, so a ramp
applies from the next note. `excitation` is an option (`noise` — broadband, the
classic; `pulse` — a single impulse, every harmonic in phase, a much cleaner
attack). Notes ring for their natural decay; `event.duration` is honoured only
as a *mute* when it's shorter than the ring, since a plucked string doesn't
stop when the written note ends. Note the `source.stop()` call must follow
`source.start()` — stopping an unstarted source throws `InvalidStateError`.

## `synths/granular.js` — `RibbitGranular extends RibbitSynth`

One source recording, played as a cloud of short windowed grains. The second
synth to read the host's sample library (through `samples.js`), the second
polyphonic one, and the first whose per-note cost is *many* nodes rather than
one or two.

**The structure is two stages, and keeping them apart is the design.** A note
is `voice envelope x sum of grains`: `attack`/`release` are on one
`GainNode` per note, `density`/`grain_size`/`spray`/`position`/`drift`/
`pitch_spread`/`pan_spread` govern what gets scheduled into it. Every grain of
a note is placed on the audio clock inside `trigger()` — no timers, nothing
running between notes — which is also why polyphony is free.

Five things worth knowing before editing it:

- **Grain windows are shared, unit-amplitude `Float32Array`s** (`WINDOWS`,
  built lazily per shape and cached module-wide), applied with
  `setValueCurveAtTime`. They can stay at unit amplitude *because* the note's
  level lives on the voice gain — which is what keeps a 400-grain note from
  allocating 400 curve arrays. The last point of every curve is forced to 0:
  the curve holds its final value afterwards, so a grain ending at 0.007 would
  leave a DC step on that gain node.
- **Timing jitter is not a taste setting.** `TIME_JITTER` scatters each grain
  by up to half the nominal interval, because a perfectly periodic cloud
  amplitude-modulates itself at exactly `density` Hz — a 30Hz buzz over
  everything at 30 grains/second.
- **Read positions wrap inside `duration - consumed`, not inside the buffer.**
  A grain that starts near the end would otherwise run off it and leave a
  hole. `consumed` accounts for `playbackRate`, since a transposed grain eats
  more or less material than its output length.
- **`_measure` gain-matches each source on load** (peak, capped at
  `MAX_NORMALIZE`). Not a nicety: a field-recording library isn't mastered —
  the shipped `foley` folder spans ~30dB — so without it `sample=random` moves
  a track's level by 30dB and every mix decision has to be redone after every
  roll. Long buffers are strided rather than scanned whole; this runs on the
  main thread right after a decode.
- **Reverse needs a mirrored copy** (`_ensureReversed`) because Web Audio has
  no backwards playback — a negative `playbackRate` is undefined for
  `AudioBufferSourceNode`. It's built when the `direction` option is set, not
  at trigger time: a few hundred milliseconds of copying is nothing when you
  type a command and a glitch when a note starts. Reading it means mirroring
  the position too (`duration - read - consumed`).

The `_generation` counter guards stale rolls exactly as in `percsampler`, and
for the same reason. `describeState()` reports the source, its length and any
gain match — the first synth to implement that hook, and the reason
`channelSummary` now calls it (a randomly-chosen source is otherwise invisible
from the console). `MAX_GRAINS` thins a note's cloud by stretching the
interval rather than truncating it: a texture that gets grainier is a texture,
a pad that stops halfway through is a bug you can hear.

## `synths/tapepad.js` — `RibbitTapePad extends RibbitSynth`

A polyphonic subtractive pad running through a tape machine. The third
polyphonic synth, and the first with **persistent nodes of its own** —
everything before it either built only one-shots per note or held nothing but
decoded buffers.

**Two halves, and the split is the design.** Per note, `trigger()` builds an
ordinary voice: `voices` detuned oscillators, panned across the field by
`pan_spread` in the same order they're detuned, into one lowpass (swept open
across the attack and eased back over the tail) and one attack/sustain/release
gain. Shared and always running: a **transport** (the `wow` and `flutter`
drift signals summed into `_pitchMod`, which every live oscillator's `detune`
is connected to) and a **tape stage** (`_satGain` → tanh `WaveShaper` →
bit-crush `WaveShaper` → fixed bandwidth lowpass), with hiss joining after the
curves.

Five things worth knowing before editing it:

- **The transport is shared because a tape machine has one capstan.** Per-voice
  drift is an ensemble chorus; one signal fanning into every voice is what
  reads as a warped recording. This isn't only aesthetics — it's what makes
  `wow`/`wow_rate`/`flutter` real single-node `AudioParam`s rather than
  JS-read values, so they ramp and take patches *continuously*. This file is
  therefore the example for **a synth whose params are of both kinds** (see
  `creating-a-synth.md`); `this.params` is assembled in two passes, real
  `AudioParam`s first and `RibbitParamSources` entries `Object.assign`ed on
  top.
- **The tape stage is shared for a second reason**: saturating each voice
  separately and then summing gives a clean sum of dirty voices. Running the
  summed chord into one curve is what gets the voices intermodulating, which
  is where the dirt actually comes from.
- **`buildDrift` sums sines at *whole* cycle counts** over the buffer, at
  random phase. Whole counts are what let the buffer loop without a seam; the
  counts are primes so the sum doesn't repeat before the whole loop does. The
  alternative — filtered noise — needs a crossfade at the seam, and a
  crossfade in a signal this slow is audible as a hesitation once per pass.
  The buffers are tiny (`DRIFT_POINTS`) and played back at a rate well under
  1, so they're control signals rather than sounds; `wow_rate` is a
  `RibbitParam` on that `playbackRate` with `encode`/`decode` hiding the base
  rate from the user.
- **`buildSatCurve` normalizes to unity slope at the origin**, not unity peak —
  the same convention as `processors/saturator.js`, whose long comment is the
  one to read. Consequence: `sat` gets louder as well as dirtier, and the
  track's `gain` is the balance control.
- **`bits` is an option, not a param**, because setting it rebuilds a
  `Float32Array` (same reason as saturator's `character`). Quantization finer
  than `CRUSH_POINTS`' spacing is smoothed straight back out by the
  `WaveShaper`'s own interpolation, which is why 12 and up is effectively
  clean rather than a subtly wrong 16-bit.

`dispose()` is mandatory here rather than optional: the transport and hiss
sources run forever once started, and `removeTrack`/`setTrackSynth` only do a
generic `output.disconnect()`. The same persistence means hiss is audible while
the track is stopped — `active` gates event scheduling, not audio, and a tape
machine hissing through a pause is the intended behaviour.

## `synths/chaossynth.js` — `RibbitChaosSynth extends RibbitSynth`

A chaotic two-voice cross-coupled feedback synthesizer, recreated from the
`p "chaotic synthesiser"` subpatcher in `.claude/context/regression.maxpat`
(where a `fluid.mlpregressor~` predicted its ten inputs from a 2D pad). The
second synth to **render per note into an `AudioBuffer`** rather than build a
node graph, and the first whose algorithm is genuinely per-sample DSP rather
than one loop over a delay line.

**The topology, per voice:** a sine oscillator whose frequency is bent by the
*other* voice's last output sample, through an `atan` saturator, into a
resonant lowpass whose cutoff is derived from that voice's own loudness. Two
nested feedback loops — the inner one negative and per voice (louder closes
the filter, which makes it quieter, which opens it again, so it hunts rather
than settling), the outer one between the voices and acting on frequency.

Things worth knowing before changing it:

- **Both loops are single-sample, and that's why it can't be a node graph.**
  Web Audio forces any graph cycle to a full render quantum; 128 samples of lag
  in the cross coupling makes it a *different* dynamical system, not a slightly
  worse one. The envelope follower in the inner loop has no node equivalent at
  all. (Max's own `send~`/`receive~` imposes a signal vector here; a single
  sample is the ideal version of the same connection.)
- **Two rates in one loop.** The audible path runs per sample; the loudness →
  cutoff path runs every `CONTROL_HOP` (64) samples with its filter coefficient
  interpolated across the block. That split keeps a log and an exp per voice
  out of the inner loop, and it is also exactly the original's control rate
  (`fluid.loudness~ @hopsize 64`) — faithful, not a shortcut.
- **Two documented substitutions.** `lores~` → a Chamberlin state-variable
  filter, because a biquad recomputing coefficients every 64 samples can go
  unstable and an SVF doesn't. `fluid.loudness~` → a one-pole RMS follower
  (~20ms) read at the same hop; smoother than a windowed loudness measure,
  which is what this loop wants.
- **Divergence is checked, not hoped for.** One NaN in a feedback loop poisons
  every sample after it, and a buffer of NaN is silence plus a click rather
  than a warning, so each control block resets a voice whose state has gone
  non-finite.
- **The output clip does real work.** `atan` bounds what reaches the filter,
  but a resonant lowpass has gain at its cutoff: measured peak with all ten
  inputs at 1 is exactly 1.0, versus ~0.35 at the defaults. Distorting at the
  top of the range beats a gain stage that makes every ordinary setting
  quieter.
- `MAX_NOTE_SECONDS` (8) caps the render. Measured ~5.6ms per 2-second note —
  well over `karplus`'s, and the reason the cap exists.

**`seed` → per-note state** is the other half of the design. `_stateTable()`
lazily builds 128 rows of ten uniform draws from one `mulberry32(seed)` stream,
thrown away whenever the seed changes; `_resolveState(midi, modulated)` lerps
each param toward that note's row by `spread`. So a MIDI note selects a
*configuration*, not a pitch, and any event generator becomes a timbre
sequencer. The `modulated` flag follows `RibbitParam`'s own split:
`trigger()` passes `true` (a patch should be seen), `describeState()` passes
`false`, because a patched param's summed value is only readable while the
graph is rendering and a `/track` typed before `/start` would otherwise print
`0.00` for exactly the params someone had bothered to patch.

`dispose()` is the usual one-liner for `RibbitParamSources`; there are no
persistent audio nodes.

## `synths/czsynth.js` — `RibbitCZSynth extends RibbitSynth`

An emulation of the Casio CZ-101 (1984) — phase distortion. The third synth to
**render per note into an `AudioBuffer`**, and the clearest case for it: the
algorithm is a per-sample nonlinearity whose *shape* is being moved by an
envelope. `WaveShaperNode` reshapes amplitude, not phase, from a fixed
`Float32Array`; there is no node arrangement that expresses a moving transfer
function, and the alternative is an `AudioWorklet` module the host would have
to serve.

**The algorithm.** A linear phase ramp `φ ∈ [0,1)` is bent by a
piecewise-linear transfer function, then read out of a cosine table.
`distortedPhase()` holds one function per waveform; the DCW envelope morphs
each between the identity (which reads out an undistorted cosine — so DCW 0 is
a sine for *every* waveform) and its fully bent shape. `resonanceWindow()`
handles the three that work differently. Architecture is the machine's: up to
two lines, each `DCO → DCW → DCA` with an eight-stage envelope on all three.

Things worth knowing before changing it:

- **The cosine table needs two guard entries, not one.** Every distortion
  function except the saw *clamps* to a phase of exactly 1.0 — the flat top of
  a pulse lands there every period — so the interpolation reads index
  `TABLE_SIZE + 1`. With one guard entry those four waveforms render as NaN.
  This was a real bug, found by rendering rather than by reading.
- **The resonant waveforms are not phase distortion.** They are an inner sine
  hard-synced to the note, multiplied by a per-cycle window (saw / triangle /
  trapezoid), so `dcw` moves a *frequency* there. Casio named them after the
  window, which is why the manual is misleading.
- **Envelopes are flattened before the render, not stepped through modes.**
  `buildEnvelope()` collapses the eight `[rate, level]` stages plus the sustain
  point into one linear segment list, using the gate length — which is known up
  front. That covers the case that gives the electric pianos their character,
  where the key is released long before the attack finishes and the release
  ramps from wherever the level had got to.
- **One line at a time, not all lines per sample.** Measured ~5× faster: it
  puts every piece of a line's state in a local and keeps the sample loop free
  of an inner iteration. Both ways of combining lines are per-sample
  commutative, so the first writes and the rest add (or multiply, for ring).
- **`OUTPUT_TRIM` is exact, not a guess.** These waveforms are peak-to-peak 2
  by construction, but the DC-heavy ones (pulse, doublesine) sit pinned at a
  rail, so their peak *from zero* after the DC blocker is 2. Untrimmed, stock
  presets ran from 0.68 to 1.99 and half of them clipped at velocity 1.
- **The DC blocker is faithful, not a patch.** The hardware's output stage is
  AC-coupled and never passes the offset either; without it the DCA envelope
  turns that offset into a thump on every note.
- **`fullSpanSeconds()` is a fitted curve.** Casio published the 0..99 rate
  scale but never its meaning in seconds, and no teardown has recovered it.
  The two anchors were chosen by working backwards from the shipped tones. If
  it ever needs re-fitting, that is the honest way to do it — and `env_time`
  exists so a user never has to.
- `MAX_NOTE_SECONDS` (12) caps the render, generous because a CZ note *is* its
  release. Cost is ~0.35ms per second of audio per line.

**Options carry a `preset` sentinel.** Every option but `preset` accepts the
literal string `"preset"`, meaning "whatever the tone says", which is what
keeps the preset layer and the override layer from writing to each other.
`lines` and `octave` deliberately declare **no `choices`** — the console
coerces numeric-looking values to Numbers before `applyOptions`, whose choices
test is a strict `includes()`, so a declared `"1"` can never match a typed `1`.
Same reason `tapepad`'s `voices` and `bits` validate in `set()`.

## `synths/cz-tones.js` — the preset data

Twenty-eight Boards of Canada patches decoded from the Casio sysex dumps in
`.claude/context/Casio CZ 101/syx/`, one folder per record. Plain data, no host
contract — nothing at runtime reads the `.syx` files.

A single-tone dump is 264 bytes: seven of header, 256 of payload transmitted as
half-bytes (low nibble first), then `F7`. The payload joins back into 128 bytes
laid out in 25 fixed-length sections. The file's header comment carries the
field-by-field meaning; the decode is self-checking, which is why it can be
trusted — `a03-square-lead` comes back as wave code 1 (square) and
`sixtyniner-sine-pad` as a saw-pulse whose DCW envelope terminates at level
zero, which in phase distortion is exactly a sine.

## `processor.js` — `RibbitProcessor` (base)

Mirrors `RibbitSynth`: `name`, `input`/`output` (both `GainNode`s — subclasses wire
their own DSP between them), `active` (routing bypass, read by
`Channel._rewireChain`), `params` (`{ paramName: RibbitParam }` — see `param.js`
— this *is* meant to be filled in by subclasses; it's the introspection
surface the command router uses for `/reverb wet=0.5` and `/reverb help`),
`options` (same declarative non-rampable-settings map as `RibbitSynth.options`
— `RibbitReverb` uses it for `duration`/`decay`, whose setters rebuild the
impulse response in place), and `automation`.

Two shared behaviours also live here.

`createCrossfade(mix)` builds a **true** dry/wet fade (dry = 1 - mix) and
returns `{ param, dryGain, wetGain }` with the dry side pre-wired
(`input → dryGain → output`); the caller connects its wet chain into `wetGain`.
This is deliberately not what `reverb`/`delay` do — they keep dry at unity and
*add* wet, which is right for an effect layered beside a signal and wrong for
anything that acts on the signal itself, since a compressor's untouched dry
path would carry exactly the peaks it exists to control. It also yields
parallel processing for free at `mix=0.5`.

The implementation is why it lives on the base class rather than being
open-coded per processor: one value has to drive two gains in opposite
directions, and `RibbitParam`'s `onSet` only overrides the instant-set path, so
a *ramp* would move the wet side and strand the dry side — the same multi-node
limitation `RibbitDelay` still carries. Instead the param is a
`ConstantSourceNode`'s offset (via `RibbitParamSources`, which also handles the
silent-sink quirk that would otherwise make its scheduled automation unreadable
on `.value`), connected into both gains — once directly, once through a `-1`
inverter. `AudioParam` connections *sum* onto the intrinsic value, so
`dryGain`'s intrinsic 1 minus mix and `wetGain`'s intrinsic 0 plus mix track a
single param exactly, through instant sets, ramps, deferred `at=` and `/patch`
alike.

`dispose()` is the duck-typed teardown, called by `Ribbit.removeProcessor` and
`Ribbit.dispose` — the same hook synths and modulators already had, extended to
processors when `createCrossfade` arrived. It's needed because those
`ConstantSourceNode`s are running sources reaching `audioContext.destination`
through their own muted sinks, so they aren't reachable from `this.output` and
unwiring a processor from a chain doesn't stop them. The base implementation
disposes `this._paramSources`; `RibbitGoodenizer` overrides it to also tear
down its four children.

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

## `processors/compressor.js` — `RibbitCompressor extends RibbitProcessor`

A thin, honest wrapper around Web Audio's `DynamicsCompressorNode` (a real
feed-forward compressor with proper gain computation — not worth
reimplementing), plus a `makeupGain` after it and a `createCrossfade` around
both. All five node params (`threshold`/`ratio`/`attack`/`release`/`knee`) are
plain single-node `RibbitParam`s at the node's own documented ranges.

Makeup gain isn't decoration: compression only ever takes level away, so
without it a compressor is a volume drop. The crossfade is what makes parallel
compression possible.

`describeState()` reports live gain reduction. That's exported as
`formatReduction(compressorNode)` because `DynamicsCompressorNode.reduction` is
a plain float in the current spec, was an `AudioParam` in the original one, and
is absent entirely from a stub context — a display-only value must not throw
inside a summary line. `RibbitLimiter` and `RibbitGoodenizer` reuse it.

## `processors/saturator.js` — `RibbitSaturator extends RibbitProcessor`

`driveGain → WaveShaperNode → levelGain`, inside a crossfade. The split is the
design: `drive` is a pre-gain and therefore a real `AudioParam` that ramps,
while the curve *shape* is an option, since it rebuilds a `Float32Array`.
Folding drive into the curve instead would have made it non-rampable for
nothing.

**`buildCurve` normalizes to unity slope at the origin, not unity peak** — read
its comment before touching this file, because it was wrong the other way
round first. Peak normalization maximizes a curve's low-level gain: `tanh(3x)`
scaled that way has a slope near 3 at the origin, applying ~9.6dB of gain and
bending visibly long before full scale, so a mixed signal peaking at 0.3 came
back at 0.9 and there was no `drive` value at which the stage was clean. Unity
slope makes the curve tangent to the identity at zero, so quiet signal passes
untouched and `drive` alone decides how much reaches the bend. The cost is that
each character has its own output level at full drive (a wavefolder ends up
quieter than a clipper — true of real ones), which is what `level` is for.

Four characters: `soft` (tanh), `hard` (clipped identity — the most transparent
until driven), `fold` (a wavefolder; the curve turns around past its peak, so
louder input gets a *different* shape rather than a flatter one), `tape`
(asymmetric, adding even harmonics; the constant subtraction removes the DC
offset the asymmetry introduces without rebalancing the halves). The `character`
setter validates before assigning, per the rule `RibbitPatternVariator`'s
`pack=` learned: a set that throws must leave the object as it found it.

## `processors/tilt.js` — `RibbitTilt extends RibbitProcessor`

A low shelf and a high shelf in series, sharing a pivot frequency and moving in
opposite directions from one `tone` control (±12dB, fixed — a second control
for "how much of the one control" is one nobody moves). No crossfade: an EQ
blended with its dry signal is just a weaker EQ, and `tone=0` is already flat.

Both filters' `gain` and `frequency` start at intrinsic zero and are driven
entirely by two `RibbitParamSources` params connected in — `tone` through a
`+12` gain into the high shelf and a `-12` gain into the low shelf, `pivot`
unscaled into both frequencies. This is the same technique as `createCrossfade`
and for the same reason: `onSet` can't keep a *ramp* moving more than one node.

## `processors/limiter.js` — `RibbitLimiter extends RibbitProcessor`

`boostGain → DynamicsCompressorNode` at ratio 20, knee 0, attack 1ms. Ratio,
knee and attack are fixed and unexposed — a limiter with those adjustable is a
compressor, and pointing at `compressor` beats offering the same controls
twice. `boost` is the half that matters: a limiter alone only makes things
quieter, and the boost underneath turns "nothing clips" into "loud and even".
No crossfade, since a limiter you can blend past isn't one.

Documented honestly as a fast compressor rather than a lookahead brickwall —
Web Audio has no lookahead, so a fast enough transient can still exceed the
ceiling, which is why `ceiling` defaults to `-1` rather than `0`.

## `processors/goodenizer.js` — `RibbitGoodenizer extends RibbitProcessor`

The only **composite** in the engine: it constructs one each of the four
processors above, chains them `compress → saturate → tilt → limit`, wraps the
lot in its own `createCrossfade`, and republishes the children's *actual*
`RibbitParam` and option objects under its own `params`/`options`. Not a fifth
implementation — `/glue threshold=` and a standalone `/compressor threshold=`
are the same object, so they cannot drift.

Children are built with `new` rather than `ribbit.createProcessor`, so they're
never registered, never addressable, and never in an insert chain. Everything
generic then works with no extra code, because it all reads `params`/`options`:
help text, ramping, `at=`, `/patch` destinations, and session round-tripping
(its constructor accepts back every option it republishes, which is what
`session.js`'s `createProcessor(type, { name, ...options })` requires).

Stage order is the argument the class makes. Compression first so the saturator
sees a level that barely moves — that's what keeps distortion character
consistent as the music gets busier, which is most of what "evenly mixed"
means. Tilt after the saturator, to voice what came out rather than what went
in. Limiter last, since anything after it could undo it.

`drive` defaults to **1**, i.e. the saturation stage present but clean:
compression, tilt and limiting make a mix more like itself, while saturation
makes it something else, and a processor that alters timbre by default isn't
one to leave on every session. Deliberately *not* republished: the children's
`mix`, the saturator's `level`, the limiter's `boost` — each would be a second
way to set the same balance. `describeState()` prints both the compressor's and
the limiter's reduction; `dispose()` overrides the base to tear down all four
children.

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

Two things live here that only the *event-generating* subclasses use, and both
are on the base deliberately:

`eventDestinations` — an empty array, the channels a generator currently
delivers notes to, pushed/spliced by `RibbitEventPatch`. It was previously
declared per-subclass, which made it look optional when it isn't:
`patch.js` and `Ribbit._createEventPatch` index into it directly, so a new
generator that forgot it failed at *patch* time with a bare "cannot read
properties of undefined" — an error pointing nowhere near the omission, and one
that broke every `.notes` patch in a session file at load. A continuous
modulator simply leaves it empty; one uniform contract beats a conditional one.

`_stride()` — asks the patched destination how many sample slots one drum
category occupies (`RibbitPercSampler` publishes `slotsPerCategory`), falling
back to the subclass's own `perCategory` when there's nothing to ask. It lives
here rather than in each generator because it describes the **destination**,
not the generation strategy: all three percussion generators need exactly the
same answer, and that's what lets a pattern written against a 4-slot kit sound
identical on a 1- or 8-slot one, and lets two generators share one kit.

## `modulators/lfo.js` — `RibbitLFO extends RibbitModulator`

A continuously-running `OscillatorNode` (started once in the constructor,
never stopped) connected straight into `this.output` — a bipolar control
signal at `freq` Hz. `waveform` is a runtime option (its setter mutates
`osc.type` in place, which `OscillatorNode` allows live). `params.freq` is
an `RibbitParam` wrapping
`osc.frequency`; `get freq()` is the same kind of thin alias as a processor's
`get wet()`.

## `modulators/cv.js` — `RibbitCV extends RibbitModulator`

The minimal modulator, and useful as the reference for what the base class
actually requires: a `ConstantSourceNode` into `this.output`, one
`RibbitParam` (`params.value`) wrapping its `offset`, and nothing else — no
per-tick work, no `generateEvents`, no options. Because nothing moves on its
own, every change comes through the ordinary param path (instant set, ramp,
`at=` deferral, `automate=`), which is exactly what makes it read as "CV"
rather than a second LFO. `params.value` is deliberately given no `min`/`max`
(unlike `lfo`'s `freq`), on the same reasoning as a patch's `depth`: the
patch scales it per-destination, so clamping here would be an arbitrary cap.
`get value()` is the usual thin alias onto the underlying `AudioParam`.

## `modulators/markovpercs.js` — `RibbitMarkovPercs extends RibbitModulator`

The second event-generating modulator, and the opposite shape to
`RibbitRandomNotes`: it walks a first-order Markov chain over
`[rest, ...PERC_CATEGORIES]` **once**, from a seeded PRNG (`mulberry32` —
`Math.random()` can't be seeded, and seedability is what makes a rhythm
survive a session round trip), building a fixed `pattern` that
`generateEvents` then indexes straight off the absolute step number. No
cursor is needed (unlike `randomnotes`), and it realigns by itself after a
`/stop`/`/start`.

The split between options and params is deliberate: anything shaping the
pattern (`style`, `seed`, `steps`, `step_beats`, `density`) is an **option**
whose setter regenerates, because a param you could ramp but that's only
consulted at regeneration time would look like a control that does nothing.
`velocity`/`swing` are **params** precisely because they're read fresh every
tick and so genuinely ride the pattern already playing.

Pattern cells store `{ category, variant }` rather than a finished slot
number; `_stride()` resolves the arithmetic at delivery time, preferring the
patched destination's `slotsPerCategory` over this modulator's own
`per_category`. `describeState()` renders the pattern for the console (see
`commands.js`'s `paramObjectSummary`).

`STYLES` is named for texture, not genre, and there's no `fourfloor` on
purpose — a first-order chain has no notion of bar position, so it cannot
place a kick on every downbeat. That's `modulators/euclidpercs.js`'s job; it
shares this file's slot contract exactly, so both can drive one kit at once.

## `modulators/euclidpercs.js` — `RibbitEuclidPercs extends RibbitModulator`

The grid-position counterpart to `markovpercs`, and the other driver for
`RibbitPercSampler`. `euclid(pulses, steps)` is Bjorklund's algorithm —
repeatedly pair the "hit" groups with the "gap" groups until at most one
remainder is left; what falls out is the maximally-even distribution.
Verified against the canonical results (E(3,8) tresillo, E(5,8) cinquillo,
E(5,16) bossa, E(7,16), E(2,5)).

The structural difference from `markovpercs` is that **each category is an
independent layer**, built and stored separately in `this.layers`. A Markov
step is one voice; a euclidean step can be a kick *and* a hat, which is what
makes a kit pattern possible. `generateEvents` therefore loops over
`PERC_CATEGORIES` inside its step loop and may emit several events per step.

Rotation is applied as `hits[(step - rotation + steps) % steps]` — subtract,
so `snares_rotate=4` moves the first hit *to* step 4. Adding instead is
invisible on an evenly-spaced layer like E(2,16) (it's a symmetry of the
pattern) and obviously wrong on a single-pulse one, which is exactly how the
direction bug survived first testing.

`PRESETS` set grid length plus per-category pulses and rotations. The
constructor gives **explicitly-passed values precedence over the preset's**,
which is what makes `getOptions()` round-trip: a session stores both the
preset name and the concrete numbers, so an edited pattern reloads as edited
rather than snapping back. The `preset` *setter*, by contrast, replaces
everything — it's a "start again from here" gesture.

Randomization is split along the reproducible/live line:

- `variation` (option, seeded, regenerates) picks which sample slot within a
  category each hit uses. Part of the fixed pattern.
- `dropout` (param, live) skips hits per pass, re-rolled from `Math.random()`
  and deliberately *not* seeded. It's the only non-reproducible thing here,
  and it can only ever remove a hit, never move one, so the grid survives it.

The per-category options (`kicks`, `kicks_rotate`, ...) are built in a loop
over `PERC_CATEGORIES` rather than written out eight times, so a category
added to the sampler becomes drivable automatically instead of silently
going missing. `_stride()` is the same contract as `markovpercs`' — currently
the one piece genuinely duplicated between the two generators; a third grid
generator would be the point to lift it onto `RibbitModulator`.
`describeState()` renders one row per category.

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
sink into `audioContext.destination`, which reliably keeps it live
regardless of whether the mixer is even mounted. That machinery lives in
**`RibbitParamSources`** (`param.js`) rather than in this class: the same
idiom is needed by `RibbitMarkovPercs` (`velocity`/`swing`) and
`RibbitPercSampler` (`dynamics`/`pan_spread`/`speed_spread`), and was
open-coded three times before, each copy re-explaining the quirk and
keeping its own parallel sink array. A caller now writes
`this._paramSources.create(value, { min, max })` and gets a `RibbitParam`
back. Those sinks aren't reachable via `this.output`, so
`Ribbit.removeModulator`'s generic `modulator.output.disconnect()` alone
wouldn't tear them down — `dispose()` (called via the same
duck-typed-optional-hook pattern as `generateEvents` itself) delegates to
`this._paramSources.dispose()`, which stops every `ConstantSourceNode` and
disconnects every sink.

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

## `modulators/patternvariator.js` — `RibbitPatternVariator extends RibbitModulator`

The fourth generator, and the only one whose material is **authored rather than
derived**: it loads a hand-written pattern (see `pattern.js` above) and
generates seeded variations on it. Drives a `percsampler` (`drums` patterns,
through the same slot contract as `markovpercs`/`euclidpercs`) or any pitched
synth (`notes` patterns, emitting `degree`).

The organizing rule, and the thing to preserve when editing: **every operator
transforms existing material; none invents.** Concretely, pitched variation
draws from `pitchCollection(sequence)` — the pattern's *own* pitch classes —
rather than the harmony context's full scale, which is what keeps a variation a
recognisable version of the source instead of a wander. The weight tables
(`RHYTHM`, `MELODY`, probabilities at `variation=1`) are deliberately well
under 1: at full strength roughly two thirds of a source rhythm still survives,
which is the design target, not a limit.

Operator notes:

- Rhythm: `skip`, `displace` (only into a step the author left empty —
  displacing onto another hit would delete it, a bigger edit than this operator
  should make), `revariant` (re-pick the sample slot; the cheapest possible
  variation — same rhythm, different kit). Ghost notes fill rests, weighted per
  category by `GHOST_CHANCE`: an extra hat is what a drummer does without
  noticing, an extra kick moves the track's centre of gravity.
- Melody: `invert` and `octave` are weighted highest because they change the
  sound a lot and the harmony not at all. `neighbour` is the only operator that
  alters harmony, hence the modest weight. `passing` fills a gap with a tone
  between its neighbours.
- `REGISTER_LIMIT` (±24 semitones) folds runaway voices back: `invert` and
  `octave` are independent and can both land on the same voice, compounding to
  nearly three octaves from a source note. Folding by 12 preserves pitch class,
  so the harmony survives the register correction.

Each lane is varied **in place at its own length**, not expanded to the
pattern's — that preserves the format's polymeter promise, at the cost of a
short lane varying identically on each repetition, which is the right trade
since the repetition is why it was written short.

`variation` and `density` are **options, not params**, despite being numeric:
they're inputs to seeded generation rather than values read per note, so
ramping them would mean the pattern rewriting itself mid-phrase. `velocity` and
`swing` are params. This is the same split `markovpercs` makes, and the general
rule for the choice.

Two things that were bugs and are now invariants. `_select()` rolls `pack` and
`patternName` back if the new selection doesn't validate — a set that throws
must leave the object exactly as it found it, or the *next* command reports the
stale bad value instead of its own problem. And every draw must come from the
seeded `random()` in a **fixed order**, since reproducibility across a
save/load depends on the draw sequence being deterministic; inserting a
conditional draw mid-sequence changes every take after it.

## `modulators/chorale.js` — `RibbitChorale extends RibbitModulator`

The fifth generator, and the only one that isn't making a rhythm: sustained,
overlapping voices moving through a chord progression in a mode. Drives any
polyphonic synth (`tapepad`, `karplus`, `granular`), emitting `degree` so the
harmony context still resolves the key.

The organizing property, and the thing to preserve when editing: **there is no
state and no randomness**. Every note is a pure function of the absolute beat,
`MODES`, and the options — no seed, no cursor, no `onClockStart()`, and
nothing to reproduce across a save/load. Two consequences worth knowing before
changing anything here: it realigns by itself after a `/stop` `/start` (like
`markovpercs`/`euclidpercs`, unlike `randomnotes`), and a skipped lookahead
window costs one window of notes rather than desynchronising it permanently.

Two independent clocks, deliberately not locked to each other:

- the **chord clock** — `floor(beat / chord_beats)` indexes `progression`;
- the **voice clock** — voice `v` attacks at `k * note_beats + offset_v`,
  where `offset_v` spreads the voices across one period by `stagger`.

Because a voice takes whatever chord is current at *its own* attack time, a
voice that attacked before a chord change holds its old note across it. That
overhang is the suspensions, and it's the reason `note_beats` and
`chord_beats` are not derived from one another.

Continuity comes from `overlap`: a note's `duration` is
`note_beats * (1 + overlap)`, so each voice crossfades with itself rather than
gapping. The synth's own release runs on past that and the two stack.

**Voice leading is positional, not remembered** — the technique worth copying.
Each voice has a fixed register anchor (`v / (voices - 1) * spread * 12`) and
always takes chord tone `v % chord_size`, octave-placed nearest that anchor by
`tone + 12 * round((anchor - tone) / 12)`. That yields a fully voiced chord
where each voice moves the smallest interval keeping it in its own register —
the musical result a remembered previous-note approach would give, without the
cursor state that would cost. `transpose` is applied last, after the octave
placement, so it shifts a finished voicing rather than changing which octave
each tone lands in.

Chord building (`_chordDegrees`) stacks `chord_size` tones `stack` mode-steps
apart, carrying the octave whenever the walk runs off the top of the mode —
which is why `pentatonic` (5 notes) and `wholetone` (6) need no special case
and produce quartal/augmented stacks for free.

Param/option split: `velocity`/`note_beats`/`overlap`/`spread`/`stagger` are
params (all bounded at both ends, so all randomizable and all valid `/patch`
destinations); `mode`/`progression`/`chord_size`/`stack`/`chord_beats`/
`transpose`/`voices` are options. `chord_beats` is the interesting call — it
*is* read fresh, but a ramp on it would renumber every chord boundary
underneath the music rather than slowing the progression, so it's an option.
`progression` parses through `harmony.js`'s shared `parseDegreeList`.

A param is read when a voice **attacks**, not continuously, so a ramp or patch
on `spread` arrives voice by voice as each re-enters — the pad revoices itself
over a cycle rather than sliding. Read them with `getModulated()`, as every
generator must.

`describeState()` prints the whole progression as actually voiced. It can,
because the voicing is a pure function with no clock state to consult — which
the other generators' `describeState()` implementations cannot claim.

## `patch.js` — `RibbitPatch` / `RibbitEventPatch`

`RibbitPatch`: one continuous "patch cable" — connects a source object's
`.output` (a modulator, but also a track/master's post-fader signal or a
processor's post-effect signal — anything with an `.output`) into a
destination param, through its own `depthGain` (attenuator) node —
`sourceObject.output → depthGain → destParam.audioParam`. `destParam` is the
`RibbitParam`, not its bare `AudioParam`, so the cable can both drive it and
*announce itself* to it (`attachPatch`/`detachPatch`) — which is what lets a
param that gets read in JS rather than heard know it's modulated at all, and
build its `AnalyserNode` tap lazily. `depth` lives on the patch,
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
engine state (e.g. `clock.bpm`). `splitParamKey(key)` splits the one dotted
key shape the grammar allows (`cutoff.r`) into a param name and an attribute;
`isRandom`/`hasRandom`/`randomBounds` recognize the literal value `random` and
the line-level `min=`/`max=` that narrow it. `setInstant(audioContext, param, value,
startTime)` writes a value onto an `AudioParam` via
`cancelScheduledValues`+`setValueAtTime` rather than a direct `.value =`
assignment, so a deferred (`at=`) *instant* set is possible, not just a
deferred ramp.

`applyParams(nllc, paramsMap, input, timing, { reportUnknown })`
is the one function that knows how to get/set/ramp/defer/randomize any
`RibbitParam` (see `param.js`) against a parsed command value — shared by `channelCommand`
(gain/pan plus a track's synth's params), `paramObjectCommand` (every
processor/modulator param), and the `/patch` command (depth), replacing what
used to be three separate hand-rolled copies of the same
ramp/instant/`at=` branching. Its non-rampable sibling is
`applyOptions(nllc, object, input, timing, exclude)` — applies keys naming
entries in an object's declarative `options` map (rejecting ramp specs,
validating against `choices`), with `exclude` = `compositeClaimedKeys(params)`
so a composite command's generic keys (`automate=`'s `duration=`, say) don't
also hit a same-named option (reverb's `duration`). It takes `timing` because
an option, while never rampable, *is* schedulable — see `runAt` below.

`randomizeAll(nllc, paramsMap, spec, timing)` is the bulk `/<object> random`.
It doesn't reimplement anything: it filters `paramsMap` by `.canRandomize` and
hands `applyParams` a synthesized `{ key: "random", ... }` input, so a bulk
roll ramps (`random=4b`) and defers (`at=cycle`) by the same code path a
single one does. Params only — options have no range and no `.r` flag, and the
ones worth re-rolling already have their own (`seed=random`).

`runAt(nllc, { startTime, label }, pending, fn)` is the third scheduling
path, and the one that makes `at=` universal: it runs `fn` now, or defers it
via `automation.js`'s `scheduleAt`. Where `applyParams` picks between
`scheduleRamp` and `setInstant` for anything `AudioParam`-backed, `runAt`
covers everything that isn't — options, transport, routing, processor
inserts, event edits, patches, object creation and removal. `fn` returns the
"it happened" message; deferred, that can't be the command's return value, so
it goes to `nllc.notify()` and the caller's `pending` ("it will happen") text
is returned instead.

The rule this imposes on callers: **validate before the defer, never inside
it.** A throw from a bare timer has no command left to report to, which is why
`channelCommand` checks unknown `synth=`/`add_processor=` types explicitly
rather than letting the constructor throw, and why `applyOptions` validates
`choices` before calling `runAt`. `runAt`'s own try/catch is the backstop,
turning a genuinely-late failure into a `notify()` line rather than an
unhandled one. This is the same lesson `assertKnownTypes` encoded for
`session.js`. Top-level commands use the thin `scheduled(params, pending, fn)`
wrapper inside `createCommandRouter`, which additionally strips `at` from the
params forwarded on as constructor options.

The automate family —
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
- `start()`/`stop()`/`dispose()` — the lifecycle trio. `start`/`stop` back
  the `/start` and `/stop` commands and only resume/suspend: `stop` leaves
  everything built and restartable. `dispose()` is the one-way version, for a
  host discarding the engine entirely (a UI unmounting, a page navigating
  away): it `stop()`s, calls the duck-typed `dispose?.()` on every live synth
  and modulator, then `close()`s the `AudioContext`, returning that promise.
  It exists because **neither the context nor the clock is reachable by
  garbage collection** — the `AudioContext` is owned by the browser's audio
  thread, and `RibbitClock._tick` reschedules itself with `setTimeout`
  forever — so dropping the last JS reference to a `Ribbit` stops nothing.
  A host that unmounts without calling this leaves the session audibly
  playing (see `SessionPage.svelte`'s `onMount` cleanup in the reference app).
- `onMessage` / `notify(text, kind = "deferred")` — the channel for output no
  command is waiting on. `onMessage` is an optional host-supplied
  `(text, kind) => void`; `notify` calls it, or falls back to `console.log`.
  It exists because not everything can be a command's return value: deferred
  `at=` work reports back long after its command returned
  (`kind: "deferred"`), and a session auto-loaded from a URL never had a
  command at all (`kind: "readme"`). Without it, a deferred *failure* would
  vanish silently — worse than an immediate one, since the user has already
  been told the change was scheduled. `nllc`'s `SessionPage.svelte` wires it
  to `CodeEditor.appendOutput`.
- `readme` — the current session's introduction lines, set by
  `session.js`'s `loadSession` and written back by `sessionToJSON`. Empty for
  a session never loaded from a file.
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
  Each `params` block is accompanied by an optional sibling `no_random` array
  (`serializeNoRandom`) listing the params whose `.r` flag is off, so which
  params a bulk `random` touches survives a round trip. It records the whole
  excluded set rather than a diff against class defaults, and `applyNoRandom`
  only runs when the key is actually present — a session file written before
  `no_random` existed keeps each class's own defaults instead of having them
  all switched on.
  `sessionToJSON` adds a `version`, `nllc.states` (see `/save` below), and
  the session's `readme` on top of the same shape `snapshotSession` returns.
  The readme is deliberately *only* on `sessionToJSON`: it describes the
  session as a document, so a `/save`d state carries no copy of it.
  `normalizeReadme` accepts either an array of lines (the readable way to
  write several lines in JSON, which has no multi-line string literal) or one
  `\n`-joined string; `loadSession` stores it on `nllc.readme` and pushes it
  through `nllc.notify(..., "readme")` once the graph exists, and
  `clearSession` resets it so a file without one can't inherit the previous
  session's. Every rampable value comes
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
  fires once more. Both resolve through `addressableParams()`, not
  `object.params`, so automation targeting a track's **synth** param
  round-trips; resolving it the narrow way would have silently dropped
  exactly those events on save — the worst kind of data loss, the kind you
  only notice on reload.
- `assertKnownTypes(nllc, snapshot)` (private) — checks every `.type` in a
  snapshot against the live registries and throws listing all unknown ones
  at once. Both rebuild paths below call it **before their first mutation**,
  because neither is atomic: the `create*` calls aren't individually
  guarded, so one dead type would otherwise throw partway through and leave
  a graph that's neither the old session nor the new one. It matters more
  for `applySnapshot`, where almost every `create*` runs inside a deferred
  `scheduleAt` callback — a throw there would escape a bare timer long after
  `/recall` had already reported success.
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
