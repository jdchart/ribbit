// Capture of what the session is actually playing, as downloadable audio.
//
// One recorder per engine (Ribbit builds it in its constructor and hands it
// to /record — see commands.js). Two modes, differing only in *where the taps
// go*; everything downstream of the tap is identical:
//
//   stereo      one tap on master's post-fader output — "what you heard".
//   multitrack  one tap per track, per bus, and on master — the same signals
//               a mixdown is made of, ready to drop into a DAW.
//
// The tap is deliberately post-fader/post-pan/post-mute (a channel's `output`,
// the same node a send or a patch source reads), because that is the signal
// the channel is *contributing*. A muted track records silence, which is the
// honest answer: it contributed silence.
//
// Why an AudioWorklet rather than MediaRecorder. MediaRecorder is less code
// but hands back compressed webm/opus — lossy, stereo-only, and awkward to
// import. A live-coding take wants a WAV you can drop into a DAW, so the
// audio has to be captured as raw frames and encoded here. The worklet module
// is compiled from an inline blob URL rather than shipped as a separate file:
// this package is consumed as plain ESM through a bundler that would otherwise
// need its own rule for "asset that must stay a standalone URL at runtime",
// and there is exactly one processor to compile.
//
// Nothing here is session state. A take is the output of a performance, not
// part of its description, so the recorder is absent from snapshotSession/
// sessionToJSON — save a session and a take separately.

// How many frames each worklet buffers before posting them to the main
// thread. 128 (one render quantum) would be ~375 messages/second per tap;
// 4096 is ~12, still fine-grained enough that stopping loses nothing audible
// and the live duration readout doesn't visibly step.
const BLOCK_FRAMES = 4096;

// The two tap layouts. Exported so the console can complete `mode=` from the
// same list the setter validates against.
export const RECORDER_MODES = ["stereo", "multitrack"];

// WAV sample formats. 32 is IEEE float (WAVE_FORMAT_IEEE_FLOAT) — lossless,
// and unbothered by a master that runs past 0dBFS, which a live session
// regularly does. 16 is ordinary PCM, half the file size and playable by
// anything, at the cost of hard-clipping anything over full scale.
export const RECORDER_BIT_DEPTHS = [16, 32];

// Safety stop. A recording is a growing array of raw floats in memory with no
// natural end — a forgotten one eats the tab. Five minutes of stereo float32
// at 48k is ~115MB; the same five minutes of a six-channel multitrack is
// ~690MB, which is why describe() reports the projected size rather than
// leaving it to be discovered.
const DEFAULT_MAX_MINUTES = 5;

// The AudioWorkletProcessor, compiled from source at runtime (see the blob
// URL in _loadModule). It does no processing: it copies its input into a
// buffer and posts each full block to the main thread, transferring the
// ArrayBuffers rather than copying them.
//
// Two details that aren't obvious. It writes zeros when its input is
// disconnected (`inputs[0]` comes through empty), which is what keeps every
// tap in a multitrack frame-aligned when one channel's source goes away
// mid-take. And it keeps returning true — staying alive — until it is told to
// flush, because a processor that returns false is torn down immediately and
// would take its partial block with it.
const WORKLET_SOURCE = `
class RibbitRecorderProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._channels = options.processorOptions.channels;
        this._blockFrames = options.processorOptions.blockFrames;
        this._done = false;
        this._allocate();
        // The only message this ever receives: "stop, and give me whatever is
        // still in the buffer". The main thread has already disconnected the
        // input by the time this arrives, so the block is pure captured audio.
        this.port.onmessage = (event) => {
            if (event.data !== "flush") return;
            this._post();
            this._done = true;
            this.port.postMessage({ done: true });
        };
    }

    _allocate() {
        this._buffers = [];
        for (let c = 0; c < this._channels; c++) this._buffers.push(new Float32Array(this._blockFrames));
        this._filled = 0;
    }

    _post() {
        if (this._filled === 0) return;
        const channels = this._buffers.map((buffer) => buffer.slice(0, this._filled).buffer);
        this.port.postMessage({ channels, frames: this._filled }, channels);
        this._allocate();
    }

    process(inputs) {
        if (this._done) return false;

        const input = inputs[0] ?? [];
        const frames = input[0]?.length ?? 128;

        for (let i = 0; i < frames; i++) {
            for (let c = 0; c < this._channels; c++) {
                // A disconnected (or mono, against an explicit 2-channel
                // node) input leaves a channel missing rather than zeroed.
                this._buffers[c][this._filled] = input[c] ? input[c][i] : 0;
            }
            this._filled++;
            if (this._filled === this._blockFrames) this._post();
        }

        return true;
    }
}

registerProcessor("ribbit-recorder", RibbitRecorderProcessor);
`;

