import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// A chord that never moves, on a tape that does — the AE machine's Tape Pad
// (`aemd_ewd`). **A switch, not an instrument you play**: it ignores notes
// and sounds whenever its track is running (`/pad start`/`stop` fade it in
// and out over `att`/`rel`, up to 20 and 30 seconds).
//
// Five triangle voices, tuned 32 cents flat by default (A = 432Hz): the
// fundamental two octaves under `root`, its octave and a low fifth for
// density, and two quiet colour voices above (a ninth and a twelfth of the
// root). `voices` sounds the first 2..5. **The harmony never moves** — what
// moves is everything that isn't pitch: an internal clock fires every one to
// two minutes, picks new targets for the saturation and the tone colour
// (scaled by `drift`), and the pad slides there over about seventy seconds,
// below the threshold where change is heard. You notice, at some point, that
// it is somewhere else.
//
// Around it: `spread` opens the upper voices and runs left and right as
// detuned copies breathing apart; `wow`/`flut` slow and fast tape
// instability; `wash` four cross-fed comb delays (the cloud); `dark` a
// lowpass; `hiss` tape hiss plus sparse vinyl dust that feeds the wash;
// `breath` slow amplitude breathing; `glide` how long a `root` change takes;
// `sat`, `width`, `hp`, `level`.
export const TAPEDRONE_PARAMS = {
    root: { value: 48, min: 24, max: 72 },
    tune: { value: -32, min: -50, max: 50 },
    voices: { value: 4, min: 2, max: 5 },
    spread: { value: 0.4, min: 0, max: 1 },
    drift: { value: 0.5, min: 0, max: 1 },
    glide: { value: 2, min: 0.05, max: 8 },
    wow: { value: 0.3, min: 0, max: 1 },
    flut: { value: 0.15, min: 0, max: 1 },
    wash: { value: 0.4, min: 0, max: 1 },
    dark: { value: 0.35, min: 0, max: 1 },
    hiss: { value: 0.15, min: 0, max: 1 },
    breath: { value: 0.2, min: 0, max: 1 },
    att: { value: 6, min: 0, max: 20 },
    rel: { value: 8, min: 0, max: 30 },
    sat: { value: 0.25, min: 0, max: 1 },
    width: { value: 0.7, min: 0, max: 1 },
    hp: { value: 0.1, min: 0, max: 1 },
    level: { value: 0.5, min: 0, max: 1 },
};

