import { RibbitParam } from "./param.js";
import { positionToGain, gainToPosition } from "./taper.js";

// The audio interface: which output device the session plays through, how
// many channels it has, and which of them each signal lands on.
//
// Web Audio gives a page one output, `audioContext.destination`, normally
// stereo. Two things open that up. `AudioContext.setSinkId` (Chrome 110+)
// picks the device — a Scarlett rather than the built-in speakers. And a
// destination can be opened to its full `maxChannelCount` with "discrete"
// channel interpretation, at which point channel N of whatever feeds it is
// hardware output N, untouched. So every output here feeds one
// ChannelMergerNode, into the merger input for the hardware channel it
// names; the merger is the destination's only input.
//
// The merger is built at the Web Audio maximum (32) once rather than sized
// to the device, so switching devices never rewires anything: discrete
// down-mixing drops the merger's channels past the device's count. An output
// aimed past them is silent, and says so (see RibbitOutput.describe).
export const MAX_HARDWARE_CHANNELS = 32;

// "3,4" / "3-4" / "3" / [3, 4] -> [3, 4] or [3]: 1-based hardware channels,
// a stereo pair or one mono channel.
export function parseHardwareChannels(value) {
    const list = Array.isArray(value) ? value : String(value ?? "").trim().split(/[\s,\-]+/).filter(Boolean);
    const channels = list.map(Number);
    const valid = channels.length >= 1 && channels.length <= 2
        && channels.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_HARDWARE_CHANNELS);
    if (!valid) throw new Error(`invalid channels "${value}" — expected a pair like 3,4 or one channel like 3 (1..${MAX_HARDWARE_CHANNELS})`);
    return channels;
};

export function formatHardwareChannels(channels) {
    return channels.join(",");
};

// A device matched by id or by a case-insensitive fragment of its label
// ("scarlett"), among `kind` ("audiooutput" / "audioinput"). Labels are only
// populated once the page holds microphone permission (a browser privacy
// rule), so a label query asks for it once first — the same prompt audio
// input needs anyway. "default" (or empty) is the system default.
export async function findMediaDevice(kind, query) {
    const wanted = String(query ?? "").trim();
    if (!wanted || wanted === "default") return { deviceId: "default", label: "default" };
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error("this browser can't list audio devices");

    let devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind);
    if (devices.length && devices.every((d) => !d.label)) {
        await unlockDeviceLabels();
        devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind);
    }
    const lower = wanted.toLowerCase();
    const match = devices.find((d) => d.deviceId === wanted) ?? devices.find((d) => d.label.toLowerCase().includes(lower));
    if (!match) {
        const names = devices.map((d) => d.label || d.deviceId).join(", ") || "none";
        throw new Error(`no ${kind === "audioinput" ? "input" : "output"} device matching "${wanted}" (have: ${names})`);
    }
    return { deviceId: match.deviceId, label: match.label || match.deviceId };
};

export async function unlockDeviceLabels() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
    } catch {
        // Denied: devices stay listed without labels, matched by id only.
    }
};

export class RibbitHardware {
    constructor(audioContext) {
        this.audioContext = audioContext;
        this.merger = audioContext.createChannelMerger(MAX_HARDWARE_CHANNELS);
        this.merger.connect(audioContext.destination);
        // What the user asked for (kept for the session file, so a session
        // saved on the Scarlett asks for it again) and what it resolved to.
        this.device = "default";
        this.deviceLabel = "default";
        this._openAllChannels();
    };

    get channelCount() {
        return this.audioContext.destination.channelCount;
    };

    get supportsDeviceChoice() {
        return typeof this.audioContext.setSinkId === "function";
    };

    // Opens the destination to every channel the current device has, with no
    // up/down-mixing, so merger channel N is hardware output N. On a stereo
    // device this is exactly the old behaviour.
    _openAllChannels() {
        const destination = this.audioContext.destination;
        const count = Math.max(1, Math.min(destination.maxChannelCount || 2, MAX_HARDWARE_CHANNELS));
        destination.channelCount = count;
        destination.channelCountMode = "explicit";
        destination.channelInterpretation = "discrete";
    };

