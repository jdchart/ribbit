import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// Two coupled plucked strings — the AE machine's String Voice (`aemd_ks`):
// "Karplus-Strong synthesis, extended until it can be a kalimba, a bass
// string, a sitar or a metal rod."
//
// Each string is a delay line one period long with a loss filter in its
// loop (`bright`: how much high frequency survives each pass — the string's
// material) and a loop gain set from `decay` so the ring time is the same at
// every pitch. It runs in a worklet, not a buffer render like `karplus`,
// because everything below needs the loop to keep being *played* while it
// rings:
//
//   pick     where it's plucked: the excitation is combed at pick×period,
//            which removes the harmonics with a node at that point.
//   stiff    two first-order allpasses in the loop — dispersion, so upper
//            partials run sharp the way thick strings and rods do. The
//            allpasses' and the loss filter's phase delay at the fundamental
//            is subtracted from the line, so stiffness doesn't detune.
//   tension  the loop shortens with the string's own amplitude: a hard pluck
//            starts sharp and settles as it decays.
//   couple   the strings (detuned a few cents apart) exchange energy through
//            a shared bridge: beating, and a two-stage decay at 1.
//   scatter  random re-excitations while it rings, plus a one-sided buzz at
//            the bridge — sitar, rattle.
//   drive    saturation *inside* the loop, normalised to never add gain.
//
// Recipes (manual): kalimba bright 0.4, decay 0.5, pick 0.25, stiff 0.1,
// couple 0. Bass string low pitch, bright 0.8, stiff 0.5, tension 0.3. Sitar
// scatter 0.5, couple 0.7, bright 0.7. Metal rod stiff 0.9, bright 0.9,
// decay 0.9, pick 0.5.
export const TWOSTRING_PARAMS = {
    pitch: { value: 48, min: 12, max: 108 },
    bright: { value: 0.55, min: 0, max: 1 },
    decay: { value: 0.5, min: 0, max: 1 },
    pick: { value: 0.25, min: 0, max: 1 },
    stiff: { value: 0.1, min: 0, max: 1 },
    tension: { value: 0.1, min: 0, max: 1 },
    couple: { value: 0.2, min: 0, max: 1 },
    scatter: { value: 0, min: 0, max: 1 },
    drive: { value: 0, min: 0, max: 1 },
    keytrk: { value: 1, min: 0, max: 1 },
    n_tmbr: { value: 0.3, min: 0, max: 1 },
    level: { value: 0.7, min: 0, max: 1 },
};

