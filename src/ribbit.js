import { RibbitClock } from "./clock.js";
import { RibbitChannel } from "./channel.js";
import { RibbitTrack } from "./track.js";
import { RibbitReverb } from "./processors/reverb.js";
import { RibbitDelay } from "./processors/delay.js";
import { RibbitCompressor } from "./processors/compressor.js";
import { RibbitSaturator } from "./processors/saturator.js";
import { RibbitTilt } from "./processors/tilt.js";
import { RibbitLimiter } from "./processors/limiter.js";
import { RibbitGoodenizer } from "./processors/goodenizer.js";
import { RibbitOscSynth } from "./synths/oscsynth.js";
import { RibbitSampler } from "./synths/sampler.js";
import { RibbitPercSampler } from "./synths/percsampler.js";
import { RibbitKarplus } from "./synths/karplus.js";
import { RibbitGranular } from "./synths/granular.js";
import { RibbitTapePad } from "./synths/tapepad.js";
import { RibbitChaosSynth } from "./synths/chaossynth.js";
import { RibbitCZSynth } from "./synths/czsynth.js";
import { RibbitLFO } from "./modulators/lfo.js";
import { RibbitRandomNotes } from "./modulators/randomnotes.js";
import { RibbitCV } from "./modulators/cv.js";
import { RibbitMarkovPercs } from "./modulators/markovpercs.js";
import { RibbitEuclidPercs } from "./modulators/euclidpercs.js";
import { RibbitPatternVariator } from "./modulators/patternvariator.js";
import { RibbitChorale } from "./modulators/chorale.js";
import { RibbitPatch, RibbitEventPatch } from "./patch.js";
import { createHarmonyContext } from "./harmony.js";

// String-keyed registries that map a command/UI-facing type name to a class.
// Adding a new synth, processor, or modulator type means adding one entry
// here (plus the import) — createSynth/createProcessor/createModulator and
// the command router (synth=/add_processor=/add_modulator) look types up
// dynamically, with no other code needing to know new types exist. See
// docs/dev/creating-a-synth.md and docs/dev/creating-a-processor.md.
const PROCESSOR_TYPES = {
    reverb: RibbitReverb,
    delay: RibbitDelay,
    compressor: RibbitCompressor,
    saturator: RibbitSaturator,
    tilt: RibbitTilt,
    limiter: RibbitLimiter,
    // A composite of the four above rather than a sixth implementation —
    // see processors/goodenizer.js.
    goodenizer: RibbitGoodenizer,
};

const SYNTH_TYPES = {
    oscsynth: RibbitOscSynth,
    sampler: RibbitSampler,
    percsampler: RibbitPercSampler,
    karplus: RibbitKarplus,
    granular: RibbitGranular,
    tapepad: RibbitTapePad,
    chaossynth: RibbitChaosSynth,
    czsynth: RibbitCZSynth,
};

const MODULATOR_TYPES = {
    lfo: RibbitLFO,
    randomnotes: RibbitRandomNotes,
    cv: RibbitCV,
    markovpercs: RibbitMarkovPercs,
    euclidpercs: RibbitEuclidPercs,
    patternvariator: RibbitPatternVariator,
    chorale: RibbitChorale,
};

// Every name the console router dispatches before it ever looks at objects:
// the top-level commands (see commands.js, which sanity-checks itself against
// this list at router build time) plus "master". An object created with one
// of these names would be permanently unaddressable (the router finds the
// command/master first), so _uniqueName treats them as taken and de-duplicates
// past them, exactly like a name collision with an existing object.
export const RESERVED_NAMES = new Set([
    "start", "stop", "add_track", "tracks", "add_bus", "buses", "clock",
    "harmony", "add_modulator", "modulators", "patch", "unpatch", "patches",
    "save", "recall", "remove_state", "states",
    "save_session", "save_json", "load_session", "load_json",
    "master", "help",
]);

