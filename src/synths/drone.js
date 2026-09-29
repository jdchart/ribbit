import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams, toggleOption } from "../dsp/spec.js";

// The floor of the machine — the AE machine's Drone Voice (`aemd_drone`):
// three detuned sawtooths through a resonant filter. Unlike every other voice
// it **sustains**: one persistent voice, not a note per trigger.
//
// A note doesn't necessarily do anything. `trig` is the chance it retriggers
// the drone (moves it to the note, reopens the gate for the note's length);
// `rebirth` the chance it also jumps the drone to a new octave and
// re-excites it (a filter swell). `hold` keeps the gate open and ignores
// notes entirely — switching it on re-excites, which is also the manual's
// remedy when a drone is silent after a recall ("toggle HOLD off and on").
//
// Sound: `detune` is the beating between the three oscillators, `wave`
// morphs saw to triangle, `fmode` crossfades low/band/high (0..2), `cutoff`
// is exponential (0.25 is ~85Hz — felt more than heard), `res`, a slow filter
// LFO (`lfo_rt` 0.008..6Hz, `lfo_dp`), `comb` a comb tuned to the fundamental
// (hollow), `compand` a slow compressor that keeps it even, `att`/`rel` up to
// 4.5 and 9 seconds, `oct` an octave offset, `drive`, `level`.
//
// Pitch: the note chooses the pitch class, `pitch` the register — so the
// drone follows the sieve's notes without leaping across the keyboard.
export const DRONE_PARAMS = {
    trig: { value: 60, min: 0, max: 100 },
    rebirth: { value: 10, min: 0, max: 100 },
    pitch: { value: 36, min: 12, max: 96 },
    detune: { value: 0.35, min: 0, max: 1 },
    wave: { value: 0.2, min: 0, max: 1 },
    fmode: { value: 0, min: 0, max: 2 },
    cutoff: { value: 0.45, min: 0, max: 1 },
    res: { value: 0.3, min: 0, max: 1 },
    lfo_rt: { value: 0.3, min: 0, max: 1 },
    lfo_dp: { value: 0.2, min: 0, max: 1 },
    comb: { value: 0, min: 0, max: 1 },
    compand: { value: 0.3, min: 0, max: 1 },
    att: { value: 0.4, min: 0, max: 1 },
    rel: { value: 0.5, min: 0, max: 1 },
    oct: { value: 0, min: -3, max: 2 },
    drive: { value: 0.1, min: 0, max: 1 },
    level: { value: 0.5, min: 0, max: 1 },
};

