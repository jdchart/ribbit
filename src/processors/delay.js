import { RibbitProcessor } from "../processor.js";
import { RibbitParam } from "../param.js";

// A stereo ping-pong delay: independent left/right delay lines whose feedback
// crosses to the *opposite* channel (L's tail feeds R's delay line and vice
// versa) rather than back into itself, plus a small time offset on the right
// channel for stereo width. Dry signal always passes straight through.
export class RibbitDelay extends RibbitProcessor {
    constructor(audioContext, { name = "delay", time = 0.375, feedback = 0.35, wet = 0.3, stereoOffset = 0.06 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A stereo delay: independent left/right delay lines with cross-feedback (ping-pong) and a small time offset between channels for width.";

        this.stereoOffset = stereoOffset;

        // Runtime-settable — /delay stereoOffset=0.02 re-derives the R
        // side's delay time from the current base time. Round-tripped via
        // the base getOptions().
        this.options = {
            stereoOffset: {
                get: () => this.stereoOffset,
                set: (value) => {
                    const num = Number(value);
                    if (!Number.isFinite(num) || num < 0 || num > 1) throw new Error(`invalid stereoOffset "${value}" — seconds, 0..1`);
                    this.stereoOffset = num;
                    this.delayR.delayTime.value = this.delayL.delayTime.value + num;
                },
            },
        };

        const splitter = audioContext.createChannelSplitter(2);
        const merger = audioContext.createChannelMerger(2);

        this.delayL = audioContext.createDelay(5);
        this.delayR = audioContext.createDelay(5);
        this.delayL.delayTime.value = time;
        this.delayR.delayTime.value = time + stereoOffset;

        this.feedbackL = audioContext.createGain();
        this.feedbackR = audioContext.createGain();
        this.feedbackL.gain.value = feedback;
        this.feedbackR.gain.value = feedback;

        this.wetGain = audioContext.createGain();
        this.wetGain.gain.value = wet;

        // dry passthrough
        this.input.connect(this.output);

        this.input.connect(splitter);
        splitter.connect(this.delayL, 0);
        splitter.connect(this.delayR, 1);

        // cross-feedback: L feeds back into R's delay line and vice versa, for a ping-pong bounce
        this.delayL.connect(this.feedbackL);
        this.feedbackL.connect(this.delayR);
        this.delayR.connect(this.feedbackR);
        this.feedbackR.connect(this.delayL);

        this.delayL.connect(merger, 0, 0);
        this.delayR.connect(merger, 0, 1);

        merger.connect(this.wetGain);
        this.wetGain.connect(this.output);

        // Console/UI-facing control surface (see commands.js's applyParams).
        // time/feedback each drive two nodes (the R side, offset for time),
        // so they use onSet to fan the instant-set path out correctly; the
        // "primary" AudioParam (L side) is still what ramping/deferred at=
        // scheduling animates directly — see RibbitParam.
        // Bounds: time's max matches createDelay(5) above (the node itself
        // clamps past that); feedback stays below unity because the two
        // cross-feeding delay lines otherwise recirculate a growing signal
        // forever (a runaway feedback loop, not an effect); wet allows up to
        // a 2x boost but not an unbounded one.
        this.params = {
            time: new RibbitParam(this.delayL.delayTime, {
                min: 0,
                max: 5,
                onSet: (value) => {
                    this.delayL.delayTime.value = value;
                    this.delayR.delayTime.value = value + this.stereoOffset;
                },
            }),
            feedback: new RibbitParam(this.feedbackL.gain, {
                min: 0,
                max: 0.95,
                onSet: (value) => {
                    this.feedbackL.gain.value = value;
                    this.feedbackR.gain.value = value;
                },
            }),
            wet: new RibbitParam(this.wetGain.gain, { min: 0, max: 2 }),
        };
    };

    // Thin aliases onto params.*'s own AudioParams (not second
    // implementations) so these can also be used directly as
    // RibbitAutomationEvent targets, e.g. delay.wet in a pattern-automation call.
    get time() {
        return this.params.time.audioParam;
    };

    get feedback() {
        return this.params.feedback.audioParam;
    };

    get wet() {
        return this.params.wet.audioParam;
    };
};
