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
- **Decide dry/wet at construction, and pick the right *kind*.** There are two,
  and choosing wrong is a real bug rather than a style preference:
  - **Dry at unity, wet added on top** (`input.connect(output)` in parallel with
    the wet path) — what `RibbitReverb` and `RibbitDelay` do. Right for an
    *effect*: something you're layering beside the signal. `wet=0` means off.
  - **A true crossfade**, dry = 1 - mix — `RibbitProcessor.createCrossfade(mix)`,
    used by `RibbitCompressor`, `RibbitSaturator` and `RibbitGoodenizer`. Right
    for anything that *acts on* the signal. A compressor built the first way
    could never tame a peak, because the untouched peak would sail through the
    dry path beside it.

  `createCrossfade` returns `{ param, dryGain, wetGain }` with the dry side
  already wired; connect your wet chain into `wetGain` and put `param` into
  `this.params` as `mix`. It also gives parallel processing for free — `mix=0.5`
  is New York compression.

  A processor may reasonably have *neither* (`RibbitTilt`, `RibbitLimiter`): an
  EQ blended with its dry signal is just a weaker EQ, and a limiter you can
  blend past isn't a limiter.
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
- **A param that isn't backed by a real `AudioParam` at all** splits into two
  cases, and they get opposite answers:
  - **There's no continuous value to sweep** (`amount` above, whose "value" is
    really a `Float32Array` curve rebuilt from scratch on every change; or
    `RibbitSaturator`'s `character`). Declare it as an **option**. Don't invent
    a fake `AudioParam` — a half-applied waveshaper curve is meaningless, so
    there's nothing a ramp could even mean. Note that non-rampable does *not*
    mean non-schedulable: `/saturator character=fold at=cycle` works, like every
    other mutating command.
  - **There is a value worth sweeping, but nothing in the audio graph to hang it
    on.** Use `RibbitParamSources` (`src/param.js`), which invents an
    `AudioParam` from a `ConstantSourceNode`'s `.offset` and handles the
    silent-sink quirk that would otherwise make its scheduled automation
    unreadable. This is what `createCrossfade` uses internally, and what
    `RibbitTilt`'s `tone`/`pivot` and several modulators' params are built from.
    Call `this._paramSources.dispose()` from your own `dispose()`.
- **A param that must *ramp* across several nodes needs the `ConstantSourceNode`
  route, not `onSet`.** `onSet` only overrides the instant-set path, so a ramp
  animates the primary node and strands the others — that's the standing
  `RibbitDelay` `time`/`feedback` limitation. Connecting one
  `ConstantSourceNode`'s offset into several `AudioParam`s instead (optionally
  through scaling/inverting gains) makes a single param drive all of them
  through instant sets, ramps, `at=` deferral and `/patch` alike, because
  `AudioParam` connections *sum* onto the intrinsic value. `RibbitTilt` drives
  two shelf gains in opposite directions this way; `createCrossfade` drives two
  gains for the same reason.
- **Implement `dispose()` if you own running nodes.** It's duck-typed, called by
  `Ribbit.removeProcessor` and `Ribbit.dispose`. The base implementation
  disposes `this._paramSources`; override and call `super.dispose()` if you own
  more (`RibbitGoodenizer` disposes its four children). This matters because a
  `ConstantSourceNode` reaches `audioContext.destination` through its own muted
  sink, so unwiring the processor from a channel's chain never stops it.
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
    compressor: RibbitCompressor,
    saturator: RibbitSaturator,
    tilt: RibbitTilt,
    limiter: RibbitLimiter,
    goodenizer: RibbitGoodenizer,
    distortion: RibbitDistortion,   // add this
};
```

`/track_1 add_processor=distortion` and `/distortion amount=0.8` work immediately —
no other code changes needed, since `createProcessor` and `processorCommand`/
`applyParams` both work generically off `PROCESSOR_TYPES` and `params`.

## Optional: composing existing processors

A processor doesn't have to contain new DSP. `RibbitGoodenizer` is a
**composite**: it constructs one `RibbitCompressor`, `RibbitSaturator`,
`RibbitTilt` and `RibbitLimiter`, chains their `input`/`output`s, and
republishes their *actual* `RibbitParam` and option objects under its own
`params`/`options`:

```js
this.compressor = new RibbitCompressor(audioContext, { name: `${name}:comp`, threshold, ratio });
this.saturator  = new RibbitSaturator(audioContext, { name: `${name}:sat`, drive, character });

this.input.connect(this.compressor.input);
this.compressor.output.connect(this.saturator.input);
// ...

this.params = {
    threshold: this.compressor.params.threshold,   // the same object, not a copy
    drive: this.saturator.params.drive,
};
this.options = { character: this.saturator.options.character };
```

Three things make this work cleanly, and they're the rules to follow if you
build another one:

- **Construct children directly, not via `ribbit.createProcessor`.** They must
  not be registered, addressable, or in anyone's insert chain — they're
  node-graph builders that happen to be shaped like processors.
- **Share the objects, don't wrap them.** Because `params.threshold` *is* the
  child's `RibbitParam`, `/goodenizer threshold=` and a standalone
  `/compressor threshold=` run identical code against the same `AudioParam` and
  cannot drift. Everything generic — help text, ramping, `at=`, `/patch`,
  session round-tripping via `getOptions()` — then works with no extra code.
- **Your constructor must accept back every option you republish**, since
  `session.js` reconstructs with `createProcessor(type, { name, ...options })`.
- **Override `dispose()`** and tear down the children (see above).

Be deliberate about what you *don't* republish. The goodenizer omits its
children's `mix`, the saturator's `level` and the limiter's `boost` — each
would be a second way to set the same balance. One knob per job; the atoms
exist for the rest.

## Removing one later

See [removing-a-type.md](removing-a-type.md) — the undo is not just these
steps reversed, since docs, comments, demo sessions, and host-app routes all
accumulate references to a type over its life.
