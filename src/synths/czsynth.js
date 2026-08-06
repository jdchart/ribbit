import { RibbitSynth } from "../synth.js";
import { RibbitParamSources } from "../param.js";
import { resolveDegree } from "../harmony.js";
import { CZ_TONES, CZ_TONE_NAMES } from "./cz-tones.js";

function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
};

// Ceiling on how long one note renders for. A CZ note is its release — several
// of the shipped electric pianos are an instant attack straight into a decay
// lasting seconds — so this has to be generous where karplus's 8 was tight,
// and it is the only thing stopping a slow tempo and a long tail from
// allocating an unbounded buffer.
const MAX_NOTE_SECONDS = 12;

// How often the pitch path (vibrato + the DCO envelope, through an exp) is
// recomputed, in samples. Same split chaossynth makes and for the same reason:
// the audible path is per sample, the expensive control path is not. A 10Hz
// vibrato resolved every 64 samples (1.3ms at 48k) has no audible stepping,
// and it turns two exp() per sample into two per block.
const CONTROL_HOP = 64;

// The cosine table. The CZ read a stored quarter-sine at 8-bit resolution;
// this is the same idea at a size where linear interpolation is inaudible, and
// it is what keeps the inner loop to a lookup rather than a Math.cos.
const TABLE_SIZE = 4096;
// Two guard entries past the end, not one. A phase of exactly 1.0 is not a
// theoretical edge here: every distortion function except the saw *clamps* to
// it, so the flat top of a pulse lands on index TABLE_SIZE every period and
// the interpolation still reads index+1.
const COSINE_TABLE = new Float32Array(TABLE_SIZE + 2);
for (let i = 0; i < TABLE_SIZE + 2; i++) COSINE_TABLE[i] = Math.cos((2 * Math.PI * i) / TABLE_SIZE);

// `phase` must already be in [0, 1].
function cosine(phase) {
    const x = phase * TABLE_SIZE;
    const i = x | 0;
    return COSINE_TABLE[i] + (COSINE_TABLE[i + 1] - COSINE_TABLE[i]) * (x - i);
};

// The waveforms, in the CZ's own panel order. The first five are true phase
// distortion (a bent phase ramp read out of the cosine table); the last three
// are not, and are handled separately below.
const WAVES = ["saw", "square", "pulse", "doublesine", "sawpulse", "reso1", "reso2", "reso3"];
const RESO_FIRST = 5;

// The LINE SELECT and OCTAVE switch positions, as strings — see the `lines`
// option for why these can't be `choices`. "preset" is the sentinel every
// option but `preset` itself carries, meaning "whatever the tone says".
const LINE_SELECTS = ["preset", "1", "2", "1+1", "1+2"];
const OCTAVES = ["preset", "-1", "0", "1"];

// How many cycles of the inner sine fit into one period at full DCW on a
// resonant wave — i.e. the top of the simulated resonant frequency sweep. The
// CZ-1 teardown counts about fifteen at maximum.
const MAX_RESONANCE = 16;

// Output trim. Every one of these waveforms is peak-to-peak 2 by construction
// — it is a cosine table read at a funny rate — but half of them are not
// centred: a pulse at full DCW sits pinned at +1 for most of its period and
// dips to -1, so once the DC blocker has removed that offset its peak *from
// zero* is 2, not 1. Measured across the shipped tones the peaks ran from 0.68
// to 1.99, which meant a stock preset clipped at velocity 1 while a sine one
// stayed 9dB down. Trimming by half is exact rather than a guess, and makes
// the instrument's ceiling the same as everything else in the engine.
const OUTPUT_TRIM = 0.5;

