import { RibbitParam } from "./param.js";
import { positionToGain, gainToPosition } from "./taper.js";

// Base class for anything with a fader, pan, and an insert chain of
// processors: the master bus and every RibbitTrack. Owns the actual Web Audio
// nodes for that signal path and keeps them wired correctly as processors are
// added, removed, or bypassed. Not itself a sound source — RibbitTrack adds a
// `.source` synth on top of this.
export class RibbitChannel {
    constructor(audioContext, { name = "channel" } = {}) {
        this.name = name;

        this.audioContext = audioContext;
        this.input = audioContext.createGain();
        this.panner = audioContext.createStereoPanner();
        this.gainNode = audioContext.createGain();

        this.panner.connect(this.gainNode);

        this.processors = [];
        this.automation = [];

        // Every place this channel's post-fader signal is currently being fed
        // — see addSend/removeSend/connect below. Independent of the insert
        // chain (_rewireChain never touches these; they hang off gainNode,
        // downstream of it).
        this.sends = [];
        this._sendIdCounter = 0;

        // Console/UI-facing control surface (see commands.js's applyParams) —
        // gain is a 0-1 position, exponentially tapered onto the actual
        // (also 0-1) AudioParam value for perceptually-even steps; pan is
        // linear -1..1 straight onto its AudioParam. Same shape every
        // processor/modulator/patch uses for their own params.
        this.params = {
            gain: new RibbitParam(this.gainNode.gain, { decode: gainToPosition, encode: positionToGain, min: 0, max: 1 }),
            pan: new RibbitParam(this.panner.pan, { min: -1, max: 1 }),
        };

        this._rewireChain();
    };

    get volume() {
        return this.gainNode.gain;
    };

    get pan() {
        return this.panner.pan;
    };

    // Post-fader signal, exposed under the same name every other patchable
    // object (RibbitSynth, RibbitProcessor, RibbitModulator) uses for its output —
    // lets a track or master double as a patch source (see patch.js), e.g.
    // sidechaining one track's level into another's gain.
    get output() {
        return this.gainNode;
    };

    addAutomation(event) {
        this.automation.push(event);
        return event;
    };

    // Adds one more feed from this channel's post-fader signal to
    // `destination` (another channel, e.g. a bus/master, or a raw AudioNode),
    // through its own gain — independent of every other send this channel
    // already has, so the same signal can feed several places at once at
    // different levels (e.g. dry to master, a wet send to a reverb bus).
    // `destName` is only for display (see channelSummary/patchSummary-style
    // reporting); it's whatever name the caller resolved `destination` from.
    addSend(destination, { destName, gain = 1 } = {}) {
        if (destination === this) {
            throw new Error(`"${this.name}" cannot send to itself`);
        }

        const sendGain = this.audioContext.createGain();
        sendGain.gain.value = gain;
        this.gainNode.connect(sendGain);
        sendGain.connect(destination.input ?? destination);

        const send = {
            id: `s${++this._sendIdCounter}`,
            destination,
            destName: destName ?? destination.name ?? "?",
            params: { gain: new RibbitParam(sendGain.gain, { min: 0 }) },
            _node: sendGain,
        };
        this.sends.push(send);
        return send;
    };

    removeSend(id) {
        const index = this.sends.findIndex((s) => s.id === id);
        if (index === -1) return false;

        const [removed] = this.sends.splice(index, 1);
        removed._node.disconnect();
        return true;
    };

    // Replaces every existing send with a single one to `destination` at
    // gain 1 — the common case (a track feeding exactly one place) expressed
    // as sugar over the general multi-send model above (see also the
    // console's `out=` param in commands.js).
    connect(destination, destName) {
        for (const send of [...this.sends]) this.removeSend(send.id);
        return this.addSend(destination, { destName });
    };

    // Inserts a processor into the chain at `index` (default: appended at the
    // end) and rebuilds the actual node connections to include it.
    addProcessor(processor, index = this.processors.length) {
        this.processors.splice(index, 0, processor);
        processor._channel = this;
        this._rewireChain();
        return processor;
    };

    removeProcessor(id) {
        const index = this.processors.findIndex((p) => p.id === id);
        if (index === -1) return false;

        const [removed] = this.processors.splice(index, 1);
        // The removed processor is no longer walked by _rewireChain, so its own
        // outgoing edge to whatever came after it would otherwise dangle.
        removed.output.disconnect();
        removed._channel = null;
        // Once spliced out, _rewireChain's own _chainTarget-clearing loop
        // never sees this processor again (it only walks this.processors),
        // so without this the blanket disconnect() above leaves a stale
        // _chainTarget behind. Harmless if `removed` is discarded, but if
        // the same instance is ever re-added later (e.g. session.js's
        // /recall reordering a channel's chain in place), the next
        // _rewireChain() would try to disconnect(that stale target) against
        // an output already fully disconnected — throwing, since that
        // specific edge no longer exists.
        removed._chainTarget = null;

        this._rewireChain();
        return true;
    };

    // Toggles a processor's routing bypass (distinct from a track's own
    // transport start/stop) and rebuilds the chain to route around it.
    setProcessorActive(id, active) {
        const processor = this.processors.find((p) => p.id === id);
        if (!processor) return false;
        processor.active = active;
        this._rewireChain();
        return true;
    };

    // Rebuilds the actual node graph from scratch: input -> each active
    // processor in order (inactive ones are skipped/bypassed entirely, not
    // just muted) -> panner -> gainNode. This is the only place nodes are
    // connected/disconnected; every mutating method above just edits the
    // `processors` array and calls this to make the graph match it.
    //
    // Tears down only the specific chain-internal edge each source (this.input,
    // or a processor's own output) was last connected to (tracked in
    // this._chainTarget / processor._chainTarget), rather than a blanket
    // .disconnect() — a processor's output can also be a patch source (see
    // patch.js) or, in principle, a standalone RibbitProcessor.connect() target;
    // a blanket disconnect would silently tear that external connection down
    // too every time an unrelated processor elsewhere in this same chain is
    // added/removed/bypassed.
    _rewireChain() {
        if (this._chainTarget) {
            this.input.disconnect(this._chainTarget);
            this._chainTarget = null;
        }
        for (const processor of this.processors) {
            if (processor._chainTarget) {
                processor.output.disconnect(processor._chainTarget);
                processor._chainTarget = null;
            }
        }

        let node = this.input;
        let prevOwner = null; // null while `node` is still this.input
        for (const processor of this.processors) {
            if (!processor.active) continue;
            node.connect(processor.input);
            if (prevOwner) prevOwner._chainTarget = processor.input;
            else this._chainTarget = processor.input;

            node = processor.output;
            prevOwner = processor;
        }

        node.connect(this.panner);
        if (prevOwner) prevOwner._chainTarget = this.panner;
        else this._chainTarget = this.panner;
    };
};
