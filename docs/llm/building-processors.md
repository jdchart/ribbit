# LLM context: building a processor

Full tutorial with rationale: `docs/dev/creating-a-processor.md`. This is the
condensed recipe.

**Read `docs/llm/catalog.md` first** — it lists every existing synth,
processor and modulator with its params and options, and has a "which one to
copy" table. Pick the closest existing processor from there and read that one
file, rather than trawling `src/`. **And update the catalog** when you're
done: a new type that isn't in it is invisible to the next session.

A processor extends `RibbitProcessor` (`src/processor.js`),
which provides `this.input`/`this.output` (both `GainNode`s) and `this.active`
(routing bypass, handled entirely by the owning `RibbitChannel._rewireChain` —
don't check it yourself). Wire real DSP nodes between `input` and `output` in the
constructor; there's no `trigger()` or per-event method — processors just sit in
the signal chain continuously. Populate `this.params` as `{ paramName: RibbitParam }`
(`src/param.js`) — this is what the console's `/name
param=value`, `/name help`, ramping, and `at=` deferral all read/write generically
via `commands.js`'s `applyParams()`.

```js
// src/processors/myprocessor.js — non-base processors
// live in their own processors/ subfolder, one level down from the base classes.
import { RibbitProcessor } from "../processor";
import { RibbitParam } from "../param";

export class RibbitMyProcessor extends RibbitProcessor {
    constructor(audioContext, { name = "myprocessor", amount = 0.5 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "One-line description shown in /help.";

        // build DSP nodes, this.input.connect(...)....connect(this.output)
        // (existing processors always keep a dry passthrough in parallel with
        // the wet path: this.input.connect(this.output) plus a separate wet chain)
        this.someGain = audioContext.createGain();
        this.someGain.gain.value = amount;

        this.params = {
            amount: new RibbitParam(this.someGain.gain),
        };
    };

    // Optional: only add if you want `amount` usable directly as an
    // RibbitAutomationEvent target elsewhere — a thin delegate, not a second
    // implementation, so it can't drift from params.amount.
    get amount() {
        return this.params.amount.audioParam;
    };
};
```

`new RibbitParam(audioParam, opts?)` covers almost every case:
- Single real `AudioParam` (most common): `new RibbitParam(this.someGain.gain)`.
- Needs a value transform (rare outside channel gain's taper): `{ decode, encode }`.
- Needs clamping: `{ min, max }` — always declare both. They also decide
  randomizability: `<param>=random` draws from the range, and the bulk
  `/<name> random` skips any param without one.
- Should never be part of a bulk `random` even though it has a range:
  `{ randomizable: false }` (only channel `gain` uses this today).
- Needs to fan out across several nodes — connect
  one `ConstantSourceNode`'s `.offset` (via `RibbitParamSources`) into every
  target `AudioParam`, setting each target's intrinsic value to 0. Connections
  *sum* onto the intrinsic value, so one param drives all of them through
  sets, ramps, `at=` and `/patch`. See `RibbitTilt` (two shelf gains, inverted),
  `RibbitProcessor.createCrossfade` (two gains, inverted), `RibbitDelay`
  (both delay lines, plus a second constant for `stereoOffset`) and
  `RibbitComb` (both branches' delay and feedback).
  There is also `{ onSet }`, which overrides the *instant-set* path only — so
  a ramp animates the "primary" node and strands the others. **No shipped param
  uses it**; reach for the constant-source technique above instead.
- Not backed by any real `AudioParam` and with nothing to sweep (a value that
  rebuilds a waveshaper curve): make it an **option**, not a param.
- Not backed by any real `AudioParam` but genuinely sweepable: use
  `RibbitParamSources` (`src/param.js`), and dispose it.

**Dry/wet has two shapes; picking wrong is a bug.** `reverb`/`delay` keep dry at
unity and *add* wet — right for an effect. Anything that *acts on* the signal
(compressor, saturator) needs `RibbitProcessor.createCrossfade(mix)`, a true
crossfade with dry = 1 - mix, or its dry path carries exactly the peaks it was
inserted to control. Returns `{ param, dryGain, wetGain }` with dry pre-wired;
connect your wet chain into `wetGain`. Some processors want neither (`tilt`,
`limiter`).

**`dispose()`** is duck-typed and called by `removeProcessor`/`Ribbit.dispose`.
The base disposes `this._paramSources`; override + `super.dispose()` if you own
more. Required if you use `createCrossfade` or `RibbitParamSources`, since those
`ConstantSourceNode`s reach `destination` through their own muted sinks and
aren't stopped by unwiring the processor.

**Composites are allowed.** `RibbitGoodenizer` builds four other processors
directly (never via `createProcessor`, so they stay unregistered and
unaddressable), chains their `input`/`output`s, and republishes their *actual*
`RibbitParam`/option objects — the same objects, so nothing can drift. Its
constructor must accept back every option it republishes (session.js
reconstructs via `createProcessor(type, { name, ...options })`), and its
`dispose()` tears down the children.

Register it in `ribbit.js`'s `PROCESSOR_TYPES` map (`import { RibbitMyProcessor }
from "./processors/myprocessor"; ... { myprocessor: RibbitMyProcessor }`) — the
only other required change. That alone makes `/track_1
add_processor=myprocessor` and `/myprocessor amount=0.8` work, including
`remove_self`, `help`, ramping (`/myprocessor amount=0.8 3`), and `at=beat`/
`at=cycle` deferral — no extra code needed beyond the `RibbitParam`.

For a setting that *isn't* backed by any real `AudioParam` (e.g. a value
that rebuilds a `WaveShaperNode` curve from scratch), declare it in
`this.options` — `{ key: { get(), set(value), choices? } }`, where `set` can
do arbitrary work (rebuild the curve) and throw a clean error on a bad
value (see `RibbitReverb`'s `duration`/`decay` for the real example). That
one declaration makes `/myprocessor curveAmount=3` settable at runtime
(ramp specs rejected — options aren't rampable), lists it in `help` under
"options", and round-trips it through `/save_session`/`/recall`: the base
`getOptions()` derives from the map (same keys the constructor accepts
back), so don't override it.

Removing a type again later: `docs/llm/removing-types.md`.

## When the DSP needs an AudioWorklet

Per-sample feedback, a nonlinearity inside a loop, or state that must keep
running (a sustaining voice, a freeze, a looper) can't be a node graph — use
the worklet bases in `src/dsp/` (`RibbitWorkletSynth`,
`RibbitWorkletProcessor`, `RibbitWorkletModulator`) with a param table and a
**self-contained** processor factory. `docs/dev/worklets.md` is the guide;
the AE machine's 36 types are the examples (`fmperc` is the smallest voice,
`cascade` a small effect, `modlfo` a small modulator).
