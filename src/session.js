import { scheduleRamp, setInstant, scheduleAt, RibbitAutomationEvent } from "./automation.js";
import { RibbitEvent } from "./event.js";
import { addressableParams } from "./param.js";

// Whole-session (de)serialization, plus the diff-and-ramp reconciler /recall
// uses. Three entry points:
//
// - snapshotSession(ribbit)/sessionToJSON(ribbit) — pure, JSON-serializable
//   snapshots of everything live: clock/harmony, master/buses/tracks (each
//   with their own gain/pan/inserts/sends), modulators, and patches. Every
//   rampable value goes through RibbitParam.get() (already the user-facing,
//   decoded value — see param.js), and every constructible object (synth/
//   processor/modulator) is tagged with the registry key that built it
//   (`.type`, set by Ribbit.createSynth/createProcessor/createModulator) plus
//   whatever non-param constructor state it wants to round-trip
//   (`.getOptions()` — see synth.js/processor.js/modulator.js).
// - loadSession(ribbit, json) — hard rebuild: tears down every track/bus/
//   modulator/patch and every processor on master, then reconstructs from
//   scratch via the same ribbit.create*/addProcessor/addSend/createPatch calls
//   the console itself uses. This is the vehicle for a whole-session file
//   load — a cold-start operation, so there's no reason to make it glitch-
//   free the way /recall is.
// - applySnapshot(ribbit, snapshot, { startTime, durationSeconds }) — a diff
//   against the *live* session: matching objects (by name, and for
//   processors/modulators also by type) ramp their params in place; objects
//   only in the snapshot fade in (created now, gain/depth ramped up from 0);
//   objects only live fade out (ramped to 0) and are torn down once that
//   fade completes. This is what /recall uses, via ribbit.states (named
//   snapshots captured by /save — see commands.js).
//
// Reconstruction order matters in both loadSession and applySnapshot: buses
// and tracks (which can send to each other) before their own processors and
// sends are wired up, modulators after that, and patches last of all, since
// a patch resolves both endpoints by name against whatever already exists.

const SESSION_VERSION = 1;

function serializeParams(paramsMap) {
    const out = {};
    for (const [key, param] of Object.entries(paramsMap)) out[key] = param.get();
    return out;
};

// Loop-position automation, stored by param *name* with user-facing
// (decoded) from/to values — an RibbitAutomationEvent's own `target` is a raw
// AudioParam reference, which can't survive JSON. Only events carrying a
// `paramKey` (everything the console's automate= command creates — see
// commands.js) can round-trip; one built in code against a bare AudioParam
// is skipped. `_scheduled` isn't captured: a rebuilt `once` event fires once
// more after a load/recall, which is the least-surprising reading of
// "restore this state".
function serializeAutomation(object) {
    // addressableParams, not object.params: a track can automate its synth's
    // params too (see commands.js's automate=), and a saved session that
    // silently dropped exactly those would be the worst kind of data loss —
    // one you only notice on reload.
    const params = addressableParams(object);
    return object.automation
        .filter((event) => event.paramKey && params[event.paramKey])
        .map((event) => {
            const param = params[event.paramKey];
            return {
                param: event.paramKey,
                from: param.decode(event.from),
                to: param.decode(event.to),
                beat: event.beat,
                duration: event.duration,
                curve: event.curve,
                once: event.once,
            };
        });
};

// The inverse of serializeAutomation: re-resolves each entry's param by name
// on the (possibly freshly-constructed) object and re-encodes its values.
// An entry naming a param the object no longer has is dropped silently —
// same forgiving shape param application below already has.
function rebuildAutomation(object, list = []) {
    const params = addressableParams(object);
    return list
        .map((data) => {
            const param = params[data.param];
            if (!param) return null;
            return new RibbitAutomationEvent({
                beat: data.beat,
                duration: data.duration,
                target: param.audioParam,
                from: param.encode(data.from),
                to: param.encode(data.to),
                curve: data.curve,
                once: data.once,
                paramKey: data.param,
            });
        })
        .filter(Boolean);
};

