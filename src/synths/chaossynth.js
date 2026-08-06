import { RibbitSynth } from "../synth.js";
import { RibbitParamSources } from "../param.js";
import { resolveDegree } from "../harmony.js";
import { mulberry32, randomSeed } from "../random.js";

function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
};

// Ceiling on how long one note renders for. The inner loop is per-sample and
// costs far more than karplus's, so an eight-bar note at 40bpm would be both a
// huge buffer and a visible stall; nothing this instrument does is musical
// past this anyway.
const MAX_NOTE_SECONDS = 8;

// How often the loudness -> cutoff path is recomputed, in samples. The Max
// patch measures with `fluid.loudness~ @hopsize 64`, so this is the original's
// own control rate rather than a shortcut — and it is what makes the note
// affordable, since the log and the exp on that path would otherwise run at
// audio rate. The coefficient is interpolated across the block (the patch
// smooths the same signal with a 2ms `line~`), so a hop is not audible as a
// step.
const CONTROL_HOP = 64;

// One seeded configuration per MIDI note. 128 is the whole MIDI range, so
// every note a generator can produce has a state waiting for it and nothing
// has to wrap.
const STATE_COUNT = 128;

// The ten control points, in the order the original patch's `unpack` feeds
// them to the subpatcher's inlets — voice A's five, then voice B's. Declared
// once because three things need the same order and the same names: the
// `params` map, the seeded state table's columns, and describeState().
const INPUTS = [
    "a_cross", "a_drive", "a_pitch", "a_res", "a_track",
    "b_cross", "b_drive", "b_pitch", "b_res", "b_track",
];

