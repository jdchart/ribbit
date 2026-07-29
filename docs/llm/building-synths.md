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
fallback). `synths/percsampler.js` is the worked example — it declares
`dynamics`/`pan_spread`/`speed_spread`. Note a synth param needs a real
`AudioParam` behind it; if the value has no node of its own, use
`RibbitParamSources` (`param.js`):

```js
this._paramSources = new RibbitParamSources(audioContext);
this.params = { cutoff: this._paramSources.create(cutoff, { min: 20, max: 20000 }) };
dispose() { this._paramSources.dispose(); }
```

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
implementing when there's actually something to tear down. Neither built-in
synth does, so there's no in-tree example to copy from; `randomnotes` is the
nearest one.

Optional: implement `describeState()` returning a short string, and
`commands.js`'s `paramObjectSummary` will append it to the object's one-line
summary. It's for state that is neither a param nor an option —
`RibbitMarkovPercs` uses it to print its generated pattern, since its options
only describe how that pattern was *derived*.

If your synth loads external assets, note the host contract precedent:
`RibbitPercSampler` fetches a manifest (`/samples/manifest.json`, overridable
per instance) because a browser can't list a directory, and degrades to an
empty kit plus a `console.warn` rather than throwing out of a constructor.

Removing a type again later: `docs/llm/removing-types.md`.
