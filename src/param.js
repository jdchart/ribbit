// A single command-line-addressable parameter: wraps a raw Web Audio
// AudioParam (optionally through a value transform — e.g. a channel's 0-1
// taper position sitting on top of an exponential gain AudioParam) so every
// object with rampable parameters — a channel, a processor, a modulator, a
// patch — defines them exactly the same way, and commands.js has exactly one
// code path (see applyParams) that knows how to get/set/ramp/defer any of
// them.
//
// Before this, ramping a param needed two things kept in sync by hand: a
// {get,set} pair in an object's `.params` map, and a separately-declared
// same-named getter returning the raw AudioParam (e.g. `get wet()`) that
// commands.js's ramp/patch code reached into instead. Here `.audioParam`
// lives right on the one object both paths now share, so there's nothing
// left that can drift apart.
export class RibbitParam {
    constructor(audioParam, { decode = (v) => v, encode = (v) => v, min = -Infinity, max = Infinity, onSet } = {}) {
        this.audioParam = audioParam;
        this.decode = decode; // raw AudioParam value -> user-facing value
        this.encode = encode; // user-facing value -> raw AudioParam value
        this.min = min;
        this.max = max;
        // Most params are a 1:1 mapping onto a single AudioParam's .value —
        // the default set() below handles that. A few (e.g. RibbitDelay's
        // "time") need to fan a single user-facing value out across more
        // than one node (delayL + delayR, the latter offset for stereo
        // width); onSet lets a param override just the instant-set path for
        // that case. Ramping/deferred-at= scheduling still only animates
        // `audioParam` itself (the "primary" node) — a pre-existing
        // limitation for those multi-node params, unchanged by this class.
        this._onSet = onSet;
    };

    get() {
        return this.decode(this.audioParam.value);
    };

    set(value) {
        if (this._onSet) this._onSet(value);
        else this.audioParam.value = this.encode(value);
    };

    clamp(value) {
        return Math.max(this.min, Math.min(this.max, value));
    };
};

// Backing store for params that have no AudioParam of their own.
//
// Most RibbitParams wrap an AudioParam that already exists because it does
// audio work — a GainNode's gain, a StereoPannerNode's pan. But a synth or
// modulator often wants a *control* value with the same console surface
// (get/set/ramp/at=/patch-as-a-destination) and nothing in the audio graph
// to hang it on: RibbitRandomNotes' probability, RibbitMarkovPercs' swing,
// RibbitPercSampler's pan_spread. The trick is to invent an AudioParam by
// creating a ConstantSourceNode and using its `.offset`.
//
// That comes with a Web Audio quirk, which is the real reason this class
// exists rather than a one-liner at each call site: a node with no path into
// the rendered graph can have its scheduled automation (setValueAtTime — the
// route every deferred at= set and every /recall ride, see automation.js)
// silently never reflected in later `.value` reads, even though a *direct*
// `.value =` assignment always works. So each source is routed through a
// muted (gain 0) sink into audioContext.destination: connected enough to
// stay live, silent enough to never be heard.
//
// This was open-coded in three classes before, each re-explaining the quirk
// and each maintaining its own parallel `_sinks` array and dispose() —
// exactly the drift risk RibbitParam itself was introduced to remove.
export class RibbitParamSources {
    constructor(audioContext) {
        this.audioContext = audioContext;
        this.sources = [];
        this.sinks = [];
    };

    // Creates one silent-backed RibbitParam. `min`/`max` are declared once
    // and used twice: to clamp the initial value, and as the RibbitParam's
    // own bounds for every later set/ramp. (Previously each call site wrote
    // the same numbers out in both places, free to disagree.)
    create(value, { min = -Infinity, max = Infinity, ...options } = {}) {
        const source = this.audioContext.createConstantSource();
        source.offset.value = Math.max(min, Math.min(max, Number(value)));
        source.start();

        const sink = this.audioContext.createGain();
        sink.gain.value = 0;
        source.connect(sink).connect(this.audioContext.destination);

        this.sources.push(source);
        this.sinks.push(sink);
        return new RibbitParam(source.offset, { min, max, ...options });
    };

    // Called from the owner's own duck-typed dispose() (see
    // Ribbit.removeModulator/removeTrack/setTrackSynth). Necessary because
    // these sinks reach audioContext.destination directly, so the generic
    // `output.disconnect()` those methods do never touches them — an
    // undisposed owner would leave running nodes behind.
    dispose() {
        for (const source of this.sources) source.stop();
        for (const sink of this.sinks) sink.disconnect();
        this.sources = [];
        this.sinks = [];
    };
};