export function tapedroneProcessor(Base, DSP) {
    const { SR, TAU, clamp, mtof, tanh, smoothing, OnePole, Delay, Rng } = DSP;
    const INTERVALS = [0, 12, 7, 26, 31];
    const LEVELS = [1, 0.7, 0.55, 0.22, 0.16];
    const WASH_TIMES = [0.047, 0.061, 0.073, 0.089];

    return class extends Base {
        constructor(options) {
            super(options);
            this.P = {};
            this.dead = false;
            this.gate = (options && options.processorOptions && options.processorOptions.active) !== false;
            this.env = 0;
            this.rng = new Rng(0xe3d);
            this.phaseL = new Float64Array(5);
            this.phaseR = new Float64Array(5);
            for (let i = 0; i < 5; i++) { this.phaseL[i] = this.rng.next(); this.phaseR[i] = this.rng.next(); }
            this.voiceGain = new Float64Array(5);
            this.baseL = new Float64Array(5);
            this.baseR = new Float64Array(5);
            this.root = null;
            this.wowPhase = 0;
            this.flutPhase = 0;
            this.breathPhase = 0;
            this.flutNoise = 0;
            // The imperceptible drift: current and target offsets for
            // saturation and tone, re-targeted every 60..120s.
            this.driftSat = 0;
            this.driftTone = 0;
            this.targetSat = 0;
            this.targetTone = 0;
            this.nextDrift = 0;
            this.driftSlew = 1 - smoothing(70 / 5);
            this.darkL = new OnePole(8000);
            this.darkR = new OnePole(8000);
            this.hpL = new OnePole(30);
            this.hpR = new OnePole(30);
            this.hissFilter = new OnePole(6000);
            this.wash = WASH_TIMES.map((t) => ({ line: new Delay(Math.ceil(t * SR * 1.05) + 4), d: t * SR, lp: new OnePole(5000) }));
            this.washOut = new Float64Array(4);
            this.dust = 0;
            this.port.onmessage = (event) => {
                const m = event.data;
                if (m.type === "dispose") this.dead = true;
                else if (m.type === "gate") this.gate = m.on;
            };
        }
        process(inputs, outputs, parameters) {
            if (this.dead) return false;
            const P = DSP.readParams(parameters, this.P);
            const L = outputs[0][0];
            const R = outputs[0][1] || outputs[0][0];
            const frames = L.length;
            const up = P.att <= 0 ? 1 : 1 / (P.att * SR);
            const downMul = P.rel <= 0 ? 0 : Math.exp(-6.9 / (P.rel * SR));
            if (!this.gate && this.env < 1e-5) {
                this.env = 0;
                return true;
            }
            if (this.root === null) this.root = P.root;
            const glide = 1 - smoothing(P.glide / 4);
            const count = Math.round(clamp(P.voices, 2, 5));
            const tune = P.tune / 1200;
            const spreadCents = P.spread * 9 / 1200;

            // Drift: every block advance the slow slide; every 60..120s a new
            // target (scaled by drift).
            this.nextDrift -= frames / SR;
            if (this.nextDrift <= 0) {
                this.nextDrift = 60 + this.rng.next() * 60;
                this.targetSat = this.rng.bi() * P.drift;
                this.targetTone = this.rng.bi() * P.drift;
            }
            const slew = 1 - Math.exp(-(frames / SR) / 70);
            this.driftSat += (this.targetSat - this.driftSat) * slew;
            this.driftTone += (this.targetTone - this.driftTone) * slew;

            const sat = clamp(P.sat + this.driftSat * 0.35, 0, 1);
            const satGain = 1 + sat * 5;
            const satNorm = 1 / tanh(satGain);
            const cutoff = Math.min(SR * 0.45, 200 * Math.pow(90, clamp(1 - P.dark + this.driftTone * 0.25, 0, 1)));
            this.darkL.set(cutoff);
            this.darkR.set(cutoff);
            const hpHz = 15 + P.hp * P.hp * 400;
            this.hpL.set(hpHz);
            this.hpR.set(hpHz);
            const washFb = 0.5 + P.wash * 0.42;
            const washMix = P.wash;

            // The root glides at block rate (a glide of 0.05s is still many
            // blocks long), and with it each voice's two detuned frequencies.
            this.root += (P.root - this.root) * (1 - Math.pow(1 - glide, frames));
            const baseL = this.baseL, baseR = this.baseR;
            for (let v = 0; v < 5; v++) {
                const f = mtof(this.root - 24 + INTERVALS[v]) * Math.pow(2, tune);
                const detune = spreadCents * (v === 0 ? 0.3 : 1);
                baseL[v] = f * Math.pow(2, -detune);
                baseR[v] = f * Math.pow(2, detune);
            }
            for (let i = 0; i < frames; i++) {
                if (this.gate) this.env = Math.min(1, this.env + up);
                else this.env *= downMul;

                // Tape transport: wow ~0.5Hz, flutter ~6.5Hz with a little
                // jitter; both bend every voice together, as tape does.
                this.wowPhase += 0.5 / SR;
                this.flutPhase += 6.5 / SR;
                this.flutNoise += (this.rng.bi() - this.flutNoise) * 0.001;
                const bend = (Math.sin(TAU * this.wowPhase) * P.wow * 22 + (Math.sin(TAU * this.flutPhase) + this.flutNoise * 2) * P.flut * 5) / 1200;

                let l = 0, r = 0;
                // One pow per sample for the transport's bend; everything
                // per-voice was worked out once for the block.
                const bendFactor = Math.pow(2, bend) / SR;
                for (let v = 0; v < 5; v++) {
                    const target = v < count ? LEVELS[v] : 0;
                    this.voiceGain[v] += (target - this.voiceGain[v]) * 0.00005;
                    if (this.voiceGain[v] < 1e-5) continue;
                    this.phaseL[v] += baseL[v] * bendFactor;
                    this.phaseR[v] += baseR[v] * bendFactor;
                    if (this.phaseL[v] >= 1) this.phaseL[v] -= 1;
                    if (this.phaseR[v] >= 1) this.phaseR[v] -= 1;
                    const tl = 1 - 4 * Math.abs(this.phaseL[v] - 0.5);
                    const tr = 1 - 4 * Math.abs(this.phaseR[v] - 0.5);
                    const g = this.voiceGain[v];
                    l += tl * g;
                    r += tr * g;
                }
                l *= 0.35; r *= 0.35;

                // Surface: hiss, and dust that falls into the wash.
                const hiss = this.hissFilter.lp(this.rng.bi()) * P.hiss * 0.05;
                let dust = 0;
                if (this.rng.next() < P.hiss * 4 / SR) dust = this.rng.bi() * 0.4 * P.hiss;

                l = tanh(l * satGain) * satNorm;
                r = tanh(r * satGain) * satNorm;
                l = this.darkL.lp(l);
                r = this.darkR.lp(r);

                // Wash: four combs, cross-fed through a Householder mix.
                let sum = 0;
                for (let k = 0; k < 4; k++) {
                    this.washOut[k] = this.wash[k].lp.lp(this.wash[k].line.read(this.wash[k].d - 1));
                    sum += this.washOut[k];
                }
                sum *= 0.5;
                const feed = (l + r) * 0.5 + dust;
                for (let k = 0; k < 4; k++) this.wash[k].line.write(feed + (this.washOut[k] - sum) * washFb);
                const washL = this.washOut[0] + this.washOut[2];
                const washR = this.washOut[1] + this.washOut[3];
                l = l * (1 - washMix * 0.5) + washL * washMix * 0.5;
                r = r * (1 - washMix * 0.5) + washR * washMix * 0.5;

                this.breathPhase += 0.07 / SR;
                const breathing = 1 - P.breath * 0.4 * (0.5 + 0.5 * Math.sin(TAU * this.breathPhase));

                // Width (mid/side), highpass, level.
                const mid = (l + r) * 0.5, side = (l - r) * 0.5 * P.width * 1.4;
                l = this.hpL.hp(mid + side) + hiss;
                r = this.hpR.hp(mid - side) + hiss;
                const g = this.env * breathing * P.level;
                L[i] = l * g;
                R[i] = r * g;
            }
            return true;
        }
    };
};

registerWorkletProcessor("ribbit-tapedrone", tapedroneProcessor, workletParams(TAPEDRONE_PARAMS));

export class RibbitTapeDrone extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "tapedrone", ...options }, {
            processor: "ribbit-tapedrone",
            params: TAPEDRONE_PARAMS,
            lane: "any",
            sieve: "all",
            processorOptions: { active: true },
        });
        this.llm_summary = "A free-running tape pad (the AE machine's tape pad): five triangle voices at 432Hz holding one chord two octaves under root, through wow/flutter, comb wash, hiss and dust. Ignores notes: it plays while its track is started (fades over att/rel). Saturation and tone drift imperceptibly on a 1-2 minute clock.";
        this._gateReady = true;
        this._sendGate();
    };

    // The transport pause *is* this voice's gate: `/pad stop` fades it out
    // over `rel`, `/pad start` back in over `att`. The base class writes
    // `active` in its own constructor, before the node exists — hence the
    // guard.
    get active() {
        return this._active ?? true;
    };

    set active(value) {
        this._active = value;
        if (this._gateReady) this._sendGate();
    };

    _sendGate() {
        this.node.post({ type: "gate", on: this.active !== false });
    };

    // A switch, not a note-player.
    trigger() {
        return false;
    };
};
