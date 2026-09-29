import { RibbitWorkletProcessor } from "../dsp/effect.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { workletParams } from "../dsp/spec.js";

// It listens, photographs the twelve strongest partials of what it hears, and
// answers as a robot — the AE machine's Spectra (`aem_fx_spectra`). "You never
// hear the input, only its machine double."
//
// **The photograph** (every `rate` sixteenth-note steps, fired with chance
// `snap`, or `photo=now` by hand): a 2048-point spectrum of the input, the
// twelve strongest peaks above `thresh` dB, folded down `oct` octaves and
// tilted low→high by `tilt`. `jump` is the chance a photograph *reshuffles*
// (its partials land on the strings in a scrambled order, octaves rolled)
// rather than follows. At snap 0 the chord holds forever. The photograph is
// the `photo` option — so a saved session, and a /recall, speak its chord at
// once.
//
// **The robot**: an eight-band vocoder plus a chest band below 140Hz. The
// input is the modulator; the carrier is six of the photograph's partials,
// ring-modulated against each other by `ring` (low: a polite robot; high:
// alien metal). The analysis bands sit where drums speak, the carrier bands
// are shifted down by `sink`, so bright material drives a deep voice: a kick
// opens the chest, a hat articulates the consonants. `tight` is the release,
// soft and sung to 12ms surgical.
//
// **The strings**: twelve feedback combs tuned to the photograph folded into a
// low window (`sink` moves it too), each with an allpass in its loop that
// stretches partials the way stiffness does — carillon, not organ. The robot
// excites them; `bloom` couples them in a ring so chords bloom out of hits;
// `decay` (s) is their ring, `feed` stretches it up to fourfold, `damp`
// darkens them. `grime` drives robot and strings, `robo` balances strings (0)
// against robot (1), `width`/`wash` spread and veil it, `mix` is the return's
// level. Put `lossyverb` after it on the same bus for the manual's LSYX.
export const SPECTRA_PARAMS = {
    rate: { value: 16, min: 1, max: 64 },
    snap: { value: 50, min: 0, max: 100 },
    jump: { value: 10, min: 0, max: 100 },
    thresh: { value: -60, min: -90, max: -10 },
    decay: { value: 2, min: 0.1, max: 10 },
    ring: { value: 0.3, min: 0, max: 1 },
    tight: { value: 0.4, min: 0, max: 1 },
    sink: { value: 0.3, min: 0, max: 1 },
    bloom: { value: 0.2, min: 0, max: 1 },
    feed: { value: 0.2, min: 0, max: 1 },
    grime: { value: 0.1, min: 0, max: 1 },
    damp: { value: 0.4, min: 0, max: 1 },
    robo: { value: 0.5, min: 0, max: 1 },
    oct: { value: 0, min: 0, max: 6 },
    tilt: { value: 0, min: -1, max: 1 },
    width: { value: 0.6, min: 0, max: 1 },
    wash: { value: 0.2, min: 0, max: 1 },
    mix: { value: 1, min: 0, max: 1 },
};

const DEFAULT_PHOTO = [[110, 1], [220, 0.7], [330, 0.5], [415, 0.4], [554, 0.35], [660, 0.3], [831, 0.25], [990, 0.2], [1245, 0.18], [1480, 0.15], [1760, 0.12], [2217, 0.1]];

