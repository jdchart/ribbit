import { RibbitSynth } from "../synth.js";
import { RibbitParamSources } from "../param.js";
import {
    SAMPLE_MANIFEST_URL,
    fetchSampleManifest,
    resolvedSampleManifest,
    sampleName,
    sampleUrl,
    parseSampleList,
} from "../samples.js";

// The categories a percussion kit is built from, in slot order. This array is
// the contract a rhythm generator codes against (see modulators/markovpercs.js):
// with `per_category` slots each, kicks occupy [0, n), snares [n, 2n), hats
// [2n, 3n) and percs [3n, 4n). Changing this order silently re-maps every
// pattern any generator produces, so it's deliberately not configurable.
export const PERC_CATEGORIES = ["kicks", "snares", "hats", "percs"];

// Where the host publishes "what sample files exist, by folder", and the
// naming/caching rules for reading it, all live in ../samples.js — shared with
// `granular`, which picks its grain source from the same library. The four
// categories below are the part of that manifest this synth cares about.

// The category a sample path belongs to, or null for a path that isn't under
// one of the four folders (an explicit `samples=` list is allowed to name
// anything the host serves — see the options block below).
function sampleCategory(filePath) {
    const folder = filePath.includes("/") ? filePath.slice(0, filePath.indexOf("/")) : null;
    return PERC_CATEGORIES.includes(folder) ? folder : null;
};

// Which per-hit randomizations each category takes part in. Gain (dynamics)
// deliberately isn't here — it applies to everything, because a drum machine
// where every hit is exactly as loud as the last is the single most
// machine-like thing about it.
//
// The other two are per-category on purpose: a kick that wanders across the
// stereo field or drifts in pitch stops anchoring the track, so kicks opt out
// of both. Snares hold the centre but can vary in pitch; hats and percs, the
// decorative end of the kit, take everything.
const RANDOMIZATION = {
    kicks: { pan: false, speed: false },
    snares: { pan: false, speed: true },
    hats: { pan: true, speed: true },
    percs: { pan: true, speed: true },
};

function pickRandom(candidates, count) {
    const picked = [];
    for (let i = 0; i < count; i++) {
        // Sampling with replacement: a category with fewer files than
        // `per_category` still fills all its slots (with repeats) rather than
        // leaving holes that would shift every later category's slot index
        // and break the arithmetic PERC_CATEGORIES documents above.
        picked.push(candidates[Math.floor(Math.random() * candidates.length)]);
    }
    return picked;
};