// Seconds for an envelope to traverse the full 0..99 level range at a given
// rate. **This curve is fitted, not documented.** Casio published the rate
// scale but never what a rate means in seconds, and no reverse-engineering of
// the CZ has recovered it either; what is agreed is that it is exponential,
// that 99 is effectively instant and that 0 is tens of seconds.
//
// The two anchors below were chosen by working backwards from the shipped
// tones, which is the best evidence available: `5978-flute` then comes out
// with a 36ms attack, a 0.5s swell onto its sustain and a 111ms release, and
// `zander-two-bells` decays over 1.3s. Both are musically right for what they
// are named. Where a preset feels wrong, `env_time` scales every segment at
// once and is the intended correction.
const RATE_FASTEST_SECONDS = 0.008;
const RATE_SLOWEST_SECONDS = 25;
const RATE_CURVE = Math.log(RATE_SLOWEST_SECONDS / RATE_FASTEST_SECONDS) / 99;

function fullSpanSeconds(rate) {
    return RATE_FASTEST_SECONDS * Math.exp(RATE_CURVE * (99 - rate));
};

// One phase-distorted sample.
//
// Phase distortion bends the phase ramp before it reaches the cosine table
// rather than filtering what comes out. `phase` runs linearly 0..1 across a
// period; each waveform maps it through its own piecewise-linear transfer
// function, and `distortion` (0..1, the DCW) morphs that function between the
// identity — which reads out an undistorted cosine — and its fully bent shape.
// That is the whole trick, and it is why the DCW behaves like a filter cutoff
// without there being a filter anywhere: at 0 every waveform is a sine, and
// opening it up adds harmonics.
//
// The bend is always "spend part of the period sweeping fast, the rest slowly
// (or not at all)". A saw crams the falling half of the cosine into a sliver
// at the start; a square does that at both half-period boundaries and holds
// flat between them; a pulse squeezes one whole cosine cycle into a narrowing
// window and sits at the table's peak either side of it.
function distortedPhase(wave, phase, distortion) {
    switch (wave) {
        case 0: {
            // Saw. The breakpoint walks from the middle of the period (where
            // the transfer is the identity) toward the very start.
            const m = 0.5 - 0.495 * distortion;
            return phase < m ? (0.5 * phase) / m : 0.5 + (0.5 * (phase - m)) / (1 - m);
        }
        case 1: {
            // Square: the same sweep applied at both half-period boundaries,
            // clamped so the phase sits still — and the output sits at a rail
            // — for the rest of each half.
            const m = 0.5 - 0.495 * distortion;
            return phase < 0.5
                ? 0.5 * Math.min(phase / m, 1)
                : 0.5 + 0.5 * Math.min((phase - 0.5) / m, 1);
        }
        case 2: {
            // Pulse: one entire cosine cycle inside a window that narrows as
            // the DCW opens, centred in the period. Outside the window the
            // phase is pinned at a table peak, which is the flat part of the
            // pulse.
            const width = 1 - 0.99 * distortion;
            const x = (phase - (0.5 - width * 0.5)) / width;
            return x < 0 ? 0 : x > 1 ? 1 : x;
        }
        case 3: {
            // Double sine, which the CZ-1 teardown calls sine-pulse: the same
            // narrowing window as the pulse, but anchored at the start of the
            // period rather than centred. Half open it is one compressed
            // cosine cycle followed by a flat top, which is the shape Casio's
            // panel drawing shows.
            const width = 1 - 0.99 * distortion;
            const x = phase / width;
            return x > 1 ? 1 : x;
        }
        case 4: {
            // Saw-pulse: a saw whose rising segment runs at up to double rate
            // and then holds, so at full DCW it is half a sawtooth and half a
            // flat idle. Close enough to a saw to be mistaken for one, which
            // is why so many of these presets reach for it.
            const m = 0.5 - 0.495 * distortion;
            if (phase < m) return (0.5 * phase) / m;
            const x = 0.5 + ((0.5 * (phase - m)) / (1 - m)) * (1 + distortion);
            return x > 1 ? 1 : x;
        }
    }
    return phase;
};

