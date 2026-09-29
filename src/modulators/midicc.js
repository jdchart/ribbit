import { RibbitModulator } from "../modulator.js";
import { RibbitParamSources } from "../param.js";
import { MidiListener } from "./midiin.js";

// One MIDI control — a knob, fader or pedal (control change `cc`) — as a
// continuous signal, 0..1, for patching into any param. One per control, so
// each gets its own cable and depth:
//
//     /add_modulator type=midicc name=knob1 cc=74
//     /patch source=knob1 dest=pad.cutoff depth=2000
//
// `cc=pitchbend` follows the pitch wheel instead (centre 0.5). It also fires
// whenever the control crosses the middle going up — a pedal or a button as
// a trigger= / strike= source.
export class RibbitMidiCC extends RibbitModulator {
    constructor(audioContext, { name = "midicc", device = "any", channel = 0, cc = 1, smooth = 0.02 } = {}) {
        super(audioContext, { name });
        this.llm_summary = "One MIDI control (a knob, fader or pedal: control change cc=0-127, or cc=pitchbend) as a continuous 0..1 signal for param patches; smooth seconds de-zippers it. Fires when the control crosses the middle upwards, so a pedal or button works as a trigger=/strike= source.";
        this.cc = parseCC(cc);
        this.value = 0;

        this.source = audioContext.createConstantSource();
        this.source.offset.value = 0;
        this.source.connect(this.output);
        this.source.start();

        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            smooth: this._paramSources.create(Number(smooth) || 0.02, { min: 0.001, max: 2 }),
        };

        this.midi = new MidiListener((kind, data1, data2) => {
            if (this.cc === "pitchbend") {
                if (kind === 0xe0) this.set(((data2 << 7) | data1) / 16383);
            } else if (kind === 0xb0 && data1 === this.cc) {
                this.set(data2 / 127);
            }
        });
        this.midi.device = String(device || "any");
        this.midi.channel = Number(channel) || 0;
        this.options = {
            ...this.midi.options(),
            cc: { get: () => this.cc, set: (value) => { this.cc = parseCC(value); } },
        };
        this.midi.open();
    };

    // Public so a host or a test can move it without a device.
    set(value) {
        const now = this.audioContext.currentTime;
        if (this.value < 0.5 && value >= 0.5) {
            this.lastEventTime = now;
            this.lastVelocity = 1;
        }
        this.value = value;
        this.source.offset.setTargetAtTime(value, now, this.params.smooth.get() / 3);
    };

    describeState() {
        return `[${this.midi.status}, value ${this.value.toFixed(2)}]`;
    };

    dispose() {
        this.midi.dispose();
        this.source.stop();
        this.source.disconnect();
        this._paramSources.dispose();
    };
};

function parseCC(value) {
    if (String(value).trim().toLowerCase() === "pitchbend") return "pitchbend";
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 127) throw new Error(`invalid cc "${value}" — 0-127, or pitchbend`);
    return n;
};