export function spectraProcessor(Base, DSP) {
    const { SR, TAU, clamp, tanh, sinT, fft, Biquad, OnePole, Delay, Allpass, Allpass1, Rng, effectProcessor } = DSP;
    const BANDS = [180, 300, 500, 800, 1300, 2100, 3400, 5500];
    const FFT = 2048;

    const Processor = effectProcessor(Base, {
        setup() {
            this.sines = new Float64Array(6);
            this.carrierFreq = new Float64Array(6).fill(110);
            this.ring = new Float32Array(FFT);
            this.ringPos = 0;
            this.re = new Float32Array(FFT);
            this.im = new Float32Array(FFT);
            this.rng = new Rng(0x5bec);
            this.photo = (this.opts.photo && this.opts.photo.length ? this.opts.photo : null) || [[110, 1]];
            this.order = this.photo.map((_, i) => i);
            this.analysis = BANDS.map((f) => new Biquad("bandpass", f, 4));
            this.synthesis = BANDS.map((f) => new Biquad("bandpass", f, 4));
            this.chestIn = new Biquad("lowpass", 140, 0.7);
            this.chestOut = new Biquad("lowpass", 140, 0.7);
            this.env = new Float64Array(BANDS.length + 1);
            this.carrierPhase = new Float64Array(6);
            this.strings = [];
            for (let s = 0; s < 12; s++) {
                this.strings.push({ line: new Delay(Math.ceil(SR / 20) + 8), lp: new OnePole(4000), ap: new Allpass1(0.35), period: SR / 110, out: 0 });
            }
            this.washL = [new Allpass(Math.round(0.0131 * SR), 0.6), new Allpass(Math.round(0.0217 * SR), 0.55)];
            this.washR = [new Allpass(Math.round(0.0149 * SR), 0.6), new Allpass(Math.round(0.0241 * SR), 0.55)];
            this.lastSink = -1;
            this.lastOct = -1;
            this.retune = true;
        },
        onMessage(m) {
            if (m.type === "photo") this.snapshot(m.follow !== false, m.thresh);
            else if (m.type === "set_photo") {
                this.photo = m.photo;
                this.order = this.photo.map((_, i) => i);
                this.retune = true;
            }
        },
        render(inL, inR, outL, outR, P, frames) {
            if (this.retune || P.sink !== this.lastSink || P.oct !== this.lastOct) this.tune(P);
            const tightRelease = Math.exp(-1 / ((0.3 - 0.288 * P.tight) * SR));
            const attack = Math.exp(-1 / (0.002 * SR));
            const decay = P.decay * (1 + P.feed * 3);
            const grime = 1 + P.grime * 5;
            const grimeNorm = 1 / tanh(grime);
            const ringAmount = P.ring;
            const bloom = P.bloom * 0.08;
            const robo = P.robo;
            const mix = P.mix;
            const dampHz = 300 + 9000 * (1 - P.damp) * (1 - P.damp);
            for (const string of this.strings) {
                string.lp.set(dampHz);
                string.gain = Math.pow(0.001, string.period / (decay * SR));
            }
            const carriers = this.carrierFreq;
            for (let i = 0; i < frames; i++) {
                const x = (inL[i] + inR[i]) * 0.5;
                this.ring[this.ringPos] = x;
                this.ringPos = (this.ringPos + 1) % FFT;

                // Robot: the carrier, six photograph partials ring-modulated.
                let c = 0;
                const s = this.sines;
                for (let k = 0; k < 6; k++) {
                    this.carrierPhase[k] += carriers[k] / SR;
                    if (this.carrierPhase[k] >= 1) this.carrierPhase[k] -= 1;
                    s[k] = sinT(this.carrierPhase[k]);
                    c += s[k];
                }
                c = c / 6 * (1 - ringAmount) + (s[0] * s[1] + s[2] * s[3] + s[4] * s[5]) * ringAmount;

                let robot = 0;
                for (let b = 0; b < BANDS.length; b++) {
                    const a = Math.abs(this.analysis[b].process(x));
                    const e = this.env[b];
                    this.env[b] = a + (e - a) * (a > e ? attack : tightRelease);
                    robot += this.synthesis[b].process(c) * this.env[b];
                }
                const chest = Math.abs(this.chestIn.process(x));
                const ce = this.env[BANDS.length];
                this.env[BANDS.length] = chest + (ce - chest) * (chest > ce ? attack : tightRelease);
                robot += this.chestOut.process(c) * this.env[BANDS.length] * 2;
                robot = tanh(robot * 6 * grime) * grimeNorm * 0.3;

                // Strings, excited by the robot, coupled in a ring by bloom.
                let sl = 0, sr = 0;
                const strings = this.strings;
                for (let k = 0; k < 12; k++) {
                    const string = strings[k];
                    const back = string.ap.process(string.lp.lp(string.line.read(string.period - 2))) * string.gain;
                    const neighbour = strings[(k + 11) % 12].out;
                    const v = tanh((robot * 0.2 + back + neighbour * bloom) * grime) / grime;
                    string.line.write(v);
                    string.out = v;
                    if (k & 1) sr += v * string.amp; else sl += v * string.amp;
                }
                let l = robot * robo + sl * (1 - robo) * 0.5;
                let r = robot * robo + sr * (1 - robo) * 0.5;
                const mid = (l + r) * 0.5, side = (l - r) * 0.5 * P.width;
                l = mid + side;
                r = mid - side;
                if (P.wash > 0) {
                    const wl = this.washL[1].process(this.washL[0].process(l));
                    const wr = this.washR[1].process(this.washR[0].process(r));
                    l += (wl - l) * P.wash;
                    r += (wr - r) * P.wash;
                }
                outL[i] = l * mix;
                outR[i] = r * mix;
            }
        },
    });

    // Takes the photograph: the twelve strongest spectral peaks of the last
    // 2048 samples above `thresh` dB. `follow` false reshuffles which string
    // each partial lands on, and rolls some of them an octave.
    Processor.prototype.snapshot = function snapshot(follow, thresh) {
        const re = this.re, im = this.im;
        for (let i = 0; i < FFT; i++) {
            const w = 0.5 - 0.5 * Math.cos((TAU * i) / FFT);
            re[i] = this.ring[(this.ringPos + i) % FFT] * w;
            im[i] = 0;
        }
        fft(re, im);
        const half = FFT / 2;
        const mags = new Float32Array(half);
        for (let k = 0; k < half; k++) mags[k] = Math.hypot(re[k], im[k]) / (FFT / 4);
        const floor = Math.pow(10, (thresh ?? this.P.thresh ?? -60) / 20);
        const peaks = [];
        for (let k = 2; k < half - 1; k++) {
            if (mags[k] > floor && mags[k] >= mags[k - 1] && mags[k] > mags[k + 1]) {
                const a = mags[k - 1], b = mags[k], c = mags[k + 1];
                const d = (a - c) / (2 * (a - 2 * b + c) || 1);
                peaks.push([((k + clamp(d, -0.5, 0.5)) * SR) / FFT, b]);
            }
        }
        if (peaks.length === 0) return;
        peaks.sort((x, y) => y[1] - x[1]);
        const top = peaks.slice(0, 12).sort((x, y) => x[0] - y[0]);
        const peak = top.reduce((m, p) => Math.max(m, p[1]), 0) || 1;
        this.photo = top.map(([f, a]) => [f, a / peak]);
        this.order = this.photo.map((_, i) => i);
        if (!follow) {
            for (let i = this.order.length - 1; i > 0; i--) {
                const j = Math.floor(this.rng.next() * (i + 1));
                const t = this.order[i]; this.order[i] = this.order[j]; this.order[j] = t;
            }
            this.photo = this.photo.map(([f, a]) => [f * (this.rng.next() < 0.3 ? (this.rng.next() < 0.5 ? 0.5 : 2) : 1), a]);
        }
        this.retune = true;
        this.port.postMessage({ type: "photo", photo: this.photo });
    };

    // Retunes carrier, synthesis bands and strings from the photograph and
    // the sink/oct/tilt controls.
    Processor.prototype.tune = function tune(P) {
        this.retune = false;
        this.lastSink = P.sink;
        this.lastOct = P.oct;
        const down = Math.pow(2, -P.oct);
        const sink = Math.pow(2, -P.sink * 2);
        const photo = this.photo;
        const n = photo.length;
        // Carriers: the six strongest partials.
        const strongest = photo.map((p, i) => [p[1], i]).sort((a, b) => b[0] - a[0]).slice(0, 6);
        for (let k = 0; k < 6; k++) {
            const entry = strongest[k % strongest.length];
            this.carrierFreq[k] = clamp(photo[entry[1]][0] * down, 20, SR * 0.4);
        }
        for (let b = 0; b < BANDS.length; b++) this.synthesis[b].set("bandpass", Math.max(40, BANDS[b] * sink), 4);
        this.chestOut.set("lowpass", Math.max(30, 140 * sink), 0.7);
        // Strings: each partial folded into a low window, amplitude tilted.
        const lo = 80 * Math.pow(2, -P.sink * 1.5), hi = lo * 8;
        for (let s = 0; s < 12; s++) {
            const string = this.strings[s];
            const index = s < n ? this.order[s] : s % n;
            let f = photo[index][0] * down;
            while (f > hi) f /= 2;
            while (f < lo) f *= 2;
            string.period = SR / f;
            const position = n > 1 ? index / (n - 1) : 0.5;
            string.amp = photo[index][1] * Math.exp((P.tilt || 0) * 1.5 * (position * 2 - 1)) * (s < n ? 1 : 0.4);
        }
    };

    return Processor;
};

