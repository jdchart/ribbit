import { RibbitSynth } from "../synth.js";
import { resolveDegree } from "../harmony.js";

// Converts a MIDI note number to frequency in Hz (A4 = MIDI 69 = 440Hz).
function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
};

// The default synth type: one oscillator per note, event.pitch treated as a
// MIDI note number. Starts with an empty pattern — see commands.js's
// add_event/clear_events for authoring events onto it.
export class RibbitOscSynth extends RibbitSynth {
    constructor(audioContext, { name = "oscsynth", waveform = "sawtooth" } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A basic subtractive synth voice: single oscillator per note into a gain envelope.";
        this.waveform = waveform;

        // Runtime-settable (each trigger() reads this.waveform fresh, so a
        // set applies from the next note on) — /track_1 waveform=square.
        // `choices` drives both console validation and ghost-text
        // completion; getOptions() (base class) round-trips it for sessions.
        this.options = {
            waveform: {
                get: () => this.waveform,
                set: (value) => { this.waveform = value; },
                choices: ["sine", "square", "sawtooth", "triangle"],
            },
        };
    };

    // Builds one voice per note: an oscillator through a gain envelope (a fast
    // 5ms linear attack, then an exponential decay across the note's
    // duration). Oscillators are one-shot, so a fresh one is created per hit
    // rather than reused, and stopped shortly after its envelope finishes.
    trigger(time, event, secondsPerBeat) {
        const ctx = this.audioContext;
        const durationSeconds = event.duration * secondsPerBeat;
        const midi = event.degree !== undefined ? resolveDegree(this.harmony, event.degree) : event.pitch;

        const osc = ctx.createOscillator();
        osc.type = this.waveform;
        osc.frequency.setValueAtTime(midiToFreq(midi), time);

        const voiceGain = ctx.createGain();
        voiceGain.gain.setValueAtTime(0, time);
        voiceGain.gain.linearRampToValueAtTime(event.velocity, time + 0.005);
        // exponential ramps can't reach exactly 0, hence the 0.0001 floor
        voiceGain.gain.exponentialRampToValueAtTime(0.0001, time + durationSeconds);

        osc.connect(voiceGain).connect(this.output);
        osc.start(time);
        osc.stop(time + durationSeconds + 0.05);
    };
};
