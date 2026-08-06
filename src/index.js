// Public API for the `ribbit` audio engine. A host interface generally needs
// only the first group (the top-level owner, the command router, and the
// session (de)serializers); the rest is exposed for extension authors writing
// new synths/processors/modulators against the same base classes, and for any
// interface that wants to build directly on the graph primitives.
//
// Adding a new *built-in* synth/processor/modulator type is still done by
// registering it in ribbit.js (see the *_TYPES registries there and
// docs/dev/); this barrel only controls what the package hands to consumers.

// ── Core ────────────────────────────────────────────────────────────────
// The top-level owner (one AudioContext, clock, master bus, and every
// track/bus/processor/modulator/patch), plus the set of command names that
// can't be used as object names.
export { Ribbit, RESERVED_NAMES } from "./ribbit.js";

// ── Text control surface ────────────────────────────────────────────────
// A usable, UI-free way to drive an engine: createCommandRouter(engine)
// returns { executeCommand, suggest } for slash-command strings; parseCommand
// is the lower-level tokenizer.
export { createCommandRouter, parseCommand } from "./commands.js";

// ── Session (de)serialization ───────────────────────────────────────────
// JSON save/load and the ramped snapshot/recall used for live "scenes".
export { snapshotSession, sessionToJSON, loadSession, applySnapshot } from "./session.js";

// ── Harmony context ─────────────────────────────────────────────────────
// The shared key/scale a synth resolves an event's `degree` against.
export { createHarmonyContext, parseDegreeList, resolveDegree } from "./harmony.js";

// ── Graph primitives & extension base classes ───────────────────────────
export { RibbitChannel } from "./channel.js";
export { RibbitTrack } from "./track.js";
export { RibbitClock } from "./clock.js";
export { RibbitParam, RibbitParamSources } from "./param.js";
export { RibbitEvent } from "./event.js";
export { RibbitSynth } from "./synth.js";
export { RibbitProcessor } from "./processor.js";
export { RibbitModulator } from "./modulator.js";
export { RibbitPatch, RibbitEventPatch } from "./patch.js";
export { positionToGain, gainToPosition } from "./taper.js";
export { mulberry32, randomSeed } from "./random.js";
export { parsePattern, cellAt, fetchPattern, fetchPatternManifest } from "./pattern.js";
export { fetchSampleManifest, resolvedSampleManifest, sampleName, sampleUrl, sampleFolders } from "./samples.js";
export {
    RibbitAutomationEvent,
    scheduleAutomationEvent,
    scheduleRamp,
    setInstant,
    scheduleAt,
} from "./automation.js";

// ── Built-in types ──────────────────────────────────────────────────────
// Exposed so an interface can reference/subclass them directly; they're also
// what the ribbit.js registries wire up for the command router.
export { RibbitOscSynth } from "./synths/oscsynth.js";
export { RibbitSampler } from "./synths/sampler.js";
export { RibbitPercSampler, PERC_CATEGORIES } from "./synths/percsampler.js";
export { RibbitKarplus } from "./synths/karplus.js";
export { RibbitGranular } from "./synths/granular.js";
export { RibbitTapePad } from "./synths/tapepad.js";
export { RibbitChaosSynth } from "./synths/chaossynth.js";
export { RibbitCZSynth } from "./synths/czsynth.js";
export { CZ_TONES, CZ_TONE_NAMES } from "./synths/cz-tones.js";
export { RibbitReverb } from "./processors/reverb.js";
export { RibbitDelay } from "./processors/delay.js";
export { RibbitCompressor } from "./processors/compressor.js";
export { RibbitSaturator, SATURATOR_CHARACTERS } from "./processors/saturator.js";
export { RibbitTilt } from "./processors/tilt.js";
export { RibbitLimiter } from "./processors/limiter.js";
export { RibbitGoodenizer } from "./processors/goodenizer.js";
export { RibbitLFO } from "./modulators/lfo.js";
export { RibbitRandomNotes } from "./modulators/randomnotes.js";
export { RibbitCV } from "./modulators/cv.js";
export { RibbitMarkovPercs } from "./modulators/markovpercs.js";
export { RibbitEuclidPercs } from "./modulators/euclidpercs.js";
export { RibbitPatternVariator } from "./modulators/patternvariator.js";
export { RibbitChorale } from "./modulators/chorale.js";