registerWorkletProcessor("ribbit-spectra", spectraProcessor, workletParams(SPECTRA_PARAMS));

function formatPhoto(photo) {
    return photo.map(([f, a]) => `${Number(f.toFixed(1))}:${Number(a.toFixed(3))}`).join(",");
};

function parsePhoto(value) {
    if (Array.isArray(value)) return value.map(([f, a]) => [Number(f), Number(a)]);
    const photo = String(value).split(",").map((entry) => entry.split(":").map(Number));
    if (photo.length === 0 || photo.length > 12 || photo.some(([f, a]) => !(f > 0) || !Number.isFinite(a))) {
        throw new Error(`invalid photo "${value}" — expected now, or up to 12 frequency:amplitude pairs like 110:1,220:0.5`);
    }
    return photo;
};

const STEP_BEATS = 0.25;

export class RibbitSpectra extends RibbitWorkletProcessor {
    constructor(audioContext, options = {}) {
        const photo = options.photo ? parsePhoto(options.photo) : DEFAULT_PHOTO;
        super(audioContext, { name: "spectra", ...options }, {
            processor: "ribbit-spectra",
            params: SPECTRA_PARAMS,
            processorOptions: { photo },
        });
        this.llm_summary = "Photographs the 12 strongest partials of its input and answers as a robot (the AE machine's spectra): an 8-band vocoder + chest band whose carrier is the photograph ring-modulated (ring), shifted down by sink, plus 12 sympathetic strings tuned to the photo (decay/feed/bloom/damp). robo balances strings vs robot. Photos every rate steps with chance snap (jump = reshuffle); photo=now by hand; oct folds the photo down. You never hear the input.";
        this.photo = photo;
        this._step = null;
        this._random = Math.random;
        this.options = {
            // The photograph as frequency:amplitude pairs — saved with the
            // session, so a recalled scene speaks its chord at once. `now`
            // takes one from whatever is playing.
            photo: {
                get: () => formatPhoto(this.photo),
                set: (value) => {
                    if (String(value).trim().toLowerCase() === "now") {
                        this.send({ type: "photo", follow: true });
                        return;
                    }
                    this.photo = parsePhoto(value);
                    this.send({ type: "set_photo", photo: this.photo });
                },
            },
        };
        this.onWorkletMessage = (message) => {
            if (message.type === "photo") this.photo = message.photo;
        };
    };

