// Base class for every modulation source (see lfo.js). A modulator is a
// named, addressable object registered with Ribbit the same way a synth or
// processor is — it can be created, addressed by name from the console, and
// removed — but unlike a synth it never attaches to a track's chain; it
// exists purely to be patched (see patch.js) into some other object's
// parameter. Subclasses build their own continuously-running Web Audio graph
// in the constructor (there's no per-event trigger) and expose their raw
// output via `this.output` — by convention a bipolar signal roughly in
// [-1, 1], since a patch's own depth (see patch.js) — not the modulator —
// decides how hard that signal pushes any given destination.
export class RibbitModulator {
    constructor(audioContext, { name = "modulator" } = {}) {
        this.llm_summary = "The basic modulator class.";
        this.name = name;

        this.audioContext = audioContext;
        this.output = audioContext.createGain();

        // Generic command-line introspection surface, same shape as
        // RibbitProcessor.params: { paramName: { get(), set(value) } }.
        this.params = {};

        // Non-rampable runtime settings — see RibbitSynth.options for the
        // shape and what one declaration here buys.
        this.options = {};

        // Every channel this modulator currently delivers generated events to
        // — pushed/spliced by RibbitEventPatch, read by the clock and by
        // _stride() below. Declared here rather than in each event-generating
        // subclass because it isn't optional for them: patch.js and
        // Ribbit._createEventPatch both index into it directly, so a generator
        // that forgot to initialize it fails at patch time with a bare
        // "cannot read properties of undefined" rather than anything that
        // points at the omission. A continuous modulator (lfo, cv) simply
        // leaves it empty — one uniform contract beats a conditional one.
        this.eventDestinations = [];

        // Loop-position pattern automation on this modulator's own params
        // (e.g. an LFO's freq sweeping over the loop) — same array shape
        // every channel/processor unit already has; the clock schedules it
        // identically (see clock.js). Populated by the console's automate=
        // command (commands.js).
        this.automation = [];
    };

    addAutomation(event) {
        this.automation.push(event);
        return event;
    };

    // How many sample slots one drum category occupies on the thing being
    // driven — the shared contract that lets any percussion generator
    // (markovpercs, euclidpercs, patternvariator) drive the same kit
    // interchangeably, and lets a pattern written against a 4-per-category kit
    // stay musically identical when the kit is rebuilt with 1 or 8.
    //
    // Asks the destination first (RibbitPercSampler publishes
    // `slotsPerCategory`) and falls back to the subclass's own `per_category`
    // option when there's nothing to ask — the same duck-typed-optional-hook
    // idiom the clock uses for generateEvents/onClockStart, and the reason a
    // generator patched into a plain `sampler` still produces something
    // sensible. Lives here rather than in each generator because it describes
    // the *destination*, not the generation strategy; only event-generating
    // subclasses (the ones with eventDestinations and a perCategory) call it.
    _stride() {
        for (const destination of this.eventDestinations ?? []) {
            const published = destination.source?.slotsPerCategory;
            if (Number.isFinite(published) && published >= 1) return published;
        }
        return this.perCategory;
    };

    // Derived from the `options` map above — see RibbitSynth.getOptions; same
    // idea, used by session.js.
    getOptions() {
        const out = {};
        for (const [key, option] of Object.entries(this.options)) out[key] = option.get();
        return out;
    };
};

// Marks an option as naming other objects, so a host can draw it as a
// cable rather than leave it as text in a field (lilypad does). `direction`
// is which way the relation runs: "in" when the named object drives this one
// (randomnotes' trigger=, loudness' source=), "out" when this one acts on
// the named objects (a jumper's targets=). `multiple` for a comma list.
// Returns the option, so it wraps a declaration in place.
export function refOption(option, { direction, multiple = false }) {
    return { ...option, ref: { direction, multiple } };
};

// When `object` last *fired*, or null: the time (and velocity, when it knows
// one) of its latest event. A generator or analyser stamps its own
// (lastEventTime/lastVelocity — a delivered note, a midiin key, a loudness
// onset); a track's is its synth's, stamped by the clock on every note it
// plays. This one reading is what every "follow that object" option shares —
// randomnotes' trigger=, the worklet modulators' strike= — so anything that
// fires can drive anything that listens, with no cable type between them.
export function firingOf(object) {
    const time = object?.lastEventTime ?? object?.source?.lastEventTime;
    if (!Number.isFinite(time)) return null;
    return { time, velocity: object.lastVelocity ?? object.source?.lastVelocity ?? 1 };
};
