// Base class for every effect (see reverb.js, delay.js). A processor sits
// continuously in a channel's insert chain, wiring real DSP nodes between the
// inherited `this.input`/`this.output`. Unlike a synth, there's no per-event
// trigger — subclasses build their node graph once, in the constructor.
export class RibbitProcessor {
    constructor(audioContext, { name = "processor" } = {}) {
        this.llm_summary = "The basic processor class.";
        this.name = name;

        this.audioContext = audioContext;
        this.input = audioContext.createGain();
        this.output = audioContext.createGain();

        // Whether the containing Channel routes signal through this processor
        // at all (a true bypass, handled by Channel._rewireChain), not a param.
        this.active = true;

        // Generic command-line introspection surface: { paramName: { get(), set(value) } }.
        // Distinct from raw AudioParam getters (e.g. .wet) used as automation targets.
        this.params = {};
        this.automation = [];

        // Non-rampable runtime settings — see RibbitSynth.options for the
        // shape ({ get(), set(value), choices? } per key) and everything a
        // single declaration here buys (console set, help, completion,
        // session round-trip via getOptions below).
        this.options = {};
    };

    addAutomation(event) {
        this.automation.push(event);
        return event;
    };

    // Direct-connects this processor's output to another node. Channels don't
    // normally call this themselves (RibbitChannel._rewireChain wires processors
    // into the chain directly) — it exists for standalone/manual wiring.
    connect(destination) {
        this.output.connect(destination.input ?? destination);
        return destination;
    };

    // Derived from the `options` map above — see RibbitSynth.getOptions; same
    // idea, used by session.js when serializing a channel's inserts.
    getOptions() {
        const out = {};
        for (const [key, option] of Object.entries(this.options)) out[key] = option.get();
        return out;
    };
};
