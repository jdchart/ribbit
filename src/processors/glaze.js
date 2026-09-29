import { RibbitWorkletProcessor } from "../dsp/effect.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// A granular cloud built from what the machine played in the last few
// seconds — the AE machine's Glaze (`aem_fx_glaze`).
//
// Six grains read continuously from a rolling six-second buffer of the
// input. Each grain, when it restarts, picks its own position (`scatter`: how
// far back — low stays on the present, high reaches the whole buffer), pitch
// (`octave`: up to two octaves up, whole octaves), pan (`spray`) and plays
// with probability `density`. `size` is the grain length (short crackles,
// long smears); `motion` drifts the whole cloud across the stereo field.
// `feed` writes the cloud back into its own buffer — layers build into a
// drone.
//
// **Glaze keeps sounding after the machine stops**: with `feed` up it reads
// and re-reads its own memory, "a bed that slowly forgets where it came
// from". Deliberate. `mix` is the hand that silences it.
export const GLAZE_PARAMS = {
    size: { value: 0.18, min: 0.01, max: 1 },
    density: { value: 0.7, min: 0, max: 1 },
    scatter: { value: 0.4, min: 0, max: 1 },
    spray: { value: 0.6, min: 0, max: 1 },
    motion: { value: 0.2, min: 0, max: 1 },
    octave: { value: 1, min: 0, max: 2 },
    feed: { value: 0.2, min: 0, max: 1 },
    mix: { value: 1, min: 0, max: 1 },
};

export function glazeProcessor(Base, DSP) {
    const { SR, TAU, readAt, Rng, effectProcessor } = DSP;
    const GRAINS = 6;
    const SECONDS = 6;

    return effectProcessor(Base, {
        setup() {
            this.length = Math.ceil(SECONDS * SR);
            this.bufL = new Float32Array(this.length);
            this.bufR = new Float32Array(this.length);
            this.write = 0;
            this.rng = new Rng(0x61a2e);
            this.grains = [];
            for (let g = 0; g < GRAINS; g++) {
                // Staggered so the first cloud isn't six grains in lockstep.
                this.grains.push({ pos: 0, rate: 1, n: 0, len: 1, pan: 0.5, active: false, wait: Math.round(g * 0.03 * SR) });
            }
            this.motionPhase = 0;
            this.wetL = 0;
            this.wetR = 0;
        },
        render(inL, inR, outL, outR, P, frames) {
            const mix = P.mix;
            const feed = P.feed * 0.85;
            const grainLen = P.size * SR;
            const motionHz = P.motion * 0.5;
            for (let i = 0; i < frames; i++) {
                this.motionPhase += motionHz / SR;
                if (this.motionPhase >= 1) this.motionPhase -= 1;
                const drift = Math.sin(TAU * this.motionPhase) * 0.35 * P.motion;
                let l = 0, r = 0;
                for (let g = 0; g < GRAINS; g++) {
                    const grain = this.grains[g];
                    if (grain.wait > 0) {
                        grain.wait--;
                        continue;
                    }
                    if (grain.n >= grain.len) {
                        // Restart: a new position, pitch, pan — and maybe
                        // silence, if density says so.
                        const octaves = Math.floor(this.rng.next() * (P.octave + 1));
                        grain.rate = Math.pow(2, Math.min(2, octaves));
                        grain.len = Math.max(64, grainLen);
                        const reach = 0.02 * SR + this.rng.next() * P.scatter * (this.length - grain.len * grain.rate - 0.05 * SR);
                        grain.pos = this.write - reach - grain.len * grain.rate;
                        grain.pan = 0.5 + (this.rng.next() - 0.5) * P.spray;
                        grain.active = this.rng.next() < P.density;
                        grain.n = 0;
                    }
                    if (grain.active) {
                        const w = Math.sin((Math.PI * grain.n) / grain.len);
                        let p = grain.pos % this.length;
                        if (p < 0) p += this.length;
                        const sl = readAt(this.bufL, p) * w * w;
                        const sr = readAt(this.bufR, p) * w * w;
                        const pan = Math.min(1, Math.max(0, grain.pan + drift));
                        l += (sl + sr) * 0.5 * (1 - pan) * 2;
                        r += (sl + sr) * 0.5 * pan * 2;
                    }
                    grain.pos += grain.rate;
                    grain.n++;
                }
                l *= 0.45;
                r *= 0.45;
                this.bufL[this.write] = inL[i] + l * feed;
                this.bufR[this.write] = inR[i] + r * feed;
                this.write = (this.write + 1) % this.length;
                outL[i] = inL[i] * (1 - mix) + l * mix;
                outR[i] = inR[i] * (1 - mix) + r * mix;
            }
        },
    });
};

registerWorkletProcessor("ribbit-glaze", glazeProcessor, workletParams(GLAZE_PARAMS));

export class RibbitGlaze extends RibbitWorkletProcessor {
    constructor(audioContext, options = {}) {
        super(audioContext, { name: "glaze", ...options }, { processor: "ribbit-glaze", params: GLAZE_PARAMS });
        this.llm_summary = "A granular cloud from the last six seconds of its input (the AE machine's glaze): six grains, size, density, scatter (how far back), spray (pan), motion (cloud drift), octave (up to +2), feed (the cloud into its own buffer, building a drone — it keeps sounding after the music stops; mix silences it).";
    };

    // The Glaze jumper: grain size and scatter.
    jump(random, time) {
        this.setParamAt("size", 0.02 + random() * random() * 0.6, time);
        this.setParamAt("scatter", random(), time);
    };
};
