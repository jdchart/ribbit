// A scheduled ramp of a real Web Audio AudioParam (e.g. a channel's `volume`,
// a processor's `wet`), added to a channel's or processor's `automation` list
// the same way an RibbitEvent is added to a synth's `events` list. The clock
// calls scheduleAutomationEvent() directly for these — there's no `trigger()`
// step, since ramping an AudioParam is generic across every target.
export class RibbitAutomationEvent {
    constructor({ beat, duration, target, from, to, curve = "linear", once = false, paramKey }) {
        this.beat = beat;
        this.duration = duration; // in beats
        this.target = target; // an AudioParam
        this.from = from; // raw AudioParam values (already encoded, e.g. gain taper applied)
        this.to = to;
        this.curve = curve; // "linear" | "exponential" | "target"
        this.once = once; // fire a single time ever, instead of every loop pass
        // Which key in the owning unit's `params` map `target` came from —
        // set by everything that creates one from a named param (the
        // console's automate= command, session.js's rebuild) so listings can
        // display it and session.js can serialize by name rather than by an
        // unserializable AudioParam reference. Optional: an event built
        // straight against a raw AudioParam in code just won't round-trip.
        this.paramKey = paramKey;
        this._scheduled = false;
    };
};

// Draws one ramp on `param` between `time` and `endTime`. The one place that
// knows how to turn a curve name into actual AudioParam calls — shared by
// scheduleAutomationEvent (loop-position pattern automation) and scheduleRamp
// (one-off console ramps) so the two can't drift apart. `curve` selects the
// shape: "linear" (constant rate), "exponential" (clamped away from 0, since
// exponential ramps can't reach it), or "target" (an asymptotic approach via
// setTargetAtTime, using a quarter of the span as the time constant for a
// smoother settle).
function applyRamp(param, time, endTime, from, to, curve) {
    param.cancelScheduledValues(time);

    if (curve === "exponential") {
        param.setValueAtTime(Math.max(from, 0.0001), time);
        param.exponentialRampToValueAtTime(Math.max(to, 0.0001), endTime);
    } else if (curve === "target") {
        param.setValueAtTime(from, time);
        param.setTargetAtTime(to, time, (endTime - time) / 4);
    } else {
        param.setValueAtTime(from, time);
        param.linearRampToValueAtTime(to, endTime);
    }
};

// Applies one automation event's ramp to its target AudioParam starting at
// `time` (an absolute AudioContext timestamp the clock computed from the
// event's loop-relative beat).
export function scheduleAutomationEvent(time, event, secondsPerBeat) {
    const endTime = time + event.duration * secondsPerBeat;
    applyRamp(event.target, time, endTime, event.from, event.to, event.curve);
};

// Ramps a raw AudioParam from `from` to `to` over `durationSeconds`, starting
// at `startTime` (an absolute AudioContext timestamp; defaults to right now).
// This is the vehicle for one-off console ramps like `/track_1 gain=0 3` (see
// commands.js) — distinct from scheduleAutomationEvent's loop-position
// pattern automation, though both draw the curve identically via applyRamp.
// Passing an explicit `startTime` (e.g. clock.nextBeatTime()/nextCycleTime())
// is how a ramp gets deferred to the next beat/cycle instead of firing
// immediately.
export function scheduleRamp(audioContext, param, from, to, durationSeconds, { startTime, curve = "linear" } = {}) {
    const time = startTime ?? audioContext.currentTime;
    applyRamp(param, time, time + durationSeconds, from, to, curve);
};

// Writes a value onto an AudioParam at a specific (possibly future) time
// instead of assigning .value directly, so at=beat/at=cycle can defer a
// plain (non-ramped) set the same way scheduleRamp defers a ramp's start.
// Shared by commands.js's applyParams (console sets) and session.js's
// applySnapshot (/recall's non-ramped, instant-change fields) — the one
// place that knows how to do this, rather than two copies.
export function setInstant(audioContext, param, value, startTime) {
    const time = startTime ?? audioContext.currentTime;
    param.cancelScheduledValues(time);
    param.setValueAtTime(value, time);
};

// Runs `fn` at (approximately) absolute AudioContext time `time`. For work
// that can't ride native AudioParam scheduling the way a ramp/instant set
// can — structural graph changes (session.js's applySnapshot reconciling
// create/remove/reorder) or a plain non-AudioParam number like
// RibbitClock.loopLengthBeats (commands.js's /clock num_beats= at=) — this is
// the same "step it on a timer" compromise RibbitClock.rampBpm already makes
// for bpm, generalized to arbitrary deferred work.
export function scheduleAt(audioContext, time, fn) {
    const delayMs = Math.max(0, (time - audioContext.currentTime) * 1000);
    setTimeout(fn, delayMs);
};
