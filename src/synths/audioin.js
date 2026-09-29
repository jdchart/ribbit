import { RibbitSynth } from "../synth.js";
import { RibbitParam } from "../param.js";
import { findMediaDevice, parseHardwareChannels, formatHardwareChannels } from "../hardware.js";
import { toggleOption } from "../dsp/spec.js";

// Live audio input as a track's source: a microphone, or any input of an
// interface (a Scarlett's inputs 3-4). It's a synth only in the sense that it
// is what a track plays — it ignores notes — and that's the point: as a
// track it gets a fader, inserts, sends and solo, reaches any bus or output,
// and (like any channel) can be a patch source or a `loudness` source.
//
//     /add_track synth=audioin name=mic                   default input, ch 1
//     /mic device=scarlett channels=1,2                   a stereo pair
//     /mic monitor=off                                    analyse without hearing it
//
// The stream is opened asynchronously (the browser asks for permission the
// first time); until it arrives the track is silent. Echo cancellation,
// noise suppression and auto gain are all off — they're for calls, and they
// wreck music. `monitor=off` mutes the track's own signal but keeps it
// flowing to anything tapping `output` (see loudness), so a mic can drive
// analysis without feeding back through the speakers.
export class RibbitAudioIn extends RibbitSynth {
    constructor(audioContext, { name = "audioin", device = "default", channels = "1", trim = 1, monitor = "on" } = {}) {
        super(audioContext, { name });
        this.llm_summary = "Live audio input (microphone or interface inputs) as a track's source: device=<name fragment>, channels=1 (mono) or 1,2 (a pair); ignores notes. Put effects on the track, or tap it with a loudness modulator.";

        this.device = String(device || "default");
        this.deviceLabel = "(opening)";
        this.channels = parseHardwareChannels(channels);
        this.monitor = String(monitor) !== "off" && String(monitor) !== "false";
        this.status = "opening";

        // trim -> [channel picking] -> this.tap -> monitorGain -> output.
        // `tap` is the pre-monitor signal an analyser reads (see loudness's
        // tapOf), so muting the monitor doesn't blind it.
        this.trimGain = audioContext.createGain();
        this.trimGain.gain.value = trim;
        this.tap = audioContext.createChannelMerger(2);
        this.monitorGain = audioContext.createGain();
        this.monitorGain.gain.value = this.monitor ? 1 : 0;
        this.tap.connect(this.monitorGain);
        this.monitorGain.connect(this.output);

        this.params = {
            trim: new RibbitParam(this.trimGain.gain, { min: 0, max: 8 }),
        };
        this.options = {
            device: {
                get: () => this.device,
                set: (value) => {
                    this.device = String(value || "default");
                    this._open();
                },
            },
            channels: {
                get: () => formatHardwareChannels(this.channels),
                set: (value) => {
                    this.channels = parseHardwareChannels(value);
                    this._open();
                },
            },
            monitor: toggleOption(this, "monitor", (on) => {
                this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, audioContext.currentTime, 0.01);
            }),
        };

        this._stream = null;
        this._source = null;
        this._splitter = null;
        this._generation = 0;
        this._open();
    };

    // The signal before the monitor switch — what an analyser should hear.
    get analysisOutput() {
        return this.tap;
    };

    async _open() {
        const generation = ++this._generation;
        this.status = "opening";
        if (!navigator.mediaDevices?.getUserMedia) {
            this.status = "unavailable: this browser has no audio input (needs a secure context — localhost or https)";
            return;
        }
        try {
            const { deviceId, label } = await findMediaDevice("audioinput", this.device);
            const need = Math.max(...this.channels);
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    ...(deviceId === "default" ? {} : { deviceId: { exact: deviceId } }),
                    channelCount: { ideal: Math.max(need, 2) },
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
            });
            if (generation !== this._generation || this._disposed) {
                for (const track of stream.getTracks()) track.stop();
                return;
            }
            this._close();
            this._stream = stream;
            this.deviceLabel = label;
            const source = this.audioContext.createMediaStreamSource(stream);
            const available = stream.getAudioTracks()[0]?.getSettings?.().channelCount ?? source.channelCount ?? 2;
            // A splitter sized to what the browser actually delivered: some
            // capture only the first two channels of a larger interface.
            const splitter = this.audioContext.createChannelSplitter(Math.max(available, 1));
            source.channelCountMode = "max";
            source.connect(this.trimGain);
            this.trimGain.channelCountMode = "max";
            this.trimGain.channelInterpretation = "discrete";
            this.trimGain.connect(splitter);
            const [left, right = left] = this.channels.map((n) => n - 1);
            const missing = this.channels.filter((n) => n > available);
            if (!missing.length) {
                splitter.connect(this.tap, left, 0);
                splitter.connect(this.tap, right, 1);
            }
            this._source = source;
            this._splitter = splitter;
            this.status = missing.length
                ? `silent: the browser opened ${available} input channel${available === 1 ? "" : "s"} on ${label}, not ${missing.join(",")}`
                : `live: ${label} ch ${formatHardwareChannels(this.channels)}`;
        } catch (error) {
            if (generation === this._generation) this.status = `unavailable: ${error.message}`;
        }
    };

    _close() {
        this._source?.disconnect();
        this._splitter?.disconnect();
        try { this.trimGain.disconnect(); } catch {}
        for (const track of this._stream?.getTracks() ?? []) track.stop();
        this._stream = null;
        this._source = null;
        this._splitter = null;
    };

    // Notes mean nothing to a live input; declining them keeps a stray
    // pattern or generator from lighting this track up.
    trigger() {
        return false;
    };

    describeState() {
        return `[${this.status}${this.monitor ? "" : ", monitor off"}]`;
    };

    // Releases the device — without this the browser's recording indicator
    // stays on after the track is gone.
    dispose() {
        this._disposed = true;
        this._generation++;
        this._close();
        this.tap.disconnect();
        this.monitorGain.disconnect();
    };
};
