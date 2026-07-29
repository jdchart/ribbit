# Creating a synth

> **Before you start:** [`../llm/catalog.md`](../llm/catalog.md) lists every
> synth, processor and modulator already in the engine with its params and
> options, plus a "which one to copy" table. It's the quickest way to find the
> closest existing synth to model yours on. **Remember to add your new synth
> to it** once it works — that catalog is what later readers consult instead of
> the source tree.

A synth is anything that extends `RibbitSynth`, implements `trigger()`, and connects
its sound-producing nodes into `this.output` (a `GainNode` the base class already
creates for you).

## Minimal example

A one-oscillator sine "ping" synth, ignoring `pitch`/`velocity` for simplicity:

```js
// src/synths/pingsynth.js — non-base synths live in
// their own synths/ subfolder, one level down from the base classes.
import { RibbitSynth } from "../synth";

export class RibbitPingSynth extends RibbitSynth {
    constructor(audioContext, { name = "pingsynth" } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A single sine-wave ping per event, fixed pitch.";
    };

    trigger(time, event, secondsPerBeat) {
        const ctx = this.audioContext;
        const durationSeconds = event.duration * secondsPerBeat;

        const osc = ctx.createOscillator();
        osc.frequency.setValueAtTime(440, time);

        const voiceGain = ctx.createGain();
        voiceGain.gain.setValueAtTime(event.velocity, time);
        voiceGain.gain.exponentialRampToValueAtTime(0.0001, time + durationSeconds);

        osc.connect(voiceGain).connect(this.output);
        osc.start(time);
        osc.stop(time + durationSeconds + 0.05);
    };
};
```

Points worth noting, all copied from `synths/oscsynth.js`/`synths/sampler.js`:

- **Always create fresh nodes per trigger.** `OscillatorNode`/`AudioBufferSourceNode`
  are one-shot (`start()` can only be called once) — you cannot reuse a single
  persistent oscillator across triggers the way a real modular synth voice might;
  build the voice graph inside `trigger()` and let it be garbage-collected after
  `stop()`.
- **Schedule at `time`, not `audioContext.currentTime`.** The clock computed `time`
  as a precise future `AudioContext` timestamp via lookahead scheduling; using
  `currentTime` instead would make playback jittery.
- **`secondsPerBeat` converts `event.duration` (in beats) to seconds** — durations
  in `RibbitEvent` are tempo-relative, not absolute.
- **Ramp gain to 0 exponentially, not linearly, and add a small tail** (`+ 0.05`
  on `stop()`) so the oscillator doesn't hard-cut mid-sample (a click).
  `exponentialRampToValueAtTime` cannot target exactly `0`, hence `0.0001`.
- **`this.output` is provided by the base class** — never create your own output
  gain node; connect your voice's final node into the inherited one.

## Registering it

Add it to the registry in `ribbit.js` (the only place that needs to know new synth
types exist):

```js
import { RibbitPingSynth } from "./synths/pingsynth";

const SYNTH_TYPES = {
    oscsynth: RibbitOscSynth,
    sampler: RibbitSampler,
    pingsynth: RibbitPingSynth,   // add this
};
```

That's it — `/add_track synth=pingsynth` and `/track_1 synth=pingsynth` both work
immediately, with no other code changes, because `createTrack`/`setTrackSynth`
look the type up in `SYNTH_TYPES` dynamically.

## Don't self-seed events

Earlier versions of both existing synths seeded a few `RibbitEvent`s in their own
constructor so a freshly-created instance was audible with zero authoring. That
convention is gone now that real event authoring exists (`/track_1 add_event
...`, see [user/commands.md](../user/commands.md)) — a synth should leave
`this.events` empty and let the console/UI/LLM populate it. A fresh instance of
your synth will be silent until something calls `addEvent()` on it, and that's
expected.

## Optional: resolving `degree` against harmony

If your synth is pitched (like `oscsynth`), consider following its pattern for
`RibbitEvent.degree`: resolve it against the shared harmony context at trigger
time instead of always reading `event.pitch` directly, so the synth
automatically benefits from any future key/scale-changing command:

```js
import { resolveDegree } from "../harmony";

trigger(time, event, secondsPerBeat) {
    const midi = event.degree !== undefined ? resolveDegree(this.harmony, event.degree) : event.pitch;
    // ... use midi instead of event.pitch
};
```

`this.harmony` is set by the base `RibbitSynth` constructor (from the `harmony`
option `Ribbit.createSynth` passes in, falling back to a fresh chromatic context
for standalone use) — you don't need to do anything to receive it. Skip this
entirely if `pitch` doesn't mean "MIDI note" for your synth (e.g. `sampler`
treats it as a slot index and never resolves `degree`).

## Optional: runtime options (settable, not rampable)

For a runtime setting that isn't backed by any `AudioParam` (like
`RibbitOscSynth`'s `waveform`), store it on `this` in the constructor and
declare it in `this.options` — `{ key: { get(), set(value), choices? } }`:

```js
this.options = {
    waveform: {
        get: () => this.waveform,
        set: (value) => { this.waveform = value; },
        choices: ["sine", "square", "sawtooth", "triangle"],
    },
};
```

One declaration buys everything: `channelCommand` routes it through the
track's own name (`/track_1 waveform=square` — a synth is never separately
addressable, its channel is its surface), `help` lists it under "synth
params/options", ghost-text completes its value from `choices`, a ramp spec
on it is cleanly rejected (options aren't rampable), and `session.js`
round-trips it — the base `getOptions()` derives its result from this map
(the same keys your constructor accepts back), so **don't override
`getOptions()` anymore**. `set()` may validate and throw; the message
surfaces as a per-key console error without aborting the rest of the
command.

## Optional: runtime params

`RibbitSynth.params` starts as `{}` and neither existing synth subclass
populates it — both synths' runtime surface is currently options (above).
If your synth has a genuinely rampable, `AudioParam`-backed value (a filter
cutoff, say), populate `this.params` with `RibbitParam`s the same way a
processor does (see [creating-a-processor.md](creating-a-processor.md) and
`param.js`). Nothing else needs changing: `channelCommand` already routes
`channel.source.params` through `applyParams()`, so `/track_1 cutoff=800 2b`
(ramping and `at=` deferral included) works, and `_resolveDest` falls back
from a channel's own `params` to its synth's, so `/patch dest=track_1.cutoff`
resolves too. Both paths are live but currently unexercised — neither
built-in synth declares a param — so yours would be the first to use them.

## Removing one later

See [removing-a-type.md](removing-a-type.md) — the undo is not just these
steps reversed, since docs, comments, demo sessions, and host-app routes all
accumulate references to a type over its life.
