import { RibbitWorkletModulator } from "../dsp/modsource.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams, choiceOption, toggleOption, isOn } from "../dsp/spec.js";

export const MODLFO_SHAPES = ["sine", "triangle", "sawup", "sawdown", "square", "sh", "drift"];
export const MODLFO_DIVS = { "4bar": 16, "2bar": 8, "1bar": 4, "1/2": 2, "1/4": 1, "1/8": 0.5, "1/16": 0.25 };
const DIV_NAMES = Object.keys(MODLFO_DIVS);

// One modulator per parameter — the AE machine's mod panels (chapter 42).
// Not one LFO routed to a destination: patch one of these into every param
// you want moving, each with its own shape, speed and depth (the patch's
// depth, as a fraction of the param's range — "modulation adds, it does not
// replace").
//
// Seven shapes. The manual's advice: "sine on everything sounds like a synth
// demo" — **`drift`** moves smoothly between random points and sounds alive;
// **`sh`** (sample and hold) jumps once a cycle *and re-rolls when the voice
// is struck* (`strike=<track>`), which locks the randomness to the rhythm.
// `sync=on` locks the rate to the beat at `div` (4 bars down to 1/16, phase
// aligned to the grid); `sync=off` runs free at `hz` (0.01..40).
export const MODLFO_PARAMS = {
    hz: { value: 0.5, min: 0.01, max: 40 },
};

export function modlfoProcessor(Base, DSP) {
    const { SR, TAU, Rng, BeatClock } = DSP;
    return class extends Base {
        constructor(options) {
            super(options);
            const o = (options && options.processorOptions) || {};
            this.shape = o.shape || 0;
            this.sync = !!o.sync;
            this.div = o.div || 4;
            this.clock = new BeatClock();
            this.rng = new Rng(0x70f0 + (o.seed || 0));
            this.phase = 0;
            this.held = 0;
            this.from = 0;
            this.to = this.rng.bi();
            this.strikes = [];
            this.dead = false;
            this.port.onmessage = (event) => {
                const m = event.data;
                if (m.type === "dispose") this.dead = true;
                else if (m.type === "anchor") this.clock.anchor(m);
                else if (m.type === "strike") this.strikes.push(m.time);
                else if (m.type === "config") Object.assign(this, m.config);
            };
        }
        reroll() {
            this.held = this.rng.bi();
            this.from = this.value ?? 0;
            this.to = this.rng.bi();
        }
        process(inputs, outputs, parameters) {
            if (this.dead) return false;
            const out = outputs[0][0];
            const frames = out.length;
            const hz = parameters.hz[0];
            const beat0 = this.sync ? this.clock.beatAt(currentTime) : null;
            const beatStep = this.clock.bpm / 60 / SR;
            for (let i = 0; i < frames; i++) {
                let phase;
                if (beat0 !== null) {
                    const beat = beat0 + beatStep * i;
                    phase = beat / this.div - Math.floor(beat / this.div);
                } else {
                    phase = this.phase + hz / SR;
                    phase -= Math.floor(phase);
                }
                if (phase < this.phase) this.reroll();
                this.phase = phase;
                if (this.strikes.length && this.strikes[0] <= currentTime + i / SR) {
                    this.strikes.shift();
                    this.reroll();
                }
                let v;
                switch (this.shape) {
                    case 1: v = 1 - 4 * Math.abs(phase - 0.5); break;
                    case 2: v = 2 * phase - 1; break;
                    case 3: v = 1 - 2 * phase; break;
                    case 4: v = phase < 0.5 ? 1 : -1; break;
                    case 5: v = this.held; break;
                    case 6: {
                        const t = 0.5 - 0.5 * Math.cos(Math.PI * phase);
                        v = this.from + (this.to - this.from) * t;
                        break;
                    }
                    default: v = Math.sin(TAU * phase);
                }
                this.value = v;
                out[i] = v;
            }
            return true;
        }
    };
};

registerWorkletProcessor("ribbit-modlfo", modlfoProcessor, workletParams(MODLFO_PARAMS));

export class RibbitModLFO extends RibbitWorkletModulator {
    constructor(audioContext, options = {}) {
        const shape = MODLFO_SHAPES.includes(options.shape) ? options.shape : "drift";
        const sync = isOn(options.sync, false);
        const div = DIV_NAMES.includes(options.div) ? options.div : "1bar";
        super(audioContext, { name: "modlfo", ...options }, {
            processor: "ribbit-modlfo",
            params: MODLFO_PARAMS,
            processorOptions: { shape: MODLFO_SHAPES.indexOf(shape), sync, div: MODLFO_DIVS[div] },
        });
        this.llm_summary = "A per-parameter modulator (the AE machine's mod panels): shapes sine, triangle, sawup, sawdown, square, sh (sample and hold, re-rolled on each hit of strike=<track>) and drift (smooth random — the one that sounds alive); sync=on locks to the beat at div (4bar..1/16), off runs free at hz. Patch one into each param you want moving.";
        this.shape = shape;
        this.sync = sync;
        this.div = div;
        const sendConfig = () => this.node.post({ type: "config", config: { shape: MODLFO_SHAPES.indexOf(this.shape), sync: this.sync, div: MODLFO_DIVS[this.div] } });
        this.options = {
            shape: choiceOption(this, "shape", MODLFO_SHAPES, sendConfig),
            sync: toggleOption(this, "sync", sendConfig),
            div: choiceOption(this, "div", DIV_NAMES, sendConfig),
            strike: this.strikeOption(),
        };
    };
};
