import { RibbitWorkletProcessor } from "../dsp/effect.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams, isOn } from "../dsp/spec.js";

// Thirty seconds of memory with a playhead you draw — the AE machine's
// circular looper (`aemd_looper`). "It captures what a preset cannot: the
// actual sound of a moment."
//
// Put it on a bus fed by the mix (the AE's looper listens to the master; in
// ribbit, send the tracks to a `mix` bus and add a send from that bus into a
// `loop` bus carrying this — it never records itself, since its output leaves
// by the loop bus). `rec=on` records (the first take sets the loop's length:
// however long you held it, up to 30s); `rec=on` again over a loop overdubs,
// with `ovr_fbk` below 1 fading older layers. `play=on` plays, `clear=now`
// erases. All three take `at=`, which is the point — a take bounded by cycle
// boundaries is a whole number of bars.
//
// `speed` (−4..4, negative backwards, interpolated so off-speeds stay clean),
// `start`/`length` (a window inside the loop — shrink it to isolate a
// fragment), `xfade` (ms at the seam), `level`, `monitor` (pass the input
// through too; 0 on a send bus).
//
// **The morph curves** are what make it more than a looper. Instead of moving
// evenly, the playhead can follow a curve — `curve_a` and `curve_b`, each a
// list of points 0..1 spread evenly across one pass, blended by `morph`,
// obeyed by `depth`. Where the curve rises the loop runs forward, where it
// falls backward, where it's flat it holds. A staircase (`0,0,0.25,0.25,
// 0.5,0.5,0.75,0.75`) holds on fixed points and jumps between them — a
// granular stutter designed by hand; morph slowly to a straight line
// (`0,1`) and hear it resolve into normal playback.
export const LOOPER_PARAMS = {
    speed: { value: 1, min: -4, max: 4 },
    start: { value: 0, min: 0, max: 1 },
    length: { value: 1, min: 0, max: 1 },
    xfade: { value: 10, min: 0, max: 200 },
    ovr_fbk: { value: 0.8, min: 0, max: 1 },
    level: { value: 0.8, min: 0, max: 1 },
    depth: { value: 0, min: 0, max: 1 },
    morph: { value: 0, min: 0, max: 1 },
    monitor: { value: 0, min: 0, max: 1 },
};

const MAX_SECONDS = 30;

export function looperProcessor(Base, DSP) {
    const { SR, readLoop, effectProcessor } = DSP;
    const CAPACITY_SECONDS = 30; // MAX_SECONDS, restated: the factory can't see its module

    const curveAt = (points, phase) => {
        const n = points.length;
        if (n === 1) return points[0];
        const x = phase * (n - 1);
        const i = Math.min(n - 2, Math.floor(x));
        return points[i] + (points[i + 1] - points[i]) * (x - i);
    };

    const Processor = effectProcessor(Base, {
        setup() {
            this.capacity = Math.ceil(CAPACITY_SECONDS * SR);
            this.bufL = new Float32Array(this.capacity);
            this.bufR = new Float32Array(this.capacity);
            this.loopLength = 0;
            this.recording = false;
            this.fresh = false;
            this.recPos = 0;
            this.playing = !!this.opts.play;
            this.phase = 0;
            this.curveA = this.opts.curveA || [0, 1];
            this.curveB = this.opts.curveB || [0, 1];
            this.statusTimer = 0;
        },
        onMessage(m) {
            if (m.type === "rec") this.setRecording(m.on);
            else if (m.type === "play") this.playing = m.on;
            else if (m.type === "clear") {
                this.loopLength = 0;
                this.recording = false;
                this.bufL.fill(0);
                this.bufR.fill(0);
            } else if (m.type === "curves") {
                this.curveA = m.a;
                this.curveB = m.b;
            }
        },
        render(inL, inR, outL, outR, P, frames) {
            const monitor = P.monitor;
            for (let i = 0; i < frames; i++) {
                const xl = inL[i], xr = inR[i];
                let l = 0, r = 0;
                // First take: write straight in, the loop grows.
                if (this.recording && this.fresh) {
                    this.bufL[this.recPos] = xl;
                    this.bufR[this.recPos] = xr;
                    if (++this.recPos >= this.capacity) this.setRecording(false);
                }
                if (this.loopLength > 0 && (this.playing || (this.recording && !this.fresh))) {
                    const winStart = Math.min(this.loopLength - 64, P.start * this.loopLength);
                    const winLength = Math.max(64, Math.min(this.loopLength - winStart, P.length * this.loopLength));
                    this.phase += P.speed / winLength;
                    this.phase -= Math.floor(this.phase);
                    const curve = curveAt(this.curveA, this.phase) + (curveAt(this.curveB, this.phase) - curveAt(this.curveA, this.phase)) * P.morph;
                    const place = this.phase + (Math.min(1, Math.max(0, curve)) - this.phase) * P.depth;
                    const position = winStart + Math.min(0.99999, place) * winLength;
                    const fade = Math.min(winLength * 0.5, (P.xfade / 1000) * SR);
                    if (this.playing) {
                        l = readLoop(this.bufL, position, winStart, winLength, fade);
                        r = readLoop(this.bufR, position, winStart, winLength, fade);
                    }
                    // Overdub at the playhead, older layers fading by ovr_fbk.
                    if (this.recording && !this.fresh) {
                        const index = Math.floor(position);
                        this.bufL[index] = this.bufL[index] * P.ovr_fbk + xl;
                        this.bufR[index] = this.bufR[index] * P.ovr_fbk + xr;
                    }
                }
                outL[i] = l * P.level + xl * monitor;
                outR[i] = r * P.level + xr * monitor;
            }
            this.statusTimer += frames;
            if (this.statusTimer > SR / 2) {
                this.statusTimer = 0;
                this.port.postMessage({ type: "status", length: this.loopLength / SR, recording: this.recording, fresh: this.fresh, position: this.phase });
            }
        },
    });

    // rec on: a fresh take if there's no loop, an overdub if there is.
    // rec off: a fresh take becomes the loop, its length however long it ran.
    Processor.prototype.setRecording = function setRecording(on) {
        if (on && !this.recording) {
            this.recording = true;
            this.fresh = this.loopLength === 0;
            this.recPos = 0;
        } else if (!on && this.recording) {
            this.recording = false;
            if (this.fresh) {
                this.loopLength = Math.max(Math.round(0.05 * SR), this.recPos);
                this.phase = 0;
                this.fresh = false;
            }
        }
    };

    return Processor;
};