// Applies a saved options block ({ key: value } from getOptions()) onto a
// live object's declarative `options` map — used when /recall matches an
// object in place (a fresh construction gets the block via its constructor
// instead). Skips unknown keys and swallows a per-key set() throw, so one
// stale option can't abort the rest of a recall.
function applyOptionsSnapshot(object, optionsData = {}) {
    for (const [key, value] of Object.entries(optionsData)) {
        try {
            object.options?.[key]?.set(value);
        } catch {
            // a saved value the option no longer accepts — leave it as-is
        }
    }
};

function serializeProcessor(processor) {
    return {
        type: processor.type,
        name: processor.name,
        active: processor.active,
        options: processor.getOptions(),
        params: serializeParams(processor.params),
        automation: serializeAutomation(processor),
    };
};

function serializeModulator(modulator) {
    return {
        type: modulator.type,
        name: modulator.name,
        options: modulator.getOptions(),
        params: serializeParams(modulator.params),
        automation: serializeAutomation(modulator),
    };
};

function serializeSends(channel) {
    return channel.sends.map((send) => ({ destName: send.destName, gain: send.params.gain.get() }));
};

function serializeChannel(channel, { includeSends = true } = {}) {
    const data = {
        params: serializeParams(channel.params),
        processors: channel.processors.map(serializeProcessor),
        automation: serializeAutomation(channel),
    };
    if (includeSends) data.sends = serializeSends(channel);
    return data;
};

function serializeEvent(event) {
    return { beat: event.beat, pitch: event.pitch, degree: event.degree, velocity: event.velocity, duration: event.duration };
};

function serializeTrack(track) {
    return {
        name: track.name,
        active: track.source.active,
        ...serializeChannel(track),
        synth: {
            type: track.source.type,
            options: track.source.getOptions(),
            params: serializeParams(track.source.params),
            events: track.source.events.map(serializeEvent),
        },
    };
};

function serializeBus(bus) {
    return { name: bus.name, ...serializeChannel(bus) };
};

// An event patch (dest=<track>.notes — see RibbitEventPatch) has no `depth`,
// so this only includes it when present rather than assuming every patch is
// shaped like a regular RibbitPatch.
function serializePatch(patch) {
    const data = { sourceName: patch.sourceName, destName: patch.destName };
    if (patch.params.depth) data.depth = patch.params.depth.get();
    return data;
};

// The pure "everything live" snapshot shape shared by a whole-session save
// and one named /save state — see the module doc comment above.
export function snapshotSession(ribbit) {
    return {
        clock: { bpm: ribbit.clock.bpm, loopLengthBeats: ribbit.clock.loopLengthBeats },
        harmony: { root: ribbit.harmony.root, scale: [...ribbit.harmony.scale] },
        master: serializeChannel(ribbit.master, { includeSends: false }),
        buses: ribbit.buses.map(serializeBus),
        tracks: ribbit.tracks.map(serializeTrack),
        modulators: ribbit.modulators.map(serializeModulator),
        patches: ribbit.patches.map(serializePatch),
    };
};

// A session file's optional self-introduction, normalized to an array of
// lines. Authored either as an array (the readable way to write several lines
// in JSON, which has no multi-line string literal) or as one "\n"-joined
// string, since that's what a hand-edited or programmatically-produced file
// is likely to contain. Deliberately *not* part of snapshotSession: it
// describes the session as a document, so a /save'd state has no business
// carrying a copy of it.
function normalizeReadme(value) {
    if (value === undefined || value === null) return [];
    const lines = Array.isArray(value) ? value : String(value).split("\n");
    return lines.map((line) => String(line));
};

// The full session file shape: a snapshot, every named state /save has
// captured (so loading a session file also restores what you could /recall),
// and the readme, so a session downloaded with /save_json keeps whatever
// introduction it was opened with.
export function sessionToJSON(ribbit) {
    return {
        version: SESSION_VERSION,
        ...(ribbit.readme.length ? { readme: [...ribbit.readme] } : {}),
        ...snapshotSession(ribbit),
        states: { ...ribbit.states },
    };
};

