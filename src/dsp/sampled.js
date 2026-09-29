import { SAMPLE_MANIFEST_URL, fetchSampleManifest, resolvedSampleManifest, sampleFolders } from "../samples.js";
import { analyseSample, MAX_SECONDS } from "./analysis.js";

// The source recording of a worklet sample voice (`slicer`, `microsampler`,
// `multicluster`): its `sample` and `folder` options, a random roll from the
// host's manifest, and the load → analyse → hand-to-the-worklet pipeline.
//
// The rules are granular's (see synths/granular.js, whose comments explain
// each): `sample` reports the *resolved* path, never "random", so a session
// records what a roll landed on; setting `folder` to its current value must
// not re-roll (a /recall restores sample, then folder); a newer choice always
// wins over a load still in flight (the generation counter); and a failed load
// is one warning and a silent voice, never a throw.
//
// Sources are peak-normalised (capped at 20×) for granular's reason: the
// library isn't mastered, and a roll shouldn't be a loudness lottery.
export class SampleSlot {
    constructor(owner, { folder = "foley", sample = null, manifestUrl = SAMPLE_MANIFEST_URL, analysis = () => ({}), onLoad }) {
        this.owner = owner;
        this.folder = String(folder);
        this.sample = null;
        this.manifestUrl = manifestUrl;
        this.analysis = analysis;
        this.onLoad = onLoad;
        this.generation = 0;
        this.loaded = null;   // the last analysis result, once it lands
        this.status = "empty";
        if (sample) this.set(String(sample));
        else this.randomize();
    };

    options() {
        return {
            sample: {
                get: () => this.sample,
                set: (value) => {
                    const text = String(value).trim();
                    if (text.toLowerCase() === "random") return this.randomize();
                    if (!/\.\w+$/.test(text)) {
                        throw new Error(`invalid sample "${value}" — expected "random" or a path with a file extension, served under the host's "/samples/" path. A path containing spaces has to be quoted: sample="foley/a b.wav".`);
                    }
                    this.set(text);
                },
            },
            folder: {
                get: () => this.folder,
                set: (value) => {
                    const next = String(value).trim();
                    if (!next) throw new Error(`folder can't be empty — expected a folder served under the host's "/samples/" path`);
                    if (next === this.folder) return;
                    const manifest = resolvedSampleManifest(this.manifestUrl);
                    if (manifest && !sampleFolders(manifest).includes(next)) {
                        throw new Error(`unknown folder "${next}" — expected ${sampleFolders(manifest).join(", ")}`);
                    }
                    this.folder = next;
                    this.randomize();
                },
            },
        };
    };

    randomize() {
        const pick = (manifest) => {
            const candidates = manifest[this.folder] ?? [];
            if (candidates.length === 0) {
                console.warn(`${this.owner.name}: no samples in folder "${this.folder}". Available: ${sampleFolders(manifest).join(", ") || "(none)"}.`);
                return;
            }
            this.set(candidates[Math.floor(Math.random() * candidates.length)]);
        };
        const cached = resolvedSampleManifest(this.manifestUrl);
        if (cached) return pick(cached);
        const generation = ++this.generation;
        fetchSampleManifest(this.manifestUrl).then((manifest) => {
            if (generation === this.generation) pick(manifest);
        }).catch((error) => {
            console.warn(`${this.owner.name}: couldn't read sample manifest at ${this.manifestUrl} — ${error.message}. Set sample=<path> to load one directly.`);
        });
    };

    set(path) {
        const generation = ++this.generation;
        this.sample = path;
        this.loaded = null;
        this.status = "loading";
        return this.reanalyse(generation);
    };

    // Re-runs the analysis on the current file (a changed threshold or
    // cluster count). Cached per setting, so going back is free.
    reanalyse(generation = ++this.generation) {
        if (!this.sample) return Promise.resolve();
        const path = this.sample;
        return analyseSample(this.owner.audioContext, path, this.analysis()).then((result) => {
            if (generation !== this.generation) return;
            this.loaded = result;
            this.status = "ready";
            this.onLoad?.(result, peakGain(result.sample));
        }).catch((error) => {
            if (generation !== this.generation) return;
            this.status = "failed";
            console.warn(`${this.owner.name}: couldn't load ${path} — ${error.message}`);
        });
    };

    describe() {
        if (this.status !== "ready") return `${this.sample ?? "no sample"} (${this.status})`;
        const { sample, starts } = this.loaded;
        const name = String(this.sample).replace(/^.*\//, "");
        const sliced = this.analysis().onsets === false ? "" : ` · ${starts.length} slices`;
        return `${name} ${sample.seconds.toFixed(1)}s${sample.truncated ? ` (first ${MAX_SECONDS}s)` : ""}${sliced}`;
    };
};

function peakGain(sample) {
    let peak = 0;
    for (const channel of sample.right === sample.left ? [sample.left] : [sample.left, sample.right]) {
        for (let i = 0; i < channel.length; i++) {
            const a = Math.abs(channel[i]);
            if (a > peak) peak = a;
        }
    }
    return peak > 0 ? Math.min(20, 0.9 / peak) : 1;
};

// Copies a decoded sample for transfer into a worklet (the cached decode
// must survive — other instances and later re-analyses read it).
export function transferable(sample, from = 0, to = sample.left.length) {
    const left = sample.left.slice(from, to);
    const right = sample.right === sample.left ? left : sample.right.slice(from, to);
    const transfer = right === left ? [left.buffer] : [left.buffer, right.buffer];
    return { left, right, transfer };
};