// A chaotic two-voice feedback synthesizer.
//
// This is a recreation of the "chaotic synthesiser" subpatcher in the Max/MSP
// patch at `.claude/context/regression.maxpat`, where it sat downstream of a
// `fluid.mlpregressor~` that predicted its ten inputs from a 2D pad. The ten
// inputs are reproduced exactly, in the patch's own order and its own 0..1
// range; what replaces the regressor here is a seed (see below).
//
// **The algorithm.** Two identical voices, cross-coupled. Each voice is:
//
//     freq   = mtof((other_voice_out * cross + pitch) * 69)
//     osc    = sin(freq)
//     driven = osc * dbtoa(drive * 50)
//     sat    = atan(driven)                        <- hard bound at +-pi/2
//     out    = lowpass(sat, cutoff, res * 0.96)
//     cutoff = mtof(130 - (loudness_db(out) + 120) * track)
//
// Two nested feedback loops, which is where the chaos comes from. The inner
// one is per voice and *negative*: the filter's cutoff is driven by how loud
// that voice's own output is, so getting louder closes the filter, which makes
// it quieter, which opens it again — a self-regulating loop that hunts rather
// than settling. The outer one is between the voices and *frequency*: each
// oscillator's pitch is modulated at audio rate by the other's filtered
// output, so neither voice has a pitch of its own for more than an instant.
// Small changes in the ten inputs give completely different results, and
// that's the instrument, not a defect.
//
// **Why it renders into an AudioBuffer**, the same choice `synths/karplus.js`
// makes and for a sharper version of the same reason: Web Audio forces any
// feedback cycle to at least one render quantum (128 samples) of delay. Both
// loops here are single-sample by nature — a 128-sample lag in the cross
// coupling makes it a different dynamical system, not a slightly worse one —
// and the envelope follower on the inner loop has no node equivalent at all.
// Rendering directly is exact and, like karplus, needs no AudioWorklet module
// for the host to serve.
//
// **Two substitutions**, both documented rather than hidden. `lores~` becomes
// a Chamberlin state-variable filter: the cutoff is remodulated every 64
// samples and a biquad recomputing coefficients that fast can go unstable,
// which an SVF does not. `fluid.loudness~` becomes a one-pole RMS follower
// read at the same 64-sample hop; it is a smoother control signal than a
// windowed loudness measure, and this loop wants smooth.
//
// **What a MIDI note means here.** Not pitch — a *state*. The seed builds one
// configuration of all ten inputs per MIDI note, and playing note 60 selects
// configuration 60. So any existing note generator becomes a way to sequence
// timbres: a `markovpercs` rhythm, a `chorale` progression or a hand-written
// pattern all drive this into a sequence of different chaotic states rather
// than a melody. `spread` sets how far a note is allowed to depart from the
// ten params you set by hand (0 = not at all, so every note is identical and
// the params are the whole sound; 1 = the seeded state outright), and
// `pitch_track` restores as much conventional pitch behaviour as you want.
//
// Polyphony is free, as in karplus: each trigger renders and starts its own
// one-shot BufferSource, so a chord is several overlapping chaotic systems
// with no voice allocator to run out.
export class RibbitChaosSynth extends RibbitSynth {
    constructor(audioContext, {
        name = "chaossynth",
        harmony,
        seed = 1,
        output = "stereo",
        a_cross = 0.12,
        a_drive = 0.45,
        a_pitch = 0.55,
        a_res = 0.6,
        a_track = 0.5,
        b_cross = 0.18,
        b_drive = 0.4,
        b_pitch = 0.62,
        b_res = 0.55,
        b_track = 0.55,
        spread = 0.35,
        pitch_track = 0,
        attack = 0.01,
        release = 0.25,
    } = {}) {
        super(audioContext, { name, harmony });
        this.llm_summary = "A chaotic two-voice cross-coupled feedback synth, rendered per note. Ten 0..1 control points; a seed gives every MIDI note its own configuration, so a note selects a timbre rather than a pitch.";

        this.seed = Math.floor(seed);
        this.outputMode = output;
        this._states = null;

        this.options = {
            // Which set of 128 configurations is in force. Everything about
            // the seeded half of the sound follows from this one number, which
            // is what makes a saved session reproduce: the table is rebuilt
            // from the seed on load, never stored.
            seed: {
                get: () => this.seed,
                set: (value) => {
                    if (typeof value === "string" && value.trim().toLowerCase() === "random") {
                        this.seed = randomSeed();
                    } else {
                        const parsed = Number(value);
                        if (!Number.isFinite(parsed)) {
                            throw new Error(`invalid seed "${value}" — expected a number or "random"`);
                        }
                        this.seed = Math.floor(parsed);
                    }
                    this._states = null;
                },
            },
            // The two voices are genuinely separate signals, so the patch's
            // two outlets went to a stereo pair and so do these. `a` and `b`
            // are for hearing one voice on its own, which is the fastest way
            // to work out which half of a state is doing what.
            output: {
                get: () => this.outputMode,
                set: (value) => { this.outputMode = value; },
                choices: ["stereo", "mono", "a", "b"],
            },
        };

        // Every one of the ten is 0..1 because that is what the original
        // patch's multislider was (`setminmax [0. 1.]`), feeding ten inlets
        // that each apply their own scaling inside. Keeping the user-facing
        // range identical means a set of numbers from the Max patch can be
        // typed in here unchanged, and it makes bulk `/<track> random` a
        // uniform draw over the same space the regressor was trained on.
        //
        // They ride silent ConstantSourceNodes: the rendering is pure JS, so
        // there is no AudioParam in the graph to hang them off (see
        // RibbitParamSources for the Web Audio quirk that makes that class
        // necessary rather than a one-liner).
        this._paramSources = new RibbitParamSources(audioContext);
        const unit = { min: 0, max: 1 };
        this.params = {
            // How hard voice B's output frequency-modulates voice A. The
            // coupling, and so the chaos knob: at 0 the voices are two
            // independent drones, and by 0.3 neither has a stable pitch.
            a_cross: this._paramSources.create(a_cross, unit),
            // Pre-saturation gain, 0..50dB into an atan. Timbre rather than
            // level — atan bounds the result either way, so this is how much
            // of the sine survives as a sine.
            a_drive: this._paramSources.create(a_drive, unit),
            // Base pitch, as 0..1 mapped onto MIDI 0..69 — so 1 is A440 and
            // the useful drone range is the bottom two thirds. Whatever the
            // cross coupling adds rides on top of this.
            a_pitch: this._paramSources.create(a_pitch, unit),
            // Filter resonance, scaled by 0.96 as in the patch. That ceiling
            // is not decoration: this filter's cutoff is being modulated by
            // its own output, and at 1 the loop self-oscillates into a
            // scream.
            a_res: this._paramSources.create(a_res, unit),
            // How much the voice's own loudness closes its filter — the inner
            // feedback loop's depth. 0 leaves the filter wide open and the
            // voice is a plain saturated oscillator; 1 is the full 120dB
            // sweep, and the voice breathes and stutters on its own.
            a_track: this._paramSources.create(a_track, unit),

            b_cross: this._paramSources.create(b_cross, unit),
            b_drive: this._paramSources.create(b_drive, unit),
            b_pitch: this._paramSources.create(b_pitch, unit),
            b_res: this._paramSources.create(b_res, unit),
            b_track: this._paramSources.create(b_track, unit),

            // How far a note's seeded configuration is allowed to pull the ten
            // above. A straight lerp: 0 is the params exactly (every note
            // identical — the instrument played as a fixed sound), 1 is the
            // seeded state outright (the params stop mattering). In between,
            // the params are a centre and the seed decides how each note
            // departs from it, which is the way it's meant to be played.
            spread: this._paramSources.create(spread, unit),
            // How much the MIDI note *also* behaves like a pitch, on top of
            // selecting a state. At 0 a note is purely an index and a rising
            // line is not a rising sound; at 1 the note is added to both
            // voices' base pitch in semitones, so note 69 puts an uncoupled
            // voice at A440 and melodic material reads as melodic.
            pitch_track: this._paramSources.create(pitch_track, unit),

            // The envelope around the rendered chaos. Kept short by default
            // because the interesting transient is the system winding up from
            // silence, and a slow attack hides exactly that.
            attack: this._paramSources.create(attack, { min: 0, max: 2 }),
            release: this._paramSources.create(release, { min: 0.005, max: 4 }),
        };
    };

