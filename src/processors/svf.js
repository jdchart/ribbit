import { RibbitProcessor } from "../processor.js";
import { RibbitParam } from "../param.js";

// The four responses one state-variable filter can be read out as. Named the
// way the Web Audio node names them (rather than "lp"/"hp") so the option
// value and `BiquadFilterNode.type` are the same word — there is no mapping
// table here, and there shouldn't be.
const MODES = ["lowpass", "highpass", "bandpass", "notch"];

// A state-variable filter: one cutoff, one resonance, and a switch for which
// of the four responses comes out — lowpass, highpass, bandpass or notch.
//
// This is the filter the engine didn't have. `tilt` is a broad two-shelf tone
// control for fixing a mix; this is the sound-design one — the thing you sweep
// with an LFO, close down over eight bars, or ring at high resonance. Both
// `cutoff` and `resonance` are real `AudioParam`s on a single node, so unlike
// most multi-node params in here they ramp, defer and take a patch natively,
// with nothing to fan out.
//
// One node, its `type` switched, rather than four filters in parallel with a
// morph between them. A morph would be the more modular answer and is the
// obvious extension — but it costs four biquads on every channel for a control
// almost nobody sweeps, and `mode` still schedules on a boundary
// (`/filt mode=highpass at=cycle`) like any other option, which is how the
// switch is actually used.
//
// `mix` is a true crossfade (see RibbitProcessor.createCrossfade) rather than
// an added wet path: a filter's job is to take something away, and a dry path
// running at unity beside it means the removed band sails through untouched.
// It doubles as parallel filtering — a notch at `mix=0.5` is a gentle scoop
// rather than a hole.
export class RibbitSVF extends RibbitProcessor {
    constructor(audioContext, { name = "svf", mode = "lowpass", cutoff = 1000, resonance = 1, mix = 1 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A state-variable filter: one cutoff and resonance read out as a lowpass, highpass, bandpass or notch.";

        this.filter = audioContext.createBiquadFilter();
        this.filter.type = MODES.includes(mode) ? mode : "lowpass";
        this.filter.frequency.value = cutoff;
        this.filter.Q.value = resonance;

        const { param: mixParam, wetGain } = this.createCrossfade(mix);
        this.input.connect(this.filter).connect(wetGain);

        // Live-mutable on the running node, exactly like RibbitLFO's waveform
        // — switching response mid-note is a click at worst, never a rebuild.
        this.options = {
            mode: {
                get: () => this.filter.type,
                set: (value) => {
                    // `choices` already rejects a bad value from the console
                    // (see commands.js's applyOptions), but a session file's
                    // options block reaches set() directly — and assigning a
                    // nonsense `type` to the node throws a DOMException that
                    // says nothing about which option it came from.
                    if (!MODES.includes(value)) throw new Error(`invalid mode "${value}" — expected ${MODES.join(", ")}`);
                    this.filter.type = value;
                },
                choices: MODES,
            },
        };

        // Console/UI-facing control surface (see commands.js's applyParams).
        // Bounds: cutoff spans the audible band and a little either side (a
        // sweep that stops at 15kHz reads as broken on a bright source);
        // resonance tops out at 30, which self-oscillates in all but name and
        // is loud — a biquad has real gain at cutoff, so a high-resonance
        // sweep is the fastest way to overload a channel, and the limiter on
        // master is the reason that's survivable rather than a design flaw.
        this.params = {
            cutoff: new RibbitParam(this.filter.frequency, { min: 20, max: 18000 }),
            resonance: new RibbitParam(this.filter.Q, { min: 0.1, max: 30 }),
            mix: mixParam,
        };
    };

    // Thin aliases onto the params' own AudioParams (not second
    // implementations), so both can also be used directly as
    // RibbitAutomationEvent targets.
    get cutoff() {
        return this.params.cutoff.audioParam;
    };

    get resonance() {
        return this.params.resonance.audioParam;
    };
};
