import { RibbitParamSources } from "../param.js";

// Every worklet-backed type declares its params once, as data:
//
//     const PARAMS = {
//         harm:  { value: 2, min: 0.1, max: 16 },
//         key:   { value: 0, min: -1, max: 1, rate: "a-rate", randomizable: false },
//     };
//
// and that one table becomes both the RibbitParams on the main thread
// (buildParams) and the AudioParam descriptors of its processor
// (workletParams) — so the console surface and the DSP can't disagree about
// what exists. A constructor option with the same key overrides `value`,
// which is what lets a session file's saved params and a typed
// `/add_track synth=fmperc harm=3.5` both work with no per-type code.

export function buildParams(audioContext, spec, options = {}) {
    const sources = new RibbitParamSources(audioContext);
    const params = {};
    for (const [key, { value, min = -Infinity, max = Infinity, randomizable = true }] of Object.entries(spec)) {
        const given = Number(options[key]);
        params[key] = sources.create(Number.isFinite(given) ? given : value, { min, max, randomizable });
    }
    return { sources, params };
};

export function workletParams(spec) {
    return Object.entries(spec).map(([name, { rate }]) => (rate ? { name, rate } : name));
};

// A {get,set,choices} option over a plain field, validated against `choices`
// — the shape every `options` entry has (see RibbitSynth.options). Saves a
// dozen identical four-line blocks per type.
export function choiceOption(target, field, choices, onChange) {
    return {
        get: () => target[field],
        set: (value) => {
            const text = String(value).trim();
            if (!choices.includes(text)) throw new Error(`invalid ${field} "${value}" — expected ${choices.join(", ")}`);
            target[field] = text;
            onChange?.(text);
        },
        choices,
    };
};

// An on/off option. Accepts on/off, true/false, 1/0.
export function toggleOption(target, field, onChange) {
    return {
        get: () => (target[field] ? "on" : "off"),
        set: (value) => {
            const text = String(value).trim().toLowerCase();
            if (!["on", "off", "true", "false", "1", "0"].includes(text)) throw new Error(`invalid ${field} "${value}" — expected on or off`);
            target[field] = text === "on" || text === "true" || text === "1";
            onChange?.(target[field]);
        },
        choices: ["on", "off"],
    };
};

export function isOn(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === "boolean") return value;
    const text = String(value).trim().toLowerCase();
    return text === "on" || text === "true" || text === "1";
};
