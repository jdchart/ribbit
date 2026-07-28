# ribbit

A browser audio engine for live-coding music, built on the Web Audio API. It
owns a graph of **tracks** (each wrapping a **synth**), **buses** (shared send
destinations for sub-mixes or shared effects), **processors** (insert effects),
**modulators** (control sources like LFOs, **patched** into any parameter), and
a **master** bus — all playing against a shared, looping, lookahead-scheduled
**clock**. A small, headless, text-driven take on Max/MSP or SuperCollider.

Ribbit is UI-agnostic: it's plain browser ESM with no framework dependency. You
drive it either by calling its methods directly, or through its built-in
slash-command router — a usable control surface with no interface required. The
whole session (every track, bus, processor, modulator, patch, and saved state)
serializes to and from a `.json` file.

Ribbit is the engine extracted from **NLLC** (Natural Language Live Coding); the
`nllc` app in this workspace is one interface built on top of it.

## Install

Within this workspace it's wired up as an npm workspace, so a sibling interface
just declares it as a dependency and imports `ribbit`:

```json
{ "dependencies": { "ribbit": "*" } }
```

For a project outside this workspace, install it locally:

```sh
npm install /path/to/ribbit        # or: npm link, or a "file:" dependency
```

## Quick usage

```js
import { Ribbit, createCommandRouter, loadSession } from "ribbit";

// One instance per page. Construct client-side only (needs AudioContext).
const engine = new Ribbit({ latencyHint: "interactive" });

// Option A — drive it with slash-commands (no UI needed):
const { executeCommand, suggest } = createCommandRouter(engine);
executeCommand("/start");
executeCommand("/add_track name=lead synth=oscsynth");
executeCommand("/add_modulator type=lfo name=wobble freq=2");
executeCommand("/patch source=wobble dest=lead.cutoff depth=400");

// Option B — call the graph directly:
const track = engine.createTrack({ name: "bass", synth: "oscsynth" });

// Save / load the whole session as JSON:
import { sessionToJSON } from "ribbit";
const json = sessionToJSON(engine);
loadSession(engine, json);

// When the host is done with it (a component unmounting, a page navigating
// away), tear it down. `stop()` only pauses; nothing collects an AudioContext
// or the clock's timer loop just because you dropped your last reference, so
// without this the session keeps playing.
await engine.dispose();
```

`AudioContext` doesn't exist during server-side rendering, so construct `Ribbit`
in the browser only (e.g. inside `onMount` in a SvelteKit app).

### Samples

The built-in `sampler` synth fetches sample files from the host's `/samples/`
path — the host app is responsible for serving them there (e.g. SvelteKit's
`static/samples/`).

## Documentation

The same three-audience structure the rest of the workspace uses:

- **[docs/user](docs/user/)** — the command and object reference: what you can
  create and control, and the full slash-command vocabulary.
- **[docs/dev](docs/dev/)** — architecture, a source walkthrough, and tutorials
  for extending the engine (new synths, processors, modulators, commands) or
  [removing a type](docs/dev/removing-a-type.md) again.
- **[docs/llm](docs/llm/)** — concise, context-window-friendly summaries meant
  to be fed to an LLM instead of the full source.

## Public API

Import surface (see [`src/index.js`](src/index.js)):

- **Core** — `Ribbit`, `RESERVED_NAMES`
- **Control** — `createCommandRouter`, `parseCommand`
- **Session** — `loadSession`, `sessionToJSON`, `snapshotSession`, `applySnapshot`
- **Harmony** — `createHarmonyContext`, `parseDegreeList`, `resolveDegree`
- **Primitives & base classes** — `RibbitChannel`, `RibbitTrack`, `RibbitClock`,
  `RibbitParam`, `RibbitEvent`, `RibbitSynth`, `RibbitProcessor`,
  `RibbitModulator`, `RibbitPatch`, `RibbitEventPatch`, plus the `automation`/
  `taper` helpers
- **Built-in types** — `RibbitOscSynth`, `RibbitSampler`, `RibbitReverb`,
  `RibbitDelay`, `RibbitLFO`, `RibbitRandomNotes`, `RibbitCV`
