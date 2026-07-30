# Creating a modulator

> **Before you start:** [`../llm/catalog.md`](../llm/catalog.md) lists every
> synth, processor and modulator already in the engine with its params and
> options, plus a "which one to copy" table. It's the quickest way to find the
> closest existing modulator to model yours on. **Remember to add your new modulator
> to it** once it works — that catalog is what later readers consult instead of
> the source tree.

A modulator is anything that extends `RibbitModulator`, builds a
continuously-running Web Audio graph in its constructor (there's no
per-event `trigger()` — unlike a synth, a modulator is always "on"), connects
its final node into the inherited `this.output`, and populates `this.params`
with `RibbitParam`s so the console can inspect/control it — structurally, this
is almost exactly a processor (see [creating-a-processor.md](creating-a-processor.md)),
except a modulator never joins a channel's insert chain. It exists purely to
be *patched* into some other object's parameter (see
[user/commands.md](../user/commands.md#modulators-and-patches) for the `/patch`
command), so by convention its raw `output` should be a bipolar signal
(roughly `-1..1`) — the *patch* connecting it somewhere else decides the
depth, not the modulator itself.

## Minimal example

A smoothed random modulator ("sample and hold"-style wobble): continuous
white noise through a low-pass filter, with one runtime param (`rate`, the
filter's cutoff — higher values wobble faster/rougher):

```js
// src/modulators/noisemod.js — non-base modulators
// live in their own modulators/ subfolder, one level down from the base classes.
import { RibbitModulator } from "../modulator";
import { RibbitParam } from "../param";

// A short buffer of white noise, looped continuously — same technique
// reverb.js uses for its impulse response, just looped instead of one-shot.
function buildNoiseBuffer(audioContext) {
    const length = audioContext.sampleRate * 2;
    const buffer = audioContext.createBuffer(1, length, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
};

export class RibbitNoiseModulator extends RibbitModulator {
    constructor(audioContext, { name = "noisemod", rate = 4 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "Smoothed random noise: a continuous bipolar (-1..1) wobble, for patching into any parameter.";

        this.noise = audioContext.createBufferSource();
        this.noise.buffer = buildNoiseBuffer(audioContext);
        this.noise.loop = true;

        this.filter = audioContext.createBiquadFilter();
        this.filter.type = "lowpass";
        this.filter.frequency.value = rate;

        this.noise.connect(this.filter).connect(this.output);
        this.noise.start();

        this.params = {
            rate: new RibbitParam(this.filter.frequency),
        };
    };

    get rate() {
        return this.params.rate.audioParam;
    };
};
```

Points worth noting, all copied from `modulators/lfo.js` (and, since a modulator is a
processor's sibling, `processors/reverb.js`/`processors/delay.js`):

- **`this.output` is provided by the base class** (a plain `GainNode`) —
  connect your node graph's final stage into it; never create your own
  output node.
- **Build the graph once, in the constructor, and start it immediately** —
  `this.noise.start()` above, same as `RibbitLFO`'s `this.osc.start()`. A
  modulator has no `trigger()`; it's always producing signal from the moment
  it's created (which may be before the engine's `/start`, while the
  `AudioContext` is still suspended — that's fine, it just won't render
  anything audible/measurable until the context resumes).
- **Keep the raw output bipolar (`-1..1`-ish), not scaled to a specific
  range or offset.** Depth and centering belong to the *patch* that connects
  this modulator somewhere (`/patch source=noisemod1 dest=reverb.wet
  depth=0.2`), not to the modulator — that's what lets the same modulator
  drive several destinations at different amounts. If your modulator's
  natural output range genuinely isn't bipolar (unlikely, but possible for an
  exotic source), that's a case-by-case call; every existing modulator keeps
  to the convention.
- **`this.params` works exactly like a processor's** — `{ paramName: RibbitParam }`
  (see `param.js` and [creating-a-processor.md](creating-a-processor.md)).
  `commands.js`'s `applyParams()` is fully generic over it, so `rate` gets
  instant-set, ramping (`/noisemod1 rate=20 3`), and deferred `at=`
  scheduling for free — no extra code.