// ── WAV encoding ────────────────────────────────────────────────────────

function writeString(view, offset, text) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
};

// Interleaved WAV from one Float32Array per channel (all the same length),
// as raw bytes. `bits` picks between IEEE float and 16-bit PCM — see
// RECORDER_BIT_DEPTHS. Kept separate from encodeWAV below because a
// multitrack take needs the bytes to checksum and pack into a zip, while a
// stereo one only ever needs the Blob.
function wavBytes(channels, sampleRate, bits = 32) {
    const channelCount = channels.length;
    const frames = channels[0]?.length ?? 0;
    const bytesPerSample = bits === 16 ? 2 : 4;
    const blockAlign = channelCount * bytesPerSample;
    const dataBytes = frames * blockAlign;

    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);

    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);                        // fmt chunk size
    view.setUint16(20, bits === 16 ? 1 : 3, true);       // 1 = PCM, 3 = IEEE float
    view.setUint16(22, channelCount, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);   // byte rate
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bits, true);
    writeString(view, 36, "data");
    view.setUint32(40, dataBytes, true);

    let offset = 44;
    if (bits === 16) {
        for (let i = 0; i < frames; i++) {
            for (let c = 0; c < channelCount; c++) {
                // Clamped, not wrapped: an over-full-scale sample that wraps
                // is a loud click, while one that clips is the distortion the
                // user already chose by mixing that hot.
                const sample = Math.max(-1, Math.min(1, channels[c][i]));
                view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
                offset += 2;
            }
        }
    } else {
        for (let i = 0; i < frames; i++) {
            for (let c = 0; c < channelCount; c++) {
                view.setFloat32(offset, channels[c][i], true);
                offset += 4;
            }
        }
    }

    return buffer;
};

export function encodeWAV(channels, sampleRate, bits = 32) {
    return new Blob([wavBytes(channels, sampleRate, bits)], { type: "audio/wav" });
};

// ── ZIP (store, no compression) ─────────────────────────────────────────
// A multitrack take is N files, and N sequential downloads is a browser
// permission prompt and a mess of a Downloads folder. Store-only is the whole
// format worth having here: WAV of music barely compresses, and "store" is
// about sixty lines with no dependency.

let CRC_TABLE = null;

function crc32(bytes) {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[n] = c;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
};

// MS-DOS packed date/time, the only timestamp the ZIP local/central headers
// carry. Wrong by a couple of seconds (the format's resolution is two) and
// blind to timezones, which is why the real timestamp is in the filename.
function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
};

// `files` is [{ name, bytes: Uint8Array }].
function buildZip(files) {
    const { time, day } = dosDateTime(new Date());
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const crc = crc32(file.bytes);

        const header = new DataView(new ArrayBuffer(30));
        header.setUint32(0, 0x04034b50, true);          // local file header
        header.setUint16(4, 20, true);                  // version needed
        header.setUint16(6, 0, true);                   // flags
        header.setUint16(8, 0, true);                   // method 0 = store
        header.setUint16(10, time, true);
        header.setUint16(12, day, true);
        header.setUint32(14, crc, true);
        header.setUint32(18, file.bytes.length, true);  // compressed size
        header.setUint32(22, file.bytes.length, true);  // uncompressed size
        header.setUint16(26, nameBytes.length, true);
        header.setUint16(28, 0, true);                  // extra field length
        parts.push(header.buffer, nameBytes, file.bytes);

        const entry = new DataView(new ArrayBuffer(46));
        entry.setUint32(0, 0x02014b50, true);           // central directory entry
        entry.setUint16(4, 20, true);                   // version made by
        entry.setUint16(6, 20, true);                   // version needed
        entry.setUint16(8, 0, true);
        entry.setUint16(10, 0, true);
        entry.setUint16(12, time, true);
        entry.setUint16(14, day, true);
        entry.setUint32(16, crc, true);
        entry.setUint32(20, file.bytes.length, true);
        entry.setUint32(24, file.bytes.length, true);
        entry.setUint16(28, nameBytes.length, true);
        entry.setUint16(30, 0, true);                   // extra
        entry.setUint16(32, 0, true);                   // comment
        entry.setUint16(34, 0, true);                   // disk number
        entry.setUint16(36, 0, true);                   // internal attrs
        entry.setUint32(38, 0, true);                   // external attrs
        entry.setUint32(42, offset, true);              // local header offset
        central.push(entry.buffer, nameBytes);

        offset += 30 + nameBytes.length + file.bytes.length;
    }

    const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);                 // end of central directory
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
};

