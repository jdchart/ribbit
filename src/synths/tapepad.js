import { RibbitSynth } from "../synth.js";
import { RibbitParam, RibbitParamSources } from "../param.js";
import { resolveDegree } from "../harmony.js";

function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
};

// Length of one pass of a drift buffer, in points. Small — these are control
// signals, not audio, and they're played back so slowly (see buildDrift) that
// 8192 points spread over ten-odd seconds still leaves ~70 points per cycle of
// the fastest flutter partial, which is smooth after the buffer source's own
// interpolation.
const DRIFT_POINTS = 8192;

// How long one pass of each drift loop takes. Deliberately not round numbers
// and not related to each other: a wow loop and a flutter loop that shared a
// period would line up on every pass, which is exactly the mechanical
// regularity the whole transport exists to avoid.
const WOW_SECONDS = 13.7;
const FLUTTER_SECONDS = 3.1;

// Cycle counts, per loop, of the partials each drift signal is built from —
// so WOW's 2 cycles over 13.7s is ~0.15Hz and FLUTTER's 37 over 3.1s is ~12Hz.
// Primes, so no two partials share a factor and the sum doesn't repeat before
// the whole loop does. See buildDrift for why they must be whole numbers.
const WOW_PARTIALS = [1, 2, 3, 5, 7];
const FLUTTER_PARTIALS = [11, 17, 23, 29, 37];

// Per-note tuning error, in cents, applied on top of the voice spread. Not
// exposed: it isn't a setting, it's the reason two takes of the same chord
// aren't identical. Small enough to read as "not quite in tune", not as an
// effect.
const NOTE_JITTER_CENTS = 2.5;

// Knee of the tape saturation curve. See buildSatCurve — with the unity-slope
// normalization applied there, this sets how early the curve starts bending
// rather than how loud it is.
const TAPE_KNEE = 2;
const SAT_POINTS = 4096;

// Resolution of the bit-crush curve. Worth knowing: the WaveShaper interpolates
// between curve points, so quantization finer than the point spacing (2/8191,
// i.e. about 12 bits) is smoothed straight back out — which is why `bits` at
// its top of the range is effectively clean rather than a subtly wrong 16-bit.
const CRUSH_POINTS = 8192;

// Corner of the fixed lowpass every voice and the hiss pass through on the way
// out — the bandwidth of the medium. Fixed rather than a param because it is
// not a tone control: it's what stops the crush stage's staircase from
// sounding like a broken codec, and there's no setting of it that improves on
// "roughly where a domestic tape machine gave up".
const TAPE_BANDWIDTH_HZ = 7500;

// Corner of the highpass on the hiss. Tape noise lives up top; without this
// the noise floor is a rumble competing with the pad's own low end.
const HISS_HIGHPASS_HZ = 1100;

// What `hiss` = 1 actually means in gain. The param is 0..1 because "how much
// noise floor" is a taste dial, not a level in dB — this is the one number
// that decides what the top of that dial sounds like.
const HISS_SCALE = 0.03;

const WAVEFORMS = ["sine", "triangle", "sawtooth", "square"];
const MAX_VOICES = 5;
const MIN_BITS = 3;
const MAX_BITS = 16;

// The whole numbers from low to high, as the strings a `choices` list holds —
// so an integer-valued option declares its range once instead of writing the
// same bounds out twice (see voices/bits below).
const RANGE_CHOICES = (low, high) =>
    Array.from({ length: high - low + 1 }, (_, i) => String(low + i));

