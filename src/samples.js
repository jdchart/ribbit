// The host's sample library: what files it serves, and how a synth finds out.
// This is the samples counterpart to pattern.js — a shared loader rather than
// a type, so that two synths reading the same library share one fetch and one
// set of naming rules instead of each inventing their own.
//
// A browser can't list a directory over HTTP, so anything that picks a file at
// random is only possible if the host publishes what there is to choose from.
// Shape: { <folder>: ["<folder>/a.wav", ...], ... }, each entry a path relative
// to the same "/samples/" prefix the audio files themselves are served under.
// Reference implementation: nllc/src/routes/samples/manifest.json/+server.js.
//
// The four percussion categories (see PERC_CATEGORIES in synths/percsampler.js)
// are always present because percsampler's slot arithmetic depends on them.
// Every other folder is just a folder — `granular` reads one by name — so a
// host adding static/samples/<folder>/ needs no code change anywhere.
import { libraryUrl, createLibraryCache } from "./library.js";

export const SAMPLE_MANIFEST_URL = "/samples/manifest.json";

// Derives a short display name from a sample path, e.g.
// "kicks/CLAUDE - kick01.wav" -> "kick01". The leading folder goes because a
// slot already knows its own category; the "CLAUDE - " prefix goes because
// every file in the shipped library has it and it carries no information.
export function sampleName(filePath) {
    return String(filePath)
        .replace(/^.*\//, "")
        .replace(/^CLAUDE - /, "")
        .replace(/\.\w+$/, "");
};

// The fetchable URL for a manifest path — see libraryUrl for why building
// this by hand is a trap.
export function sampleUrl(filePath, { base = "/samples" } = {}) {
    return libraryUrl(filePath, base);
};

// The manifest describes the host's static sample folder, which doesn't change
// while the page is open, and re-rolling a kit or a grain source live
// (repeatedly, mid-set) shouldn't mean a network round trip each time — see
// createLibraryCache for both layers and why the synchronous one matters here.
const manifests = createLibraryCache();

export function fetchSampleManifest(url = SAMPLE_MANIFEST_URL) {
    return manifests.get(url);
};

// The already-resolved manifest for a URL, or null if it hasn't landed yet.
// The synchronous path; callers fall back to fetchSampleManifest.
export function resolvedSampleManifest(url = SAMPLE_MANIFEST_URL) {
    return manifests.resolved(url);
};

// Every folder name in a manifest. Used for error messages that tell you what
// you *could* have asked for.
export function sampleFolders(manifest) {
    return Object.keys(manifest ?? {});
};
