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
        // An optional microtonal tuning, { name, cents, period } — see
        // TUNINGS below. null means "the scale, in semitones". Only voices
        // with a `quant` option read it (quantizeToTuning); `degree`
        // resolution deliberately ignores it, so setting a tuning never
        // changes what an existing degree pattern means.
        tuning: null,
    };
};

// Named tunings in cents above the root, each with the interval it repeats
// at. Cents rather than semitones because two of them can't be written in
// semitones at all: 19-EDO's step is 63 cents, and Bohlen-Pierce doesn't
// repeat at the octave but at the perfect twelfth (a 3:1 "tritave", 1902
// cents), divided into 13 equal steps. `ji_major` is 5-limit just
// intonation — pure 5/4 thirds and 3/2 fifths, audibly calmer than 12-EDO.
const edo = (steps, period = 1200) => Array.from({ length: steps }, (_, i) => (i * period) / steps);
const TRITAVE = 1200 * Math.log2(3);
export const TUNINGS = {
    chromatic: { cents: edo(12), period: 1200 },
    major: { cents: [0, 200, 400, 500, 700, 900, 1100], period: 1200 },
    minor: { cents: [0, 200, 300, 500, 700, 800, 1000], period: 1200 },
    pentatonic: { cents: [0, 200, 400, 700, 900], period: 1200 },
    wholetone: { cents: edo(6), period: 1200 },
    ji_major: { cents: [0, 203.91, 386.31, 498.04, 701.96, 884.36, 1088.27], period: 1200 },
    et19: { cents: edo(19), period: 1200 },
    bohlen_pierce: { cents: edo(13, TRITAVE), period: TRITAVE },
};

// Parses a /harmony tuning= value: a TUNINGS name, "off", or an ascending
// comma-separated cents list (the period then defaults to 1200, or comes from
// period=). Returns the tuning object, or null for "off".
export function parseTuning(value, period) {
    const text = String(value).trim().toLowerCase();
    if (text === "off" || text === "none" || text === "") return null;
    if (TUNINGS[text]) return { name: text, cents: [...TUNINGS[text].cents], period: TUNINGS[text].period };
    const cents = text.split(",").map(Number);
    const repeat = period === undefined ? 1200 : Number(period);
    if (cents.length === 0 || cents.some((c) => !Number.isFinite(c)) || !(repeat > 0)) {
        throw new Error(`invalid tuning "${value}" — expected ${Object.keys(TUNINGS).join(", ")}, off, or a cents list like 0,150,300 (with period=<cents>)`);
    }
    for (let i = 1; i < cents.length; i++) {
        if (cents[i] <= cents[i - 1] || cents[i] >= repeat) throw new Error(`invalid tuning "${value}" — cents must ascend and stay below the period (${repeat})`);
    }
    return { name: "custom", cents, period: repeat };
};

export function formatTuning(tuning) {
    if (!tuning) return "off";
    if (tuning.name !== "custom") return tuning.name;
    return `${tuning.cents.map((c) => Number(c.toFixed(2))).join(",")} period=${Number(tuning.period.toFixed(2))}`;
};

// Snaps a (possibly fractional) MIDI pitch to the nearest pitch of the shared
// tuning, anchored at `harmony.root`. With no tuning set it snaps to the
// scale, in semitones — so a voice's QUANT follows /harmony scale= by
// default and a tuning only when one is chosen. Returns fractional MIDI.
export function quantizeToTuning(harmony, midi) {
    const tuning = harmony.tuning;
    const cents = tuning ? tuning.cents : harmony.scale.map((step) => step * 100);
    const period = tuning ? tuning.period : 1200;
    const relative = (midi - harmony.root) * 100;
    const k = Math.floor(relative / period);
    const within = relative - k * period;
    let best = 0;
    let bestDistance = Infinity;
    for (const c of cents) {
        for (const candidate of [c, c + period, c - period]) {
            const distance = Math.abs(candidate - within);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = candidate;
            }
        }
    }
    return harmony.root + (k * period + best) / 100;
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
