import { RibbitProcessor } from "../processor.js";
import { RibbitCompressor } from "./compressor.js";
import { RibbitSaturator } from "./saturator.js";
import { RibbitTilt } from "./tilt.js";
import { RibbitLimiter } from "./limiter.js";
import { formatReduction } from "./compressor.js";

// The whole mastering chain as one object: compress, saturate, tilt, limit.
// Drop it on master and everything gets louder and more even without you
// deciding anything — and dirtier the moment you ask (see `drive` below,
// which defaults to clean on purpose).
//
// **It is a composite, not a reimplementation.** It builds one of each of the
// four processors above and chains them, then republishes their *actual*
// RibbitParam objects under its own `params` — the same objects, not copies
// wrapping the same nodes — so there is exactly one implementation of each
// stage and nothing here can drift from the standalone version. The children
// are constructed directly rather than through ribbit.createProcessor, so
// they're never registered, never addressable, and never in anyone's insert
// chain: they're node-graph builders that happen to be shaped like
// processors.
//
// Stage order is the argument this design makes, and it's deliberate:
//
//   compress → saturate → tilt → limit
//
// Compression first, so the saturator is fed a level that barely moves —
// that's what makes the distortion character *consistent* instead of
// lurching between clean and fried as the music gets busier, and it's most
// of what "sounds evenly mixed" actually means. Tilt after the saturator,
// because saturation adds its own top end and you want to voice what came
// out, not what went in. Limiter last, always, since anything after it could
// undo it.
//
// Reach for the four individually when you want one thing (parallel
// compression on a drum bus, a wavefolder on a lead); reach for this when
// you want the mix to sound good and would rather not think about it.
export class RibbitGoodenizer extends RibbitProcessor {
    constructor(audioContext, {
        name = "goodenizer",
        // Defaults are the version you'd leave on everything: about 4-6dB of
        // reduction on a busy passage, a slight lift up top, and a ceiling
        // that catches the rest.
        //
        // `drive` defaults to 1 — the saturation stage present but clean.
        // That's deliberate and was the correction to this processor's first
        // version. A compressor, a tilt and a limiter make a mix *more like
        // itself*: louder, steadier, better balanced. Saturation makes it
        // into something else, and something that alters timbre by default
        // is not a thing you can leave on every session. So the stage sits
        // inert until asked, and drive=8 with character=fold is one command
        // away when it is.
        threshold = -20,
        ratio = 4,
        attack = 0.01,
        release = 0.12,
        makeup = 1.4,
        drive = 1,
        character = "soft",
        oversample = "2x",
        tone = 0.15,
        pivot = 900,
        ceiling = -1,
        mix = 1,
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "The whole chain in one box: compressor into saturator into tilt EQ into limiter. Makes anything louder and more even; raise drive= for dirt.";

        // Child names only ever surface in an error thrown from a setter, so
        // they're prefixed to say where such an error came from.
        this.compressor = new RibbitCompressor(audioContext, { name: `${name}:comp`, threshold, ratio, attack, release, makeup });
        this.saturator = new RibbitSaturator(audioContext, { name: `${name}:sat`, drive, character, oversample });
        this.tilt = new RibbitTilt(audioContext, { name: `${name}:tilt`, tone, pivot });
        this.limiter = new RibbitLimiter(audioContext, { name: `${name}:limit`, ceiling });
        this.stages = [this.compressor, this.saturator, this.tilt, this.limiter];

        // The children's own mix params stay at 1 (fully processed); the
        // crossfade that matters is this one, across the whole chain. At 0.5
        // you get the entire treatment in parallel with the untouched mix,
        // which is a surprisingly good place to sit.
        const { param: mixParam, wetGain } = this.createCrossfade(mix);
        this.input.connect(this.compressor.input);
        this.compressor.output.connect(this.saturator.input);
        this.saturator.output.connect(this.tilt.input);
        this.tilt.output.connect(this.limiter.input);
        this.limiter.output.connect(wetGain);

        // Flattened control surface. Every entry below is the child's own
        // RibbitParam, so ramping/automating/patching /goodenizer threshold
        // and the standalone /compressor threshold run the exact same code
        // against the exact same AudioParam.
        //
        // Not everything is republished: the saturator's `level` and both
        // children's `mix` would each be a second, subtly different way to
        // set the overall balance, and the limiter's `boost` overlaps the
        // compressor's `makeup`. One knob per job — the atoms are there when
        // the extra one is actually wanted.
        this.params = {
            threshold: this.compressor.params.threshold,
            ratio: this.compressor.params.ratio,
            attack: this.compressor.params.attack,
            release: this.compressor.params.release,
            makeup: this.compressor.params.makeup,
            drive: this.saturator.params.drive,
            tone: this.tilt.params.tone,
            pivot: this.tilt.params.pivot,
            ceiling: this.limiter.params.ceiling,
            mix: mixParam,
        };

        // Same delegation for options — the saturator's own declarations,
        // shared by reference, so `character` validates and rebuilds the
        // curve through one implementation and round-trips through the base
        // getOptions() exactly as it does standalone.
        this.options = {
            character: this.saturator.options.character,
            oversample: this.saturator.options.oversample,
        };
    };

    // Both ends of the chain at once: how hard the compressor is working and
    // whether the limiter is having to clean up after it. Anything past a
    // couple of dB of limiting means makeup or drive is pushed further than
    // the ceiling can absorb — which is a legitimate place to be, but worth
    // being able to see.
    describeState() {
        return `comp ${formatReduction(this.compressor.compressor)}, limit ${formatReduction(this.limiter.limiter)}`;
    };

    // The children own running ConstantSourceNodes (their crossfades and the
    // tilt's two controls) that nothing else can reach — see
    // RibbitProcessor.dispose.
    dispose() {
        super.dispose();
        for (const stage of this.stages) stage.dispose();
    };
};