// The top-level owner: one instance per page. Holds the AudioContext, the
// clock, the master bus, and every track/processor, and is the only place
// that knows how to construct/register/tear down any of them. Both the
// command router (commands.js) and any host UI operate on one shared Ribbit
// instance rather than their own copies of this state.
export class Ribbit {
    // `latencyHint` is the one AudioContext construction option worth
    // exposing this early — "interactive" (the browser default, and this
    // class's own default) favors the lowest latency at the cost of more
    // CPU; "playback" accepts higher latency for fewer glitches; "balanced"
    // sits between the two. A host app typically surfaces this in an
    // audio-options panel and passes it in here — it can't be changed after
    // construction, since the Web Audio spec only accepts it at AudioContext
    // creation time.
    constructor({ latencyHint = "interactive" } = {}) {
        this.audioContext = new AudioContext({ latencyHint });
        // Some browsers grant AudioContext a running start if page navigation
        // counted as a user gesture, even though nothing has called start()
        // yet. Force it suspended so the UI's off-by-default state is honest.
        this.audioContext.suspend();
        this.running = false;

        this.master = new RibbitChannel(this.audioContext, { name: "master" });
        this.master.connect(this.audioContext.destination, "speakers");

        this.tracks = [];
        this.buses = [];
        this.processors = [];
        this._processorIdCounter = 0;

        this.modulators = [];
        this.patches = [];
        this._patchIdCounter = 0;

        // Named full-session snapshots captured by /save and applied by
        // /recall (see session.js) — persisted as part of the session JSON
        // too, so a saved session's states survive a save/load round trip.
        this.states = {};

        // One shared context every synth resolves RibbitEvent.degree against
        // (see harmony.js) — mutate its fields in place (once a /harmony
        // command exists) rather than replacing this object, so synths that
        // already hold a reference stay in sync.
        this.harmony = createHarmonyContext();

        this.clock = new RibbitClock(this.audioContext);
        this.clock.addUnit(this.master);

        // Live setTimeout ids from automation.js's scheduleAt — deferred work
        // that can't ride native AudioParam scheduling (/recall's structural
        // create/remove/reorder, /clock num_beats= at=). Native scheduling
        // dies with the AudioContext; these don't, so dispose() has to cancel
        // them explicitly or they fire against a closed context. Entries
        // remove themselves once they run.
        this._deferredTimers = new Set();

        // Optional host-supplied sink for output that no command is waiting
        // on — deferred at=beat/at=cycle work, and a loaded session's readme
        // (see notify() below). A host that doesn't set it still sees
        // everything, just in the browser console.
        this.onMessage = null;

        // The current session's readme: an array of lines a session file can
        // carry to introduce itself when opened (what it is, which commands
        // to try). Set by session.js's loadSession, serialized back out by
        // sessionToJSON, and empty for a session that was never loaded from
        // a file.
        this.readme = [];
    };

    // Pushes a line of unprompted output to the host (see onMessage). `kind`
    // is a presentation hint the host may style differently: "deferred" for
    // at=-scheduled work reporting back, "readme" for a session introducing
    // itself on load.
    //
    // Every ordinary command reports by *returning* a string, which the host
    // prints. Some output can't work that way: by the time a `/hats seed=20
    // at=cycle` actually reseeds, its command has long since returned, and a
    // session auto-loaded from a URL had no command to begin with. Without a
    // channel like this one, a deferred failure (a name that collided in the
    // meantime, an option setter that threw) would vanish silently — worse
    // than for an immediate command, because the user has already been told
    // it was scheduled.
    notify(text, kind = "deferred") {
        if (this.onMessage) this.onMessage(text, kind);
        else console.log(`[ribbit] ${text}`);
    };

    // Registered type names (see PROCESSOR_TYPES/SYNTH_TYPES/MODULATOR_TYPES
    // above) — exposed read-only so callers (e.g. commands.js's help text)
    // can list what's available without reaching into this module's private
    // registries directly.
    get synthTypes() {
        return Object.keys(SYNTH_TYPES);
    };

    get processorTypes() {
        return Object.keys(PROCESSOR_TYPES);
    };

    get modulatorTypes() {
        return Object.keys(MODULATOR_TYPES);
    };

    // audioContext.resume() must run synchronously within a user-gesture
    // call stack (e.g. a keydown handler), which /start satisfies.
    start() {
        this.audioContext.resume();
        this.clock.start();
        this.running = true;
    };

    stop() {
        this.clock.stop();
        this.audioContext.suspend();
        this.running = false;
    };

