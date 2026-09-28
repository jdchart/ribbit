import { RibbitSynth } from "../synth.js";
import { sampleName, sampleUrl } from "../samples.js";

const SAMPLE_FILES = [
    "CLAUDE - kick02.wav",
    "CLAUDE - kick03.wav",
    "CLAUDE - distorted snare06.wav",
    "CLAUDE - distorted snare07.wav",
    "CLAUDE - hat13.wav",
    "CLAUDE - hat14.wav",
];

// A drum-machine-style synth: a fixed set of loaded sample buffers ("slots"),
// where an event's pitch selects which one to play. Starts with an empty
// pattern — see commands.js's add_event/clear_events for authoring events
// onto it (pitch selects a slot index, not a MIDI note).
export class RibbitSampler extends RibbitSynth {
    constructor(audioContext, { name = "sampler", samples = SAMPLE_FILES } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A sample player: each event's pitch selects one of a fixed set of loaded sample slots to trigger (0 = first slot, wrapping if out of range).";

        this._setSamples(samples);

        // Runtime-settable — /drums samples=kick02.wav,hat13.wav swaps the
        // slot list live (slots empty-then-fill as each file loads, same
        // fire-and-forget rule as construction). Kept as the original
        // filename list (slots only store derived display names/URLs) so
        // the base getOptions() round-trips it for sessions.
        this.options = {
            samples: {
                get: () => this.samples,
                set: (value) => {
                    const list = Array.isArray(value) ? value : String(value).split(",").map((s) => s.trim());
                    if (list.length === 0 || list.some((s) => !s)) {
                        throw new Error(`invalid samples "${value}" — expected a comma-separated list of filenames served under the host's "/samples/" path`);
                    }
                    this._setSamples(list);
                },
            },
        };
    };

    // Shared by the constructor and the `samples` option above: replaces the
    // slot list and kicks off (re)loading. Fire-and-forget: nothing awaits
    // `_loaded`, so a trigger for a slot whose buffer hasn't finished
    // loading yet silently does nothing (see trigger()'s
    // `if (!slot?.buffer) return`) rather than queuing.
    _setSamples(samples) {
        this.samples = samples;
        this.slots = samples.map((filename) => ({
            name: sampleName(filename),
            // Relative to the host's "/samples/" path, and may include a
            // folder ("kicks/a.wav") — see samples.js's sampleUrl, which
            // encodes each segment rather than the "/" between them.
            url: sampleUrl(filename),
            buffer: null,
        }));
        this._loaded = this._loadAll();
    };

    // Fetches and decodes every sample file in parallel, filling in each
    // slot's `buffer` in place as it finishes. A file that fails leaves one
    // silent slot and a warning — nothing awaits `_loaded`, so a rejection
    // here would otherwise surface as an unhandled one (percsampler's rule).
    async _loadAll() {
        await Promise.all(this.slots.map(async (slot) => {
            try {
                const response = await fetch(slot.url);
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                slot.buffer = await this.audioContext.decodeAudioData(await response.arrayBuffer());
            } catch (error) {
                console.warn(`${this.name}: couldn't load ${slot.url} — ${error.message}`);
            }
        }));
    };

    // Selects a slot by event.pitch, wrapping (including for negative
    // pitches, hence the double modulo) rather than throwing out of range,
    // and plays it once through a simple velocity-scaled gain. A sampler
    // doesn't resolve harmony, so an event authored with degree= instead of
    // pitch= (valid generically on add_event) leaves pitch undefined; falls
    // back to slot 0 rather than silently NaN-ing out to no sound at all.
    trigger(time, event, secondsPerBeat) {
        const pitch = event.pitch ?? 0;
        const slot = this.slots[((pitch % this.slots.length) + this.slots.length) % this.slots.length];
        if (!slot?.buffer) return;

        const source = this.audioContext.createBufferSource();
        source.buffer = slot.buffer;

        const voiceGain = this.audioContext.createGain();
        voiceGain.gain.value = event.velocity;

        source.connect(voiceGain).connect(this.output);
        source.start(time);
    };
};
