import { RibbitModulator } from "../modulator.js";
import { RibbitParamSources } from "../param.js";
import { RibbitEvent } from "../event.js";
import { parseDegreeList } from "../harmony.js";

// The modes and scales a chord can be built out of, as semitone offsets
// within one octave.
//
// These are *degrees* in the engine's sense (see harmony.js), which means they
// are semitones only while the shared harmony context keeps its default
// chromatic scale — the state every shipped session is in. Set a non-chromatic
// `/harmony scale=` and they resolve as steps of that scale instead, which is
// the same double-mapping RibbitRandomNotes' `scale` option already has. The
// layering is deliberate: `/harmony scale=` is the tuning of the whole
// session, `mode` here is which colour this one generator draws chords from.
//
// The last three are not modes of the major scale, and are included because
// they voice differently under thirds-stacking: harmonic minor for its
// augmented second, pentatonic (5 notes) and wholetone (6) because a stack of
// "thirds" in a scale that isn't 7 notes long produces quartal and augmented
// chords for free rather than needing a separate chord vocabulary.
const MODES = {
    ionian: [0, 2, 4, 5, 7, 9, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    aeolian: [0, 2, 3, 5, 7, 8, 10],
    locrian: [0, 1, 3, 5, 6, 8, 10],
    harmonicminor: [0, 2, 3, 5, 7, 8, 11],
    pentatonic: [0, 2, 4, 7, 9],
    wholetone: [0, 2, 4, 6, 8, 10],
};

// An event-generating modulator (see modulators/randomnotes.js for how the
// `.notes` patch mechanism works) that produces a *continuous, overlapping*
// pad: several sustained voices moving through a chord progression, each
// re-attacking on its own staggered schedule so a new note always blooms in
// before the last one has died.
//
// The four existing generators differ in what decides whether a hit happens —
// a dice roll (randomnotes), the previous step (markovpercs), the step's own
// index (euclidpercs), a file a person wrote (patternvariator). This one's
// answer is different again and is the reason it exists: **a voice's note
// elapsed**. There is no rhythm and nothing random. Every note is a pure
// function of the absolute beat, the mode and the progression, so the texture
// is the same on every pass and after any /stop /start — a bed to put other
// things on top of, not a pattern that develops.
//
// Two independent clocks run underneath, and keeping them independent is the
// whole design:
//
//   the chord clock   every `chord_beats`, the progression advances one entry.
//   the voice clock   every `note_beats`, each voice re-attacks — but staggered
//                     across the voices by `stagger`, and holding for longer
//                     than its own period by `overlap`.
//
// Because a voice takes whatever chord is current *at its own attack time*,
// nothing lines up the two: a voice that attacked before a chord change holds
// its old note across it, which is where the suspensions and the sense of one
// harmony dissolving into the next come from. Making `note_beats` divide
// `chord_beats` evenly is how you turn that off.
//
// Voice leading is positional rather than remembered. Each voice has a fixed
// register anchor spread across `spread` octaves, and always takes chord tone
// `v % chord_size` placed in the octave nearest that anchor. Two things fall
// out of it: the chord is always fully voiced with no doublings (as long as
// there are at least as many voices as tones), and a voice moves by the
// smallest interval that keeps it in its own register when the chord changes —
// which is what makes this sound like harmony rather than like arpeggios.
// A remembered previous-note approach would voice-lead slightly better and
// would need cursor state, an onClockStart() reset, and would drift if a
// lookahead window were ever skipped; this is stateless for the same reason
// markovpercs indexes straight off the absolute step number.
export class RibbitChorale extends RibbitModulator {
    constructor(audioContext, {
        name = "chorale",
        mode = "aeolian",
        progression = [0, 5, 3, 4],
        chord_size = 4,
        chord_beats = 8,
        stack = 2,
        voices = 4,
        transpose = 0,
        note_beats = 8,
        overlap = 0.5,
        spread = 2,
        stagger = 1,
        velocity = 0.6,
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "Generates a continuous overlapping pad — sustained voices moving through a chord progression in a mode, with positional voice leading; feeds a polyphonic synth via /patch dest=<track>.notes.";

        this.mode = MODES[mode] ? mode : "aeolian";
        this.progression = this._parseProgression(progression);
        this.chordSize = Math.max(1, Math.floor(chord_size));
        this.chordBeats = Math.max(0.25, Number(chord_beats) || 8);
        this.stack = Math.min(4, Math.max(1, Math.floor(stack)));
        this.voices = Math.max(1, Math.floor(voices));
        this.transpose = Math.floor(Number(transpose)) || 0;

        this.options = {
            mode: {
                get: () => this.mode,
                set: (value) => { this.mode = value; },
                choices: Object.keys(MODES),
            },
            // Which degree of the mode each chord is built on, as mode *steps*
            // (0 = the tonic chord, 4 = the chord on the fifth degree), one
            // entry per chord in the cycle. Parsed by the same helper as
            // RibbitRandomNotes' scale and /harmony's scale= so the three
            // can't drift on what a list of degrees accepts; floored
            // afterwards because a step is an index into the mode.
            progression: {
                get: () => this.progression,
                set: (value) => { this.progression = this._parseProgression(value); },
            },
            // How many tones each chord has. 3 is a triad, 4 a seventh, 5 a
            // ninth. More tones than voices simply means the top ones are
            // never voiced.
            chord_size: {
                get: () => this.chordSize,
                set: (value) => {
                    const parsed = Math.floor(Number(value));
                    if (!Number.isFinite(parsed) || parsed < 1) {
                        throw new Error(`invalid chord_size "${value}" — expected a whole number >= 1`);
                    }
                    this.chordSize = parsed;
                },
            },
            // The interval between stacked chord tones, in mode steps: 2 is
            // tertian (ordinary chords), 3 quartal, 4 stacks fifths and gives
            // the open, rootless drone sound. 1 builds clusters.
            stack: {
                get: () => this.stack,
                set: (value) => {
                    const parsed = Math.floor(Number(value));
                    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 4) {
                        throw new Error(`invalid stack "${value}" — expected a whole number between 1 and 4`);
                    }
                    this.stack = parsed;
                },
            },
            // Deliberately an option rather than a param, unlike note_beats.
            // The chord in force is derived by dividing the absolute beat by
            // this, so ramping it doesn't slow the progression down — it
            // renumbers every chord boundary underneath the music and scrambles
            // the order. Setting it (optionally at=cycle) is the coherent
            // gesture.
            chord_beats: {
                get: () => this.chordBeats,
                set: (value) => {
                    const parsed = Number(value);
                    if (!Number.isFinite(parsed) || parsed < 0.25) {
                        throw new Error(`invalid chord_beats "${value}" — expected a number >= 0.25`);
                    }
                    this.chordBeats = parsed;
                },
            },
            // Added to every emitted degree, so the same generator can feed
            // two tracks an octave apart (transpose=12) or drop a bass layer
            // (-12). Distinct from `spread`, which sets how far the voices sit
            // from *each other*: this moves the whole stack without revoicing
            // it. Degrees, like patternvariator's transpose — semitones while
            // the harmony context is chromatic.
            transpose: {
                get: () => this.transpose,
                set: (value) => {
                    const parsed = Math.floor(Number(value));
                    if (!Number.isFinite(parsed)) {
                        throw new Error(`invalid transpose "${value}" — expected a whole number of degrees`);
                    }
                    this.transpose = parsed;
                },
            },
            // An option because a fractional voice has no meaning; it also
            // sets each voice's register anchor, so changing it revoices the
            // whole texture from the next attack.
            voices: {
                get: () => this.voices,
                set: (value) => {
                    const parsed = Math.floor(Number(value));
                    if (!Number.isFinite(parsed) || parsed < 1) {
                        throw new Error(`invalid voices "${value}" — expected a whole number >= 1`);
                    }
                    this.voices = parsed;
                },
            },
        };

        // Everything read fresh inside generateEvents, and every one of them
        // musical to sweep: note_beats re-attacks faster, overlap thickens the
        // texture into itself, spread fans the voices apart in register,
        // stagger collapses them from a continuous wash into block chords.
        // All four are bounded at both ends, so all four are randomizable and
        // are valid /patch destinations — an LFO into `spread` is the gesture
        // this was built to make possible.
        //
        // Backed by silent ConstantSourceNodes; see RibbitParamSources in
        // param.js for the Web Audio quirk that makes the muted sink
        // necessary.
        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            velocity: this._paramSources.create(velocity, { min: 0, max: 1 }),
            note_beats: this._paramSources.create(note_beats, { min: 0.25, max: 64 }),
            overlap: this._paramSources.create(overlap, { min: 0, max: 2 }),
            spread: this._paramSources.create(spread, { min: 0, max: 4 }),
            stagger: this._paramSources.create(stagger, { min: 0, max: 1 }),
        };
    };

    _parseProgression(value) {
        const list = parseDegreeList(value, "progression").map((n) => Math.floor(n));
        return list;
    };

    // The chord built on one entry of the progression, as degrees relative to
    // the harmony context's root. Stacks `chord_size` tones `stack` mode-steps
    // apart, carrying the octave whenever the walk runs off the top of the
    // mode — so a mode of any length (pentatonic's 5, wholetone's 6) stacks
    // correctly without a special case.
    _chordDegrees(rootStep) {
        const modeDegrees = MODES[this.mode];
        const length = modeDegrees.length;
        const tones = [];
        for (let i = 0; i < this.chordSize; i++) {
            const step = rootStep + i * this.stack;
            const octave = Math.floor(step / length);
            const index = ((step % length) + length) % length;
            tones.push(modeDegrees[index] + 12 * octave);
        }
        return tones;
    };

    // Which degree voice `v` sings of a given chord: its assigned tone,
    // transposed to whichever octave lands closest to that voice's register
    // anchor. With `voices` spread evenly over `spread` octaves, voice 0 sits
    // at the bottom and the last at the top; a single voice anchors at the
    // root. `transpose` is applied last, after the octave placement, so it
    // shifts the finished voicing rather than changing which octave each tone
    // is placed in.
    _voiceDegree(tones, v, spread) {
        const anchor = this.voices > 1 ? (v / (this.voices - 1)) * spread * 12 : 0;
        const tone = tones[v % tones.length];
        return tone + 12 * Math.round((anchor - tone) / 12) + this.transpose;
    };

    // Called by RibbitClock once per tick with an absolute (non-loop-relative)
    // beat range — see clock.js. Like markovpercs and euclidpercs this indexes
    // straight off the absolute beat rather than keeping a cursor, so it needs
    // no onClockStart() reset and realigns by itself after a /stop /start.
    generateEvents(fromBeat, toBeat) {
        const velocity = this.params.velocity.getModulated();
        const noteBeats = this.params.note_beats.getModulated();
        const overlap = this.params.overlap.getModulated();
        const spread = this.params.spread.getModulated();
        const stagger = this.params.stagger.getModulated();

        // Holding for longer than the re-attack period is what makes the pad
        // continuous: at overlap=0.5 every voice is two notes deep for a third
        // of its cycle, so it crossfades with itself instead of gapping. The
        // synth's own release runs on past this, and the two stack.
        const duration = noteBeats * (1 + overlap);
        const cycle = this.progression.length;
        const events = [];

        for (let v = 0; v < this.voices; v++) {
            // Spreading the entries evenly across one period is the whole
            // point of stagger: at 1 with four voices somebody re-attacks
            // every quarter period, at 0 they all move together and the pad
            // becomes block chords.
            const offset = stagger * noteBeats * (v / this.voices);
            // 1e-9 absorbs float error in beat arithmetic, so an attack
            // landing exactly on fromBeat isn't dropped by a rounding hair.
            let step = Math.ceil((fromBeat - offset) / noteBeats - 1e-9);
            for (; step * noteBeats + offset < toBeat; step++) {
                const beat = step * noteBeats + offset;
                if (beat < 0) continue;

                const chordIndex = Math.floor(beat / this.chordBeats + 1e-9);
                const rootStep = this.progression[((chordIndex % cycle) + cycle) % cycle];
                const degree = this._voiceDegree(this._chordDegrees(rootStep), v, spread);

                events.push(new RibbitEvent({
                    beat,
                    degree,
                    // A gentle rolloff towards the top of the stack. Voicing
                    // convention rather than decoration: with every voice at
                    // equal velocity the upper tones of a wide chord dominate
                    // and the pad turns shrill, the same reasoning behind
                    // markovpercs' on-beat accent.
                    velocity: velocity * (this.voices > 1 ? 1 - 0.25 * (v / (this.voices - 1)) : 1),
                    duration,
                }));
            }
        }

        return events;
    };

    // The whole progression as actually voiced — one group per chord, each
    // showing the degrees the voices will sing. Picked up by commands.js's
    // paramObjectSummary via the optional describeState() hook: the mode and
    // the progression steps describe how the chords were *derived*, which says
    // very little about what you're about to hear, and this is cheap because
    // the voicing is a pure function with no clock state to consult.
    describeState() {
        const spread = this.params.spread.get();
        const chords = this.progression.map((rootStep) => {
            const tones = this._chordDegrees(rootStep);
            const voiced = [];
            for (let v = 0; v < this.voices; v++) voiced.push(this._voiceDegree(tones, v, spread));
            return `${rootStep}: ${voiced.sort((a, b) => a - b).join(",")}`;
        });
        return `${this.mode} | ${chords.join(" | ")}`;
    };

    dispose() {
        this._paramSources.dispose();
    };
};
