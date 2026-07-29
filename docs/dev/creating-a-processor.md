# Creating a processor

> **Before you start:** [`../llm/catalog.md`](../llm/catalog.md) lists every
> synth, processor and modulator already in the engine with its params and
> options, plus a "which one to copy" table. It's the quickest way to find the
> closest existing processor to model yours on. **Remember to add your new processor
> to it** once it works — that catalog is what later readers consult instead of
> the source tree.

A processor is anything that extends `RibbitProcessor`, wires real DSP nodes between
the inherited `this.input` and `this.output` (both plain `GainNode`s), and
populates `this.params` with `RibbitParam`s so the console can inspect/control it.

## Minimal example

A simple hard-clip distortion using a `WaveShaperNode`, with one runtime param
(`wet`):

```js
// src/processors/distortion.js — non-base processors
// live in their own processors/ subfolder, one level down from the base classes.
import { RibbitProcessor } from "../processor";
import { RibbitParam } from "../param";

function buildCurve(amount) {
    const samples = 1024;
    const curve = new Float32Array(samples);
    const k = amount * 100;
    for (let i = 0; i < samples; i++) {
        const x = (i / (samples - 1)) * 2 - 1;
        curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
};

export class RibbitDistortion extends RibbitProcessor {
    constructor(audioContext, { name = "distortion", amount = 0.5, wet = 1 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A simple waveshaper distortion.";

        // Not a runtime param (no AudioParam behind it) — exposed as a
        // runtime *option* below instead.
        this.amount = amount;

        this.shaper = audioContext.createWaveShaper();
        this.shaper.curve = buildCurve(amount);

        this.wetGain = audioContext.createGain();
        this.wetGain.gain.value = wet;

        this.input.connect(this.shaper);
        this.shaper.connect(this.wetGain);
        this.wetGain.connect(this.output);

        this.params = {
            wet: new RibbitParam(this.wetGain.gain),
        };

        // Runtime-settable option: /distortion amount=0.8 rebuilds the
        // curve in place. Round-tripped by the base getOptions().
        this.options = {
            amount: {
                get: () => this.amount,
                set: (value) => {
                    const num = Number(value);
                    if (!Number.isFinite(num) || num <= 0) throw new Error(`invalid amount "${value}"`);
                    this.amount = num;
                    this.shaper.curve = buildCurve(num);
                },
            },
        };
    };
};
```

(`amount` is deliberately left as a constructor-only option here, not a
runtime param — see the note below on params that aren't backed by a real
`AudioParam` at all.)

Points worth noting, all copied from `processors/reverb.js`/`processors/delay.js`:

- **`this.input`/`this.output` are provided by the base class** — wire your DSP
  chain between them; never create your own input/output nodes.
- **Decide dry/wet at construction, not as an afterthought.** `RibbitReverb` and
  `RibbitDelay` both always pass dry signal straight through (`input.connect(output)`)
  in parallel with the wet path, so `wet=0` doesn't silence the channel — match
  this convention unless a processor is deliberately not supposed to have a dry
  path (e.g. a pure gain/distortion insert might reasonably *not* keep a separate
  dry path, since the wet path *is* the whole signal).
- **`this.params` is the command-router's introspection surface** —
  `{ paramName: RibbitParam }` (see `param.js`). `commands.js`'s `applyParams()`
  calls `.set(value)`/reads `.audioParam` for `/name param=value` (and ramps/
  defers the same way), and `.get()` to print current values for `/name` /
  `/name help`. Every param you want addressable from the console (or
  eventually the mixer) must appear here.
- **Most params wrap exactly one real `AudioParam`** — `new RibbitParam(this.wetGain.gain)`
  is the common case (see `wet` above, or `RibbitReverb.params.wet`). This is
  what makes ramping/`at=` deferral work automatically, since both read/write
  `.audioParam` directly via native `setValueAtTime`/`linearRampToValueAtTime`
  calls.
- **A param that has to fan a value out across more than one node** (like
  `RibbitDelay`'s `time`, which writes both `delayL.delayTime` and
  `delayR.delayTime`, the latter offset for stereo width) still fits
  `RibbitParam` — pass whichever node should be the "primary" one (the one
  ramping/`at=` deferral will animate) as the wrapped `AudioParam`, and
  override the plain instant-set path with `onSet`. See `processors/delay.js` for the
  real example.
- **A param that isn't backed by a real `AudioParam` at all** (`amount`
  above, whose "value" is really a `Float32Array` curve that has to be
  rebuilt from scratch on every change) doesn't fit `RibbitParam` well — there's
  no real `AudioParam` to ramp, and forcing one in just to satisfy the
  constructor would be misleading. It's fine to leave a param like this as a
  constructor-only option (not runtime-adjustable at all) until/unless
  `RibbitParam` grows a mode for non-`AudioParam`-backed values; don't invent an
  awkward fake `AudioParam` to route around this.
- **`active` (routing bypass) is handled entirely by `RibbitChannel._rewireChain`** —
  you don't need to check `this.active` yourself inside the processor; when
  bypassed, the channel simply doesn't connect your `input`/`output` into the
  chain at all.
- **If you also want a param usable as an `RibbitAutomationEvent` target**
  (loop-position pattern automation, not a console ramp), expose a getter
  that delegates to your `RibbitParam`'s own `audioParam` — e.g. `get wet() {
  return this.params.wet.audioParam; }`, exactly like `RibbitReverb`/`RibbitDelay`
  do. This is a thin alias, not a second implementation, so it can never
  drift out of sync with `params.wet` the way two independently-hand-written
  accessors could.

## Optional: runtime options (settable, not rampable)

For a setting that isn't a real `AudioParam` (like `amount` above, or
`RibbitReverb`'s `duration`/`decay`, which regenerate the impulse response),
declare it in `this.options` — `{ key: { get(), set(value), choices? } }`,
as `RibbitDistortion.amount` does above. One declaration makes it
console-settable at runtime (`/distortion amount=0.8`; a ramp spec is
cleanly rejected), lists it in `help` under "options", and lets
`session.js` reconstruct an equivalent processor on
`/load_session`/`/recall` — the base `getOptions()` derives its result from
this map (the same keys the constructor accepts back), so don't override
it. `set()` may validate and throw; the message surfaces as a per-key
console error. Every `RibbitParam` in `this.params` already round-trips on
its own; options are only for the rest. See
[architecture.md](architecture.md#a-third-path-structural-reconciliation-for-recall).

## Registering it

```js
// ribbit.js
import { RibbitDistortion } from "./processors/distortion";

const PROCESSOR_TYPES = {
    reverb: RibbitReverb,
    delay: RibbitDelay,
    distortion: RibbitDistortion,   // add this
};
```

`/track_1 add_processor=distortion` and `/distortion amount=0.8` work immediately —
no other code changes needed, since `createProcessor` and `processorCommand`/
`applyParams` both work generically off `PROCESSOR_TYPES` and `params`.


## Removing one later

See [removing-a-type.md](removing-a-type.md) — the undo is not just these
steps reversed, since docs, comments, demo sessions, and host-app routes all
accumulate references to a type over its life.
