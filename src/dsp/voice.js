import { RibbitSynth } from "../synth.js";
import { resolveDegree, quantizeToTuning } from "../harmony.js";
import { WorkletNode } from "./worklet.js";
import { buildParams, toggleOption, isOn } from "./spec.js";

export const LANES = ["any", "1", "2", "3", "4", "5", "6"];

// Parses a sieve: `all`, `even`, `odd`, or `<divisor>:<remainder>` ("4:0" —
// plays when note mod 4 is 0). Returns a predicate over an integer note, and
// throws on anything else so a typo is a command error.
export function parseSieve(value) {
    const text = String(value ?? "all").trim().toLowerCase();
    if (text === "all") return { text, test: () => true };
    if (text === "even") return { text, test: (note) => note % 2 === 0 };
    if (text === "odd") return { text, test: (note) => Math.abs(note % 2) === 1 };
    const match = /^(\d+):(\d+)$/.exec(text);
    if (match) {
        const divisor = Number(match[1]);
        const remainder = Number(match[2]);
        if (divisor >= 1 && remainder < divisor) {
            return { text, test: (note) => ((note % divisor) + divisor) % divisor === remainder };
        }
    }
    throw new Error(`invalid sieve "${value}" — expected all, even, odd, or <divisor>:<remainder> like 4:0`);
};

// Base class for the synths whose voices run in an AudioWorklet (the AE
// voices, see docs/dev/ae-machine.md). Everything that isn't sound design is
// here, so a voice file is a param table, a few options, and its processor.
//
// **Params are continuous.** Each RibbitParam's ConstantSourceNode is
// connected into the processor's AudioParam of the same name (WorkletNode), so
// a ramp or a patch reaches the DSP while a note rings. Whether a voice
// *latches* a value at the strike or *follows* it is then a sound-design
// choice made in the processor, per param — the struck-object voices mostly
// latch (a drum is hit once), the sustained ones follow.
//
// **The sieve** — how one note stream orchestrates a kit. The AE machine's
// sequencer sends every note on a *lane* (its Trig family, 1..6) and every
// voice listening on that lane decides for itself whether the note is its own:
// divide the note by my number and see if the remainder is mine. So each voice
// here carries `lane` and `sieve` options and `trigger()` returns false for a
// note that isn't its own, which the clock reads as "declined" (no lamp).
// **Only a lane-stamped note is sieved**: a note from add_event, a pianoroll
// or any other generator carries no lane, and every voice simply plays it —
// so these are also ordinary ribbit synths.
//
// `spec` fields: `processor` (registered worklet name), `params` (the table
// from spec.js), `lane`/`sieve` (defaults), `quant` (whether the voice
// offers QUANT), `maxVoices`.
export class RibbitWorkletSynth extends RibbitSynth {
    constructor(audioContext, options = {}, spec) {
        super(audioContext, { name: options.name ?? spec.processor, harmony: options.harmony });
        this.spec = spec;

        const { sources, params } = buildParams(audioContext, spec.params, options);
        this._paramSources = sources;
        this.params = params;

        this.lane = LANES.includes(String(options.lane ?? spec.lane ?? "any")) ? String(options.lane ?? spec.lane ?? "any") : "any";
        this._sieve = parseSieve(options.sieve ?? spec.sieve ?? "all");
        this.quant = spec.quant ? isOn(options.quant, false) : false;

        this.options = {
            // Which sequencer lane (Trig family) this voice listens on.
            // `any` hears every lane.
            lane: {
                get: () => this.lane,
                set: (value) => {
                    const text = String(value).trim();
                    if (!LANES.includes(text)) throw new Error(`invalid lane "${value}" — expected ${LANES.join(", ")}`);
                    this.lane = text;
                },
                choices: LANES,
            },
            // Which of that lane's notes are this voice's own. No `choices`:
            // the router rejects anything outside a choices list, and
            // `<divisor>:<remainder>` is open-ended — parseSieve validates.
            sieve: {
                get: () => this._sieve.text,
                set: (value) => { this._sieve = parseSieve(value); },
            },
        };
        if (spec.quant) {
            // Snap pitch to the shared tuning (/harmony tuning=, or the
            // scale when no tuning is set). Per voice, like the AE's QUANT
            // toggle; the tuning itself is shared, like its SCALE menu.
            this.options.quant = toggleOption(this, "quant");
        }

        this.node = new WorkletNode(audioContext, spec.processor, {
            params: this.params,
            output: this.output,
            processorOptions: spec.processorOptions ?? {},
        });
        this.node.onmessage = (message) => this.onWorkletMessage?.(message);
    };

    // Whether a note belongs to this voice (see the class comment).
    accepts(event) {
        if (event.lane === undefined || event.lane === null) return true;
        if (this.lane !== "any" && this.lane !== String(event.lane)) return false;
        const note = Math.round(event.pitch ?? 60);
        return this._sieve.test(note);
    };

    // The MIDI pitch a note sounds at: its note (or resolved degree), plus
    // the sequencer's micro-detune `shift` in semitones, snapped to the
    // tuning when QUANT is on. Fractional.
    pitchOf(event) {
        const base = event.degree !== undefined ? resolveDegree(this.harmony, event.degree) : (event.pitch ?? 60);
        const pitch = base + (event.shift ?? 0);
        return this.quant ? quantizeToTuning(this.harmony, pitch) : pitch;
    };

    trigger(time, event, secondsPerBeat) {
        if (!this.accepts(event)) return false;
        this.node.post({
            type: "note",
            time,
            pitch: this.pitchOf(event),
            note: Math.round(event.pitch ?? 60),
            velocity: event.velocity ?? 1,
            duration: (event.duration ?? 0.25) * secondsPerBeat,
            ...(this.noteExtras?.(event) ?? {}),
        });
        return true;
    };

    dispose() {
        this.node.dispose();
        this._paramSources.dispose();
    };
};