function applyChannelParams(channel, data) {
    for (const [key, value] of Object.entries(data.params)) {
        channel.params[key]?.set(value);
    }
};

function loadProcessors(ribbit, channel, processorsData = []) {
    for (const data of processorsData) {
        const processor = ribbit.createProcessor(data.type, { name: data.name, ...data.options });
        channel.addProcessor(processor);
        processor.active = data.active;
        for (const [key, value] of Object.entries(data.params)) {
            processor.params[key]?.set(value);
        }
        processor.automation = rebuildAutomation(processor, data.automation);
    }
};

// Replaces whatever sends a freshly-created channel starts with (its default
// send to master) with the real saved list — called only once every track/
// bus this session might reference by name already exists.
function loadSends(ribbit, channel, sendsData = []) {
    for (const send of [...channel.sends]) channel.removeSend(send.id);
    for (const data of sendsData) {
        const destObject = ribbit._resolveObject(data.destName);
        if (destObject) channel.addSend(destObject, { destName: data.destName, gain: data.gain });
    }
};

// Tears down everything but master itself (and master's own speaker
// connection, which Ribbit's constructor owns, not session data) so
// loadSession always starts from the same clean slate regardless of what
// was live beforehand.
function clearSession(ribbit) {
    for (const track of [...ribbit.tracks]) ribbit.removeTrack(track);
    for (const bus of [...ribbit.buses]) ribbit.removeBus(bus);
    for (const modulator of [...ribbit.modulators]) ribbit.removeModulator(modulator);
    for (const processor of [...ribbit.master.processors]) ribbit.removeProcessor(processor);
    // Cleared here rather than only reassigned at the end of loadSession, so
    // loading a file with no readme doesn't leave the previous session's one
    // attached to it (and then serialize it back out on the next save).
    ribbit.readme = [];
};

// Checks every `.type` in a snapshot against the live registries BEFORE
// anything is built or torn down, and throws listing all of them at once.
//
// This exists because both rebuild paths are destructive and non-atomic: the
// create* calls are not individually guarded, so one dead type — the normal
// consequence of removing a shipped type, see docs/dev/removing-a-type.md —
// would otherwise throw halfway through and leave a graph that is neither
// the old session nor the new one. Failing before the first mutation means a
// bad file costs you nothing: whatever was playing keeps playing.
//
// Reporting every bad type at once rather than the first is deliberate too —
// a session file outside the repo can't be migrated by the engine, so
// hand-editing the JSON is the only recovery, and that's much easier with
// the full list than with one name per attempt.
function assertKnownTypes(ribbit, snapshot) {
    const problems = [];
    const check = (kind, known, type, where) => {
        if (type !== undefined && !known.includes(type)) {
            problems.push(`${where}: unknown ${kind} type "${type}"`);
        }
    };
    const checkProcessors = (list = [], where) => {
        for (const data of list) check("processor", ribbit.processorTypes, data.type, `${where} processor "${data.name}"`);
    };

    checkProcessors(snapshot.master?.processors, "master");
    for (const data of snapshot.buses ?? []) checkProcessors(data.processors, `bus "${data.name}"`);
    for (const data of snapshot.tracks ?? []) {
        check("synth", ribbit.synthTypes, data.synth?.type, `track "${data.name}"`);
        checkProcessors(data.processors, `track "${data.name}"`);
    }
    for (const data of snapshot.modulators ?? []) {
        check("modulator", ribbit.modulatorTypes, data.type, `modulator "${data.name}"`);
    }

    if (problems.length) {
        throw new Error(`session references ${problems.length} unknown type(s):\n  ${problems.join("\n  ")}`);
    }
};