registerWorkletProcessor("ribbit-looper", looperProcessor, workletParams(LOOPER_PARAMS));

function parseCurve(value, name) {
    const points = (Array.isArray(value) ? value : String(value).split(",")).map(Number);
    if (points.length < 1 || points.length > 64 || points.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) {
        throw new Error(`invalid ${name} "${value}" — expected 1..64 comma-separated points in 0..1, e.g. 0,0,0.5,0.5,1`);
    }
    return points;
};

export class RibbitLooper extends RibbitWorkletProcessor {
    constructor(audioContext, options = {}) {
        const curveA = options.curve_a ? parseCurve(options.curve_a, "curve_a") : [0, 1];
        const curveB = options.curve_b ? parseCurve(options.curve_b, "curve_b") : [0, 1];
        const play = isOn(options.play, false);
        super(audioContext, { name: "looper", ...options }, {
            processor: "ribbit-looper",
            params: LOOPER_PARAMS,
            processorOptions: { curveA, curveB, play },
        });
        this.llm_summary = "A 30-second circular looper (the AE machine's looper): rec=on/off (the first take sets the length, later ones overdub with ovr_fbk), play=on/off, clear=now — all deferrable with at=. speed -4..4, start/length window, xfade, level, monitor. The playhead can follow hand-drawn curves (curve_a, curve_b point lists, blended by morph, obeyed by depth): rising = forward, falling = backward, flat = hold. Put oxide after it.";
        this.curve_a = curveA;
        this.curve_b = curveB;
        this.play = play;
        this.rec = false;
        this.status = { length: 0, recording: false };
        const sendCurves = () => this.send({ type: "curves", a: this.curve_a, b: this.curve_b });
        this.options = {
            rec: {
                get: () => (this.rec ? "on" : "off"),
                set: (value) => {
                    this.rec = isOn(value);
                    this.send({ type: "rec", on: this.rec });
                },
                choices: ["on", "off"],
            },
            play: {
                get: () => (this.play ? "on" : "off"),
                set: (value) => {
                    this.play = isOn(value);
                    this.send({ type: "play", on: this.play });
                },
                choices: ["on", "off"],
            },
            // A gesture, not state (excluded from getOptions): any value
            // erases the loop.
            clear: {
                get: () => "-",
                set: () => {
                    this.rec = false;
                    this.send({ type: "clear" });
                },
            },
            curve_a: {
                get: () => this.curve_a.join(","),
                set: (value) => {
                    this.curve_a = parseCurve(value, "curve_a");
                    sendCurves();
                },
            },
            curve_b: {
                get: () => this.curve_b.join(","),
                set: (value) => {
                    this.curve_b = parseCurve(value, "curve_b");
                    sendCurves();
                },
            },
        };
        this.onWorkletMessage = (message) => {
            if (message.type === "status") this.status = message;
        };
    };

    // A loop's audio isn't session state — a take is a performance's output,
    // not its description (the recorder's rule too). So `rec` is saved off
    // and `clear` never.
    getOptions() {
        const { clear, rec, ...rest } = super.getOptions();
        return rest;
    };

    describeState() {
        const { length, recording, fresh } = this.status;
        if (recording) return `[${fresh ? "recording the first take" : "overdubbing"}${length ? ` · loop ${length.toFixed(2)}s` : ""}]`;
        return length ? `[loop ${length.toFixed(2)}s · ${this.play ? "playing" : "stopped"}]` : "[empty — rec=on to record]";
    };
};