- **A getter delegating to `params.<key>.audioParam`** (like `get rate()`
  above) is optional — only add one if you want the param usable directly as
  an `RibbitAutomationEvent` target elsewhere in the codebase (see
  `RibbitReverb.wet` for why). Nothing in the modulator/patch system itself
  needs it, since `Ribbit._resolveDest` already reaches `params[key].audioParam`
  directly.

## Optional: runtime options (settable, not rampable)

For a runtime setting that isn't a real `AudioParam` (like `RibbitLFO`'s
`waveform`, or `RibbitRandomNotes`' `scale`), store it on `this` in the
constructor and declare it in `this.options`:

```js
this.options = {
    waveform: {
        get: () => this.waveform,
        set: (value) => {
            this.waveform = value;
            this.osc.type = value; // live-mutable on OscillatorNode
        },
        choices: ["sine", "square", "sawtooth", "triangle"],
    },
};
```

One declaration makes it console-settable (`/mod1 waveform=square`,
validated against `choices`, which also drive ghost-text completion; ramp
specs rejected), lists it in `help` under "options", and round-trips it
through `/save_session`/`/recall` — the base `getOptions()` derives from
this map (the same keys your constructor accepts back), so don't override
it. Every `RibbitParam` in `this.params` (like `rate` above) already
round-trips on its own. See
[architecture.md](architecture.md#a-third-path-structural-reconciliation-for-recall).

## Registering it

```js
// ribbit.js
import { RibbitNoiseModulator } from "./modulators/noisemod";

const MODULATOR_TYPES = {
    lfo: RibbitLFO,
    noisemod: RibbitNoiseModulator,   // add this
};
```

`/add_modulator type=noisemod rate=8 name=wobble1` and `/wobble1 rate=20 3`
work immediately — no other code changes needed, since `createModulator` and
`modulatorCommand`/`applyParams` all work generically off `MODULATOR_TYPES`
and `params`. `/patch source=wobble1 dest=reverb.wet depth=0.3` patches it in
exactly the same way an `lfo` would, since patching only cares that the
source object has an `.output`.

## An alternative shape: generating discrete events instead of a signal

Everything above assumes a modulator produces a *continuous* signal to patch
into a parameter — the common case. A modulator can instead generate
discrete **notes** (e.g. an algorithmic melody/rhythm generator) and feed
them straight into a track's synth — see `modulators/randomnotes.js`
(`RibbitRandomNotes`) for the real example, and
[architecture.md](architecture.md#event-generating-modulators-the-discrete-counterpart-to-a-patch)
for the full model. The shape is different enough from the rest of this
document that it's worth calling out rather than shoehorning into the
"builds a signal, connects into `this.output`" recipe above:

- Implement `generateEvents(fromBeat, toBeat)` instead of relying on a
  meaningful `this.output` — called by `RibbitClock` every tick with an
  **absolute** (non-loop-relative) beat range, so state like "beats since the
  last note" can advance forever rather than resetting every loop pass (a
  fixed, loop-relative `events` array — the shape a synth's own pattern
  uses — assumes a *repeating* pattern, which generated notes usually aren't).
  Return whatever `RibbitEvent`s should fire in that range.
- `this.eventDestinations` is already there — declared on `RibbitModulator`,
  so you **don't** initialize it yourself. The clock delivers generated notes
  to every channel in this array via `destination.source.trigger(...)`, the
  exact same call a manually-authored event uses, and the array is maintained
  for you by `RibbitEventPatch` (`patch.js`). It used to be each subclass's
  job, which made it look optional when it isn't: `patch.js` and
  `Ribbit._createEventPatch` index into it directly, so a generator that forgot
  it failed at *patch* time with a bare "cannot read properties of undefined" —
  an error pointing nowhere near the omission.
- If the modulator keeps its own **absolute-beat** state (like
  `RibbitRandomNotes`' `_nextCandidateBeat` cursor), implement
  `onClockStart()` (another duck-typed optional hook, called by
  `RibbitClock.start()` on every unit) to reset it — a clock (re)start
  rewinds absolute beats to 0, and stale absolute-beat state would leave
  the modulator silently generating nothing after a `/stop` `/start` until
  the clock caught back up to it.
- Such a modulator is patched into a synth with the reserved `.notes`
  destination instead of a `name.param` — `/patch source=<generator>
  dest=<track>.notes` (see [user/commands.md](../user/commands.md#event-generating-modulators-patching-notes-into-a-synth))
  — which `ribbit.js`'s `createPatch` recognizes automatically by duck-typing
  `generateEvents` on the source; no separate command or registry is needed.
- If a param on this kind of modulator needs real `AudioParam` scheduling
  (ramping, `at=`, `/recall`) but isn't naturally audio-rate — like
  `RibbitRandomNotes`'s `probability`/`min_gap` — use **`RibbitParamSources`**
  (`param.js`): `this._paramSources = new RibbitParamSources(audioContext)`,
  then one `this._paramSources.create(value, { min, max })` per param, each
  returning a ready-made `RibbitParam`. It exists because such a param needs
  a `ConstantSourceNode` **routed through a muted sink into
  `audioContext.destination`**, not left fully disconnected: a disconnected
  node's `setValueAtTime`-scheduled automation can silently never be
  reflected back in a later `.value` read in some browsers, even though a
  direct `.value =` assignment always works regardless — see
  `source-overview.md`'s `modulators/randomnotes.js` section for the full
  explanation. Anything extra a modulator owns beyond
  `this.output` (like those sink nodes) needs its own `dispose()` method —
  with `RibbitParamSources` that's a one-liner,
  `this._paramSources.dispose()` —
  called by `Ribbit.removeModulator` the same duck-typed-optional way as
  `generateEvents` itself — the base class's generic `output.disconnect()`
  alone won't reach them.
- If it generates **drums**, don't emit raw slot numbers. Store
  `{ category, variant }` and resolve `category * stride + variant` at
  delivery, where `stride` comes from the inherited
  `RibbitModulator._stride()` — it asks the patched destination
  (`RibbitPercSampler` publishes `slotsPerCategory`) and falls back to your own
  `perCategory`. That's what lets one pattern drive a kit with 1 or 8 slots per
  category, and lets two generators share one kit.
- If it needs seeded randomness (and any generator that should survive a
  session round trip does), import `mulberry32`/`randomSeed` from `random.js`
  rather than writing your own. Use `Math.random()` only for things that
  deliberately *shouldn't* be reproducible — the choice of generator is the
  choice of whether the result is part of the document.

### Which kind of generator to build

There are four, and they differ in **what decides whether a hit happens** —
usually a more useful axis for a fifth than a new sound:

| Generator | Decides from |
|---|---|
| `randomnotes` | a fresh dice roll per slot — never repeats |
| `markovpercs` | the previous step — fixed pattern, no notion of bar position |
| `euclidpercs` | the step's own index — exactly repeatable, can hold a downbeat |
| `patternvariator` | **a file a person wrote**, plus seeded variation |

The last one is the odd one out and worth understanding before adding another:
its material is *authored* rather than derived, which is a genuinely different
proposition from the other three. See
[creating-a-pattern.md](creating-a-pattern.md) for the format it reads and how
to extend it.

One design note that applies to all of them: a value consulted only when the
pattern is **regenerated** should be an *option*, even when it's numeric,
because a ramp on it would look like a control that does nothing. Reserve
params for values read fresh inside `generateEvents`. Both `markovpercs` and
`patternvariator` split exactly this way — `seed`/`variation`/`density` are
options, `velocity`/`swing` are params.

## Removing one later

See [removing-a-type.md](removing-a-type.md) — the undo is not just these
steps reversed, since docs, comments, demo sessions, and host-app routes all
accumulate references to a type over its life.
