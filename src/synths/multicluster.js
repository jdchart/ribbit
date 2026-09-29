import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";
import { SampleSlot } from "../dsp/sampled.js";

// One family of a recording's slices — the AE machine's Multicluster
// (`smp8_analysis`): "slices that sound alike should be treated alike".
//
// The file is sliced at its onsets, every slice is measured (band energies,
// centroid, flatness, loudness, zero crossings) and k-means sorts them into
// `clusters` families, ordered darkest first. **One instance is one family**:
// make up to eight tracks with the same `sample` and `seed` and
// `cluster=0..7`, patch the same sequencer into all of them, and each track
// is that family's mixer strip — its own level, pan, mute, sends, and its own
// playback `rate` (pitch one whole family, leave the rest alone).
//
// **Which slice plays is random; where it goes is not.** On every step each
// instance draws the *same* slice (a hash of `seed` and the step's time), and
// only the instance whose family it belongs to plays it — the others decline
// the note, so their lamps stay dark. To feature a timbre, raise its track;
// the sequencer doesn't choose it. Analysis is shared: eight instances of one
// file decode and cluster it once, and each worklet receives only its own
// family's audio.
//
// It needs enough slices: asking for eight families from five slices is
// refused with a warning (describeState says so) — lower `thresh` or
// `clusters`.
export const MULTICLUSTER_PARAMS = {
    rate: { value: 1, min: 0.25, max: 4 },
    attack: { value: 1, min: 0, max: 100 },
    release: { value: 150, min: 5, max: 2000 },
    level: { value: 0.8, min: 0, max: 1 },
};

