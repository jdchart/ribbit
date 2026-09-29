import { RibbitModulator } from "../modulator.js";
import { RibbitParamSources } from "../param.js";
import { mulberry32 } from "../random.js";

const KINDS = ["sends", "pan"];
const MODES = ["smooth", "jump"];

// Slow, independent drift across many channels at once — the AE machine's
// FX mod banks (chapter 43) and its pan drift (`aem_panbank`, chapter 44), as
// one type with two `kind`s.
//
//   kind=sends  every target channel's send into `bus` drifts on its own
//               between silent and `depth`, so voices enter and leave an
//               effect without anyone touching a dial (one bank per effect
//               bus is the original's layout).
//   kind=pan    every target channel's pan wanders — but not like an
//               auto-pan: it picks a point near one edge, travels there over
//               a random 0.1..1.5s, waits, and heads for the other edge.
//               Never parked in the centre, never a period you can hear.
//
// `mode=smooth` sweeps (sends); `mode=jump` makes discrete jumps with chance
// `jump` (%) per sixteenth. `rate` speeds it all up. Each channel has its own
// fixed seed (its position in `targets`), so the drift is different per
// channel but **repeatable across sessions**. `targets` defaults to every
// track.
export class RibbitDriftBank extends RibbitModulator {
    constructor(audioContext, {
        name = "driftbank",
        engine = null,
        kind = "sends",
        bus = "",
        targets = "",
        mode = "smooth",
        seed = 1,
        rate = 1,
        jump = 20,
        depth = 1,
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "Drifts many channels independently — the AE machine's FX mod banks and pan drift. kind=sends: each target's send into bus wanders between silent and depth, so voices enter and leave an effect on their own; kind=pan: each pan travels edge to edge on random timings, never centred. mode smooth|jump (jump% per step), rate. Seeded per channel, so repeatable.";
        this.engine = engine;
        this.kind = KINDS.includes(kind) ? kind : "sends";
        this.bus = String(bus).trim();
        this.targetNames = String(targets).split(",").map((t) => t.trim()).filter(Boolean);
        this.mode = MODES.includes(mode) ? mode : "smooth";
        this.seed = Math.floor(Number(seed)) || 1;
        this.lanes = new Map();
        this._next = null;

        this.options = {
            kind: {
                get: () => this.kind,
                set: (value) => {
                    if (!KINDS.includes(value)) throw new Error(`invalid kind "${value}" — expected sends or pan`);
                    this.kind = value;
                    this.lanes.clear();
                },
                choices: KINDS,
            },
            bus: {
                get: () => this.bus,
                set: (value) => { this.bus = String(value).trim(); },
            },
            targets: {
                get: () => this.targetNames.join(","),
                set: (value) => {
                    this.targetNames = String(value).split(",").map((t) => t.trim()).filter(Boolean);
                    this.lanes.clear();
                },
            },
            mode: {
                get: () => this.mode,
                set: (value) => {
                    if (!MODES.includes(value)) throw new Error(`invalid mode "${value}" — expected smooth or jump`);
                    this.mode = value;
                },
                choices: MODES,
            },
            seed: {
                get: () => this.seed,
                set: (value) => {
                    this.seed = Math.floor(Number(value)) || 1;
                    this.lanes.clear();
                },
            },
        };

        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            rate: this._paramSources.create(rate, { min: 0.05, max: 4 }),
            jump: this._paramSources.create(jump, { min: 0, max: 100 }),
            depth: this._paramSources.create(depth, { min: 0, max: 1 }),
        };
    };

    dispose() {
        this._paramSources.dispose();
    };

    onClockStart() {
        this._next = null;
        this.lanes.clear();
    };

    // The RibbitParams this bank moves, keyed by channel name.
    _targets() {
        const engine = this.engine;
        if (!engine) return [];
        const channels = this.targetNames.length
            ? this.targetNames.map((name) => engine._resolveObject(name)).filter((c) => c && c.params?.pan)
            : engine.tracks;
        const out = [];
        channels.forEach((channel, index) => {
            if (this.kind === "pan") out.push({ key: channel.name, index, param: channel.params.pan });
            else {
                const send = channel.sends?.find((s) => s.destName === this.bus);
                if (send) out.push({ key: channel.name, index, param: send.params.gain });
            }
        });
        return out;
    };

    onSchedule(fromBeat, toBeat, secondsPerBeat, clock) {
        const rate = this.params.rate.get();
        const depth = this.params.depth.get();
        const now = this.audioContext.currentTime;
        const horizon = clock.beatToTime(toBeat);
        for (const { key, index, param } of this._targets()) {
            let lane = this.lanes.get(key);
            if (!lane) {
                lane = { random: mulberry32(this.seed * 7919 + index * 104729), nextTime: now, side: index % 2 ? 1 : -1 };
                this.lanes.set(key, lane);
            }
            if (this.kind === "pan") {
                // Edge to edge: travel, wait, turn round.
                while (lane.nextTime < horizon) {
                    const start = Math.max(lane.nextTime, now);
                    lane.side = -lane.side;
                    const target = lane.side * (0.6 + 0.4 * lane.random()) * depth;
                    const travel = (0.1 + 1.4 * lane.random()) / rate;
                    const wait = (0.2 + 1.8 * lane.random()) / rate;
                    this._ramp(lane, param, target, start, travel);
                    lane.nextTime = start + travel + wait;
                }
            } else if (this.mode === "smooth") {
                while (lane.nextTime < horizon) {
                    const start = Math.max(lane.nextTime, now);
                    const target = lane.random() * depth;
                    const travel = (2 + 6 * lane.random()) / rate;
                    this._ramp(lane, param, target, start, travel);
                    lane.nextTime = start + travel;
                }
            } else {
                // Jumps, rolled per sixteenth.
                if (lane.nextBeat === undefined || lane.nextBeat < fromBeat) lane.nextBeat = Math.ceil(fromBeat * 4) / 4;
                while (lane.nextBeat < toBeat) {
                    if (lane.random() * 100 < this.params.jump.get() * rate) this._ramp(lane, param, lane.random() * depth, clock.beatToTime(lane.nextBeat), 0.01);
                    lane.nextBeat += 0.25;
                }
            }
        }
    };

    // Ramps are laid out ahead of time, so each starts from where the
    // lane's previous one ends — not from the param's value *now*.
    _ramp(lane, param, value, start, seconds) {
        const audioParam = param.audioParam;
        const target = param.encode(param.clamp(value));
        const from = lane.last ?? audioParam.value;
        audioParam.cancelScheduledValues(start);
        audioParam.setValueAtTime(from, start);
        audioParam.linearRampToValueAtTime(target, start + Math.max(0.005, seconds));
        lane.last = target;
    };

    describeState() {
        const count = this._targets().length;
        return `[${this.kind === "pan" ? "pan drift" : `sends into ${this.bus || "(no bus)"}`} · ${count} channel${count === 1 ? "" : "s"} · ${this.mode}]`;
    };
};
