import { RibbitWorkletModulator } from "../dsp/modsource.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams, choiceOption } from "../dsp/spec.js";

const DIVS = { "1": 4, "1/2": 2, "1/4": 1, "1/8": 0.5, "1/16": 0.25, "1/32": 0.125 };
const DIV_NAMES = Object.keys(DIVS);

// A drawn curve that loops in time with the tempo — the AE machine's Shapes
// (`aems_shape`, chapter 27), four of which ride the slice sampler's slice,
// rate, end and window. Not an envelope in the ADSR sense: a curve played left
// to right over a musical length, then again.
//
// `points` is the drawing (up to 64 values 0..1, evenly spaced; lilypad and
// the console both write it). `div` × `mult` is the loop length (a whole note
// down to a thirty-second, times 1..64), locked to the beat. `min`/`max` map
// the curve's 0..1 into the output — a patch then adds that, at its own depth;
// "shapes add, they do not set". `rate` is the most musical control of the
// system (the manual's *SHAPE rate ×*): how fast this curve is read — give
// four curves four different rates and they drift against each other, the
// whole landscape repeating only when all four meet again.
//
// Random curves: `rnd=now` draws one — `npoints` points, `jump` how contrasty
// (few points and low jump: slow drifts; many and high: jagged staircases) —
// and `auto` is the chance each cycle redraws itself. `clr=now` flattens it.
// A redrawn curve is written back to `points`, so a session keeps what the
// dice drew.
export const CURVELOOP_PARAMS = {
    rate: { value: 1, min: 0.125, max: 4 },
    min: { value: 0, min: -1, max: 1 },
    max: { value: 1, min: -1, max: 1 },
    auto: { value: 0, min: 0, max: 100 },
    npoints: { value: 8, min: 2, max: 32 },
    jump: { value: 0.5, min: 0, max: 1 },
};

export function curveloopProcessor(Base, DSP) {
    const { SR, Rng, BeatClock } = DSP;
    return class extends Base {
        constructor(options) {
            super(options);
            const o = (options && options.processorOptions) || {};
            this.points = o.points || [0, 1];
            this.length = o.length || 4;
            this.clock = new BeatClock();
            this.rng = new Rng(0xc0e + (o.seed || 0));
            this.phase = 0;
            this.freePhase = 0;
            this.dead = false;
            this.port.onmessage = (event) => {
                const m = event.data;
                if (m.type === "dispose") this.dead = true;
                else if (m.type === "anchor") this.clock.anchor(m);
                else if (m.type === "points") this.points = m.points;
                else if (m.type === "length") this.length = m.length;
                else if (m.type === "random") this.draw(m.npoints, m.jump);
            };
        }
        // A random curve: a walk whose steps are as big as `jump` allows.
        draw(npoints, jump) {
            const n = Math.max(2, Math.min(64, Math.round(npoints)));
            const points = [];
            let v = this.rng.next();
            for (let i = 0; i < n; i++) {
                points.push(Math.round(v * 1000) / 1000);
                v = Math.min(1, Math.max(0, v + this.rng.bi() * (0.1 + jump * 0.9)));
            }
            this.points = points;
            this.port.postMessage({ type: "points", points });
        }
        process(inputs, outputs, parameters) {
            if (this.dead) return false;
            const out = outputs[0][0];
            const rate = parameters.rate[0];
            const lo = parameters.min[0], hi = parameters.max[0];
            const beat0 = this.clock.beatAt(currentTime);
            const beatStep = this.clock.bpm / 60 / SR;
            const points = this.points;
            const n = points.length;
            for (let i = 0; i < out.length; i++) {
                let phase;
                if (beat0 !== null) {
                    const cycles = ((beat0 + beatStep * i) * rate) / this.length;
                    phase = cycles - Math.floor(cycles);
                } else {
                    this.freePhase += (rate * 2) / this.length / SR;
                    this.freePhase -= Math.floor(this.freePhase);
                    phase = this.freePhase;
                }
                if (phase < this.phase && this.rng.next() * 100 < parameters.auto[0]) {
                    this.draw(parameters.npoints[0], parameters.jump[0]);
                }
                this.phase = phase;
                let v;
                if (n === 1) v = points[0];
                else {
                    const x = phase * (n - 1);
                    const k = Math.min(n - 2, Math.floor(x));
                    v = points[k] + (points[k + 1] - points[k]) * (x - k);
                }
                out[i] = lo + (hi - lo) * v;
            }
            return true;
        }
    };
};

registerWorkletProcessor("ribbit-curveloop", curveloopProcessor, workletParams(CURVELOOP_PARAMS));

function parsePoints(value) {
    const points = (Array.isArray(value) ? value : String(value).split(",")).map(Number);
    if (points.length < 1 || points.length > 64 || points.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) {
        throw new Error(`invalid points "${value}" — expected 1..64 comma-separated values in 0..1`);
    }
    return points;
};

export class RibbitCurveLoop extends RibbitWorkletModulator {
    constructor(audioContext, options = {}) {
        const points = options.points ? parsePoints(options.points) : [0, 0.8, 0.3, 1, 0.1, 0.6];
        const div = DIV_NAMES.includes(String(options.div)) ? String(options.div) : "1";
        const mult = Math.max(1, Math.min(64, Math.round(Number(options.mult) || 1)));
        super(audioContext, { name: "curveloop", ...options }, {
            processor: "ribbit-curveloop",
            params: CURVELOOP_PARAMS,
            processorOptions: { points, length: DIVS[div] * mult },
        });
        this.llm_summary = "A hand-drawn curve looping on a musical length (the AE machine's shapes): points (0..1 values), div x mult (whole note .. 1/32, x1..64) locked to the beat, rate (read-speed multiplier — give several curves different rates and they drift against each other), min/max output range. rnd=now draws a random one (npoints, jump), auto% redraws each cycle, clr=now flattens.";
        this.points = points;
        this.div = div;
        this.mult = mult;
        const sendLength = () => this.node.post({ type: "length", length: DIVS[this.div] * this.mult });
        this.options = {
            points: {
                get: () => this.points.join(","),
                set: (value) => {
                    this.points = parsePoints(value);
                    this.node.post({ type: "points", points: this.points });
                },
            },
            div: choiceOption(this, "div", DIV_NAMES, sendLength),
            mult: {
                get: () => this.mult,
                set: (value) => {
                    this.mult = Math.max(1, Math.min(64, Math.round(Number(value) || 1)));
                    sendLength();
                },
            },
            rnd: {
                get: () => "-",
                set: () => this.node.post({ type: "random", npoints: this.params.npoints.get(), jump: this.params.jump.get() }),
            },
            clr: {
                get: () => "-",
                set: () => {
                    this.points = [0, 0];
                    this.node.post({ type: "points", points: this.points });
                },
            },
        };
        this.onWorkletMessage = (message) => {
            if (message.type === "points") this.points = message.points;
        };
    };

    getOptions() {
        const { rnd, clr, ...rest } = super.getOptions();
        return rest;
    };
};
