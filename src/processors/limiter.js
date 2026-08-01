import { RibbitProcessor } from "../processor.js";
import { RibbitParam } from "../param.js";
import { formatReduction } from "./compressor.js";

// A loudness ceiling: drive the signal up with `boost`, then hold whatever
// comes out under `ceiling`. That pairing is the whole point — a limiter on
// its own only ever makes things quieter, and it's the boost underneath it
// that turns "nothing clips" into "everything is loud and even".
//
// Honest about what it is: a DynamicsCompressorNode at a high ratio and a
// very fast attack, not a lookahead brickwall. Web Audio doesn't offer
// lookahead, so a fast enough transient can still poke a little past the
// ceiling. It's a safety net and a loudness tool, not a mastering-grade
// true-peak limiter — treat `ceiling` as "about here" rather than a
// guarantee, which is also why it defaults to -1 rather than 0.
export class RibbitLimiter extends RibbitProcessor {
    constructor(audioContext, { name = "limiter", boost = 1, ceiling = -1, release = 0.1 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A loudness ceiling: a boost stage into a fast, high-ratio compressor that holds the output near a set level.";

        this.boostGain = audioContext.createGain();
        this.boostGain.gain.value = boost;

        this.limiter = audioContext.createDynamicsCompressor();
        this.limiter.threshold.value = ceiling;
        // Fixed, and not exposed: these three are what make it a limiter
        // rather than a compressor. A limiter with an adjustable ratio and a
        // slow attack is a compressor with a confusing name — /compressor
        // already exists for that, and pointing at it is better than
        // offering the same controls twice.
        this.limiter.ratio.value = 20;
        this.limiter.knee.value = 0;
        this.limiter.attack.value = 0.001;
        this.limiter.release.value = release;

        // No dry/wet: a limiter you can blend past isn't a limiter, since
        // the dry path would carry exactly the peaks it was inserted to stop.
        this.input.connect(this.boostGain).connect(this.limiter).connect(this.output);

        this.params = {
            boost: new RibbitParam(this.boostGain.gain, { min: 0, max: 8 }),
            ceiling: new RibbitParam(this.limiter.threshold, { min: -40, max: 0 }),
            release: new RibbitParam(this.limiter.release, { min: 0.01, max: 1 }),
        };
    };

    // See RibbitCompressor.describeState — on a limiter this doubles as the
    // "am I pushing too hard" readout, since anything past a few dB of
    // reduction means boost is doing more than the ceiling can politely
    // absorb.
    describeState() {
        return `limiting ${formatReduction(this.limiter)}`;
    };
};