    // Required: the param sources route into the context destination, which
    // the generic output.disconnect() never reaches.
    dispose() {
        this._paramSources.dispose();
    };

    // The seeded table: one row of ten absolute targets per MIDI note, built
    // lazily and thrown away whenever the seed changes. Drawn from one
    // mulberry32 stream in note order, so note 60's configuration depends on
    // the seed alone and not on what has been played.
    //
    // Uniform in the same 0..1 the params live in, deliberately. A chaotic
    // system has no "sensible" region to draw from that isn't just a taste —
    // `spread` is where that taste belongs, since it lets the player put the
    // centre wherever they like and decide how far the seed may drag it.
    _stateTable() {
        if (this._states) return this._states;
        const random = mulberry32(this.seed);
        const states = [];
        for (let note = 0; note < STATE_COUNT; note++) {
            const row = new Float64Array(INPUTS.length);
            for (let i = 0; i < INPUTS.length; i++) row[i] = random();
            states.push(row);
        }
        this._states = states;
        return states;
    };

    // The ten values a given note actually plays with: each param lerped
    // toward that note's seeded target by `spread`.
    //
    // `modulated` follows the split RibbitParam draws. trigger() passes true,
    // so a patch into (say) `a_cross` is seen — once per note, which for this
    // instrument is the right grain anyway. describeState() passes false,
    // because a patched param's summed value is only readable while the graph
    // is actually rendering: a `/drone` typed before `/start` would otherwise
    // print 0.00 for exactly the params someone had bothered to patch.
    _resolveState(midi, modulated) {
        const targets = this._stateTable()[((midi % STATE_COUNT) + STATE_COUNT) % STATE_COUNT];
        const read = (param) => (modulated ? param.getModulated() : param.get());
        const spread = read(this.params.spread);
        const state = {};
        for (let i = 0; i < INPUTS.length; i++) {
            const key = INPUTS[i];
            const centre = read(this.params[key]);
            state[key] = centre + (targets[i] - centre) * spread;
        }
        return state;
    };

