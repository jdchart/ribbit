import { RibbitParam } from "./param.js";

// A single "patch cable": connects a source's raw output (a modulator, or
// any other object exposing `.output` — a track/master's post-fader signal,
// a processor's post-effect signal) into a destination AudioParam, through
// its own depth (attenuator) gain node. Depth lives on the patch rather than
// the source or destination, so the same modulator can drive several
// destinations at different amounts, and removing one patch never touches
// either endpoint directly — it just tears down the one cable.
//
// `sourceObject`/`destObject` (plus the display-only `sourceName`/`destName`
// strings) are kept so Ribbit can cascade-remove a patch when either endpoint
// is itself removed (see ribbit.js's removeModulator/removeProcessor/removeTrack).
export class RibbitPatch {
    constructor(audioContext, { id, sourceObject, sourceName, destObject, destName, destParam, depth = 1 }) {
        this.id = id;
        this.sourceObject = sourceObject;
        this.sourceName = sourceName;
        this.destObject = destObject;
        this.destName = destName;
        this.destParam = destParam;

        this.depthGain = audioContext.createGain();
        this.depthGain.gain.value = depth;

        sourceObject.output.connect(this.depthGain);
        this.depthGain.connect(destParam);

        // Console/UI-facing control surface (see commands.js's applyParams),
        // same shape every other patchable object's params use.
        this.params = {
            depth: new RibbitParam(this.depthGain.gain),
        };
    };

    // Thin alias onto params.depth's own AudioParam (not a second
    // implementation) — used by patchSummary and a host patch-list UI for display.
    get depth() {
        return this.params.depth.audioParam;
    };

    disconnect() {
        this.sourceObject.output.disconnect(this.depthGain);
        this.depthGain.disconnect(this.destParam);
    };
};

// The discrete counterpart to RibbitPatch: connects an event-generating
// modulator (one exposing generateEvents() — see RibbitRandomNotes) into a
// track's synth, rather than a continuous signal into an AudioParam. There's
// no native Web Audio node to wire up (nothing is audio-rate here), so this
// is pure bookkeeping — the clock reads sourceObject.eventDestinations
// directly on every tick (see clock.js) to know where to deliver whatever
// generateEvents() just produced.
//
// destObject is the *channel* (a track), not its synth directly, so the
// patch keeps working across a synth= swap — same property RibbitPatch already
// has for gain/pan (both live on the channel, not the synth). No `depth`:
// unlike an AudioParam patch, there's nothing here to attenuate — the
// modulator's own params (e.g. probability) already shape what it generates,
// and the same generated stream reaches every destination this modulator is
// patched into, exactly like one LFO signal feeding several depths.
export class RibbitEventPatch {
    constructor({ id, sourceObject, sourceName, destObject, destName }) {
        this.id = id;
        this.sourceObject = sourceObject;
        this.sourceName = sourceName;
        this.destObject = destObject;
        this.destName = destName;
        this.params = {};

        sourceObject.eventDestinations.push(destObject);
    };

    disconnect() {
        const index = this.sourceObject.eventDestinations.indexOf(this.destObject);
        if (index !== -1) this.sourceObject.eventDestinations.splice(index, 1);
    };
};