// ── Download ────────────────────────────────────────────────────────────

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    // Not revoked immediately, unlike commands.js's downloadJSON: a
    // multitrack zip is hundreds of megabytes and the browser is still
    // reading from the object URL when click() returns. A short delay is the
    // conventional answer; the URL dies with the page either way.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

// A filesystem-safe stamp for a filename — the local wall clock, in an order
// that sorts, e.g. "2026-08-07_14-32-05".
function timestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        + `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
};

function formatBytes(bytes) {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)}GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)}MB`;
    return `${Math.round(bytes / 1e3)}kB`;
};

// ── The recorder ────────────────────────────────────────────────────────

export class RibbitRecorder {
    constructor(engine) {
        this.llm_summary = "Records the session's output to downloadable WAV — master in stereo, or every track/bus/master as separate files.";

        this.engine = engine;
        this.audioContext = engine.audioContext;

        this.mode = "stereo";
        this.bits = 32;
        this.maxMinutes = DEFAULT_MAX_MINUTES;

        this.recording = false;

        // The current take: null until the first recording starts, then held
        // (through stop, and across mode changes) until cleared or replaced
        // by the next /record. Shape:
        //   { mode, sampleRate, startedAt, taps: [{ name, blocks, frames }] }
        // where `blocks` is an array of per-channel Float32Array groups, kept
        // unconcatenated so that capture is pure appends and the (single,
        // large) concatenation happens once, at save time.
        this.take = null;

        // Resolved once per AudioContext — compiling the worklet module is
        // the only asynchronous step in the whole recorder, which is why
        // prepare() exists separately from start(). The flag tracks whether
        // it has actually *finished*, which is the thing start() needs to
        // know: the promise exists from the moment prepare() is called, and
        // constructing an AudioWorkletNode before its processor is registered
        // throws.
        this._modulePromise = null;
        this._moduleReady = false;

        // Every worklet node needs a live path to the destination or the
        // graph never pulls it and process() is never called. One shared
        // silent gain is that path; the worklet writes nothing to its output,
        // so the gain is belt-and-braces rather than load-bearing.
        this._sink = null;

        this._pendingFlushTimers = new Set();
    };

    get ready() {
        return this._moduleReady;
    };

    // Seconds captured so far (live), or the length of the finished take.
    // Read off the *frame count* rather than the wall clock, so a recording
    // made across a /stop reports the audio it actually contains — a
    // suspended AudioContext renders nothing, and a take that claims fifty
    // seconds but holds ten is worse than useless when lining takes up.
    get durationSeconds() {
        if (!this.take) return 0;
        return this.take.taps[0] ? this.take.taps[0].frames / this.take.sampleRate : 0;
    };

    get hasTake() {
        return this.take !== null && this.durationSeconds > 0;
    };

    // Bytes the take currently occupies in memory (float32, 2 channels per
    // tap) — what describe() reports and what the cap is really about.
    get memoryBytes() {
        if (!this.take) return 0;
        return this.take.taps.reduce((sum, tap) => sum + tap.frames * 2 * 4, 0);
    };

    setMode(mode) {
        if (!RECORDER_MODES.includes(mode)) {
            throw new Error(`unknown recording mode "${mode}" (expected ${RECORDER_MODES.join(" or ")})`);
        }
        // Switching layouts mid-take would mean a take whose second half has
        // a different set of files in it, so this is refused rather than
        // silently applied to the next recording.
        if (this.recording) throw new Error(`can't change mode while recording — /stop_record first`);
        this.mode = mode;
        return this.mode;
    };

    setBits(bits) {
        const value = Number(bits);
        if (!RECORDER_BIT_DEPTHS.includes(value)) {
            throw new Error(`unknown bit depth "${bits}" (expected ${RECORDER_BIT_DEPTHS.join(" or ")})`);
        }
        // Unlike mode, this is safe to change at any time: capture is always
        // float32 in memory and the depth is only applied when encoding.
        this.bits = value;
        return this.bits;
    };

