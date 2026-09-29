import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// A sub-bass sine welded to a four-mode metal resonator, with its own
// ping-pong delay — the AE machine's Metal Bass Voice (`aemd_mtl`), "the low,
// metallic, refined weight that sits under a track".
//
// Two things at once. Underneath, a deep sine at `pitch` with a pitch `drop`
// on the attack (`sub_dcy` long). Above it, four resonators at bell ratios an
// octave up, struck by a short burst: `stretch` pulls those ratios apart,
// `material` goes from damped (upper modes die fast) to ringing, and also opens
// the `comb` — a feedback comb tuned to the note that gives the metal its
// hollow edge (`width` detunes its left and right lines). `formant`/`rm_mix`
// ring-modulate the metal against a sine from 80Hz to 3.2kHz — vocal,
// inharmonic. `drive` saturates the sum.
//
// **The delay is part of the instrument.** `d_time`/`d_fb`/`d_sprd`/`d_wet`
// run one ping-pong delay on the voice's output, shared by all its notes and
// read continuously — so it keeps echoing after a note ends and a ramp moves
// it live.
//
// Pitch: a note chooses the pitch class and `pitch` the register (within six
// semitones of it), so a melody on the sieve stays a bass line.
export const METALBASS_PARAMS = {
    pitch: { value: 33, min: 18, max: 60 },
    material: { value: 0.5, min: 0, max: 1 },
    stretch: { value: 0.2, min: 0, max: 1 },
    sub_dcy: { value: 0.5, min: 0, max: 1 },
    met_dcy: { value: 0.4, min: 0, max: 1 },
    drop: { value: 0.3, min: 0, max: 1 },
    comb: { value: 0.3, min: 0, max: 1 },
    formant: { value: 0.4, min: 0, max: 1 },
    rm_mix: { value: 0, min: 0, max: 1 },
    drive: { value: 0.2, min: 0, max: 1 },
    width: { value: 0.4, min: 0, max: 1 },
    d_time: { value: 0.35, min: 0, max: 1 },
    d_fb: { value: 0.35, min: 0, max: 1 },
    d_sprd: { value: 0.5, min: 0, max: 1 },
    d_wet: { value: 0, min: 0, max: 1 },
    level: { value: 0.75, min: 0, max: 1 },
};