    // Permanent teardown, for a host that's discarding this engine (a UI
    // unmounting, a page navigating away). Distinct from stop(), which only
    // pauses: nothing here is meant to be restarted afterwards.
    //
    // Both halves matter. The AudioContext is what's actually making sound,
    // and it belongs to the browser, not to this object — dropping the last
    // reference to a Ribbit does *not* collect it, so audio keeps playing
    // until it's explicitly closed. The clock is a self-rescheduling
    // setTimeout loop, which likewise keeps firing (and would then be
    // scheduling against a closed context) until stopped. Returns close()'s
    // promise for a caller that wants to await the teardown.
    dispose() {
        this.stop();
        // Deferred work from scheduleAt (see _deferredTimers above) is the
        // third thing outliving this object: a /recall or a deferred
        // num_beats= still in flight would otherwise wake up after close().
        // stop() already covers the clock's own two timers (its tick loop and
        // any in-flight rampBpm).
        for (const id of this._deferredTimers) clearTimeout(id);
        this._deferredTimers.clear();
        // Same duck-typed hook removeTrack/removeModulator use for a single
        // object; here it covers everything still alive at teardown.
        for (const track of this.tracks) track.source?.dispose?.();
        for (const modulator of this.modulators) modulator.dispose?.();
        for (const processor of this.processors) processor.dispose?.();
        return this.audioContext.close();
    };

    // Every name currently addressable as /name (excluding "master", which
    // lives in RESERVED_NAMES) — tracks, buses, processors, and modulators
    // share ONE namespace, since the console router dispatches a bare /name
    // against all four kinds in order and a duplicate across kinds would
    // leave the later one permanently shadowed.
    _allNames() {
        return new Set([
            ...this.tracks.map((t) => t.name),
            ...this.buses.map((b) => b.name),
            ...this.processors.map((p) => p.name),
            ...this.modulators.map((m) => m.name),
        ]);
    };

    // Validates `base` as an addressable name (must parse as a /name token,
    // and must not contain "." — a patch destination is "name.param", so a
    // dot inside a name would break _resolveDest), then appends "_2", "_3",
    // ... until it collides with neither an existing object of ANY kind nor
    // a reserved top-level command name (see RESERVED_NAMES above).
    _uniqueName(base) {
        base = String(base);
        if (!/^[a-zA-Z_]\w*$/.test(base)) {
            throw new Error(`invalid name "${base}" — letters, digits, and _ only, starting with a letter or _`);
        }

        const taken = this._allNames();
        const isTaken = (name) => taken.has(name) || RESERVED_NAMES.has(name);
        if (!isTaken(base)) return base;

        let i = 2;
        while (isTaken(`${base}_${i}`)) i++;
        return `${base}_${i}`;
    };

    // Looks up `type` in SYNTH_TYPES and constructs an instance. Does not
    // register it with the clock or a track by itself — see createTrack and
    // setTrackSynth, which call this and then wire the result in.
    createSynth(type, options = {}) {
        const SynthClass = SYNTH_TYPES[type];
        if (!SynthClass) {
            throw new Error(`unknown synth type "${type}"`);
        }

        const synth = new SynthClass(this.audioContext, { ...options, harmony: this.harmony });
        // Recorded so session.js can serialize "which registry key built
        // this" — the registry itself only maps that key to a class, forward.
        synth.type = type;
        return synth;
    };

    // Creates a fully-wired track: a unique name, a synth (default
    // "oscsynth"), connected to master (or `out=` a different track/bus),
    // and registered with the clock as two separate units (the synth for its
    // own events, the track itself for its own automation — see clock.js).
    createTrack(options = {}) {
        const name = this._uniqueName(options.name ?? "track");

        // The synth keeps its own type-based name (e.g. "oscsynth", "sampler")
        // rather than inheriting the track's name — "name"/"synth"/"out" here
        // are track-level options, not meant to reach the synth's constructor.
        const { name: _trackName, synth: synthType, out, ...synthOptions } = options;
        const source = this.createSynth(synthType ?? "oscsynth", synthOptions);
        const track = new RibbitTrack(this.audioContext, source, { name });

        const destName = out ?? "master";
        const destObject = this._resolveObject(destName);
        if (!destObject) throw new Error(`unknown destination "${destName}"`);
        track.connect(destObject, destName);

        this.tracks.push(track);
        this.clock.addUnit(source);
        this.clock.addUnit(track);

        return track;
    };