export function twostringProcessor(Base, DSP) {
    const { SR, TAU, clamp, mtof, tanh, Delay, Allpass1, OnePole, Follower, Rng, voiceProcessor } = DSP;
    const seeds = new Rng(0x2575);

    // Phase delay, in samples, of a first-order allpass (c + z^-1)/(1 + c z^-1)
    // and of the one-pole lowpass y = (1-p)x + p·y1, at radian frequency w.
    const allpassDelay = (c, w) => {
        const re = c + Math.cos(w), im = -Math.sin(w);
        const dre = 1 + c * Math.cos(w), dim = -c * Math.sin(w);
        return -Math.atan2(im * dre - re * dim, re * dre + im * dim) / w;
    };
    const onePoleDelay = (p, w) => Math.atan2(p * Math.sin(w), 1 - p * Math.cos(w)) / w;

    class Str {
        constructor(freq, P, brightness) {
            this.period = SR / freq;
            this.line = new Delay(Math.ceil(this.period * 1.2) + 8);
            // Loss filter: a one-pole lowpass whose cutoff rides above the
            // fundamental by `bright`.
            const cutoff = Math.min(SR * 0.45, freq * (2.5 + 60 * brightness * brightness));
            this.pole = Math.exp(-TAU * cutoff / SR);
            this.y = 0;
            // Dispersion. In the standard form (c + z^-1)/(1 + c z^-1) a
            // *negative* c delays high frequencies less than low ones, so
            // upper partials come round the loop early and run sharp — a
            // stiff string. (Allpass1's own coefficient is -c.) At stiff 0
            // the pair is still a two-sample delay, so it is always
            // compensated, not only when stiff is up.
            const c = -0.62 * P.stiff;
            this.ap1 = new Allpass1(-c);
            this.ap2 = new Allpass1(-c);
            const w = TAU * freq / SR;
            const compensation = 2 * allpassDelay(c, w) + onePoleDelay(this.pole, w);
            this.length = Math.max(2, this.period - compensation);
            // Loop gain for a -60dB ring of 0.15..14s, whatever the pitch.
            const ring = 0.15 * Math.pow(93, P.decay);
            this.gain = Math.pow(0.001, 1 / (ring * freq));
            this.out = 0;
        }
        // Reads the loop and runs it through loss filter + dispersion.
        read(lengthScale) {
            const raw = this.line.readHermite(this.length * lengthScale - 1);
            this.y = (1 - this.pole) * raw + this.pole * this.y;
            let v = this.y;
            v = this.ap1.process(v);
            v = this.ap2.process(v);
            return v * this.gain;
        }
    }

    class Voice {
        constructor(m, P) {
            const pitch = P.pitch + P.keytrk * (m.pitch - P.pitch);
            const freq = mtof(pitch);
            const noteT = clamp((m.pitch - 60) / 24, -1, 1.5) * P.n_tmbr;
            const brightness = clamp(P.bright + noteT * 0.25 + (m.velocity - 0.7) * 0.2, 0, 1);
            const detune = Math.pow(2, (2 + 4 * P.couple) / 1200);
            this.a = new Str(freq, P, brightness);
            this.b = new Str(freq * detune, P, brightness);
            this.couple = P.couple * 0.5;
            this.tension = P.tension * 0.035;
            this.scatter = P.scatter;
            this.driveGain = 1 + P.drive * 3;
            this.noise = new Rng((seeds.next() * 4294967296) >>> 0);

            // The pluck: one period of noise, combed at the pick point and
            // softened for a gentle hit.
            const length = Math.max(4, Math.round(this.a.period));
            this.excitation = new Float32Array(length);
            const pickOffset = Math.max(1, Math.round(length * (0.04 + 0.46 * P.pick)));
            const raw = new Float32Array(length);
            for (let i = 0; i < length; i++) raw[i] = this.noise.bi();
            const soft = new OnePole(Math.min(SR * 0.45, 400 + brightness * brightness * 16000));
            for (let i = 0; i < length; i++) {
                const combed = raw[i] - (i >= pickOffset ? raw[i - pickOffset] : 0);
                this.excitation[i] = soft.lp(combed) * m.velocity * 0.9;
            }
            this.follower = new Follower(0.002, 0.08);
            // In-loop drive holds the string's amplitude near 1/driveGain;
            // make most of that back so drive is a colour, not a fader.
            this.outGain = P.level * Math.pow(this.driveGain, 0.8);
            this.burst = 0;
            this.n = 0;
            this.quiet = 0;
        }
        render(L, R, from, to) {
            const a = this.a, b = this.b;
            for (let i = from; i < to; i++) {
                let exc = this.n < this.excitation.length ? this.excitation[this.n] : 0;
                // Scatter: occasional short noise kicks while ringing.
                if (this.scatter > 0) {
                    if (this.burst > 0) {
                        exc += this.noise.bi() * 0.25 * this.follower.e;
                        this.burst--;
                    } else if (this.noise.next() < this.scatter * this.scatter * 0.002) {
                        this.burst = 12 + ((this.noise.next() * 40) | 0);
                    }
                }
                const loud = this.follower.e;
                const scale = 1 - this.tension * Math.min(1, loud * 3);
                const sa = a.read(scale);
                const sb = b.read(scale);
                let va = exc + sa + this.couple * (sb - sa);
                let vb = exc * 0.8 + sb + this.couple * (sa - sb);
                if (this.driveGain > 1) {
                    va = tanh(va * this.driveGain) / this.driveGain;
                    vb = tanh(vb * this.driveGain) / this.driveGain;
                }
                // The bridge buzz: a one-sided soft limit that only acts when
                // scatter is up — the jawari of a sitar.
                if (this.scatter > 0 && va > 0.2) va = 0.2 + (va - 0.2) * (1 - this.scatter * 0.6);
                a.line.write(va);
                b.line.write(vb);
                this.follower.process(va + vb);
                const l = (va * 0.65 + vb * 0.35) * this.outGain;
                const r = (va * 0.35 + vb * 0.65) * this.outGain;
                L[i] += l;
                R[i] += r;
                this.n++;
                if (this.n > this.excitation.length && Math.abs(l) + Math.abs(r) < 1e-5) {
                    if (++this.quiet > 2048) return false;
                } else this.quiet = 0;
            }
            return true;
        }
    }

    return voiceProcessor(Base, (m, P) => new Voice(m, P), 10);
};

registerWorkletProcessor("ribbit-twostring", twostringProcessor, workletParams(TWOSTRING_PARAMS));

export class RibbitTwoString extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "twostring", ...options }, {
            processor: "ribbit-twostring",
            params: TWOSTRING_PARAMS,
            lane: "5",
            sieve: "6:5",
            quant: true,
        });
        this.llm_summary = "Two coupled plucked strings (the AE machine's string voice, extended Karplus-Strong): bright=material, pick=pluck position, stiff=dispersion (metal rod), tension=pitch settles as it decays, couple=beating two-stage decay, scatter=sitar buzz. Sieve 6:5 on lane 5.";
    };
};
