import { dspLibrary } from "./lib.js";
import { sampleUrl } from "../samples.js";
import { mulberry32 } from "../random.js";

// Main-thread audio analysis for the sample voices (`slicer`,
// `microsampler`, `multicluster`) — the part the AE machine hands to
// FluCoMa. Onsets by spectral flux, per-slice timbre descriptors, k-means.
//
// Everything here is cached per URL (and per analysis setting), because the
// multicluster idiom is *eight instances of one file*: one decode and one
// analysis, shared, is the difference between a load and eight.
//
// Long files are cut at MAX_SECONDS. A four-minute field recording decoded
// to float stereo is ~90MB, and a worklet holds its own copy; two minutes is
// plenty of material to slice and loop, and the cap is in describeState()
// output whenever it bites.
export const MAX_SECONDS = 120;

const DSP = dspLibrary();
const decoded = new Map();
const analyses = new Map();

// Decodes a library path to { left, right, sampleRate, seconds, truncated }
// (Float32Arrays, right === left for mono). Shared per (context rate, path).
export function decodeSample(audioContext, path) {
    const key = `${audioContext.sampleRate}|${path}`;
    if (!decoded.has(key)) {
        const promise = fetch(sampleUrl(path))
            .then((response) => {
                if (!response.ok) throw new Error(`${response.status} for ${path}`);
                return response.arrayBuffer();
            })
            .then((bytes) => audioContext.decodeAudioData(bytes))
            .then((buffer) => {
                const frames = Math.min(buffer.length, Math.floor(MAX_SECONDS * buffer.sampleRate));
                const left = buffer.getChannelData(0).slice(0, frames);
                const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice(0, frames) : left;
                return { left, right, sampleRate: buffer.sampleRate, seconds: frames / buffer.sampleRate, truncated: frames < buffer.length };
            });
        promise.catch(() => decoded.delete(key));
        decoded.set(key, promise);
    }
    return decoded.get(key);
};

// Yields to the event loop — analysis of a long file runs in slices so a
// load never freezes the page (or the scheduler, which is a setTimeout too).
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

// Onsets by half-wave-rectified log-spectral flux against a moving median.
// `thresh` 0..1: lower finds more onsets (it scales how far above the local
// median a flux peak must stand). `minHop` seconds: the shortest slice.
// Returns slice start positions in frames, always beginning with 0.
export async function detectOnsets(left, right, sampleRate, { thresh = 0.5, minHop = 0.05 } = {}) {
    const size = 1024;
    const hop = 512;
    const frames = Math.floor((left.length - size) / hop);
    if (frames < 4) return [0];
    const re = new Float32Array(size), im = new Float32Array(size);
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    let previous = new Float32Array(size / 2);
    let current = new Float32Array(size / 2);
    const flux = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
        const offset = f * hop;
        for (let i = 0; i < size; i++) {
            re[i] = (left[offset + i] + right[offset + i]) * 0.5 * window[i];
            im[i] = 0;
        }
        DSP.fft(re, im);
        let sum = 0;
        for (let k = 1; k < size / 2; k++) {
            const magnitude = Math.log1p(100 * Math.hypot(re[k], im[k]));
            current[k] = magnitude;
            const rise = magnitude - previous[k];
            if (rise > 0) sum += rise;
        }
        flux[f] = sum;
        const swap = previous;
        previous = current;
        current = swap;
        if ((f & 1023) === 1023) await breathe();
    }
    // Adaptive threshold: a flux frame is an onset if it's a local maximum
    // standing above the median of its neighbourhood by a margin thresh sets.
    const radius = 8;
    const margin = 0.2 + thresh * 3;
    let mean = 0;
    for (let f = 0; f < frames; f++) mean += flux[f];
    mean /= frames;
    const onsets = [0];
    const minFrames = Math.max(1, Math.round((minHop * sampleRate) / hop));
    let last = -Infinity;
    const neighbourhood = [];
    for (let f = 1; f < frames - 1; f++) {
        if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;
        neighbourhood.length = 0;
        for (let k = Math.max(0, f - radius); k <= Math.min(frames - 1, f + radius); k++) neighbourhood.push(flux[k]);
        neighbourhood.sort((a, b) => a - b);
        const median = neighbourhood[neighbourhood.length >> 1];
        if (flux[f] > median + margin * mean * 0.25 && f - last >= minFrames) {
            // A flux frame rises as its window starts to take in the onset,
            // so its start is up to a window early. The centre, less a
            // couple of milliseconds of pre-roll so no attack is clipped.
            const position = Math.max(0, f * hop + size / 2 + hop / 4 - Math.round(0.002 * sampleRate));
            if (position > 0) onsets.push(position);
            last = f;
        }
    }
    return onsets;
};

