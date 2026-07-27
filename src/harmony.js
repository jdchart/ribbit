// Shared musical context a synth consults at *trigger* time (not baked into
// events at authoring time) to resolve an RibbitEvent's `degree` into a MIDI
// pitch — so changing the key/scale live retunes a pattern that's already
// scheduled, rather than requiring events to be rewritten. This is the hook
// only: `scale` defaults to chromatic (every semitone), so `degree` behaves
// as a plain semitone offset from `root` until real scale/chord logic (and a
// /harmony console command to change root/scale at runtime) is built.
export function createHarmonyContext() {
    return {
        root: 60,
        scale: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    };
};

// Parses a degree/semitone list from either an actual array or the comma
// string the console produces ("0,2,4,5,7,9,11") into a validated number
// array — shared by RibbitRandomNotes' scale (constructor and runtime option)
// and the /harmony command's scale=, so the two can't drift on what a
// "list of degrees" accepts. Throws on anything empty or non-numeric.
export function parseDegreeList(value, label = "scale") {
    const list = (Array.isArray(value) ? value : String(value).split(",")).map(Number);
    if (list.length === 0 || list.some((n) => !Number.isFinite(n))) {
        throw new Error(`invalid ${label} "${value}" — expected a comma-separated list of numbers, e.g. 0,2,4,5,7,9,11`);
    }
    return list;
};

// Maps a scale-degree (may be negative, or larger than one octave) to a MIDI
// note number via `harmony.root`/`harmony.scale`, wrapping into higher/lower
// octaves as needed.
export function resolveDegree(harmony, degree) {
    const { root, scale } = harmony;
    const octave = Math.floor(degree / scale.length);
    const index = ((degree % scale.length) + scale.length) % scale.length;
    return root + scale[index] + 12 * octave;
};
