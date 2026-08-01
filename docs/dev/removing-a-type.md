# Removing a synth, processor, or modulator

The inverse of [creating-a-synth.md](creating-a-synth.md) /
[creating-a-processor.md](creating-a-processor.md) /
[creating-a-modulator.md](creating-a-modulator.md) — but **not symmetric with
them**. Adding a type touches two places: a new file, and one registry line.
Removing it has to also undo everything that *accumulated around* the type
while it existed: prose in docs, example references in code comments, demo
sessions and routes in the host app, and any shared machinery that was
introduced for it but has since become general.

All three kinds remove the same way; only the registry name and folder
differ. Work through the sections in order — §1 is what breaks the build,
§2–§5 is what silently rots if skipped.

## 1. Engine: the registration sites (required)

These are the only places the engine itself knows a type exists.

| Site | File | What to remove |
| --- | --- | --- |
| Implementation | `src/synths/<type>.js`, `src/processors/…`, `src/modulators/…` | The file |
| Registry entry | `src/ribbit.js` | The `<type>: RibbitFoo,` line in `SYNTH_TYPES` / `PROCESSOR_TYPES` / `MODULATOR_TYPES` |
| Registry import | `src/ribbit.js` | The matching `import { RibbitFoo } from …` at the top |
| Public export | `src/index.js` | The `export { RibbitFoo } from …` line under "Built-in types" |

Nothing else in the engine dispatches on type names. `createSynth` /
`createProcessor` / `createModulator` look the key up dynamically and throw
`unknown <kind> type "<name>"` when it's gone, the command router surfaces
that as a clean console error, and ghost-text completion enumerates the same
registries — so `synth=`, `add_processor=`, and `type=` all stop offering and
stop accepting the name with no further changes.

There is **no** separate list of type names in `commands.js`, no
`RESERVED_NAMES` entry (that list is top-level *command* names, not types),
and no UI-side registry in `nllc` — a mixer strip renders from the live
object, not from its type.

### Check whether another type imports it

Deleting the file is only safe if nothing else in `src/` imports it. Most
types are independent, but two dependencies exist today, both among the
processors:

- **`RibbitGoodenizer` is a composite** — it imports and constructs
  `RibbitCompressor`, `RibbitSaturator`, `RibbitTilt` and `RibbitLimiter`
  directly. Removing any one of those four breaks it, and the breakage is a
  module-resolution error at import time rather than a clean
  `unknown processor type` at the console. Either remove the goodenizer too, or
  rework it first.
- **`formatReduction`** is defined in `processors/compressor.js` and imported by
  `processors/limiter.js` and `processors/goodenizer.js`. If `compressor` goes,
  that helper needs a new home before its file is deleted.

`grep -rn "processors/<type>" src/` (or `synths/`, `modulators/`) before
deleting anything. This is the general shape of the problem §2 is about — a
type accumulates references over its life — but these ones break the *build*,
so they belong in §1.

## 2. Engine: trailing references

None of these break anything. All of them leave the docs lying about what
exists, which is worse in a codebase read primarily by LLMs.

```sh
grep -rn -i "<type>\|Ribbit<Type>" --include="*.js" --include="*.md" \
  --include="*.svelte" --include="*.json" . | grep -v node_modules
```

Expect hits in:

- **`README.md`** — the "Built-in types" bullet lists every exported class.
- **`docs/user/objects.md`** — the reference section for the type, if it ever
  got one (a `### <type>` heading under Synths / Processors / Modulators).
- **`docs/user/commands.md`, `docs/user/tutorial.md`** — if the type was used
  in any worked example.
- **`docs/llm/overview.md`** — the type-registry code block near the top, and
  possibly the "Known current limitations" section (which is phrased in terms
  of *which* types exist, e.g. "neither synth type exposes rampable params").
- **`docs/llm/building-*.md`** and **`docs/dev/creating-*.md`** — these cite
  real in-tree types as examples. If the removed type was the only example of
  a given technique, say so explicitly rather than deleting the sentence: a
  reader needs to know the hook exists even when nothing currently uses it.
- **Code comments in `src/ribbit.js`** — the same problem. Comments explaining
  *why* a generic hook exists tend to name the one type that motivated it.

## 3. Decide what the type leaves behind

The interesting part, and the reason removal deserves a doc at all. A
non-trivial type usually forced some *general* capability into the engine
while it was being built. That capability is now unused but not necessarily
unwanted. For each one, decide deliberately:

- **Keep it** if it's a documented extension point that the next author of a
  similar type would need. Then update its comment/doc so it no longer claims
  an in-tree example that's gone — state plainly that nothing implements it
  today.
- **Remove it** if it only ever made sense for that one type and no
  documentation promises it.

