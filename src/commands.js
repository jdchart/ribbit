import { scheduleRamp, setInstant, scheduleAt, RibbitAutomationEvent } from "./automation.js";
import { RibbitEvent } from "./event.js";
import { parseDegreeList } from "./harmony.js";
import { RESERVED_NAMES } from "./ribbit.js";
import { snapshotSession, sessionToJSON, loadSession, applySnapshot } from "./session.js";

// Coerces a raw parsed token into a number, boolean, or (quote-stripped)
// string. Falls through to the raw string for anything else (e.g. a bare
// type name like `sampler` in `synth=sampler`).
function parseValue(raw) {
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (raw === "true") return true;
    if (raw === "false") return false;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        return raw.slice(1, -1);
    }
    return raw;
};

// Turns a bare "3" or "4b" trailing a param's value into { amount, unit }:
// no suffix means seconds, a "b" suffix means beats.
function parseDuration(raw) {
    const match = raw.match(/^(\d+(?:\.\d+)?)(b)?$/);
    return { amount: Number(match[1]), unit: match[2] ? "beats" : "seconds" };
};

// Shared by pairPattern (a key's "=value") and POSITIONAL_VALUE_PATTERN (a
// bare leading value with no key) below, so the two grammars can't drift.
const QUOTED_OR_BARE_VALUE = `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\S*`;
const TRAILING_DURATION = `\\d+(?:\\.\\d+)?b?`;

// A leading value with no "key=" prefix, e.g. the "1" in "/save 1" or the
// "1 4b" in "/recall 1 4b at=cycle" — same value/duration shape a key's
// "=value" gets, just anchored to the very start of argsText instead of
// nested after "key=". Only opted into by commands whose one meaningful
// param has no other bare-flag-shaped param to collide with (save/recall's
// name=) — see parseCommand.
const POSITIONAL_VALUE_PATTERN = new RegExp(`^(${QUOTED_OR_BARE_VALUE})(?:\\s+(${TRAILING_DURATION})(?=\\s|$))?`);

// Commands where a bare leading token (no "key=") is shorthand for their one
// meaningful param, so "/save 1" works as well as "/save name=1".
const POSITIONAL_NAME_COMMANDS = new Set(["save", "recall"]);

// Parses "/name" or "/name param=val param2=val2" into { name, params }.
// Values are bare (no spaces) or quoted (may contain spaces): param="foo bar".
// Whitespace around "=" is optional: "param = val" and "param =val" both work.
// A value may be followed by a bare duration token (e.g. "gain=0 3" or
// "gain=0 4b") to mean "ramp to this value over 3 seconds / 4 beats" instead
// of setting it instantly — see commands that opt into ramping (isRamp()).
// Such params parse to { value, duration, unit } instead of a plain scalar.
export function parseCommand(text) {
    const match = text.trim().match(/^\/([a-zA-Z_]\w*)(?:\s+([\s\S]*))?$/);
    if (!match) {
        throw new Error(`invalid command syntax: "${text}"`);
    }

    const [, name, argsTextRaw] = match;
    const params = {};
    let argsText = argsTextRaw;

    // A bare leading token with no "=" in it is otherwise indistinguishable
    // from a boolean flag (see below) — only consumed as the positional
    // value for commands that opted in, and only when it isn't itself a
    // "key=value" pair (so "/save name=1" still parses normally).
    if (argsText && POSITIONAL_NAME_COMMANDS.has(name)) {
        const positional = argsText.match(POSITIONAL_VALUE_PATTERN);
        if (positional && positional[1] && !positional[1].includes("=")) {
            const [full, rawValue, rawDuration] = positional;
            if (rawDuration !== undefined) {
                const { amount, unit } = parseDuration(rawDuration);
                params.name = { value: parseValue(rawValue), duration: amount, unit };
            } else {
                params.name = parseValue(rawValue);
            }
            argsText = argsText.slice(full.length);
        }
    }

    if (argsText) {
        // A bare token with no "=" (e.g. "help") is a boolean flag: params.help = true.
        // The duration group only applies inside an "=value" match (nested in
        // that group), so a bare flag can never swallow a following number.
        const pairPattern = new RegExp(`([a-zA-Z_]\\w*)(?:\\s*=\\s*(${QUOTED_OR_BARE_VALUE})(?:\\s+(${TRAILING_DURATION})(?=\\s|$))?)?`, "g");
        let cursor = 0;
        let pair;
        while ((pair = pairPattern.exec(argsText))) {
            if (argsText.slice(cursor, pair.index).trim()) {
                throw new Error(`invalid parameter near "${argsText.slice(cursor, pair.index).trim()}" in /${name} ...`);
            }
            const [, key, rawValue, rawDuration] = pair;
            if (rawValue === undefined) {
                params[key] = true;
            } else if (rawValue === "") {
                // "gain=" with nothing after it would otherwise parse to the
                // empty string, which Number("") silently coerces to 0 —
                // /track_1 gain= muting the track is a footgun, not a
                // feature. An explicitly-quoted empty string ("" / '') still
                // parses, since its raw token isn't empty.
                throw new Error(`missing value for "${key}=" in /${name} ...`);
            } else if (rawDuration !== undefined) {
                const { amount, unit } = parseDuration(rawDuration);
                params[key] = { value: parseValue(rawValue), duration: amount, unit };
            } else {
                params[key] = parseValue(rawValue);
            }
            cursor = pairPattern.lastIndex;
        }
        if (argsText.slice(cursor).trim()) {
            throw new Error(`invalid parameter near "${argsText.slice(cursor).trim()}" in /${name} ...`);
        }
    }

    return { name, params };
};

// True for a parsed param carrying a ramp duration (see parseCommand).
function isRamp(value) {
    return typeof value === "object" && value !== null && "duration" in value;
};

// Converts a ramp spec's duration to seconds, resolving a "beats" unit
// against the clock's current tempo.
function rampSeconds(clock, spec) {
    return spec.unit === "beats" ? spec.duration * clock.secondsPerBeat : spec.duration;
};

// Resolves a command's "at=" scheduling hint into an absolute AudioContext
// startTime for scheduleRamp: "beat" anchors to the next beat boundary,
// "cycle" to the next loop boundary, and omitting it means "right now"
// (startTime undefined, which scheduleRamp itself defaults to currentTime).
// An unrecognized value falls back to "right now" with a warning to surface.
function resolveStartTime(clock, at) {
    if (at === "beat") return { startTime: clock.nextBeatTime(), label: "next beat" };
    if (at === "cycle") return { startTime: clock.nextCycleTime(), label: "next cycle" };
    if (at !== undefined) return { warning: `unknown at="${at}" (expected "beat" or "cycle"), starting now` };
    return {};
};

// Runs `fn` now, or defers it to `startTime` — the non-AudioParam counterpart
// to applyParams' ramp/setInstant branching, and the one place that knows how
// to defer anything that isn't a param.
//
// The point is that at=beat|cycle is a property of *when a command takes
// effect*, not of whether the thing being changed happens to be rampable.
// Most of what a live-coding session actually does mid-performance is
// discrete — reseed a generator, swap a waveform, mute a track, drop in a
// patch — and all of it wants to land on a boundary rather than wherever the
// keystroke fell. Before this, only AudioParam-backed values could be
// deferred and every other command silently ignored an at= it was given,
// which is the worst of the three options (honoring it, refusing it, or
// pretending).
//
// `fn` returns the "it happened" message. Deferred, that message can't be the
// command's return value (the command returned long ago), so it goes to
// ribbit.notify() when the work fires, and the caller's `pending` text — "it
// will happen" — is returned instead. Anything that can fail must therefore
// be validated *before* the defer, not inside it: a throw from a bare timer
// has no command left to attach itself to. That's the same lesson
// assertKnownTypes encoded for applySnapshot; here the try/catch turns a
// late failure into a console line rather than an unhandled rejection.
function runAt(ribbit, { startTime, label }, pending, fn) {
    if (startTime === undefined) return fn();
    scheduleAt(ribbit, startTime, () => {
        try {
            const message = fn();
            if (message) ribbit.notify(message);
        } catch (error) {
            ribbit.notify(`${pending} (${label}) failed: ${error.message}`);
        }
    });
    return `${pending} (${label})`;
};

// Converts a user-supplied value to a finite number, throwing (rather than
// silently producing NaN) so a bad command surfaces as an error via run()'s
// catch and never corrupts persistent engine state (e.g. clock.bpm sticking
// at NaN forever, poisoning every future beat calculation).
function toNumber(raw, label) {
    const num = Number(raw);
    if (!Number.isFinite(num)) {
        throw new Error(`invalid number for ${label}: "${raw}"`);
    }
    return num;
};

// Triggers a browser download of `json` as a timestamped .json file — the
// vehicle for /save_session (see docs/dev/architecture.md's "one Ribbit
// instance per page, created client-side": this module already only ever
// runs in-browser, so reaching for `document`/Blob here is consistent with
// that, not a new layering assumption).
function downloadJSON(json, filenamePrefix) {
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filenamePrefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
};

// Opens a native file picker and resolves with the parsed JSON of whatever
// file was chosen — the vehicle for /load_session. Resolves to null if the
// picker is dismissed with no file chosen (never rejects for that case, only
// for a read/parse failure once a file was actually picked).
function pickJSONFile() {
    return new Promise((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json";
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) {
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(await file.text()));
            } catch (error) {
                reject(error);
            }
        };
        input.click();
    });
};

