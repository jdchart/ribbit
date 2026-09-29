import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams, toggleOption, isOn } from "../dsp/spec.js";
import { SampleSlot, transferable } from "../dsp/sampled.js";

// A looping window that moves through a recording — the AE machine's Slice
// Sampler (`aems_v1`). Load a file, let it find the transients (`thresh`:
// lower finds more; `min_hop`: shortest slice, ms), and the window that moves
// through them is itself the instrument.
//
// **It always plays.** Like the tape pad, this is a running thing rather than
// a note-player: while its track is started it loops the region `start..end`
// at `rate` (negative runs backwards), `window` fading each edge of the loop
// (long breathes, short clicks) and `declick` crossfading whenever it jumps.
// Under ~50ms a loop stops being a loop and becomes a tone — one of the most
// productive places in the machine to spend time.
//
// **Notes move it** (the manual's *Markov deviations*). Patched to a
// sequencer, every step relocates the window: `dev_slice` moves to a later
// slice for a higher note, `dev_rate` bends the speed with the melody,
// `dev_end` stretches the loop with it, and `dev_window` makes accents
// (velocity) change the grain shape. The note is scaled against the range of
// the sequencer's own note column (it sends that along), so it works whatever
// range you wrote. `dev_slice=1` is the manual's *Full Play Area* — the
// window wanders the whole file in time with the pattern. `mod=off` (or all
// four at 0) and it's a plain looper: drag `start`/`end`, raise `window`.
//
// `slice` is where the deviations start from (0..1 across the slices).
// Patching a `curveloop` into slice/rate/end/window is the manual's *Shapes*.
export const SLICER_PARAMS = {
    rate: { value: 1, min: -4, max: 4 },
    start: { value: 0, min: 0, max: 1 },
    end: { value: 0.05, min: 0, max: 1 },
    window: { value: 8, min: 0, max: 200 },
    declick: { value: 6, min: 0, max: 50 },
    slice: { value: 0, min: 0, max: 1 },
    dev_slice: { value: 0.5, min: -1, max: 1 },
    dev_rate: { value: 0, min: -1, max: 1 },
    dev_end: { value: 0, min: -1, max: 1 },
    dev_window: { value: 0, min: -1, max: 1 },
    level: { value: 0.8, min: 0, max: 1 },
};

export function slicerProcessor(Base, DSP) {
    const { SR, clamp, readLoop, smoothing, TimedQueue } = DSP;
    const MAX_HEADS = 4;

    return class extends Base {
        constructor(options) {
            super(options);
            this.P = {};
            this.dead = false;
            this.queue = new TimedQueue();
            this.buffer = null;
            this.starts = [0];
            this.mod = !(options && options.processorOptions && options.processorOptions.mod === false);
            this.gate = true;
            this.env = 0;
            // Read heads: one live, older ones fading out after a jump.
            this.heads = [];
            this.deviation = { slice: 0, rate: 0, end: 0, window: 0 };
            this.rateNow = 1;
            this.port.onmessage = (event) => {
                const m = event.data;
                if (m.type === "dispose") this.dead = true;
                else if (m.type === "buffer") {
                    this.buffer = { left: m.left, right: m.right, sampleRate: m.sampleRate, gain: m.gain };
                    this.starts = m.starts.length ? m.starts : [0];
                    this.heads = [];
                } else if (m.type === "gate") this.gate = m.on;
                else if (m.type === "mod") this.mod = m.on;
                else this.queue.push(m);
            };
        }

        // Where the loop should be, from the params plus the latest step.
        region(P) {
            const length = this.buffer.left.length;
            const lo = Math.min(P.start, P.end), hi = Math.max(P.start, P.end);
            let start = lo * length;
            let span = Math.max(64, (hi - lo) * length);
            const count = this.starts.length;
            if (this.mod && count > 1) {
                const base = Math.round(P.slice * (count - 1));
                const index = ((base + Math.round(this.deviation.slice * (count - 1))) % count + count) % count;
                start = this.starts[index];
            }
            span *= Math.pow(2, this.deviation.end * 2);
            span = Math.max(64, Math.min(span, length - start - 4));
            return { start, span };
        }

        relocate(P, fadeSamples) {
            if (!this.buffer) return;
            const { start, span } = this.region(P);
            for (const head of this.heads) head.target = 0;
            this.heads.push({ start, span, position: this.rateNow >= 0 ? start : start + span - 1, gain: this.heads.length ? 0 : 1, target: 1, step: 1 / Math.max(1, fadeSamples) });
            while (this.heads.length > MAX_HEADS) this.heads.shift();
        }

        process(inputs, outputs, parameters) {
            if (this.dead) return false;
            const P = DSP.readParams(parameters, this.P);
            const L = outputs[0][0];
            const R = outputs[0][1] || outputs[0][0];
            const frames = L.length;
            if (!this.buffer) return true;
            if (this.heads.length === 0) this.relocate(P, 1);
            const declick = (P.declick / 1000) * SR;

            this.queue.drain(frames, (m) => {
                if (m.type !== "step" || !this.mod) return;
                const n = clamp(m.noteNorm, 0, 1) * 2 - 1;
                this.deviation.slice = P.dev_slice * (n * 0.5 + 0.5);
                this.deviation.rate = P.dev_rate * n;
                this.deviation.end = P.dev_end * n;
                this.deviation.window = P.dev_window * (m.velocity * 2 - 1);
                this.relocate(P, declick);
            });

            // The live head follows start/end changes without a jump.
            const live = this.heads[this.heads.length - 1];
            if (live && !this.mod) {
                const { start, span } = this.region(P);
                live.start = start;
                live.span = span;
            }
            const up = 1 / (0.05 * SR);
            const down = Math.exp(-6.9 / (0.3 * SR));
            const rateTarget = P.rate * Math.pow(2, this.deviation.rate) * (this.buffer.sampleRate / SR);
            const rateGlide = 1 - smoothing(0.01);
            const windowMs = P.window * Math.pow(2, this.deviation.window * 1.5);
            const { left, right, gain } = this.buffer;
            const g = gain * P.level;

            for (let i = 0; i < frames; i++) {
                this.env = this.gate ? Math.min(1, this.env + up) : this.env * down;
                this.rateNow += (rateTarget - this.rateNow) * rateGlide;
                let l = 0, r = 0;
                for (let h = this.heads.length - 1; h >= 0; h--) {
                    const head = this.heads[h];
                    if (head.gain < head.target) head.gain = Math.min(head.target, head.gain + head.step);
                    else if (head.gain > head.target) head.gain = Math.max(head.target, head.gain - head.step);
                    if (head.gain <= 0 && head.target === 0) {
                        this.heads.splice(h, 1);
                        continue;
                    }
                    const end = head.start + head.span;
                    head.position += this.rateNow;
                    if (head.position >= end) head.position -= head.span * Math.ceil((head.position - end + 1) / head.span);
                    if (head.position < head.start) head.position += head.span * Math.ceil((head.start - head.position) / head.span);
                    const fade = Math.min(head.span * 0.5, (windowMs / 1000) * SR);
                    const a = readLoop(left, head.position, head.start, head.span, fade);
                    const b = right === left ? a : readLoop(right, head.position, head.start, head.span, fade);
                    l += a * head.gain;
                    r += b * head.gain;
                }
                L[i] = l * g * this.env;
                R[i] = r * g * this.env;
            }
            return true;
        }
    };
};