// One loop of tape drift: a sum of sines at *whole* cycle counts over the
// buffer, each at a random phase.
//
// Whole counts are what make the buffer loop without a seam — every partial is
// back exactly where it started at the end, so the join is silent. The
// alternative (filtered noise) has to be crossfaded at the seam, and a
// crossfade in a signal this slow is audible as a hesitation once per pass.
//
// Amplitudes fall off across the list so the slowest partial dominates and the
// fast ones only roughen it, which is what unsteady tape actually does: a broad
// wander with a fine tremble on top, not a chord of wobbles.
function buildDrift(audioContext, partials, seconds) {
    const buffer = audioContext.createBuffer(1, DRIFT_POINTS, audioContext.sampleRate);
    const data = buffer.getChannelData(0);

    let total = 0;
    for (let p = 0; p < partials.length; p++) {
        const amplitude = 1 / (p + 1);
        const phase = Math.random() * Math.PI * 2;
        const step = (partials[p] * Math.PI * 2) / DRIFT_POINTS;
        for (let i = 0; i < DRIFT_POINTS; i++) data[i] += Math.sin(phase + step * i) * amplitude;
        total += amplitude;
    }

    // Normalized to a peak of exactly 1 so the depth params are honest: with
    // `wow` in cents driving a gain on this signal, "wow=18" has to mean ±18
    // cents and not "±18 times whatever this sum happened to peak at".
    let peak = 0;
    for (let i = 0; i < DRIFT_POINTS; i++) peak = Math.max(peak, Math.abs(data[i]));
    const scale = peak > 0 ? 1 / peak : 1 / Math.max(1, total);
    for (let i = 0; i < DRIFT_POINTS; i++) data[i] *= scale;

    // Played back this slowly the buffer is a control signal rather than a
    // sound; the caller sets playbackRate from this so the loop lasts
    // `seconds`.
    const rate = DRIFT_POINTS / (seconds * audioContext.sampleRate);
    return { buffer, rate };
};

