# Architecture

Ribbit has two halves that meet at a single object: a plain-JS DSP/scheduling engine
(`src/`) and a Svelte interface (`src/routes`,
`src/lib/components`) that renders and drives it. There is exactly one `Ribbit`
instance per page, created client-side (it touches `AudioContext`, which doesn't
exist during SSR).

## Interface tree

```
routes/+layout.svelte                   theme.css / reset.css, favicon — global chrome only
routes/+page.svelte                     blank-session link + a dropdown of every static/sessions/*.json
│                                         (listed by +page.server.js), plus an audio-options
│                                         panel (output device / latency hint) that only ever writes
│                                         to localStorage — this page never touches AudioContext itself
routes/code-editor/+page.svelte         <SessionPage /> — a blank session
routes/code-editor/[session]/+page.svelte   <SessionPage sessionUrl="/sessions/<slug>.json" />
SessionPage.svelte                      owns the Ribbit instance + executeCommand; top-level layout
├── CodeEditor.svelte                   text input + scrollback log; calls onCommand(text) prop;
│                                        owns command history (↑/↓) and exposes insertAtCursor(text)
└── Mixer.svelte  /  CollapsedRail.svelte    (toggled by a collapse arrow)
    ├── Transport.svelte           engine on/off, clock LED, beat/bpm readout,
    │                               Save JSON/Load JSON buttons (run /save_json,/load_json
    │                               via the same onRunCommand path CodeEditor's own submit uses)
    ├── MixerSection.svelte        one per titled panel (Tracks/Buses/Master/Modulators) —
    │                               collapse/resize chrome only; renders whatever's passed as children
    ├── MixerChannel.svelte        one per track, one per bus, plus one for master
    ├── ModulatorStrip.svelte      one per modulator (Modulators section)
    └── PatchList.svelte           every active patch cable, as a flat list
```

`SessionPage.svelte` (`src/lib/components/code-editor/`) is the only place
the `Ribbit` instance and its `createCommandRouter`-produced
`executeCommand`/`suggest` functions live; they're passed down as props
(`onCommand`/`onSuggest` on `CodeEditor`). Both route pages are thin
wrappers around it — a session route is never anything more than "which
`sessionUrl`, if any, to hand it" — so the two routes can't drift apart
in layout/polling logic, only in which JSON (if any) gets loaded once the
engine exists. Neither route hand-authors content of its own;
`/code-editor/<slug>` just `fetch()`es `static/sessions/<slug>.json` and
calls `session.js`'s `loadSession` on it once the engine's constructed —
exactly what `/load_session` does with a picked file, minus the file picker
(see `session.js` in [source-overview.md](source-overview.md#sessionjs)).
Because the slug is taken straight from the URL rather than checked against
a list, dropping a new file into `static/sessions/` is all it takes to give
it a route; a slug with no matching file opens an empty session and says so
in a banner.
`SessionPage` also owns a `requestAnimationFrame` poll loop that diffs each
of `nllc.tracks`, `nllc.buses`, `nllc.modulators`, and `nllc.patches`
against its own last copy **by element identity** (length + per-index
`!==`), not by joined names/ids — loading a session whose names match
what's already live (e.g. the same file twice) replaces every object with a
fresh instance while leaving the name list byte-identical, and a name-based
diff would keep the mixer bound to the torn-down originals — to detect
additions/removals/replacements — these are plain mutable arrays, not Svelte state, since
they're mutated from inside the DSP layer (`Ribbit.createTrack`/`removeTrack`/
`createBus`/`removeBus`/`createModulator`/etc., and now also `loadSession`),
not from component code. `MixerChannel.svelte` does the same trick for a
channel's `processors` list, and needs no changes at all to also render a
bus strip — it only ever reads `channel.gainNode`/`channel.pan`/
`channel.processors`, all present on any `RibbitChannel` regardless of whether
it has a `.source`.

### Audio options: localStorage as the handoff, not a store

The homepage's audio-options panel (output device via
`navigator.mediaDevices.enumerateDevices()`/`AudioContext.setSinkId`,
latency via `AudioContext`'s `latencyHint`) never touches an `AudioContext`
itself — it can't, since `AudioContext`/`Ribbit` are constructed per session
page, not on the homepage. It writes two plain values to `localStorage`
(`nllc:audioLatencyHint`, `nllc:audioOutputDeviceId`); `SessionPage` reads
them once in `onMount`, before constructing `Ribbit` (`latencyHint` is a
constructor-time-only `AudioContext` option — see `ribbit.js` — so it has to
be read first), and applies the saved output device via `setSinkId` right
after, feature-detected and best-effort (`.catch(() => {})`) so a browser
without `setSinkId` support, or a since-unplugged device id, just falls back
to the platform default instead of failing session startup. `localStorage`
rather than a shared Svelte store or URL params is deliberate: the value
needs to survive a full navigation to a different route (the homepage link
click), and outlive the current tab, with no coordination required between
pages that never run at the same time.

Everything below `code-editor/+page.svelte` reads live values off the `Ribbit`
object's real Web Audio nodes directly (`channel.gainNode.gain.value`,
`channel.pan.value`, an `AnalyserNode` tapped onto `gainNode`/a modulator's
`output` for a meter) rather than through a duplicated reactive store — the DOM
is a thin, polled view onto the audio graph, and the console (`executeCommand`)
is another view onto the exact same graph. Neither is a source of truth; the
`Ribbit` instance's nodes are. Both `MixerChannel.svelte` and
`ModulatorStrip.svelte` take care to wrap their `AnalyserNode`-tap cleanup in a
`try { ... } catch {}` — if the track/modulator was removed from the console
while the strip was still mounted, `nllc.removeTrack`/`removeModulator` already
did a blanket `.disconnect()` that silently takes the tap connection down with
it, so the specific `.disconnect(analyser)` in the component's own cleanup
would otherwise throw on an already-severed connection.