function formatValue(value) {
    return typeof value === "number" ? value.toFixed(3) : String(value);
};

// The same job for an *option* rather than a param. Options are discrete
// settings, not points on a continuous range, so a whole number prints bare:
// "steps=16.000" implies 16.5 would be accepted, and a markovpercs seed comes
// out as "668580691.000". Params keep formatValue's fixed 3 decimals, where
// the trailing zeros correctly signal "this is continuous and rampable".
function formatOptionValue(value) {
    if (typeof value !== "number") return String(value);
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
};

// "key=value (range min..max)" for a help listing — the range is omitted
// when a param never declared bounds (e.g. a patch's depth, deliberately
// unclamped; see RibbitParam's -Infinity/Infinity defaults), since printing
// "-Infinity..Infinity" would just be noise.
function formatParamLine(key, param) {
    const hasRange = Number.isFinite(param.min) || Number.isFinite(param.max);
    const range = hasRange ? ` (range ${param.min}..${param.max})` : "";
    return `  ${key}=${formatValue(param.get())}${range}`;
};

// The options counterpart to formatParamLine — a choices-carrying option
// (waveform) lists them; anything else just notes it can't be ramped, the
// one behavioral difference from a param a reader needs to know. It can
// still be deferred with at= (see applyOptions), so the note is specifically
// "not rampable" rather than the broader "not schedulable" it used to imply.
function formatOptionLine(key, option) {
    const note = option.choices ? ` (choices: ${option.choices.join(", ")})` : " (not rampable, but at= works)";
    return `  ${key}=${formatOptionValue(option.get())}${note}`;
};

// The one place that knows how to get/set/ramp/defer a param (an RibbitParam —
// see param.js) against a parsed command value. Shared by channelCommand
// (gain/pan), paramObjectCommand (every processor/modulator param), and the
// /patch command (depth) — previously each of these had its own hand-rolled
// copy of this ramp/instant/at= branching, which is exactly the kind of
// duplication that lets one of them quietly fall out of sync with the rest.
// `paramsMap` is whatever `.params` the target object exposes; `input` is the
// full parsed command params (not just the rampable ones) — anything in
// `input` that isn't a key of `paramsMap` is either reported as unknown
// (`reportUnknown: true`, the default — appropriate when paramsMap is an
// object's *entire* param surface, e.g. a processor/modulator) or silently
// left alone for the caller's own handling (`reportUnknown: false` — e.g.
// channelCommand, which has plenty of other non-param keys like add_event).
function applyParams(ribbit, paramsMap, input, { startTime, label }, { reportUnknown = true } = {}) {
    const results = [];
    for (const [key, spec] of Object.entries(input)) {
        if (key === "at") continue;
        const param = paramsMap[key];
        if (!param) {
            if (reportUnknown) results.push(`unknown param "${key}"`);
            continue;
        }

        if (isRamp(spec)) {
            const target = param.clamp(toNumber(spec.value, key));
            const seconds = rampSeconds(ribbit.clock, spec);
            scheduleRamp(ribbit.audioContext, param.audioParam, param.audioParam.value, param.encode(target), seconds, { startTime });
            results.push(`${key} ramping to ${formatValue(target)} over ${seconds.toFixed(2)}s${label ? ` (${label})` : ""}`);
        } else {
            const target = param.clamp(toNumber(spec, key));
            if (startTime !== undefined) {
                // Same raw-AudioParam route the ramp branch uses, so a plain
                // set can also be deferred to at=beat/at=cycle.
                setInstant(ribbit.audioContext, param.audioParam, param.encode(target), startTime);
                results.push(`${key}=${formatValue(target)} (${label})`);
            } else {
                param.set(target);
                results.push(`${key}=${formatValue(target)}`);
            }
        }
    }
    return results;
};

// The options counterpart to applyParams: applies every key of `input` that
// names one of `object.options` (the declarative non-rampable settings a
// synth/processor/modulator exposes — see RibbitSynth.options).
//
// An option can't be *ramped* — there's no AudioParam to draw a curve on, and
// a half-applied waveform means nothing — so a ramp spec is still rejected
// per-key. But it can be *deferred*: `/rhy seed=20 at=cycle` reseeds on the
// next loop boundary, `/lead waveform=square at=beat` switches on the beat.
// Ramping and scheduling are independent questions, and options only ever
// failed the first one. (They used to silently drop at= altogether, since
// "at" simply isn't a key of any object's options map.)
//
// `exclude` holds keys currently claimed by a composite command in the same
// input (automate='s from/to/beat/duration, add_event's fields) so e.g.
// /reverb automate=wet to=1 duration=2 ramps wet over 2 beats rather than
// ALSO rebuilding the impulse response with a 2-second duration. A
// `choices`-carrying option validates against that list here, one place,
// rather than per-class — and, importantly, *before* runAt, so a bad choice
// is still a normal command error even when deferred.
function applyOptions(ribbit, object, input, timing, exclude = new Set()) {
    const results = [];
    for (const [key, spec] of Object.entries(input)) {
        if (exclude.has(key)) continue;
        const option = object.options?.[key];
        if (!option) continue;

        if (isRamp(spec)) {
            results.push(`${key} can't be ramped (not an audio param) — use ${key}=<value>, optionally with at=beat|cycle`);
            continue;
        }
        if (option.choices && !option.choices.includes(spec)) {
            results.push(`invalid ${key} "${spec}" (expected ${option.choices.join(", ")})`);
            continue;
        }
        try {
            // The deferred echo has to quote the *requested* value: the
            // setter hasn't run yet, so there's no normalized option.get() to
            // report (a `samples=random` that resolves to a concrete kit only
            // knows which kit once it fires — hence the notify() on the way
            // back out of runAt).
            results.push(runAt(ribbit, timing, `${key}=${formatOptionValue(spec)}`, () => {
                option.set(spec);
                return `${key}=${formatOptionValue(option.get())}`;
            }));
        } catch (error) {
            results.push(error.message);
        }
    }
    return results;
};

// The add_event/automate composite commands claim generic keys (beat=,
// duration=, from=, to=, ...) that could otherwise collide with an object's
// own option names (RibbitReverb's duration) — this is the exclusion set
// applyOptions honors when one of those composites is present in the same
// input.
function compositeClaimedKeys(params) {
    const claimed = new Set();
    if (params.add_event) for (const key of ["beat", "pitch", "degree", "velocity", "duration"]) claimed.add(key);
    if ("automate" in params) for (const key of ["from", "to", "beat", "duration", "curve", "once"]) claimed.add(key);
    return claimed;
};

const AUTOMATION_CURVES = ["linear", "exponential", "target"];

// Builds and attaches one RibbitAutomationEvent from an automate= command —
// shared by channelCommand (gain/pan) and paramObjectCommand (any
// processor/modulator param), the same way applyParams is. `beat`/`duration`
// are in beats (loop-relative pattern position — this is the clock-driven,
// repeating kind of automation, distinct from a one-off console ramp like
// gain=0 3). from defaults to the param's current value; values are stored
// encoded (raw AudioParam domain) since that's what the clock schedules.
function addAutomationCommand(ribbit, unit, paramsMap, params, timing) {
    const key = params.automate;
    const param = paramsMap[key];
    if (!param) return [`unknown param "${key}" to automate`];
    if (!("to" in params)) return [`usage: automate=${key} to=<value> [from=] [beat=0] [duration=1] [curve=linear|exponential|target] [once]`];

    const curve = params.curve ?? "linear";
    if (!AUTOMATION_CURVES.includes(curve)) return [`invalid curve "${curve}" (expected ${AUTOMATION_CURVES.join(", ")})`];

    const to = param.clamp(toNumber(params.to, "to"));
    const from = params.from !== undefined ? param.clamp(toNumber(params.from, "from")) : param.get();
    const beat = toNumber(params.beat ?? 0, "beat");
    const duration = toNumber(params.duration ?? 1, "duration");
    const once = params.once === true;

    const loopLength = ribbit.clock.loopLengthBeats;
    const beyondLoop = beat >= loopLength
        ? ` (beat ${beat} is beyond the current ${loopLength}-beat loop — it won't fire unless num_beats is raised)`
        : "";
    const description = `${key} ${formatValue(from)} -> ${formatValue(to)} at beat ${beat} over ${duration}b (${curve}${once ? ", once" : ""})${beyondLoop}`;

    // at= here defers when the automation *joins* the loop, not the
    // loop-relative beat= it fires on — the two are independent: beat= is the
    // pattern position it repeats at, at= is which pass it starts repeating
    // from. `from` is captured now rather than at fire time, matching the
    // immediate path (and keeping a deferred automate= predictable).
    return [runAt(ribbit, timing, `automation will be added: ${description}`, () => {
        unit.addAutomation(new RibbitAutomationEvent({
            beat,
            duration,
            target: param.audioParam,
            from: param.encode(from),
            to: param.encode(to),
            curve,
            once,
            paramKey: key,
        }));
        return `automation added: ${description}`;
    })];
};

