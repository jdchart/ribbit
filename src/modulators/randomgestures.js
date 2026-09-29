import { RibbitModulator, refOption } from "../modulator.js";
import { RibbitParamSources, addressableParams } from "../param.js";
import { scheduleRamp } from "../automation.js";
import { mulberry32, randomSeed } from "../random.js";

const SCOPES = ["all", "tracks", "buses", "processors", "modulators", "master"];

// Turns a comma-separated console value ("lead,pad", the only list form a
// value token can carry) into a list of trimmed names. Empty means "no
// restriction", which is why "" is a meaningful value for both list options.
function nameList(value) {
    return String(value ?? "").split(",").map((name) => name.trim()).filter(Boolean);
};

// A modulator that plays the session itself: every so often it picks a
// parameter somewhere in the graph and glides it somewhere new.
//
// **It is the first modulator that isn't patched into anything.** Every other
// one publishes something — a bipolar signal on `.output`, or note events —
// and a `/patch` decides where that lands. This one has no output at all: it
// reaches into `ribbit` (handed to it at construction, the way a synth is
// handed the harmony context), enumerates what is currently modulatable, and
// ramps a real `AudioParam` directly. What a patch cable gives you is one
// destination chosen by hand; what this gives you is the whole patch, drifting.
//
// **Which params it is allowed to touch is not a new concept.** It draws from
// exactly the set the bulk `/<object> random` command draws from — a param
// with a declared range whose `.r` flag is on (see RibbitParam.canRandomize).
// So a channel's fader is out by default, `/lead cutoff.r=false` takes one
// param off the table for both commands at once, and that exclusion is already
// something a session file round-trips. There is deliberately no second
// opt-out list here.
//
// **Seeded, and therefore repeatable.** seed + the gesture parameters
// determine the whole sequence, and a `/stop /start` replays it from the top
// (see onClockStart) — the same contract markovpercs and patternvariator have.
// The one caveat is that a gesture is a choice *among what currently exists*,
// so adding a track mid-take renumbers everything after it. Reproducing a
// performance means reproducing the session, which is what a session file is.
//
// Gestures are ramps, not jumps: `glide` is how long each one takes, and it
// can be longer than the interval between them, so several params can be in
// motion at once — which is the difference between this sounding like a
// performer and like a randomizer.
export class RibbitRandomGestures extends RibbitModulator {
    constructor(audioContext, {
        name = "randomgestures",
        engine = null,
        seed,
        scope = "all",
        targets = "",
        params = "",
        gesture_beats = 4,
        glide = 2,
        depth = 0.3,
        probability = 1,
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "Roams the live session and glides random parameters to new values — a seeded, self-playing hand on the controls. Needs no patch: it acts on objects directly.";

        this.engine = engine;
        this.scope = SCOPES.includes(scope) ? scope : "all";
        this.targetNames = nameList(targets);
        this.paramNames = nameList(params);
        // Same rule as markovpercs: an unseeded instance resolves to a
        // concrete seed immediately, or getOptions() would have nothing to
        // save and a reload couldn't reproduce the take.
        this.seed = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : randomSeed();

        this._random = mulberry32(this.seed);
        // The next absolute beat a gesture is due on. Advanced by whole
        // `gesture_beats` steps rather than derived from the beat number, so
        // changing the interval mid-take moves the *next* gesture rather than
        // renumbering every past one.
        this._nextBeat = 0;
        this.gestureCount = 0;
        this.lastGesture = null;

        this.options = {
            seed: {
                get: () => this.seed,
                set: (value) => {
                    if (typeof value === "string" && value.trim().toLowerCase() === "random") {
                        this.seed = randomSeed();
                    } else {
                        const parsed = Number(value);
                        if (!Number.isFinite(parsed)) throw new Error(`invalid seed "${value}" — expected a number or "random"`);
                        this.seed = Math.floor(parsed);
                    }
                    this._random = mulberry32(this.seed);
                    this.gestureCount = 0;
                },
            },
            // Which kinds of object are in play. The coarse control; `targets`
            // below is the precise one.
            scope: {
                get: () => this.scope,
                set: (value) => {
                    if (!SCOPES.includes(value)) throw new Error(`invalid scope "${value}" — expected ${SCOPES.join(", ")}`);
                    this.scope = value;
                },
                choices: SCOPES,
            },
            // An explicit comma-separated list of objects, which overrides
            // `scope` entirely when non-empty. A **group name** expands to its
            // members (see group.js), which is the intended way to aim this:
            // /add_group name=drums members=kick,snare,hats then
            // /gest targets=drums keeps the gestures on the kit.
            targets: refOption({
                get: () => this.targetNames.join(","),
                set: (value) => { this.targetNames = nameList(value); },
            }, { direction: "out", multiple: true }),
            // And, orthogonally, which *params* by name — /gest params=cutoff
            // sweeps filters and nothing else. Empty means every eligible
            // param on every object in range.
            params: {
                get: () => this.paramNames.join(","),
                set: (value) => { this.paramNames = nameList(value); },
            },
        };

        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            // Read fresh at each gesture, so all four are live and rampable
            // (and automatable, and patchable) even though what they control
            // is a discrete decision — a `depth` that opens up over a
            // build-up is the obvious use.
            gesture_beats: this._paramSources.create(gesture_beats, { min: 0.25, max: 64 }),
            glide: this._paramSources.create(glide, { min: 0, max: 64 }),
            // How far a single gesture may move a param, as a fraction of
            // that param's own declared range, in either direction from where
            // it currently sits. So this is a bounded random *walk*, not a
            // series of unrelated jumps: at 0.05 it breathes, at 1 any gesture
            // can land anywhere.
            depth: this._paramSources.create(depth, { min: 0, max: 1 }),
            // Rolled per due gesture. Below 1 the gestures stop being
            // metronomic without the interval itself having to change.
            probability: this._paramSources.create(probability, { min: 0, max: 1 }),
        };
    };

