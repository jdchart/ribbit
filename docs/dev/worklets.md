# Writing a type that runs in an AudioWorklet

The AE machine's 36 types (`docs/dev/ae-machine.md`) run their DSP in
AudioWorklets. This is the guide to doing the same for a new synth, processor
or modulator. The ordinary path (`creating-a-synth.md` etc.) still applies for
registration, options and docs; this covers what's different.

## When

Use a worklet when a node graph can't express the DSP:

- **feedback shorter than 128 samples** — any cycle in a Web Audio graph is
  forced to one render quantum, so nothing resonates above ~375 Hz (the wall
  `karplus` and `comb` document);
- **a nonlinearity or a shifter inside a loop** (Cascade's pitch shifter, a
  wavefolded delay network);
- **state that evolves per sample** and must keep running while notes ring or
  when no note comes (a drone, a freeze, a looper, an envelope follower);
- a voice whose params should **move while it rings** (a render-into-a-buffer
  voice like `karplus` can only read params once per note).

Otherwise don't: native nodes are cheaper and a buffer render is simpler.

## The pieces (`src/dsp/`)

| file | what |
|---|---|
| `worklet.js` | `registerWorkletProcessor(name, factory, params)`, `loadWorklets(ctx)` (one blob module per context), `WorkletNode` (the main-thread handle) |
| `lib.js` | `dspLibrary()` — the toolkit every processor uses, injected as `DSP` |
| `spec.js` | the param-table convention: `buildParams`, `workletParams`, `choiceOption`, `toggleOption` |
| `voice.js` | `RibbitWorkletSynth` (lane/sieve/quant, note posting) |
| `effect.js` | `RibbitWorkletProcessor` (`send`, `setParamAt`, the `jump` convention), `tunedDelay` |
| `modsource.js` | `RibbitWorkletModulator` (beat anchors, strikes, `signalOutput`) |
| `analysis.js`, `sampled.js` | sample decode/onsets/features/k-means; the `sample`/`folder` slot |

## The one rule: a factory is self-contained

A processor is a **factory function** `(Base, DSP) => class extends Base {…}`
in an ordinary module. `worklet.js` turns it into source text with
`toString()` and compiles every registered factory into one blob module, so
the host serves nothing. Inside the factory you may use its two arguments and
the worklet globals (`sampleRate`, `currentTime`) — **nothing else from its
module**. A constant, a helper, the param table: restate it inside, or put it
in `lib.js` (which is injected whole). A factory that closes over module scope
works in Node and fails in the browser with a ReferenceError — so test it the
way the browser builds it (below).

## A voice, end to end

```js
export const MYVOICE_PARAMS = {
    decay: { value: 0.3, min: 0, max: 1 },
    level: { value: 0.7, min: 0, max: 1 },
};

export function myvoiceProcessor(Base, DSP) {
    const { SR, mtof, t60, voiceProcessor } = DSP;
    class Voice {
        constructor(m, P) {           // m: {time, pitch, note, velocity, duration}
            this.inc = mtof(m.pitch) / SR;  // P: every param's current value
            this.mul = t60(0.02 + 3 * P.decay);
            this.env = m.velocity * P.level;
            this.phase = 0;
        }
        render(L, R, from, to) {       // ADD into L/R; return false when done
            for (let i = from; i < to; i++) {
                this.env *= this.mul;
                if (this.env < 1e-4) return false;
                const y = Math.sin(6.2831853 * (this.phase += this.inc)) * this.env;
                L[i] += y; R[i] += y;
            }
            return true;
        }
    }
    return voiceProcessor(Base, (m, P) => new Voice(m, P), 8);
};

registerWorkletProcessor("ribbit-myvoice", myvoiceProcessor, workletParams(MYVOICE_PARAMS));

export class RibbitMyVoice extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "myvoice", ...options }, {
            processor: "ribbit-myvoice", params: MYVOICE_PARAMS, lane: "any", sieve: "all",
        });
        this.llm_summary = "…";
    };
};
```

`voiceProcessor` owns the note queue (each note starts at its exact sample;
notes more than 50 ms late are dropped), voice stealing (5 ms fade past the
limit), and hooks: `init`, `message(m)`, `before(L, R, P)`, `after(L, R, P)`
(a stage on the voice *sum* that must outlive voices — `metalbass`'s delay,
`bassdrum`'s reverb); any other function in the hooks becomes a method.
`effectProcessor(Base, { setup, onMessage, render })` is the same for an
effect, with a `TimedQueue` so `send({…}, time)` lands on its sample.

## Params

A param table becomes both the `RibbitParam`s (each a `ConstantSourceNode`)
and the processor's `AudioParam` descriptors (intrinsic 0). `WorkletNode`
connects one into the other, so ramps, `at=`, automation and `/patch` reach
the DSP with no per-type code. Read them per block as `P.name` (k-rate).
`rate: "a-rate"` gives a per-sample array (`parameters.name`) — a sidechain
input when a track is patched into it.

## Messages

Main → worklet: `this.node.post(msg)` (queued until the module loads).
Worklet → main: `this.port.postMessage(msg)`, received in
`onWorkletMessage(msg)` — how `oxide` reports Time to Degradation and
`spectra` its photograph. Keep status posts to a few per second.

## Rules the existing types follow

- **Allocate nothing per sample** — no arrays, no closures in the loop, no
  destructuring of returned arrays (write into preallocated typed arrays).
- **Prove loop gains ≤ 1**: normalise fold/saturation to unity slope, use
  orthogonal (Householder/Hadamard) mixing, use the SVF's `band * k` for a
  unity-peak bandpass (its raw band output peaks at Q).
- **Compensate pitch** in delay-line resonators: subtract the loop filters'
  phase delay at the fundamental (`twostring`).
- `pow`/`exp`/`tan` at block rate, not per sample, unless the value sweeps.
- A free-running synth gates on its `active` setter (the base constructor
  assigns `active` before your node exists — guard it).

## Testing

1. **Node, from source text.** Render the factory rebuilt from its
   `toString()` against a stub `Base` with `sampleRate`/`currentTime`
   globals and `new Function(...)`, exactly as `worklet.js` does — that alone
   catches scope leaks — then check NaN, peak, RMS, tail length, pitch
   (autocorrelation), and render with every param at its extremes.
2. **Browser, offline.** `new OfflineAudioContext`, construct the class
   directly, `await synth.node.ready`, trigger, `startRendering()` — via the
   `run` skill's `js:` directive. Node and Chromium agree to three decimals
   (the same V8).
3. **Browser, live**, for anything involving the clock: the `run` skill.

The build of the AE machine used exactly this loop; see the session log for
the bugs it caught (a two-sample pitch error, three runaway feedback loops,
two scope leaks).