// A drum-kit sampler: 4 x `per_category` sample slots, grouped by category in
// PERC_CATEGORIES order, with each category's samples drawn at random from
// the host's library by default. An event's pitch selects a slot and wraps,
// so a generator can emit whatever it likes without range-checking.
//
// The difference from RibbitSampler (which this deliberately doesn't
// subclass — it shares only the fetch/decode idiom, and coupling them would
// mean the parent's flat slot list fighting this one's category structure) is
// the *structure* of the slot list. A plain sampler's slots are an arbitrary
// list only its author understands; these have a published layout, which is
// what lets a rhythm generator ask for "a snare" by index without either side
// knowing the other exists.
export class RibbitPercSampler extends RibbitSynth {
    constructor(audioContext, {
        name = "percsampler",
        per_category = 4,
        samples = null,
        categories = null,
        manifest_url = SAMPLE_MANIFEST_URL,
        dynamics = 0.25,
        pan_spread = 0.4,
        speed_spread = 0.1,
    } = {}) {
        super(audioContext, { name });
        this.llm_summary = "A drum-kit sampler: 4 categories (kicks, snares, hats, percs) x per_category slots, filled at random from the host's sample library; an event's pitch picks a slot and wraps. Humanizes each hit (gain always; pan and playback speed by category).";

        this.manifestUrl = manifest_url;
        this.perCategory = Math.max(1, Math.floor(per_category));
        // Which categories this instance actually loads samples for. All four
        // by default; restricting it is how one kit gets split across several
        // tracks so each can have its own inserts and sends (see the class
        // comment above). Slot *indices* never change — an unloaded category
        // keeps its placeholders, so every generator's arithmetic still lines
        // up and the unowned hits simply fall silent.
        this.categories = this._parseCategories(categories ?? PERC_CATEGORIES);
        this.slots = [];
        this.samples = [];

        // Bumped by every kit change. A random roll finishes asynchronously
        // and *replaces* the whole slot list when it lands, so without this a
        // roll you didn't like, immediately followed by an explicit
        // `samples=<list>`, would silently revert to the random kit a moment
        // later — last writer wins, and the last writer is the one you
        // already rejected.
        this._generation = 0;

        // An explicit list (what a saved session hands back — see the
        // `samples` option) skips the manifest entirely and is used verbatim,
        // which is what makes a kit reproducible across a save/load. Only a
        // fresh instance rolls the dice.
        if (samples) this._setSamples(parseSampleList(samples));
        else this._randomize();

        this.options = {
            // Reports the *resolved* file list, never the word "random" — a
            // session has to record which files a random roll actually landed
            // on, or reloading it would silently produce a different kit.
            // Setting it accepts either a comma-separated list (pin an exact
            // kit) or the literal "random" (re-roll every category), so one
            // option covers both "give me this" and "give me another".
            samples: {
                get: () => this.samples,
                set: (value) => {
                    if (typeof value === "string" && value.trim().toLowerCase() === "random") {
                        this._randomize();
                        return;
                    }
                    const list = parseSampleList(value);
                    // Empty entries are allowed — they're the placeholders a
                    // split kit keeps for categories it doesn't own — but not
                    // a list that's nothing but.
                    if (list.every((s) => !s)) {
                        throw new Error(`invalid samples "${value}" — expected "random" or a comma-separated list of paths served under the host's "/samples/" path`);
                    }
                    // Every entry must look like a file. This mostly catches
                    // one specific thing: sample paths contain spaces, and an
                    // unquoted space ends a console value (see parseCommand),
                    // so pasting a real path in unquoted silently truncates
                    // it. Without this the truncation would be accepted, 404
                    // on load, and report success — the one failure mode
                    // worse than an error message.
                    const malformed = list.filter((entry) => entry && !/\.\w+$/.test(entry));
                    if (malformed.length) {
                        throw new Error(`invalid samples — ${malformed.map((s) => `"${s}"`).join(", ")} has no file extension. A path containing spaces has to be quoted: samples="kicks/a b.wav,hats/c.wav".`);
                    }
                    this._setSamples(list);
                },
            },

            // Changing the slot count has to re-roll: it changes what every
            // category's slot range even is, so keeping the old picks would
            // leave the layout PERC_CATEGORIES promises only half true.
            //
            // Setting it to the value it already has must NOT re-roll, and
            // that's load-bearing rather than an optimization. session.js's
            // applyOptionsSnapshot replays every saved option in declaration
            // order, so a /recall restores `samples` and then immediately
            // sets `per_category` — an unconditional re-roll there would
            // throw the just-restored kit away and hand back a random one.
            // Re-rolling at the current size is what `samples=random` is for.
            per_category: {
                get: () => this.perCategory,
                set: (value) => {
                    const count = Math.floor(Number(value));
                    if (!Number.isFinite(count) || count < 1) {
                        throw new Error(`invalid per_category "${value}" — expected a whole number >= 1`);
                    }
                    if (count === this.perCategory) return;
                    this.perCategory = count;
                    this._randomize();
                },
            },

            // Which categories this instance loads. Same no-op-when-unchanged
            // rule as per_category above, and for the same /recall reason.
            categories: {
                get: () => this.categories,
                set: (value) => {
                    const next = this._parseCategories(value);
                    if (next.join(",") === this.categories.join(",")) return;
                    this.categories = next;
                    this._randomize();
                },
            },
        };

        // The first synth in the engine to expose rampable params of its own
        // (channels/processors/modulators already did) — `channelCommand`
        // routes a track's synth params through the track's name, so these
        // are reachable as `/drums dynamics=0.6 4b` with no commands.js
        // change. Each rides a real AudioParam backed by a silent
        // ConstantSourceNode — see RibbitParamSources in param.js for the Web
        // Audio quirk that makes the muted sink necessary.
        //
        // They're params rather than options because sweeping them is
        // musical: opening pan_spread up over a few bars, or riding dynamics
        // down into a breakdown, is exactly the kind of gesture a ramp is
        // for. They're read fresh per trigger, so a ramp applies from the
        // next hit onward.
        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            // How much each hit's level can drop below its event velocity: a
            // hit is scaled by a random factor in [1 - dynamics, 1]. Capped
            // at 0.9 rather than 1 so the quietest possible hit is still
            // audible — "adds dynamics", never "randomly drops notes".
            dynamics: this._paramSources.create(dynamics, { min: 0, max: 0.9 }),
            // Random stereo placement per hit, +/- this much (1 = hard L to
            // hard R). Only applies to categories with pan enabled above.
            pan_spread: this._paramSources.create(pan_spread, { min: 0, max: 1 }),
            // Random playback rate per hit, 1 +/- this much. Since this is a
            // sampler, rate changes pitch and length together — the usual
            // tape-speed behaviour, which is what makes repeated hats stop
            // sounding like a copy-paste.
            speed_spread: this._paramSources.create(speed_spread, { min: 0, max: 1 }),
        };
    };

    // Validates a categories list against PERC_CATEGORIES and returns it in
    // canonical slot order, so `categories=percs,kicks` and
    // `categories=kicks,percs` describe the same instance.
    _parseCategories(value) {
        const list = Array.isArray(value) ? value : String(value).split(",").map((s) => s.trim());
        const wanted = new Set(list.filter(Boolean).map((s) => s.toLowerCase()));
        const unknown = [...wanted].filter((c) => !PERC_CATEGORIES.includes(c));
        if (unknown.length) {
            throw new Error(`unknown categor${unknown.length === 1 ? "y" : "ies"} ${unknown.map((c) => `"${c}"`).join(", ")} — expected ${PERC_CATEGORIES.join(", ")}`);
        }
        if (wanted.size === 0) throw new Error(`categories can't be empty — expected one or more of ${PERC_CATEGORIES.join(", ")}`);
        return PERC_CATEGORIES.filter((c) => wanted.has(c));
    };

    // Duck-typed teardown, called by Ribbit.removeTrack/setTrackSynth/dispose.
    // Needed because the param sources above are routed into the context
    // destination, which the generic `output.disconnect()` never reaches —
    // exactly the situation RibbitRandomNotes.dispose() exists for.
    dispose() {
        this._paramSources.dispose();
    };

    // Total slots per category, published for a rhythm generator that wants
    // to compute a slot index (category * this + variant) rather than
    // hardcode a stride. See markovpercs, which reads this off its patched
    // destination when it can.
    get slotsPerCategory() {
        return this.perCategory;
    };

    // Picks one sample per slot from an already-resolved manifest.
    _pickKit(manifest) {
        const chosen = [];
        for (const category of PERC_CATEGORIES) {
            // A category this instance doesn't own still occupies its slots —
            // as placeholders. That's what keeps slot indices absolute across
            // a split kit: a generator emitting "snare, variant 2" hits index
            // 6 whether it's talking to the full kit or to a hats-only track,
            // and on the latter it simply makes no sound. No filtering, no
            // negotiation, no shared state between the tracks.
            if (!this.categories.includes(category)) {
                chosen.push(...new Array(this.perCategory).fill(null));
                continue;
            }

            const candidates = manifest[category] ?? [];
            if (candidates.length === 0) {
                console.warn(`${this.name}: no samples in category "${category}" — its ${this.perCategory} slot(s) will stay silent.`);
                chosen.push(...new Array(this.perCategory).fill(null));
                continue;
            }
            chosen.push(...pickRandom(candidates, this.perCategory));
        }
        return chosen;
    };

    // Re-picks every owned category. Synchronous once the host's manifest has
    // been seen (the overwhelmingly common case — every re-roll after the
    // first), which is what lets the console echo the kit it just chose
    // rather than the one it replaced.
    //
    // The first call for a given manifest URL still has to go to the network,
    // and stays fire-and-forget like RibbitSampler's loading: the slot list is
    // empty until it resolves and triggers in the meantime silently do
    // nothing rather than queue up. A host serving no manifest gets an empty
    // kit and one console warning, not an exception out of a constructor.
    _randomize() {
        const cached = resolvedSampleManifest(this.manifestUrl);
        if (cached) {
            this._setSamples(this._pickKit(cached));
            return;
        }

        const generation = ++this._generation;
        this._resolved = (async () => {
            let manifest;
            try {
                manifest = await fetchSampleManifest(this.manifestUrl);
            } catch (error) {
                console.warn(`${this.name}: couldn't read sample manifest at ${this.manifestUrl} — ${error.message}. Kit is empty; set samples=<list> to load files directly.`);
                return;
            }

            const chosen = this._pickKit(manifest);
            // Something set the kit while the manifest was in flight — that
            // choice is newer than this one, so drop the roll on the floor.
            if (generation !== this._generation) return;
            this._setSamples(chosen);
        })();
    };

    // Replaces the slot list and starts loading. Shared by the constructor,
    // an explicit samples= set, and the tail of a random roll.
    _setSamples(samples) {
        this._generation++;
        this.samples = samples;
        this.slots = samples.map((filePath) => ({
            name: filePath ? sampleName(filePath) : "(empty)",
            category: filePath ? sampleCategory(filePath) : null,
            url: filePath ? sampleUrl(filePath) : null,
            buffer: null,
        }));
        this._loaded = this._loadAll();
    };

    async _loadAll() {
        await Promise.all(this.slots.map(async (slot) => {
            if (!slot.url) return;
            try {
                const response = await fetch(slot.url);
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                slot.buffer = await this.audioContext.decodeAudioData(await response.arrayBuffer());
            } catch (error) {
                // One unreadable file leaves one silent slot; the other
                // fifteen still play. Promise.all would otherwise reject the
                // whole kit's load on the first bad path.
                console.warn(`${this.name}: couldn't load ${slot.url} — ${error.message}`);
            }
        }));
    };

    // pitch selects a slot, wrapping in both directions (hence the double
    // modulo). Unlike RibbitSampler this falls back to `degree` before slot 0:
    // several generic generators (randomnotes) emit degree=, and treating that
    // as a slot index makes them usable as drum drivers instead of pinning
    // every note to the first slot. Nothing here resolves harmony — a slot
    // index isn't a pitch.
    trigger(time, event, secondsPerBeat) {
        if (this.slots.length === 0) return;

        const index = event.pitch ?? event.degree ?? 0;
        const slot = this.slots[((index % this.slots.length) + this.slots.length) % this.slots.length];
        if (!slot?.buffer) return;

        const randomize = RANDOMIZATION[slot.category] ?? { pan: false, speed: false };

        const source = this.audioContext.createBufferSource();
        source.buffer = slot.buffer;

        // Tape-speed variation: pitch and length move together, which is the
        // point — it's what stops a repeated hat sounding like one sample
        // pasted sixteen times. Floored well above 0 because a rate at or
        // below 0 either freezes the sample or throws.
        if (randomize.speed) {
            const spread = this.params.speed_spread.getModulated();
            if (spread > 0) {
                source.playbackRate.value = Math.max(0.1, 1 + (Math.random() * 2 - 1) * spread);
            }
        }

        const voiceGain = this.audioContext.createGain();
        // Velocity is the floor the generator asked for; dynamics only ever
        // takes away from it, by a random amount up to `dynamics`. Since that
        // param is capped at 0.9 the quietest possible hit is a tenth of its
        // velocity — quiet, but never a dropped note.
        const dynamics = this.params.dynamics.getModulated();
        voiceGain.gain.value = event.velocity * (1 - Math.random() * dynamics);

        // The panner is built per hit and only when it would do something —
        // an always-on StereoPannerNode per voice would be a node (and a
        // stereo upmix) that most hits don't need.
        const panSpread = randomize.pan ? this.params.pan_spread.getModulated() : 0;
        if (panSpread > 0) {
            const panner = this.audioContext.createStereoPanner();
            panner.pan.value = (Math.random() * 2 - 1) * panSpread;
            source.connect(voiceGain).connect(panner).connect(this.output);
        } else {
            source.connect(voiceGain).connect(this.output);
        }

        source.start(time);
    };
};