// Hard-rebuilds the entire session from a JSON object shaped like
// sessionToJSON's output — see the module doc comment for why this (unlike
// applySnapshot) doesn't try to be glitch-free.
export function loadSession(ribbit, json) {
    if (json.version !== SESSION_VERSION) {
        throw new Error(`unsupported session version "${json.version}" (expected ${SESSION_VERSION})`);
    }
    assertKnownTypes(ribbit, json);

    clearSession(ribbit);

    ribbit.clock.setBpm(json.clock.bpm);
    ribbit.clock.setLoopLengthBeats(json.clock.loopLengthBeats);
    ribbit.harmony.root = json.harmony.root;
    ribbit.harmony.scale = [...json.harmony.scale];

    applyChannelParams(ribbit.master, json.master);
    loadProcessors(ribbit, ribbit.master, json.master.processors);
    ribbit.master.automation = rebuildAutomation(ribbit.master, json.master.automation);

    for (const data of json.buses ?? []) {
        const bus = ribbit.createBus({ name: data.name });
        applyChannelParams(bus, data);
        loadProcessors(ribbit, bus, data.processors);
        bus.automation = rebuildAutomation(bus, data.automation);
    }

    for (const data of json.tracks ?? []) {
        const track = ribbit.createTrack({ name: data.name, synth: data.synth.type, ...data.synth.options });
        track.source.active = data.active;
        applyChannelParams(track, data);
        loadProcessors(ribbit, track, data.processors);
        track.automation = rebuildAutomation(track, data.automation);
        for (const [key, value] of Object.entries(data.synth.params)) {
            track.source.params[key]?.set(value);
        }
        track.source.events = data.synth.events.map((event) => new RibbitEvent(event));
    }

    // Sends can point at any bus/track, including ones later in these lists,
    // so they're only wired up once every possible destination exists.
    for (const data of json.buses ?? []) {
        loadSends(ribbit, ribbit.buses.find((b) => b.name === data.name), data.sends);
    }
    for (const data of json.tracks ?? []) {
        loadSends(ribbit, ribbit.tracks.find((t) => t.name === data.name), data.sends);
    }

    for (const data of json.modulators ?? []) {
        const modulator = ribbit.createModulator(data.type, { name: data.name, ...data.options });
        for (const [key, value] of Object.entries(data.params)) {
            modulator.params[key]?.set(value);
        }
        modulator.automation = rebuildAutomation(modulator, data.automation);
    }

    for (const data of json.patches ?? []) {
        ribbit.createPatch({ sourceName: data.sourceName, destName: data.destName, depth: data.depth });
    }

    ribbit.states = { ...(json.states ?? {}) };

    // Printed last, once the graph it describes actually exists — and pushed
    // rather than returned, because the two ways in here differ: /load_session
    // has a command to report to, but /code-editor/<slug>'s auto-load never
    // had one. notify() is the channel that covers both (see Ribbit.notify).
    ribbit.readme = normalizeReadme(json.readme);
    if (ribbit.readme.length) ribbit.notify(ribbit.readme.join("\n"), "readme");
};

// --- applySnapshot: the diff-and-ramp reconciler behind /recall ---------

// Ramps (if durationSeconds > 0) or instantly sets (deferred to startTime
// either way) a single RibbitParam toward targetValue — the one place
// applySnapshot decides between scheduleRamp and setInstant, exactly the
// choice commands.js's applyParams makes for a console ramp.
function rampOrSet(ribbit, param, targetValue, { startTime, durationSeconds }) {
    const target = param.encode(param.clamp(targetValue));
    if (durationSeconds > 0) {
        scheduleRamp(ribbit.audioContext, param.audioParam, param.audioParam.value, target, durationSeconds, { startTime });
    } else {
        setInstant(ribbit.audioContext, param.audioParam, target, startTime);
    }
};

function applyParamsSnapshot(ribbit, paramsMap, targetValues = {}, opts) {
    for (const [key, value] of Object.entries(targetValues)) {
        const param = paramsMap[key];
        if (param) rampOrSet(ribbit, param, value, opts);
    }
};