    // Renders both voices into `left`/`right`, one sample at a time.
    //
    // The two voices are stepped in lockstep and each reads the other's
    // *previous* sample, which is the tightest coupling a serial loop can
    // express and the one the algorithm assumes. (Max's own send~/receive~
    // pair imposes a signal vector of delay here; a single sample is the
    // ideal version of the same connection, and a more responsive system.)
    _render(state, semitones, left, right, sampleRate) {
        const totalSamples = left.length;

        // Per voice: base phase increment at zero coupling, the coupling
        // depth expressed in the exp() the FM needs, drive as a linear gain,
        // and the filter's resonance and tracking depth.
        const voices = ["a", "b"].map((prefix) => {
            // 0..1 -> MIDI 0..69, plus whatever pitch_track lets the note add.
            const baseMidi = state[`${prefix}_pitch`] * 69 + semitones;
            // freq = mtof(base + cross_in * cross * 69), and mtof is
            // exponential, so the modulation is a multiply on the increment:
            // 2^(x*69/12) = exp(x * 3.9827...). Precomputing that constant is
            // what keeps the inner loop to one exp per voice per sample.
            return {
                increment: midiToFreq(baseMidi) / sampleRate,
                fmScale: (state[`${prefix}_cross`] * 69 * Math.LN2) / 12,
                gain: Math.pow(10, (state[`${prefix}_drive`] * 50) / 20),
                resonance: state[`${prefix}_res`] * 0.96,
                track: state[`${prefix}_track`],
                phase: 0,
                low: 0,
                band: 0,
                meanSquare: 0,
                f: 0,
                fStep: 0,
                damp: 2,
                out: 0,
            };
        });

        // ~20ms one-pole on the mean square, matching the window
        // fluid.loudness~ measures over at its defaults.
        const followerCoefficient = 1 - Math.exp(-1 / (0.02 * sampleRate));
        // The SVF is only stable while its cutoff stays below a quarter of the
        // sample rate; mtof(130) is about 14.9kHz, so at 44.1k and above this
        // ceiling is above anything the formula asks for and only bites on an
        // unusually low-rate context.
        const maxCutoff = sampleRate * 0.24;
        const twoPi = 2 * Math.PI;

        for (let i = 0; i < totalSamples; i++) {
            // Control rate: the loudness -> cutoff path, at the patch's own
            // 64-sample hop. The new coefficient is reached by a linear ramp
            // across the block rather than stepped, so the filter glides.
            if (i % CONTROL_HOP === 0) {
                const remaining = Math.min(CONTROL_HOP, totalSamples - i);
                for (const voice of voices) {
                    // A voice that has diverged is reset rather than allowed
                    // to fill the rest of the buffer with NaN — one bad sample
                    // in a feedback loop poisons everything after it, and a
                    // buffer of NaN is silence plus a click, not a warning.
                    if (!Number.isFinite(voice.low) || !Number.isFinite(voice.band) || !Number.isFinite(voice.meanSquare)) {
                        voice.low = voice.band = voice.meanSquare = 0;
                    }

                    // 20*log10(rms) is 10*log10(meanSquare); the floor keeps
                    // log(0) out and is below the -120 clip anyway.
                    const db = Math.max(-120, Math.min(0, 10 * Math.log10(voice.meanSquare + 1e-13)));
                    // The patch's `!-~ 130` after scaling: silence leaves the
                    // filter at MIDI 130 (wide open), full scale drags it down
                    // to MIDI 10 at track=1. Louder is darker.
                    const cutoff = Math.max(20, Math.min(maxCutoff, midiToFreq(130 - (db + 120) * voice.track)));
                    const target = 2 * Math.sin(Math.PI * cutoff / sampleRate);
                    voice.fStep = (target - voice.f) / remaining;
                    // Chamberlin damping, with the standard stability guard —
                    // without the second term a high cutoff and a high
                    // resonance together put the filter over the edge.
                    voice.damp = Math.min(
                        2 * (1 - Math.pow(voice.resonance, 0.25)),
                        Math.min(2, 2 / target - target * 0.5),
                    );
                }
            }

            for (let v = 0; v < 2; v++) {
                const voice = voices[v];
                const other = voices[1 - v];

                voice.f += voice.fStep;

                // The outer loop: the other voice's last output bends this
                // one's pitch, exponentially, because the patch's chain is
                // `+~ -> *~ 69 -> mtof~`.
                voice.phase += voice.increment * Math.exp(other.out * voice.fmScale);
                if (voice.phase >= 1) voice.phase -= Math.floor(voice.phase);

                // Oscillator -> drive -> atan. atan is the reason this whole
                // thing stays bounded: however far the drive and the coupling
                // push it, what reaches the filter never leaves +-pi/2.
                const excited = Math.atan(Math.sin(voice.phase * twoPi) * voice.gain);

                // Chamberlin state-variable filter, lowpass output.
                voice.low += voice.f * voice.band;
                const high = excited - voice.low - voice.damp * voice.band;
                voice.band += voice.f * high;

                voice.out = voice.low;
                // The inner loop's measurement, fed back at the next hop.
                voice.meanSquare += followerCoefficient * (voice.out * voice.out - voice.meanSquare);
            }

            // The patch's `*~ 0.1` on each outlet, then a hard clip.
            //
            // The clip is not insurance, it does real work: atan bounds what
            // reaches the filter to +-pi/2, but a resonant lowpass has gain at
            // its cutoff, and near res=1 that is enough to put the scaled
            // output past full scale. Measured peak with all ten inputs at 1
            // is exactly 1.0 (i.e. clipping); at the defaults it is about
            // 0.35. Distorting at the top of the range is the right behaviour
            // for this instrument — the alternative is a gain stage that makes
            // every ordinary setting quieter to protect the extreme one.
            const a = Math.max(-1, Math.min(1, voices[0].out * 0.1));
            const b = Math.max(-1, Math.min(1, voices[1].out * 0.1));

            switch (this.outputMode) {
                case "mono": left[i] = right[i] = (a + b) * 0.5; break;
                case "a": left[i] = right[i] = a; break;
                case "b": left[i] = right[i] = b; break;
                // The patch's two outlets went to a stereo pair; so do these.
                default: left[i] = a; right[i] = b;
            }
        }
    };

