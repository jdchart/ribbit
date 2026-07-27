import { RibbitModulator } from "../modulator.js";
import { RibbitParam } from "../param.js";

// A low-frequency oscillator: a continuously-running OscillatorNode whose raw
// output is a bipolar [-1, 1] control signal at `freq` Hz — the modular
// synthesis equivalent of a patch cable's source. It has no depth or offset
// of its own; patch it into any AudioParam (see patch.js) to wobble that
// param's existing value, with the *amount* of wobble controlled per-patch
// (so the same LFO can drive several destinations at different depths).
export class RibbitLFO extends RibbitModulator {
    constructor(audioContext, { name = "lfo", freq = 1, waveform = "sine" } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A low-frequency oscillator: a continuous bipolar (-1..1) control signal at a given rate, for patching into any parameter.";

        this.waveform = waveform;

        this.osc = audioContext.createOscillator();
        this.osc.type = waveform;
        this.osc.frequency.value = freq;
        this.osc.connect(this.output);
        this.osc.start();

        // Not a param (no AudioParam behind a waveform choice) but still
        // runtime-settable — OscillatorNode.type is live-mutable, so
        // /lfo1 waveform=square switches the running oscillator in place.
        this.options = {
            waveform: {
                get: () => this.waveform,
                set: (value) => {
                    this.waveform = value;
                    this.osc.type = value;
                },
                choices: ["sine", "square", "sawtooth", "triangle"],
            },
        };

        // Console/UI-facing control surface (see commands.js's applyParams).
        // Deliberately allowed well past "low frequency" — patching an LFO
        // running at audio rate into a param is classic FM territory — but
        // still bounded to the audible ballpark rather than unbounded.
        this.params = {
            freq: new RibbitParam(this.osc.frequency, { min: 0, max: 20000 }),
        };
    };

    // Thin alias onto params.freq's own AudioParam (not a second
    // implementation), so freq can also be used directly as an
    // RibbitAutomationEvent target or a patch destination's raw param.
    get freq() {
        return this.params.freq.audioParam;
    };
};