    // Moves the whole session to another output device. Async (the browser
    // opens the device), and the channel count is re-read afterwards: that's
    // when maxChannelCount reflects the new device.
    async setDevice(query) {
        if (!this.supportsDeviceChoice) throw new Error("this browser can't choose an output device (needs AudioContext.setSinkId — Chrome 110+)");
        const { deviceId, label } = await findMediaDevice("audiooutput", query);
        await this.audioContext.setSinkId(deviceId === "default" ? "" : deviceId);
        this.device = String(query ?? "default").trim() || "default";
        this.deviceLabel = label;
        this._openAllChannels();
        return `output device: ${label} (${this.channelCount} channels)`;
    };

    describe() {
        return `output device ${this.deviceLabel} — ${this.channelCount} channel${this.channelCount === 1 ? "" : "s"}`;
    };
};

// One place a signal leaves the session: a stereo pair or a single channel
// of the audio interface. Master always has one (`hardware.main`, the
// "speakers", 1-2 by default); `/add_output` makes more, which tracks and
// buses reach the ordinary way — `out=phones`, `add_send=phones` — since
// this has an `.input` like any channel. It deliberately isn't a channel:
// no inserts, no sends, no solo. Anything that needs processing on its way
// out goes through a bus first.
export class RibbitOutput {
    constructor(hardware, { name = "output", channels = [1, 2], gain = 1 } = {}) {
        this.llm_summary = "A hardware output: sends what reaches it to one stereo pair (or one mono channel) of the audio interface.";
        this.name = name;
        this.hardware = hardware;
        const audioContext = hardware.audioContext;
        this.audioContext = audioContext;

        // Forced to stereo with "speakers" mixing, so a mono source lands on
        // both sides of a pair; a mono output sums L+R back down at the
        // merger input (which is always one channel).
        this.input = audioContext.createGain();
        this.input.channelCount = 2;
        this.input.channelCountMode = "explicit";
        this.input.channelInterpretation = "speakers";
        this.splitter = audioContext.createChannelSplitter(2);
        this.input.connect(this.splitter);

        this.channels = parseHardwareChannels(channels);
        this._wire();

        this.params = {
            gain: new RibbitParam(this.input.gain, { decode: gainToPosition, encode: positionToGain, min: 0, max: 1, randomizable: false }),
        };
        this.params.gain.set(gain);
        this.options = {
            channels: {
                get: () => formatHardwareChannels(this.channels),
                set: (value) => {
                    this.channels = parseHardwareChannels(value);
                    this._wire();
                },
            },
        };
        this.automation = [];
    };

    addAutomation(event) {
        this.automation.push(event);
        return event;
    };

    getOptions() {
        return { channels: formatHardwareChannels(this.channels) };
    };

    _wire() {
        this.splitter.disconnect();
        this.input.disconnect();
        this.input.connect(this.splitter);
        const [left, right] = this.channels.map((n) => n - 1);
        if (right === undefined) {
            this.input.connect(this.hardware.merger, 0, left);
        } else {
            this.splitter.connect(this.hardware.merger, 0, left);
            this.splitter.connect(this.hardware.merger, 1, right);
        }
    };

    // True when the device doesn't have the channel(s) this names.
    get silent() {
        return Math.max(...this.channels) > this.hardware.channelCount;
    };

    describeState() {
        const where = this.channels.length === 2 ? `outs ${this.channels.join("-")}` : `out ${this.channels[0]} (mono)`;
        return `-> ${where} on ${this.hardware.deviceLabel}${this.silent ? ` — SILENT: device has ${this.hardware.channelCount} channels` : ""}`;
    };

    dispose() {
        this.input.disconnect();
        this.splitter.disconnect();
    };
};