// One line per automation event, with its index (the handle remove_automation
// takes). from/to are decoded back through the named param so the listing
// shows user-facing values (fader position, not raw tapered gain).
function listAutomation(object, paramsMap) {
    if (object.automation.length === 0) return "no automation";
    return object.automation.map((event, i) => {
        const param = event.paramKey ? paramsMap[event.paramKey] : null;
        const from = param ? param.decode(event.from) : event.from;
        const to = param ? param.decode(event.to) : event.to;
        return `${i}: ${event.paramKey ?? "(raw param)"} ${formatValue(from)} -> ${formatValue(to)} beat=${event.beat} duration=${event.duration}b curve=${event.curve}${event.once ? " (once)" : ""}`;
    }).join("\n");
};

function removeAutomationCommand(ribbit, object, rawIndex, timing) {
    const index = toNumber(rawIndex, "remove_automation");
    if (!Number.isInteger(index) || index < 0 || index >= object.automation.length) {
        return `no automation event ${rawIndex} (see "automations" for the current list)`;
    }
    // Holds the event itself, not the index — same reasoning as remove_event.
    const event = object.automation[index];
    return runAt(ribbit, timing, `automation event ${index} will be removed`, () => {
        const at = object.automation.indexOf(event);
        if (at === -1) return `automation event ${index} was already gone`;
        object.automation.splice(at, 1);
        return `automation event ${index} removed`;
    });
};

// Builds the one-line status string for a channel (master, a track, or a
// bus), shown both for `/track_1` with no params and inside `/tracks`/`/buses`.
function channelSummary(channel) {
    const gain = `gain=${channel.params.gain.get().toFixed(2)}`;
    const pan = `pan=${channel.params.pan.get().toFixed(2)}`;
    const inserts = channel.processors.length
        ? channel.processors.map((p) => `${p.id}:${p.name}${p.active ? "" : "(off)"}`).join(", ")
        : "none";
    const sends = channel.sends.length
        ? channel.sends.map((s) => `${s.id}:${s.destName}(${s.params.gain.get().toFixed(2)})`).join(", ")
        : "none";
    // For now the source can't be introspected further, but surface what it
    // is so this is a natural place for that control to grow into.
    const synth = channel.source
        ? ` synth=${channel.source.name}("${channel.source.llm_summary}")${channel.source.active ? "" : " (stopped)"}`
        : "";
    return `${channel.name} — ${gain} ${pan} inserts=[${inserts}] sends=[${sends}]${synth}`;
};

// Full reference text for `/track_1 help` (also master/any bus) — everything
// channelSummary condenses to one line, spelled out: every param with its
// live value and range, then every command this channel kind accepts.
// Doesn't need per-param prose descriptions (unlike, say, a synth's own
// waveform choices might one day want) since gain/pan are just the two
// generic channel params every RibbitChannel has — the command list below is
// what actually needs spelling out.
function channelHelp(ribbit, channel) {
    const lines = [channelSummary(channel), "", "params:"];
    for (const [key, param] of Object.entries(channel.params)) {
        lines.push(formatParamLine(key, param));
    }

    // A track's synth contributes its own params/options to this channel's
    // command surface (routed by channelCommand the same way gain/pan are)
    // — list them here so /track_1 help shows e.g. waveform without the
    // user needing to know which object it technically lives on.
    if (channel.source) {
        const synthParams = Object.entries(channel.source.params);
        const synthOptions = Object.entries(channel.source.options);
        if (synthParams.length || synthOptions.length) {
            lines.push("", `synth params/options (${channel.source.name}):`);
            for (const [key, param] of synthParams) lines.push(formatParamLine(key, param));
            for (const [key, option] of synthOptions) lines.push(formatOptionLine(key, option));
        }
    }

    lines.push("", "commands:");
    lines.push("  gain=<val> / pan=<val>          set instantly; add a trailing duration to ramp, e.g. gain=0 3 (3s) or gain=0 4b (4 beats)");
    lines.push("  at=beat|cycle                    defer ANY command on this line — a set, a ramp, or a discrete change like start/stop/synth=/an option — to the next beat/loop boundary instead of firing now");
    if (channel.source) {
        lines.push(`  synth=<type>                     swap this track's synth (${ribbit.synthTypes.join(", ")})`);
        lines.push("  add_event beat= pitch=|degree= velocity= duration=   append a note event (all fields optional; beat defaults to 0)");
        lines.push("  events / remove_event=<n>        list this synth's events with indices / remove one by index");
        lines.push("  clear_events                     empty this synth's pattern");
        lines.push("  start / stop                     pause/resume this synth's transport (routing untouched)");
        lines.push(`  (this synth can also receive generated notes alongside add_event: /patch source=<generator> dest=${channel.name}.notes)`);
    } else {
        lines.push("  (no synth here — add_event/clear_events/start/stop/synth= are no-ops on master/buses)");
    }
    lines.push("  automate=<param> to= [from= beat= duration= curve= once]   add loop-position automation on gain/pan (beats, repeats every loop unless once)");
    lines.push("  automations / remove_automation=<n> / clear_automation     list (with indices) / remove one / remove all");
    lines.push(`  add_processor=<type>             insert an effect at the end of the chain (${ribbit.processorTypes.join(", ")})`);
    lines.push("  remove_processor=<id>            remove an insert by id");
    lines.push("  out=<name>                       replace every current send with a single one to <name>");
    lines.push("  add_send=<name> [send_gain=]     add another simultaneous send (default gain 1)");
    lines.push("  remove_send=<id>                 remove one send");
    lines.push("  send=<id> [send_gain=]           report, or ramp/set, one existing send's own gain");
    if (channel !== ribbit.master) lines.push("  remove_self                      delete this channel");
    lines.push(`  (this channel's post-fader output can be a patch source: /patch source=${channel.name} dest=<name.param>)`);
    lines.push("  help                             show this text");

    return lines.join("\n");
};

// Every track, bus, and master is addressable by its own name, e.g.
// /track_1 gain=0.5. gain is a 0-1 position, exponentially tapered onto the
// actual AudioParam; pan is linear -1..1. Either can instead be ramped by
// giving a trailing duration, e.g. /track_1 gain=0 3 (over 3 seconds) or
// gain=0 4b (over 4 beats). A set (ramped or not) starts right now by
// default; add at=beat or at=cycle to defer it to the next beat/loop
// boundary instead, e.g. /track_1 gain=0 3 at=cycle, or /track_1 gain=0
// at=cycle for an instant (unramped) change that still waits for the
// boundary. add_processor/remove_processor manage the insert chain at
// runtime. out=<name> replaces every current send with a single one to that
// track/bus/master (the default: a fresh track/bus sends to master alone).
// add_send=<name> (optionally with send_gain=<0-1>, default 1) adds one more
// simultaneous send without disturbing existing ones — e.g. a track can send
// dry to master (its default) and also add_send= a reverb bus at a lower
// level; remove_send=<id> removes just one. send=<id> (optionally with
// send_gain=<value>, ramp/at= supported the same as any other param) reports
// or adjusts one existing send's own gain afterward. add_event appends an
// RibbitEvent to the track's synth (beat=/pitch=|degree=/velocity=/duration=,
// each optional); clear_events empties its pattern. start/stop pause a
// track's own synth (its events stop scheduling) without touching routing;
// master and any bus have no synth, so start/stop/synth/add_event/
// clear_events are no-ops there.
// Every non-param key channelCommand itself consumes (beat/pitch/degree/
// velocity/duration ride along with add_event; send_gain with add_send/
// send). Anything typed that's neither here nor one of the channel's own
// params is reported as unknown at the end of channelCommand — without
// that, a typo'd key (/track_1 gian=0.5) would silently do nothing and
// print the summary as if the command had been a plain query.
const CHANNEL_COMMAND_KEYS = new Set([
    "at", "out", "add_send", "send_gain", "remove_send", "send",
    "add_event", "beat", "pitch", "degree", "velocity", "duration",
    "events", "remove_event", "clear_events", "start", "stop", "synth",
    "automate", "from", "to", "curve", "once",
    "automations", "remove_automation", "clear_automation",
    "add_processor", "remove_processor", "remove_self", "help",
]);

