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

// Which params the bulk `/<object> random` command currently skips because
// their `.r` flag is off (see RibbitParam.randomizable and commands.js).
// Rides alongside `params` as a sibling key rather than inside it, so the
// existing `{ key: value }` param shape — read by every load path, and by
// every session file already written — stays exactly as it was.
//
// Records the *whole* excluded set, including whatever a class ships with
// off by default (a channel's gain), not just what the user changed: that
// makes restoring a plain assignment instead of a diff against defaults this
// module would otherwise have to know. Omitted entirely when nothing is
// excluded.
function serializeNoRandom(paramsMap) {
    const excluded = Object.keys(paramsMap).filter((key) => !paramsMap[key].randomizable);
    return excluded.length ? { no_random: excluded } : {};
};

// The inverse. Only does anything when the key is actually present — a
// session file written before this existed has no `no_random`, and reading
// its absence as "nothing is excluded" would quietly switch the defaults on
// for every object in it.
function applyNoRandom(paramsMap, list) {
    if (!list) return;
    for (const [key, param] of Object.entries(paramsMap)) param.randomizable = !list.includes(key);
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
        ...serializeNoRandom(processor.params),
        automation: serializeAutomation(processor),
    };
};

function serializeModulator(modulator) {
    return {
        type: modulator.type,
        name: modulator.name,
        options: modulator.getOptions(),
        params: serializeParams(modulator.params),
        ...serializeNoRandom(modulator.params),
        automation: serializeAutomation(modulator),
    };
};

function serializeSends(channel) {
    return channel.sends.map((send) => ({ destName: send.destName, gain: send.params.gain.get() }));
};

