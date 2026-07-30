import { scheduleAutomationEvent } from "./automation.js";

// A lookahead scheduler: rather than triggering sounds exactly when a setTimeout
// fires (which drifts under load), it periodically looks a short window into the
// future and schedules anything due using precise AudioContext time. Every
// registered "unit" (synth, channel, or processor) is polled uniformly for
// in-range events/automation; a unit only needs `events`/`automation` arrays,
// `trigger()`, and an `active` flag to participate.
export class RibbitClock {
    constructor(audioContext, { bpm = 120, loopLengthBeats = 4, lookaheadMs = 25, scheduleAheadTime = 0.1 } = {}) {
        this.audioContext = audioContext;

        this.bpm = bpm;
        this.loopLengthBeats = loopLengthBeats;
        this.lookaheadMs = lookaheadMs;
        this.scheduleAheadTime = scheduleAheadTime;

        this.units = [];
        this.running = false;
        this.timerId = null;

        this.startTime = 0;
        this.scheduledUpTo = 0;

        // The highest loop index onCycle() has already been fired for, so a
        // boundary is announced exactly once however many scheduling passes
        // happen to land inside it. -1 means "not even cycle 0 yet".
        this._notifiedCycle = -1;

        this._bpmRampTimer = null;
    };

    get secondsPerBeat() {
        return 60 / this.bpm;
    };

    // Registers a unit (synth/channel/processor) to be polled for due
    // events/automation on every tick.
    addUnit(unit) {
        this.units.push(unit);
    };

    removeUnit(unit) {
        const index = this.units.indexOf(unit);
        if (index !== -1) this.units.splice(index, 1);
    };

    start() {
        if (this.running) return;
        this.running = true;
        this.startTime = this.audioContext.currentTime;
        this.scheduledUpTo = 0;
        // Beat position rewinds to 0, so cycle numbering does too — without
        // this, a restart would never re-announce cycle 0 and a unit that
        // regenerates on the boundary would sit on a stale pattern.
        this._notifiedCycle = -1;
        // A (re)start rewinds the absolute beat position to 0 — any unit
        // holding its own absolute-beat state (e.g. RibbitRandomNotes'
        // candidate-grid cursor) must reset it, or after a /stop /start it
        // would sit silently waiting for a beat number that's now far in the
        // future. Duck-typed and optional, like trigger()/generateEvents().
        for (const unit of this.units) unit.onClockStart?.();
        this._tick();
    };

    stop() {
        this.running = false;
        clearTimeout(this.timerId);
        this._cancelBpmRamp();
    };

    // Changes tempo without a glitch: if the clock is already running, shifts
    // startTime so the current playback beat is unchanged at the moment of the
    // switch (only the rate of beats going forward changes). Cancels any
    // in-flight rampBpm so a plain instant set always wins over a stale ramp.
    setBpm(bpm) {
        this._cancelBpmRamp();
        this._applyBpm(bpm);
    };

    _applyBpm(bpm) {
        if (this.running) {
            const now = this.audioContext.currentTime;
            const currentBeat = (now - this.startTime) / this.secondsPerBeat;
            this.bpm = bpm;
            this.startTime = now - currentBeat * this.secondsPerBeat;
        } else {
            this.bpm = bpm;
        }
    };

    // Glides bpm from its current value to targetBpm over durationSeconds.
    // bpm isn't a native AudioParam (it's a plain number the clock uses for
    // its own beat<->time math), so unlike gain/pan/wet this can't ride
    // linearRampToValueAtTime — instead this steps _applyBpm repeatedly on a
    // short timer, each step re-deriving startTime the same glitch-free way
    // setBpm always has. `startTime` (an AudioContext timestamp) defers the
    // ramp's start, e.g. for /clock bpm=140 8 at=cycle.
    rampBpm(targetBpm, durationSeconds, { startTime } = {}) {
        this._cancelBpmRamp();
        const beginTime = startTime ?? this.audioContext.currentTime;
        const startBpm = this.bpm;
        const stepMs = 15;

        const tick = () => {
            const now = this.audioContext.currentTime;
            if (now < beginTime) {
                this._bpmRampTimer = setTimeout(tick, stepMs);
                return;
            }

            const elapsed = now - beginTime;
            if (elapsed >= durationSeconds) {
                this._applyBpm(targetBpm);
                this._bpmRampTimer = null;
                return;
            }

            this._applyBpm(startBpm + (targetBpm - startBpm) * (elapsed / durationSeconds));
            this._bpmRampTimer = setTimeout(tick, stepMs);
        };
        this._bpmRampTimer = setTimeout(tick, 0);
    };