// Reconciles one channel's insert chain against a target processor list:
// matched processors (same name+type) ramp their params in place and keep
// their identity; anything only in the target is created, anything only
// live is torn down, and the chain is rebuilt in the target's order — all
// three as one structural pass deferred to startTime, since none of that can
// ride native AudioParam scheduling. Matched params still ramp immediately
// (scheduling a future AudioParam value doesn't require the node to already
// be connected into the graph by the time it's scheduled, only by the time
// it fires — which the same deferred pass guarantees).
function reconcileProcessors(ribbit, channel, targetList, { startTime, durationSeconds }) {
    const key = (p) => `${p.type}:${p.name}`;
    const targetKeys = new Set(targetList.map(key));
    const toRemove = channel.processors.filter((p) => !targetKeys.has(key(p)));

    const finalOrder = targetList.map((data) => {
        let processor = channel.processors.find((p) => key(p) === `${data.type}:${data.name}`);
        if (!processor) processor = ribbit.createProcessor(data.type, { name: data.name, ...data.options });
        applyParamsSnapshot(ribbit, processor.params, data.params, { startTime, durationSeconds });
        return { processor, active: data.active, data };
    });

    scheduleAt(ribbit, startTime, () => {
        for (const processor of toRemove) ribbit.removeProcessor(processor);
        for (const processor of [...channel.processors]) channel.removeProcessor(processor.id);
        for (const { processor, active, data } of finalOrder) {
            processor.active = active;
            // A matched processor keeps its identity, so its saved options
            // (a reverb's IR duration) and automation don't arrive via the
            // constructor the way a freshly-created one's do — apply both
            // here, in the same structural pass. Harmless duplication for a
            // fresh processor (its constructor already consumed them).
            applyOptionsSnapshot(processor, data.options);
            processor.automation = rebuildAutomation(processor, data.automation);
            channel.addProcessor(processor);
        }
    });
};

// Sends are a secondary routing detail (not a direct sound source the way a
// channel's own gain is), so unlike processors/channels there's no fade
// choreography here — matched sends' gain still ramps, but add/remove is a
// plain structural swap at startTime.
function reconcileSends(ribbit, channel, targetList, { startTime }) {
    scheduleAt(ribbit, startTime, () => {
        const targetByName = new Map(targetList.map((s) => [s.destName, s]));
        for (const send of [...channel.sends]) {
            if (!targetByName.has(send.destName)) channel.removeSend(send.id);
        }
        for (const data of targetList) {
            const existing = channel.sends.find((send) => send.destName === data.destName);
            if (existing) existing.params.gain.set(data.gain);
            else {
                const destObject = ribbit._resolveObject(data.destName);
                if (destObject) channel.addSend(destObject, { destName: data.destName, gain: data.gain });
            }
        }
    });
};

function reconcileMaster(ribbit, data, opts) {
    applyParamsSnapshot(ribbit, ribbit.master.params, data.params, opts);
    reconcileProcessors(ribbit, ribbit.master, data.processors ?? [], opts);
    scheduleAt(ribbit, opts.startTime, () => {
        ribbit.master.automation = rebuildAutomation(ribbit.master, data.automation);
    });
};