function serializeChannel(channel, { includeSends = true } = {}) {
    const data = {
        params: serializeParams(channel.params),
        ...serializeNoRandom(channel.params),
        // Both written only when true, so a session with nothing muted or
        // soloed serializes exactly as it did before these existed — the
        // same "omit the default" rule no_random follows. `_soloSilenced`
        // is deliberately absent: it's derived from everyone else's `soloed`
        // (see Ribbit.updateSolo) and recomputed on load.
        ...(channel.muted ? { muted: true } : {}),
        ...(channel.soloed ? { soloed: true } : {}),
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
            ...serializeNoRandom(track.source.params),
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
        // Omitted when there are none, so a session that predates groups
        // round-trips byte-identically (same rule as `muted` above).
        ...(ribbit.groups.length
            ? { groups: ribbit.groups.map((group) => ({ name: group.name, members: [...group.members] })) }
            : {}),
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
    applyNoRandom(channel.params, data.no_random);
    applyChannelState(channel, data);
};

// Mute/solo, restored from a session or a /save'd state. Absent keys mean
// false — a file written before these existed described a session where
// nothing was muted, which is exactly what that reads as. setSoloed
// re-derives the whole session's solo state each time (see
// Ribbit.updateSolo), so the last channel restored leaves it correct however
// many were soloed.
function applyChannelState(channel, data) {
    channel.setMuted(!!data.muted);
    channel.setSoloed(!!data.soloed);
};

function loadProcessors(ribbit, channel, processorsData = [], rename = () => {}) {
    for (const data of processorsData) {
        const processor = ribbit.createProcessor(data.type, { name: data.name, ...data.options });
        rename(data.name, processor.name);
        channel.addProcessor(processor);
        processor.active = data.active;
        for (const [key, value] of Object.entries(data.params)) {
            processor.params[key]?.set(value);
        }
        applyNoRandom(processor.params, data.no_random);
        processor.automation = rebuildAutomation(processor, data.automation);
    }
};

// Replaces whatever sends a freshly-created channel starts with (its default
// send to master) with the real saved list — called only once every track/
// bus this session might reference by name already exists. `resolveName` maps
// a name as written in the file to the name that object actually got (see
// loadSession's rename map).
function loadSends(ribbit, channel, sendsData = [], resolveName = (name) => name) {
    for (const send of [...channel.sends]) channel.removeSend(send.id);
    for (const data of sendsData) {
        const destName = resolveName(data.destName);
        const destObject = ribbit._resolveObject(destName);
        if (destObject) channel.addSend(destObject, { destName, gain: data.gain });
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
    // Groups own nothing, so there's nothing to tear down — but a stale one
    // would survive the load and then name objects from the previous session.
    ribbit.groups = [];
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

    // Every object whose requested name wasn't available, mapped to the name
    // it actually got. Ribbit._uniqueName silently de-duplicates past a
    // collision — with another object in the same file, or with a reserved
    // top-level command name (a track called "states") — and *everything*
    // below that refers to an object by name (a send's destination, a patch's
    // two endpoints) is written in terms of the name in the file. Without
    // this map, the first such reference finds nothing and the load stops
    // half-applied, which is how a session with one badly-named track used to
    // lose all of its modulators and patches.
    const renames = new Map();
    const rename = (wanted, actual) => { if (wanted !== actual) renames.set(wanted, actual); };
    const resolveName = (name) => renames.get(name) ?? name;
    // The object part of a patch destination ("reverb.wet", "lead.notes") is
    // a name too; the param/".notes" half never is.
    const resolveDestName = (destName) => {
        const dot = String(destName).indexOf(".");
        if (dot === -1) return destName;
        return `${resolveName(destName.slice(0, dot))}${destName.slice(dot)}`;
    };

    applyChannelParams(ribbit.master, json.master);
    loadProcessors(ribbit, ribbit.master, json.master.processors, rename);
    ribbit.master.automation = rebuildAutomation(ribbit.master, json.master.automation);

    for (const data of json.buses ?? []) {
        const bus = ribbit.createBus({ name: data.name });
        rename(data.name, bus.name);
        applyChannelParams(bus, data);
        loadProcessors(ribbit, bus, data.processors, rename);
        bus.automation = rebuildAutomation(bus, data.automation);
    }

    for (const data of json.tracks ?? []) {
        const track = ribbit.createTrack({ name: data.name, synth: data.synth.type, ...data.synth.options });
        rename(data.name, track.name);
        track.source.active = data.active;
        applyChannelParams(track, data);
        loadProcessors(ribbit, track, data.processors);
        track.automation = rebuildAutomation(track, data.automation);
        for (const [key, value] of Object.entries(data.synth.params)) {
            track.source.params[key]?.set(value);
        }
        applyNoRandom(track.source.params, data.synth.no_random);
        track.source.events = data.synth.events.map((event) => new RibbitEvent(event));
    }

    // Sends can point at any bus/track, including ones later in these lists,
    // so they're only wired up once every possible destination exists.
    for (const data of json.buses ?? []) {
        loadSends(ribbit, ribbit.buses.find((b) => b.name === resolveName(data.name)), data.sends, resolveName);
    }
    for (const data of json.tracks ?? []) {
        loadSends(ribbit, ribbit.tracks.find((t) => t.name === resolveName(data.name)), data.sends, resolveName);
    }

    for (const data of json.modulators ?? []) {
        const modulator = ribbit.createModulator(data.type, { name: data.name, ...data.options });
        rename(data.name, modulator.name);
        for (const [key, value] of Object.entries(data.params)) {
            modulator.params[key]?.set(value);
        }
        applyNoRandom(modulator.params, data.no_random);
        modulator.automation = rebuildAutomation(modulator, data.automation);
    }

    for (const data of json.patches ?? []) {
        ribbit.createPatch({
            sourceName: resolveName(data.sourceName),
            destName: resolveDestName(data.destName),
            depth: data.depth,
        });
    }

    // Last, and by name: a group's members can be anything above (including
    // another group), so this is the only point at which every name it might
    // hold is guaranteed to have been created — and to have been renamed, if
    // it was going to be.
    for (const data of json.groups ?? []) {
        ribbit.createGroup({ name: data.name, members: (data.members ?? []).map(resolveName) });
    }

    ribbit.states = { ...(json.states ?? {}) };

    // Said out loud rather than silently absorbed: the file no longer
    // describes what's live, so a /save_json writes different names back out,
    // and any /save'd state inside it still refers to the old ones (those are
    // whole nested snapshots — reconciled by name at /recall time, not
    // rewritten here). Renaming the object in the file is the real fix.
    if (renames.size) {
        const list = [...renames].map(([wanted, actual]) => `"${wanted}" -> ${actual}`).join(", ");
        ribbit.notify(`renamed on load (name already taken): ${list}. Saved states in this file still refer to the original names.`);
    }

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

// `noRandom` rides along here rather than getting its own pass at each call
// site: every reconcile below already calls this with the right params map
// and the snapshot chunk the flags live in. Applied immediately, not deferred
// to startTime like the values around it — a `.r` flag isn't audible, so
// there's no boundary for it to land on and nothing a ramp could mean.
function applyParamsSnapshot(ribbit, paramsMap, targetValues = {}, opts, noRandom) {
    applyNoRandom(paramsMap, noRandom);
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
        applyParamsSnapshot(ribbit, processor.params, data.params, { startTime, durationSeconds }, data.no_random);
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
    applyParamsSnapshot(ribbit, ribbit.master.params, data.params, opts, data.no_random);
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
        applyParamsSnapshot(ribbit, channel.params, restParams, opts, data.no_random);
        rampOrSet(ribbit, channel.params.gain, data.params.gain, opts);
        reconcileProcessors(ribbit, channel, data.processors ?? [], opts);
        if (data.sends) reconcileSends(ribbit, channel, data.sends, opts);
        scheduleAt(ribbit, opts.startTime, () => {
            channel.automation = rebuildAutomation(channel, data.automation);
            // Deferred to the boundary with the structural changes rather
            // than ramped with the values: mute is already its own 10ms fade
            // (see RibbitChannel), and a *slow* mute is a fade, which is what
            // the gain ramp beside it is for.
            applyChannelState(channel, data);
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
            applyParamsSnapshot(ribbit, channel.params, restParams, instantOpts, data.no_random);
            reconcileProcessors(ribbit, channel, data.processors ?? [], instantOpts);
            if (data.sends) reconcileSends(ribbit, channel, data.sends, instantOpts);
            channel.automation = rebuildAutomation(channel, data.automation);
            applyChannelState(channel, data);
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
            applyParamsSnapshot(ribbit, modulator.params, data.params, opts, data.no_random);
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
            applyParamsSnapshot(ribbit, modulator.params, data.params, { startTime: opts.startTime, durationSeconds: 0 }, data.no_random);
            modulator.automation = rebuildAutomation(modulator, data.automation);
        });
    }
};

// Groups hold no audio, so there is no fade choreography here and no reason
// to stagger anything: the whole membership picture is swapped at startTime.
// Matched by name, like channels and modulators. A group whose members were
// edited live and then /recall'd goes back to the saved membership, which is
// the same reading of "restore this state" everything else here takes.
function reconcileGroups(ribbit, targetList, { startTime }) {
    scheduleAt(ribbit, startTime, () => {
        const targetByName = new Map(targetList.map((data) => [data.name, data]));
        for (const group of [...ribbit.groups]) {
            const data = targetByName.get(group.name);
            if (data) group.setMembers(data.members ?? []);
            else ribbit.removeGroup(group);
        }
        for (const data of targetList) {
            if (ribbit.groups.some((g) => g.name === data.name)) continue;
            ribbit.createGroup({ name: data.name, members: data.members ?? [] });
        }
    });
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
                applyNoRandom(track.source.params, data.synth.no_random);
                track.source.active = data.active;
                track.source.events = data.synth.events.map((event) => new RibbitEvent(event));
            });
        },
    }, opts);

    reconcileModulators(ribbit, snapshot.modulators ?? [], opts);
    reconcilePatches(ribbit, snapshot.patches ?? [], opts);
    reconcileGroups(ribbit, snapshot.groups ?? [], opts);
};