function channelCommand(ribbit, channel, params) {
    if (params.help) return channelHelp(ribbit, channel);
    if (Object.keys(params).length === 0) return channelSummary(channel);

    const { warning, ...timing } = resolveStartTime(ribbit.clock, params.at);

    if (params.remove_self) {
        if (channel === ribbit.master) return "cannot remove the master channel";
        return runAt(ribbit, timing, `${channel.name} will be removed`, () => {
            if (ribbit.buses.includes(channel)) ribbit.removeBus(channel);
            else ribbit.removeTrack(channel);
            return `${channel.name} removed`;
        });
    }

    const results = warning ? [warning] : [];

    // gain/pan go through the exact same param machinery every processor,
    // modulator, and patch uses (see applyParams) — reportUnknown: false
    // since `params` also carries channel-specific keys (add_event, start,
    // synth=, ...) that aren't rampable params at all.
    results.push(...applyParams(ribbit, channel.params, params, timing, { reportUnknown: false }));

    // A track's synth's own params and options are addressable straight off
    // the track (/lead waveform=square) — the synth isn't an addressable
    // object of its own, so its channel is where its surface lives. Channel
    // params take precedence on a key collision (none exist today).
    const claimed = compositeClaimedKeys(params);
    if (channel.source) {
        results.push(...applyParams(ribbit, channel.source.params, params, timing, { reportUnknown: false }));
        results.push(...applyOptions(ribbit, channel.source, params, timing, claimed));
    }

    if ("out" in params) {
        // out= replaces EVERY send — on master that includes its one send to
        // the actual speakers (audioContext.destination), which has no
        // addressable name, so nothing typed at the console could ever wire
        // it back. add_send= on master stays allowed (it doesn't disturb the
        // speakers send), as does remove_send= of any non-speakers send.
        if (channel === ribbit.master) {
            results.push("master's output is fixed to the speakers — out= is not available on master");
        } else {
            // Resolved before the defer, not inside it, so a typo'd
            // destination is still a plain command error — see runAt.
            const destObject = ribbit._resolveObject(params.out);
            if (!destObject || !destObject.input) {
                results.push(`unknown or invalid destination "${params.out}"`);
            } else {
                results.push(runAt(ribbit, timing, `will route to ${params.out}`, () => {
                    channel.connect(destObject, params.out);
                    return `routed to ${params.out} (replacing previous sends)`;
                }));
            }
        }
    }

    if ("add_send" in params) {
        const destObject = ribbit._resolveObject(params.add_send);
        if (!destObject || !destObject.input) {
            results.push(`unknown or invalid send destination "${params.add_send}"`);
        } else {
            const gain = params.send_gain !== undefined ? toNumber(params.send_gain, "send_gain") : 1;
            // A deferred add_send can't report its send id up front (ids are
            // handed out at creation), so the pending line names the
            // destination and the fired line carries the id.
            results.push(runAt(ribbit, timing, `will add send -> ${params.add_send} (gain ${gain.toFixed(2)})`, () => {
                const send = channel.addSend(destObject, { destName: params.add_send, gain });
                return `added send ${send.id} -> ${params.add_send} (gain ${gain.toFixed(2)})`;
            }));
        }
    }

    if ("remove_send" in params) {
        const send = channel.sends.find((s) => s.id === params.remove_send);
        // Same reasoning as the out= guard above: master's speakers send is
        // the one edge the console could never recreate once severed.
        if (send && send.destination === ribbit.audioContext.destination) {
            results.push("master's send to the speakers can't be removed");
        } else if (!send) {
            results.push(`no send "${params.remove_send}" on ${channel.name}`);
        } else {
            results.push(runAt(ribbit, timing, `will remove send ${params.remove_send}`, () => (
                channel.removeSend(params.remove_send)
                    ? `removed send ${params.remove_send}`
                    : `no send "${params.remove_send}" on ${channel.name}`
            )));
        }
    }

    if ("send" in params) {
        const send = channel.sends.find((s) => s.id === params.send);
        if (!send) {
            results.push(`no send "${params.send}" on ${channel.name}`);
        } else if (!("send_gain" in params)) {
            results.push(`${send.id} -> ${send.destName} (gain ${send.params.gain.get().toFixed(2)})`);
        } else {
            results.push(...applyParams(ribbit, { gain: send.params.gain }, { gain: params.send_gain }, timing));
        }
    }

    if (params.add_event) {
        if (!channel.source) {
            results.push(`${channel.name} has no synth`);
        } else {
            const event = new RibbitEvent({
                beat: toNumber(params.beat ?? 0, "beat"),
                pitch: params.pitch !== undefined ? toNumber(params.pitch, "pitch") : undefined,
                degree: params.degree !== undefined ? toNumber(params.degree, "degree") : undefined,
                velocity: params.velocity !== undefined ? toNumber(params.velocity, "velocity") : undefined,
                duration: params.duration !== undefined ? toNumber(params.duration, "duration") : undefined,
            });
            // beat is loop-relative, so a beat at/past the current loop
            // length never matches a scheduling window — legal (num_beats
            // may grow later), but silent, so it deserves a heads-up.
            const loopLength = ribbit.clock.loopLengthBeats;
            const beyondLoop = event.beat >= loopLength
                ? ` (beat ${event.beat} is beyond the current ${loopLength}-beat loop — it won't sound unless num_beats is raised)`
                : "";
            const source = channel.source;
            results.push(runAt(ribbit, timing, `event will be added to ${source.name} at beat ${event.beat}${beyondLoop}`, () => {
                source.addEvent(event);
                return `event added to ${source.name} at beat ${event.beat}${beyondLoop}`;
            }));
        }
    }

    if (params.events) {
        if (!channel.source) {
            results.push(`${channel.name} has no synth`);
        } else if (channel.source.events.length === 0) {
            results.push("no events");
        } else {
            results.push(channel.source.events.map((event, i) => {
                const pitch = event.degree !== undefined ? `degree=${event.degree}` : `pitch=${event.pitch}`;
                return `${i}: beat=${event.beat} ${pitch} velocity=${event.velocity} duration=${event.duration}`;
            }).join("\n"));
        }
    }

    if ("remove_event" in params) {
        if (!channel.source) {
            results.push(`${channel.name} has no synth`);
        } else {
            const index = toNumber(params.remove_event, "remove_event");
            const source = channel.source;
            if (!Number.isInteger(index) || index < 0 || index >= source.events.length) {
                results.push(`no event ${params.remove_event} (see "events" for the current list)`);
            } else {
                // Deliberately holds the *event object*, not the index: by the
                // time a deferred removal fires, another command may have
                // shifted the list and index 2 could be a different note.
                const event = source.events[index];
                results.push(runAt(ribbit, timing, `event ${index} will be removed`, () => {
                    const at = source.events.indexOf(event);
                    if (at === -1) return `event ${index} was already gone`;
                    source.events.splice(at, 1);
                    return `event ${index} removed`;
                }));
            }
        }
    }

    if (params.clear_events) {
        if (!channel.source) {
            results.push(`${channel.name} has no synth`);
        } else {
            const source = channel.source;
            results.push(runAt(ribbit, timing, `${source.name} events will be cleared`, () => {
                source.events = [];
                return `${source.name} events cleared`;
            }));
        }
    }

    // Loop-position automation on this channel's own gain/pan — see
    // addAutomationCommand/listAutomation above; the same surface every
    // processor/modulator gets via paramObjectCommand.
    if ("automate" in params) {
        results.push(...addAutomationCommand(ribbit, channel, channel.params, params, timing));
    }
    if (params.automations) results.push(listAutomation(channel, channel.params));
    if ("remove_automation" in params) results.push(removeAutomationCommand(ribbit, channel, params.remove_automation, timing));
    if (params.clear_automation) {
        results.push(runAt(ribbit, timing, "automation will be cleared", () => {
            channel.automation = [];
            return "automation cleared";
        }));
    }

    // Transport on a single track — the most obviously boundary-shaped
    // gesture in the whole surface: dropping a part in or out mid-bar is
    // almost never what's wanted, so /hats stop at=cycle is the normal form.
    if (params.start) {
        if (!channel.source) {
            results.push(`${channel.name} has no synth`);
        } else {
            const source = channel.source;
            results.push(runAt(ribbit, timing, `${channel.name} will start`, () => {
                source.active = true;
                return `${channel.name} started`;
            }));
        }
    }

    if (params.stop) {
        if (!channel.source) {
            results.push(`${channel.name} has no synth`);
        } else {
            const source = channel.source;
            results.push(runAt(ribbit, timing, `${channel.name} will stop`, () => {
                source.active = false;
                return `${channel.name} stopped`;
            }));
        }
    }

    if ("synth" in params) {
        if (!channel.source) {
            results.push(`${channel.name} has no synth`);
        } else if (!ribbit.synthTypes.includes(params.synth)) {
            // Checked here rather than left to setTrackSynth's own throw so
            // that an unknown type fails as a command error even when
            // deferred (see runAt).
            results.push(`unknown synth type "${params.synth}" (expected ${ribbit.synthTypes.join(", ")})`);
        } else {
            results.push(runAt(ribbit, timing, `synth will be set to ${params.synth}`, () => {
                ribbit.setTrackSynth(channel, params.synth);
                return `synth set to ${params.synth}`;
            }));
        }
    }

    if ("add_processor" in params) {
        if (!ribbit.processorTypes.includes(params.add_processor)) {
            results.push(`unknown processor type "${params.add_processor}" (expected ${ribbit.processorTypes.join(", ")})`);
        } else {
            // Creation is deferred along with insertion, so a deferred
            // add_processor doesn't leave a named-but-unwired processor
            // sitting in ribbit.processors until the boundary arrives. The
            // cost is that its id isn't known until it fires.
            results.push(runAt(ribbit, timing, `will add ${params.add_processor}`, () => {
                const processor = ribbit.createProcessor(params.add_processor);
                channel.addProcessor(processor);
                return `added ${processor.name} (${processor.id})`;
            }));
        }
    }

    if ("remove_processor" in params) {
        // Must go through ribbit.removeProcessor (not channel.removeProcessor
        // directly) so the processor is also deregistered from ribbit.processors
        // and the clock, and any patch sourced from its output is cascade-
        // removed first — channel.removeProcessor alone only unwires it from
        // this one chain, leaving it as an orphaned "ghost" still addressable
        // by name and still ticking on the clock.
        const processor = channel.processors.find((p) => p.id === params.remove_processor);
        if (!processor) {
            results.push(`no processor "${params.remove_processor}" on ${channel.name}`);
        } else {
            results.push(runAt(ribbit, timing, `will remove ${params.remove_processor}`, () => (
                ribbit.removeProcessor(processor)
                    ? `removed ${params.remove_processor}`
                    : `no processor "${params.remove_processor}" on ${channel.name}`
            )));
        }
    }

    // See CHANNEL_COMMAND_KEYS above — reportUnknown is off for the
    // applyParams calls (each only knows one params map), so unrecognized
    // keys are caught here instead of silently ignored. A key is known if
    // any surface this command routes to claims it: the channel's params,
    // its synth's params/options, or the command keywords themselves.
    for (const key of Object.keys(params)) {
        const knownOnSynth = channel.source && (key in channel.source.params || key in channel.source.options);
        if (!(key in channel.params) && !knownOnSynth && !CHANNEL_COMMAND_KEYS.has(key)) {
            results.push(`unknown param "${key}"`);
        }
    }

    return results.length ? results.join("; ") : channelSummary(channel);
};