    setMaxMinutes(minutes) {
        const value = Number(minutes);
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error(`invalid max_minutes "${minutes}" (expected a positive number)`);
        }
        this.maxMinutes = value;
        return this.maxMinutes;
    };

    // Compiles the worklet module. Idempotent, and deliberately separate from
    // start(): this is the one asynchronous step, and a `/record
    // at=cycle` has to be fully synchronous by the time the boundary arrives
    // — a rejection inside a deferred timer has no command left to report to.
    // So the console awaits this first, then schedules a synchronous start().
    prepare() {
        if (!this._modulePromise) {
            if (!this.audioContext.audioWorklet) {
                return Promise.reject(new Error("this browser has no AudioWorklet — recording is unavailable"));
            }
            const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
            this._modulePromise = this.audioContext.audioWorklet.addModule(url)
                .then(() => { this._moduleReady = true; })
                .finally(() => URL.revokeObjectURL(url))
                .catch((error) => {
                    // Cleared so a later attempt can retry rather than
                    // resolving forever against a module that never compiled.
                    this._modulePromise = null;
                    throw error;
                });
        }
        return this._modulePromise;
    };

    // The channels this mode taps, in the order they'll appear as files.
    // Resolved at start(), so a take covers the session as it stood when
    // recording began — a track added halfway through isn't in it.
    _tapTargets() {
        if (this.mode === "stereo") return [{ name: "master", channel: this.engine.master }];
        return [
            ...this.engine.tracks.map((track) => ({ name: track.name, channel: track })),
            ...this.engine.buses.map((bus) => ({ name: bus.name, channel: bus })),
            { name: "master", channel: this.engine.master },
        ];
    };

    // Begins capture. Synchronous — prepare() must have resolved first (see
    // there). Replaces any previous take.
    start() {
        if (this.recording) throw new Error("already recording");
        if (!this.ready) throw new Error("recorder not prepared — call prepare() first");

        const targets = this._tapTargets();
        if (targets.length === 0) throw new Error("nothing to record");

        if (!this._sink) {
            this._sink = this.audioContext.createGain();
            this._sink.gain.value = 0;
            this._sink.connect(this.audioContext.destination);
        }

        this.take = {
            mode: this.mode,
            sampleRate: this.audioContext.sampleRate,
            startedAt: new Date(),
            taps: [],
        };

        // Every node is created and connected inside this one synchronous
        // block, so all of them join the graph on the same render quantum and
        // a multitrack take is sample-aligned across its files with no
        // per-tap offset to correct for.
        for (const target of targets) {
            const node = new AudioWorkletNode(this.audioContext, "ribbit-recorder", {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                // Explicit, so a mono source is up-mixed to the stereo pair
                // every tap writes rather than quietly recording one channel.
                channelCount: 2,
                channelCountMode: "explicit",
                channelInterpretation: "speakers",
                processorOptions: { channels: 2, blockFrames: BLOCK_FRAMES },
            });

            const tap = { name: target.name, source: target.channel.output, node, blocks: [], frames: 0 };
            node.port.onmessage = (event) => this._receive(tap, event.data);

            target.channel.output.connect(node);
            node.connect(this._sink);

            this.take.taps.push(tap);
        }

        this.recording = true;
        return this.take;
    };

    _receive(tap, message) {
        if (message.done) {
            this._finishTap(tap);
            return;
        }
        if (!message.channels) return;

        tap.blocks.push(message.channels.map((buffer) => new Float32Array(buffer)));
        tap.frames += message.frames;

        // Checked against the first tap only — every tap advances together,
        // and this runs once per block per tap on the audio-adjacent path.
        if (tap === this.take?.taps[0] && this.recording && tap.frames >= this.maxMinutes * 60 * this.take.sampleRate) {
            this.stop();
            this.engine.notify(`recording stopped at the ${this.maxMinutes}-minute limit (/record max_minutes= to raise it)`);
        }
    };

    // Ends capture. Synchronous in every way that matters — `recording` is
    // false and the taps are off the graph the moment this returns — but each
    // worklet still holds up to one partial block, which it posts back over
    // the next render quantum or two. Those late blocks append to the same
    // arrays this take is already built from, so nothing has to be awaited;
    // only a save() called within a few milliseconds of stop() would miss
    // them, and stop-then-save is a human gesture apart.
    stop() {
        if (!this.recording) return false;
        this.recording = false;

        for (const tap of this.take.taps) {
            // Input first, so the flush that follows can only contain audio
            // captured before this call.
            try { tap.source.disconnect(tap.node); } catch { /* already gone with its channel */ }
            tap.node.port.postMessage("flush");
            // The worklet answers on its next process() call — which never
            // comes if the AudioContext is suspended, or if the graph tore
            // the node out from under us. Without this the node would stay
            // connected to the sink forever.
            const timer = setTimeout(() => this._finishTap(tap), 500);
            this._pendingFlushTimers.add(timer);
            tap._flushTimer = timer;
        }

        return true;
    };

    _finishTap(tap) {
        if (tap._flushTimer) {
            clearTimeout(tap._flushTimer);
            this._pendingFlushTimers.delete(tap._flushTimer);
            tap._flushTimer = null;
        }
        if (tap._finished) return;
        tap._finished = true;
        tap.node.port.onmessage = null;
        try { tap.node.disconnect(); } catch { /* context already closed */ }
    };

    clear() {
        if (this.recording) this.stop();
        this.take = null;
        return true;
    };

    // One Float32Array per channel for a tap, from its accumulated blocks.
    // `frames` is passed in so every file in a multitrack take is trimmed to
    // the same length — the taps only ever differ by a final partial block
    // that arrived (or didn't) after stop().
    _flatten(tap, frames) {
        const channels = [new Float32Array(frames), new Float32Array(frames)];
        let offset = 0;
        for (const block of tap.blocks) {
            const length = Math.min(block[0].length, frames - offset);
            if (length <= 0) break;
            for (let c = 0; c < channels.length; c++) {
                channels[c].set(length === block[c].length ? block[c] : block[c].subarray(0, length), offset);
            }
            offset += length;
        }
        return channels;
    };

    // Encodes and downloads the take: one .wav in stereo mode, a .zip of one
    // .wav per channel in multitrack. Returns the message the console prints.
    save() {
        if (!this.hasTake) return "nothing recorded";

        const { sampleRate, taps } = this.take;
        // Every file trimmed to the shortest tap. They differ by at most one
        // partial block (a flush that landed, against one that timed out), so
        // this costs milliseconds and buys guaranteed alignment.
        const frames = Math.min(...taps.map((tap) => tap.frames));
        const name = `ribbit-${timestamp()}`;
        const seconds = (frames / sampleRate).toFixed(1);

        if (taps.length === 1) {
            const blob = encodeWAV(this._flatten(taps[0], frames), sampleRate, this.bits);
            downloadBlob(blob, `${name}.wav`);
            return `saved ${name}.wav (${seconds}s, ${formatBytes(blob.size)})`;
        }

        // Numbered so the files sort into mixer order (tracks, buses,
        // master) rather than alphabetically by whatever the user named them.
        const files = taps.map((tap, index) => ({
            name: `${String(index + 1).padStart(2, "0")}-${tap.name}.wav`,
            bytes: new Uint8Array(wavBytes(this._flatten(tap, frames), sampleRate, this.bits)),
        }));
        const zip = buildZip(files);
        downloadBlob(zip, `${name}.zip`);
        return `saved ${name}.zip — ${files.length} files, ${seconds}s (${formatBytes(zip.size)})`;
    };

    // Teardown for a disposed engine: stop capturing, drop the audio, and
    // cancel the flush fallbacks so none of them wakes up against a closed
    // AudioContext. The take itself is dropped too — the engine is going away
    // and holding hundreds of megabytes past it helps nobody.
    dispose() {
        if (this.recording) this.stop();
        for (const tap of this.take?.taps ?? []) this._finishTap(tap);
        for (const timer of this._pendingFlushTimers) clearTimeout(timer);
        this._pendingFlushTimers.clear();
        this._sink?.disconnect();
        this._sink = null;
        this.take = null;
    };

    // One line of status, for /record with no arguments and for the mixer's
    // own readout. Reports projected memory alongside duration because that,
    // not time, is what the cap is really protecting.
    describe() {
        const parts = [`mode=${this.mode}`, `bits=${this.bits}`, `max_minutes=${this.maxMinutes}`];

        if (this.recording) {
            const channels = this.take.taps.length;
            parts.unshift(`recording ${this.durationSeconds.toFixed(1)}s across ${channels} channel${channels === 1 ? "" : "s"} (${formatBytes(this.memoryBytes)})`);
            if (!this.engine.running) parts.push("engine is stopped — nothing is being captured");
        } else if (this.hasTake) {
            const channels = this.take.taps.length;
            parts.unshift(`take: ${this.durationSeconds.toFixed(1)}s, ${channels} channel${channels === 1 ? "" : "s"} (${formatBytes(this.memoryBytes)}) — /save_record`);
        } else {
            parts.unshift("idle");
        }

        return parts.join(" ");
    };
};