// Two channels of independent white noise. Independent rather than one channel
// duplicated because correlated noise images dead centre, and a mono noise
// floor under a wide pad sounds like a fault rather than like tape.
function buildNoise(audioContext, seconds) {
    const length = Math.round(seconds * audioContext.sampleRate);
    const buffer = audioContext.createBuffer(2, length, audioContext.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    return buffer;
};

// Soft tape saturation, normalized to **unity slope at the origin** rather
// than to unity peak — the same convention, and for the same reason, as
// processors/saturator.js's buildCurve, whose long comment is the one to read.
// In short: peak normalization makes low-level signal loud and bent, so there
// is no setting at which the stage is clean. Tangent to the identity at zero
// instead means `sat` alone decides how much signal reaches the bend.
function buildSatCurve() {
    const curve = new Float32Array(SAT_POINTS);
    for (let i = 0; i < SAT_POINTS; i++) {
        const x = (i / (SAT_POINTS - 1)) * 2 - 1;
        curve[i] = Math.tanh(TAPE_KNEE * x) / TAPE_KNEE;
    }
    return curve;
};

// A staircase: rounds the signal to 2^(bits-1) levels either side of zero.
// Real bit reduction, not a filter — the harmonics it adds are inharmonic and
// loudest when the signal is quiet, which is the sound of a cheap sampler and
// half of what "lofi" means.
function buildCrushCurve(bits) {
    const curve = new Float32Array(CRUSH_POINTS);
    const levels = Math.pow(2, bits - 1);
    for (let i = 0; i < CRUSH_POINTS; i++) {
        const x = (i / (CRUSH_POINTS - 1)) * 2 - 1;
        curve[i] = Math.round(x * levels) / levels;
    }
    return curve;
};

// A polyphonic pad run through a tape machine.
//
// Two halves, and the split between them is the whole design:
//
//   per note — a stack of detuned oscillators, panned apart, through one
//     lowpass and one slow attack/release envelope. Ordinary subtractive
//     voicing; this is the part that plays the chord.
//
//   shared — one **transport**: wow and flutter drift signals fanning into
//     every live oscillator's detune, and a tape stage (saturation, bit
//     crush, bandwidth limit, hiss) that every voice is mixed through.
//     Persistent, running whether or not anything is playing.
//
// The transport is shared rather than per-voice because a tape machine has one
// capstan. Give each note its own wobble and a chord smears into a chorus —
// every voice drifting somewhere different is the sound of an ensemble effect,
// not of an unsteady tape. Sharing one signal means the whole chord bends
// *together*, which is the thing that reads as a warped recording. It is also
// what makes `wow` and `flutter` real single-node AudioParams: they're gains on
// one signal, so they ramp smoothly and take a patch continuously, unlike the
// per-note params below which are read once at each trigger.
//
// The tape stage is likewise shared, and for a second reason: saturation and
// crush applied per voice would distort each note separately and then sum
// cleanly, which is not what a mix bus does. Running the summed chord into one
// curve is what gets the voices interfering with each other — the intermodulation
// *is* the dirt.
//
// Deliberately not here: sample-rate reduction, the other half of a real lofi
// stage. It needs a per-sample hold, which in Web Audio means an AudioWorklet
// module for the host to serve — a new kind of host obligation (the engine only
// ever asks for JSON manifests). `bits` covers the audible half of the same
// idea.
export class RibbitTapePad extends RibbitSynth {
    constructor(audioContext, {
        name = "tapepad",
        harmony,
        cutoff = 1400,
        detune = 14,
        pan_spread = 0.5,
        sub = 0.35,
        attack = 0.9,
        release = 2.5,
        wow = 18,
        wow_rate = 1,
        flutter = 10,
        hiss = 0.15,
        sat = 1.4,
        waveform = "sawtooth",
        voices = 3,
        bits = 12,
    } = {}) {
        super(audioContext, { name, harmony });
        this.llm_summary = "A polyphonic pad played through a tape machine: detuned oscillator stacks into one shared transport (wow/flutter pitch drift) and one shared tape stage (saturation, bit crush, bandwidth, hiss). Built for slow, warped, lofi chords.";

        this.waveform = waveform;
        this.voices = voices;
        this.bits = bits;

        const ctx = audioContext;

        // --- the tape stage, in signal order -------------------------------
        // Every voice lands on _voiceBus, so the chord is summed *before* it
        // hits the curves (see the class comment).
        this._voiceBus = ctx.createGain();
        this._satGain = ctx.createGain();
        this._satShaper = ctx.createWaveShaper();
        this._satShaper.curve = buildSatCurve();
        // 2x is enough here: the pad's own content is already lowpassed, so
        // there isn't much above Nyquist/2 for the curve to fold back.
        this._satShaper.oversample = "2x";

        this._crushShaper = ctx.createWaveShaper();
        this._crushShaper.curve = buildCrushCurve(this.bits);

        this._tapeTone = ctx.createBiquadFilter();
        this._tapeTone.type = "lowpass";
        this._tapeTone.frequency.value = TAPE_BANDWIDTH_HZ;
        this._tapeTone.Q.value = 0.7;

        this._voiceBus
            .connect(this._satGain)
            .connect(this._satShaper)
            .connect(this._crushShaper)
            .connect(this._tapeTone)
            .connect(this.output);

        // Hiss joins *after* the curves and before the bandwidth limit: it's
        // noise printed on the tape, not signal fed into the machine, so
        // driving `sat` harder must not make the noise floor louder too.
        this._hissSource = ctx.createBufferSource();
        this._hissSource.buffer = buildNoise(ctx, 2);
        this._hissSource.loop = true;
        this._hissFilter = ctx.createBiquadFilter();
        this._hissFilter.type = "highpass";
        this._hissFilter.frequency.value = HISS_HIGHPASS_HZ;
        this._hissGain = ctx.createGain();
        this._hissSource.connect(this._hissFilter).connect(this._hissGain).connect(this._tapeTone);
        this._hissSource.start();

        // --- the transport -------------------------------------------------
        // Both drift signals sum into _pitchMod, which every live oscillator's
        // detune is connected to. Nothing downstream of _pitchMod is an audio
        // path — it exists only to be added into AudioParams — which is fine:
        // a connection into an AudioParam is part of the rendered graph, so
        // the sources are pulled even with no notes sounding.
        this._pitchMod = ctx.createGain();

        const wowDrift = buildDrift(ctx, WOW_PARTIALS, WOW_SECONDS);
        this._wowSource = ctx.createBufferSource();
        this._wowSource.buffer = wowDrift.buffer;
        this._wowSource.loop = true;
        this._wowBaseRate = wowDrift.rate;
        this._wowGain = ctx.createGain();
        this._wowSource.connect(this._wowGain).connect(this._pitchMod);

        const flutterDrift = buildDrift(ctx, FLUTTER_PARTIALS, FLUTTER_SECONDS);
        this._flutterSource = ctx.createBufferSource();
        this._flutterSource.buffer = flutterDrift.buffer;
        this._flutterSource.loop = true;
        this._flutterSource.playbackRate.value = flutterDrift.rate;
        this._flutterGain = ctx.createGain();
        this._flutterSource.connect(this._flutterGain).connect(this._pitchMod);

        this._wowSource.start();
        this._flutterSource.start();

        // --- params ----------------------------------------------------------
        // Split by whether there is a real AudioParam doing the work.
        //
        // The five below wrap one directly, so they are continuous: a ramp or a
        // patch moves them *during* a sustained chord, which for wow depth or
        // tape drive is the whole point. The six on _paramSources are read once
        // per trigger by JS, so the same ramp or patch moves them note by note
        // instead — see RibbitParam.getModulated.
        this.params = {
            // Depth of the slow wander and the fast tremble, both in cents of
            // detune. Separate params rather than one "instability" because
            // they are different faults: wow is a warped reel, flutter is a
            // worn capstan, and a lot of what people mean by "tape" is having
            // much more of the first than the second.
            wow: new RibbitParam(this._wowGain.gain, { min: 0, max: 200 }),
            flutter: new RibbitParam(this._flutterGain.gain, { min: 0, max: 200 }),

            // A multiplier on the wow loop's speed, not a frequency: the loop
            // is a sum of five partials, so there is no single rate to name.
            // 1 is the natural wobble. Encoded through the buffer's own base
            // playback rate — the raw AudioParam value is a very small number
            // and nothing user-facing should ever have to know that.
            wow_rate: new RibbitParam(this._wowSource.playbackRate, {
                encode: (value) => value * this._wowBaseRate,
                decode: (value) => value / this._wowBaseRate,
                min: 0.1,
                max: 8,
            }),

            // Level of the noise floor, 0..1 over a fixed useful range rather
            // than a raw gain — see HISS_SCALE. Runs whether or not the track
            // is playing, because a tape machine hisses when the music stops;
            // hiss=0 if that isn't wanted.
            hiss: new RibbitParam(this._hissGain.gain, {
                encode: (value) => value * HISS_SCALE,
                decode: (value) => value / HISS_SCALE,
                min: 0,
                max: 1,
            }),

            // Drive into the saturation curve. Louder as well as dirtier, by
            // the unity-slope convention buildSatCurve explains — the track's
            // own gain is the balance control, the same trade saturator makes.
            sat: new RibbitParam(this._satGain.gain, { min: 1, max: 20 }),
        };

        this._paramSources = new RibbitParamSources(audioContext);
        Object.assign(this.params, {
            // Corner of the per-note lowpass. Also swept by the envelope: the
            // filter opens to `cutoff` across the attack and eases back down
            // over the tail, so a long chord breathes rather than sitting
            // still. That shape isn't exposed — a pad whose filter doesn't
            // move is a job for oscsynth.
            cutoff: this._paramSources.create(cutoff, { min: 40, max: 16000 }),

            // Spread between the stacked oscillators, in cents, widest pair
            // first. This is the thickness control: at 0 the stack collapses
            // to one oscillator's worth of tone, past ~30 it stops being a
            // chorus and starts being out of tune, which is sometimes correct.
            detune: this._paramSources.create(detune, { min: 0, max: 60 }),

            // How far apart the stack is panned. Shares its position with the
            // detune spread — the sharp voice is on one side and the flat one
            // on the other — so widening it also widens the beating. No effect
            // at voices=1, which has nothing to spread.
            pan_spread: this._paramSources.create(pan_spread, { min: 0, max: 1 }),

            // Level of a sine an octave below the note. Routed past the
            // lowpass rather than through it, so closing `cutoff` right down
            // darkens the pad without hollowing out its bottom end — the
            // gesture this instrument gets asked for most.
            sub: this._paramSources.create(sub, { min: 0, max: 1 }),

            // Envelope, in seconds. `attack` is clamped per note to the note's
            // own length (a 3-second swell inside a 1-second note peaks at 1
            // second rather than never arriving); `release` runs past the end
            // of the note and is what makes the chords overlap.
            attack: this._paramSources.create(attack, { min: 0, max: 10 }),
            release: this._paramSources.create(release, { min: 0, max: 10 }),
        });

        this.options = {
            waveform: {
                get: () => this.waveform,
                set: (value) => { this.waveform = value; },
                choices: WAVEFORMS,
            },

            // Oscillators per note. Not a param because there is no such thing
            // as 2.5 oscillators — the value indexes a stack, so sweeping it
            // isn't a gesture. Capped low: each voice is three nodes and a
            // four-note chord already builds a stack per note.
            voices: {
                get: () => this.voices,
                set: (value) => {
                    const count = Math.floor(Number(value));
                    if (!Number.isFinite(count) || count < 1 || count > MAX_VOICES) {
                        throw new Error(`invalid voices "${value}" — expected a whole number 1-${MAX_VOICES}`);
                    }
                    this.voices = count;
                },
                // A short integer run, so it's worth listing: `choices` buys
                // ghost-text completion and a validation message before a
                // deferred at= ever fires. The set() above still validates —
                // it's the path a session file and a direct host call take.
                choices: RANGE_CHOICES(1, MAX_VOICES),
            },

            // Quantization depth of the crush stage. An option rather than a
            // param because setting it rebuilds a Float32Array curve, the same
            // reason saturator's `character` is one (see that file). The top of
            // the range is effectively clean rather than a subtly wrong 16-bit
            // — CRUSH_POINTS explains why.
            bits: {
                get: () => this.bits,
                set: (value) => {
                    const count = Math.floor(Number(value));
                    if (!Number.isFinite(count) || count < MIN_BITS || count > MAX_BITS) {
                        throw new Error(`invalid bits "${value}" — expected a whole number ${MIN_BITS}-${MAX_BITS}`);
                    }
                    this.bits = count;
                    this._crushShaper.curve = buildCrushCurve(count);
                },
                choices: RANGE_CHOICES(MIN_BITS, MAX_BITS),
            },
        };

        // Initial values for the params that ride real AudioParams. Set through
        // the RibbitParams so encode() and the clamps apply once, here, rather
        // than being duplicated against the raw nodes above.
        this.params.wow.set(this.params.wow.clamp(wow));
        this.params.wow_rate.set(this.params.wow_rate.clamp(wow_rate));
        this.params.flutter.set(this.params.flutter.clamp(flutter));
        this.params.hiss.set(this.params.hiss.clamp(hiss));
        this.params.sat.set(this.params.sat.clamp(sat));
    };

    // Required: the transport and the hiss run forever once started, and the
    // param sources route into the context destination — none of which the
    // generic output.disconnect() in Ribbit.removeTrack/setTrackSynth reaches.
    dispose() {
        this._paramSources.dispose();
        for (const source of [this._wowSource, this._flutterSource, this._hissSource]) {
            try { source.stop(); } catch { /* already stopped */ }
            source.disconnect();
        }
        this._pitchMod.disconnect();
        this._tapeTone.disconnect();
    };

    // Builds one note: a stack of detuned, panned oscillators (plus an optional
    // sub) through a filter and an envelope, onto the shared voice bus. Every
    // oscillator's detune also picks up the shared transport, so the note bends
    // with everything else already sounding.
    trigger(time, event, secondsPerBeat) {
        const ctx = this.audioContext;
        const midi = event.degree !== undefined ? resolveDegree(this.harmony, event.degree) : event.pitch;
        const freq = midiToFreq(midi);

        const cutoff = this.params.cutoff.getModulated();
        const detune = this.params.detune.getModulated();
        const panSpread = this.params.pan_spread.getModulated();
        const sub = this.params.sub.getModulated();
        const release = this.params.release.getModulated();

        const durationSeconds = Math.max(0.01, (event.duration ?? 1) * secondsPerBeat);
        // A swell longer than the note it lives in peaks at the end of the note
        // instead of never arriving. The 5ms floor is the usual click guard.
        const attack = Math.max(0.005, Math.min(this.params.attack.getModulated(), durationSeconds));
        // exponentialRampToValueAtTime can't start from or reach zero, hence
        // both floors.
        const peak = Math.max(0.0001, event.velocity ?? 1);

        const voiceGain = ctx.createGain();
        voiceGain.gain.setValueAtTime(0.0001, time);
        voiceGain.gain.linearRampToValueAtTime(peak, time + attack);
        voiceGain.gain.setValueAtTime(peak, time + durationSeconds);
        voiceGain.gain.exponentialRampToValueAtTime(0.0001, time + durationSeconds + release);
        voiceGain.connect(this._voiceBus);

        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        // Barely resonant. A pad wants the corner to be a slope, not a bump —
        // any real Q here turns the envelope sweep below into a filter sound
        // rather than the chord getting brighter.
        filter.Q.value = 0.9;
        filter.frequency.setValueAtTime(Math.max(40, cutoff * 0.45), time);
        filter.frequency.linearRampToValueAtTime(cutoff, time + attack);
        filter.frequency.linearRampToValueAtTime(Math.max(40, cutoff * 0.6), time + durationSeconds + release);
        filter.connect(voiceGain);

        const voices = this.voices;
        const stopTime = time + durationSeconds + release + 0.05;
        const sources = [];

        for (let i = 0; i < voices; i++) {
            // -1..1 across the stack: one end sharp and hard left, the other
            // flat and hard right, a single voice dead centre and in tune.
            const position = voices === 1 ? 0 : (i / (voices - 1)) * 2 - 1;

            const osc = ctx.createOscillator();
            osc.type = this.waveform;
            osc.frequency.setValueAtTime(freq, time);
            osc.detune.setValueAtTime(position * detune + (Math.random() * 2 - 1) * NOTE_JITTER_CENTS, time);
            // The shared transport, summed on top of the static offset above.
            this._pitchMod.connect(osc.detune);

            const panner = ctx.createStereoPanner();
            panner.pan.setValueAtTime(position * panSpread, time);

            // Equal-ish level per voice so `voices` changes the thickness
            // without changing how loud the instrument is.
            const voiceLevel = ctx.createGain();
            voiceLevel.gain.value = 1 / voices;

            osc.connect(panner).connect(voiceLevel).connect(filter);
            sources.push(osc);
        }

        if (sub > 0.001) {
            const subOsc = ctx.createOscillator();
            subOsc.type = "sine";
            subOsc.frequency.setValueAtTime(freq / 2, time);
            this._pitchMod.connect(subOsc.detune);

            const subGain = ctx.createGain();
            subGain.gain.value = sub * 0.6;
            // Straight to the envelope, past the filter — see the `sub` param.
            subOsc.connect(subGain).connect(voiceGain);
            sources.push(subOsc);
        }

        for (const source of sources) {
            source.start(time);
            source.stop(stopTime);
        }

        // Unwire the note once it's over. The transport feeding each
        // oscillator's detune is persistent, and a connection *from* a live
        // node keeps its destination alive — so without this every note ever
        // played stays attached to _pitchMod (and its voice chain to
        // _voiceBus) for the life of the session. Same leak granular's
        // _retire closes. All sources stop together, so one is enough to
        // listen on.
        // The try is for a synth disposed mid-note: dispose() already did a
        // blanket _pitchMod.disconnect(), and a specific disconnect of an
        // edge that no longer exists throws.
        sources[0].onended = () => {
            try {
                for (const source of sources) this._pitchMod.disconnect(source.detune);
            } catch { /* already unwired by dispose() */ }
            voiceGain.disconnect();
        };
    };
};
