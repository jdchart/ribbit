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

    // Derived from the `options` map above — see RibbitSynth.getOptions; same
    // idea, used by session.js.
    getOptions() {
        const out = {};
        for (const [key, option] of Object.entries(this.options)) out[key] = option.get();
        return out;
    };
};
