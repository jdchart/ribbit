# LLM context: adding a command

Full tutorial with rationale: `docs/dev/adding-commands.md`. This is the condensed
recipe.

All command logic is in `src/commands.js`. Extension
points:

1. **New top-level command** (like `/start`, `/add_track`, `/add_modulator`):
   add a key to the `commands` object inside `createCommandRouter(nllc)`.
   Handler signature: `(params) => string`. `params` is already parsed
   (numbers/booleans/quoted strings coerced, see `parseCommand`/`parseValue`).
   Return a string to echo to the console; thrown errors are caught
   automatically by the router's `run()` wrapper and turned into an error
   string — no need for your own try/catch. Always run a user-supplied
   number through `toNumber(raw, label)` rather than a bare `Number(...)` —
   it throws on a non-finite result instead of silently writing `NaN` into
   persistent state. Also add the command's name to `RESERVED_NAMES` in
   `ribbit.js` (keeps objects from being created with a name your command
   shadows — the router warns at build time if you forget).

2. **New rampable param on every channel, processor, or modulator** (like
   `gain=`, or any processor/modulator's own params): wrap it as an
   `RibbitParam` (`param.js`) in the owning object's `this.params` map — see
   `docs/llm/building-processors.md`/`building-modulators.md`. `applyParams()`
   in `commands.js` is the one function that already does get/set/ramp/defer
   for any `RibbitParam`; `channelCommand` (gain/pan), `paramObjectCommand`
   (every processor/modulator param), and `/patch` (depth) all call into it —
   don't hand-roll ramp/instant/`at=` branching again.

3. **New non-rampable field on channel commands** (like `add_event`,
   `synth=`): add a branch inside `channelCommand`, following the existing
   `if ("key" in params) { ... results.push(...) }` pattern for value-bearing
   params, or `if (params.key) { ... }` for boolean flags. Keep each param
   independent so one bad param in a multi-param command doesn't block the
   others.

```js
// top-level example (this exact shape is how the real /clock command works)
const commands = {
    // ...existing...
    seed: (params) => {
        if (!("value" in params)) return `seed is ${nllc.randomSeed}`;
        nllc.randomSeed = toNumber(params.value, "seed");
        return `seed set to ${nllc.randomSeed}`;
    },
};
```

A handler may return `Promise<string>` instead of a plain string when the
work genuinely can't resolve synchronously (`load_session` is the one
example — it awaits a picked file's contents). `run()` awaits it and
converts a rejection to the same clean error string a sync throw gets, and
`executeCommand` transparently returns a `Promise` itself only when a
submitted line's segments actually contain one — `CodeEditor.svelte` already
awaits `executeCommand`'s result either way, so nothing else needs to
change. Don't reach for this unless the work is genuinely async (a file
read, a `fetch`).

Dispatch order in `executeCommand`: top-level `commands` → `master` → track by
name → bus by name → processor by name → modulator by name → `unknown
command`. A bus (`/add_bus`) is addressed and handled exactly like a track —
both go through `channelCommand` — the only difference is a bus has no
`.source`, so synth-only params (`add_event`, `synth=`, `start`/`stop`) are
no-ops on it, same as on master.
`executeCommand` also splits one submitted line into multiple `/name ...`
segments before dispatch (`splitCommands`), so several commands typed on one
line run together — no extra code needed for a new command to participate.
A patch (`/patch`, `/unpatch`) doesn't fit this "addressed by its own name"
shape at all — it's a top-level command that branches on `id=` (adjust) vs.
`source=`/`dest=` (create); read it directly in `commands.js` if you're
adding another object kind shaped like this.

**Keeping `/name help` in sync**: `channelHelp`/`paramObjectHelp` in
`commands.js` are hand-written reference strings, not generated from the
command branches — a new channel command (case 3) or rampable param (case 2)
needs its own line added there too. New param values/ranges and new
`synth=`/`add_processor=`/`add_modulator` type names show up automatically
(`formatParamLine` reads the object's own `params`; the type lists read
`nllc.synthTypes`/`processorTypes`/`modulatorTypes`) — only new *commands*
need a manual help-text update.

**Keeping console suggestions (ghost-text completion) in sync**:
`createCommandRouter(nllc)` returns `{ executeCommand, suggest }`, not just
`executeCommand` — `suggest(input, cursorPos)` is `commands.js`'s
`suggestCompletion`, consumed by `CodeEditor.svelte` (see
`docs/dev/architecture.md`'s "Console suggestions" section). A new top-level
command (case 1) is suggestible for free (`suggest` reads
`Object.keys(commands)`); a new rampable param (case 2) is too
(`resolveKeywordsFor` reads the object's own `params`). A new non-rampable
channel field (case 3) needs a manual addition to `commands.js`'s
`CHANNEL_ACTION_KEYWORDS`/`PARAM_OBJECT_ACTION_KEYWORDS` — the same "new
commands need a manual list update, params/types don't" split `help` has,
just a second list. Note also that neither the `/name` token nor a value ever
completes past something the user has already typed in full, since the console
submits ghost text on Enter: `lines=1` must not run as `lines=1+1`, and
`/record` must not run as `/recording`. **A new command name that is a strict
prefix of an existing one is therefore fine** — but only because of that
guard; check it still holds if you touch `suggestCompletion`.

Any new channel command works through **groups** with no extra work:
`groupCommand` forwards every key it doesn't own to each member's handler, so
there is no per-command list to extend.

If a param genuinely shouldn't be rampable (like `/clock num_beats=` — a
fractional, shifting loop length makes no sense), reject a ramp spec
explicitly with a message rather than silently applying just the `.value`
half of it — see the `clock` command's `num_beats` branch.

If your ramp target genuinely isn't backed by a real `AudioParam` (the one
case in the codebase: `/clock bpm=`, since bpm is a plain number the clock
uses for beat↔time math, not a native `AudioParam`), you can't use
`RibbitParam`/`applyParams` — see `RibbitClock.rampBpm` for the stepped-timer
alternative, and reuse `isRamp(value)`/`rampSeconds(nllc.clock,
value)`/`resolveStartTime(nllc.clock, params.at)` directly the way the real
`clock` command does. Don't touch `parseCommand`/`parseValue` themselves
unless you need a genuinely new syntax shape (not another `key=value` pair,
and not another ramp-like suffix) — quoting, optional `=` spacing, type
coercion, and ramp duration parsing are already generic and shared by every
command.