    trigger(time, event, secondsPerBeat) {
        const ctx = this.audioContext;
        const sampleRate = ctx.sampleRate;

        // A degree resolves against the shared harmony context like any other
        // synth's, even though the result indexes a state table rather than a
        // pitch — so a chorale or a scale-aware generator patched in here
        // selects states along its scale, and `pitch_track` decides whether
        // that is also audible as melody.
        const midi = event.degree !== undefined ? resolveDegree(this.harmony, event.degree) : event.pitch;
        const state = this._resolveState(Math.round(midi), true);
        const semitones = this.params.pitch_track.getModulated() * (midi - 69);

        const attack = this.params.attack.getModulated();
        const release = this.params.release.getModulated();

        // Unlike a plucked string, this has no natural decay — it would run
        // forever — so the written duration is the note, and the buffer is
        // exactly long enough to cover it plus the release tail.
        const durationSeconds = Math.max(0.01, (event.duration ?? 0) * secondsPerBeat);
        const renderSeconds = Math.min(MAX_NOTE_SECONDS, durationSeconds + release);
        const totalSamples = Math.max(CONTROL_HOP, Math.ceil(renderSeconds * sampleRate));

        const buffer = ctx.createBuffer(2, totalSamples, sampleRate);
        this._render(state, semitones, buffer.getChannelData(0), buffer.getChannelData(1), sampleRate);

        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const voiceGain = ctx.createGain();
        const peak = Math.max(0.0001, event.velocity);
        voiceGain.gain.setValueAtTime(0.0001, time);
        if (attack > 0) voiceGain.gain.exponentialRampToValueAtTime(peak, time + Math.min(attack, durationSeconds));
        else voiceGain.gain.setValueAtTime(peak, time);
        voiceGain.gain.setValueAtTime(peak, time + durationSeconds);
        voiceGain.gain.exponentialRampToValueAtTime(0.0001, time + durationSeconds + release);

        source.connect(voiceGain).connect(this.output);
        source.start(time);
        // Must follow start() — calling stop() on a source that hasn't been
        // started throws InvalidStateError.
        source.stop(time + renderSeconds + 0.01);
    };

    // The seed and `spread` between them decide most of what is heard, and
    // neither is legible as a number — so print the state one note actually
    // resolves to. Middle C is the reference because it's what a bare
    // `add_event` defaults near, and the ten columns are in the same order as
    // the params, so a line here can be read straight back as commands.
    describeState() {
        const state = this._resolveState(60, false);
        const columns = INPUTS.map((key) => `${key}=${state[key].toFixed(2)}`).join(" ");
        return `seed ${this.seed}, note 60 -> ${columns}`;
    };
};