    // Processors are clock units too: count sixteenth-note steps and fire a
    // photograph every `rate` of them, if `snap` lets it.
    onSchedule(fromBeat, toBeat, secondsPerBeat, clock) {
        if (this._step === null || this._step < fromBeat) this._step = Math.ceil(fromBeat / STEP_BEATS) * STEP_BEATS;
        const every = Math.max(1, Math.round(this.params.rate.get()));
        while (this._step < toBeat) {
            const index = Math.round(this._step / STEP_BEATS);
            if (index % every === 0 && Math.random() * 100 < this.params.snap.get()) {
                const follow = Math.random() * 100 >= this.params.jump.get();
                this.send({ type: "photo", follow }, clock.beatToTime(this._step));
            }
            this._step += STEP_BEATS;
        }
    };

    onClockStart() {
        this._step = null;
    };

    // The Spectra jumper: rate, jump, grain (tight), metal (ring), octave.
    jump(random, time) {
        this.setParamAt("rate", [4, 8, 16, 32][Math.floor(random() * 4)], time);
        this.setParamAt("jump", random() * 60, time);
        this.setParamAt("tight", random(), time);
        this.setParamAt("ring", random(), time);
        this.setParamAt("oct", Math.floor(random() * 3), time);
    };

    describeState() {
        const lowest = this.photo.slice(0, 4).map(([f]) => `${Math.round(f)}Hz`).join(" ");
        return `[photo: ${this.photo.length} partials from ${lowest}${this.photo.length > 4 ? " …" : ""}]`;
    };
};