// A deterministic 0..1 from a seed and a step time (to the millisecond), so
// every instance draws the same slice for the same step.
function stepHash(seed, time) {
    let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.round(time * 1000)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export function multiclusterProcessor(Base, DSP) {
    const { SR, readAt, voiceProcessor } = DSP;

    class Voice {
        constructor(m, P, proc) {
            const bank = proc.bank;
            const [offset, length] = bank.slices[m.slice];
            this.left = bank.left;
            this.right = bank.right;
            this.position = offset;
            this.end = offset + length;
            this.rate = P.rate * (bank.sampleRate / SR);
            this.attack = Math.max(1, (P.attack / 1000) * SR);
            this.release = Math.max(1, (P.release / 1000) * SR);
            this.gain = bank.gain * m.velocity * P.level;
            this.n = 0;
        }
        render(L, R, from, to) {
            for (let i = from; i < to; i++) {
                const remaining = (this.end - this.position) / this.rate;
                if (remaining <= 1) return false;
                const env = Math.min(1, this.n / this.attack, remaining / this.release);
                const l = readAt(this.left, this.position);
                const r = this.right === this.left ? l : readAt(this.right, this.position);
                L[i] += l * env * this.gain;
                R[i] += r * env * this.gain;
                this.position += this.rate;
                this.n++;
            }
            return true;
        }
    }

    return voiceProcessor(Base, (m, P, proc) => (proc.bank && proc.bank.slices[m.slice] ? new Voice(m, P, proc) : null), 8, {
        init() {
            this.bank = null;
        },
        message(m) {
            if (m.type === "bank") this.bank = m.bank;
        },
    });
};

registerWorkletProcessor("ribbit-multicluster", multiclusterProcessor, workletParams(MULTICLUSTER_PARAMS));

// Slices longer than this play only their first four seconds — a family is
// a timbre, and a slice of a slow field recording can be most of a minute.
const MAX_SLICE_SECONDS = 4;

export class RibbitMultiCluster extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "multicluster", ...options }, {
            processor: "ribbit-multicluster",
            params: MULTICLUSTER_PARAMS,
            lane: "any",
            sieve: "all",
        });
        this.llm_summary = "One timbre family of an onset-sliced, k-means-clustered recording (the AE machine's multicluster). Make one track per cluster=0..7 with the same sample and seed and patch one sequencer into all: every step draws the same random slice and only its family's track plays it — so each track is that family's strip, with its own rate. clusters sets how many families.";
        const int = (value, fallback, lo, hi) => (Number.isFinite(Number(value)) ? Math.max(lo, Math.min(hi, Math.round(Number(value)))) : fallback);
        this.clusters = int(options.clusters, 8, 2, 8);
        this.cluster = int(options.cluster, 0, 0, 7);
        this.seed = int(options.seed, 1, 0, 2 ** 31);
        this.thresh = Number.isFinite(Number(options.thresh)) ? Math.max(0, Math.min(1, Number(options.thresh))) : 0.35;
        this.labels = null;
        this.localIndex = null;
        this.warning = null;

        this.recording = new SampleSlot(this, {
            folder: options.folder ?? "foley",
            sample: options.sample,
            analysis: () => ({ thresh: this.thresh, minHop: 0.04, clusters: this.clusters, seed: this.seed }),
            onLoad: (result, gain) => this._sendBank(result, gain),
        });
        const intOption = (field, lo, hi, reanalyse) => ({
            get: () => this[field],
            set: (value) => {
                const n = Number(value);
                if (!Number.isFinite(n)) throw new Error(`invalid ${field} "${value}" — expected a number ${lo}..${hi}`);
                this[field] = Math.max(lo, Math.min(hi, Math.round(n)));
                if (reanalyse) this.recording.reanalyse();
                else if (this.recording.loaded) this._sendBank(this.recording.loaded, this._gain);
            },
        });
        this.options = {
            ...this.options,
            ...this.recording.options(),
            clusters: intOption("clusters", 2, 8, true),
            // Which family this instance is.
            cluster: intOption("cluster", 0, 7, false),
            // Shared by every instance of a file: same seed, same draws.
            seed: intOption("seed", 0, 2 ** 31, true),
            thresh: {
                get: () => this.thresh,
                set: (value) => {
                    const n = Number(value);
                    if (!Number.isFinite(n)) throw new Error(`invalid thresh "${value}" — expected 0..1`);
                    this.thresh = Math.max(0, Math.min(1, n));
                    this.recording.reanalyse();
                },
            },
        };
    };

    // Packs this instance's family — only its own slices — into one buffer.
    _sendBank(result, gain) {
        this._gain = gain;
        this.warning = result.warning ?? null;
        if (!result.labels) {
            this.labels = null;
            this.node.post({ type: "bank", bank: null });
            return;
        }
        const { sample, starts, labels } = result;
        const maxLength = Math.floor(MAX_SLICE_SECONDS * sample.sampleRate);
        const mine = [];
        let total = 0;
        this.localIndex = new Array(starts.length).fill(-1);
        for (let s = 0; s < starts.length; s++) {
            if (labels[s] !== this.cluster) continue;
            const end = s + 1 < starts.length ? starts[s + 1] : sample.left.length;
            const length = Math.min(maxLength, end - starts[s]);
            this.localIndex[s] = mine.length;
            mine.push([starts[s], length, total]);
            total += length;
        }
        const left = new Float32Array(total);
        const right = sample.right === sample.left ? left : new Float32Array(total);
        for (const [start, length, offset] of mine) {
            left.set(sample.left.subarray(start, start + length), offset);
            if (right !== left) right.set(sample.right.subarray(start, start + length), offset);
        }
        this.labels = labels;
        this.sizes = result.sizes;
        const bank = { left, right, sampleRate: sample.sampleRate, gain, slices: mine.map(([, length, offset]) => [offset, length]) };
        this.node.post({ type: "bank", bank }, right === left ? [left.buffer] : [left.buffer, right.buffer]);
    };

    trigger(time, event) {
        if (!this.labels || !this.accepts(event)) return false;
        const slice = Math.floor(stepHash(this.seed, time) * this.labels.length);
        if (this.labels[slice] !== this.cluster) return false;
        this.node.post({ type: "note", time, slice: this.localIndex[slice], velocity: event.velocity ?? 1, pitch: 60, duration: 0 });
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
        const base = this.recording.describe();
        if (this.warning) return `[${base} · ${this.warning}]`;
        if (!this.sizes) return `[${base}]`;
        return `[${base} · cluster ${this.cluster} of ${this.clusters} · family sizes ${this.sizes.join("/")}]`;
    };
};
