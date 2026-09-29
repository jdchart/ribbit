import { RibbitWorkletProcessor, tunedDelay } from "../dsp/effect.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// A delay with a pitch shifter inside the feedback loop — the AE machine's
// Cascade (`aem_fx_cascade`). Every repeat comes back transposed, so echoes
// fall or climb away into the distance. "Set shift to +7 and feedback high:
// the echoes climb away in fifths until they disappear into the top of the
// spectrum. It is the single most recognisable sound in this machine."
//
// Per channel: delay → pitch shift → damp → a resonant band (`reson` at
// `rfreq`) → `drive` → diffusion (`morph`: clean echo to a smeared,
// reverb-like tail) → back into the delay. `time` glides, so moving it slides
// pitch like tape; `shift` is semitones per repeat (default −5, a fourth
// down); `win` the shifter's grain (small is metallic, large smeared);
// `spread` offsets left and right in pitch (wide beating); `xfb` crosses the
// two cascades into each other.
//
// The shifter is the classic two-tap delay-line kind: two read heads sweep a
// short buffer at the rate the ratio implies, each windowed by a sin² that is
// silent where it wraps, half a grain apart — so their sum is continuous.
// Inside a feedback loop that's exactly the Cascade's character: each
// generation is shifted again, with a little of the grain's texture.
export const CASCADE_PARAMS = {
    time: { value: 0.32, min: 0.02, max: 2 },
    shift: { value: -5, min: -12, max: 12 },
    feedback: { value: 0.6, min: 0, max: 1 },
    win: { value: 0.06, min: 0.01, max: 0.2 },
    damp: { value: 0.3, min: 0, max: 1 },
    xfb: { value: 0.2, min: 0, max: 1 },
    spread: { value: 0.2, min: 0, max: 1 },
    reson: { value: 0, min: 0, max: 1 },
    rfreq: { value: 1200, min: 100, max: 8000 },
    drive: { value: 0.1, min: 0, max: 1 },
    morph: { value: 0.1, min: 0, max: 1 },
    mix: { value: 1, min: 0, max: 1 },
};

export function cascadeProcessor(Base, DSP) {
    const { SR, TAU, tanh, smoothing, Delay, OnePole, SVF, Allpass, effectProcessor } = DSP;

    class Shifter {
        constructor() {
            this.line = new Delay(Math.ceil(0.25 * SR));
            this.phase = 0;
        }
        process(x, ratio, windowSamples) {
            this.line.write(x);
            // Each head's delay shrinks (pitch up) or grows (pitch down) at
            // 1 - ratio samples per sample, wrapping every window.
            this.phase += (1 - ratio) / windowSamples;
            this.phase -= Math.floor(this.phase);
            const p2 = (this.phase + 0.5) % 1;
            const d1 = 1 + this.phase * windowSamples;
            const d2 = 1 + p2 * windowSamples;
            const w1 = Math.sin(Math.PI * this.phase);
            const w2 = Math.sin(Math.PI * p2);
            return this.line.read(d1) * w1 * w1 + this.line.read(d2) * w2 * w2;
        }
    }

    class Channel {
        constructor(side) {
            this.delay = new Delay(Math.ceil(2.1 * SR));
            this.shifter = new Shifter();
            this.damp = new OnePole(8000);
            this.band = new SVF(1200, 4);
            this.diffuse = [new Allpass(Math.round(0.0113 * SR + side * 37), 0.6), new Allpass(Math.round(0.0171 * SR + side * 53), 0.6)];
            this.out = 0;
        }
    }

    return effectProcessor(Base, {
        setup() {
            this.left = new Channel(0);
            this.right = new Channel(1);
            this.time = 0.32 * SR;
            this.glide = 1 - smoothing(0.12);
        },
        render(inL, inR, outL, outR, P, frames) {
            const target = P.time * SR;
            const fb = P.feedback * 0.97;
            const windowSamples = P.win * SR;
            const spreadSemis = P.spread * 0.35;
            const ratioL = Math.pow(2, (P.shift - spreadSemis) / 12);
            const ratioR = Math.pow(2, (P.shift + spreadSemis) / 12);
            const dampHz = 300 + 17000 * (1 - P.damp) * (1 - P.damp);
            this.left.damp.set(dampHz);
            this.right.damp.set(dampHz);
            this.left.band.set(P.rfreq, 1 + P.reson * 10);
            this.right.band.set(P.rfreq * 1.01, 1 + P.reson * 10);
            const driveGain = 1 + P.drive * 5;
            const driveNorm = 1 / tanh(driveGain);
            const morph = P.morph;
            const xfb = P.xfb * 0.5;
            const mix = P.mix;
            const L = this.left, R = this.right;
            const reson = P.reson;
            // One generation of the loop, for one channel. Defined per block,
            // not per sample: nothing on the audio thread should allocate.
            const loop = (ch, echo, ratio) => {
                let v = ch.shifter.process(echo, ratio, windowSamples);
                v = ch.damp.lp(v);
                ch.band.process(v);
                // band·k is the unity-peak bandpass (the raw band output
                // peaks at Q, which would push the loop past unity).
                v += (ch.band.band * ch.band.k - v) * reson;
                v = tanh(v * driveGain) * driveNorm;
                if (morph > 0) {
                    const d = ch.diffuse[1].process(ch.diffuse[0].process(v));
                    v += (d - v) * morph;
                }
                return v;
            };
            for (let i = 0; i < frames; i++) {
                this.time += (target - this.time) * this.glide;
                const vL = loop(L, L.delay.read(this.time), ratioL);
                const vR = loop(R, R.delay.read(this.time * 1.013), ratioR);
                L.delay.write(inL[i] + (vL * (1 - xfb) + vR * xfb) * fb);
                R.delay.write(inR[i] + (vR * (1 - xfb) + vL * xfb) * fb);
                // The output is the shifted signal, so even the first repeat
                // arrives transposed.
                outL[i] = inL[i] * (1 - mix) + vL * mix;
                outR[i] = inR[i] * (1 - mix) + vR * mix;
            }
        },
    });
};

registerWorkletProcessor("ribbit-cascade", cascadeProcessor, workletParams(CASCADE_PARAMS));

const JUMP_SHIFTS = [-12, -7, -5, -3, 3, 5, 7, 12];

export class RibbitCascade extends RibbitWorkletProcessor {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "cascade", ...options }, { processor: "ribbit-cascade", params: CASCADE_PARAMS });
        this.llm_summary = "A delay with a pitch shifter inside its feedback loop (the AE machine's cascade): every repeat comes back transposed by shift semitones (-5 falls in fourths, +7 climbs away in fifths). time glides like tape; win = shifter grain; reson/rfreq a resonant band in the loop; drive; morph clean echo -> diffuse tail; xfb/spread stereo.";
    };

    // The Cascade jumper: a delay time in tune, and a new interval.
    jump(random, time, tuning) {
        this.setParamAt("time", tunedDelay(random, tuning, 0.08, 0.9), time);
        this.setParamAt("shift", JUMP_SHIFTS[Math.floor(random() * JUMP_SHIFTS.length)], time);
    };
};
