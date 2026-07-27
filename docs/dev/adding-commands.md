# Adding commands

All command handling lives in `src/commands.js`. There are two
places to add behavior, depending on scope.

## 1. A new top-level command

Top-level commands (`/start`, `/stop`, `/add_track`, `/tracks`) live in the
`commands` object inside `createCommandRouter`:

```js
export function createCommandRouter(nllc) {
    const commands = {
        start: () => { nllc.start(); return "engine started"; },
        stop: () => { nllc.stop(); return "engine stopped"; },
        add_track: (params) => {
            const track = nllc.createTrack(params);
            return `created ${track.name}`;
        },
        tracks: () => { /* ... */ },
        clock: (params) => { /* see the real one — bpm=/num_beats=, reports current values with no params */ },

        // add a new one, following the same "no params = report status" shape:
        seed: (params) => {
            if (!("value" in params)) return `seed is ${nllc.randomSeed}`;
            nllc.randomSeed = Number(params.value);
            return `seed set to ${nllc.randomSeed}`;
        },
    };
    // ...
};
```

(The real `/clock` command is a good template to read directly in
`commands.js` — it shows the "no params = report current state, else apply
each given param and collect a result message per param" shape used
throughout.)

Each handler receives the parsed `params` object (from `parseCommand`) and returns
a string that gets echoed into the console log (or throws/returns nothing — see
`run()`, which catches exceptions and turns them into an error string
automatically, so handlers don't need their own `try`/`catch`).

**Also add the new command's name to `RESERVED_NAMES` in `ribbit.js`** — that
set is what stops a track/bus/processor/modulator being created with a name
the router would dispatch as your command first (the object would be
permanently shadowed). `createCommandRouter` sanity-checks its command keys
against the set when the router is built and `console.warn`s about any it
finds missing, so a forgotten entry is loud in the browser console rather
than a silent namespace hole.

A handler can also return a `Promise<string>` instead of a plain string, for
a command that genuinely can't resolve synchronously — `load_session` is the
one example today (it opens a file picker and awaits the chosen file's
contents before it has anything to report). `run()` awaits it and converts a
rejection into the same clean error string a sync throw gets, so you still
don't need your own `try`/`catch`; `CodeEditor.svelte` already awaits
whatever `executeCommand` returns, so nothing on the UI side needs to change
either. `executeCommand` itself only pays for a `Promise.all` when a
submitted line's segments actually contain one (see `commands.js`'s doc
comment on `executeCommand`) — a plain synchronous command line is unaffected.
Reach for this only when the work genuinely can't be synchronous (a file
read, a fetch); don't make a handler async just because it *could* be.

## 2. A new rampable param on channels, processors, or modulators

If the new behavior is a numeric param that should be gettable/settable/
rampable/deferrable (`at=`) — like `gain=`/`pan=`, any processor param, or any
modulator param — don't hand-roll get/set/ramp logic at all. Wrap it as an
`RibbitParam` (`param.js`) in the owning object's `this.params` map, and it's
done: `commands.js`'s `applyParams()` is the one function that already knows
how to instant-set, ramp, and defer *any* `RibbitParam`, and it's what
`channelCommand` (for gain/pan), `paramObjectCommand` (for every
processor/modulator param), and `/patch` (for depth) all call into. See
[creating-a-processor.md](creating-a-processor.md) and
[creating-a-modulator.md](creating-a-modulator.md) for how to define one on a
new processor/modulator class, and `channel.js`'s constructor for the
channel-level `gain`/`pan` example (gain adds a `decode`/`encode` taper;
pan doesn't need one).

If the new behavior is genuinely *not* a good fit for ramping (like
`/clock num_beats=` — a fractional, constantly-shifting loop length has no
sensible meaning), that's a legitimate call: reject a ramp spec explicitly
with a clear message rather than silently applying only the `.value` part of
it (see the `clock` top-level command's `num_beats` branch for the pattern).
Not every param has to be rampable just because the machinery makes it easy.

## 3. A new non-rampable field on channel commands

For channel-specific behavior that isn't a rampable param at all (like
`add_event`, `start`/`stop`, `synth=`), add it directly inside
`channelCommand`, following the existing pattern: check `"key" in params` for
a value-bearing param, `params.key` (truthy) for a boolean flag, push a
human-readable string onto `results`, and let the function join them at the
end. Keep each param's logic self-contained (a bad `synth=` shouldn't stop
`gain=` in the same command from applying — see how the existing handler
tries/catches `synth=` locally rather than letting a bad type abort the whole
command). Every user-supplied number should go through `toNumber(raw, label)`
rather than a bare `Number(...)` — it throws (caught automatically by `run()`)
on a non-finite result instead of silently writing `NaN` into engine state,
which is exactly the kind of bug that can otherwise persist long after the
one bad command that caused it (see `toNumber`'s doc comment in
`commands.js`).

## Keeping `help` in sync

`/name help` (any channel, processor, or modulator) is a hand-written
reference string — `channelHelp`/`paramObjectHelp` in `commands.js`, not
generated from the `channelCommand`/`paramObjectCommand` branches themselves.
Adding a new channel-level command (step 3 above) or a new rampable param
(step 2) means adding its own line to the relevant help builder too — nothing
enforces the two staying in sync automatically. New param values/ranges *do*
show up for free (`formatParamLine` reads straight off the object's own
`params` map), and a new synth/processor/modulator type shows up for free in
any `synth=`/`add_processor=`/`add_modulator` help line too (they read
`nllc.synthTypes`/`processorTypes`/`modulatorTypes`) — it's specifically new
*commands* (not new params or types) that need a manual help-text line.

## Keeping suggestions in sync

