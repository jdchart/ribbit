import { RibbitChannel } from "./channel.js";

// An RibbitChannel (fader/pan/inserts) plus a `.source` synth feeding it. This
// is the "track" a user creates with /add_track — its own gain/pan/insert
// chain is inherited from RibbitChannel; the only thing added here is owning
// and swapping out the sound source.
export class RibbitTrack extends RibbitChannel {
    constructor(audioContext, source, options = {}) {
        super(audioContext, options);
        this.source = source;
        source.output.connect(this.input);
    };

    // Swaps this track's synth at runtime (used by /track_1 synth=...)
    // without touching gain, pan, or the processor insert chain.
    setSource(newSource) {
        this.source.output.disconnect();
        this.source = newSource;
        newSource.output.connect(this.input);
    };
};
