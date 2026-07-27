import { RibbitModulator } from "../modulator.js";
import { RibbitParam } from "../param.js";
import { RibbitEvent } from "../event.js";
import { parseDegreeList } from "../harmony.js";

// An event-generating modulator: instead of a continuous signal on
// `this.output` (like RibbitLFO), this produces discrete RibbitEvent notes on the
// fly and delivers them to whatever synth(s) are patched into its ".notes"
// destination (/patch source=<this> dest=<track>.notes — see ribbit.js's
// createPatch and RibbitEventPatch). Algorithmic/generated notes live
// alongside, not instead of, a synth's manually-authored `events` pattern —
// this never touches that array.
//
// Generation walks a fixed-spacing candidate grid (min_gap beats apart,
// starting wherever the clock first asks): at each slot, probability decides
// whether a note actually fires, and if so a random entry from `scale` (a
// list of harmony-context scale degrees, resolved the same way a manually
// add_event'd degree is — see harmony.js) is picked. min_gap is therefore
// both "how often a note *could* happen" and the hard floor on spacing
// between notes; probability thins that grid out rather than controlling
// density independently of it.
export class RibbitRandomNotes extends RibbitModulator {
    constructor(audioContext, { name = "randomnotes", probability = 0.5, min_gap = 1, scale = [0, 2, 4, 5, 7, 9, 11] } = {}) {
        super(audioContext, { name });
        this.llm_summary = "Generates random note events (probability/min-gap/scale) and feeds a synth's control input via /patch dest=<track>.notes — doesn't touch manually-authored events.";

        // Not an RibbitParam (a list of degrees, not a single ramp-able value)
        // but runtime-settable as an option — /rand1 scale=0,3,5,7,10 —
        // taking effect from the next generated note. Round-tripped via the
        // base getOptions(), like RibbitLFO's waveform.
        this.scale = parseDegreeList(scale);
        this.options = {
            scale: {
                get: () => this.scale,
                set: (value) => { this.scale = parseDegreeList(value); },
            },
        };

        // probability/min_gap still ride real AudioParams (via a silent
        // ConstantSourceNode per param) purely so they get the exact same
        // get/set/ramp/at= machinery every other param has (applyParams in
        // commands.js) — e.g. `/rand1 probability=0.9 4b` — rather than a
        // second, param-shaped-but-not-really config surface. Each is routed
        // through a muted (gain 0) sink into audioContext.destination —
        // Web Audio quirk: a node with literally no path into the rendered
        // graph can have scheduled automation (setValueAtTime, which every
        // deferred/at= set or /recall ride — see automation.js's setInstant)
        // silently never reflected back in later .value reads, even though a
        // *direct* .value= assignment (like the line above) always works.
        // Routed-but-silent keeps it live without ever being audible.
        this._probabilitySource = audioContext.createConstantSource();
        this._probabilitySource.offset.value = Math.min(1, Math.max(0, probability));
        this._probabilitySource.start();
        this._silentSink(audioContext, this._probabilitySource);

        this._minGapSource = audioContext.createConstantSource();
        this._minGapSource.offset.value = Math.max(0.0625, min_gap);
        this._minGapSource.start();
        this._silentSink(audioContext, this._minGapSource);

        this.params = {
            probability: new RibbitParam(this._probabilitySource.offset, { min: 0, max: 1 }),
            min_gap: new RibbitParam(this._minGapSource.offset, { min: 0.0625, max: 16 }),
        };

        // Channels (tracks) currently patched into this modulator's .notes —
        // maintained by RibbitEventPatch's constructor/disconnect(), read by
        // RibbitClock on every tick (see clock.js). Empty until /patch'd.
        this.eventDestinations = [];

        // Absolute (non-loop-relative) beat of the next slot to roll the dice
        // on — undefined until the first generateEvents() call, which seeds it
        // to that call's own fromBeat rather than 0, so a modulator patched in
        // mid-session doesn't try to "catch up" on every slot since beat 0.
        this._nextCandidateBeat = undefined;
    };

    // Called by RibbitClock once per tick per absolute (non-looping) beat range
    // — see clock.js. Returns whatever RibbitEvent notes should fire in
    // [fromBeat, toBeat); their own `.beat` is that absolute beat (used by the
    // clock to compute a real AudioContext time), not loop-relative like a
    // synth's own authored events.
    generateEvents(fromBeat, toBeat) {
        if (this._nextCandidateBeat === undefined) this._nextCandidateBeat = fromBeat;

        const probability = this.params.probability.get();
        const minGap = this.params.min_gap.get();

        const events = [];
        while (this._nextCandidateBeat < toBeat) {
            if (Math.random() < probability) {
                const degree = this.scale[Math.floor(Math.random() * this.scale.length)];
                events.push(new RibbitEvent({ beat: this._nextCandidateBeat, degree }));
            }
            this._nextCandidateBeat += minGap;
        }
        return events;
    };

    // Called by RibbitClock.start() (duck-typed, like generateEvents): a clock
    // (re)start rewinds absolute beats to 0, so the candidate cursor must
    // reseed off the first post-restart generateEvents() range — otherwise a
    // /stop /start would leave it stranded at the pre-stop beat number,
    // generating nothing until the clock caught back up to it.
    onClockStart() {
        this._nextCandidateBeat = undefined;
    };

    // See the constructor comment above — a muted (gain 0) path into
    // audioContext.destination keeps `source`'s AudioParam automation live.
    // Tracked in this._sinks so dispose() can tear it down again.
    _silentSink(audioContext, source) {
        const sink = audioContext.createGain();
        sink.gain.value = 0;
        source.connect(sink).connect(audioContext.destination);
        (this._sinks ??= []).push(sink);
    };

    // Called by Ribbit.removeModulator (duck-typed, like generateEvents above)
    // so the silent destination-routed sinks above don't outlive this
    // modulator — ribbit.removeModulator's own generic `output.disconnect()`
    // never touches them, since they're not on this.output.
    dispose() {
        this._probabilitySource.stop();
        this._minGapSource.stop();
        for (const sink of this._sinks ?? []) sink.disconnect();
    };
};
