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