export function droneProcessor(Base, DSP) {
    const { SR, TAU, clamp, mtof, registerPitch, tanh, smoothing, SVF, Delay, Follower, Rng, voiceProcessor } = DSP;

    // PolyBLEP-corrected sawtooth: the naive ramp's discontinuity is what
    // aliases, and this smooths exactly that sample and its neighbour.
    const blep = (t, dt) => {
        if (t < dt) { t /= dt; return t + t - t * t - 1; }
        if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
        return 0;
    };

    const Processor = voiceProcessor(Base, (m, P, proc) => {
        proc.note(m, P);
        return null;
    }, 1, {
        init() {
            this.rng = new Rng(0xd20e);
            this.phases = [0, 0.33, 0.66];
            this.voices = new Float32Array(3);
            this.pitch = 36;
            this.targetPitch = 36;
            this.octaveShift = 0;
            this.gateUntil = -1;
            this.env = 0;
            this.excite = 0;
            this.hold = !!this.opts.hold;
            this.filter = new SVF(200, 1);
            this.lfoPhase = 0;
            this.comb = new Delay(Math.ceil(SR / 15) + 8);
            this.follower = new Follower(0.05, 0.6);
            this.glide = 1 - smoothing(0.04);
            this.frame = 0;
            this.havePitch = false;
            if (this.hold) this.excite = 1;
        },
        message(m) {
            if (m.type === "hold") {
                this.hold = m.on;
                if (m.on) this.excite = 1;
            }
        },
        before(L, R, P) {
            const frames = L.length;
            if (!this.havePitch) {
                this.pitch = this.targetPitch = P.pitch;
                this.havePitch = true;
            }
            const attack = 0.005 + 4.5 * P.att * P.att;
            const release = 0.02 + 9 * P.rel * P.rel;
            const up = 1 / (attack * SR);
            const downMul = Math.exp(-6.9 / (release * SR));
            const detuneCents = P.detune * 22;
            const ratios = [Math.pow(2, -detuneCents / 1200), 1, Math.pow(2, detuneCents / 1200)];
            const lfoHz = 0.008 * Math.pow(750, P.lfo_rt);
            const q = 0.5 + P.res * P.res * 18;
            const baseCut = 20 * Math.pow(326, P.cutoff);
            const mode = clamp(P.fmode, 0, 2);
            const driveGain = 1 + P.drive * 5;
            const driveNorm = 1 / tanh(driveGain);
            const exciteMul = Math.exp(-1 / (1.2 * SR));

            if (this.env < 1e-5 && this.gateUntil < this.frame && !this.hold) {
                this.frame += frames;
                return;
            }

            for (let i = 0; i < frames; i++) {
                const open = this.hold || this.frame < this.gateUntil;
                if (open) this.env = Math.min(1, this.env + up);
                else this.env *= downMul;

                this.pitch += (this.targetPitch + this.octaveShift * 12 + Math.round(P.oct) * 12 - this.pitch) * this.glide;
                const f0 = mtof(this.pitch);
                const dt = f0 / SR;
                const voices = this.voices;
                for (let k = 0; k < 3; k++) {
                    const inc = dt * ratios[k];
                    let p = this.phases[k] + inc;
                    if (p >= 1) p -= 1;
                    this.phases[k] = p;
                    const saw = 2 * p - 1 - blep(p, inc);
                    const tri = 1 - 4 * Math.abs(p - 0.5);
                    voices[k] = saw + (tri - saw) * P.wave;
                }

                this.lfoPhase += lfoHz / SR;
                if (this.lfoPhase >= 1) this.lfoPhase -= 1;
                this.excite *= exciteMul;
                const cutoff = baseCut * Math.pow(2, Math.sin(TAU * this.lfoPhase) * P.lfo_dp * 3 + this.excite * 2.5);
                if ((i & 7) === 0) this.filter.set(Math.min(cutoff, SR * 0.45), q);

                const mono = (voices[0] + voices[1] + voices[2]) / 3;
                this.filter.process(mono);
                const f = this.filter;
                const filtered = mode <= 1
                    ? f.low + (f.band - f.low) * mode
                    : f.band + (f.high - f.band) * (mode - 1);

                let y = filtered;
                if (P.comb > 0) {
                    const period = SR / f0;
                    const c = y + this.comb.read(period - 1) * 0.75;
                    this.comb.write(c);
                    y += (c * 0.5 - y) * P.comb;
                }
                const e = this.follower.process(y);
                y *= (1 + P.compand * 1.5) / (1 + P.compand * 3 * e);
                y = tanh(y * driveGain) * driveNorm * this.env * P.level;

                // Stereo: the outer oscillators lean left and right through
                // the same filter state's share of the mix.
                const side = (voices[0] - voices[2]) * 0.08 * this.env * P.level;
                L[i] += y + side;
                R[i] += y - side;
                this.frame++;
            }
        },
    });

    // A note, at the block it falls due in (there is one drone, not a voice
    // per note — the host's makeVoice above hands every note here).
    Processor.prototype.note = function note(m, P) {
        const roll = () => this.rng.next() * 100;
        if (this.hold) return;
        if (roll() >= P.trig) return;
        this.targetPitch = registerPitch(P.pitch, m.pitch);
        const start = this.frame + Math.max(0, Math.round((m.time - currentTime) * SR));
        this.gateUntil = Math.max(this.gateUntil, start + Math.round(m.duration * SR));
        if (roll() < P.rebirth) {
            this.octaveShift = Math.floor(this.rng.next() * 3) - 1;
            this.excite = 1;
        }
    };
    return Processor;
};

registerWorkletProcessor("ribbit-drone", droneProcessor, workletParams(DRONE_PARAMS));

export class RibbitDrone extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        const hold = options.hold === true || options.hold === "on" || options.hold === "true";
        super(audioContext, { name: "drone", ...options }, {
            processor: "ribbit-drone",
            params: DRONE_PARAMS,
            lane: "5",
            sieve: "4:2",
            quant: true,
            processorOptions: { hold },
        });
        this.llm_summary = "A sustaining drone (the AE machine's drone voice): three detuned saws through a resonant low/band/high filter with a slow LFO, comb and compander. One persistent voice: trig% is the chance a note retriggers it, rebirth% the chance it jumps octave and swells; hold=on keeps it open and ignores notes. Sieve 4:2 on lane 5.";
        this.hold = hold;
        this.options.hold = toggleOption(this, "hold", (on) => this.node.post({ type: "hold", on }));
    };
};