// Reconciles a named list of channels (tracks or buses) against a target
// snapshot list: matched channels (by name) ramp gain/pan/processors/sends
// in place; a channel only in the target is created now and its gain
// ramped up from 0 (a fade-in); a channel only live has its gain ramped
// down to 0 and is torn down once that fade completes (a fade-out) rather
// than cut instantly. `onMatch`/create are the one bit that differs between
// a track (which also needs its synth's type/params/events/active handled)
// and a bare bus.
function reconcileChannelList(ribbit, live, targetList, { create, remove, onMatch }, opts) {
    const targetByName = new Map(targetList.map((data) => [data.name, data]));

    for (const channel of [...live]) {
        const data = targetByName.get(channel.name);
        if (!data) {
            rampOrSet(ribbit, channel.params.gain, 0, opts);
            scheduleAt(ribbit, opts.startTime + opts.durationSeconds, () => remove(channel));
            continue;
        }

        const { gain: _gain, ...restParams } = data.params;
        applyParamsSnapshot(ribbit, channel.params, restParams, opts);
        rampOrSet(ribbit, channel.params.gain, data.params.gain, opts);
        reconcileProcessors(ribbit, channel, data.processors ?? [], opts);
        if (data.sends) reconcileSends(ribbit, channel, data.sends, opts);
        scheduleAt(ribbit, opts.startTime, () => {
            channel.automation = rebuildAutomation(channel, data.automation);
        });
        onMatch?.(channel, data, opts);
    }

    for (const data of targetList) {
        if (live.some((c) => c.name === data.name)) continue;
        scheduleAt(ribbit, opts.startTime, () => {
            const channel = create(data);
            const instantOpts = { startTime: opts.startTime, durationSeconds: 0 };
            const { gain: targetGain, ...restParams } = data.params;

            channel.params.gain.set(0);
            applyParamsSnapshot(ribbit, channel.params, restParams, instantOpts);
            reconcileProcessors(ribbit, channel, data.processors ?? [], instantOpts);
            if (data.sends) reconcileSends(ribbit, channel, data.sends, instantOpts);
            channel.automation = rebuildAutomation(channel, data.automation);
            rampOrSet(ribbit, channel.params.gain, targetGain, opts);
            onMatch?.(channel, data, instantOpts);
        });
    }
};

function reconcileModulators(ribbit, targetList, opts) {
    const targetByName = new Map(targetList.map((data) => [data.name, data]));

    for (const modulator of [...ribbit.modulators]) {
        const data = targetByName.get(modulator.name);
        if (!data) {
            scheduleAt(ribbit, opts.startTime + opts.durationSeconds, () => ribbit.removeModulator(modulator));
        } else {
            applyParamsSnapshot(ribbit, modulator.params, data.params, opts);
            scheduleAt(ribbit, opts.startTime, () => {
                applyOptionsSnapshot(modulator, data.options);
                modulator.automation = rebuildAutomation(modulator, data.automation);
            });
        }
    }

    for (const data of targetList) {
        if (ribbit.modulators.some((m) => m.name === data.name)) continue;
        scheduleAt(ribbit, opts.startTime, () => {
            const modulator = ribbit.createModulator(data.type, { name: data.name, ...data.options });
            applyParamsSnapshot(ribbit, modulator.params, data.params, { startTime: opts.startTime, durationSeconds: 0 });
            modulator.automation = rebuildAutomation(modulator, data.automation);
        });
    }
};

// Patches don't have their own name, just a (sourceName, destName) pair —
// used as the matching key. A patch whose endpoint is also disappearing
// this same reconcile (a removed track/bus/modulator/processor) gets
// cascade-removed by that object's own removeTrack/removeBus/
// removeModulator/removeProcessor call, same as it would from the console —
// this function only needs to handle a patch appearing/disappearing on its
// own, both endpoints staying put.
function reconcilePatches(ribbit, targetList, opts) {
    const key = (p) => `${p.sourceName}→${p.destName}`;
    const targetByKey = new Map(targetList.map((data) => [key(data), data]));

    for (const patch of [...ribbit.patches]) {
        const data = targetByKey.get(key(patch));
        if (!data) {
            // An event patch (no depth) has nothing to fade — it's removed
            // outright once the fade window elapses, same timing either way.
            if (patch.params.depth) rampOrSet(ribbit, patch.params.depth, 0, opts);
            scheduleAt(ribbit, opts.startTime + opts.durationSeconds, () => ribbit.removePatch(patch));
        } else if (patch.params.depth) {
            rampOrSet(ribbit, patch.params.depth, data.depth, opts);
        }
    }

    for (const data of targetList) {
        if (ribbit.patches.some((p) => key(p) === key(data))) continue;
        scheduleAt(ribbit, opts.startTime, () => {
            const patch = ribbit.createPatch({ sourceName: data.sourceName, destName: data.destName, depth: 0 });
            if (patch.params.depth) rampOrSet(ribbit, patch.params.depth, data.depth, opts);
        });
    }
};