export function metalbassProcessor(Base, DSP) {
    const { SR, TAU, mtof, registerPitch, tanh, t60, smoothing, Resonator, OnePole, Delay, Rng, voiceProcessor } = DSP;
    const seeds = new Rng(0x3e7a1);
    const RATIOS = [1, 1.51, 2.02, 2.76];

    class Voice {
        constructor(m, P) {
            const pitch = registerPitch(P.pitch, m.pitch);
            this.f0 = mtof(pitch);
            this.drop = P.drop * 24;
            this.dropState = 1;
            this.dropMul = Math.exp(-1 / (0.03 * SR));
            this.subMul = t60(0.1 * Math.pow(40, P.sub_dcy));
            this.subEnv = 1;
            this.phase = 0;

            const metalDecay = 0.05 * Math.pow(60, P.met_dcy) * (0.35 + P.material * 1.3);
            this.modes = RATIOS.map((ratio, i) => {
                const f = this.f0 * 2 * Math.pow(ratio, 1 + P.stretch * 0.9);
                const decay = metalDecay / (1 + (1 - P.material) * 2.5 * i);
                return new Resonator(Math.min(f, SR * 0.45), decay);
            });
            this.burstLen = Math.round(0.003 * SR);
            this.noise = new Rng((seeds.next() * 4294967296) >>> 0);
            this.burstFilter = new OnePole(6000);

            // The comb: a feedback comb one period of 2·f0 long, one per side.
            const period = SR / (this.f0 * 2);
            this.combL = new Delay(Math.ceil(period * 1.1) + 4);
            this.combR = new Delay(Math.ceil(period * 1.1) + 4);
            this.periodL = period;
            this.periodR = period * (1 + P.width * 0.03);
            this.combFb = (0.3 + P.material * 0.6) * P.comb;
            this.combMix = P.comb;
            this.rmHz = 80 * Math.pow(40, P.formant);
            this.rmMix = P.rm_mix;
            this.rmPhase = 0;
            this.driveGain = 1 + P.drive * 5;
            this.driveNorm = 1 / tanh(this.driveGain);
            this.amp = P.level * m.velocity;
            this.n = 0;
            this.quiet = 0;
        }
        render(L, R, from, to) {
            for (let i = from; i < to; i++) {
                this.dropState *= this.dropMul;
                const freq = this.f0 * Math.pow(2, (this.drop * this.dropState) / 12);
                this.phase += freq / SR;
                if (this.phase >= 1) this.phase -= 1;
                this.subEnv *= this.subMul;
                const sub = Math.sin(TAU * this.phase) * this.subEnv;

                let x = 0;
                if (this.n < this.burstLen) x = this.burstFilter.lp(this.noise.bi()) * (1 - this.n / this.burstLen) * 0.6;
                let metal = 0;
                for (let k = 0; k < 4; k++) metal += this.modes[k].process(x) / (1 + k * 0.5);

                if (this.rmMix > 0) {
                    this.rmPhase += this.rmHz / SR;
                    if (this.rmPhase >= 1) this.rmPhase -= 1;
                    metal += (metal * Math.sin(TAU * this.rmPhase) - metal) * this.rmMix;
                }

                let metalL = metal, metalR = metal;
                if (this.combMix > 0) {
                    const cl = metal + this.combL.read(this.periodL - 1) * this.combFb;
                    const cr = metal + this.combR.read(this.periodR - 1) * this.combFb;
                    this.combL.write(cl);
                    this.combR.write(cr);
                    metalL = metal + (cl - metal) * this.combMix;
                    metalR = metal + (cr - metal) * this.combMix;
                }

                const l = tanh((sub + metalL) * this.driveGain) * this.driveNorm * this.amp;
                const r = tanh((sub + metalR) * this.driveGain) * this.driveNorm * this.amp;
                L[i] += l;
                R[i] += r;
                this.n++;
                if (this.n > this.burstLen && Math.abs(l) + Math.abs(r) < 1e-5) {
                    if (++this.quiet > 2048) return false;
                } else this.quiet = 0;
            }
            return true;
        }
    }

    return voiceProcessor(Base, (m, P) => new Voice(m, P), 6, {
        init() {
            this.delayL = new Delay(Math.ceil(1.2 * SR));
            this.delayR = new Delay(Math.ceil(1.2 * SR));
            this.dampL = new OnePole(5000);
            this.dampR = new OnePole(5000);
            this.time = 0.3 * SR;
            this.glide = 1 - smoothing(0.08);
        },
        // The ping-pong: left feeds right and right feeds left, the right
        // line longer by d_sprd. Delay time glides (a tape slide) rather than
        // jumping, since it's a live control.
        after(L, R, P) {
            const wet = P.d_wet;
            if (wet <= 0 && Math.abs(this.delayL.tap(0)) + Math.abs(this.delayR.tap(0)) < 1e-7) return;
            const target = (0.02 + 0.88 * P.d_time * P.d_time) * SR;
            const fb = P.d_fb * 0.9;
            const spread = 1 + P.d_sprd * 0.5;
            for (let i = 0; i < L.length; i++) {
                this.time += (target - this.time) * this.glide;
                const dl = this.dampL.lp(this.delayL.read(this.time));
                const dr = this.dampR.lp(this.delayR.read(this.time * spread));
                this.delayL.write(L[i] + dr * fb);
                this.delayR.write(dl * fb);
                L[i] += dl * wet;
                R[i] += dr * wet;
            }
        },
    });
};

registerWorkletProcessor("ribbit-metalbass", metalbassProcessor, workletParams(METALBASS_PARAMS));

export class RibbitMetalBass extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "metalbass", ...options }, {
            processor: "ribbit-metalbass",
            params: METALBASS_PARAMS,
            lane: "5",
            sieve: "8:1",
            quant: true,
        });
        this.llm_summary = "Sub-bass sine welded to a four-mode metal resonator (the AE machine's metal bass voice): material damped->ringing, stretch, tuned comb, ring-mod formant, and its own ping-pong delay (d_time/d_fb/d_sprd/d_wet) that keeps echoing after the note. The note picks the pitch class, pitch the register. Sieve 8:1 on lane 5.";
    };
};