    // Creates a fully-wired bus: a plain RibbitChannel (fader/pan/inserts, no
    // synth) under its own name namespace, with a default send to master (or
    // `out=` a different track/bus). A bus exists purely to be a shared
    // destination other channels can send into (e.g. a shared reverb send,
    // or a sub-mix of several tracks) — see commands.js's /add_bus and
    // channelCommand's out=/add_send=/remove_send=.
    createBus(options = {}) {
        const name = this._uniqueName(options.name ?? "bus");
        const bus = new RibbitChannel(this.audioContext, { name });

        const destName = options.out ?? "master";
        const destObject = this._resolveObject(destName);
        if (!destObject) throw new Error(`unknown destination "${destName}"`);
        bus.connect(destObject, destName);

        this.buses.push(bus);
        this.clock.addUnit(bus);

        return bus;
    };

    // Swaps a track's synth at runtime (e.g. /track_1 synth=sampler),
    // deregistering the old synth from the clock and registering the new one
    // so it starts being scheduled immediately.
    setTrackSynth(track, type, options = {}) {
        const newSource = this.createSynth(type, options);
        const oldSource = track.source;

        this.clock.removeUnit(oldSource);
        track.setSource(newSource);
        this.clock.addUnit(newSource);
        // Duck-typed, like RibbitRandomNotes' own dispose() — the built-in
        // synths (oscsynth, sampler) own nothing beyond one-shot per-trigger
        // nodes and so don't implement it, but one with persistent
        // always-running nodes (an idle noise floor, a free-running
        // oscillator) needs this so the outgoing synth doesn't keep running
        // forever, disconnected but still alive.
        oldSource.dispose?.();

        // A track's automation can target its synth's params, not just
        // gain/pan (see commands.js's automate=), and an RibbitAutomationEvent
        // holds a raw AudioParam reference — so every such event is now
        // pointing at a param on a synth that no longer exists. Re-aim the
        // ones the new synth also has (two synths sharing a param name mean
        // the same thing by it) and drop the rest, rather than leaving the
        // clock ramping a disconnected node forever.
        track.automation = track.automation.filter((event) => {
            if (!event.paramKey || event.paramKey in track.params) return true;
            const param = newSource.params[event.paramKey];
            if (!param) return false;
            event.target = param.audioParam;
            return true;
        });

        return newSource;
    };

    // Creates a processor, assigns it a unique name and a stable id (e.g.
    // "p1") used for cross-referencing from a channel's insert list, and
    // registers it with the clock (for its own automation). Note this does
    // NOT insert it into any channel's chain — callers (e.g. channelCommand's
    // add_processor=) still need to call channel.addProcessor(processor).
    createProcessor(type, options = {}) {
        const ProcessorClass = PROCESSOR_TYPES[type];
        if (!ProcessorClass) {
            throw new Error(`unknown processor type "${type}"`);
        }

        const name = this._uniqueName(options.name ?? type);
        const processor = new ProcessorClass(this.audioContext, { ...options, name });
        processor.id = `p${++this._processorIdCounter}`;
        // See createSynth's `synth.type` for why this is recorded here rather
        // than reverse-derived from the registry (see session.js).
        processor.type = type;

        this.processors.push(processor);
        this.clock.addUnit(processor);

        return processor;
    };

    // Fully removes a track: tears down its own processor inserts and sends,
    // disconnects every node it owns, and deregisters both the track and its
    // synth from the clock. Returns false (no-op) if the track isn't
    // actually registered.
    removeTrack(track) {
        const index = this.tracks.indexOf(track);
        if (index === -1) return false;

        // Must run before any disconnect() below — a patch/send's own
        // disconnect() targets a specific node/param and throws if that
        // connection was already severed by a blanket disconnect() first.
        this._removePatchesReferencing(track);
        this._removeSendsReferencing(track);

        for (const processor of [...track.processors]) {
            this.removeProcessor(processor);
        }

        for (const send of [...track.sends]) track.removeSend(send.id);

        track.source.output.disconnect();
        // See setTrackSynth's own oldSource.dispose?.() for why this exists.
        track.source.dispose?.();
        track.input.disconnect();
        track.gainNode.disconnect();

        this.tracks.splice(index, 1);
        this.clock.removeUnit(track.source);
        this.clock.removeUnit(track);

        return true;
    };

