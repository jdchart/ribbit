import { RibbitProcessor } from "../processor.js";
import { RibbitParam } from "../param.js";

// The four transfer curves, each a plain function of x in -1..1. A
// WaveShaperNode clamps its *input* to that range before the lookup, so the
// entire nonlinearity has to live inside it — pushing harder into it (see
// `drive` below) means more of the signal reaches the bent part, which is
// what saturation is.
//
// The bend constants are deliberately gentle. The character of a saturator
// should come from the *shape*; the amount should come entirely from
// `drive`. A curve that bends hard on its own takes that choice away from
// the player, which is exactly what these did in their first version — see
// buildCurve's note on slope below.
//
// soft/tape are "nice" (odd and mostly-odd harmonics); hard and fold are
// not, and are the reason this exists.
const CHARACTERS = {
    // tanh — the textbook soft clipper. Rounds peaks off gradually.
    soft: (x) => Math.tanh(1.5 * x),
    // Straight clipping with a sharp corner: buzzy odd harmonics, no
    // rounding at all. Below full scale it's the identity, so this is the
    // most transparent of the four until drive actually pushes into it.
    hard: (x) => Math.max(-1, Math.min(1, x)),
    // A wavefolder: past its peak the curve turns around and comes back
    // down, so a louder input gets a *different* shape rather than a flatter
    // one. Inharmonic, metallic, and completely unlike the other three —
    // this is the one to reach for when subtlety is not the goal.
    fold: (x) => Math.sin(x * Math.PI * 1.5),
    // Asymmetric soft clipping: the positive and negative halves saturate
    // differently, which adds even harmonics on top of the odd ones. The
    // subtraction removes the DC offset the asymmetry would otherwise
    // introduce; it deliberately does *not* rebalance the two halves, since
    // that asymmetry is the whole point.
    tape: (x) => Math.tanh(1.8 * x + 0.12) - Math.tanh(0.12),
};

// Normalizes a curve to **unity slope at the origin** — not to unity peak.
//
// This is the single most important line in the file, and it was wrong
// first time round. Normalizing to peak 1 maximizes a curve's low-level
// gain: tanh(3x) scaled that way has a slope of about 3 at the origin, so
// it applied ~9.6dB of gain and started visibly bending long before the
// signal got anywhere near full scale. Fed a normal mixed signal peaking
// around 0.3, it returned about 0.9 — the waveform reshaped rather than its
// peaks rounded. With `drive` multiplying on top, "drive=1" was already
// heavy distortion and there was no setting at which the stage was clean.
//
// Unity slope instead means the curve is tangent to the identity at zero:
// quiet signal passes through untouched, and how much of it reaches the
// bent part is decided by `drive` alone. drive=1 is essentially clean,
// which is what makes the stage safe to leave in a chain that isn't asking
// for dirt. The trade is that each character now has its own output level
// at full drive (a wavefolder ends up quieter than a clipper, which is
// true of real ones too) — that's what `level` is for.
//
// The final clamp is a guard, not arithmetic anything currently relies on:
// a WaveShaperNode applies curve values as-is with no output clamping of
// its own, so a future character that overshot would hand the rest of the
// chain a signal past full scale.
function buildCurve(character, samples = 2048) {
    const shape = CHARACTERS[character];
    const h = 1e-4;
    const slope = (shape(h) - shape(-h)) / (2 * h);
    const scale = Math.abs(slope) > 1e-6 ? 1 / slope : 1;

    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
        const x = (i / (samples - 1)) * 2 - 1;
        curve[i] = Math.max(-1, Math.min(1, shape(x) * scale));
    }
    return curve;
};

// Waveshaping distortion: a gain stage pushing into a fixed transfer curve.
//
// The split between `drive` (a param) and `character` (an option) is the
// whole design. The *amount* is a pre-gain — a real AudioParam, so it ramps,
// automates and accepts a patch (/sat drive=12 4b sweeps into the dirt) —
// while the *shape* is a Float32Array that has to be rebuilt from scratch,
// so it's an option, exactly like RibbitReverb's impulse-response settings.
// Folding drive into the curve instead would have made it non-rampable for
// no gain.
//
// Loudness self-limits as drive rises: more of the signal sits in the flat
// part of the curve, whose output is bounded at ±1 by construction. So
// drive gets dirtier rather than infinitely louder, and `level` is there to
// trim what's left.
export class RibbitSaturator extends RibbitProcessor {
    constructor(audioContext, {
        name = "saturator",
        drive = 2,
        level = 1,
        mix = 1,
        character = "soft",
        oversample = "2x",
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "Waveshaping saturation: a drive stage into one of four transfer curves, from gentle tape warmth to a wavefolder.";

        this.character = character;

        this.shaper = audioContext.createWaveShaper();
        this.shaper.curve = buildCurve(this._validCharacter(character));
        this.shaper.oversample = oversample;

        this.driveGain = audioContext.createGain();
        this.driveGain.gain.value = drive;
        this.levelGain = audioContext.createGain();
        this.levelGain.gain.value = level;

        const { param: mixParam, wetGain } = this.createCrossfade(mix);
        this.input.connect(this.driveGain).connect(this.shaper).connect(this.levelGain).connect(wetGain);

        // Neither of these is backed by an AudioParam — one rebuilds a
        // Float32Array, the other writes a string property — so both are
        // options rather than params. Settable at runtime and round-tripped
        // through the base getOptions(); see RibbitReverb's duration/decay.
        this.options = {
            character: {
                get: () => this.character,
                set: (value) => {
                    // Validate before assigning: a set that throws must
                    // leave the object exactly as it found it (the rule
                    // RibbitPatternVariator's pack=/pattern= learned the
                    // hard way — a corrupted field makes the *next*
                    // command report a stale problem instead of its own).
                    const valid = this._validCharacter(value);
                    this.shaper.curve = buildCurve(valid);
                    this.character = valid;
                },
                choices: Object.keys(CHARACTERS),
            },
            oversample: {
                get: () => this.shaper.oversample,
                set: (value) => {
                    if (!["none", "2x", "4x"].includes(value)) throw new Error(`invalid oversample "${value}" — none, 2x, 4x`);
                    this.shaper.oversample = value;
                },
                choices: ["none", "2x", "4x"],
            },
        };

        this.params = {
            drive: new RibbitParam(this.driveGain.gain, { min: 1, max: 50 }),
            level: new RibbitParam(this.levelGain.gain, { min: 0, max: 2 }),
            mix: mixParam,
        };
    };

    _validCharacter(value) {
        if (!CHARACTERS[value]) throw new Error(`invalid character "${value}" — ${Object.keys(CHARACTERS).join(", ")}`);
        return value;
    };
};

export { CHARACTERS as SATURATOR_CHARACTERS };