// Per-slice timbre descriptors: eight log band energies (roughly mel-spaced),
// spectral centroid, flatness, loudness and zero-crossing rate — computed on
// the slice's first 2048 frames (its attack and body, which is what makes
// "low thuds" and "metallic noise" different families).
export function sliceFeatures(left, right, sampleRate, starts) {
    const size = 2048;
    const re = new Float32Array(size), im = new Float32Array(size);
    const edges = [40, 120, 250, 500, 1000, 2000, 4000, 8000, 16000];
    const features = [];
    for (let s = 0; s < starts.length; s++) {
        const start = starts[s];
        const end = Math.min(left.length, s + 1 < starts.length ? starts[s + 1] : left.length);
        const length = Math.min(size, end - start);
        let energy = 0, crossings = 0, previous = 0;
        for (let i = 0; i < size; i++) {
            const x = i < length ? (left[start + i] + right[start + i]) * 0.5 : 0;
            const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
            re[i] = x * w;
            im[i] = 0;
            energy += x * x;
            if (i > 0 && (x < 0) !== (previous < 0)) crossings++;
            previous = x;
        }
        DSP.fft(re, im);
        const bands = new Float64Array(8);
        let centroidNum = 0, centroidDen = 0, logSum = 0, linSum = 0, bins = 0;
        for (let k = 1; k < size / 2; k++) {
            const hz = (k * sampleRate) / size;
            const power = re[k] * re[k] + im[k] * im[k] + 1e-12;
            const magnitude = Math.sqrt(power);
            centroidNum += hz * magnitude;
            centroidDen += magnitude;
            logSum += Math.log(power);
            linSum += power;
            bins++;
            for (let b = 0; b < 8; b++) if (hz >= edges[b] && hz < edges[b + 1]) bands[b] += power;
        }
        const total = bands.reduce((a, b) => a + b, 0) + 1e-12;
        const vector = Array.from(bands, (b) => Math.log10(b / total + 1e-6));
        vector.push(Math.log10(centroidNum / (centroidDen || 1) + 1));
        vector.push(Math.exp(logSum / bins) / (linSum / bins));
        vector.push(Math.log10(energy / Math.max(1, length) + 1e-9) / 4);
        vector.push(crossings / Math.max(1, length) * 10);
        features.push(vector);
    }
    return features;
};

// k-means with a seeded k-means++ start, on standardised features. Seeded so
// every instance analysing the same file lands on the same clusters.
export function kmeans(vectors, k, seed = 1) {
    const n = vectors.length;
    if (n === 0) return { labels: [], sizes: new Array(k).fill(0) };
    const dims = vectors[0].length;
    const mean = new Array(dims).fill(0), std = new Array(dims).fill(0);
    for (const v of vectors) for (let d = 0; d < dims; d++) mean[d] += v[d] / n;
    for (const v of vectors) for (let d = 0; d < dims; d++) std[d] += (v[d] - mean[d]) ** 2 / n;
    const data = vectors.map((v) => v.map((x, d) => (x - mean[d]) / (Math.sqrt(std[d]) || 1)));
    const random = mulberry32(seed);
    const distance = (a, b) => {
        let sum = 0;
        for (let d = 0; d < dims; d++) sum += (a[d] - b[d]) ** 2;
        return sum;
    };
    const centres = [data[Math.floor(random() * n)].slice()];
    while (centres.length < k) {
        const weights = data.map((v) => Math.min(...centres.map((c) => distance(v, c))));
        const total = weights.reduce((a, b) => a + b, 0);
        let pick = random() * total, index = 0;
        while (index < n - 1 && pick > weights[index]) pick -= weights[index++];
        centres.push(data[index].slice());
    }
    const labels = new Array(n).fill(0);
    for (let iteration = 0; iteration < 40; iteration++) {
        let changed = false;
        for (let i = 0; i < n; i++) {
            let best = 0, bestDistance = Infinity;
            for (let c = 0; c < k; c++) {
                const dd = distance(data[i], centres[c]);
                if (dd < bestDistance) { bestDistance = dd; best = c; }
            }
            if (labels[i] !== best) { labels[i] = best; changed = true; }
        }
        for (let c = 0; c < k; c++) {
            const members = data.filter((_, i) => labels[i] === c);
            if (members.length === 0) continue;
            for (let d = 0; d < dims; d++) centres[c][d] = members.reduce((a, v) => a + v[d], 0) / members.length;
        }
        if (!changed) break;
    }
    // Order clusters by mean centroid (low thuds first), so cluster 0 is
    // always the darkest family — an index that means something.
    const centroidDim = 8;
    const order = centres.map((c, i) => ({ i, value: c[centroidDim] })).sort((a, b) => a.value - b.value).map((entry) => entry.i);
    const rank = new Array(k);
    order.forEach((original, position) => { rank[original] = position; });
    const ranked = labels.map((label) => rank[label]);
    const sizes = new Array(k).fill(0);
    for (const label of ranked) sizes[label]++;
    return { labels: ranked, sizes };
};

// Decode + onsets (+ clusters when asked), cached per setting. Resolves to
// { sample (decoded), starts, labels, sizes }.
export function analyseSample(audioContext, path, { onsets = true, thresh = 0.5, minHop = 0.05, clusters = 0, seed = 1 } = {}) {
    const key = `${audioContext.sampleRate}|${path}|${onsets}|${thresh}|${minHop}|${clusters}|${seed}`;
    if (!analyses.has(key)) {
        const promise = decodeSample(audioContext, path).then(async (sample) => {
            const starts = onsets ? await detectOnsets(sample.left, sample.right, sample.sampleRate, { thresh, minHop }) : [0];
            if (!clusters) return { sample, starts, labels: null, sizes: null };
            if (starts.length < clusters) {
                return { sample, starts, labels: null, sizes: null, warning: `${starts.length} slices can't make ${clusters} clusters — lower thresh or clusters` };
            }
            const features = sliceFeatures(sample.left, sample.right, sample.sampleRate, starts);
            const { labels, sizes } = kmeans(features, clusters, seed);
            return { sample, starts, labels, sizes };
        });
        promise.catch(() => analyses.delete(key));
        analyses.set(key, promise);
    }
    return analyses.get(key);
};
