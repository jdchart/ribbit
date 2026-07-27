// A single scheduled note/hit on a synth's `events` list. `beat` is
// loop-relative (0 to the clock's loopLengthBeats); `duration` is in beats, not
// seconds (the clock converts using its current tempo at trigger time). Plain
// data only — synths interpret `pitch`/`velocity` however suits them (e.g. as a
// MIDI note vs. as a sample-slot index).
export class RibbitEvent {
    constructor({ beat, pitch, degree, velocity = 1, duration = 0.25 }) {
        this.beat = beat;
        // If neither is given, fall back to a plain MIDI note. `degree` (a
        // scale-degree offset) is resolved against the shared harmony
        // context at *trigger* time, not here — see harmony.js — so a
        // pattern retunes live if the key/scale changes later instead of
        // baking in a pitch at authoring time.
        this.pitch = pitch === undefined && degree === undefined ? 60 : pitch;
        this.degree = degree;
        this.velocity = velocity;
        this.duration = duration;
    };
};