    _cancelBpmRamp() {
        if (this._bpmRampTimer) {
            clearTimeout(this._bpmRampTimer);
            this._bpmRampTimer = null;
        }
    };

    // Unlike setBpm, no rebasing is needed: _scheduleRange reads
    // loopLengthBeats fresh on every tick, so this takes effect on the next
    // tick. A change mid-loop can shift where the current loop boundary
    // falls, which is an accepted live-coding wrinkle rather than a bug.
    setLoopLengthBeats(beats) {
        this.loopLengthBeats = beats;
    };

    // Converts a beat position (loop-relative or absolute) into an absolute,
    // precise AudioContext timestamp suitable for scheduling.
    beatToTime(beat) {
        return this.startTime + beat * this.secondsPerBeat;
    };

    // The absolute (non-loop-relative) beat position right now.
    currentBeat() {
        return (this.audioContext.currentTime - this.startTime) / this.secondsPerBeat;
    };

    // The AudioContext time of the next upcoming integer beat boundary —
    // the anchor point for deferring a console ramp to "the next beat"
    // instead of firing immediately (see automation.js's scheduleRamp
    // `startTime` option).
    nextBeatTime() {
        return this.beatToTime(Math.floor(this.currentBeat()) + 1);
    };

    // The AudioContext time of the next loop boundary (the start of the next
    // pass through the pattern) — the anchor point for deferring a console
    // ramp to "the next cycle".
    nextCycleTime() {
        const currentLoopIndex = Math.floor(this.currentBeat() / this.loopLengthBeats);
        return this.beatToTime((currentLoopIndex + 1) * this.loopLengthBeats);
    };

    // Runs once per lookaheadMs: schedules anything due in the next
    // scheduleAheadTime seconds, then reschedules itself. Using setTimeout
    // (rather than requestAnimationFrame) keeps ticking in a backgrounded tab.
    // _scheduleRange is wrapped so a single bad event/param (e.g. a NaN that
    // throws inside a native AudioParam call) can only drop that one
    // scheduling pass rather than killing the reschedule below forever —
    // the whole engine going silent from one bad command is worse than
    // dropping the offending event.
    _tick() {
        const now = this.audioContext.currentTime;
        const horizonBeat = (now + this.scheduleAheadTime - this.startTime) / this.secondsPerBeat;

        try {
            this._scheduleRange(this.scheduledUpTo, horizonBeat);
        } catch (error) {
            console.error("RibbitClock: error scheduling range, skipping", error);
        }
        this.scheduledUpTo = horizonBeat;

        this.timerId = setTimeout(() => this._tick(), this.lookaheadMs);
    };

