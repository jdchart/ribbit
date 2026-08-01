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

`RibbitSynth.params` starts as `{}`. `oscsynth` and `sampler` leave it that
way — their runtime surface is options (above) — but `percsampler`
(`dynamics`/`pan_spread`/`speed_spread`), `karplus`
(`damping`/`decay`/`brightness`), `granular` (nine) and `tapepad` (eleven) all
declare params, so there are four worked examples to copy.

> **Read your params with `getModulated()`, not `get()`.** A synth param is
> read in JavaScript when a note is scheduled, and a patch sums into the
> `AudioParam`'s *computed* value, which a `.value` read never sees.
> `getModulated()` reads the summed signal instead (see `param.js` in
> [source-overview.md](source-overview.md#paramjs)); `get()` is for display
> and serialization only. Use it for every param you read in `trigger()` and
> `/patch dest=track_1.cutoff` works — once per note, so it moves each new
> note rather than sweeping a sounding one.

If your synth has a genuinely rampable value (a filter cutoff, say), populate
`this.params` with `RibbitParam`s the same way a processor does (see
[creating-a-processor.md](creating-a-processor.md) and `param.js`). Nothing
else needs changing: `channelCommand` already routes `channel.source.params`
through `applyParams()`, so `/track_1 cutoff=800 2b` (ramping and `at=`
deferral included) works; `_resolveDest` falls back from a channel's own
`params` to its synth's, so `/patch dest=track_1.cutoff` resolves; and
`addressableParams()` does the same for `automate=`, so
`/track_1 automate=cutoff to=2000 duration=4` attaches loop automation.

A synth param needs a real `AudioParam` behind it. If your value has no node
of its own — `karplus` is the extreme case, since it renders each note in JS
and has no live graph at all — use `RibbitParamSources` (`param.js`) rather
than hand-rolling a `ConstantSourceNode`, and call its `dispose()` from your
own:

```js
this._paramSources = new RibbitParamSources(audioContext);
this.params = { cutoff: this._paramSources.create(cutoff, { min: 20, max: 20000 }) };
dispose() { this._paramSources.dispose(); }
```

### Params that *aren't* read per note

The rule above — read with `getModulated()`, moves note by note — applies to a
param your `trigger()` reads. It doesn't have to be all of them. If your synth
keeps **persistent shared nodes** alongside the one-shots it builds per note,
any `AudioParam` on those is a param you can publish directly:

```js
this.params = { wow: new RibbitParam(this._wowGain.gain, { min: 0, max: 200 }) };
```

Such a param is *continuous* — a ramp or a patch moves it while notes are
already sounding — and needs no `RibbitParamSources` entry, no
`getModulated()` call, and no tap. `tapepad` is the worked example, and mixes
both kinds in one `this.params`: five real `AudioParam`s on its shared tape
transport, six JS-read ones for the per-note voice. The console can't tell
them apart and doesn't need to; the difference is only *when* the change is
audible, which is worth stating in your docs entry per param.

Two things follow from having persistent nodes at all. They keep running when
the track is stopped (`active` gates event scheduling, not audio — `tapepad`'s
hiss is audible with the transport paused, deliberately), and they must be
torn down in `dispose()`, since `removeTrack`/`setTrackSynth` only do a
generic `output.disconnect()`.

## Optional: polyphony, and synthesizing into a buffer

`karplus`, `granular` and `tapepad` are the polyphonic synths, and polyphony
turned out to need no machinery: `trigger()` builds a fresh, self-contained
voice per call, so a chord is simply several calls at the same beat. There's no
voice allocator and nothing to run out of.

`granular` pushes that further and is the example to read if your synth
schedules **many** nodes per note: it places a whole cloud of grains (three
nodes each) on the audio clock inside one `trigger()`, with no timers. Two
rules it follows that generalize — put anything shared across a note's nodes
on *one* node rather than per-node (its grain windows are unit-amplitude
`Float32Array`s shared engine-wide, because level lives on the voice gain),
and when a note would exceed your node budget, **thin it rather than truncate
it**: a texture that gets sparser is a texture, a note that stops halfway
through is a bug you can hear.

It's also the only synth that renders audio with a **JS loop into an
`AudioBuffer`** instead of building a node graph. Worth knowing as a technique,
because sometimes a node graph can't express the algorithm: there, Web Audio
requires any feedback cycle containing a `DelayNode` to impose at least one
render quantum (128 samples) of delay, which caps a node-graph Karplus-Strong
around 375Hz — the middle of the playable range. Rendering the samples directly
is exact at any pitch and, importantly, needs no `AudioWorklet` module for the
host to serve, which would be a new category of host obligation (the engine
otherwise only ever asks hosts for JSON manifests). The cost is well under a
millisecond per note.

## Optional: loading files from the host

If your synth plays audio the host serves, don't write your own fetch: use
**`src/samples.js`** (`fetchSampleManifest`, `resolvedSampleManifest`,
`sampleName`, `sampleUrl`). It exists because `percsampler` and `granular`
both read the same library, and it carries two non-obvious things — a
two-level cache (promise *and* resolved object, the latter so a live re-roll
completes synchronously and the console echoes what it just chose rather than
what it replaced) and a URL builder that doesn't over-escape path segments.

The host contract is: a browser can't list a directory over HTTP, so the host
publishes `GET /samples/manifest.json` → `{ <folder>: ["<folder>/a.wav", ...] }`.
Keep the failure mode the others have — a missing manifest means a silent
instrument and one `console.warn`, never a throw out of a constructor, and a
trigger before loading finishes silently no-ops rather than queuing.

Two conventions worth copying from `granular` if your synth picks a file at
random: report the **resolved** path from your option's `get()` (never the
word `random`, or a saved session wouldn't reproduce), and **gain-match the
file on load** — an unmastered library spans tens of dB, and without matching
every re-roll invalidates the mix.

## Removing one later

See [removing-a-type.md](removing-a-type.md) — the undo is not just these
steps reversed, since docs, comments, demo sessions, and host-app routes all
accumulate references to a type over its life.
