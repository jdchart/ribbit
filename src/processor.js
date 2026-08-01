import { RibbitParamSources } from "./param.js";

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

    // Builds a *true* dry/wet crossfade — dry = 1 - mix — and returns
    // `{ param, dryGain, wetGain }` with the dry side already wired
    // (input → dryGain → output) and both sides summing into `output`. The
    // caller wires its own wet chain into `wetGain`.
    //
    // This is deliberately NOT what reverb/delay do. Those keep dry at unity
    // and *add* a wet path, which is right for an effect you're layering on
    // top of a signal. It's wrong for anything whose job is to control the
    // signal itself: a compressor whose dry path still runs at unity can
    // never actually tame a peak, because the untouched peak sails through
    // beside it. A crossfade also gives parallel processing for free — mix
    // at 0.5 is New York compression.
    //
    // The implementation is the reason this lives on the base class rather
    // than being open-coded per processor. One value has to drive two gains
    // in opposite directions, and the obvious tool (RibbitParam's onSet) only
    // overrides the *instant-set* path — a ramp would animate the wet side
    // and strand the dry side at its last value, which is exactly the
    // multi-node limitation RibbitDelay's time/feedback still carry. So the
    // param is instead a ConstantSourceNode's offset (via RibbitParamSources,
    // which also handles the silent-sink quirk that makes its scheduled
    // automation readable back) connected into both gains, once directly and
    // once through a -1 inverter. AudioParam connections *sum* onto the
    // intrinsic value, so dryGain's intrinsic 1 minus mix and wetGain's
    // intrinsic 0 plus mix track a single param exactly — through instant
    // sets, ramps, deferred at= scheduling and /patch alike.
    createCrossfade(mix = 1, { min = 0, max = 1 } = {}) {
        this._paramSources ??= new RibbitParamSources(this.audioContext);
        const param = this._paramSources.create(mix, { min, max });

        const dryGain = this.audioContext.createGain();
        const wetGain = this.audioContext.createGain();
        dryGain.gain.value = 1; // intrinsic; the inverted connection subtracts mix
        wetGain.gain.value = 0; // intrinsic; the direct connection adds mix

        const inverter = this.audioContext.createGain();
        inverter.gain.value = -1;
        param.sourceNode.connect(wetGain.gain);
        param.sourceNode.connect(inverter).connect(dryGain.gain);

        this.input.connect(dryGain).connect(this.output);
        wetGain.connect(this.output);

        return { param, dryGain, wetGain };
    };

    // Duck-typed teardown, called by Ribbit.removeProcessor and
    // Ribbit.dispose — the same hook a synth or modulator already gets. It
    // matters for the same reason theirs does: createCrossfade's
    // ConstantSourceNode is a *running* source reaching audioContext
    // .destination through its own muted sink, so it isn't reachable from
    // this.output and a blanket disconnect() there never touches it. A
    // subclass with children of its own (RibbitGoodenizer) overrides this and
    // calls super.
    dispose() {
        this._paramSources?.dispose();
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
