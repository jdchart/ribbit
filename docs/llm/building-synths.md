# LLM context: building a synth

Full tutorial with rationale: `docs/dev/creating-a-synth.md`. This is the
condensed recipe.

**Read `docs/llm/catalog.md` first** — it lists every existing synth,
processor and modulator with its params and options, and has a "which one to
copy" table. Pick the closest existing synth from there and read that one
file, rather than trawling `src/`. **And update the catalog** when you're
done: a new type that isn't in it is invisible to the next session.

A synth extends `RibbitSynth` (`src/synth.js`), which provides
`this.output` (a `GainNode`), `this.events`/`this.automation` arrays, `this.active`,
and `addEvent()`/`addAutomation()`. Implement `trigger(time, event,
secondsPerBeat)`: build fresh Web Audio nodes (oscillator/buffer source/etc.),
schedule them starting at the given `time` (an absolute `AudioContext` timestamp,
not `currentTime`), connect the chain's end into `this.output`, and `start()`/
`stop()` the source node(s). `event.duration` is in beats — multiply by
`secondsPerBeat` for seconds. Nodes like `OscillatorNode` are one-shot; build them
inside `trigger()`, don't try to reuse a persistent node across triggers.

```js
// src/synths/mysynth.js — non-base synths live in their
// own synths/ subfolder, one level down from the base classes.
import { RibbitSynth } from "../synth";
import { resolveDegree } from "../harmony"; // only if pitch means "MIDI note"

export class RibbitMySynth extends RibbitSynth {
    constructor(audioContext, { name = "mysynth" } = {}) {
        super(audioContext, { name });
        this.llm_summary = "One-line description shown in /track_1 summaries.";
        // don't seed placeholder events — leave this.events empty; the
        // console/UI/LLM populates it via add_event
    };

    trigger(time, event, secondsPerBeat) {
        const ctx = this.audioContext;
        const durationSeconds = event.duration * secondsPerBeat;
        const midi = event.degree !== undefined ? resolveDegree(this.harmony, event.degree) : event.pitch;
        // build nodes, schedule at `time`, ramp gain to ~0.0001 exponentially
        // by time + durationSeconds to avoid clicks, connect(...).connect(this.output)
    };
};
```