    // Schedules every unit's events/automation whose beat falls within
    // [fromBeat, toBeat). The pattern repeats every loopLengthBeats, so a beat
    // range is first split into per-loop-iteration sub-ranges (a lookahead
    // window can straddle a loop boundary) and each sub-range is translated
    // back to loop-relative beats before being matched against unit.events.
    _scheduleRange(fromBeat, toBeat) {
        const loopStart = Math.floor(fromBeat / this.loopLengthBeats);
        const loopEnd = Math.floor(toBeat / this.loopLengthBeats);

        for (let loopIndex = loopStart; loopIndex <= loopEnd; loopIndex++) {
            const loopBeatStart = loopIndex * this.loopLengthBeats;
            const rangeStart = Math.max(fromBeat, loopBeatStart) - loopBeatStart;
            const rangeEnd = Math.min(toBeat, loopBeatStart + this.loopLengthBeats) - loopBeatStart;

            // A new loop is about to be scheduled: announce the boundary to
            // any unit that wants to know, *before* that loop's events are
            // read. Optional and duck-typed, like generateEvents/onClockStart.
            //
            // This is the hook for "change something every N cycles" — a
            // generator re-rolling its pattern (RibbitPatternVariator), a
            // section advancing. It is deliberately not needed for merely
            // *playing* a pattern: generateEvents() takes absolute beats, so
            // all three older generators index straight off the step number
            // and need no boundary notification at all.
            //
            // Two properties worth knowing. It fires a lookahead window
            // *early*, in the same pass that schedules the cycle's first
            // events, which is exactly what a regenerating unit needs (it
            // must have rewritten its pattern before that pattern is read).
            // And cycleIndex is monotonic but not necessarily contiguous: if
            // a stall swallowed whole cycles, the skipped ones are not
            // replayed — regenerating N times for cycles nobody will hear is
            // strictly worse than landing on the current one.
            if (loopIndex > this._notifiedCycle) {
                this._notifiedCycle = loopIndex;
                for (const unit of this.units) {
                    if (unit.active === false) continue;
                    unit.onCycle?.(loopIndex);
                }
            }

            for (const unit of this.units) {
                // A paused track's synth, or a bypassed processor, stops being
                // scheduled entirely (both its events and its automation).
                if (unit.active === false) continue;

                for (const event of unit.events ?? []) {
                    if (event.beat >= rangeStart && event.beat < rangeEnd) {
                        const time = this.beatToTime(loopBeatStart + event.beat);
                        unit.trigger(time, event, this.secondsPerBeat);
                    }
                }

                for (const event of unit.automation ?? []) {
                    // `once` events (e.g. a one-time fade-in) fire on their first
                    // pass through this beat and never again on later loops.
                    if (event.once && event._scheduled) continue;
                    if (event.beat >= rangeStart && event.beat < rangeEnd) {
                        const time = this.beatToTime(loopBeatStart + event.beat);
                        scheduleAutomationEvent(time, event, this.secondsPerBeat);
                        event._scheduled = true;
                    }
                }

                // Event-generating modulators (e.g. RibbitRandomNotes) are the
                // discrete counterpart to a continuous CV signal: rather than a
                // fixed, loop-relative events array, generateEvents() is asked
                // for whatever it wants to fire in this absolute (non-looping)
                // beat range, so its own internal state (e.g. "beats since the
                // last note") advances forever instead of resetting every pass
                // through the loop. Generated notes go straight to whatever
                // synth(s) are patched into this modulator's ".notes" (see
                // ribbit.js's createPatch/RibbitEventPatch) — a manually-authored
                // pattern (unit.events, handled above) is untouched by this.
                if (typeof unit.generateEvents === "function") {
                    const fromBeat = loopBeatStart + rangeStart;
                    const toBeat = loopBeatStart + rangeEnd;
                    for (const event of unit.generateEvents(fromBeat, toBeat, this.secondsPerBeat)) {
                        const time = this.beatToTime(event.beat);
                        let delivered = false;
                        for (const destination of unit.eventDestinations ?? []) {
                            if (destination.source?.active === false) continue;
                            destination.source?.trigger(time, event, this.secondsPerBeat);
                            delivered = true;
                        }
                        // The AudioContext time of the latest note actually
                        // delivered somewhere — read by the mixer's
                        // ModulatorStrip to flash on each audible note,
                        // since an event generator's continuous `.output`
                        // (what the strip's meter taps for an LFO) reads a
                        // meaningless flat 0.
                        if (delivered) unit.lastEventTime = time;
                    }
                }
            }
        }
    };
};
