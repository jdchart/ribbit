import { RibbitProcessor } from "../processor.js";
import { RibbitParam } from "../param.js";

// Generates a synthetic impulse response: exponentially-decaying white noise
// per channel (not a recorded space). `decay` is the exponent of the falloff
// curve — higher values decay faster near the start of the buffer.
function buildImpulseResponse(audioContext, duration, decay) {
    const rate = audioContext.sampleRate;
    const length = Math.max(1, Math.floor(rate * duration));
    const impulse = audioContext.createBuffer(2, length, rate);

    for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
        }
    }

    return impulse;
};

// A convolution reverb: the dry signal always passes straight through, in
// parallel with a wet path convolved against a generated impulse response.
export class RibbitReverb extends RibbitProcessor {
    constructor(audioContext, { name = "reverb", duration = 2.5, decay = 3, wet = 0.3 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A simple algorithmic reverb: convolution against a generated impulse response, added on top of the dry signal.";

        this.duration = duration;
        this.decay = decay;

        this.convolver = audioContext.createConvolver();
        this.convolver.buffer = buildImpulseResponse(audioContext, duration, decay);

        // Not params (there's no live AudioParam behind an impulse response)
        // but runtime-settable as options — /reverb duration=4 regenerates
        // the IR in place. Swapping a ConvolverNode's buffer mid-signal is
        // audible as a brief tail discontinuity; acceptable for a live
        // tweak, and the only way to change a convolution's character at
        // all. Round-tripped via the base getOptions().
        const rebuild = () => {
            this.convolver.buffer = buildImpulseResponse(this.audioContext, this.duration, this.decay);
        };
        this.options = {
            duration: {
                get: () => this.duration,
                set: (value) => {
                    const num = Number(value);
                    if (!Number.isFinite(num) || num <= 0 || num > 20) throw new Error(`invalid duration "${value}" — seconds, 0..20`);
                    this.duration = num;
                    rebuild();
                },
            },
            decay: {
                get: () => this.decay,
                set: (value) => {
                    const num = Number(value);
                    if (!Number.isFinite(num) || num <= 0) throw new Error(`invalid decay "${value}" — a positive exponent`);
                    this.decay = num;
                    rebuild();
                },
            },
        };

        this.wetGain = audioContext.createGain();
        this.wetGain.gain.value = wet;

        // dry passthrough, in parallel with the wet (convolved) path
        this.input.connect(this.output);
        this.input.connect(this.convolver);
        this.convolver.connect(this.wetGain);
        this.wetGain.connect(this.output);

        // Console/UI-facing control surface (see commands.js's applyParams).
        // wet allows up to a 2x boost but not an unbounded one.
        this.params = {
            wet: new RibbitParam(this.wetGain.gain, { min: 0, max: 2 }),
        };
    };

    // Thin alias onto params.wet's own AudioParam (not a second
    // implementation) so `wet` can also be used directly as an
    // RibbitAutomationEvent target, e.g. reverb.wet in a pattern-automation call.
    get wet() {
        return this.params.wet.audioParam;
    };
};