// One-line help/status text shared by processorCommand and modulatorCommand:
// name (+ id, if it has one, e.g. a processor's "p1") and llm_summary, plus
// every current param value.
function paramObjectSummary(object) {
    const paramList = [
        ...Object.entries(object.params).map(([key, param]) => `${key}=${formatValue(param.get())}`),
        ...Object.entries(object.options ?? {}).map(([key, option]) => `${key}=${formatOptionValue(option.get())}`),
    ].join(", ");
    const idSuffix = object.id ? ` (${object.id})` : "";
    // Optional duck-typed hook (same idiom as the clock's generateEvents/
    // onClockStart) for an object whose interesting state isn't a param or an
    // option at all — RibbitMarkovPercs' generated pattern is derived from
    // its seed and style, so nothing in the lists above actually shows you
    // the rhythm you're about to hear.
    const state = object.describeState?.();
    return `${object.name}${idSuffix}: ${object.llm_summary} [${paramList}]${state ? ` ${state}` : ""}`;
};

// Full reference text for `/reverb1 help` / `/lfo1 help` — every param with
// its live value and range, plus the generic set/ramp/at=/remove_self/patch
// commands every processor and modulator shares (see paramObjectCommand).
function paramObjectHelp(ribbit, object) {
    const idSuffix = object.id ? ` (${object.id})` : "";
    const lines = [`${object.name}${idSuffix}: ${object.llm_summary}`, "", "params:"];
    for (const [key, param] of Object.entries(object.params)) {
        lines.push(formatParamLine(key, param));
    }

    const options = Object.entries(object.options ?? {});
    if (options.length) {
        lines.push("", "options (settable, not rampable):");
        for (const [key, option] of options) lines.push(formatOptionLine(key, option));
    }

    lines.push("", "commands:");
    lines.push("  <param>=<val>                    set instantly; add a trailing duration to ramp, e.g. wet=0.5 3 (3s) or wet=0.5 4b (4 beats)");
    lines.push("  at=beat|cycle                    defer ANY command on this line — a set, a ramp, or a discrete change like start/stop/synth=/an option — to the next beat/loop boundary instead of firing now");
    lines.push("  automate=<param> to= [from= beat= duration= curve= once]   add loop-position automation (beats, repeats every loop unless once)");
    lines.push("  automations / remove_automation=<n> / clear_automation     list (with indices) / remove one / remove all");
    lines.push("  remove_self                      remove and delete this object");
    if (typeof object.generateEvents === "function") {
        lines.push(`  (this modulator generates note events — feed a synth: /patch source=${object.name} dest=<track>.notes)`);
    } else {
        lines.push(`  (this object's output can be a patch source: /patch source=${object.name} dest=<name.param>)`);
    }
    lines.push("  help                             show this text");

    return lines.join("\n");
};

// Every non-param/non-option key paramObjectCommand itself consumes — the
// processor/modulator counterpart to CHANNEL_COMMAND_KEYS, and the same
// "typos error instead of vanishing" contract.
const PARAM_OBJECT_COMMAND_KEYS = new Set([
    "at", "remove_self", "help",
    "automate", "from", "to", "beat", "duration", "curve", "once",
    "automations", "remove_automation", "clear_automation",
]);

// Shared by processorCommand and modulatorCommand: both are addressed by
// their own name (e.g. /reverb wet=0.5, /lfo1 freq=3) and expose the same
// generic surface — a `.params` map of RibbitParam (see param.js) plus an
// `.options` map of non-rampable settings (see applyOptions above). This
// function has no per-type knowledge of reverb/delay/lfo/etc.; params are
// ramped/set/deferred by applyParams exactly the same way a track's
// gain/pan is, options set via applyOptions, and the automate= family works
// on any of the object's params. `removeSelf` is the one bit that differs
// between the two object kinds (ribbit.removeProcessor vs. ribbit.removeModulator).
function paramObjectCommand(ribbit, object, params, removeSelf) {
    if (params.help) return paramObjectHelp(ribbit, object);
    if (Object.keys(params).length === 0) return paramObjectSummary(object);

    const { warning, ...timing } = resolveStartTime(ribbit.clock, params.at);

    if (params.remove_self) {
        return runAt(ribbit, timing, `${object.name} will be removed`, () => {
            removeSelf();
            return `${object.name} removed`;
        });
    }

    const results = warning ? [warning] : [];
    results.push(...applyParams(ribbit, object.params, params, timing, { reportUnknown: false }));
    results.push(...applyOptions(ribbit, object, params, timing, compositeClaimedKeys(params)));

    if ("automate" in params) {
        results.push(...addAutomationCommand(ribbit, object, object.params, params, timing));
    }
    if (params.automations) results.push(listAutomation(object, object.params));
    if ("remove_automation" in params) results.push(removeAutomationCommand(ribbit, object, params.remove_automation, timing));
    if (params.clear_automation) {
        results.push(runAt(ribbit, timing, "automation will be cleared", () => {
            object.automation = [];
            return "automation cleared";
        }));
    }

    for (const key of Object.keys(params)) {
        if (!(key in object.params) && !(key in (object.options ?? {})) && !PARAM_OBJECT_COMMAND_KEYS.has(key)) {
            results.push(`unknown param "${key}"`);
        }
    }

    return `${object.name}: ${results.join(", ")}`;
};

function processorCommand(ribbit, processor, params) {
    return paramObjectCommand(ribbit, processor, params, () => ribbit.removeProcessor(processor));
};

// A modulator (e.g. an lfo) is addressable by its own name exactly like a
// processor, e.g. /lfo1 freq=3 or /lfo1 help — see paramObjectCommand. It
// never sits in a channel's chain, so there's no add_processor-style
// insert/remove-from-chain step; removing one just tears the modulator (and
// any patch touching it) down (see ribbit.removeModulator).
function modulatorCommand(ribbit, modulator, params) {
    return paramObjectCommand(ribbit, modulator, params, () => ribbit.removeModulator(modulator));
};

// One-line summary for /patches, e.g. "x1: lfo1 -> reverb.wet (depth 0.30)" —
// or, for an event patch (no depth — see RibbitEventPatch), "x2: rand1 ->
// track_1.notes (generated notes)".
function patchSummary(patch) {
    const detail = patch.params.depth ? `depth ${patch.depth.value.toFixed(2)}` : "generated notes";
    return `${patch.id}: ${patch.sourceName} -> ${patch.destName} (${detail})`;
};

// Keywords channelCommand accepts beyond gain=/pan= (which come straight off
// channel.params — see channelKeywordsFor). One list, used only by the
// console's ghost-text suggestions (suggestCompletion below) — channelHelp's
// text stays separately hand-written prose, since each line there also
// carries its own usage note that doesn't reduce to a bare keyword. A
// trailing "=" marks a value-taking key (so the console doesn't add a
// trailing space after accepting it — see the console UI's
// insertAtCursor/acceptSuggestion, which both understand the same "=" tail
// convention).
const CHANNEL_ACTION_KEYWORDS = [
    "add_event", "events", "remove_event=", "clear_events", "start", "stop",
    "synth=", "add_processor=", "remove_processor=", "out=", "add_send=",
    "remove_send=", "send=", "at=",
    "automate=", "automations", "remove_automation=", "clear_automation",
    "remove_self", "help",
];

// Same idea for processor/modulator commands beyond their own params.
const PARAM_OBJECT_ACTION_KEYWORDS = [
    "at=", "automate=", "automations", "remove_automation=",
    "clear_automation", "remove_self", "help",
];

function channelKeywordsFor(channel) {
    return [
        ...Object.keys(channel.params).map((key) => `${key}=`),
        // A track's synth's params/options are addressable off the channel
        // (see channelCommand), so they're suggestible there too.
        ...Object.keys(channel.source?.params ?? {}).map((key) => `${key}=`),
        ...Object.keys(channel.source?.options ?? {}).map((key) => `${key}=`),
        ...CHANNEL_ACTION_KEYWORDS,
    ];
};

function paramObjectKeywordsFor(object) {
    return [
        ...Object.keys(object.params).map((key) => `${key}=`),
        ...Object.keys(object.options ?? {}).map((key) => `${key}=`),
        ...PARAM_OBJECT_ACTION_KEYWORDS,
    ];
};