// The per-cycle amplitude window that makes the three "resonant" waveforms.
//
// These are not phase distortion at all, and the CZ's own manual calling them
// resonant sawtooth/triangle/trapezoid has confused the point for forty years.
// What actually happens is hard sync: an inner sine runs at a multiple of the
// fundamental (DCW sets the multiple, which is what reads as a resonant peak
// sweeping) and restarts every period, and that burst is multiplied by one of
// three window shapes named after the envelope, not after the sound. So DCW on
// these three moves a *frequency*, not a brightness — the one place where the
// knob behaves unlike every other waveform.
function resonanceWindow(wave, phase) {
    switch (wave) {
        // Sawtooth window: full amplitude at the period boundary, ramping away.
        case 5: return 1 - phase;
        // Triangle window: silent at the boundaries, peaking in the middle.
        case 6: return 1 - Math.abs(2 * phase - 1);
        // Trapezoid window: held flat for half the period, then ramped away.
        default: return phase < 0.5 ? 1 : 2 * (1 - phase);
    }
};

function czSample(wave, phase, distortion) {
    if (wave >= RESO_FIRST) {
        const inner = phase * (1 + distortion * (MAX_RESONANCE - 1));
        return resonanceWindow(wave, phase) * cosine(inner - Math.floor(inner));
    }
    return cosine(distortedPhase(wave, phase, distortion));
};

// Flattens one CZ envelope into the segment list a single note actually plays.
//
// The machine's model is eight `[rate, level]` stages with a sustain point
// partway through: the stages before it run while the key is down, the level
// there is held until release, and the stages after it are the release. Because
// the gate length is known before a note renders, all of that collapses into
// one linear segment list here rather than needing a mode switch mid-render —
// including the case that gives the electric pianos their character, where the
// key is let go long before the attack has finished and the release starts from
// wherever the level happened to be.
function buildEnvelope({ steps, end }, timeScale, sampleRate, gateSamples) {
    const segments = [];
    let level = 0;
    let used = 0;

    const lengthFor = (rate, target, from) => Math.max(1, Math.round(
        fullSpanSeconds(rate) * (Math.abs(target - from) / 99) * timeScale * sampleRate,
    ));

    for (let i = 0; i < end && i < steps.length; i++) {
        const [rate, target] = steps[i];
        const samples = lengthFor(rate, target, level);
        if (used + samples >= gateSamples) {
            // The key was released partway through this stage. Stop where the
            // level had got to; that is where the release ramps from.
            const remaining = gateSamples - used;
            if (remaining > 0) {
                level += (target - level) * (remaining / samples);
                segments.push({ target: level, samples: remaining });
                used = gateSamples;
            }
            break;
        }
        segments.push({ target, samples });
        used += samples;
        level = target;
    }

    // The sustain: whatever is left of the gate, held flat.
    if (used < gateSamples) segments.push({ target: level, samples: gateSamples - used });

    for (let i = end; i < steps.length; i++) {
        const [rate, target] = steps[i];
        segments.push({ target, samples: lengthFor(rate, target, level) });
        level = target;
    }
    return segments;
};

// Walks a segment list one sample at a time, linearly between levels — the
// digital-accumulator behaviour the original hardware has, which is part of
// why CZ envelopes sound blunter than an analogue one. Past the end it holds
// its final level forever, so an envelope shorter than the note is harmless.
class EnvelopeRunner {
    constructor(segments) {
        this.segments = segments;
        this.index = -1;
        this.level = 0;
        this.remaining = 0;
        this.step = 0;
    };

    next() {
        const value = this.level;
        if (this.remaining <= 0) {
            this.index++;
            if (this.index < this.segments.length) {
                const segment = this.segments[this.index];
                this.remaining = segment.samples;
                this.step = (segment.target - this.level) / segment.samples;
            } else {
                this.remaining = Infinity;
                this.step = 0;
            }
        }
        this.level += this.step;
        this.remaining--;
        return value;
    };

    advance(count) {
        for (let i = 0; i < count; i++) this.next();
    };
};

function totalSamples(segments) {
    let total = 0;
    for (const segment of segments) total += segment.samples;
    return total;
};

