import { randomInRange } from "./random.js";

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
    constructor(audioParam, { decode = (v) => v, encode = (v) => v, min = -Infinity, max = Infinity, onSet, randomizable = true } = {}) {
        this.audioParam = audioParam;
        this.decode = decode; // raw AudioParam value -> user-facing value
        this.encode = encode; // user-facing value -> raw AudioParam value
        this.min = min;
        this.max = max;

        // Whether `/<object> random` (randomize everything at once) should
        // touch this param — the console exposes it as `<param>.r=true|false`
        // and a session file round-trips it (see session.js's no_random).
        // Defaults to true because the interesting case is a sound-design
        // param, and those are the overwhelming majority; a class opts out
        // the few where a random value isn't a timbre but a mistake (a
        // channel's fader, which would just make the track vanish).
        //
        // Note this is only about the *bulk* command: an explicit
        // `<param>=random` always works, since asking for one param by name
        // is not something to protect anyone from.
        this.randomizable = randomizable;
        // Most params are a 1:1 mapping onto a single AudioParam's .value —
        // the default set() below handles that. A few (e.g. RibbitDelay's
        // "time") need to fan a single user-facing value out across more
        // than one node (delayL + delayR, the latter offset for stereo
        // width); onSet lets a param override just the instant-set path for
        // that case. Ramping/deferred-at= scheduling still only animates
        // `audioParam` itself (the "primary" node) — a pre-existing
        // limitation for those multi-node params, unchanged by this class.
        this._onSet = onSet;

        // Modulation reading — see getModulated(). `_tap` is an AnalyserNode
        // watching the *output* of the node this param's AudioParam belongs
        // to, built lazily by _createTap (installed by RibbitParamSources)
        // the first time a patch actually lands here. `_patchCount` is how
        // many live patch cables are connected, so an unpatched param never
        // pays for the tap and never reads a stale buffer.
        this._createTap = null;
        this._tap = null;
        this._tapBuffer = null;
        this._patchCount = 0;
    };

    // The param's *intrinsic* value: what was last set or ramped here.
    //
    // Deliberately blind to patches. By the Web Audio spec an AudioParam's
    // `.value` reflects its intrinsic value only — automation is folded in,
    // an incoming node connection never is — and that's exactly the reading
    // display and serialization want: /save must record "position is 0.2",
    // not "0.7, because an LFO happened to be up when the file was written".
    // Anything deciding what to *do* at trigger time wants getModulated().
    get() {
        return this.decode(this.audioParam.value);
    };

    // The value including whatever is patched in — the number a synth or
    // generator should act on.
    //
    // A patch is an audio-rate connection into the AudioParam, and there is
    // no way to read the summed result off the param itself. The one place it
    // becomes visible is the owning node's output, so a patched param grows
    // an AnalyserNode there and reads the last rendered sample. Falls back to
    // get() when nothing is patched (the common case, and free) or when this
    // param has no tap to build — a param wrapping a real audio node's
    // AudioParam does its own work with the summed value and is never read
    // from JS.
    //
    // The value is one render quantum old, and notes are scheduled a little
    // ahead of the clock, so this is "the modulator's value at command time",
    // not at note time. For LFO-into-grain-position gestures that difference
    // is inaudible; a sample-accurate read would mean doing the work in an
    // AudioWorklet instead.
    getModulated() {
        if (!this._patchCount || !this._tap) return this.get();
        this._tap.getFloatTimeDomainData(this._tapBuffer);
        return this.clamp(this.decode(this._tapBuffer[this._tapBuffer.length - 1]));
    };

    // Called by RibbitPatch as cables come and go (see patch.js). The count,
    // rather than a boolean, because several patches can share one
    // destination — summing at the param is legitimate modular routing.
    attachPatch() {
        this._patchCount += 1;
        if (this._patchCount === 1 && !this._tap && this._createTap) {
            this._tap = this._createTap();
            this._tapBuffer = new Float32Array(this._tap.fftSize);
        }
    };

    detachPatch() {
        this._patchCount = Math.max(0, this._patchCount - 1);
    };

    set(value) {
        if (this._onSet) this._onSet(value);
        else this.audioParam.value = this.encode(value);
    };

    clamp(value) {
        return Math.max(this.min, Math.min(this.max, value));
    };

    // Whether a random draw is even *possible* here: both ends have to be
    // finite, since "somewhere in -Infinity..Infinity" is not a number.
    // Stricter than the `||` formatParamLine uses to decide whether to print
    // a range at all — a half-declared range (a send's gain, min 0 and no
    // max) is worth showing and not enough to draw from.
    get hasRange() {
        return Number.isFinite(this.min) && Number.isFinite(this.max);
    };

    // Included in `/<object> random`. Two independent reasons to be out: the
    // flag was turned off, or there's no range to draw from in the first
    // place. The console distinguishes them when listing (see
    // formatParamLine) because only the first one is the user's doing.
    get canRandomize() {
        return this.randomizable && this.hasRange;
    };

    // One draw for this param, honoring an explicit min/max override (either
    // or both — an omitted end falls back to the declared bound). Returns
    // null when the resulting range still isn't finite, which is the caller's
    // cue to say "give me min= and max=" rather than to invent a range: a
    // param left deliberately unbounded (a patch's depth) has no defensible
    // default span, and picking one silently would be worse than asking.
    //
    // The result is clamped, so an override wider than the declared range
    // can't push a param somewhere a plain set couldn't.
    randomValue({ min, max } = {}) {
        const low = min ?? this.min;
        const high = max ?? this.max;
        if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
        return this.clamp(randomInRange(Math.min(low, high), Math.max(low, high)));
    };
};

