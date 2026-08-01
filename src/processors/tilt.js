import { RibbitProcessor } from "../processor.js";
import { RibbitParamSources } from "../param.js";

// How far each shelf swings at full tone, in dB. Fixed rather than exposed:
// ±12dB either side is already a drastic tilt, and a second control for
// "how much of the one control" is the kind of parameter nobody ever moves.
const TILT_RANGE_DB = 12;

// A tilt EQ: one low shelf and one high shelf pivoting around a shared
// frequency, moving in *opposite* directions from a single control. Negative
// tone is darker and fuller, positive is brighter and thinner, zero is flat.
//
// This is the "sounds better" control that isn't a compressor. Most of what
// people mean by a mix sounding wrong is a broad tonal tilt rather than
// anything narrow, and one knob that trades bass for treble fixes it faster
// than a parametric EQ does — which is also why it's the one EQ shape worth
// having before any other.
//
// No dry/wet mix here, deliberately: an EQ blended with its own dry signal
// is just a weaker EQ, and `tone` already spans "no effect" at 0.
export class RibbitTilt extends RibbitProcessor {
    constructor(audioContext, { name = "tilt", tone = 0, pivot = 800 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A tilt EQ: one control trading low end against high end around a pivot frequency.";

        this.lowShelf = audioContext.createBiquadFilter();
        this.lowShelf.type = "lowshelf";
        this.highShelf = audioContext.createBiquadFilter();
        this.highShelf.type = "highshelf";

        // Both filters' gain and frequency are driven entirely by the two
        // params below, so their intrinsic values start at zero and every
        // change arrives as a summed connection — the same technique
        // RibbitProcessor.createCrossfade uses, and for the same reason: one
        // user-facing value has to move more than one node, and it has to
        // keep doing so through a *ramp*, which RibbitParam's onSet can't
        // deliver (it only overrides the instant-set path).
        this.lowShelf.gain.value = 0;
        this.highShelf.gain.value = 0;
        this.lowShelf.frequency.value = 0;
        this.highShelf.frequency.value = 0;

        this._paramSources ??= new RibbitParamSources(audioContext);
        const toneParam = this._paramSources.create(tone, { min: -1, max: 1 });
        const pivotParam = this._paramSources.create(pivot, { min: 100, max: 8000 });

        // tone -1..1 scaled to ±TILT_RANGE_DB, inverted into the low shelf so
        // the two ends see-saw rather than both rising.
        const highScale = audioContext.createGain();
        highScale.gain.value = TILT_RANGE_DB;
        const lowScale = audioContext.createGain();
        lowScale.gain.value = -TILT_RANGE_DB;
        toneParam.sourceNode.connect(highScale).connect(this.highShelf.gain);
        toneParam.sourceNode.connect(lowScale).connect(this.lowShelf.gain);

        // Both shelves share one pivot, so this one goes to both unscaled.
        pivotParam.sourceNode.connect(this.lowShelf.frequency);
        pivotParam.sourceNode.connect(this.highShelf.frequency);

        this.input.connect(this.lowShelf).connect(this.highShelf).connect(this.output);

        this.params = {
            tone: toneParam,
            pivot: pivotParam,
        };
    };
};
