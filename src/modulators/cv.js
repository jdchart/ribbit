import { RibbitModulator } from "../modulator.js";
import { RibbitParam } from "../param.js";

// A generic control-voltage source: no waveform, no periodicity — just a
// held value you set/ramp/automate, the modular-synthesis equivalent of a
// manual offset knob or a sample-and-hold's output. Patch it into any
// AudioParam (see patch.js) the same way an LFO or randomnotes would;
// unlike RibbitLFO's oscillator, nothing here moves on its own — every change
// is something the console/UI explicitly asked for (an instant set, a
// ramp via a trailing duration, or a pattern via automate=), which is what
// makes it read as "CV" rather than "yet another LFO".
export class RibbitCV extends RibbitModulator {
    constructor(audioContext, { name = "cv", value = 0 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A generic control-voltage source: a held value (no waveform/rate) you set, ramp, or automate, for patching into any parameter — the modular equivalent of a manual offset or sample-and-hold.";

        this.source = audioContext.createConstantSource();
        this.source.offset.value = value;
        this.source.connect(this.output);
        this.source.start();

        // Console/UI-facing control surface (see commands.js's applyParams).
        // Deliberately unbounded, like a patch's own depth — real control
        // voltage has no fixed range, so clamping it here would just be an
        // arbitrary limit on what it can be patched to do.
        this.params = {
            value: new RibbitParam(this.source.offset),
        };
    };

    // Thin alias onto params.value's own AudioParam (not a second
    // implementation), so value can also be used directly as an
    // RibbitAutomationEvent target, e.g. cv1.value in a pattern-automation call.
    get value() {
        return this.params.value.audioParam;
    };
};