// Reconciles the live session toward `snapshot` (shaped like
// snapshotSession's output) without a hard cut: matching objects ramp,
// appearing objects fade in, disappearing objects fade out then get torn
// down — see the module doc comment and reconcileChannelList above for the
// fade choreography. `startTime` defaults to right now; `durationSeconds`
// (default 0) is how long every ramp/fade takes — 0 means every change is
// still deferred to `startTime` but happens as an instant jump, not a ramp.
export function applySnapshot(ribbit, snapshot, { startTime, durationSeconds = 0 } = {}) {
    // Same guard loadSession makes, and for a sharper reason: almost every
    // create* call below runs inside a deferred scheduleAt callback, so an
    // unknown type here wouldn't just half-apply the snapshot — it would
    // throw out of a bare timer, long after /recall returned "ok", with
    // nothing left to catch it.
    assertKnownTypes(ribbit, snapshot);

    const t0 = startTime ?? ribbit.audioContext.currentTime;
    const opts = { startTime: t0, durationSeconds };

    if (snapshot.clock) {
        if (durationSeconds > 0 && snapshot.clock.bpm !== ribbit.clock.bpm) {
            ribbit.clock.rampBpm(snapshot.clock.bpm, durationSeconds, { startTime: t0 });
        } else {
            scheduleAt(ribbit, t0, () => ribbit.clock.setBpm(snapshot.clock.bpm));
        }
        scheduleAt(ribbit, t0, () => ribbit.clock.setLoopLengthBeats(snapshot.clock.loopLengthBeats));
    }

    if (snapshot.harmony) {
        scheduleAt(ribbit, t0, () => {
            ribbit.harmony.root = snapshot.harmony.root;
            ribbit.harmony.scale = [...snapshot.harmony.scale];
        });
    }

    if (snapshot.master) reconcileMaster(ribbit, snapshot.master, opts);

    reconcileChannelList(ribbit, ribbit.buses, snapshot.buses ?? [], {
        create: (data) => ribbit.createBus({ name: data.name }),
        remove: (bus) => ribbit.removeBus(bus),
    }, opts);

    reconcileChannelList(ribbit, ribbit.tracks, snapshot.tracks ?? [], {
        create: (data) => ribbit.createTrack({ name: data.name, synth: data.synth.type, ...data.synth.options }),
        remove: (track) => ribbit.removeTrack(track),
        onMatch: (track, data, matchOpts) => {
            // Ramping synth params only makes sense when the synth the
            // snapshot describes is the one that's live — if the type
            // changed since the save (/lead synth=sampler after saving it
            // as an oscsynth), the whole synth is swapped back in the
            // deferred block below instead, params applied to the fresh
            // instance there.
            const typeMatches = track.source.type === data.synth.type;
            if (typeMatches) {
                for (const [key, value] of Object.entries(data.synth.params)) {
                    if (track.source.params[key]) rampOrSet(ribbit, track.source.params[key], value, matchOpts);
                }
            }
            // Param ramps above ride native AudioParam scheduling, but a
            // synth swap and an events/active/options change are plain JS
            // mutations the clock reads on its next tick — left immediate,
            // a /recall ... at=cycle would switch patterns the moment Enter
            // is pressed while everything else correctly waits for the
            // boundary. Same setTimeout compromise every other structural
            // change here makes.
            scheduleAt(ribbit, matchOpts.startTime, () => {
                if (!typeMatches) {
                    ribbit.setTrackSynth(track, data.synth.type, data.synth.options);
                    for (const [key, value] of Object.entries(data.synth.params)) {
                        track.source.params[key]?.set(value);
                    }
                } else {
                    applyOptionsSnapshot(track.source, data.synth.options);
                }
                track.source.active = data.active;
                track.source.events = data.synth.events.map((event) => new RibbitEvent(event));
            });
        },
    }, opts);

    reconcileModulators(ribbit, snapshot.modulators ?? [], opts);
    reconcilePatches(ribbit, snapshot.patches ?? [], opts);
};