// Every param addressable on an object, its synth's included.
//
// A track's synth isn't independently addressable — its params live on the
// channel's surface (`/lead cutoff=800`, `/patch dest=lead.position`), and
// this is that same rule in one place, for the generic surfaces that need
// the whole map at once rather than one key at a time: automate=, the
// automations listing, session (de)serialization, and completion. The
// channel's own params win a name collision, matching channelCommand's
// precedence. Objects without a synth (processors, modulators, buses) just
// get their own map back.
export function addressableParams(object) {
    return object.source?.params ? { ...object.source.params, ...object.params } : object.params;
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
        this.taps = [];
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

        const param = new RibbitParam(source.offset, { min, max, ...options });
        // The node behind the param, exposed for the one case that needs more
        // than its value: a param that is *also* an audio-rate control signal
        // driving real AudioParams elsewhere in the graph. RibbitProcessor's
        // createCrossfade() connects this into two gains (one inverted) so a
        // single param moves both sides of a dry/wet fade — which onSet
        // deliberately cannot do, since onSet only overrides the instant-set
        // path and leaves a *ramp* animating one node (see RibbitParam's note
        // on multi-node params). Ignored by params that are only ever read.
        param.sourceNode = source;

        // How this param reads its patches (see RibbitParam.getModulated).
        // The analyser is spliced into the existing source -> sink path
        // rather than hung off the side, because an AnalyserNode whose
        // output goes nowhere isn't reachable from the destination and so
        // isn't guaranteed to be pulled — the same "connected enough to stay
        // live" reasoning the muted sink itself exists for. Built on demand:
        // a granular track declares nine of these params and typically
        // patches none of them.
        param._createTap = () => {
            const analyser = this.audioContext.createAnalyser();
            analyser.fftSize = 32; // the minimum; a DC control signal needs one sample
            source.disconnect(sink);
            source.connect(analyser).connect(sink);
            this.taps.push(analyser);
            return analyser;
        };

        return param;
    };

    // Called from the owner's own duck-typed dispose() (see
    // Ribbit.removeModulator/removeTrack/setTrackSynth). Necessary because
    // these sinks reach audioContext.destination directly, so the generic
    // `output.disconnect()` those methods do never touches them — an
    // undisposed owner would leave running nodes behind.
    dispose() {
        for (const source of this.sources) source.stop();
        for (const tap of this.taps) tap.disconnect();
        for (const sink of this.sinks) sink.disconnect();
        this.sources = [];
        this.sinks = [];
        this.taps = [];
    };
};
