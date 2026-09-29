import { RibbitProcessor } from "../processor.js";
import { WorkletNode } from "./worklet.js";
import { buildParams } from "./spec.js";

// Base class for processors whose DSP runs in an AudioWorklet (the AE
// effects — see docs/dev/ae-machine.md, and dsp/worklet.js for why). The
// processor owns `input -> worklet -> output`; every param in the spec is a
// live AudioParam of the worklet, so ramps, `at=`, automation and patches all
// act on the running DSP.
//
// Each of these effects mixes its own dry and wet *inside* the worklet (a
// `mix` param where the effect has one), because most of them are built to sit
// on a send bus fully wet, and a few (Oxide, the looper) aren't mixes at all.
//
// A **sidechain** is a param with `rate: "a-rate"`: patch a track into it
// (`/patch source=kick dest=breathe.key depth=1`) and the track's audio — not
// a control value — arrives in the processor at audio rate. A patch already
// *is* "connect this signal into that AudioParam"; an a-rate param is
// simply one whose processor reads every sample.
//
// **Jumps.** An effect may implement `jump(random, time)`: its own idea of a
// musically sensible random reconfiguration (a delay time picked in tune, a
// freeze thrown for a random while). `dicejumpers` calls it — the AE's
// probability jumpers each "own one effect", and an effect knows better than
// a generic randomiser which of its params move together.
export class RibbitWorkletProcessor extends RibbitProcessor {
    constructor(audioContext, options = {}, spec) {
        super(audioContext, { name: options.name ?? spec.processor });
        this.spec = spec;

        const { sources, params } = buildParams(audioContext, spec.params, options);
        this._paramSources = sources;
        this.params = params;

        this.node = new WorkletNode(audioContext, spec.processor, {
            params: this.params,
            input: this.input,
            output: this.output,
            processorOptions: spec.processorOptions ?? {},
        });
        this.node.onmessage = (message) => this.onWorkletMessage?.(message);
    };

    // Sends a message the processor applies at `time` (an AudioContext
    // timestamp; now if omitted). Every processor here reads messages through
    // DSP.TimedQueue, so a deferred option lands on its sample.
    send(message, time) {
        this.node.post({ ...message, time: time ?? this.audioContext.currentTime });
    };

    // Moves one of this effect's own params to `value` at `time` — how a
    // jump() lands without the caller knowing about AudioParams. Clamped like
    // any set.
    setParamAt(key, value, time) {
        const param = this.params[key];
        if (!param) return;
        const target = param.clamp(value);
        param.audioParam.cancelScheduledValues(time);
        param.audioParam.setValueAtTime(param.encode(target), Math.max(time, this.audioContext.currentTime));
    };

    dispose() {
        this.node.dispose();
        this._paramSources.dispose();
        super.dispose();
    };
};

// A delay time "in tune": the AE's tuned jumpers pick an octave and a scale
// degree, turn that pitch into a period, and use it as a delay length. The
// period is doubled or halved into [min, max] seconds, so a long echo is still
// a whole number of cycles of a note of the scale. `tuning` is { root, scale }
// (semitones) — resonators' when there is one, else the harmony context's
// (see dicejumpers).
export function tunedDelay(random, tuning, min, max) {
    const scale = tuning?.scale?.length ? tuning.scale : [0, 2, 4, 5, 7, 9, 11];
    const root = tuning?.root ?? 48;
    const midi = root + scale[Math.floor(random() * scale.length)] + 12 * (Math.floor(random() * 3) - 1);
    let seconds = 1 / (440 * Math.pow(2, (midi - 69) / 12));
    while (seconds < min) seconds *= 2;
    while (seconds > max) seconds /= 2;
    return seconds;
};
