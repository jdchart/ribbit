import { RibbitSynth } from "../synth.js";
import { RibbitParamSources } from "../param.js";
import { resolveDegree } from "../harmony.js";
import {
    SAMPLE_MANIFEST_URL,
    fetchSampleManifest,
    resolvedSampleManifest,
    sampleFolders,
    sampleName,
    sampleUrl,
} from "../samples.js";

// Which folder of the host's sample library a fresh instance picks its source
// from. Unlike percsampler's four categories — whose names are load-bearing,
// since slot arithmetic depends on them — this is only a default: any folder
// the host serves works, and `folder=` switches between them.
const DEFAULT_FOLDER = "foley";

// Ceiling on the number of grains one note may schedule. Exceeding it thins the
// cloud (the interval is stretched to keep it spanning the whole note) rather
// than truncating it — a pad that stops halfway through is a bug you can hear,
// while one that gets grainier is a texture.
const MAX_GRAINS = 400;

// Random spread applied to each grain's start time, as a fraction of the
// nominal interval between grains. Not exposed: a perfectly periodic cloud
// combs — regular spacing at, say, 30 grains/second is a 30Hz amplitude
// modulation sitting on top of everything — so this isn't a taste setting, it's
// what makes the technique work at all.
const TIME_JITTER = 0.5;

// Ceiling on the automatic gain match applied to a source (see _measure).
// 20x is 26dB, enough to bring a quiet field recording up to a usable level
// without turning a near-silent file into an amplified noise floor.
const MAX_NORMALIZE = 20;

// Resolution of the grain window below. 128 points is inaudibly smooth at any
// grain length the synth allows, and small enough that the arrays can be built
// once and shared by every grain.
const WINDOW_POINTS = 128;

// The grain envelope: the short fade in and out applied to each slice, without
// which every grain would begin and end on a click. Shape is a real timbral
// choice, which is why it's an option — `hann` is the classic (smooth both
// ends, grains melt into each other), `tri` is a touch more present, and
// `expo` gives each grain an attack, so a cloud reads as a shimmer of tiny
// events rather than a continuous wash.
//
// Curves are unit-amplitude and shared across every grain of every note — the
// per-note level lives on the voice gain the grains feed into, so nothing here
// ever needs scaling and no Float32Array is allocated per grain.
const WINDOWS = ["hann", "tri", "expo"];
const windowCurves = new Map();

