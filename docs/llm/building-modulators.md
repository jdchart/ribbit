# LLM context: building a modulator

Full tutorial with rationale: `docs/dev/creating-a-modulator.md`. This is the
condensed recipe.

**Read `docs/llm/catalog.md` first** — it lists every existing synth,
processor and modulator with its params and options, and has a "which one to
copy" table. Pick the closest existing modulator from there and read that one
file, rather than trawling `src/`. **And update the catalog** when you're
done: a new type that isn't in it is invisible to the next session.

A modulator extends `RibbitModulator` (`src/modulator.js`),
which provides `this.output` (a `GainNode`). Structurally a processor's
sibling — build a continuously-running Web Audio graph in the constructor
(no `trigger()`, always "on"), connect it into `this.output`, populate
`this.params` as `{ paramName: RibbitParam }` (`param.js`) exactly like a
processor does. The one real difference: a modulator never joins a channel's
insert chain — it exists only to be patched (`/patch source=... dest=...`)
into some other object's parameter, so keep its raw output bipolar
(`-1..1`-ish); depth/centering belong to the *patch*, not the modulator.

```js
// src/modulators/mymod.js — non-base modulators live in
// their own modulators/ subfolder, one level down from the base classes.
import { RibbitModulator } from "../modulator";
import { RibbitParam } from "../param";

export class RibbitMyModulator extends RibbitModulator {
    constructor(audioContext, { name = "mymod", rate = 4 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "One-line description shown in /help.";

        // build a continuously-running node graph, start it immediately,
        // connect its final stage into this.output
        this.osc = audioContext.createOscillator();
        this.osc.frequency.value = rate;
        this.osc.connect(this.output);
        this.osc.start();

        this.params = {
            rate: new RibbitParam(this.osc.frequency),
        };
    };
};
```

