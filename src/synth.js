import { createHarmonyContext } from "./harmony.js";

// Base class for every sound-producing voice (see oscsynth.js, sampler.js).
// A track's `.source` is always an RibbitSynth subclass. Subclasses connect
// their own Web Audio nodes into the inherited `this.output` GainNode and
// override `trigger()`; everything else (event storage, the active/pause
// flag) is handled generically here so a new synth only needs to implement
// sound generation.
export class RibbitSynth {
    constructor(audioContext, { name = "synth", harmony } = {}) {
        this.llm_summary = "The basic synth class.";
        this.name = name;

        this.audioContext = audioContext;
        this.output = audioContext.createGain();

        // Ribbit.createSynth passes its one shared harmony context down so
        // every synth resolves scale degrees consistently; falls back to a
        // fresh (chromatic) one for standalone use, e.g. in isolation/tests.
        this.harmony = harmony ?? createHarmonyContext();

        this.events = [];
        this.automation = [];
        this.params = {};

        // Non-rampable runtime settings, the counterpart to `params`: each
        // entry is { get(), set(value), choices? } for a value with no
        // AudioParam behind it (a waveform name, a degree list). One
        // declaration drives everything — console get/set (commands.js's
        // applyOptions), help text, ghost-text completion (via `choices`),
        // and session round-tripping (getOptions below derives from this
        // map, so subclasses no longer override it).
        this.options = {};

        // Whether the clock schedules this synth's events/automation at all
        // (a transport pause, toggled by /track_1 start|stop), not a param.
        this.active = true;
    };

    // Adds a note/hit to this synth's pattern; returns it so callers can hold
    // onto the reference (e.g. to remove it later).
    addEvent(event) {
        this.events.push(event);
        return event;
    };

    addAutomation(event) {
        this.automation.push(event);
        return event;
    };

    // Called by RibbitClock once per due event, with a precise AudioContext
    // timestamp. Subclasses build fresh Web Audio nodes here (oscillators/
    // buffer sources are one-shot, so they can't be pre-built and reused) and
    // connect them into `this.output`. Base implementation is a silent no-op.
    trigger(time, event, secondsPerBeat) {};

    // Plays a note that can be let go of early — a held key. Returns a
    // release(time) function, or null if the synth declined the note.
    //
    // Synths are one-shot: a note's length is fixed at trigger(). So the
    // note is played at its longest (`event.duration`) through a gate of its
    // own, and releasing fades the gate. The gate works by pointing
    // `this.output` at it for the duration of the trigger() call — every
    // node-graph synth builds its voice and connects it to `this.output`
    // right there — so no synth needs to know about it. A synth whose voices
    // live in a persistent worklet (the AE voices) never connects anything
    // new, and so rings its full length regardless.
    triggerHeld(time, event, secondsPerBeat) {
        const ctx = this.audioContext;
        const output = this.output;
        const gate = ctx.createGain();
        gate.connect(output);
        this.output = gate;
        let played;
        try {
            played = this.trigger(time, event, secondsPerBeat);
        } finally {
            this.output = output;
        }
        if (played === false) {
            gate.disconnect();
            return null;
        }
        let released = false;
        return (at = ctx.currentTime, fade = 0.08) => {
            if (released) return;
            released = true;
            gate.gain.setValueAtTime(1, at);
            gate.gain.setTargetAtTime(0, at, fade / 4);
            setTimeout(() => gate.disconnect(), Math.max(0, at - ctx.currentTime + fade * 2 + 0.1) * 1000);
        };
    };

    // Everything a subclass needs beyond `params` to fully reconstruct
    // itself (e.g. RibbitOscSynth's waveform), derived from the `options` map
    // above — the same keys are accepted back by the constructor, so
    // session save/load round-trips without a per-class serializer. See
    // session.js, which calls this when serializing a track's synth.
    getOptions() {
        const out = {};
        for (const [key, option] of Object.entries(this.options)) out[key] = option.get();
        return out;
    };
};