### Mixer layout: `MixerSection` as shared collapse/resize chrome

`Mixer.svelte` composes four titled panels — Tracks, Buses, Master,
Modulators — each wrapped in `MixerSection.svelte`, which owns nothing about
*what* a panel shows (that's whatever's passed as its `children` snippet)
and only the collapse/resize chrome around it, in one of two layouts:

- **`"row"`** (Tracks, Buses, Master — sit side by side in `Mixer.svelte`'s
  `.row`): a vertical (rotated) label beside a horizontally-stretching body.
  `grow` (Tracks only) makes the body `flex: 1` instead of sizing to its own
  content, so a long track list scrolls *inside* its own section instead of
  forcing the whole row wider than the mixer pane and pushing Master onto a
  second line underneath everything — the bug this shape specifically fixes.
  `resizable` (Tracks, Buses — not Master, which is intentionally neither
  resizable nor collapsible, so it's never accidentally hidden or squeezed
  away) adds a drag handle; before the first drag a section sizes itself
  normally (`flex:1` if `grow`, else content-sized up to `maxWidth`), and
  dragging measures the live DOM width at that instant and locks it in as a
  fixed pixel width going forward (at which point `grow` stops applying, so
  an explicit width and `flex:1` don't fight).
- **`"full"`** (Modulators, its own 100%-width row below `.row`): a
  horizontal label above a full-width scrollable body. Never `resizable` — a
  drag handle stacked below full-width content (rather than beside it, like
  the row sections get) has nowhere sensible to live and just reads as a
  stray control, so `Mixer.svelte` doesn't enable it there.

Collapsing (either layout) hides only the body — the title stays visible
always (rotated in `"row"`), so a collapsed section still reads as "this is
what's hidden here" rather than a bare arrow with no context. `Master`'s own
`MixerSection` is wrapped in a `margin-left: auto` div in `Mixer.svelte` so
it hugs the row's right edge regardless of how much (or little) space
Tracks/Buses currently take up.

### Click-to-paste: an imperative export, not another prop

`CodeEditor.svelte` owns the console `<input>`'s text and cursor, so pasting
into it from anywhere else in the mixer needs a way back into that
component. Rather than duplicating the input's state as a `$bindable` prop
(which would mean two sources of truth for the same text), `CodeEditor`
exposes an ordinary component export — `export function insertAtCursor(text)`
— which `code-editor/+page.svelte` reaches via `bind:this={codeEditor}` and
wraps in a stable `insertIntoConsole(text)` callback, threaded down as an
`onInsert` prop through `Mixer.svelte` to every `MixerChannel.svelte`/
`ModulatorStrip.svelte` instance. Clicking a name/param label there just
calls `onInsert(text)`; `insertAtCursor` inserts at the input's actual
`selectionStart`/`selectionEnd` (replacing a selection if there is one), then
refocuses and re-places the caret after what it inserted. It appends a
trailing space unless the text already ends in `=` (so `gain=` flows straight
into typing a value, while a bare name like `track_1` doesn't run into
whatever's typed next). `MixerChannel`'s insert badges keep their existing
plain-click bypass toggle and layer shift+click on top for "paste this id"
instead, rather than taking over the primary click.

### Console suggestions: ghost-text completion

`createCommandRouter(nllc)` returns `{ executeCommand, suggest }` (not just
`executeCommand` — the one call site, `code-editor/+page.svelte`, destructures
both). `suggest(input, cursorPos)` wraps `commands.js`'s
`suggestCompletion(nllc, topLevelNames, input, cursorPos)`, returned this way
rather than attached as a property on `executeCommand` so both stay ordinary
named values threaded down as two separate props (`onCommand`/`onSuggest`) to
`CodeEditor.svelte`, instead of a function secretly carrying extra state.
`suggestCompletion` works at any cursor position within the input, not just
the end (mid-line completion pushes later-in-the-line text over rather than
only ever appending — see the rendering technique below), and completes
three token shapes: the `/name` itself (`addressableNames` — any addressable
object, then top-level commands); once past the name, a bare param *key*
(`resolveKeywordsFor` → `channelKeywordsFor`/`paramObjectKeywordsFor`, each
object's own `params` keys plus one of two small hand-maintained keyword
lists for non-param commands); or, once a key's `=` is typed and **at least
one character of its value follows**, the value itself, but only for keys
with a small enumerable candidate list (`resolveValueCandidates` — a
registered type name for `synth=`/`type=`/`add_processor=`, `"beat"`/
`"cycle"` for `at=`, an existing object name for `out=`/`add_send=`/
`source=`/`dest=`, an existing state/patch/send id, ...); an open-ended value
(a number, a freshly-chosen name) is left alone. The empty-value guard is
deliberate, not an oversight: without it, typing `type=` with nothing after
it yet would "complete" to whichever candidate happens to be listed first
(e.g. `lfo`, the first key in `MODULATOR_TYPES`) and, if Enter is pressed
before typing anything further, silently create *that* instead of whatever
was actually intended — the same guard the `/name`-token and bare-key
branches already had (an empty partial there also returns no suggestion),
just missing from the value branch until it was added. See
[source-overview.md](source-overview.md#commandsjs) for the full breakdown
of `addressableNames`/`resolveKeywordsFor`/`resolveValueCandidates`/
`pickBestMatch`, and
[adding-commands.md](adding-commands.md#keeping-suggestions-in-sync) for
what a new command needs to stay suggestible.

`CodeEditor.svelte` renders the suggestion as inline "ghost text": a `.ghost`
div sits in the same box as the real `<input>` (identical font/padding/
border, both zeroed) and is the *only* layer that actually paints visible
text — the real `<input>`'s own glyphs are made fully transparent
(`color: transparent`, with `caret-color` kept so the blinking caret is still
visible), and the ghost overlay composites three spans around wherever the
suggestion's token sits: already-typed text before it, the dimmed suggested
remainder, and already-typed text after it. Because both elements share the
same monospace font, the overlay lines up with the real input
character-for-character without measuring anything in JS. This (rather than
an always-invisible span for typed text plus a visible one for the
suggestion, which only ever worked for a suggestion appended at the very
end) is specifically what makes mid-line completion possible: accepting a
suggestion splices it into `suggestion.start..end` and the "after" span
shifts over in the overlay to match, instead of a stale, un-shifted copy of
that trailing text showing through from the real `<input>` underneath.
Recompute happens imperatively (`updateSuggestion(target)`, called from
`oninput`/`onkeyup`/`onclick` on the input) rather than through a `$effect`,
reading straight off the DOM event's own `target.value`/`selectionStart`
instead of the `input` state variable — this sidesteps a possible
one-keystroke race if Svelte's own `bind:value` listener and this
component's listener don't fire in a guaranteed order for the same native
event.

One CSS pitfall worth flagging since it already bit this feature once:
Svelte's component-scoped CSS is scoped *per tag*, not per class — a bare
`.input { color: transparent }` rule (meant only for the real `<input>`
element) also matches a submitted command's own scrollback line, since
`entry.type === "input"` gives that `<div>` the class `"line input"` too.
Left unqualified, every echoed command silently disappears from the
scrollback right after pressing Enter. The fix is qualifying the selector to
the actual element (`input.input`), not just avoiding the name collision by
luck.

Right arrow accepts a showing suggestion into the input without submitting
(`acceptSuggestion()`); Enter, when a suggestion is showing, accepts *and*
submits in one step (`acceptSuggestion({ run: true })` — computes the
completed string, then calls `submit()` synchronously, which is safe because
reading a Svelte 5 `$state` variable back immediately after writing it
reflects the new value with no render/flush needed in between). Both call
sites share one function rather than duplicating the "how do I turn a
suggestion into a final string" logic.

Command history (↑/↓ recall) is otherwise unrelated state living entirely
inside `CodeEditor` itself — `history` (every submitted command, oldest
first), `historyIndex` (-1 = not browsing), and `historyDraft` (what you'd
started typing before you pressed ↑, restored when you arrow back past the
newest recalled entry). The two features share the same physical keys
though: ↑/↓ only drive history when the input is empty *or* `historyIndex !==
-1` (already mid-browse, so stepping further still works even though a
recalled line isn't empty) — otherwise they're reserved for a future
suggestion-cycling feature (not built — see
[overview.md](../llm/overview.md)) and simply do nothing. A genuine `input`
event (typing/paste/cut — as opposed to one of this component's own
programmatic `input = ...` assignments, none of which dispatch a native
event) always resets `historyIndex` to `-1`, so starting to type again
correctly "leaves" history-browsing mode.

## DSP object graph

```
Ribbit
├── audioContext            (suspended until /start)
├── clock: RibbitClock        drives every registered "unit"
├── master: RibbitChannel     final bus → audioContext.destination
├── tracks: RibbitTrack[]     extends RibbitChannel, each wraps one .source (a synth)
├── buses: RibbitChannel[]    plain channels, no .source — addressable send destinations
├── processors: RibbitProcessor[]   flat list of every processor that exists anywhere,
│                                  for name/id lookup + removal; ownership/insertion
│                                  order lives on the owning Channel, not here
├── modulators: RibbitModulator[]   flat list of every modulator (e.g. an lfo) —
│                                  named/addressable like a processor, but never
│                                  joins a channel's chain; exists to be patched
└── patches: RibbitPatch[]    every active "patch cable" (source.output → depth → destParam)
```

### Signal chain (per `RibbitChannel` — master, a track, or a bus)

```
input ──▶ [processors[0].input → .output] ──▶ [processors[1] ...] ──▶ panner ──▶ gainNode ──┬──▶ sends[0]: sendGain ──▶ destination0.input
                                                                                              ├──▶ sends[1]: sendGain ──▶ destination1.input
                                                                                              └──▶ ...
```

`_rewireChain()` rebuilds the `input → panner → gainNode` portion every time a
processor is added/removed/bypassed, skipping any processor with `active ===
false` (a true routing bypass — the node is disconnected, not just silenced).
It never touches `sends` — those hang directly off `gainNode`, independent of
the insert chain. A track's `input` is fed by its synth's `output`
(`RibbitTrack` wires `source.output → this.input` in its constructor and in
`setSource()`); a fresh track's/bus's one default send targets `master`
(`connect()`, called at creation) unless `out=` names something else.

### Sends: one channel, several simultaneous destinations

Before buses existed, `RibbitChannel.connect(destination)` was a single
replaceable edge — `gainNode` disconnected and reconnected to wherever it
should feed next. That's still the *common* case (a fresh track/bus feeds
master alone), but it's now sugar over a more general model: `this.sends` is
an array of `{ id, destination, destName, params: { gain: RibbitParam } }`,
each its own independent `gainNode → sendGain → destination.input` edge with
its own rampable gain. `addSend(destination, { destName, gain })` adds one
without disturbing the others (e.g. a track can send dry to master *and*
add_send= a reverb bus at a lower level); `removeSend(id)` tears down just
that one; `connect(destination, destName)` clears every existing send and
adds a single fresh one at gain 1 — what a plain `out=<name>` console command
does. A **bus** (`Ribbit.createBus`, `/add_bus`) is nothing more than a bare
`RibbitChannel` (no `.source`) registered in `nllc.buses` under its own name —
it exists purely to be a `destination` other channels' sends can point at
(a shared reverb send, a drum sub-mix, etc.), and since it's a full
`RibbitChannel` it can itself have processors, its own sends elsewhere, and be
a patch destination (`bus1.gain`) exactly like a track or master.

`Ribbit._removeSendsReferencing(object)` mirrors `_removePatchesReferencing`:
when a track/bus is torn down, every *other* channel's send pointing at it
is disconnected and removed first (same "must run before the object's own
blanket `.disconnect()`" ordering constraint patches already have). The one
routing guard in place today is `addSend` refusing a channel sending to
itself; a longer cycle (bus A → bus B → bus A) isn't detected — see
`docs/llm/overview.md`'s limitations list.

### One param abstraction for everything rampable/patchable

`RibbitParam` (`param.js`) wraps a single raw `AudioParam`, with optional
value-transform (`decode`/`encode`, used by channel `gain`'s exponential
taper), `min`/`max` clamping, and an `onSet` override for a param that has to
fan a single value out across more than one node (`RibbitDelay`'s `time`/
`feedback`). Every kind of object with rampable params — `RibbitChannel`
(`gain`/`pan`), `RibbitProcessor` subclasses, `RibbitModulator` subclasses, and
`RibbitPatch` (`depth`) — exposes them as `this.params = { key: RibbitParam }`.
`commands.js`'s `applyParams()` is the single function that knows how to
get/set/ramp/defer *any* of them, used identically regardless of which kind
of object owns the param.

This matters because before `RibbitParam` existed, a param's console-facing
`{get,set}` closure and the separately-declared same-named raw-`AudioParam`
getter that ramping code reached into (e.g. `get wet()`) were two independent
things a class author had to keep in sync by hand — easy to add one and
forget the other. `RibbitParam` is the single source of truth for both; a class
that still exposes a getter like `get wet()` (for use as an
`RibbitAutomationEvent` target elsewhere in the codebase) does so as a thin
delegate onto `this.params.wet.audioParam`, not a second implementation.

**Options** are the non-rampable counterpart, with the same
one-declaration-drives-everything philosophy: every synth/processor/
modulator also exposes `this.options = { key: { get(), set(value),
choices? } }` for runtime settings with no `AudioParam` behind them
(`waveform`, `randomnotes`' `scale`, `RibbitReverb`'s `duration`/`decay` —
whose `set` rebuilds the impulse response in place — `RibbitDelay`'s
`stereoOffset`, `RibbitSampler`'s `samples`). `commands.js`'s
`applyOptions()` is the one function that applies them (rejecting ramp
specs — nothing to schedule — and validating against `choices`, which also
drive ghost-text value completion); `help` lists them separately from
params; and the base classes' `getOptions()` *derives* its session
serialization from the same map (its keys match what the constructor
accepts back), so a subclass declares an option exactly once and never
overrides `getOptions()`. A track's synth's params/options are routed
through the track's own console name by `channelCommand` (`/lead
waveform=square`) — a synth is never separately addressable, its channel is
its surface. One wrinkle `applyOptions` handles centrally: composite
commands (`add_event`, `automate=`) claim generic keys (`beat=`,
`duration=`, `from=`, `to=`) that can collide with an option's name
(reverb's `duration`), so option application skips keys a composite in the
same command already claimed.

### Modular patching

`RibbitModulator` (`modulator.js`, e.g. `RibbitLFO`) is structurally a processor's
sibling — named/addressable, exposes `params` the same way — but never sits
in a channel's insert chain; it exists purely to be *patched* into some other
object's parameter. `RibbitPatch` (`patch.js`) is the "cable": it connects a
source object's raw `.output` (a modulator, but also a track/master's
post-fader signal, or a processor's post-effect signal — anything with an
`.output`) into a destination `AudioParam`, through its own `depthGain`
(attenuator) node — `source.output → depthGain → destParam`. This is a
direct application of a native Web Audio feature: connecting any `AudioNode`'s
output straight into an `AudioParam` **adds** to whatever value is already
scheduled there via the normal `setValueAtTime`/ramp machinery, so a patched
modulator and a console ramp on the same param don't fight each other — the
modulator just wobbles on top of whatever the base value currently is.

Depth lives on the *patch*, not either endpoint — deliberately, so the same
modulator can drive several destinations at different depths (a real
patch-cable-plus-attenuator model), and removing one patch (`Ribbit.removePatch`)
never touches either endpoint directly, just the one cable. `Ribbit` tracks
`sourceObject`/`destObject` on every patch specifically so
`removeTrack`/`removeProcessor`/`removeModulator` can cascade-remove any patch
referencing the object being torn down (`_removePatchesReferencing`) — this
must run *before* the object's own node teardown, since a patch's own
`disconnect()` uses a specific-argument `.disconnect(node)` call that throws
if that exact connection was already severed by a blanket `.disconnect()`
first.

### Event-generating modulators: the discrete counterpart to a patch

`RibbitPatch` above is one shape of "connect a source somewhere else" — a
continuous signal into an `AudioParam`. The other shape, for a modulator that
generates discrete *notes* rather than a signal (e.g. `RibbitRandomNotes` —
`modulators/randomnotes.js`), is `RibbitEventPatch`, deliberately kept as a
separate, simpler class rather than shoehorned into `RibbitPatch`: there's no
`depthGain` node, no `AudioParam` connection at all, and no `depth` param —
just bookkeeping (`sourceObject`/`destObject`/`sourceName`/`destName`, an
`id`) plus one side effect its constructor performs: pushing `destObject`
(a channel, not its synth directly — see below) onto
`sourceObject.eventDestinations`, an array the source modulator itself owns.
`disconnect()` is the inverse — splice it back out.

The clock is what actually moves notes along this "cable." `RibbitClock`'s
uniform per-unit contract (`events`/`automation`/`trigger()`/`active`) gains
one more optional, duck-typed member: a unit exposing
`generateEvents(fromBeat, toBeat)` is asked, every tick, for whatever
`RibbitEvent`s it wants to fire in that range — but unlike a synth's `events`
array (matched against a *loop-relative* beat position, since a pattern
repeats every `loopLengthBeats`), `generateEvents` is handed an **absolute**,
non-looping beat range (`loopBeatStart + rangeStart`/`rangeEnd`, the exact
sub-range `_scheduleRange` already slices per loop iteration for its own
bookkeeping — reused here for its "correctly tiles a lookahead window with no
gaps or overlaps across ticks" property, not because generation cares about
loop boundaries at all). This is what lets `RibbitRandomNotes` track state like
"beats since the last note" (`_nextCandidateBeat`) that advances forever
instead of resetting every pass through the loop — the entire reason this
needed to be a new hook rather than reusing the existing `events`-array
mechanism, which assumes a fixed, repeating pattern. For each generated
event, the clock computes its `AudioContext` time and calls
`destination.source.trigger(time, event, secondsPerBeat)` — the *exact* same
method a manually-`add_event`'d note triggers through — for every channel in
`unit.eventDestinations`, skipping any whose synth is currently paused
(`destination.source.active === false`, mirroring how a paused synth's own
authored events already stop scheduling). One generated stream can feed
several destinations at once, the discrete analogue of one LFO signal
patched into several params at different depths.

`eventDestinations` stores the **channel** (a track), not its `.source`
synth directly, specifically so a `.notes` patch survives a `synth=` swap —
the same property a `track_1.gain` patch already has, since gain also lives
on the channel rather than the synth. `ribbit.js`'s `createPatch` branches on
this at creation time: a `destName` ending in `.notes` (a reserved,
non-`AudioParam` pseudo-param, never a key in any object's real `params`
map) routes to `_createEventPatch` instead of the normal `_resolveDest`
path, which validates the source actually has a `generateEvents` method
(duck-typed, not an `instanceof` check — any future event-generating
modulator qualifies automatically) and the destination channel actually has
a `.source` (rejecting master/a bus with a clear error, rather than silently
creating a patch that can never deliver anything).

Session save/load and `/recall` treat an event patch as just another patch
with no `depth` to serialize/ramp — `session.js`'s `serializePatch`/
`reconcilePatches` both check `patch.params.depth` before touching it, since
an `RibbitEventPatch`'s `params` is `{}`.

### Harmony context

`Ribbit.harmony` (`{ root, scale }`, from `harmony.js`) is one shared object
constructed once in the `Ribbit` constructor and threaded into every synth via
`createSynth`'s `{ ...options, harmony: this.harmony }`. An `RibbitEvent` can
carry `degree` instead of (or alongside) `pitch`; a pitched synth (`oscsynth`)
resolves `degree` against `this.harmony` inside `trigger()` — i.e. at the
moment the note actually sounds, not when the event was authored. This is
deliberate: since every synth holds a *reference* to the same context object,
mutating its fields in place — which is exactly what the `/harmony [root=]
[scale=]` command does — retunes every pattern using `degree`, live, without
touching a single event. `scale` defaults to chromatic (`[0..11]`), so
`degree` behaves as a plain semitone offset until `/harmony scale=` narrows
it (`parseDegreeList` in `harmony.js` validates the list — shared with
`RibbitRandomNotes`' `scale` option, so the two can't drift). Chord/
progression logic on top of this remains future work.

### The clock is a lookahead scheduler over "units"

`RibbitClock.units` is a flat, undifferentiated array of anything with the shape
`{ events?, automation?, trigger(time, event, secondsPerBeat), active? }`. Synths,
channels (tracks/master), processors, *and* modulators all get registered as units:

- A synth's `events` are note-like `RibbitEvent`s; its `trigger()` makes sound.
- A channel's, processor's, or modulator's `automation` is
  `RibbitAutomationEvent`s (parameter ramps, e.g. a fade-in on `track.volume`
  or an opening reverb `wet` — authored via the console's `automate=`
  command, see [Two ramp-scheduling paths](#two-ramp-scheduling-paths-one-curve-implementation));
  these don't implement `trigger()` themselves — the clock schedules
  automation directly via `scheduleAutomationEvent()`, keyed off the same
  `unit.automation` array shape.

`Ribbit.createTrack` registers **two** units for one track: the synth (`source`) and
the `RibbitTrack` itself, because they have independent `events`/`automation` lists
(a synth's notes vs. the track's own volume/pan automation). A modulator
registers as one unit — its own params ride the same `unit.automation`
mechanism (`/lfo1 automate=freq to=12 beat=3 duration=0.5` sweeps an LFO's
rate at a loop position, exactly like a processor param).

Scheduling runs via `setTimeout`, not `requestAnimationFrame` (so it keeps ticking
in a background tab): every `lookaheadMs` (25ms) it looks `scheduleAheadTime`
(0.1s) into the future, converts that window to a beat range, and schedules any
event/automation whose `.beat` falls in range using precise `AudioContext` time
(`beatToTime`). The whole pattern repeats every `loopLengthBeats` (default 4)
beats — `_scheduleRange` handles a lookahead window that straddles a loop boundary
by iterating loop indices, not just beat numbers. `RibbitAutomationEvent.once` events
(e.g. a one-time fade-in) are marked `_scheduled` after firing so they don't replay
on subsequent loops. `unit.active === false` (a track paused via `/track_1 stop`, or
a bypassed processor) makes the clock skip that unit's events *and* automation
entirely for that tick.

`_tick()` wraps its call to `_scheduleRange` in a try/catch, so a single bad
event/param (something that throws inside a native `AudioParam` call, e.g. a
non-finite value that slipped through) can only drop that one scheduling pass
— the reschedule (`setTimeout(() => this._tick(), ...)`) runs unconditionally
right after, so the whole engine going permanently silent from one bad command
is never possible. `commands.js`'s `toNumber()` is the first line of defense
(reject bad input before it's ever applied); this is the second, structural
one.

`start()` also calls `unit.onClockStart?.()` on every registered unit (a
third optional, duck-typed hook alongside `trigger()`/`generateEvents()`):
a clock (re)start rewinds the absolute beat position to 0, so a unit
holding its own absolute-beat state — `RibbitRandomNotes`' candidate-grid
cursor is the one current example — must reset it there, or a `/stop`
`/start` would strand it at the pre-stop beat number, silently generating
nothing until the clock caught back up.

Both `bpm` and `loopLengthBeats` are runtime-mutable. `setBpm` is glitch-free —
it rebases `startTime` so the current playback beat doesn't jump — and also
cancels any in-flight `rampBpm`. `rampBpm(targetBpm, durationSeconds,
{startTime})` glides tempo over time; since bpm isn't a native `AudioParam`
(it's a plain number the clock uses for its own beat↔time math), this can't
ride `linearRampToValueAtTime` the way a channel/processor param can — instead
it steps `_applyBpm` repeatedly on a short `setTimeout`, each step
re-deriving `startTime` the same glitch-free way `setBpm` always has.
`setLoopLengthBeats` has no ramp equivalent by design (a fractional,
constantly-shifting loop length has no sensible meaning) — both are exposed
via `/clock bpm= num_beats=`. `_scheduleRange` reads both fresh every tick, so
a change takes effect on the next tick; changing `loopLengthBeats` mid-loop
can shift where the current loop boundary falls, an accepted live-coding
wrinkle rather than a bug. The clock also exposes `currentBeat()`,
`nextBeatTime()`, and `nextCycleTime()` — the anchor points a console ramp or
a deferred instant set uses to defer its start (see below) rather than firing
immediately.

### Two ramp-scheduling paths, one curve implementation

`automation.js` has a private `applyRamp(param, time, endTime, from, to, curve)`
that is the only place that turns a curve name into actual `AudioParam` calls
(`linearRampToValueAtTime`/`exponentialRampToValueAtTime`/`setTargetAtTime`).
Two exported functions call into it for two different use cases:

- `scheduleAutomationEvent(time, event, secondsPerBeat)` — the clock calls this
  directly for `RibbitAutomationEvent`s sitting in a unit's `.automation` array,
  matched against loop-relative beat position the same way `events` are.
  These are authored from the console: `automate=<param> to= [from= beat=
  duration= curve= once]` on any channel (gain/pan), processor, or
  modulator (all three own an `.automation` array — `RibbitModulator` grew
  one for this), with `automations`/`remove_automation=<n>`/
  `clear_automation` for inspection/removal. A console-authored event
  records the `paramKey` it targets, which is what lets `session.js`
  serialize automation by param name (`serializeAutomation`/
  `rebuildAutomation`) — from/to stored as user-facing (decoded) values,
  re-encoded on rebuild — so loop automation survives `/save`/`/recall`
  and session files. An event built in code against a bare `AudioParam`
  (no `paramKey`) is skipped by serialization; a rebuilt `once` event
  fires once more after a load/recall.
- `scheduleRamp(audioContext, param, from, to, durationSeconds, { startTime,
  curve })` — called by `commands.js`'s `applyParams()`, **not** registered
  with the clock at all. This is the vehicle for console ramps (`/track_1
  gain=0 3`, `/reverb wet=0.9 6b at=beat`): a one-off side effect anchored to
  an absolute `AudioContext` time (`audioContext.currentTime` by default, or
  `clock.nextBeatTime()`/`nextCycleTime()` when `at=beat`/`at=cycle` is given)
  rather than a loop-relative pattern position. The two paths are kept
  separate deliberately — "ramp starting right now" has no natural
  loop-relative beat to attach to, and forcing it through the clock's
  per-tick loop-position matching would add complexity (computing a live
  "current beat", handling the engine-not-started case) for no benefit.

A plain (non-ramped) instant set given `at=beat`/`at=cycle` uses
`automation.js`'s `setInstant()` instead — `cancelScheduledValues` +
`setValueAtTime` at the resolved future time, rather than a direct `.value =`
assignment — so "jump to this value on the next beat" is possible without
needing a ramp duration at all. `commands.js`'s `applyParams` and
`session.js`'s `applySnapshot` (below) both call into it, rather than each
keeping its own copy.

### A third path: structural reconciliation for `/recall`

`session.js`'s `applySnapshot(nllc, snapshot, { startTime, durationSeconds })`
— the engine behind `/recall` — adds a third scheduling path alongside the
two above, for a case neither covers: changing *which objects exist*, not
just a param's value. Ramping/instant-setting a param rides native
`AudioParam` scheduling either way (via `scheduleRamp`/`setInstant`), so a
matched track/processor/modulator/patch's params are scheduled exactly like
a console ramp would be. But creating or removing a track, reordering a
channel's processor chain, or tearing down a patch once its depth has faded
to 0 are JS-side object-graph changes with no `AudioParam` equivalent to
ride — the same problem `RibbitClock.rampBpm` already has for tempo (see
above), solved the same way: deferred via a plain `setTimeout` computed from
`startTime` rather than scheduled sample-accurately. Since scheduling a
future `AudioParam` value doesn't require the target node to already be
connected into the graph — only to exist and be connected by the time the
scheduled moment actually arrives — a newly-created object's param ramps can
still be scheduled immediately (in the same tick that creates it inside that
`setTimeout` callback), so a fade-in still starts precisely on time even
though the object's own creation is only approximately on time.

This is also why `/recall` is careful about *what* fades: an object present
in both the live session and the target snapshot never gets recreated (it
keeps its identity and just has its params ramped), an object only in the
snapshot is created immediately and has its gain/depth ramped up from 0, and
an object only live has its gain/depth ramped down to 0 first and is only
actually torn down once that fade completes — never a hard cut mid-ramp.
`session.js`'s `loadSession` (whole-session file load, `/load_session`)
deliberately does none of this — it's a hard rebuild, since loading an
entirely different session from disk is a cold-start operation with no
"previous state" worth crossfading from.

## Command router as a third view

`createCommandRouter(nllc)` closes over the live `Ribbit` instance and returns
`{ executeCommand, suggest }` — see
[Console suggestions](#console-suggestions-ghost-text-completion) above for
`suggest`; neither function maintains any state of its own beyond that
closure. Dispatch is by name lookup against `nllc.tracks`/`nllc.buses`/
`nllc.processors`/`nllc.modulators`/`master` at call time, so newly created
tracks/buses/processors/modulators are addressable immediately with no
registration step beyond what `Ribbit.createTrack`/`createBus`/`createProcessor`/
`createModulator` already do. A bus dispatches through the exact same
`channelCommand` a track does — see [adding-commands.md](adding-commands.md)
for extending it.

Every addressable object answers three ways: no params (`channelSummary`/
`paramObjectSummary` — a condensed one-liner), `help` (`channelHelp`/
`paramObjectHelp` — every param with its live value and range, plus every
command that kind of object accepts, spelled out), or an actual param/command
to run. The full-help builders list available `synth=`/`add_processor=`/
`add_modulator` type names via `nllc.synthTypes`/`processorTypes`/
`modulatorTypes` (thin getters over `ribbit.js`'s private `SYNTH_TYPES`/
`PROCESSOR_TYPES`/`MODULATOR_TYPES` registries) rather than hardcoding the
list, so a new registered type shows up in help automatically. A param's
range is only printed when `RibbitParam.min`/`max` are actually finite
(`formatParamLine`) — a param without declared bounds (e.g. `RibbitPatch`'s
`depth`, deliberately unbounded so a negative depth can invert a
modulation) would otherwise print `-Infinity..Infinity`, which is noise,
not information.

Dispatch order also means the `/name` namespace is genuinely flat:
`ribbit.js`'s `_uniqueName` de-duplicates a new object's name against every
existing object of *every* kind plus `RESERVED_NAMES` (every top-level
command name and `master`, exported from `ribbit.js`), so nothing can be
created already shadowed by an earlier lookup. `createCommandRouter`
sanity-checks its own command keys against `RESERVED_NAMES` when built
(once per page) and `console.warn`s about any command missing from it — the
one thing to remember when adding a new top-level command (see
[adding-commands.md](adding-commands.md)).

## Why this shape

The base classes (`RibbitSynth`, `RibbitProcessor`, `RibbitModulator`, `RibbitChannel`) are
intentionally thin — closer to interfaces than frameworks — so a new synth,
processor, or modulator subclass only needs to wire its own Web Audio nodes
between `this.input`/`this.output` (or just define `this.output` for a synth
or modulator) and implement the one or two methods the clock/router actually
call. Non-base implementations live one folder down from `src/`, grouped
by kind (`synths/`, `processors/`, `modulators/`), while the base classes stay
directly in `src/` — see [source-overview.md](source-overview.md) for a
file-by-file tour and [creating-a-synth.md](creating-a-synth.md) /
[creating-a-processor.md](creating-a-processor.md) /
[creating-a-modulator.md](creating-a-modulator.md) for tutorials. A bus is the
one exception to "new concept means a new class": it's deliberately just a
bare `RibbitChannel`, not a subclass, since everything a bus needs to be
(fader/pan/inserts/sends, addressable by name) is already exactly what
`RibbitChannel` provides — `RibbitTrack`'s only addition over it is the `.source`
a bus doesn't have.