The console's ghost-text completion (`suggest(input, cursorPos)`, the second
value `createCommandRouter` returns — see
[architecture.md](architecture.md#console-suggestions-ghost-text-completion))
has the same "not derived from the command branches" gap `help` does, and the
same fix for the same two cases:

- A new **top-level command** needs nothing extra for *suggestions* —
  `suggest` reads `Object.keys(commands)` once (`topLevelNames`), so it's
  suggestible the moment it's added to the `commands` object in step 1
  above. (It still needs its `RESERVED_NAMES` entry in `ribbit.js`, and a
  `TOP_LEVEL_KEYWORDS` entry if it has params of its own worth completing.)
- A new **rampable param** (step 2) needs nothing extra either —
  `resolveKeywordsFor` reads the target object's own `params` map directly.
  A new **option** likewise (the `options` map is read the same way), and
  giving it a `choices` array makes its *values* complete for free too
  (`resolveValueCandidates` falls through to any resolved object's — or a
  track's synth's — matching option's `choices`).
- A new **non-rampable field on channel commands** (step 3, like `add_event`/
  `synth=`) needs a manual addition to `commands.js`'s
  `CHANNEL_ACTION_KEYWORDS` (or `PARAM_OBJECT_ACTION_KEYWORDS` for a
  processor/modulator-level equivalent) — the same list `channelHelp`/
  `paramObjectHelp` don't actually share with (each has its own
  hand-maintained keyword source; see `commands.js`'s comment above
  `CHANNEL_ACTION_KEYWORDS` for why keeping those as prose-vs-bare-keyword
  lists wasn't worth forcibly unifying). It also needs adding to
  `CHANNEL_COMMAND_KEYS`/`PARAM_OBJECT_COMMAND_KEYS` (the consumed-key sets
  the end-of-command unknown-key check reads) — miss that and every use of
  your new key gets an `unknown param` complaint appended.
- A key whose **value** has a small enumerable domain (an id, a registered
  type, a curve name) can get value completion via a branch in
  `resolveValueCandidates`.

## Command-name dispatch

`executeCommand(text)` (part of the object `createCommandRouter` returns —
see [Keeping suggestions in sync](#keeping-suggestions-in-sync) above for the
other one, `suggest`) resolves a
command name in this order: `commands` (top-level) → `master` → `nllc.tracks`
(by `.name`) → `nllc.buses` (by `.name`) → `nllc.processors` (by `.name`) →
`nllc.modulators` (by `.name`) → `unknown command`. A bus is dispatched
through the exact same `channelCommand` a track is — it's not a new *kind* of
addressable object from the router's point of view, just another
`RibbitChannel` (with no `.source`). If you're adding a genuinely new kind of
addressable object (not a track/bus, processor, or modulator), you'd extend
this dispatch chain in `executeCommand` itself, following the same `track ?
run(...) : ...` shape already there.

A patch (`/patch`, `/unpatch`) is a different shape entirely — it isn't
addressed by its own name in the dispatch chain above (a patch's compact id,
e.g. `x1`, isn't a name you type as `/x1 ...`); instead the top-level `/patch`
command itself branches on whether `id=` was given (adjust an existing
patch's depth) or `source=`/`dest=` were given (create a new one). Worth
reading directly in `commands.js` if you're adding another object kind that
doesn't fit the usual "addressed by its own name" shape.

## Multiple commands per submitted line

`executeCommand(text)` (one of the two values `createCommandRouter` returns) first calls
`splitCommands(text)`, which finds every `/name` occurrence in the submitted
line and dispatches each segment independently through the normal path,
joining their results with newlines. This is what lets
`/track_1 gain=0 8 /reverb wet=0.9 6b` run both together, scheduled off the
same instant (they execute synchronously in one call stack). You don't need to
do anything for a new command to participate in this — it's purely a
preprocessing step before dispatch. It does assume no param value contains a
literal `/`; none currently do.

## Ramp specs and the `at=` scheduling hint

`parseCommand` turns `key=<value> <duration>[b]` into `params[key] = { value,
duration, unit }` instead of a plain scalar (`unit` is `"seconds"` or
`"beats"`) — this is what `isRamp()` checks for. If your param is an
`RibbitParam` (see above), you get all of this for free through `applyParams()`
— you don't need to touch `isRamp`/`rampSeconds`/`resolveStartTime` yourself
at all.

Those helpers are still there directly for the rare case where a "value that
ramps over time" genuinely isn't backed by an `RibbitParam` — the one example
in the codebase is `/clock bpm=`, which calls `RibbitClock.rampBpm()` instead of
`applyParams`, because bpm isn't a native `AudioParam` at all (it's a plain
number the clock uses for its own beat↔time math) and so can't ride
`scheduleRamp()`'s `linearRampToValueAtTime` the way every other rampable
param can — see `clock.js`'s `rampBpm` and its doc comment for why that needs
its own stepped-timer approach. If you find yourself in a similar spot, read
the `clock` top-level command's `bpm` branch in `commands.js` directly rather
than reinventing the ramp-spec parsing: `isRamp(params[key])` to check which
shape you got, `rampSeconds(nllc.clock, params[key])` to resolve the duration
against tempo, and `resolveStartTime(nllc.clock, params.at)` to turn an
optional `at=beat`/`at=cycle` into an absolute `AudioContext` startTime.
Remember to skip the `at` key in any generic `Object.entries(params)` loop —
it isn't itself a settable param (`applyParams` already does this for you).

## Parsing details you probably don't need to touch

`parseCommand(text)` (tokenizing `/name key=val key2="quoted val"`, including
the ramp-duration extension above) and `parseValue(raw)` (number/boolean/
quoted-string coercion) are generic and already used by every command — new
commands get quoting, optional `=` spacing, type coercion, and ramp parsing
for free. Only touch these if you need a fundamentally new syntax shape (e.g.
positional args) rather than another `key=value` pair.