// Every top-level command's own param keys (beyond a resolved channel's/
// processor's/modulator's own params, which come from channelKeywordsFor/
// paramObjectKeywordsFor above) — the other half of what resolveKeywordsFor
// needs to cover every command, not just addressable objects. A command with
// no params of its own (tracks, patches, save_session, ...) just isn't
// listed; resolveKeywordsFor falls back to [] for any recognized top-level
// name. Every command that mutates something carries at=, since all of them
// can now be deferred to a beat/cycle boundary (see runAt) — the read-only
// listing commands are the ones with nothing to schedule.
const TOP_LEVEL_KEYWORDS = {
    start: ["at="],
    stop: ["at="],
    add_track: ["name=", "synth=", "out=", "at="],
    add_bus: ["name=", "out=", "at="],
    clock: ["bpm=", "num_beats=", "at="],
    harmony: ["root=", "scale=", "at="],
    add_modulator: ["type=", "name=", "at="],
    patch: ["source=", "dest=", "depth=", "id=", "at="],
    unpatch: ["id=", "at="],
    save: ["name=", "at="],
    recall: ["name=", "at="],
    remove_state: ["name=", "at="],
};

// Every name addressable as `/name`, for completing the command/object-name
// token. Deliberately *not* executeOne's dispatch order (top-level commands
// first) — objects come first here instead, since a user-chosen name is the
// higher-value thing to complete and there are only a handful of top-level
// commands to begin with. This also resolves the one real collision today:
// without it, typing "/trac" would suggest the built-in `/tracks` (a valid
// prefix match) ahead of an actual track named "track_1".
function addressableNames(ribbit, topLevelNames) {
    return [...objectNames(ribbit), ...topLevelNames];
};

// Just the "things with a name" half of addressableNames — no top-level
// commands — for completing a value that names an object (out=/add_send=/
// source=/dest=), where a command name would never be valid.
function objectNames(ribbit) {
    return [
        "master",
        ...ribbit.tracks.map((t) => t.name),
        ...ribbit.buses.map((b) => b.name),
        ...ribbit.processors.map((p) => p.name),
        ...ribbit.modulators.map((m) => m.name),
    ];
};

// Resolves an already-typed name to whichever channel or processor/modulator
// it addresses (or null) — the one lookup both resolveKeywordsFor and
// resolveValueCandidates need, so they can't drift on how "master"/tracks/
// buses/processors/modulators are found.
function resolveObjectFor(ribbit, name) {
    if (name === "master") return ribbit.master;
    return ribbit.tracks.find((t) => t.name === name)
        ?? ribbit.buses.find((b) => b.name === name)
        ?? ribbit.processors.find((p) => p.name === name)
        ?? ribbit.modulators.find((m) => m.name === name)
        ?? null;
};

// Resolves an already-typed command name to the keyword list valid after it —
// null both for an unrecognized name and for a recognized top-level command
// with no params of its own (start, tracks, save_session, ...): either way
// there's nothing to suggest.
function resolveKeywordsFor(ribbit, name) {
    if (name === "master") return channelKeywordsFor(ribbit.master);

    const channel = ribbit.tracks.find((t) => t.name === name) ?? ribbit.buses.find((b) => b.name === name);
    if (channel) return channelKeywordsFor(channel);

    const paramObject = ribbit.processors.find((p) => p.name === name) ?? ribbit.modulators.find((m) => m.name === name);
    if (paramObject) return paramObjectKeywordsFor(paramObject);

    if (name in TOP_LEVEL_KEYWORDS) return TOP_LEVEL_KEYWORDS[name];
    return null;
};

// Known value candidates for a "key=" whose domain is small/enumerable (a
// registered type name, "beat"/"cycle", an existing id/name) rather than
// open-ended (a number, an arbitrary user-chosen name) — null means "no
// known candidates," which leaves the value untouched rather than guessing.
// `resolvedObject` is whatever resolveObjectFor found for the command/object
// name the key is being typed on (e.g. the channel for a "remove_processor="
// being typed on /track_1), so id-shaped values can be scoped to it.
function resolveValueCandidates(ribbit, commandName, resolvedObject, key) {
    if (key === "at") return ["beat", "cycle"];
    if (key === "synth") return ribbit.synthTypes;
    if (key === "add_processor") return ribbit.processorTypes;
    if (key === "type" && commandName === "add_modulator") return ribbit.modulatorTypes;
    if (key === "name" && (commandName === "recall" || commandName === "remove_state")) return Object.keys(ribbit.states);
    if (key === "id" && (commandName === "patch" || commandName === "unpatch")) return ribbit.patches.map((p) => p.id);
    if (key === "out" || key === "add_send" || key === "source" || key === "dest") return objectNames(ribbit);
    if (key === "remove_processor" && resolvedObject?.processors) return resolvedObject.processors.map((p) => p.id);
    if ((key === "remove_send" || key === "send") && resolvedObject?.sends) return resolvedObject.sends.map((s) => s.id);
    if (key === "curve") return AUTOMATION_CURVES;
    if (key === "automate" && resolvedObject?.params) return Object.keys(resolvedObject.params);
    if (key === "remove_event" && resolvedObject?.source) return resolvedObject.source.events.map((_, i) => String(i));
    if (key === "remove_automation" && resolvedObject?.automation) return resolvedObject.automation.map((_, i) => String(i));

    // An option with a declared `choices` list (a synth/lfo waveform)
    // completes from it — whether the option lives on the resolved object
    // itself (a processor/modulator) or on its synth (a track, whose
    // channelCommand routes synth options — see channelKeywordsFor).
    const optionOwner = resolvedObject?.options?.[key]
        ? resolvedObject
        : resolvedObject?.source?.options?.[key] ? resolvedObject.source : null;
    if (optionOwner) return optionOwner.options[key].choices ?? null;

    return null;
};

// First candidate that extends (but isn't identical to) `partial` — no
// ranking/cycling for now (see docs/llm/overview.md), just one deterministic
// guess that narrows as more characters are typed.
function pickBestMatch(candidates, partial) {
    return candidates.find((candidate) => candidate !== partial && candidate.startsWith(partial)) ?? null;
};

// True when `cursorPos` sits at the boundary of a token (nothing/whitespace/
// the start of the next "/command" immediately follows) rather than inside
// one — completion only ever extends the token ending exactly at the cursor,
// never inserts into the middle of one already-typed further.
function isTokenBoundary(input, cursorPos) {
    const ch = input[cursorPos];
    return ch === undefined || ch === " " || ch === "/";
};

// Ghost-text completion for the console (the console UI): given the full
// input text and the cursor position, returns { start, end, full } — the
// span of the current token (`start` to `end`, both absolute indices into
// `input`; `end` always equals `cursorPos`, since completion only fires at a
// token boundary — see isTokenBoundary) and the complete candidate string it
// could complete to — or null if there's nothing to suggest. Works with the
// cursor anywhere in the input, not just at the very end (the console UI
// composites the whole line through the ghost overlay, so an insertion
// anywhere pushes later text over correctly).
//
// Completes three token shapes: the /name itself (any top-level command or
// addressable object); once past the name, a bare param *key* for whatever
// the name resolves to (a channel/processor/modulator's own params, or a
// top-level command's — see resolveKeywordsFor); or, once a key's "=" has
// been typed, its *value* — but only for keys with a known, enumerable
// candidate list (see resolveValueCandidates); an open-ended value (a
// number, a freshly-chosen name) is left alone.
function suggestCompletion(ribbit, topLevelNames, input, cursorPos) {
    if (!isTokenBoundary(input, cursorPos)) return null;

    const lastSlash = input.lastIndexOf("/", cursorPos - 1);
    if (lastSlash === -1) return null;

    const typed = input.slice(lastSlash, cursorPos); // e.g. "/track_1 ga"
    const firstSpace = typed.indexOf(" ");

    if (firstSpace === -1) {
        const partial = typed.slice(1);
        if (!partial) return null;
        const match = pickBestMatch(addressableNames(ribbit, topLevelNames), partial);
        return match ? { start: lastSlash + 1, end: cursorPos, full: match } : null;
    }

    const name = typed.slice(1, firstSpace);
    const paramsText = typed.slice(firstSpace + 1);
    const lastSpaceInParams = paramsText.lastIndexOf(" ");
    const currentToken = lastSpaceInParams === -1 ? paramsText : paramsText.slice(lastSpaceInParams + 1);
    if (!currentToken) return null;

    const tokenStart = cursorPos - currentToken.length;
    const eqIndex = currentToken.indexOf("=");

    if (eqIndex !== -1) {
        const key = currentToken.slice(0, eqIndex);
        const valuePartial = currentToken.slice(eqIndex + 1);
        // Same "nothing typed yet" guard the /name-token and bare-key
        // branches above already have (see the `!partial`/`!currentToken`
        // checks) — without it, an empty value (just typed "type=") would
        // "complete" to the *first* candidate (e.g. "lfo") and, on Enter,
        // silently submit and create that instead of whatever the user meant
        // to type next. Requiring at least one typed character narrows
        // multiple candidates unambiguously before anything is suggested.
        if (!valuePartial) return null;
        const candidates = resolveValueCandidates(ribbit, name, resolveObjectFor(ribbit, name), key);
        if (!candidates) return null;
        const match = pickBestMatch(candidates, valuePartial);
        return match ? { start: tokenStart, end: cursorPos, full: `${key}=${match}` } : null;
    }

    const keywords = resolveKeywordsFor(ribbit, name);
    if (!keywords) return null;

    const match = pickBestMatch(keywords, currentToken);
    return match ? { start: tokenStart, end: cursorPos, full: match } : null;
};

