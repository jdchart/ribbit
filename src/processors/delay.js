import { RibbitProcessor } from "../processor.js";
import { RibbitParam, RibbitParamSources } from "../param.js";

// A stereo ping-pong delay: independent left/right delay lines whose feedback
// crosses to the *opposite* channel (L's tail feeds R's delay line and vice
// versa) rather than back into itself, plus a small time offset on the right
// channel for stereo width. Dry signal always passes straight through.
export class RibbitDelay extends RibbitProcessor {
    constructor(audioContext, { name = "delay", time = 0.375, feedback = 0.35, wet = 0.3, stereoOffset = 0.06 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A stereo delay: independent left/right delay lines with cross-feedback (ping-pong) and a small time offset between channels for width.";

        // Runtime-settable — /delay stereoOffset=0.02 widens the two lines
        // apart without touching the base time. Round-tripped via the base
        // getOptions(). The value lives on its own ConstantSourceNode summed
        // into the R line's delayTime (see below), so it and `time` add in
        // the graph rather than one having to re-derive the other.
        this.options = {
            stereoOffset: {
                get: () => this._offset.get(),
                set: (value) => {
                    const num = Number(value);
                    if (!Number.isFinite(num) || num < 0 || num > 1) throw new Error(`invalid stereoOffset "${value}" — seconds, 0..1`);
                    this._offset.set(num);
                },
            },
        };

        const splitter = audioContext.createChannelSplitter(2);
        const merger = audioContext.createChannelMerger(2);

        this.delayL = audioContext.createDelay(5);
        this.delayR = audioContext.createDelay(5);

        this.feedbackL = audioContext.createGain();
        this.feedbackR = audioContext.createGain();

        // time and feedback each drive two nodes, and both intrinsic values
        // therefore start at zero: every change arrives as a *summed
        // connection* from one ConstantSourceNode, the technique tilt.js and
        // RibbitProcessor.createCrossfade already use. This is what these two
        // used to do with RibbitParam's onSet, which only overrides the
        // instant-set path — so a ramp animated the L line while the R line
        // stayed put, and the two channels drifted apart for the length of
        // every glide. Now one param moves both, through sets, ramps,
        // deferred at= scheduling and /patch alike.
        this.delayL.delayTime.value = 0;
        this.delayR.delayTime.value = 0;
        this.feedbackL.gain.value = 0;
        this.feedbackR.gain.value = 0;

        this._paramSources ??= new RibbitParamSources(audioContext);
        const timeParam = this._paramSources.create(time, { min: 0, max: 5 });
        const feedbackParam = this._paramSources.create(feedback, { min: 0, max: 0.95 });
        // Not exposed as a param (it's the stereoOffset option's backing
        // store), just a second constant summing onto the R line so width and
        // base time stay independent numbers in the graph.
        this._offset = this._paramSources.create(stereoOffset, { min: 0, max: 1 });

        timeParam.sourceNode.connect(this.delayL.delayTime);
        timeParam.sourceNode.connect(this.delayR.delayTime);
        this._offset.sourceNode.connect(this.delayR.delayTime);
        feedbackParam.sourceNode.connect(this.feedbackL.gain);
        feedbackParam.sourceNode.connect(this.feedbackR.gain);

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
        // Bounds: time's max matches createDelay(5) above (the node itself
        // clamps past that, and stereoOffset can push the R line to it);
        // feedback stays below unity because the two cross-feeding delay
        // lines otherwise recirculate a growing signal forever (a runaway
        // feedback loop, not an effect); wet allows up to a 2x boost but not
        // an unbounded one.
        this.params = {
            time: timeParam,
            feedback: feedbackParam,
            wet: new RibbitParam(this.wetGain.gain, { min: 0, max: 2 }),
        };
    };

    // Kept as a plain property for anything reading it directly; the value
    // itself lives on the ConstantSourceNode above.
    get stereoOffset() {
        return this._offset.get();
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