registerWorkletProcessor("ribbit-slicer", slicerProcessor, workletParams(SLICER_PARAMS));

export class RibbitSlicer extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        const mod = isOn(options.mod, true);
        super(audioContext, { name: "slicer", ...options }, {
            processor: "ribbit-slicer",
            params: SLICER_PARAMS,
            lane: "any",
            sieve: "all",
            processorOptions: { mod },
        });
        this.llm_summary = "A looping window moving through an onset-sliced recording (the AE machine's slice sampler). It plays continuously while started (rate -4..4, start/end region, window/declick fades; <50ms loops become tones); patched to a sequencer, every step relocates it — dev_slice/dev_rate/dev_end follow the note, dev_window the velocity (dev_slice=1 = full play area). mod=off makes it a plain looper.";
        this.mod = mod;
        this.thresh = Number.isFinite(Number(options.thresh)) ? Math.max(0, Math.min(1, Number(options.thresh))) : 0.5;
        this.min_hop = Number.isFinite(Number(options.min_hop)) ? Math.max(5, Number(options.min_hop)) : 60;
        this.recording = new SampleSlot(this, {
            folder: options.folder ?? "foley",
            sample: options.sample,
            analysis: () => ({ thresh: this.thresh, minHop: this.min_hop / 1000 }),
            onLoad: (result, gain) => {
                const { left, right, transfer } = transferable(result.sample);
                this.node.post({ type: "buffer", left, right, sampleRate: result.sample.sampleRate, gain, starts: result.starts }, transfer);
            },
        });
        const numberOption = (field, lo, hi) => ({
            get: () => this[field],
            set: (value) => {
                const n = Number(value);
                if (!Number.isFinite(n)) throw new Error(`invalid ${field} "${value}" — expected a number`);
                this[field] = Math.max(lo, Math.min(hi, n));
                this.recording.reanalyse();
            },
        });
        this.options = {
            ...this.options,
            ...this.recording.options(),
            // Onset sensitivity (lower = more slices) and the shortest slice
            // in ms. Options, not params: each change re-runs the analysis.
            thresh: numberOption("thresh", 0, 1),
            min_hop: numberOption("min_hop", 5, 2000),
            mod: toggleOption(this, "mod", (on) => this.node.post({ type: "mod", on })),
        };
        this._gateReady = true;
        this.node.post({ type: "gate", on: this.active !== false });
    };

    get active() {
        return this._active ?? true;
    };

    set active(value) {
        this._active = value;
        if (this._gateReady) this.node.post({ type: "gate", on: value !== false });
    };

    // A step relocates the window; it never "plays a note", so the clock's
    // lamp is honest either way.
    trigger(time, event) {
        if (!this.accepts(event)) return false;
        const noteNorm = event.noteNorm ?? Math.max(0, Math.min(1, ((event.pitch ?? 60) - 36) / 36));
        this.node.post({ type: "step", time, noteNorm, velocity: event.velocity ?? 1 });
        return true;
    };

    // The source's path and folder, read by hosts (lilypad's sample picker)
    // the same way they read granular's.
    get sample() {
        return this.recording?.sample ?? null;
    };

    get folder() {
        return this.recording?.folder ?? null;
    };

    describeState() {
        return `[${this.recording.describe()}]`;
    };
};
