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

// ── A pattern as one line of text ───────────────────────────────────────
// "beat:pitch:duration:velocity", comma-separated — `0:60:1:0.8,1:d2:0.5:1`.
// A pitch written "d<n>" is a scale degree (resolved against the harmony at
// trigger time) rather than a MIDI note; duration and velocity are optional
// (0.25 and 1). This is what `set_events=` takes and what a pianoroll saves,
// so a whole piano-roll edit is one console command instead of dozens of
// add_event/remove_event lines.

const trim = (value) => String(Number(Number(value).toFixed(4)));

export function formatEvents(events) {
    return events.map((event) => {
        const pitch = event.degree !== undefined ? `d${trim(event.degree)}` : trim(event.pitch);
        return `${trim(event.beat)}:${pitch}:${trim(event.duration)}:${trim(event.velocity)}`;
    }).join(",");
};

// The inverse. Throws naming the bad entry, so a hand-typed pattern fails as
// a command error rather than silently dropping a note.
export function parseEvents(text) {
    if (Array.isArray(text)) return text.map((event) => new RibbitEvent(event));
    const source = String(text ?? "").trim();
    if (!source) return [];
    return source.split(",").map((entry) => {
        const [beatText, pitchText = "60", durationText, velocityText] = entry.trim().split(":");
        const degree = /^d/i.test(pitchText) ? Number(pitchText.slice(1)) : undefined;
        const pitch = degree === undefined ? Number(pitchText) : undefined;
        const event = new RibbitEvent({
            beat: Number(beatText),
            pitch,
            degree,
            duration: durationText === undefined ? 0.25 : Number(durationText),
            velocity: velocityText === undefined ? 1 : Number(velocityText),
        });
        const numbers = [event.beat, event.pitch ?? event.degree, event.duration, event.velocity];
        if (numbers.some((n) => !Number.isFinite(n)) || event.beat < 0 || event.duration <= 0) {
            throw new Error(`invalid event "${entry.trim()}" — expected beat:pitch[:duration[:velocity]], pitch a MIDI note or d<degree>`);
        }
        return event;
    });
};
