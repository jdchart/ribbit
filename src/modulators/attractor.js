import { RibbitWorkletModulator } from "../dsp/modsource.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams, choiceOption } from "../dsp/spec.js";

const SYSTEMS = ["coullet", "lorenz", "rossler"];
const AXES = ["x", "y", "z"];

// A chaotic attractor as a modulation source — what the AE machine gives Big
// Modal (six Coullet orbits) and Terrarium (a Lorenz), available here to patch
// into anything. The manual's inheritance: Ornament and Crime, which "hands you
// chaotic attractors as ordinary modulation sources".
//
// Three systems, integrated at audio rate (midpoint steps every 16 samples,
// interpolated between):
//   coullet   x' = y, y' = z, z' = 0.8x − 1.1y − 0.45z − x³ (Arneodo–Coullet–
//             Tresser; the Wakefield/Taylor gen~ example): gestures with an
//             average period that breathes
//   lorenz    the butterfly: long stays in one lobe, sudden flips
//   rossler   a spiral that folds: nearly periodic, then not
// `axis` picks the coordinate, scaled to about ±1. `rate` is how fast the
// orbit runs; `wander` blends it towards a gaussian random walk (0 chaos —
// shapes and gestures; 1 pure drift — neither; small amounts are the useful
// ones). With `strike=<track>`, each hit on that track *pushes the orbit's
// speed* — a hard passage makes it race and draw wider gestures, silence lets
// it crawl. "The music deflects the chaos instead of replacing it."
export const ATTRACTOR_PARAMS = {
    rate: { value: 0.1, min: 0.001, max: 1 },
    wander: { value: 0, min: 0, max: 1 },
};

export function attractorProcessor(Base, DSP) {
    const { SR, clamp, Rng } = DSP;
    const SUB = 16;
    // Writes (x', y', z') into `d` — no allocation on the audio thread.
    const derivative = (system, x, y, z, d) => {
        if (system === 1) { d[0] = 10 * (y - x); d[1] = x * (28 - z) - y; d[2] = x * y - (8 / 3) * z; }
        else if (system === 2) { d[0] = -y - z; d[1] = x + 0.2 * y; d[2] = 0.2 + z * (x - 5.7); }
        else { d[0] = y; d[1] = z; d[2] = 0.8 * x - 1.1 * y - 0.45 * z - x * x * x; }
    };
    // Per-system scale (and centre, for Lorenz z / Rössler z) to about ±1.
    const SCALE = [[1.5, 1.5, 1.5, 0, 0, 0], [20, 27, 25, 0, 0, 25], [9, 9, 12, 0, 0, 10]];
    // Speed that makes rate 0.1 sound like "a slow gesture" for each system.
    const SPEED = [9, 0.6, 3];
    return class extends Base {
        constructor(options) {
            super(options);
            const o = (options && options.processorOptions) || {};
            this.system = o.system || 0;
            this.axis = o.axis || 0;
            this.rng = new Rng(0xa77 + (o.seed || 0));
            this.d = new Float64Array(3);
            this.e = new Float64Array(3);
            this.reset();
            this.push = 0;
            this.walk = 0;
            this.prev = 0;
            this.next = 0;
            this.count = SUB;
            this.strikes = [];
            this.dead = false;
            this.port.onmessage = (event) => {
                const m = event.data;
                if (m.type === "dispose") this.dead = true;
                else if (m.type === "strike") this.push = Math.min(3, this.push + 1);
                else if (m.type === "config") {
                    if (m.config.system !== this.system) {
                        this.system = m.config.system;
                        this.reset();
                    }
                    this.axis = m.config.axis;
                }
            };
        }
        reset() {
            this.x = 0.1 + this.rng.bi() * 0.05;
            this.y = this.rng.bi() * 0.05;
            this.z = this.system === 1 ? 20 : 0.05;
        }
        step(h) {
            const s = this.system, d = this.d, e = this.e;
            derivative(s, this.x, this.y, this.z, d);
            derivative(s, this.x + 0.5 * h * d[0], this.y + 0.5 * h * d[1], this.z + 0.5 * h * d[2], e);
            this.x += h * e[0];
            this.y += h * e[1];
            this.z += h * e[2];
            if (!(Math.abs(this.x) < 1e3 && Math.abs(this.y) < 1e3 && Math.abs(this.z) < 1e3)) this.reset();
        }
        process(inputs, outputs, parameters) {
            if (this.dead) return false;
            const out = outputs[0][0];
            const rate = parameters.rate[0];
            const wander = parameters.wander[0];
            this.push *= Math.exp(-out.length / SR / 0.8);
            const dt = (SUB / SR) * rate * SPEED[this.system] * 10 * (1 + this.push);
            const scale = SCALE[this.system];
            for (let i = 0; i < out.length; i++) {
                if (this.count >= SUB) {
                    this.count = 0;
                    const n = Math.max(1, Math.ceil(dt / 0.01));
                    for (let k = 0; k < n; k++) this.step(dt / n);
                    const raw = this.axis === 0 ? this.x : this.axis === 1 ? this.y : this.z;
                    const chaos = clamp((raw - scale[this.axis + 3]) / scale[this.axis], -1, 1);
                    this.walk = clamp(this.walk * 0.9995 + this.rng.gauss() * 0.01, -1, 1);
                    this.prev = this.next;
                    this.next = chaos + (this.walk - chaos) * wander;
                }
                out[i] = this.prev + (this.next - this.prev) * (this.count / SUB);
                this.count++;
            }
            return true;
        }
    };
};

registerWorkletProcessor("ribbit-attractor", attractorProcessor, workletParams(ATTRACTOR_PARAMS));

export class RibbitAttractor extends RibbitWorkletModulator {
    constructor(audioContext, options = {}) {
        const system = SYSTEMS.includes(options.system) ? options.system : "coullet";
        const axis = AXES.includes(options.axis) ? options.axis : "x";
        super(audioContext, { name: "attractor", ...options }, {
            processor: "ribbit-attractor",
            params: ATTRACTOR_PARAMS,
            processorOptions: { system: SYSTEMS.indexOf(system), axis: AXES.indexOf(axis) },
        });
        this.llm_summary = "A chaotic attractor as a continuous modulation source (Big Modal's and Terrarium's engine, patchable anywhere): system coullet|lorenz|rossler, axis x|y|z scaled to ±1, rate = orbit speed, wander blends towards a random walk. strike=<track> makes each hit push the orbit faster — the music deflects the chaos.";
        this.system = system;
        this.axis = axis;
        const sendConfig = () => this.node.post({ type: "config", config: { system: SYSTEMS.indexOf(this.system), axis: AXES.indexOf(this.axis) } });
        this.options = {
            system: choiceOption(this, "system", SYSTEMS, sendConfig),
            axis: choiceOption(this, "axis", AXES, sendConfig),
            strike: this.strikeOption(),
        };
    };

    // Unsynced: an attractor keeps its own time. Only strikes matter here.
    onSchedule(fromBeat, toBeat, secondsPerBeat, clock) {
        if (!this.strike || !this.engine) return;
        super.onSchedule(fromBeat, toBeat, secondsPerBeat, clock);
    };
};