    dispose() {
        this._paramSources.dispose();
    };

    // A restart rewinds the beat position to 0, so the gesture sequence
    // rewinds with it — /stop /start replays the same take rather than
    // carrying on from wherever the RNG had got to.
    onClockStart() {
        this._random = mulberry32(this.seed);
        this._nextBeat = 0;
        this.gestureCount = 0;
    };

    // The clock's per-tick hook for a unit that acts on the session rather
    // than emitting events (see clock.js). Fires every gesture due in
    // [fromBeat, toBeat) — the same lookahead window everything else is
    // scheduled in, so a gesture lands on its beat rather than whenever the
    // tick happened to run.
    onSchedule(fromBeat, toBeat, secondsPerBeat, clock) {
        // Created (or resumed) mid-session: don't replay every gesture since
        // beat zero, just start from here.
        if (this._nextBeat < fromBeat) this._nextBeat = fromBeat;

        while (this._nextBeat < toBeat) {
            const interval = Math.max(0.25, this.params.gesture_beats.get());
            const beat = this._nextBeat;
            this._nextBeat += interval;
            if (this._random() >= this.params.probability.get()) continue;
            this._gesture(clock.beatToTime(beat), secondsPerBeat);
        }
    };

    // One gesture: pick an eligible param, draw a new value near its current
    // one, and ramp it there.
    _gesture(time, secondsPerBeat) {
        const candidates = this._candidates();
        if (candidates.length === 0) return;

        const { objectName, key, param } = candidates[Math.floor(this._random() * candidates.length)];
        const from = param.get();
        const span = param.max - param.min;
        const depth = this.params.depth.get();
        const target = param.clamp(from + (this._random() * 2 - 1) * depth * span);
        const glideBeats = this.params.glide.get();

        scheduleRamp(
            this.audioContext,
            param.audioParam,
            param.audioParam.value,
            param.encode(target),
            glideBeats * secondsPerBeat,
            { startTime: time },
        );

        this.gestureCount += 1;
        this.lastGesture = `${objectName}.${key} ${from.toFixed(3)} -> ${target.toFixed(3)} over ${glideBeats}b`;
        // Same field the clock records on an event generator, so the mixer's
        // modulator strip can flash once per gesture instead of metering an
        // output signal this modulator doesn't have.
        this.lastEventTime = time;
    };

    // Every object currently in range: the `targets` list if there is one
    // (with group names expanded), otherwise everything the `scope` covers.
    _objects() {
        if (!this.engine) return [];
        const engine = this.engine;

        if (this.targetNames.length) {
            const found = [];
            const seen = new Set();
            const expand = (name) => {
                if (seen.has(name)) return; // a group naming itself, or a cycle between two
                seen.add(name);
                const object = engine._resolveObject(name);
                if (object) {
                    found.push(object);
                    return;
                }
                const group = engine._resolveGroup?.(name);
                if (group) for (const member of group.members) expand(member);
            };
            for (const name of this.targetNames) expand(name);
            return found;
        }

        if (this.scope === "tracks") return [...engine.tracks];
        if (this.scope === "buses") return [...engine.buses];
        if (this.scope === "processors") return [...engine.processors];
        if (this.scope === "modulators") return [...engine.modulators];
        if (this.scope === "master") return [engine.master];
        return [engine.master, ...engine.tracks, ...engine.buses, ...engine.processors, ...engine.modulators];
    };

    // Flattened to one list of { objectName, key, param } so a gesture is a
    // single uniform draw — every eligible param in the session is equally
    // likely, rather than an object being picked first (which would make a
    // one-param processor as loud a voice as a nine-param synth).
    _candidates() {
        const candidates = [];
        for (const object of this._objects()) {
            // Never itself: gesturing its own gesture_beats/depth would make
            // the take unreproducible from its seed, and is a loop rather than
            // a gesture.
            if (object === this) continue;
            // addressableParams, not object.params — a track's surface
            // includes its synth's params (the interesting ones), exactly as
            // /<track> random and automate= see them.
            for (const [key, param] of Object.entries(addressableParams(object) ?? {})) {
                if (!param.canRandomize) continue;
                if (this.paramNames.length && !this.paramNames.includes(key)) continue;
                candidates.push({ objectName: object.name, key, param });
            }
        }
        return candidates;
    };

    // Neither the param list nor the option list can show the two things that
    // actually matter here: how much is in range, and what it just did.
    describeState() {
        const count = this._candidates().length;
        const pool = `${count} param${count === 1 ? "" : "s"} in range`;
        return `[${pool}${this.gestureCount ? ` · ${this.gestureCount} gestures · last: ${this.lastGesture}` : " · no gestures yet"}]`;
    };
};