function windowCurve(shape) {
    if (!windowCurves.has(shape)) {
        const curve = new Float32Array(WINDOW_POINTS);
        for (let i = 0; i < WINDOW_POINTS; i++) {
            const t = i / (WINDOW_POINTS - 1);
            if (shape === "tri") curve[i] = 1 - Math.abs(t * 2 - 1);
            else if (shape === "expo") curve[i] = t < 0.05 ? t / 0.05 : Math.exp(-5 * (t - 0.05) / 0.95);
            else curve[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
        }
        // Whatever the shape, the last point is silence: the curve holds its
        // final value after the grain ends, and a grain that stopped at 0.007
        // instead of 0 leaves a DC step behind on that gain node.
        curve[WINDOW_POINTS - 1] = 0;
        windowCurves.set(shape, curve);
    }
    return windowCurves.get(shape);
};

// Which way a grain reads the source. Reverse needs a reversed *copy* of the
// buffer (Web Audio has no backwards playback — a negative playbackRate is not
// defined for AudioBufferSourceNode), so it's built lazily and only when asked
// for: see _ensureReversed.
const DIRECTIONS = ["forward", "reverse", "mixed"];

// A granular synth: one source recording, played as a cloud of short windowed
// grains rather than as a sample.
//
// The whole idea is that a note is not a playback. Each note schedules dozens
// of overlapping slices taken from around a movable playhead in the source
// buffer, each one sprayed in read position, pitch, timing and stereo
// placement. Feed it a few seconds of foley — rain, a river, glass, birds —
// and what comes out has no relationship to the recording's own rhythm at all:
// it's a sustained texture whose character is the recording's timbre.
//
// **The structure is two stages, and keeping them separate is the design.**
// A note is `voice envelope x sum of grains`: `attack`/`release` shape the
// note (making this a pad instrument), while `density`/`grain_size`/`spray`
// shape the cloud (making it a texture instrument). Both are live params, so
// one hand can be on the shape of the note and the other on the shape of the
// grain, which is exactly the split a modular granular patch has.
//
// Every grain of a note is scheduled up front, at trigger time, into the
// browser's audio clock — no timers, nothing running between notes. Polyphony
// is therefore free, as in karplus: a chord is three clouds overlapping and
// there is no voice allocator to run out of.
//
// Pitch works even though foley isn't pitched: a degree resolves against the
// shared harmony context and sets each grain's playbackRate relative to
// `root`. Transposing a field recording is a tape-speed gesture, not a musical
// interval, so a chord reads as several layers of the same material at
// different sizes — which is most of why this makes a good pad.
export class RibbitGranular extends RibbitSynth {
    constructor(audioContext, {
        name = "granular",
        harmony,
        folder = DEFAULT_FOLDER,
        sample = null,
        manifest_url = SAMPLE_MANIFEST_URL,
        window: windowShape = "hann",
        direction = "forward",
        root = 60,
        density = 30,
        grain_size = 0.2,
        spray = 0.25,
        position = 0,
        drift = 0.05,
        pitch_spread = 0.15,
        pan_spread = 0.8,
        attack = 1.2,
        release = 2,
    } = {}) {
        super(audioContext, { name, harmony });
        this.llm_summary = "A granular synth: one source recording (picked at random from a folder of the host's sample library) played back as a cloud of short overlapping grains, for sustained pad textures. Plays chords; degrees transpose the grains against the shared harmony context.";

        this.manifestUrl = manifest_url;
        this.folder = String(folder);
        this.window = windowShape;
        this.direction = direction;
        this.root = Math.round(Number(root));
        this.sample = null;
        this.buffer = null;
        this._reversed = null;
        // Gain match for the current source, measured at load — see _measure.
        this._normalize = 1;

        // Bumped by every source change, for the same reason percsampler does
        // it: a random roll finishes asynchronously and replaces the buffer
        // when it lands, so without this a roll you didn't like, immediately
        // followed by an explicit sample=, would silently revert a moment
        // later — last writer wins, and the last writer is the one you already
        // rejected.
        this._generation = 0;

        // An explicit path (what a saved session hands back) skips the
        // manifest entirely and is used verbatim, which is what makes a
        // session reproduce the texture it was saved with. Only a fresh
        // instance rolls the dice.
        if (sample) {
            this._setSample(sample);
            // A pinned source never needs the manifest to play — but `folder=`
            // can only reject an unknown folder against a manifest that has
            // already arrived, and in a session where every track pins its
            // source nothing else would ever fetch one. Warming the (shared,
            // per-URL cached) manifest here is what makes that validation
            // real rather than theoretical. Failures are ignored: nothing on
            // this path needs it, and the paths that do warn for themselves.
            fetchSampleManifest(this.manifestUrl).catch(() => {});
        } else {
            this._randomize();
        }

        this.options = {
            // Reports the *resolved* path, never the word "random" — a session
            // has to record which file a roll actually landed on, or reloading
            // it would produce a different instrument. Setting it takes either
            // a path or the literal "random" (re-roll within the current
            // folder), so one option covers "give me this" and "give me
            // another".
            sample: {
                get: () => this.sample,
                set: (value) => {
                    const text = String(value).trim();
                    if (text.toLowerCase() === "random") {
                        this._randomize();
                        return;
                    }
                    // Sample paths contain both "/" and spaces, and the
                    // console's parser treats a "/" as the start of the next
                    // command and a space as the end of a value, so pasting a
                    // real path in truncates it to the folder name. Catching
                    // that here is the difference between an error message and
                    // a 404 that reports success — see the same guard on
                    // percsampler's samples=.
                    if (!/\.\w+$/.test(text)) {
                        throw new Error(`invalid sample "${value}" — expected "random" or a path with a file extension, served under the host's "/samples/" path. Note the console can't carry a path containing "/" or spaces, so an explicit path is really only settable from a session file; use sample=random here.`);
                    }
                    this._setSample(text);
                },
            },

            // Which folder of the host's library rolls come from. Changing it
            // re-rolls, since the current source belongs to the old folder.
            //
            // Setting it to the value it already has must NOT re-roll, and
            // that's load-bearing rather than an optimization: session.js
            // replays every saved option in declaration order, so a /recall
            // restores `sample` and then immediately sets `folder` — an
            // unconditional re-roll there would throw the just-restored source
            // away and hand back a random one.
            folder: {
                get: () => this.folder,
                set: (value) => {
                    const next = String(value).trim();
                    if (!next) throw new Error(`folder can't be empty — expected a folder served under the host's "/samples/" path`);
                    if (next === this.folder) return;
                    // Validated only against a manifest that has already
                    // arrived. Before that there's nothing to validate against,
                    // and refusing on those grounds would make the option
                    // unusable for the first few hundred milliseconds of a
                    // session rather than safer.
                    const manifest = resolvedSampleManifest(this.manifestUrl);
                    if (manifest && !sampleFolders(manifest).includes(next)) {
                        throw new Error(`unknown folder "${next}" — expected ${sampleFolders(manifest).join(", ")}`);
                    }
                    this.folder = next;
                    this._randomize();
                },
            },

            window: {
                get: () => this.window,
                set: (value) => { this.window = value; },
                choices: WINDOWS,
            },

            // Reverse builds a mirrored copy of the buffer, so switching to it
            // costs one pass over the source (and doubles what this instance
            // holds in memory). Done here, on the set, rather than lazily at
            // trigger time — a few hundred milliseconds of copying is nothing
            // when you type a command and a glitch when a note starts.
            direction: {
                get: () => this.direction,
                set: (value) => {
                    this.direction = value;
                    if (value !== "forward") this._ensureReversed();
                },
                choices: DIRECTIONS,
            },

            // Which MIDI note plays the source at its natural speed. Everything
            // else is transposed from here, so this is how a pattern written
            // around degree 0 is placed in a register where the material still
            // sounds like itself: raise it and the whole part reads slower and
            // deeper, lower it and it speeds up.
            root: {
                get: () => this.root,
                set: (value) => {
                    const midi = Math.round(Number(value));
                    if (!Number.isFinite(midi) || midi < 0 || midi > 127) {
                        throw new Error(`invalid root "${value}" — expected a MIDI note number 0-127`);
                    }
                    this.root = midi;
                },
            },
        };

        // Everything below is a param rather than an option because sweeping it
        // is the instrument. Opening `spray` up over eight bars, riding
        // `density` down into a breakdown, or patching a slow LFO into
        // `position` so the cloud wanders through the recording — those are the
        // gestures this synth exists for, and none of them survive being a
        // discrete setting. They ride silent ConstantSourceNodes since the
        // grain scheduling is plain JS with no AudioParam to hang off; see
        // RibbitParamSources for the Web Audio quirk that makes the muted sink
        // necessary. All are read fresh per note, so a ramp applies from the
        // next note onward.
        this._paramSources = new RibbitParamSources(audioContext);
        this.params = {
            // Grains per second. Low is a stuttering pointillist texture; high
            // is a solid wash. The cost of a note is linear in this.
            density: this._paramSources.create(density, { min: 1, max: 200 }),
            // How long each grain lasts, in seconds. Below ~30ms the grain rate
            // starts to be heard as a pitch of its own rather than a texture;
            // above ~0.5s you hear the source material's own movement through
            // each grain.
            grain_size: this._paramSources.create(grain_size, { min: 0.005, max: 2 }),
            // How far, in seconds of source material, each grain's read
            // position may wander either side of the playhead. 0 is every grain
            // reading the same instant (a frozen, almost tonal drone); a second
            // or two smears a whole phrase of the recording into one chord.
            spray: this._paramSources.create(spray, { min: 0, max: 10 }),
            // The playhead: where in the source the cloud reads from, 0..1
            // across the whole buffer. The obvious patch destination — a slow
            // LFO here is a pad that keeps evolving without any new notes.
            position: this._paramSources.create(position, { min: 0, max: 1 }),
            // How fast the playhead moves *while a note is held*, in source
            // seconds per second. 0 freezes it (the classic granular pad), 1 is
            // natural speed, negative runs the material backwards through the
            // note without reversing the grains themselves.
            drift: this._paramSources.create(drift, { min: -2, max: 2 }),
            // Random detune per grain, in semitones either way. A fraction of a
            // semitone is chorus — the cheapest lushness there is; several
            // semitones is a cloud that no longer agrees with itself about what
            // note it's playing.
            pitch_spread: this._paramSources.create(pitch_spread, { min: 0, max: 24 }),
            // Random stereo placement per grain (1 = hard L to hard R). Wide by
            // default: grains scattered across the field is most of what makes
            // a cloud sound like a space rather than a sound.
            pan_spread: this._paramSources.create(pan_spread, { min: 0, max: 1 }),
            // Seconds for a note to reach full level, and to fall away after
            // its written duration ends. Long by default — this is a pad, and a
            // pad that starts instantly is a sample.
            attack: this._paramSources.create(attack, { min: 0, max: 10 }),
            release: this._paramSources.create(release, { min: 0, max: 10 }),
        };
    };

    // Required: the param sources route into the context destination, which the
    // generic output.disconnect() never reaches. Dropping the buffers matters
    // more here than in the other samplers — a field recording can be tens of
    // megabytes decoded, and the reversed copy doubles it.
    dispose() {
        this._paramSources.dispose();
        this.buffer = null;
        this._reversed = null;
    };

    // Appended to the track's one-line summary. Worth having because the source
    // is chosen at random: without it the only way to know what you're actually
    // playing is to read the session file.
    describeState() {
        if (!this.sample) return "no source";
        const label = sampleName(this.sample);
        if (!this.buffer) return `"${label}" (loading)`;
        // The gain match is worth showing: it's the difference between two
        // sources that measure 30dB apart sounding the same, and it explains
        // why turning a track down is sometimes the wrong fix.
        const matched = this._normalize > 1.05 ? ` x${this._normalize.toFixed(1)}` : "";
        return `"${label}" ${this.buffer.duration.toFixed(1)}s${matched}`;
    };

    // Picks a new source from the current folder. Synchronous once the host's
    // manifest has been seen (every roll after the first), which is what lets
    // the console echo the source it just chose rather than the one it
    // replaced.
    //
    // The first call still goes to the network and stays fire-and-forget like
    // the other samplers': the buffer is null until it lands and notes in the
    // meantime silently do nothing rather than queue up. A host serving no
    // manifest gets a warning and a silent instrument, not an exception out of
    // a constructor.
    _randomize() {
        const cached = resolvedSampleManifest(this.manifestUrl);
        if (cached) {
            this._pickFrom(cached);
            return;
        }

        const generation = ++this._generation;
        this._resolved = (async () => {
            let manifest;
            try {
                manifest = await fetchSampleManifest(this.manifestUrl);
            } catch (error) {
                console.warn(`${this.name}: couldn't read sample manifest at ${this.manifestUrl} — ${error.message}. No source loaded; set sample=<path> to load one directly.`);
                return;
            }
            // Something set the source while the manifest was in flight — that
            // choice is newer than this one, so drop the roll on the floor.
            if (generation !== this._generation) return;
            this._pickFrom(manifest);
        })();
    };

    _pickFrom(manifest) {
        const candidates = manifest[this.folder] ?? [];
        if (candidates.length === 0) {
            console.warn(`${this.name}: no samples in folder "${this.folder}" — nothing to granulate. Available: ${sampleFolders(manifest).join(", ") || "(none)"}.`);
            return;
        }
        this._setSample(candidates[Math.floor(Math.random() * candidates.length)]);
    };

    // Replaces the source and starts loading it. Shared by the constructor, an
    // explicit sample= set, and the tail of a random roll.
    _setSample(path) {
        const generation = ++this._generation;
        this.sample = path;
        this.buffer = null;
        this._reversed = null;
        this._normalize = 1;

        this._loaded = (async () => {
            const url = sampleUrl(path);
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                const decoded = await this.audioContext.decodeAudioData(await response.arrayBuffer());
                // A field recording is a slow load. Anything that changed the
                // source while this one was in flight wins, or a roll made
                // during the wait would be silently undone when the old file
                // finally arrives.
                if (generation !== this._generation) return;
                this.buffer = decoded;
                this._normalize = this._measure(decoded);
                if (this.direction !== "forward") this._ensureReversed();
            } catch (error) {
                // A silent instrument and one warning, never a throw — the
                // same rule the other samplers follow, and the one that keeps a
                // bad path in a session file from taking the whole load down.
                console.warn(`${this.name}: couldn't load ${url} — ${error.message}`);
            }
        })();
    };

    // How much to scale a source so it plays at a comparable level to any
    // other, from its peak amplitude.
    //
    // This is not a nicety. A library of field recordings is not mastered: the
    // shipped foley folder runs from an unnormalized river recording peaking at
    // -30dB to a texture at full scale, so without this `sample=random` is a
    // 30dB loudness lottery and every track gain has to be re-set by hand after
    // every roll. Matching on peak rather than RMS keeps it predictable — a
    // recording never comes back louder than it went in.
    _measure(buffer) {
        let peak = 0;
        // Long recordings are sampled rather than scanned whole: past a few
        // million frames the peak estimate stops moving, and this runs on the
        // main thread right after a decode.
        const stride = Math.max(1, Math.floor(buffer.length / 4000000));
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            const data = buffer.getChannelData(channel);
            for (let i = 0; i < data.length; i += stride) {
                const value = Math.abs(data[i]);
                if (value > peak) peak = value;
            }
        }
        if (peak <= 0) return 1;
        return Math.min(MAX_NORMALIZE, 1 / peak);
    };

    // Builds the mirrored copy reverse grains read from. Web Audio has no
    // backwards playback, so this is the only way; it's built on demand because
    // most sessions never ask for it and a decoded field recording is large
    // enough that a speculative second copy would be rude.
    _ensureReversed() {
        if (!this.buffer || this._reversed) return;
        const source = this.buffer;
        const reversed = this.audioContext.createBuffer(source.numberOfChannels, source.length, source.sampleRate);
        for (let channel = 0; channel < source.numberOfChannels; channel++) {
            const from = source.getChannelData(channel);
            const to = reversed.getChannelData(channel);
            for (let i = 0, j = from.length - 1; i < from.length; i++, j--) to[i] = from[j];
        }
        this._reversed = reversed;
    };

    // Schedules one note: a whole cloud of grains, all of them placed on the
    // audio clock before this returns.
    trigger(time, event, secondsPerBeat) {
        const buffer = this.buffer;
        if (!buffer) return;

        const velocity = event.velocity ?? 1;
        // A silent note would still cost hundreds of nodes, and the release
        // ramp below can't run from zero anyway.
        if (velocity <= 0) return;

        const ctx = this.audioContext;
        const midi = event.degree !== undefined ? resolveDegree(this.harmony, event.degree) : (event.pitch ?? this.root);
        // Transposition is tape speed here: pitch and grain content move
        // together, so a low note doesn't just sound lower, it reads slower
        // through the material.
        const rate = Math.pow(2, (midi - this.root) / 12);

        const density = this.params.density.getModulated();
        const grainSeconds = this.params.grain_size.getModulated();
        const spray = this.params.spray.getModulated();
        const position = this.params.position.getModulated();
        const drift = this.params.drift.getModulated();
        const pitchSpread = this.params.pitch_spread.getModulated();
        const panSpread = this.params.pan_spread.getModulated();
        const attack = this.params.attack.getModulated();
        const release = this.params.release.getModulated();

        const held = Math.max(0, (event.duration ?? 1) * secondsPerBeat);
        // Grains keep spawning through the release, so the tail is granular
        // too rather than a fade applied to a suddenly-static cloud.
        const total = held + release;

        // The voice envelope every grain of this note passes through. This is
        // the stage that makes a cloud a *note* — and the reason a grain's own
        // window curve can stay at unit amplitude.
        const voiceGain = ctx.createGain();
        // The source's own gain match rides here rather than on each grain:
        // one multiplication per note instead of one per grain, and it keeps
        // the grain window at unit amplitude (see WINDOWS).
        const level = velocity * this._normalize;
        // Attack can't outlast the written note, or a short note would never
        // reach its level and quiet passages would silently swallow themselves.
        const rise = Math.min(attack, held);
        voiceGain.gain.setValueAtTime(0.0001, time);
        if (rise > 0) voiceGain.gain.linearRampToValueAtTime(level, time + rise);
        else voiceGain.gain.setValueAtTime(level, time);
        voiceGain.gain.setValueAtTime(level, time + held);
        if (release > 0) voiceGain.gain.exponentialRampToValueAtTime(0.0001, time + total);
        else voiceGain.gain.setValueAtTime(0.0001, time + held);
        voiceGain.connect(this.output);

        // Grain spacing. If the note would need more grains than the ceiling
        // allows, the interval stretches so the cloud still spans the whole
        // note: a thinner texture, never a note that stops early.
        let interval = 1 / density;
        let count = Math.max(1, Math.ceil(total / interval));
        if (count > MAX_GRAINS) {
            count = MAX_GRAINS;
            interval = total / count;
        }

        const curve = windowCurve(this.window);
        const duration = buffer.duration;
        const reversible = this.direction !== "forward" && this._reversed;

        for (let i = 0; i < count; i++) {
            // Regular spacing plus jitter — see TIME_JITTER. Without this the
            // cloud amplitude-modulates itself at exactly `density` Hz.
            const offset = Math.max(0, i * interval + (Math.random() * 2 - 1) * interval * TIME_JITTER);
            if (offset > total) continue;

            const detune = pitchSpread > 0 ? (Math.random() * 2 - 1) * pitchSpread : 0;
            const grainRate = rate * Math.pow(2, detune / 12);
            // How much source material this grain consumes. A grain that runs
            // off the end of the buffer just stops early and leaves a hole, so
            // read positions are wrapped inside the span that guarantees a
            // whole grain rather than inside the whole buffer.
            const consumed = Math.min(duration, grainSeconds * grainRate);
            const span = Math.max(0.001, duration - consumed);

            // The playhead: `position` sets where the cloud reads, `drift`
            // moves it as the note is held, `spray` scatters each grain around
            // wherever that has got to.
            const wander = position * duration + drift * offset + (Math.random() * 2 - 1) * spray;
            const read = ((wander % span) + span) % span;

            const reverse = reversible && (this.direction === "reverse" || Math.random() < 0.5);

            const source = ctx.createBufferSource();
            source.buffer = reverse ? this._reversed : buffer;
            source.playbackRate.value = grainRate;

            const grainGain = ctx.createGain();
            // The window. One shared unit-amplitude curve for every grain in
            // the engine — level lives on voiceGain above — so this allocates
            // nothing per grain. The curve holds at 0 afterwards, which is why
            // no explicit fade-out is needed before stop().
            grainGain.gain.setValueCurveAtTime(curve, time + offset, grainSeconds);

            if (panSpread > 0) {
                const panner = ctx.createStereoPanner();
                panner.pan.value = (Math.random() * 2 - 1) * panSpread;
                source.connect(grainGain).connect(panner).connect(voiceGain);
            } else {
                source.connect(grainGain).connect(voiceGain);
            }

            // Reading the mirrored buffer means mirroring the position too: a
            // grain covering forward seconds [read, read + consumed] starts, in
            // the reversed copy, at duration - read - consumed.
            const start = reverse ? Math.max(0, duration - read - consumed) : read;
            source.start(time + offset, start);
            // Must follow start() — stop() on an unstarted source throws.
            source.stop(time + offset + grainSeconds + 0.01);
        }
    };
};
