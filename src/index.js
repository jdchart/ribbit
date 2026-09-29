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
export { createHarmonyContext, parseDegreeList, resolveDegree, TUNINGS, parseTuning, formatTuning, quantizeToTuning } from "./harmony.js";

// ── Graph primitives & extension base classes ───────────────────────────
export { RibbitChannel } from "./channel.js";
export { RibbitTrack } from "./track.js";
export { RibbitClock } from "./clock.js";
export { RibbitParam, RibbitParamSources } from "./param.js";
export { RibbitEvent, formatEvents, parseEvents } from "./event.js";
export { RibbitSynth } from "./synth.js";
export { RibbitProcessor } from "./processor.js";
export { RibbitModulator, firingOf, refOption } from "./modulator.js";
export { RibbitPatch, RibbitEventPatch } from "./patch.js";
export { RibbitGroup } from "./group.js";
// Audio capture. The recorder is reached as `engine.recorder` in practice —
// these are exported for a host that wants to build its own transport (the
// mode/bit-depth lists to render a toggle from) or to encode audio of its own.
export { RibbitRecorder, RECORDER_MODES, RECORDER_BIT_DEPTHS, encodeWAV } from "./recorder.js";
export { positionToGain, gainToPosition } from "./taper.js";
export { mulberry32, randomSeed } from "./random.js";
export { parsePattern, cellAt, fetchPattern, fetchPatternManifest } from "./pattern.js";
export { fetchSampleManifest, resolvedSampleManifest, sampleName, sampleUrl, sampleFolders, parseSampleList } from "./samples.js";
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
export { RibbitSVF } from "./processors/svf.js";
export { RibbitComb } from "./processors/comb.js";
export { RibbitLimiter } from "./processors/limiter.js";
export { RibbitGoodenizer } from "./processors/goodenizer.js";
export { RibbitLFO } from "./modulators/lfo.js";
export { RibbitRandomNotes } from "./modulators/randomnotes.js";
export { RibbitCV } from "./modulators/cv.js";
export { RibbitMarkovPercs } from "./modulators/markovpercs.js";
export { RibbitEuclidPercs } from "./modulators/euclidpercs.js";
export { RibbitPatternVariator } from "./modulators/patternvariator.js";
export { RibbitChorale } from "./modulators/chorale.js";
export { RibbitRandomGestures } from "./modulators/randomgestures.js";
export { RibbitPianoRoll } from "./modulators/pianoroll.js";

// ── The AE machine (docs/dev/ae-machine.md) ─────────────────────────────
// AudioWorklet infrastructure: the processor registry/loader, the DSP
// toolkit every processor is written against, and the three base classes.
export { registerWorkletProcessor, loadWorklets, WorkletNode } from "./dsp/worklet.js";
export { dspLibrary } from "./dsp/lib.js";
export { RibbitWorkletSynth, parseSieve, LANES } from "./dsp/voice.js";
export { RibbitWorkletProcessor, tunedDelay } from "./dsp/effect.js";
export { RibbitWorkletModulator } from "./dsp/modsource.js";
export { detectOnsets, sliceFeatures, kmeans, analyseSample, decodeSample } from "./dsp/analysis.js";
// Voices.
export { RibbitFMPerc } from "./synths/fmperc.js";
export { RibbitModal } from "./synths/modal.js";
export { RibbitDrone } from "./synths/drone.js";
export { RibbitNoiseHat } from "./synths/noisehat.js";
export { RibbitSubDrum } from "./synths/subdrum.js";
export { RibbitTwoString } from "./synths/twostring.js";
export { RibbitMetalBass } from "./synths/metalbass.js";
export { RibbitCrack } from "./synths/crack.js";
export { RibbitFoldKick } from "./synths/foldkick.js";
export { RibbitBassDrum } from "./synths/bassdrum.js";
export { RibbitBigModal, MATERIALS, BIGMODAL_PRESETS } from "./synths/bigmodal.js";
export { RibbitTapeDrone } from "./synths/tapedrone.js";
export { RibbitMicroSampler } from "./synths/microsampler.js";
export { RibbitSlicer } from "./synths/slicer.js";
export { RibbitMultiCluster } from "./synths/multicluster.js";
// Effects.
export { RibbitDeepPad } from "./processors/deeppad.js";
export { RibbitResonators, RESONATOR_SCALES } from "./processors/resonators.js";
export { RibbitCascade } from "./processors/cascade.js";
export { RibbitNotverb } from "./processors/notverb.js";
export { RibbitGlaze } from "./processors/glaze.js";
export { RibbitDriveNet } from "./processors/drivenet.js";
export { RibbitSpectra } from "./processors/spectra.js";
export { RibbitLossyVerb } from "./processors/lossyverb.js";
export { RibbitBreathe } from "./processors/breathe.js";
export { RibbitMicroDelay } from "./processors/microdelay.js";
export { RibbitLooper } from "./processors/looper.js";
export { RibbitOxide, wearFinishSeconds } from "./processors/oxide.js";
// Modulators.
export { RibbitMarkovSeq, METRICS, SEQ_COLUMNS } from "./modulators/markovseq.js";
export { RibbitElasticTempo } from "./modulators/elastictempo.js";
export { RibbitDiceJumpers } from "./modulators/dicejumpers.js";
export { RibbitTerrarium } from "./modulators/terrarium.js";
export { RibbitModLFO, MODLFO_SHAPES } from "./modulators/modlfo.js";
export { RibbitDriftBank } from "./modulators/driftbank.js";
export { RibbitAttractor } from "./modulators/attractor.js";
export { RibbitFBMatrix } from "./modulators/fbmatrix.js";
export { RibbitCurveLoop } from "./modulators/curveloop.js";

// ── The outside world ───────────────────────────────────────────────────
// The audio interface (output device, channel-mapped outputs), live input,
// MIDI input, and the first audio analyser.
export { RibbitHardware, RibbitOutput, parseHardwareChannels, findMediaDevice, unlockDeviceLabels, MAX_HARDWARE_CHANNELS } from "./hardware.js";
export { RibbitAudioIn } from "./synths/audioin.js";
export { RibbitMidiIn, MidiListener, requestMidi, SUSTAIN_CC } from "./modulators/midiin.js";
export { RibbitMidiCC } from "./modulators/midicc.js";
export { RibbitLoudness, LOUDNESS_MODES } from "./modulators/loudness.js";