Register it in `ribbit.js`'s `SYNTH_TYPES` map (`import { RibbitMySynth } from
"./synths/mysynth"; ... { mysynth: RibbitMySynth }`) — the only other required
change. That alone makes `/add_track synth=mysynth` and
`/track_1 synth=mysynth` work.

Leave `this.events` empty in the constructor — a fresh instance being silent
until `add_event` is called is expected, not a bug to work around. If `pitch`
means "MIDI note" for your synth, resolve `event.degree` via `this.harmony`
(set automatically by the base class) as shown above so it benefits from any
future key/scale-changing command; skip this if `pitch` means something else
(e.g. a sample-slot index, like `RibbitSampler`). Optional: populate
`this.params` with `RibbitParam`s (`param.js`) for runtime-adjustable synth
params, the same way a processor does (see `docs/llm/building-processors.md`)
— `channelCommand` routes a track's synth's `params` (and `options`, below)
through the track's own name automatically, so `/mytrack cutoff=800 2b`
works with no `commands.js` change, and they're valid `/patch` destinations
too (`dest=mytrack.cutoff`, via `_resolveDest`'s `channel.source.params`
fallback). `synths/percsampler.js`, `synths/karplus.js` and `synths/granular.js` are the
worked examples. A synth param can be ramped, deferred with `at=`, set,
`/recall`ed, `automate=`d and patched — but **read it with `getModulated()`,
not `get()`**, in `trigger()`. `get()` returns the intrinsic value and cannot
see a patch; `getModulated()` taps the summed signal. Since it's read once
per note, a patch moves the param note by note rather than continuously — a
fine gesture, just not a smooth sweep. Note a synth param needs a real
`AudioParam` behind it; if the value has no node of its own, use
`RibbitParamSources` (`param.js`):

```js
this._paramSources = new RibbitParamSources(audioContext);
this.params = { cutoff: this._paramSources.create(cutoff, { min: 20, max: 20000 }) };
dispose() { this._paramSources.dispose(); }
```

Always declare `min`/`max`. Besides clamping, a range finite at both ends is
what makes the param randomizable (`/lead cutoff=random`, and inclusion in the
bulk `/lead random`); an unbounded param drops out of both.

It handles the Web Audio quirk that makes a bare `ConstantSourceNode`
unreliable (a node with no path into the rendered graph can have its
`setValueAtTime` automation silently never reflected in later `.value` reads,
so each source must be routed through a muted sink into
`audioContext.destination`). The `dispose()` call is required — those sinks
aren't reachable from `this.output`.

For a runtime setting *not* backed by any `AudioParam` (like `waveform`
above), declare it in `this.options` instead — `{ key: { get(), set(value),
choices? } }`. Choose param vs. option by asking whether *sweeping* the value
is musical, not whether it needs scheduling: options can't be ramped, but
they can still be deferred with `at=beat`/`at=cycle` like any other command.

```js
this.options = {
    waveform: {
        get: () => this.waveform,
        set: (value) => { this.waveform = value; },
        choices: ["sine", "square", "sawtooth", "triangle"],
    },
};
```

That one declaration makes `/mytrack waveform=square` work (validated
against `choices`, which also drive ghost-text completion; ramp specs
rejected), lists it in `help`, and round-trips it through
`/save_session`/`/recall` — the base `getOptions()` derives from this map
(same keys your constructor accepts back), so don't override it.

If your synth builds anything *persistent* beyond `trigger()`'s usual
one-shot nodes (an always-running `BufferSourceNode`/`ConstantSourceNode` —
an idle noise floor, a free-running oscillator), implement `dispose()` to
stop it — `Ribbit.removeTrack`/`setTrackSynth` call it duck-typed (like
`RibbitRandomNotes.dispose()` already does for modulators), so it only needs
implementing when there's actually something to tear down. `percsampler` and
`karplus` both implement it, in each case only to tear down their
`RibbitParamSources` sinks (a one-liner).

Optional: implement `describeState()` returning a short string, and the
console appends it to the object's one-line summary — `paramObjectSummary`
for a processor/modulator, `channelSummary` (via `channel.source`) for a
synth. It's for state that is neither a param nor an option:
`RibbitMarkovPercs` prints its generated pattern, `RibbitGranular` its source
recording, length and gain match — the latter because a randomly-chosen
source is otherwise invisible from the console.

If your synth loads external assets, use **`samples.js`**
(`fetchSampleManifest`/`resolvedSampleManifest`/`sampleName`/`sampleUrl`)
rather than fetching yourself — `RibbitPercSampler` and `RibbitGranular` both
go through it, and it carries the two-level cache (promise + resolved, the
latter so a live re-roll is synchronous and the console echo is honest) plus
a URL builder that doesn't over-escape path segments. Host contract:
`GET /samples/manifest.json` → `{ <folder>: ["<folder>/a.wav", ...] }`; the
four percussion categories are always present, every other folder is free-form.
`RibbitPatternVariator` follows the identical shape for `/patterns/manifest.json`
via `pattern.js` — keep any third one the same, since a host author should
learn one rule. Degrade to a `console.warn` and a silent instrument, never a
throw out of a constructor; a trigger before loading finishes no-ops.

Two conventions for a synth that picks its file at random: an option's
`get()` reports the **resolved** path (never `random`, or a session wouldn't
reproduce), and the file is **gain-matched on load** — an unmastered library
spans tens of dB, so without it every re-roll invalidates the mix.
`RibbitGranular._measure` peak-normalizes, capped at 20x.

**Polyphony and buffer synthesis.** `synths/karplus.js` and
`synths/granular.js` are the polyphonic ones (a chord is just several
overlapping one-shot `BufferSource`s — no voice allocator to run out);
`granular` is also the example for a synth that schedules *many* nodes per
note: a grain cloud emitted a lookahead window at a time from the clock's
`onSchedule` hook (every synth is a clock unit) rather than built inside
`trigger()`, which blocked the main thread ~6ms a note and dragged the
transport. Share anything common across a note's nodes on one node, quantize
random per-node values so the nodes can be shared too, and thin rather than
truncate when over budget — bounding concurrency, not just the total.
`karplus` and `chaossynth`
*synthesize into an `AudioBuffer`*
with a JS loop rather than building a node graph. Copy that approach when a
node graph can't express the algorithm: the specific reason in `karplus` is that
Web Audio forces any feedback cycle containing a `DelayNode` to at least one
render quantum (128 samples) of delay, capping a node-graph Karplus-Strong around
375Hz. Rendering directly is exact at any pitch and — importantly — needs no
`AudioWorklet` module for the host to serve, which would be a new kind of host
obligation (the engine only ever asks for JSON manifests). Cost is well under a
millisecond per note; don't cache the result unless the algorithm is
deterministic, since a cache makes every repeat of a note bit-identical.

`chaossynth` is the same technique pushed further, and the file to read when
the algorithm is genuinely per-sample DSP rather than one loop. Three things
it demonstrates:

- **Two rates in one loop.** The audible path (oscillator → saturator →
  filter) runs per sample; the expensive control path (an RMS envelope
  follower, a log, an exp, into the filter cutoff) runs every 64 samples with
  its coefficient interpolated across the block. That split is what makes the
  note affordable — and it happens to match the `@hopsize 64` of the Max
  object being recreated, so it's faithful rather than a shortcut.
- **Divergence handling.** A feedback loop that produces one NaN poisons every
  sample after it, and a buffer of NaN is silence plus a click, not a warning.
  Check for non-finite state at each control block and reset the voice.
- **Choosing a filter for the modulation rate you actually have.** A biquad
  recomputing coefficients every 64 samples can go unstable; a Chamberlin
  state-variable filter doesn't. Substituting one for a Max object is fine —
  say so in a comment rather than implying an exact port.

`czsynth` is the third, and the one to read for two patterns neither of the
others has:

- **A preset library, when the state is too big to type.** A CZ tone is three
  eight-stage envelopes per line — about ninety numbers — so the tone lives in
  a plain data module (`synths/cz-tones.js`, no host contract) selected by a
  `preset` option, and every `param` is a *modifier over* it rather than an
  absolute. The trick that makes the two layers independent: every **other**
  option accepts the sentinel `"preset"`, meaning "whatever the tone says". So
  selecting a tone never clobbers an override and an override never needs
  re-applying, and neither layer writes to the other. Copy that before
  inventing a scheme where an option's setter reaches into `params`.
- **An option whose values look numeric can still use `choices`.**
  `applyOptions` compares stringified, so a declared `"1"`/`"-1"` matches a
  typed `1`/`-1` (the console coerces numeric-looking tokens to Numbers on the
  way in). Declare `choices` *and* keep validating in `set()` — the setter is
  the path a session file and a direct host call take, and it's where the value
  gets normalized back to a string (`tapepad`'s `voices`/`bits`, `czsynth`'s
  `lines`/`octave`).

If the cost is more than a millisecond per note, **measure it and write the
number down** (`chaossynth`: ~5.6ms per 2-second note) and cap the render
length with a named constant, so a slow tempo and a long note can't allocate
an unbounded buffer.

Removing a type again later: `docs/llm/removing-types.md`.

## When the DSP needs an AudioWorklet

Per-sample feedback, a nonlinearity inside a loop, or state that must keep
running (a sustaining voice, a freeze, a looper) can't be a node graph — use
the worklet bases in `src/dsp/` (`RibbitWorkletSynth`,
`RibbitWorkletProcessor`, `RibbitWorkletModulator`) with a param table and a
**self-contained** processor factory. `docs/dev/worklets.md` is the guide;
the AE machine's 36 types are the examples (`fmperc` is the smallest voice,
`cascade` a small effect, `modlfo` a small modulator).
