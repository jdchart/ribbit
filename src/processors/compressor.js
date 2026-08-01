import { RibbitProcessor } from "../processor.js";
import { RibbitParam } from "../param.js";

// A dynamics compressor: the standard "make the loud bits quieter so the
// whole thing can be louder" box, wrapped around Web Audio's own
// DynamicsCompressorNode (which is a real feed-forward compressor with
// proper gain computation, not something worth reimplementing by hand).
//
// Unlike reverb/delay this uses a true dry/wet crossfade rather than a dry
// passthrough at unity — see RibbitProcessor.createCrossfade for why a
// compressor specifically needs that. Turning `mix` down is parallel (New
// York) compression: a squashed copy blended under the untouched signal,
// which thickens without flattening.
export class RibbitCompressor extends RibbitProcessor {
    constructor(audioContext, {
        name = "compressor",
        threshold = -18,
        ratio = 4,
        attack = 0.01,
        release = 0.15,
        knee = 6,
        makeup = 1,
        mix = 1,
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A dynamics compressor with makeup gain and a true dry/wet mix (turn mix down for parallel compression).";

        this.compressor = audioContext.createDynamicsCompressor();
        this.compressor.threshold.value = threshold;
        this.compressor.ratio.value = ratio;
        this.compressor.attack.value = attack;
        this.compressor.release.value = release;
        this.compressor.knee.value = knee;

        // Compression only ever takes level away, so a compressor without
        // makeup gain is just a volume drop — this is the half that turns it
        // into a loudness tool.
        this.makeupGain = audioContext.createGain();
        this.makeupGain.gain.value = makeup;

        const { param: mixParam, wetGain } = this.createCrossfade(mix);
        this.input.connect(this.compressor).connect(this.makeupGain).connect(wetGain);

        // Console/UI-facing control surface (see commands.js's applyParams).
        // Bounds are the node's own documented ranges, except makeup (an
        // ordinary gain, capped at 8x so a typo can't detonate the master)
        // and mix. threshold/ratio/attack/release are all patch destinations,
        // which is where the fun is: /patch source=lfo1 dest=comp.threshold
        // is a rhythmically pumping compressor.
        this.params = {
            threshold: new RibbitParam(this.compressor.threshold, { min: -100, max: 0 }),
            ratio: new RibbitParam(this.compressor.ratio, { min: 1, max: 20 }),
            attack: new RibbitParam(this.compressor.attack, { min: 0, max: 1 }),
            release: new RibbitParam(this.compressor.release, { min: 0, max: 1 }),
            knee: new RibbitParam(this.compressor.knee, { min: 0, max: 40 }),
            makeup: new RibbitParam(this.makeupGain.gain, { min: 0, max: 8 }),
            mix: mixParam,
        };
    };

    // How much gain reduction is happening *right now*, in dB — the one
    // thing about a compressor you actually need to see and the one thing
    // no param can tell you (it depends entirely on what's going through
    // it). Surfaced via the optional describeState() hook, so a bare
    // /compressor reports it; see commands.js's paramObjectSummary and
    // RibbitMarkovPercs' own describeState for the same idiom.
    describeState() {
        return `reducing ${formatReduction(this.compressor)}`;
    };
};

// DynamicsCompressorNode.reduction is a plain float in the current spec but
// was an AudioParam in the original one, and is absent entirely from a stub
// context (the offline test harness) — so read it defensively rather than
// letting a display-only value throw inside a summary line.
export function formatReduction(compressorNode) {
    const raw = compressorNode.reduction;
    const value = typeof raw === "number" ? raw : raw?.value ?? 0;
    return `${value.toFixed(1)} dB`;
};
