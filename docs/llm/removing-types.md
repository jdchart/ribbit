# LLM context: removing a synth, processor, or modulator

Full checklist with rationale: `docs/dev/removing-a-type.md`. This is the
condensed recipe. All three kinds remove identically; only the registry
constant and the `src/` subfolder differ.

Removal is **not** the mirror of addition. Adding touches 2 sites; removing
touches those plus everything that accumulated around the type since.

## 1. Registration sites — these are all the engine knows about (required)

1. Delete `src/{synths,processors,modulators}/<type>.js`.
2. `src/ribbit.js` — delete the `<type>: RibbitFoo,` line from `SYNTH_TYPES` /
   `PROCESSOR_TYPES` / `MODULATOR_TYPES`, **and** its `import` at the top.
3. `src/index.js` — delete the `export { RibbitFoo } …` line.

Nothing else dispatches on type names: `createSynth`/`createProcessor`/
`createModulator` look the key up dynamically and throw
`unknown <kind> type "<name>"`, and ghost-text enumerates the same registries,
so the console stops offering and stops accepting the name automatically.
There is no type list in `commands.js`, no `RESERVED_NAMES` entry (that's
top-level *command* names), and no UI-side registry in `nllc`.

## 2. Trailing references — grep, don't guess

```sh
grep -rn -i "<type>\|Ribbit<Type>" --include="*.js" --include="*.md" \
  --include="*.svelte" --include="*.json" . | grep -v node_modules
```

Usual hits: `README.md` built-in-types list; `docs/user/objects.md` reference
section; `docs/llm/overview.md` (the registry code block *and* the "Known
current limitations" section, which is phrased in terms of which types exist);
`docs/llm/building-*.md` + `docs/dev/creating-*.md` (they cite in-tree types as
examples); code comments in `src/ribbit.js`.

When the removed type was the *only* example of a technique, say the hook
exists with nothing implementing it — don't delete the sentence, or the
capability becomes invisible.

## 3. Shared machinery the type introduced — decide, don't reflex-delete

A non-trivial type usually forced a general capability into the engine. Keep
it if it's a documented extension point (then fix its comment to stop citing
the gone example); remove it only if it was type-specific and undocumented.
Both hooks `noon` motivated were **kept**: synth `dispose()` (duck-typed from
`removeTrack`/`setTrackSynth`) and `_resolveDest`'s fallback to
`channel.source.params` (makes a synth param reachable as `dest=track_1.foo`).

## 4. Session JSON — the runtime failure mode

Every saved object records its registry key as `.type`. A session file naming
a removed type makes `loadSession` **throw partway through the rebuild**
(the `create*` calls in `session.js` aren't individually guarded), leaving a
half-built graph; same for `/recall` of a pre-removal state. Fix in-repo files
(`nllc/static/sessions/*.json`); user files saved via `/save_session` are
unfixable and will fail to load — weigh that before removing a shipped type.

## 5. Interface (`nllc`) artifacts

Demo material lives in the host app, not the engine: the
`src/routes/code-editor/<type>/` route, `static/sessions/<type>-demo.json`, the
`<a class="session-link">` block in `src/routes/+page.svelte`, route/asset
listings in `nllc/README.md` and `nllc/docs/{user,dev,llm}/`, and any
`static/` assets only that type fetched. Stale `.svelte-kit/` references are
build output and regenerate.

## 6. Verify

`cd nllc && npx svelte-check` (catches a dangling import), then drive the app
via `.claude/skills/run/`: `/add_track synth=<type>` should report
`unknown synth type "<type>"` cleanly, ghost-text should no longer offer the
name, and the homepage plus any remaining demo route should still load.
