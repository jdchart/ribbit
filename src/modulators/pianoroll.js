import { RibbitModulator } from "../modulator.js";
import { RibbitParamSources } from "../param.js";
import { RibbitEvent, formatEvents, parseEvents } from "../event.js";

// A hand-written note pattern that belongs to no track.
//
// A track's own events play only on that track. A pianoroll holds the same
// kind of pattern but plays it into whatever is patched to its notes —
// `/patch source=roll dest=keys.notes`, `/patch source=roll dest=pad.notes` —
// so one part can drive several instruments at once: a melody doubled on a
// pluck and a pad, a bassline and its sub, a chord progression voiced by three
// different synths. Edit the pattern once and every instrument follows.
//
// It loops on its own `length` rather than the clock's loop, which is also
// what makes it useful next to track patterns: a 3-beat roll against a 4-beat
// loop is a polymeter for free.
//
// The pattern lives in `sequence`, deliberately not `events`: the clock plays
// any unit's `events` by calling its trigger(), which a modulator doesn't
// have. It's edited with the same commands a track's pattern takes (add_event,
// events, remove_event=, clear_events, set_events= — see commands.js's
// eventHolder), and saved through the `notes` option in the compact
// "beat:pitch:duration:velocity" form (see event.js).
export class RibbitPianoRoll extends RibbitModulator {
    constructor(audioContext, { name = "pianoroll", notes = "", length = 4, velocity = 1 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A hand-written note pattern that isn't tied to a track: loops on its own length and plays into every track patched to it (/patch source=<roll> dest=<track>.notes), so several instruments can share one part.";

        this.sequence = parseEvents(notes);
        this.length = this._parseLength(length);

        this.options = {
            // The pattern itself, as text — what a session file stores. Set
            // it to replace the whole pattern (the console's set_events= does
            // the same with a check that the notes fit).
            notes: {
                get: () => formatEvents(this.sequence),
                set: (value) => { this.sequence = parseEvents(value); },
            },
            // Loop length in beats, independent of the clock's num_beats.
            length: {
                get: () => this.length,
                set: (value) => { this.length = this._parseLength(value); },
            },
        };

        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            // Scales every note's velocity — the roll's own fader, so a doubled
            // part can be pulled back without editing a single note.
            velocity: this._paramSources.create(velocity, { min: 0, max: 1 }),
        };
    };

    _parseLength(value) {
        const beats = Number(value);
        if (!Number.isFinite(beats) || beats < 0.25) throw new Error(`invalid length "${value}" — beats, at least 0.25`);
        return beats;
    };

    // Every note whose absolute beat falls in [fromBeat, toBeat), repeating
    // every `length` beats. A note written past the end of the loop never
    // plays, the same rule a track's pattern follows against num_beats.
    generateEvents(fromBeat, toBeat) {
        if (this.sequence.length === 0) return [];
        const length = this.length;
        const velocity = this.params.velocity.getModulated();
        const events = [];
        for (let loop = Math.floor(fromBeat / length); loop * length < toBeat; loop++) {
            for (const note of this.sequence) {
                if (note.beat >= length) continue;
                const beat = loop * length + note.beat;
                if (beat < fromBeat || beat >= toBeat) continue;
                events.push(new RibbitEvent({
                    beat,
                    pitch: note.pitch,
                    degree: note.degree,
                    velocity: note.velocity * velocity,
                    duration: note.duration,
                }));
            }
        }
        return events;
    };

    describeState() {
        const count = this.sequence.length;
        return `[${count} note${count === 1 ? "" : "s"} over ${this.length} beats]`;
    };

    dispose() {
        this._paramSources.dispose();
    };
};