    // Fully removes a bus: tears down any send any other channel was feeding
    // into it, its own inserts and sends, and deregisters it from the clock.
    // Returns false (no-op) if the bus isn't actually registered.
    removeBus(bus) {
        const index = this.buses.indexOf(bus);
        if (index === -1) return false;

        this._removePatchesReferencing(bus);
        this._removeSendsReferencing(bus);

        for (const processor of [...bus.processors]) {
            this.removeProcessor(processor);
        }

        for (const send of [...bus.sends]) bus.removeSend(send.id);

        bus.input.disconnect();
        bus.gainNode.disconnect();

        this.buses.splice(index, 1);
        this.clock.removeUnit(bus);

        return true;
    };

    // Removes a processor from whichever channel currently holds it (if any)
    // and deregisters it from the clock. Returns false (no-op) if the
    // processor isn't actually registered.
    removeProcessor(processor) {
        const index = this.processors.indexOf(processor);
        if (index === -1) return false;

        this._removePatchesReferencing(processor);
        processor._channel?.removeProcessor(processor.id);

        this.processors.splice(index, 1);
        this.clock.removeUnit(processor);
        // Same duck-typed hook a synth or modulator gets on removal (see
        // removeTrack/removeModulator). A processor whose params are backed
        // by ConstantSourceNodes — anything using
        // RibbitProcessor.createCrossfade — owns running nodes that reach
        // audioContext.destination through their own muted sinks, so
        // unwiring it from the chain doesn't stop them.
        processor.dispose?.();

        return true;
    };

    // Looks up `type` in MODULATOR_TYPES and constructs+registers a named
    // modulator (unique within its own namespace, like tracks/processors).
    // Modulators are registered with the clock so their own params can be
    // ramped/pattern-automated the same way a processor's can, but — unlike
    // a track's synth — never connect into any channel's chain; they exist
    // only to be patched (see createPatch) into some other object's param.
    createModulator(type, options = {}) {
        const ModulatorClass = MODULATOR_TYPES[type];
        if (!ModulatorClass) {
            throw new Error(`unknown modulator type "${type}"`);
        }

        const name = this._uniqueName(options.name ?? type);
        const modulator = new ModulatorClass(this.audioContext, { ...options, name });
        // See createSynth's `synth.type` for why this is recorded here rather
        // than reverse-derived from the registry (see session.js).
        modulator.type = type;

        this.modulators.push(modulator);
        this.clock.addUnit(modulator);

        return modulator;
    };

    // Removes a modulator: tears down any patch that touches it (as either
    // endpoint — a modulator can itself be patched into, e.g. one LFO's
    // output driving another's freq) before disconnecting its own output.
    removeModulator(modulator) {
        const index = this.modulators.indexOf(modulator);
        if (index === -1) return false;

        this._removePatchesReferencing(modulator);
        modulator.output.disconnect();
        // Duck-typed, like generateEvents — most modulators (e.g. RibbitLFO)
        // own nothing beyond `.output`; RibbitRandomNotes also owns a couple of
        // internal nodes routed straight to audioContext.destination (see its
        // own dispose() for why) that this alone wouldn't reach.
        modulator.dispose?.();

        this.modulators.splice(index, 1);
        this.clock.removeUnit(modulator);

        return true;
    };

    // Resolves a bare name against every addressable object — the same
    // namespace the console router searches when dispatching /name — for use
    // as a patch endpoint. Order matches executeOne's dispatch order.
    _resolveObject(name) {
        if (name === "master") return this.master;
        return this.tracks.find((t) => t.name === name)
            ?? this.buses.find((b) => b.name === name)
            ?? this.processors.find((p) => p.name === name)
            ?? this.modulators.find((m) => m.name === name);
    };

    // Resolves a patch destination string "name.param" (e.g. "reverb.wet",
    // "track_1.gain", "lfo1.freq") into the object that owns it and the raw
    // AudioParam itself. Every patchable kind of object — a channel (track or
    // master), a processor, or a modulator — exposes its params the same way
    // (see param.js's RibbitParam), so there's exactly one lookup here rather
    // than a special case per object kind.
    _resolveDest(destName) {
        const dotIndex = destName.indexOf(".");
        if (dotIndex === -1) {
            throw new Error(`invalid patch destination "${destName}" — expected "name.param", e.g. "reverb.wet"`);
        }
        const objectName = destName.slice(0, dotIndex);
        const paramKey = destName.slice(dotIndex + 1);

        const object = this._resolveObject(objectName);
        if (!object) throw new Error(`unknown patch destination object "${objectName}"`);

        // A track routes its own name through to its synth's params too
        // (the same fallback channelCommand already uses for a plain
        // `/track_1 cutoff=800` set) — a synth's own params are otherwise
        // unreachable as a patch destination. karplus, percsampler and
        // granular all declare params that land here.
        const param = object.params?.[paramKey] ?? object.source?.params?.[paramKey];
        if (!param) throw new Error(`unknown param "${paramKey}" on "${objectName}"`);

        return { object, param };
    };

