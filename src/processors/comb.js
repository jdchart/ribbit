import { RibbitProcessor } from "../processor.js";
import { RibbitParamSources } from "../param.js";

const MODES = ["feedback", "feedforward"];

// A comb filter: the signal summed with a very short delayed copy of itself,
// which reinforces every frequency whose period divides the delay and cancels
// the ones in between — a rake of peaks and notches at multiples of 1/time.
//
// Two shapes, and the difference is audible rather than academic:
//
//   feedforward   y = x + a·x[n-d]   one delayed copy. Notches. This is the
//                                    body of a flanger — patch an LFO into
//                                    `time` and that's exactly what it is.
//   feedback      y = x + a·y[n-d]   the copy recirculates. Peaks, and the
//                                    thing rings: at short delays it grows a
//                                    pitch of its own, which is the resonator
//                                    /Karplus end of the same idea.
//
// Both are built and left running; `mode` just decides which one reaches the
// wet gain. Switching back and forth doesn't reset the feedback line's tail
// (it decays on its own), and the idle branch costs a delay, a filter and a
// gain — cheaper than rewiring the graph on a live channel.
//
// **The feedback branch has a floor on `time`.** A Web Audio cycle must
// contain a DelayNode, and the spec forces such a delay to at least one render
// quantum — 128 samples, about 2.9ms at 44.1kHz — so the feedback comb cannot
// resonate above roughly 344Hz however low `time` goes. This is the same wall
// `karplus` hit and answered by rendering into a buffer instead, which a live
// insert effect can't do. The feedforward branch is in no loop and has no such
// floor, so it combs the whole range. `describeState()` prints both the
// nominal frequency and the floor, because a `time` below it silently does
// nothing in feedback mode rather than erroring.
export class RibbitComb extends RibbitProcessor {
    constructor(audioContext, { name = "comb", mode = "feedback", time = 0.008, feedback = 0.7, tone = 8000, mix = 1 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A comb filter: the signal plus a very short delayed copy of itself, feedforward (notches, flanger-like) or feedback (peaks, a ringing resonator).";

        this.mode = MODES.includes(mode) ? mode : "feedback";
        // The shortest delay the feedback branch can actually hold (see the
        // class comment), and the frequency that corresponds to.
        this.feedbackFloorSeconds = 128 / audioContext.sampleRate;

        const { param: mixParam, wetGain } = this.createCrossfade(mix);

        // Both branches sum the dry signal with their own delayed copy, so
        // each sum node *is* the comb output — the wet tap is the sum, never
        // the bare delay line. That's what makes the response a comb (peaks
        // and notches around unity) rather than an echo beside the signal.
        const ffSum = audioContext.createGain();
        const fbSum = audioContext.createGain();
        this.delayFF = audioContext.createDelay(0.1);
        this.delayFB = audioContext.createDelay(0.1);
        this.dampFF = audioContext.createBiquadFilter();
        this.dampFB = audioContext.createBiquadFilter();
        this.dampFF.type = "lowpass";
        this.dampFB.type = "lowpass";
        const ffGain = audioContext.createGain();
        const fbGain = audioContext.createGain();

        // The two mode gates. Ramped rather than switched (see _applyMode) —
        // a feedback comb's output is nowhere near zero when you leave it.
        this.ffGate = audioContext.createGain();
        this.fbGate = audioContext.createGain();

        // feedforward: x + a·x[n-d]
        this.input.connect(ffSum);
        this.input.connect(this.delayFF).connect(this.dampFF).connect(ffGain).connect(ffSum);
        ffSum.connect(this.ffGate).connect(wetGain);

        // feedback: x + a·y[n-d], the loop closing back onto the sum
        this.input.connect(fbSum);
        fbSum.connect(this.delayFB).connect(this.dampFB).connect(fbGain).connect(fbSum);
        fbSum.connect(this.fbGate).connect(wetGain);

        // time and feedback each drive two nodes (one per branch), so both
        // ride ConstantSourceNodes summed onto zero-valued intrinsics — the
        // technique tilt.js and createCrossfade use, and the one that keeps a
        // *ramp* moving every node rather than just a "primary" one. This is
        // what makes /comb time=0.0004 8b a usable sweep instead of a
        // branch-dependent one.
        this._paramSources ??= new RibbitParamSources(audioContext);
        const timeParam = this._paramSources.create(time, { min: 0.0002, max: 0.05 });
        const feedbackParam = this._paramSources.create(feedback, { min: -0.95, max: 0.95 });

        this.delayFF.delayTime.value = 0;
        this.delayFB.delayTime.value = 0;
        ffGain.gain.value = 0;
        fbGain.gain.value = 0;
        timeParam.sourceNode.connect(this.delayFF.delayTime);
        timeParam.sourceNode.connect(this.delayFB.delayTime);
        feedbackParam.sourceNode.connect(ffGain.gain);
        feedbackParam.sourceNode.connect(fbGain.gain);

        // One tone control for both branches' delayed copy. In feedback mode
        // it sits inside the loop, so each pass is darker than the last and
        // the tail decays the way a plucked string does; in feedforward mode
        // it just shapes the single copy, which softens the top notches.
        const toneParam = this._paramSources.create(tone, { min: 200, max: 18000 });
        this.dampFF.frequency.value = 0;
        this.dampFB.frequency.value = 0;
        toneParam.sourceNode.connect(this.dampFF.frequency);
        toneParam.sourceNode.connect(this.dampFB.frequency);

        this.options = {
            mode: {
                get: () => this.mode,
                set: (value) => {
                    if (!MODES.includes(value)) throw new Error(`invalid mode "${value}" — expected ${MODES.join(", ")}`);
                    this.mode = value;
                    this._applyMode();
                },
                choices: MODES,
            },
        };

        // Console/UI-facing control surface (see commands.js's applyParams).
        // Bounds: `time` spans 20Hz to 5kHz as a comb frequency (the delay
        // node is built for 0.1s, well past the top of the range, so nothing
        // clips against the node's own limit); `feedback` is **bipolar**,
        // because a negative coefficient inverts the copy and moves every peak
        // onto what was a notch — the hollow, half-an-octave-down version of
        // the same setting, and worth a sign rather than a second option. It
        // stops short of 1 for the usual reason: at unity the feedback branch
        // never decays.
        this.params = {
            time: timeParam,
            feedback: feedbackParam,
            tone: toneParam,
            mix: mixParam,
        };

        // Written straight onto the gains rather than ramped (see _applyMode).
        // A processor is very often built while the engine is stopped, and a
        // suspended AudioContext's currentTime is frozen — so a ramp
        // scheduled here wouldn't advance, and *both* branches (a GainNode
        // defaults to 1) would be summing into the wet path until the
        // transport started.
        this.ffGate.gain.value = this.mode === "feedforward" ? 1 : 0;
        this.fbGate.gain.value = this.mode === "feedback" ? 1 : 0;
    };

    // The nominal comb frequency, which is what the numbers actually mean to
    // anyone using this — 1/time, whatever `time` currently is.
    get combHz() {
        return 1 / Math.max(1e-6, this.params.time.get());
    };

    get feedbackFloorHz() {
        return 1 / this.feedbackFloorSeconds;
    };

    // Ramped, not switched: `fbSum` carries the dry signal plus a ringing
    // tail, so gating it instantly is a step discontinuity — a click on every
    // mode change. 20ms is short enough to read as a switch.
    _applyMode() {
        const now = this.audioContext.currentTime;
        for (const [gate, on] of [[this.ffGate, this.mode === "feedforward"], [this.fbGate, this.mode === "feedback"]]) {
            gate.gain.cancelScheduledValues(now);
            gate.gain.setValueAtTime(gate.gain.value, now);
            gate.gain.linearRampToValueAtTime(on ? 1 : 0, now + 0.02);
        }
    };

    // The one thing neither the param list nor the option list shows: what
    // frequency this is actually combing at, and whether the feedback branch
    // can reach it. Same optional hook granular/markovpercs implement (see
    // commands.js's paramObjectSummary).
    describeState() {
        const nominal = `comb ${this.combHz.toFixed(0)}Hz`;
        if (this.mode !== "feedback") return `[${nominal}]`;
        const floored = this.params.time.get() < this.feedbackFloorSeconds;
        const floor = `feedback floor ${this.feedbackFloorHz.toFixed(0)}Hz`;
        return floored
            ? `[${nominal} — but feedback can't go above the ${floor}, so it is resonating there; use mode=feedforward for higher]`
            : `[${nominal}, ${floor}]`;
    };
};
