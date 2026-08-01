# ribbit

A browser audio engine for live-coding music, built on the Web Audio API. It
owns a graph of **tracks** (each wrapping a **synth**), **buses** (shared send
destinations for sub-mixes or shared effects), **processors** (insert effects —
reverb and delay, plus compression, saturation, tilt EQ and limiting for making
a mix louder and more even), **modulators** (control sources like LFOs,
**patched** into any parameter), and a **master** bus — all playing against a
shared, looping, lookahead-scheduled **clock**. A small, headless, text-driven
take on Max/MSP or SuperCollider.

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

The built-in `sampler`, `percsampler` and `granular` synths fetch sample files
from the host's `/samples/` path — the host app is responsible for serving them
there (e.g. SvelteKit's `static/samples/`).

`percsampler` builds its kit by picking at random from the host's library, and
`granular` picks one source recording the same way. A browser can't list a
directory over HTTP, so both expect a manifest at `/samples/manifest.json`
(overridable per instance via the `manifest_url` option):

```json
{
  "kicks":  ["kicks/kick01.wav", "kicks/kick02.wav"],
  "snares": ["snares/snare01.wav"],
  "hats":   ["hats/hat01.wav"],
  "percs":  ["percs/perc01.wav"],
  "foley":  ["foley/rain.wav", "foley/river.wav"]
}
```

Each entry is a path relative to that same `/samples/` prefix. The four drum
categories are expected by `percsampler`, whose slot layout is built from them;
any **other** key is an ordinary folder that `granular` can read by name
(`folder=foley`, its default). Serving it is the host's job — `nllc` generates
it on request from `static/samples/`. A host that serves no manifest gets an
empty kit and a console warning, not an error.

### Patterns

The `patternvariator` modulator plays **hand-written** musical material — a
drum rhythm, a chord progression, a melody — from JSON files the host serves
under `/patterns/`, and generates seeded variations on it. This is the one part
of the engine whose input is a file a person edits rather than a command:

```json
{ "kind": "drums", "step_beats": 0.25,
  "lanes": { "kicks":  "x... ..x. ..x. ....",
             "snares": ".... x... .... x...",
             "hats":   "x.x." } }
```

Same host contract as samples, for the same reason — a browser can't list a
directory, so the host publishes a manifest at `/patterns/manifest.json`:

```json
{ "hiphopdrums": ["hiphopdrums/boom-bap.json"], "darkchords": [...] }
```

The one difference is that pack names aren't fixed: a pack is just a folder, so
adding `static/patterns/<pack>/<name>.json` and refreshing is the whole
workflow. Full format reference: [docs/user/patterns.md](docs/user/patterns.md).

## Documentation

The same three-audience structure the rest of the workspace uses:

- **[docs/user](docs/user/)** — the command and object reference: what you can
  create and control, and the full slash-command vocabulary. Also
  [writing patterns](docs/user/patterns.md) — the hand-editable JSON format for
  drum rhythms, chords and melodies.
- **[docs/dev](docs/dev/)** — architecture, a source walkthrough, and tutorials
  for extending the engine (new synths, processors, modulators, commands, or
  [the pattern format](docs/dev/creating-a-pattern.md)) or
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
  `RibbitParam`, `RibbitParamSources`, `RibbitEvent`, `RibbitSynth`,
  `RibbitProcessor`, `RibbitModulator`, `RibbitPatch`, `RibbitEventPatch`,
  plus the `automation`/`taper` helpers
- **Patterns & randomness** — `parsePattern`, `cellAt`, `fetchPattern`,
  `fetchPatternManifest`, `mulberry32`, `randomSeed`
- **Built-in types** — `RibbitOscSynth`, `RibbitSampler`, `RibbitPercSampler`
  (plus `PERC_CATEGORIES`), `RibbitKarplus`, `RibbitReverb`, `RibbitDelay`,
  `RibbitCompressor`, `RibbitSaturator` (plus `SATURATOR_CHARACTERS`),
  `RibbitTilt`, `RibbitLimiter`, `RibbitGoodenizer`,
  `RibbitLFO`, `RibbitRandomNotes`, `RibbitCV`, `RibbitMarkovPercs`,
  `RibbitEuclidPercs`, `RibbitPatternVariator`.
  See [docs/llm/catalog.md](docs/llm/catalog.md) for each one's params and
  options on a single page.