    // Creates one "patch cable": sourceName is any addressable object (a
    // modulator, but also a track/master/processor, whose .output can double
    // as a CV source); destName is "name.param" as resolved by _resolveDest —
    // or "name.notes" (see _createEventPatch below), the discrete counterpart
    // for an event-generating modulator (e.g. randomnotes) feeding a synth's
    // control input instead of a continuous AudioParam. depth is the regular
    // patch's own attenuator, independent of both endpoints; an event patch
    // has no depth (see RibbitEventPatch).
    createPatch({ sourceName, destName, depth = 1 }) {
        const sourceObject = this._resolveObject(sourceName);
        if (!sourceObject) throw new Error(`unknown patch source "${sourceName}"`);

        if (destName.endsWith(".notes")) {
            return this._createEventPatch(sourceObject, sourceName, destName);
        }

        if (!sourceObject.output) throw new Error(`"${sourceName}" has no output to patch from`);

        const { object: destObject, param: destParam } = this._resolveDest(destName);

        const patch = new RibbitPatch(this.audioContext, {
            id: `x${++this._patchIdCounter}`,
            sourceObject,
            sourceName,
            destObject,
            destName,
            destParam,
            depth,
        });

        this.patches.push(patch);
        return patch;
    };

    // The ".notes" branch of createPatch: sourceObject must generate events
    // (duck-typed — see RibbitRandomNotes.generateEvents), and destName's
    // object part must be a channel with a synth (a track). destObject is the
    // channel itself, not its synth directly, so the patch survives a synth=
    // swap — same property a gain/pan patch already has.
    _createEventPatch(sourceObject, sourceName, destName) {
        if (typeof sourceObject.generateEvents !== "function") {
            throw new Error(`"${sourceName}" doesn't generate events — only an event-generating modulator (e.g. type=randomnotes) can patch into ".notes"`);
        }

        const channelName = destName.slice(0, -".notes".length);
        const destObject = this._resolveObject(channelName);
        if (!destObject?.source) {
            throw new Error(`"${channelName}" has no synth to receive notes`);
        }

        // A duplicate cable here isn't additive the way two RibbitPatch cables
        // into the same param are (two depths summing is legit modular
        // routing) — it would just deliver every generated note twice to the
        // same synth, which reads as a bug, not a patch.
        if (sourceObject.eventDestinations.includes(destObject)) {
            throw new Error(`"${sourceName}" is already patched into "${channelName}.notes"`);
        }

        const patch = new RibbitEventPatch({
            id: `x${++this._patchIdCounter}`,
            sourceObject,
            sourceName,
            destObject,
            destName,
        });

        this.patches.push(patch);
        return patch;
    };

    // Removes one patch (by reference). Returns false (no-op) if it isn't
    // actually registered.
    removePatch(patch) {
        const index = this.patches.indexOf(patch);
        if (index === -1) return false;

        patch.disconnect();
        this.patches.splice(index, 1);

        return true;
    };

    // Disconnects/removes every patch touching `object` (as either endpoint)
    // — called when the object itself is torn down, so a patch never
    // outlives the thing it was connected to.
    _removePatchesReferencing(object) {
        for (const patch of [...this.patches]) {
            if (patch.sourceObject === object || patch.destObject === object) {
                this.removePatch(patch);
            }
        }
    };

    // Disconnects/removes every send feeding into `object` (from any track,
    // bus, or master) — called when the object itself is torn down, so a
    // send never outlives the destination it was feeding.
    _removeSendsReferencing(object) {
        for (const channel of [...this.tracks, ...this.buses, this.master]) {
            for (const send of [...channel.sends]) {
                if (send.destination === object) channel.removeSend(send.id);
            }
        }
    };
};