Precedents in this codebase, both from removing `noon`:

- `dispose()` on synths (`Ribbit.removeTrack` / `setTrackSynth` call it
  duck-typed) exists so a synth with persistent always-running nodes can tear
  them down. **Kept** — it's documented in `docs/llm/building-synths.md`, and
  `RibbitRandomNotes` still implements the modulator-side equivalent.
- The `_resolveDest` fallback to `channel.source.params`, which makes a
  *synth's* own param reachable as a patch destination (`dest=track_1.cutoff`).
  **Kept** — and no longer hypothetical: `percsampler`
  (`dynamics`/`pan_spread`/`speed_spread`), `karplus`
  (`damping`/`decay`/`brightness`) and `granular` (nine of them) all declare
  params, so this path is exercised in tree rather than merely defended.
  (It resolves and connects; whether the patch *moves* anything is a separate,
  currently-negative question — see `param.js` in
  [source-overview.md](source-overview.md#paramjs).)

A sibling type built alongside the one you're removing (the `cv` modulator,
in noon's case) is a separate decision — judge it on its own merits, not by
association.

## 4. Data fallout: session JSON

This is the failure mode most easily missed, because it surfaces at runtime
in files that live outside the source tree.

Every saved session records each object's registry key as `.type`. A session
JSON naming a type that no longer exists **fails to load** — `loadSession`
and `applySnapshot` both run `assertKnownTypes` before mutating anything, so
the failure is clean (every unknown type listed in one error, the live
session left exactly as it was) rather than a graph half-rebuilt from a file
that ran out partway. The same applies to `/recall` on a state captured
before the removal.

Clean failure is not recovery, though: the engine won't skip the dead object
and load the rest, so such a file stays unloadable until someone edits the
JSON by hand.

So:

- Delete or edit any in-repo session file that uses the type
  (`nllc/static/sessions/*.json`).
- Remember that files *outside* the repo — anything a user saved with
  `/save_session` — can't be fixed, and will fail to load. That's the real
  cost of removing a shipped type, and it's worth weighing before deciding to
  remove rather than deprecate.

## 5. Interface (`nllc`) artifacts

The engine has no UI, so a type's demo material lives in the host app. Check
for, and remove:

- **A dedicated route** — `src/routes/code-editor/<type>/+page.svelte`.
- **Its demo session** — `static/sessions/<type>-demo.json` (see §4).
- **The homepage link** — the `<a class="session-link">` block in
  `src/routes/+page.svelte` pointing at that route.
- **Doc references** — `nllc/README.md` and `nllc/docs/{user,dev,llm}/`
  each enumerate the available routes and the contents of `static/sessions/`.
- **Any samples or assets** the type fetched from `static/`, if nothing else
  uses them. Two `static/` trees have a manifest route each, but **three types
  read them**: `static/samples/` (`src/routes/samples/manifest.json/+server.js`)
  serves both `percsampler` and `granular`, and `static/patterns/`
  (`src/routes/patterns/manifest.json/+server.js`) serves `patternvariator`.
  So removing `percsampler` alone must *not* take the samples route with it —
  check the other reader first. On the engine side both sample readers go
  through `src/samples.js`, which is dead only when neither remains. Note that
  a *pattern pack* or a folder of samples is content rather than code, and
  survives independently of any one type.

Note `.svelte-kit/` will still contain generated references to a deleted
route; that's a build artifact and regenerates on the next `npm run dev`.

## 6. Verify

```sh
cd nllc && npx svelte-check          # catches a dangling import
```

Then drive the app (`.claude/skills/run/`) and confirm:

- `/add_track synth=<type>` reports `unknown synth type "<type>"` rather than
  throwing something uncaught.
- Ghost-text no longer offers the name after `synth=` / `type=` /
  `add_processor=`.
- A session file still naming the type names it in the load error and leaves
  the session *empty* — not partly built (see §4). Worth checking by
  temporarily editing a `.type` in a copy of a session JSON rather than
  assuming it.
- The homepage renders without the removed link, and any remaining demo route
  still loads its session.

## Worked example: removing `noon`

For reference, the full change was: delete `src/synths/noon.js`; drop its
import + `SYNTH_TYPES` entry in `ribbit.js` and its export in `index.js`;
reword two `ribbit.js` comments and one `docs/llm/building-synths.md`
paragraph that used it as the example for `dispose()` and for synth-param
patching (both hooks kept, per §3); drop it from `README.md`'s built-in-types
list; delete `nllc/src/routes/code-editor/noon/` and
`nllc/static/sessions/noon-demo.json`; remove the homepage link; and update
four `nllc` docs that listed the route. It had no `docs/user/objects.md`
entry to remove — it was never documented there, which is its own lesson
about types that ship ahead of their docs.