// An emulation of the Casio CZ-101 (1984), the phase-distortion synthesizer
// behind most of what people mean by "the Boards of Canada sound" — the
// electric pianos, the flutes and the slightly seasick pads.
//
// **Phase distortion.** Casio's answer to Yamaha's FM patent, and a much
// simpler idea: there is no filter and no modulator oscillator. One cosine
// table is read with a phase that has been bent by a piecewise-linear transfer
// function, so a period still takes exactly one period but is traversed
// unevenly — fast through part of it, slow or stopped through the rest. The
// DCW morphs the bend between the identity and its extreme, which sounds
// remarkably like opening a filter while being nothing of the sort. See
// `distortedPhase` for the per-waveform functions and `resonanceWindow` for
// the three waveforms that work a completely different way.
//
// **The architecture is the machine's.** Up to two *lines*, each a
// DCO -> DCW -> DCA chain with its own eight-stage envelope on all three
// stages, summed and optionally detuned against each other. The DCW envelope
// is the interesting one: it is the filter sweep, except it moves harmonic
// content directly.
//
// **Why it renders into an AudioBuffer**, like `synths/karplus.js` and
// `synths/chaossynth.js`: the phase transfer function is a per-sample
// nonlinearity whose shape is being moved by an envelope, and no arrangement
// of Web Audio nodes expresses that — `WaveShaperNode` reshapes amplitude, not
// phase, and its curve is a fixed array. The alternative is an AudioWorklet
// module, which would be a new kind of obligation on every host (the engine
// only ever asks for JSON manifests). Polyphony is free as it is there: each
// trigger renders and starts its own one-shot BufferSource.
//
// **Mono, deliberately.** The CZ-101 has one output, and the FX notes for
// these patches keep summing them back to mono anyway. Width belongs to the
// delay and reverb after it, not to the instrument.
//
// **Presets are the interface here**, which is true of no other synth in the
// engine and is a consequence of the format rather than a preference: a tone
// is three eight-stage envelopes per line, and no console surface makes ninety
// numbers typable. `cz-tones.js` carries twenty-eight of them decoded from
// sysex dumps. Everything in `params` rides on top of whichever is selected —
// `dcw` especially, which scales the whole DCW envelope and so is this synth's
// filter knob: ramp it to 0 and any preset collapses to a pure sine.
export class RibbitCZSynth extends RibbitSynth {
    constructor(audioContext, {
        name = "czsynth",
        harmony,
        preset = "sixtyniner-sine-pad",
        wave = "preset",
        lines = "preset",
        mod = "preset",
        octave = "preset",
        dcw = 1,
        env_time = 1,
        detune = 0,
        vib_depth = 0,
        vib_rate = 1,
        pitch_env = 1,
        key_follow = 1,
    } = {}) {
        super(audioContext, { name, harmony });
        this.llm_summary = "A Casio CZ-101 phase-distortion voice, rendered per note. Twenty-eight Boards of Canada tones decoded from sysex ship as presets; `dcw` is the filter-like brightness knob over any of them.";

        // Constructor values are normalized rather than trusted: these arrive
        // from a session file as often as from a caller, and a hand-edited one
        // shouldn't be able to produce an octave of NaN.
        const pick = (value, allowed) => (allowed.includes(String(value)) ? String(value) : allowed[0]);
        this.preset = CZ_TONE_NAMES.includes(preset) ? preset : CZ_TONE_NAMES[0];
        this.wave = pick(wave, ["preset", ...WAVES]);
        this.lines = pick(lines, LINE_SELECTS);
        this.mod = pick(mod, ["preset", "none", "ring", "noise"]);
        this.octave = pick(octave, OCTAVES);

        // Every option except `preset` takes the sentinel "preset", meaning
        // "whatever the selected tone says". That keeps the two layers from
        // writing to each other: choosing a tone never silently clobbers an
        // override, and an override never has to be re-applied when the tone
        // changes. It is also what makes `/lead wave=square` a live gesture
        // rather than an edit — set it back to `preset` and the tone returns.
        this.options = {
            preset: {
                get: () => this.preset,
                set: (value) => {
                    const wanted = String(value).trim().toLowerCase();
                    if (wanted === "random") {
                        this.preset = CZ_TONE_NAMES[Math.floor(Math.random() * CZ_TONE_NAMES.length)];
                        return;
                    }
                    if (!CZ_TONE_NAMES.includes(wanted)) {
                        throw new Error(`unknown preset "${value}" — see "help" for the ${CZ_TONE_NAMES.length} available`);
                    }
                    this.preset = wanted;
                },
                choices: [...CZ_TONE_NAMES, "random"],
            },
            // Overrides the waveform on every line at once, combination
            // included — a preset that alternates two waveforms stops doing so
            // while this is set, since there is no longer a second one to
            // alternate with.
            wave: {
                get: () => this.wave,
                set: (value) => { this.wave = value; },
                choices: ["preset", ...WAVES],
            },
            // The LINE SELECT switch: one line, the other line, line one
            // doubled against itself, or both. Everything but "1" costs a
            // second render pass per note.
            //
            // Declared without `choices` — and so without ghost-text
            // completion — for the reason tapepad's `voices` and `bits` are:
            // the console coerces anything numeric-looking to a Number before
            // it reaches applyOptions, whose choices test is a strict
            // includes(), so a declared "1" can never match a typed 1. Same
            // story for `octave` below. Normalizing through String() here is
            // what lets both forms arrive.
            lines: {
                get: () => this.lines,
                set: (value) => {
                    const wanted = String(value).trim();
                    if (!LINE_SELECTS.includes(wanted)) {
                        throw new Error(`invalid lines "${value}" — expected ${LINE_SELECTS.join(", ")}`);
                    }
                    this.lines = wanted;
                },
            },
            // Ring multiplies the two lines instead of summing them; noise
            // jitters the second line's phase into something inharmonic. Both
            // need two lines to mean anything, and no shipped tone uses either
            // — they are the machine's, not Boards of Canada's.
            mod: {
                get: () => this.mod,
                set: (value) => { this.mod = value; },
                choices: ["preset", "none", "ring", "noise"],
            },
            octave: {
                get: () => this.octave,
                set: (value) => {
                    const wanted = String(value).trim();
                    if (!OCTAVES.includes(wanted)) {
                        throw new Error(`invalid octave "${value}" — expected ${OCTAVES.join(", ")}`);
                    }
                    this.octave = wanted;
                },
            },
        };

        // All seven are modifiers over the selected tone rather than absolute
        // settings, so that selecting a preset never has to reach in and
        // rewrite them. Each is read once per trigger like any synth param,
        // which means a ramp or a patch moves them note by note — the right
        // grain for an instrument whose every gesture is already per note.
        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            // Scales every level in both DCW envelopes. The filter knob: 0 is
            // an undistorted sine whatever the waveform, 1 is the tone as
            // dumped, and above that pushes presets past where the hardware's
            // own envelope could reach. Clamped to a fully bent transfer
            // function internally, so the top of the range flattens out.
            dcw: this._paramSources.create(dcw, { min: 0, max: 2 }),
            // Multiplies the duration of every envelope segment — attack,
            // decay, release, on all three envelopes of both lines at once.
            // The intended correction for the fitted rate curve, and the
            // fastest way to turn an electric piano into a pad.
            env_time: this._paramSources.create(env_time, { min: 0.05, max: 8 }),
            // Extra cents between the two lines, added to the tone's own
            // detune in the same direction. Additive rather than absolute
            // because most of these tones detune by an octave or two rather
            // than by a few cents, and replacing that would break them.
            detune: this._paramSources.create(detune, { min: 0, max: 100 }),
            // Extra vibrato depth in cents on top of the tone's, and a
            // multiplier on its rate. Depth adds (several tones have none and
            // would otherwise be unreachable); rate multiplies (every tone has
            // one, so there is always something to scale).
            vib_depth: this._paramSources.create(vib_depth, { min: 0, max: 100 }),
            vib_rate: this._paramSources.create(vib_rate, { min: 0.1, max: 4 }),
            // Scales the DCO envelope's depth. Only one shipped tone has a
            // pitch envelope that does anything (`a03-square-lead` bends down
            // as it releases), so this is mostly here for tones you build by
            // hand — but 0 disables it outright.
            pitch_env: this._paramSources.create(pitch_env, { min: 0, max: 4 }),
            // Scales both KEY FOLLOW amounts: how much faster high notes decay
            // and how much darker they get. 1 is the tone as dumped, 0 makes
            // the instrument behave identically at every pitch.
            key_follow: this._paramSources.create(key_follow, { min: 0, max: 2 }),
        };
    };

    // Required: the param sources route into the context destination, which
    // the generic output.disconnect() never reaches.
    dispose() {
        this._paramSources.dispose();
    };

    // The tone data plus every option override resolved, which is what both
    // trigger() and describeState() actually want to talk about.
    _resolve() {
        const tone = CZ_TONES[this.preset];
        const lines = this.lines === "preset" ? tone.lines : this.lines;
        const voices = lines === "1" ? [tone.line1]
            : lines === "2" ? [tone.line2]
            : lines === "1+1" ? [tone.line1, tone.line1]
            : [tone.line1, tone.line2];
        return {
            tone,
            lines,
            voices,
            mod: this.mod === "preset" ? tone.mod : this.mod,
            octave: this.octave === "preset" ? tone.octave : Number(this.octave),
            waveOf: (line) => WAVES.indexOf(this.wave === "preset" ? line.wave : this.wave),
            wave2Of: (line) => WAVES.indexOf(this.wave === "preset" ? line.wave2 : this.wave),
            combinationOf: (line) => this.wave === "preset" && line.combination,
        };
    };

    trigger(time, event, secondsPerBeat) {
        const ctx = this.audioContext;
        const sampleRate = ctx.sampleRate;
        const midi = event.degree !== undefined ? resolveDegree(this.harmony, event.degree) : event.pitch;

        const resolved = this._resolve();
        const { tone, voices } = resolved;

        const dcwAmount = this.params.dcw.getModulated();
        const envTime = this.params.env_time.getModulated();
        const extraDetune = this.params.detune.getModulated();
        const extraVibratoDepth = this.params.vib_depth.getModulated();
        const vibratoRateScale = this.params.vib_rate.getModulated();
        const pitchEnvScale = this.params.pitch_env.getModulated();
        const keyFollow = this.params.key_follow.getModulated();

        // KEY FOLLOW, both halves. Clamped to four octaves either side of
        // middle C so an extreme MIDI note can't scale an envelope to nothing:
        // at full follow an octave up halves the decay time, and two octaves up
        // halves the DCW depth.
        const fromMiddle = Math.max(-48, Math.min(48, midi - 60));
        const followTime = (line) => Math.pow(2, (-(line.dcaFollow / 9) * keyFollow * fromMiddle) / 12);
        const followDcw = (line) => Math.pow(2, (-(line.dcwFollow / 9) * keyFollow * fromMiddle) / 24);

        // The gate. A zero-length event is a key pressed and released, which
        // for most of these tones is the whole performance — the release is
        // where an electric piano's note actually lives.
        const gateSamples = Math.max(1, Math.round(
            Math.max(0.005, (event.duration ?? 0) * secondsPerBeat) * sampleRate,
        ));

        // DETUNE offsets the second line against the first, as on the hardware
        // — not symmetrically around the note. Several tones use it as a whole
        // octave or two rather than as a beating interval, which is where the
        // shimmers and the bells come from.
        const detuneSign = tone.detune < 0 ? -1 : 1;
        const detuneCents = tone.detune + extraDetune * detuneSign;
        const baseMidi = midi + 12 * resolved.octave;

        const rendered = voices.map((line, index) => {
            const timeScale = envTime * followTime(line);
            const dca = buildEnvelope(line.dca, timeScale, sampleRate, gateSamples);
            return {
                line,
                dca,
                dcw: buildEnvelope(line.dcw, timeScale, sampleRate, gateSamples),
                dco: buildEnvelope(line.dco, timeScale, sampleRate, gateSamples),
                // The DCO envelope is read as a deviation from its own sustain
                // level rather than as an absolute transposition, so a tone
                // whose pitch envelope simply sits at one value — which is 27
                // of the 28 here — plays in tune.
                dcoRest: line.dco.steps[Math.min(line.dco.end, line.dco.steps.length) - 1][1],
                dcwScale: (dcwAmount * followDcw(line)) / 99,
                increment: (midiToFreq(baseMidi) / sampleRate)
                    * (index === 0 ? 1 : Math.pow(2, detuneCents / 1200)),
                length: totalSamples(dca),
            };
        });

        const wanted = Math.max(...rendered.map((voice) => voice.length));
        const cap = Math.ceil(MAX_NOTE_SECONDS * sampleRate);
        const length = Math.max(CONTROL_HOP, Math.min(wanted, cap));

        const buffer = ctx.createBuffer(1, length, sampleRate);
        this._render(resolved, rendered, buffer.getChannelData(0), sampleRate, {
            vibratoDepth: tone.vibrato.depth + extraVibratoDepth,
            // Both fitted the same way the envelope rate curve is, from the
            // shipped tones: 0..99 spans 0.1-10Hz and 0-5 seconds of delay,
            // which puts these patches' vibratos between a 0.4Hz drift and a
            // 6.7Hz shimmer.
            vibratoRate: (0.1 + tone.vibrato.rate * 0.1) * vibratoRateScale,
            vibratoDelay: tone.vibrato.delay * 0.05,
            vibratoWave: tone.vibrato.wave,
            pitchEnvScale,
        });

        // A note cut short by MAX_NOTE_SECONDS would end on a discontinuity.
        if (wanted > length) {
            const data = buffer.getChannelData(0);
            const fade = Math.min(length, Math.round(0.02 * sampleRate));
            for (let i = 0; i < fade; i++) data[length - fade + i] *= 1 - i / fade;
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const voiceGain = ctx.createGain();
        voiceGain.gain.setValueAtTime(event.velocity, time);

        source.connect(voiceGain).connect(this.output);
        source.start(time);
        // Must follow start() — calling stop() on a source that hasn't been
        // started throws InvalidStateError.
        source.stop(time + length / sampleRate + 0.01);
    };

    // Renders every line into `out`.
    //
    // One line at a time rather than all of them per sample, which matters
    // more than it looks: it puts every piece of a line's state in a local
    // rather than behind a property load, and it keeps the sample loop free of
    // an inner iteration over voices. Measured at roughly five times faster
    // than the interleaved version. The lines still combine correctly because
    // both ways of combining them are per-sample commutative — the first line
    // writes, the rest add into it (or multiply, for ring modulation).
    _render(resolved, voices, out, sampleRate, vibrato) {
        const length = out.length;
        const ring = resolved.mod === "ring";
        const noise = resolved.mod === "noise";
        // Ring modulation multiplies rather than sums, so it needs the trim
        // squared to land in the same place.
        const scale = ring ? OUTPUT_TRIM * OUTPUT_TRIM : OUTPUT_TRIM / voices.length;

        const vibratoStep = (vibrato.vibratoRate * CONTROL_HOP) / sampleRate;
        const delayBlocks = (vibrato.vibratoDelay * sampleRate) / CONTROL_HOP;

        for (let v = 0; v < voices.length; v++) {
            const voice = voices[v];
            const waveA = resolved.waveOf(voice.line);
            const waveB = resolved.wave2Of(voice.line);
            const combination = resolved.combinationOf(voice.line);
            const dcwScale = voice.dcwScale;
            const increment = voice.increment;
            const rest = voice.dcoRest;
            const dca = new EnvelopeRunner(voice.dca);
            const dcw = new EnvelopeRunner(voice.dcw);
            const dco = new EnvelopeRunner(voice.dco);

            let phase = 0;
            let period = 0;
            let step = increment;
            let vibratoPhase = 0;
            let block = 0;

            for (let i = 0; i < length; i += CONTROL_HOP) {
                const blockEnd = Math.min(i + CONTROL_HOP, length);

                // Control rate: vibrato and the DCO envelope, both of which
                // reach the oscillator through an exp() that has no business
                // running per sample. The vibrato fades in over its DELAY,
                // which is how the flutes here get a straight attack and a
                // wobble afterwards.
                let bend = 0;
                if (vibrato.vibratoDepth > 0) {
                    const ramp = delayBlocks > 0 ? Math.min(1, block / delayBlocks) : 1;
                    bend = vibratoShape(vibrato.vibratoWave, vibratoPhase) * vibrato.vibratoDepth * ramp;
                }
                vibratoPhase += vibratoStep;
                if (vibratoPhase >= 1) vibratoPhase -= Math.floor(vibratoPhase);
                block++;

                const cents = bend + (dco.level - rest) * (1200 / 99) * vibrato.pitchEnvScale;
                step = increment * Math.exp((cents * Math.LN2) / 1200);
                // NOISE MOD: the second line's phase increment is thrown off by
                // a fresh random factor every block, which turns it inharmonic.
                // An approximation of the hardware's noise generator rather
                // than a port of it — and it needs two lines to be audible at
                // all. Nothing shipped uses it.
                if (noise && v > 0) step *= 0.5 + Math.random() * 1.5;
                dco.advance(blockEnd - i);

                for (let j = i; j < blockEnd; j++) {
                    const amplitude = dca.next() / 99;
                    const distortion = Math.min(1, Math.max(0, dcw.next() * dcwScale));

                    // COMBINATION waves alternate on successive periods rather
                    // than mixing, so the shape repeats every two periods and a
                    // sub-octave appears under the note. Tracking the period
                    // counter across the wrap is the whole implementation.
                    const wave = combination && (period & 1) ? waveB : waveA;
                    const value = czSample(wave, phase, distortion) * amplitude;

                    if (v === 0) out[j] = value;
                    else if (ring) out[j] *= value;
                    else out[j] += value;

                    phase += step;
                    if (phase >= 1) {
                        const wraps = Math.floor(phase);
                        phase -= wraps;
                        period += wraps;
                    }
                }
            }
        }

        // A DC blocker, because half these waveforms genuinely have an offset:
        // a pulse at full DCW sits pinned at the cosine table's peak for most
        // of its period. The hardware's output stage is AC-coupled and never
        // passes it on either, so removing it here is the faithful thing —
        // without it the DCA envelope turns that offset into a thump on every
        // note. One-pole, corner around 10Hz.
        // The per-line level scaling rides along on this pass rather than
        // costing a third one.
        const pole = 1 - (2 * Math.PI * 10) / sampleRate;
        let lastIn = 0;
        let lastOut = 0;
        for (let i = 0; i < length; i++) {
            const input = out[i] * scale;
            lastOut = input - lastIn + pole * lastOut;
            lastIn = input;
            out[i] = lastOut;
        }
    };

    // The preset is a name, and a name is not a sound — so print what it
    // actually resolved to. The DCW envelope is included because it is the
    // one that decides the timbre, and reading `67>0*` off a line is how you
    // see at a glance that `sixtyniner-sine-pad` really is just a sine.
    describeState() {
        const resolved = this._resolve();
        const line = resolved.voices[0];
        const waves = WAVES[resolved.waveOf(line)]
            + (resolved.combinationOf(line) ? `+${WAVES[resolved.wave2Of(line)]}` : "");
        const detune = resolved.lines === "1" || resolved.lines === "2"
            ? "" : `, detune ${resolved.tone.detune}c`;
        return `${this.preset} (${resolved.tone.album}) — ${waves}, lines ${resolved.lines}, oct ${resolved.octave >= 0 ? "+" : ""}${resolved.octave}${detune}`
            + `, DCA ${describeEnvelope(line.dca)}, DCW ${describeEnvelope(line.dcw)}`;
    };
};

// One period of the vibrato LFO, returned bipolar over -1..1.
function vibratoShape(wave, phase) {
    switch (wave) {
        case "sawup": return phase * 2 - 1;
        case "sawdown": return 1 - phase * 2;
        case "square": return phase < 0.5 ? 1 : -1;
        default: return 1 - Math.abs(4 * phase - 2);
    }
};

// `rate>level` per stage, with `*` marking the sustain point. Machine units,
// so it reads the same way the CZ's own display would.
function describeEnvelope({ steps, end }) {
    return steps
        .map(([rate, level], index) => `${rate}>${level}${index === end - 1 ? "*" : ""}`)
        .join(" ");
};