Register it in `ribbit.js`'s `MODULATOR_TYPES` map (`import { RibbitMyModulator }
from "./modulators/mymod"; ... { mymod: RibbitMyModulator }`) — the only other
required change. That alone makes `/add_modulator
type=mymod rate=8 name=mod1`, `/mod1 rate=20 3` (ramping), `/mod1 help`, and
`/mod1 remove_self` all work, plus `/patch source=mod1 dest=reverb.wet
depth=0.3` (patching only needs `.output`, so any modulator qualifies as a
source automatically). Removing the modulator cascade-removes any patch that
references it.

For a runtime setting that isn't a param (like `RibbitLFO`'s `waveform`, or
`RibbitRandomNotes`' `scale`), declare it in `this.options` — `{ key: {
get(), set(value), choices? } }`. One declaration makes it console-settable
(`/mod1 waveform=square`, validated against `choices`; ramp specs
rejected), lists it in `help`, and round-trips it through
`/save_session`/`/recall` — the base `getOptions()` derives from the map,
so don't override it. An option can't be *ramped*, but it can still be
*scheduled* (`/mod1 seed=20 at=cycle`) — pick param vs. option by asking
whether sweeping the value is musical, not whether it needs timing.
Real examples in tree: `modulators/cv.js` is the smallest (a
`ConstantSourceNode`, one unbounded param, no options — start here),
`lfo.js` adds an option and a bounded param, and the five generators below
are the event-generating shape.

For a param with no `AudioParam` of its own, use `RibbitParamSources`
(`param.js`) rather than hand-rolling a `ConstantSourceNode` — it handles the
routed-muted-sink requirement and its `dispose()` is what tears the sinks
down:

```js
this._paramSources = new RibbitParamSources(audioContext);
this.params = { swing: this._paramSources.create(swing, { min: 0, max: 0.5 }) };
dispose() { this._paramSources.dispose(); }
```

Declare both bounds: a finite range is also what makes the param randomizable
(`/mod1 swing=random`, and inclusion in the bulk `/mod1 random`). `cv`'s
deliberately unbounded `value` is the one modulator param they skip.

A modulator can instead generate discrete events (notes) rather than a
continuous signal — see `modulators/randomnotes.js` (`RibbitRandomNotes`) for
the pattern: expose `generateEvents(fromBeat, toBeat)` (called by
`RibbitClock` every tick with an absolute, non-loop-relative beat range — see
clock.js) returning whatever `RibbitEvent`s should fire. **`eventDestinations`
is already on the base class — do not declare it yourself** (it used to be
per-subclass; omitting it failed at *patch* time with an unattributable "cannot
read properties of undefined", taking out every `.notes` patch at session
load). If the generator keeps absolute-beat state
(a "next candidate beat" cursor etc.), also implement `onClockStart()`
(duck-typed, called by `RibbitClock.start()`) to reset it — a clock (re)start
rewinds absolute beats to 0. Such a modulator has no meaningful continuous
`.output`; instead it's patched into a track's synth via `/patch
source=<generator> dest=<track>.notes` (the reserved `.notes` destination —
see `ribbit.js`'s `createPatch`/`_createEventPatch` and `patch.js`'s
`RibbitEventPatch`), which is bookkeeping-only (no AudioParam, no `depth`) and
lives alongside — never replaces — a synth's manually-authored `events`.
Several generators may feed the same track (only an exact duplicate
source→dest patch is rejected), which is how a fixed backbone plus a
decorating layer is built.

**A modulator need not publish anything at all.** The third shape (one
instance: `modulators/randomgestures.js`) neither outputs a signal nor
generates events — it acts on the session directly. Two things make that
possible, and both are the pattern to copy: `Ribbit.createModulator` injects
`engine` into every modulator's constructor options (exactly as `createSynth`
injects `harmony`), so it can enumerate what exists; and `RibbitClock` calls
the duck-typed `onSchedule(fromBeat, toBeat, secondsPerBeat, clock)` on every
unit that has one, with the same absolute beat range `generateEvents` gets plus
the clock itself, so scheduled work lands on a beat rather than whenever the
timer fired. Such a modulator is patched nowhere; `paramObjectHelp` detects it
by `onSchedule` and says so instead of offering a patch line. If yours picks
params to touch, filter by `param.canRandomize` (`src/param.js`) rather than
inventing an opt-out list — that's the same set bulk `random` uses, so
`<param>.r=false` already means "leave this alone" and round-trips in a
session.

Five *note* generators exist, and they differ in *what decides whether a note
happens* — worth knowing before adding a sixth, since the useful axis is
usually a new answer to that question rather than a new sound:
`randomnotes` rolls fresh dice per slot (never repeats), `markovpercs` looks
at the previous step (fixed pattern, no notion of bar position),
`euclidpercs` looks at the step's own index (exactly repeatable, can hold a
downbeat), `patternvariator` reads **a file a person wrote** and varies it
(the only one whose material is authored rather than derived — see
`docs/llm/building-patterns.md`), and `chorale` answers "a voice's held note
elapsed" — the only one not making a rhythm, and the only one with no
randomness anywhere in it (no seed, nothing to reproduce: every note is a
pure function of the absolute beat). The step-string gap is closed: the `drums`
pattern kind *is* one, in a file rather than on the command line, since a
16-character grid doesn't survive `splitCommands`.

`chorale` is also the worked example of **deriving state positionally instead
of remembering it**. Voice leading is naturally a "where was this voice last"
problem, which would mean cursor state, an `onClockStart()` reset, and drift
if a lookahead window were ever skipped. Anchoring each voice to a fixed
register and taking the nearest octave of its assigned chord tone gets the
same musical result as a pure function of the beat. Prefer that shape when you
can find it — three of the five generators are stateless for the same reason.

A drum generator should drive `RibbitPercSampler` through its published slot
contract rather than emitting raw slot numbers: store `{ category, variant }`
and resolve `category * stride + variant` at delivery, where `stride` comes
from the destination's `slotsPerCategory` when it publishes one. `_stride()`
is **inherited from `RibbitModulator`** — it describes the destination, not
your generation strategy, so don't reimplement it. That's what lets one
pattern drive a kit with 1 or 8 slots per category, and lets two generators
share one kit.

For seeded randomness, import `mulberry32`/`randomSeed` from `random.js`
rather than writing your own. Reach for `Math.random()` only for things that
deliberately *shouldn't* survive a reload (euclidpercs' live `dropout`) — the
choice of generator is the choice of whether the result is part of the
document.

Optional: implement `describeState()` returning a short string, appended to
the object's one-line console summary by `commands.js`'s
`paramObjectSummary` — for state that's neither a param nor an option (see
`modulators/markovpercs.js`, which prints its pattern as one line;
`euclidpercs.js` prints a multi-line grid, one row per category).

Choosing between a param and an option for a generator is worth a moment's
thought: a value only consulted when the pattern is *regenerated* should be
an option, even if it's numeric, because a ramp on it would look like a
control that does nothing. Reserve params for values read fresh inside
`generateEvents` — `markovpercs` splits exactly this way (`style`/`seed`/
`steps` are options; `velocity`/`swing` are params, and `patternvariator`
splits the same way with `seed`/`variation`/`density`).

Read those params with **`getModulated()`, not `get()`**, inside
`generateEvents` — that's what lets a `/patch` into `velocity`/`swing`/
`dropout` actually reach them (`get()` can't see a patch; see `param.js`).
The value is sampled once per generated event, so a patched LFO shapes the
pattern event by event.

Removing a type again later: `docs/llm/removing-types.md`.