// Builds the single executeCommand(text) function the UI calls for every
// console submission. Closes over one Ribbit instance; holds no state of its
// own, since dispatch (track/processor name lookup) is re-resolved on every
// call against the live ribbit.tracks/ribbit.processors arrays.
export function createCommandRouter(ribbit) {
    // runAt for a top-level command whose entire body is one mutation:
    // resolves at=, defers, and prefixes the unknown-at= warning that the
    // longer handlers (channelCommand, /clock) push onto their results array.
    // `at` itself is stripped from what reaches the handler, so a command
    // that forwards its params on as constructor options (add_track,
    // add_modulator) doesn't carry a scheduling hint into the object it
    // builds.
    function scheduled(params, pending, fn) {
        const { at, ...rest } = params ?? {};
        const { warning, ...timing } = resolveStartTime(ribbit.clock, at);
        const result = runAt(ribbit, timing, pending, () => fn(rest));
        return warning ? `${warning}; ${result}` : result;
    };

    const commands = {
        // at= on /stop is the useful direction — "let the loop finish" —
        // while /start at= is accepted for uniformity but degenerate: a
        // suspended AudioContext's currentTime is frozen, so the clock's beat
        // boundaries aren't advancing to defer against. It still fires (the
        // delay is computed once, in wall-clock terms); it just isn't
        // musically anchored to anything.
        start: (params) => scheduled(params, "engine will start", () => {
            ribbit.start();
            return "engine started";
        }),
        stop: (params) => scheduled(params, "engine will stop", () => {
            ribbit.stop();
            return "engine stopped";
        }),
        // Creating a track/bus/modulator makes no sound on its own, so at=
        // here is much less useful than on the commands that wire them up
        // (patch, add_processor, start/stop). It's honored anyway so that
        // "at= works on anything that mutates" holds without exceptions —
        // one fewer rule for a caller (or an NL layer) to special-case. The
        // trade-off worth knowing: a deferred creation can't report the name
        // it will get, and isn't addressable until it fires, so chaining
        // `/add_track name=x at=cycle /x gain=0.5` on one line won't work.
        add_track: (params) => scheduled(params, "track will be created", (options) => {
            const track = ribbit.createTrack(options);
            return `created ${track.name}`;
        }),
        tracks: () => {
            if (ribbit.tracks.length === 0) return "no tracks";
            return ribbit.tracks.map((track) => channelSummary(track)).join("\n");
        },
        // A bus is a track-shaped object with no synth of its own — an empty
        // channel (fader/pan/inserts/sends) that exists purely to be a shared
        // destination other tracks/buses can send into, e.g. a shared reverb
        // send or a drum sub-mix. Defaults to feeding master, same as a fresh
        // track, unless out=<name> names a different destination.
        add_bus: (params) => scheduled(params, "bus will be created", (options) => {
            const bus = ribbit.createBus(options);
            return `created ${bus.name}`;
        }),
        buses: () => {
            if (ribbit.buses.length === 0) return "no buses";
            return ribbit.buses.map((bus) => channelSummary(bus)).join("\n");
        },
        // bpm can be ramped the same way a track's gain/processor's wet can
        // (/clock bpm=140 8, optionally at=beat|cycle) — see RibbitClock.rampBpm
        // for why that needs its own stepped timer rather than riding a native
        // AudioParam ramp. num_beats is deliberately not rampable (a
        // fractional, constantly-shifting loop length has no sensible
        // meaning), so a ramp spec there is rejected with a message.
        clock: (params) => {
            if (!("bpm" in params) && !("num_beats" in params)) {
                return `bpm=${ribbit.clock.bpm} num_beats=${ribbit.clock.loopLengthBeats}`;
            }

            const results = [];
            const { startTime, label, warning } = resolveStartTime(ribbit.clock, params.at);
            if (warning) results.push(warning);

            if ("bpm" in params) {
                const spec = params.bpm;
                if (isRamp(spec)) {
                    const target = toNumber(spec.value, "bpm");
                    const seconds = rampSeconds(ribbit.clock, spec);
                    ribbit.clock.rampBpm(target, seconds, { startTime });
                    results.push(`bpm ramping to ${target} over ${seconds.toFixed(2)}s${label ? ` (${label})` : ""}`);
                } else {
                    const target = toNumber(spec, "bpm");
                    if (startTime !== undefined) {
                        // bpm isn't a native AudioParam, so a deferred plain
                        // set rides rampBpm with a zero-length ramp — the
                        // same "step it on a timer until startTime, then
                        // apply" mechanism, not a duplicate of it.
                        ribbit.clock.rampBpm(target, 0, { startTime });
                        results.push(`bpm set to ${target} (${label})`);
                    } else {
                        ribbit.clock.setBpm(target);
                        results.push(`bpm set to ${ribbit.clock.bpm}`);
                    }
                }
            }

            if ("num_beats" in params) {
                const spec = params.num_beats;
                if (isRamp(spec)) {
                    results.push(`num_beats can't be ramped — use num_beats=<number>`);
                } else {
                    const target = toNumber(spec, "num_beats");
                    if (startTime !== undefined) {
                        scheduleAt(ribbit, startTime, () => ribbit.clock.setLoopLengthBeats(target));
                        results.push(`num_beats set to ${target} (${label})`);
                    } else {
                        ribbit.clock.setLoopLengthBeats(target);
                        results.push(`num_beats set to ${ribbit.clock.loopLengthBeats}`);
                    }
                }
            }

            return results.join("; ");
        },
        // The shared harmony context every synth resolves RibbitEvent.degree
        // against, mutated in place (never replaced — synths hold a
        // reference; see harmony.js). Because degrees resolve at *trigger*
        // time, changing root/scale retunes already-playing degree-authored
        // patterns (and randomnotes streams) live, mid-loop.
        harmony: (params) => {
            if (!("root" in params) && !("scale" in params)) {
                return `root=${ribbit.harmony.root} scale=${ribbit.harmony.scale.join(",")}`;
            }

            const { warning, ...timing } = resolveStartTime(ribbit.clock, params.at);
            const results = warning ? [warning] : [];

            // A key change is the archetypal at=cycle gesture, so both of
            // these defer even though neither can ramp. Parsing happens
            // before runAt so a malformed scale is still a command error.
            if ("root" in params) {
                if (isRamp(params.root)) {
                    results.push("root can't be ramped — use root=<midi note>, optionally with at=beat|cycle");
                } else {
                    const root = toNumber(params.root, "root");
                    results.push(runAt(ribbit, timing, `root=${root}`, () => {
                        ribbit.harmony.root = root;
                        return `root=${ribbit.harmony.root}`;
                    }));
                }
            }
            if ("scale" in params) {
                if (isRamp(params.scale)) {
                    results.push("scale can't be ramped — use scale=<comma-separated degrees>, optionally with at=beat|cycle");
                } else {
                    const scale = parseDegreeList(params.scale);
                    results.push(runAt(ribbit, timing, `scale=${scale.join(",")}`, () => {
                        ribbit.harmony.scale = scale;
                        return `scale=${ribbit.harmony.scale.join(",")}`;
                    }));
                }
            }
            return results.join("; ");
        },
        add_modulator: (params) => scheduled(params, "modulator will be created", (rest) => {
            const { type, ...options } = rest;
            const modulator = ribbit.createModulator(type ?? "lfo", options);
            return `created ${modulator.name}`;
        }),
        modulators: () => {
            if (ribbit.modulators.length === 0) return "no modulators";
            return ribbit.modulators.map(paramObjectSummary).join("\n");
        },
        // A patch is its own standalone thing — a "cable" from any named
        // object's raw output (a modulator, but also a track/master/processor,
        // whose signal can double as a CV source) into any other object's
        // param (name.param, e.g. "reverb.wet", "track_1.gain", "lfo1.freq"),
        // through its own depth (attenuator), independent of both endpoints —
        // see ribbit.createPatch/RibbitPatch. /patch source=... dest=... depth=...
        // creates one; /patch id=<id> depth=... adjusts an existing patch's
        // depth afterward (ramp/at= supported the same way any param is).
        patch: (params) => {
            if ("id" in params) {
                const patchObj = ribbit.patches.find((p) => p.id === params.id);
                if (!patchObj) return `no patch "${params.id}"`;
                if (!("depth" in params)) return patchSummary(patchObj);
                if (!patchObj.params.depth) return `${patchObj.id} is an event patch (-> .notes) — no depth to adjust`;

                const { id: _id, ...depthParams } = params;
                const { startTime, label, warning } = resolveStartTime(ribbit.clock, depthParams.at);
                const results = warning ? [warning] : [];
                results.push(...applyParams(ribbit, patchObj.params, depthParams, { startTime, label }));
                return `${patchObj.id} ${results.join(", ")}`;
            }

            if (!("source" in params) || !("dest" in params)) {
                return `usage: /patch source=<name> dest=<name.param> depth=<0-1> (default 1); adjust later with /patch id=<id> depth=...; or dest=<track>.notes to feed an event-generating modulator's notes into a synth (no depth)`;
            }

            // Patching is audible the moment it happens — a modulator starts
            // pushing a param, or a generator starts feeding a synth notes —
            // so at= here is one of the more musically useful cases:
            // /patch source=rhy dest=hats.notes at=cycle drops the drums in
            // on the downbeat. createPatch validates (and allocates the id)
            // when it fires, so a deferred patch reports its id via notify().
            const depth = toNumber(params.depth ?? 1, "depth");
            return scheduled(params, `will patch ${params.source} -> ${params.dest}`, () => {
                const patchObj = ribbit.createPatch({ sourceName: params.source, destName: params.dest, depth });
                return `patched ${patchSummary(patchObj)}`;
            });
        },
        unpatch: (params) => {
            if (!("id" in params)) return `usage: /unpatch id=<id>`;
            const patchObj = ribbit.patches.find((p) => p.id === params.id);
            if (!patchObj) return `no patch "${params.id}"`;
            return scheduled(params, `${params.id} will be removed`, () => {
                ribbit.removePatch(patchObj);
                return `${params.id} removed`;
            });
        },
        patches: () => {
            if (ribbit.patches.length === 0) return "no patches";
            return ribbit.patches.map(patchSummary).join("\n");
        },
        // Captures everything live (clock/harmony/master/buses/tracks/
        // modulators/patches — see session.js's snapshotSession) under a
        // name, held in memory on ribbit.states. Also persisted as part of a
        // whole-session file (see save_session below), so a saved session's
        // states survive a save/load round trip. A bare leading token is
        // shorthand for name= (see POSITIONAL_NAME_COMMANDS in
        // parseCommand): "/save 1" and "/save name=1" are equivalent.
        // at= here defers *when the snapshot is taken*, which is the whole
        // point of deferring it: "capture how this sounds at the top of the
        // next cycle" rather than mid-gesture, halfway through a fade.
        save: (params) => {
            if (!("name" in params)) return `usage: /save <state> [at=beat|cycle] (or name=<state>)`;
            return scheduled(params, `will save state "${params.name}"`, () => {
                ribbit.states[params.name] = snapshotSession(ribbit);
                return `saved state "${params.name}"`;
            });
        },
        // Reconciles the live session toward a saved state without a hard
        // cut — matching objects ramp in place, appearing/disappearing ones
        // fade in/out (see session.js's applySnapshot) — rather than
        // tearing everything down and rebuilding. A bare leading token is
        // shorthand for name= (see POSITIONAL_NAME_COMMANDS in
        // parseCommand): "/recall 1" and "/recall name=1" are equivalent, as
        // are "/recall 1 4b" and "/recall name=1 4b". A trailing duration
        // ramps the change over that long, e.g. /recall 1 3 (3s) or
        // /recall 1 4b (4 beats); with none, every change is still deferred
        // to at=beat|cycle if given, just as an instant jump rather than a
        // ramp — same convention as any other param.
        recall: (params) => {
            if (!("name" in params)) return `usage: /recall <state> [<duration>] [at=beat|cycle] (or name=<state>)`;

            const spec = params.name;
            const stateName = isRamp(spec) ? spec.value : spec;
            const durationSeconds = isRamp(spec) ? rampSeconds(ribbit.clock, spec) : 0;

            const snapshot = ribbit.states[stateName];
            if (!snapshot) return `no saved state "${stateName}"`;

            const { startTime, label, warning } = resolveStartTime(ribbit.clock, params.at);
            applySnapshot(ribbit, snapshot, { startTime, durationSeconds });

            const rampNote = durationSeconds > 0 ? ` over ${durationSeconds.toFixed(2)}s` : "";
            return `${warning ? `${warning}; ` : ""}recalling "${stateName}"${rampNote}${label ? ` (${label})` : ""}`;
        },
        remove_state: (params) => {
            if (!("name" in params)) return `usage: /remove_state name=<state>`;
            if (!(params.name in ribbit.states)) return `no saved state "${params.name}"`;
            return scheduled(params, `will remove state "${params.name}"`, () => {
                delete ribbit.states[params.name];
                return `removed state "${params.name}"`;
            });
        },
        states: () => {
            const names = Object.keys(ribbit.states);
            return names.length ? names.join(", ") : "no saved states";
        },
        // Downloads the whole live session (including every /save'd state)
        // as a JSON file — see session.js's sessionToJSON. /save_json is the
        // exact same command under an alternate, more literal name (also
        // what a host's Save control —
        // runs) — both point at the one handler below rather than two copies.
        save_session: () => saveSessionHandler(),
        save_json: () => saveSessionHandler(),
        // Opens a file picker and hard-rebuilds the session from whatever
        // .json is chosen (see session.js's loadSession) — async, unlike
        // every other command, since reading the picked file can't resolve
        // synchronously; the console UI already awaits onCommand's result.
        // /load_json is the same alias relationship as /save_json above.
        load_session: () => loadSessionHandler(),
        load_json: () => loadSessionHandler(),
    };

    function saveSessionHandler() {
        downloadJSON(sessionToJSON(ribbit), "ribbit-session");
        return "session downloaded";
    };

    async function loadSessionHandler() {
        const json = await pickJSONFile();
        if (!json) return "load cancelled";
        loadSession(ribbit, json);
        return "session loaded";
    };

    // Computed once (not per suggest() call) since `commands`'s own keys
    // never change after this router is built.
    const topLevelNames = Object.keys(commands);

    // RESERVED_NAMES (ribbit.js) is what stops an object being created with a
    // name this router would dispatch as a command first — the two lists
    // live in different modules, so verify they haven't drifted whenever a
    // router is built (once per page) rather than trusting it silently.
    for (const name of topLevelNames) {
        if (!RESERVED_NAMES.has(name)) {
            console.warn(`Ribbit: top-level command "${name}" is missing from RESERVED_NAMES (ribbit.js) — an object could be created with that name and shadow it`);
        }
    }

    // Wraps a handler so a thrown error becomes a console-printable string
    // instead of crashing the session — handlers don't need their own
    // try/catch. A handler (e.g. load_session) may return a Promise instead
    // of a string directly — the console UI already awaits executeOne's
    // result, so that promise passes through unchanged, but a *rejection*
    // still needs converting to the same clean error string a sync throw
    // gets, hence the .catch here alongside the sync try/catch.
    function run(name, handler, params) {
        try {
            const result = handler(params) ?? "";
            return result instanceof Promise
                ? result.catch((error) => `error running /${name}: ${error.message}`)
                : result;
        } catch (error) {
            return `error running /${name}: ${error.message}`;
        }
    };

    // Dispatch order: built-in top-level commands, then master, then a
    // matching track name, then a matching bus name, then a matching
    // processor name, then a matching modulator name.
    function executeOne(text) {
        if (!text.trim().startsWith("/")) {
            return `unrecognized: "${text}" (commands must start with /)`;
        }

        let name, params;
        try {
            ({ name, params } = parseCommand(text));
        } catch (error) {
            return error.message;
        }

        if (commands[name]) return run(name, commands[name], params);

        if (name === "master") return run(name, (p) => channelCommand(ribbit, ribbit.master, p), params);

        const track = ribbit.tracks.find((t) => t.name === name);
        if (track) return run(name, (p) => channelCommand(ribbit, track, p), params);

        const bus = ribbit.buses.find((b) => b.name === name);
        if (bus) return run(name, (p) => channelCommand(ribbit, bus, p), params);

        const processor = ribbit.processors.find((p) => p.name === name);
        if (processor) return run(name, (p) => processorCommand(ribbit, processor, p), params);

        const modulator = ribbit.modulators.find((m) => m.name === name);
        if (modulator) return run(name, (p) => modulatorCommand(ribbit, modulator, p), params);

        return `unknown command: /${name}`;
    };

    // Splits one submitted line into multiple "/name ..." segments so
    // several targets can be set off together, e.g.
    // "/track_1 gain=0 8 /reverb wet=0.9 6b" runs both in the same call
    // stack (and so schedules off the same audioContext.currentTime).
    // Assumes no param value contains a literal "/" — none currently do.
    function splitCommands(text) {
        const starts = [];
        const commandStart = /\/[a-zA-Z_]\w*/g;
        let match;
        while ((match = commandStart.exec(text))) starts.push(match.index);

        if (starts.length <= 1) return [text.trim()].filter(Boolean);
        return starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length).trim());
    };

    // The single entry point the UI calls for every console submission.
    // Every built-in command is synchronous except load_session (see run()
    // above) — segments.map(executeOne) is a plain string array the vast
    // majority of the time, joined immediately; only when a segment actually
    // came back as a Promise does this itself return one (the console UI
    // already awaits executeCommand's result either way), instead of always
    // paying an extra microtask for the common all-sync case.
    function executeCommand(text) {
        const segments = splitCommands(text);
        if (segments.length === 0) return `unrecognized: "${text}" (commands must start with /)`;

        const results = segments.map(executeOne);
        if (results.some((result) => result instanceof Promise)) {
            return Promise.all(results).then((resolved) => resolved.join("\n"));
        }
        return results.join("\n");
    };

    // Ghost-text completion for the console UI — see suggestCompletion.
    // Returned alongside executeCommand (rather than attached to it as a
    // property) so both stay ordinary named values at the call site; they
    // share this closure's `commands`/`topLevelNames` so a new top-level
    // command is suggestible with no separate list to keep in sync.
    function suggest(input, cursorPos) {
        return suggestCompletion(ribbit, topLevelNames, input, cursorPos);
    };

    return { executeCommand, suggest };
};
