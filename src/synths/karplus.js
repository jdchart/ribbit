import { RibbitSynth } from "../synth.js";
import { RibbitParamSources } from "../param.js";
import { resolveDegree } from "../harmony.js";

function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
};

// Ceiling on how long one pluck is rendered for, in seconds. A string with a
// long decay and a low fundamental would otherwise allocate an unbounded
// buffer per note, and nothing musical needs more than this.
const MAX_RING_SECONDS = 8;

// A polyphonic Karplus-Strong plucked string.
//
// Karplus-Strong is about the simplest physical model there is: fill a short
// delay line (one wavelength long) with noise, then repeatedly read it out
// while feeding each sample back in averaged with its neighbour. The noise
// burst is the pluck; the averaging is the string losing its high harmonics
// first, which is what makes it sound like a string rather than a filtered
// oscillator.
//
// **Why this renders into an AudioBuffer instead of building a node graph.**
// The obvious Web Audio implementation is DelayNode -> lowpass -> gain ->
// back into the delay. It doesn't work above a few hundred Hz: the spec
// requires any cycle containing a DelayNode to impose at least one render
// quantum (128 samples) of delay, which at 48kHz floors the delay line at
// 2.7ms and therefore caps the fundamental at about 375Hz — roughly F#4, in
// the middle of the range you'd actually play. Running the algorithm directly
// into a buffer is exact at every pitch, needs no AudioWorklet module for the
// host to serve (the engine deliberately asks hosts for JSON manifests and
// nothing else), and costs well under a millisecond per note.
//
// Nothing is cached. Rendering is cheap next to the 100ms scheduling window,
// and a fresh noise burst per pluck is the point — a cache would make every
// repeat of a note bit-identical, which is exactly the mechanical quality the
// noise excitation exists to avoid.
//
// Polyphony is free: each trigger renders and starts its own one-shot
// BufferSource, so a chord is just four overlapping buffers and there is no
// voice allocator to run out. Notes ring for their natural decay rather than
// being cut at the event's duration, which is how a plucked string behaves —
// `duration` instead controls muting (see trigger).
export class RibbitKarplus extends RibbitSynth {
    constructor(audioContext, {
        name = "karplus",
        harmony,
        damping = 0.35,
        decay = 2,
        brightness = 0.6,
        excitation = "noise",
    } = {}) {
        super(audioContext, { name, harmony });
        this.llm_summary = "A polyphonic Karplus-Strong plucked string: a noise burst through a feedback delay line, rendered per note. Plays chords and melodies; degrees resolve against the shared harmony context.";

        this.excitation = excitation;

        this.options = {
            // What fills the delay line at the moment of the pluck. Noise is
            // the classic (a broadband burst, so every harmonic of the string
            // is excited at once); pulse is a single-sample impulse, which
            // excites the same harmonics at equal phase and reads as a much
            // cleaner, more harp-like attack.
            excitation: {
                get: () => this.excitation,
                set: (value) => { this.excitation = value; },
                choices: ["noise", "pulse"],
            },
        };

        // All three are params rather than options because sweeping them is
        // musical — opening brightness up over a phrase, or riding decay down
        // into a staccato section, is exactly what a ramp is for. Each is read
        // fresh per trigger, so a ramp applies from the next note onward.
        // They ride silent ConstantSourceNodes since there's no AudioParam in
        // the graph to hang them off (the rendering is pure JS) — see
        // RibbitParamSources for the Web Audio quirk that makes that
        // necessary.
        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            // How fast the high harmonics are lost, i.e. how much of each
            // sample is averaged with its neighbour on the way round the loop.
            // 0 is a bright, almost metallic string; 1 is a dull thud.
            damping: this._paramSources.create(damping, { min: 0, max: 1 }),
            // Seconds for the note to fall by 60dB. Converted per note into a
            // per-sample feedback coefficient (see trigger), so the decay
            // *time* is the same at every pitch — without that correction a
            // high note, whose delay line is short and therefore loops far
            // more often per second, would die away much faster than a low one.
            decay: this._paramSources.create(decay, { min: 0.05, max: MAX_RING_SECONDS }),
            // Tone of the pluck itself, before the string gets hold of it: 1
            // is the raw burst, lower values pre-soften it. Distinct from
            // damping, which governs how the string evolves after the pluck.
            brightness: this._paramSources.create(brightness, { min: 0, max: 1 }),
        };
    };

    // Required: the param sources route into the context destination, which
    // the generic output.disconnect() never reaches.
    dispose() {
        this._paramSources.dispose();
    };

    // Renders one pluck. `event.duration` is honoured only as a mute: a string
    // rings past the end of its written note, so the envelope below leaves the
    // decay alone unless the note is short enough that the author clearly
    // meant it stopped (see the release comment).
    trigger(time, event, secondsPerBeat) {
        const ctx = this.audioContext;
        const sampleRate = ctx.sampleRate;
        const midi = event.degree !== undefined ? resolveDegree(this.harmony, event.degree) : event.pitch;
        const freq = midiToFreq(midi);

        const damping = this.params.damping.getModulated();
        const decaySeconds = this.params.decay.getModulated();
        const brightness = this.params.brightness.getModulated();

        // The delay line is one wavelength long — that length *is* the pitch.
        // Floored at 2 samples so an absurdly high note degrades to noise
        // rather than dividing by zero.
        //
        // Rounding to a whole number of samples quantizes the pitch, and the
        // error grows as the line gets shorter: measured against the intended
        // frequency it stays inside ~6 cents up to C6, then widens to ~22
        // cents by G6 (a 31-sample line at 48kHz). Inaudible across the range
        // this is actually played in, and the fix — a fractional delay with
        // interpolated read-back — costs more complexity in the inner loop
        // than the top octave is worth here.
        const lineLength = Math.max(2, Math.round(sampleRate / freq));
        const ringSeconds = Math.min(decaySeconds, MAX_RING_SECONDS);
        const totalSamples = Math.max(lineLength * 2, Math.ceil(ringSeconds * sampleRate));

        // Per-sample feedback chosen so amplitude reaches -60dB (a factor of
        // 0.001) after exactly `decaySeconds`. The signal passes through the
        // whole line once per lineLength samples, so the per-round-trip loss
        // is spread over that many samples — this is the pitch compensation
        // described on the `decay` param above.
        const roundTrips = (ringSeconds * sampleRate) / lineLength;
        const feedback = Math.pow(0.001, 1 / Math.max(1, roundTrips));

        const line = new Float32Array(lineLength);
        if (this.excitation === "pulse") {
            // A single impulse: every harmonic excited in phase, giving a
            // much cleaner attack than noise.
            line[0] = 1;
        } else {
            for (let i = 0; i < lineLength; i++) line[i] = Math.random() * 2 - 1;
        }

        // Pre-soften the excitation by averaging it with itself — a cheap
        // one-pole lowpass over the burst, which is what `brightness` below 1
        // takes away. Done on the line before it starts circulating, so it
        // shapes the pluck rather than the string.
        if (brightness < 1) {
            const smooth = 1 - brightness;
            let previous = line[lineLength - 1];
            for (let i = 0; i < lineLength; i++) {
                previous = line[i] = line[i] * (1 - smooth) + previous * smooth;
            }
        }

        const buffer = ctx.createBuffer(1, totalSamples, sampleRate);
        const output = buffer.getChannelData(0);

        // The algorithm itself. `damping` sets how much of each sample is
        // mixed with the previous one on the way back into the line: more
        // averaging kills high harmonics faster, which is a duller string.
        // 0.5/0.5 is the textbook Karplus-Strong lowpass.
        const blend = 0.5 * (0.2 + 0.8 * damping);
        let index = 0;
        let previous = 0;
        for (let i = 0; i < totalSamples; i++) {
            const current = line[index];
            output[i] = current;
            line[index] = (current * (1 - blend) + previous * blend) * feedback;
            previous = current;
            index = index + 1 === lineLength ? 0 : index + 1;
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const voiceGain = ctx.createGain();
        voiceGain.gain.setValueAtTime(event.velocity, time);

        // A written note shorter than the string's natural decay is read as
        // the player damping it — a short fade rather than a hard stop, which
        // would click. A note at least as long as the decay is left to ring
        // out on its own, so the default (duration == step length) still
        // sounds like a pluck and not like a gate.
        const durationSeconds = (event.duration ?? 0) * secondsPerBeat;
        const ringTime = totalSamples / sampleRate;
        const muted = durationSeconds > 0 && durationSeconds < ringTime;
        let release = 0;
        if (muted) {
            release = Math.min(0.12, durationSeconds * 0.5);
            voiceGain.gain.setValueAtTime(event.velocity, time + durationSeconds);
            voiceGain.gain.exponentialRampToValueAtTime(0.0001, time + durationSeconds + release);
        }

        source.connect(voiceGain).connect(this.output);
        source.start(time);
        // Must follow start() — calling stop() on a source that hasn't been
        // started throws InvalidStateError.
        if (muted) source.stop(time + durationSeconds + release + 0.01);
    };
};
