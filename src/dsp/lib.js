// The DSP toolkit every ribbit AudioWorklet processor is written against.
//
// This whole function is *stringified* into the worklet module (see
// worklet.js) and called once there, so it must be completely
// self-contained: no imports, no references to anything outside its own
// body. That's also why it's a function returning an object rather than a
// module of exports — a module can't be sent to an AudioWorkletGlobalScope as
// source text, and the function's `toString()` can. The same property makes
// it testable in Node: define `sampleRate`/`currentTime` globals, call
// `dspLibrary()`, and every class here runs unchanged.
//
// Conventions, so the processors read the same way:
//   - everything runs per sample, allocates nothing after construction, and
//     keeps its state in plain fields;
//   - frequencies are in Hz, times in seconds, gains linear;
//   - a `set*()` call may be expensive (a tan(), an exp()); `process()` is
//     cheap. Processors call set at k-rate unless a voice is genuinely
//     sweeping (a kick's pitch drop), where per-sample set is the point.
export function dspLibrary() {
    const SR = typeof sampleRate !== "undefined" ? sampleRate : 48000;
    const TAU = Math.PI * 2;

    const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
    const lerp = (a, b, t) => a + (b - a) * t;
    const mtof = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
    const dbToGain = (db) => Math.pow(10, db / 20);
    // The note's pitch class, placed within six semitones of `base` — how a
    // voice whose register is its own (a sub bass, a drone, a snare body)
    // still follows a note: the note picks *which* pitch, the voice's own
    // PITCH control picks *where*. Fractional notes stay fractional.
    const registerPitch = (base, note) => base + ((((note - base) % 12) + 18) % 12) - 6;

    // Per-sample multiplier that falls 60dB in `seconds` — the "decay time"
    // every resonator, envelope and tail in the library is specified by.
    const t60 = (seconds) => (seconds <= 0 ? 0 : Math.exp(-6.907755 / (seconds * SR)));
    // One-pole smoothing coefficient for a time constant, for parameter glides.
    const smoothing = (seconds) => (seconds <= 0 ? 0 : Math.exp(-1 / (seconds * SR)));

    // ── Nonlinearities ──────────────────────────────────────────────────
    // A rational tanh: exact at 0, within 2% everywhere, and hard-limited to
    // ±1 outside ±3 where the rational form turns back.
    const tanh = (x) => {
        if (x > 3) return 1;
        if (x < -3) return -1;
        const x2 = x * x;
        return (x * (27 + x2)) / (27 + 9 * x2);
    };
    // A triangle wavefolder: identity inside ±1, and past it the waveform
    // folds back rather than clipping — the source of "hard upper harmonics".
    const fold = (x) => {
        const t = (x + 1) * 0.25;
        return 1 - 4 * Math.abs(t - Math.floor(t) - 0.5);
    };
    // Asymmetric saturation: a biased tanh with its DC removed at rest, so
    // positive and negative half-waves bend differently — even harmonics,
    // the "valve"/tape colour.
    const asym = (x, bias) => tanh(x + bias) - tanh(bias);

    // A percussive envelope's level at progress x (0 at the strike, 1 at
    // the end) for a CURVE control in -1..1: negative is snappier (a fast
    // initial drop, the AE voices' "tighter"), 0 linear, positive holds
    // before falling. (1-x)^p with p = 8^-curve.
    const curveEnv = (x, curve) => (x >= 1 ? 0 : Math.pow(1 - x, Math.pow(8, -curve)));

    // ── Randomness ──────────────────────────────────────────────────────
    // xorshift32: fast enough to be a noise source, seedable so a voice's
    // "random" per-hit variation can be reproduced.
    class Rng {
        constructor(seed = 0x9e3779b9) {
            this.s = (seed >>> 0) || 0x9e3779b9;
        }
        next() {
            let s = this.s;
            s ^= s << 13; s >>>= 0;
            s ^= s >>> 17;
            s ^= s << 5; s >>>= 0;
            this.s = s;
            return s / 4294967296;
        }
        bi() {
            return this.next() * 2 - 1;
        }
        // Approximately gaussian (sum of four uniforms), unit variance.
        gauss() {
            return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
        }
    }

    // ── Filters ─────────────────────────────────────────────────────────
    // One-pole lowpass; `.hp(x)` is the complementary highpass.
    class OnePole {
        constructor(freq = 1000) {
            this.y = 0;
            this.set(freq);
        }
        set(freq) {
            this.a = Math.exp(-TAU * clamp(freq, 1, SR * 0.49) / SR);
        }
        lp(x) {
            this.y = x + (this.y - x) * this.a;
            return this.y;
        }
        hp(x) {
            return x - this.lp(x);
        }
    }

    // Topology-preserving state-variable filter (Zavalishin / Cytomic).
    // Stable under per-sample cutoff modulation, which is why it's the
    // library's default resonant filter: a biquad recomputing coefficients
    // every sample can blow up, this can't. One call gives all three outputs.
    class SVF {
        constructor(freq = 1000, q = 0.707) {
            this.ic1 = 0; this.ic2 = 0;
            this.low = 0; this.band = 0; this.high = 0;
            this.set(freq, q);
        }
        set(freq, q) {
            const g = Math.tan(Math.PI * clamp(freq, 5, SR * 0.49) / SR);
            this.k = 1 / Math.max(0.05, q);
            this.a1 = 1 / (1 + g * (g + this.k));
            this.a2 = g * this.a1;
            this.a3 = g * this.a2;
        }
        process(x) {
            const v3 = x - this.ic2;
            const v1 = this.a1 * this.ic1 + this.a2 * v3;
            const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
            this.ic1 = 2 * v1 - this.ic1;
            this.ic2 = 2 * v2 - this.ic2;
            this.low = v2;
            this.band = v1;
            this.high = x - this.k * v1 - v2;
            return v2;
        }
        reset() {
            this.ic1 = this.ic2 = 0;
        }
    }

    // RBJ-cookbook biquad, direct form I. For fixed or k-rate filters
    // (crossovers, band splits, a vocoder's analysis bank).
    class Biquad {
        constructor(type = "lowpass", freq = 1000, q = 0.707, gainDb = 0) {
            this.x1 = this.x2 = this.y1 = this.y2 = 0;
            this.set(type, freq, q, gainDb);
        }
        set(type, freq, q = 0.707, gainDb = 0) {
            const w = TAU * clamp(freq, 5, SR * 0.49) / SR;
            const cw = Math.cos(w);
            const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
            const A = Math.pow(10, gainDb / 40);
            let b0, b1, b2, a0, a1, a2;
            if (type === "highpass") {
                b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
            } else if (type === "bandpass") {
                // Constant 0dB peak gain, so a bank of them sums sensibly.
                b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
            } else if (type === "notch") {
                b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
            } else if (type === "peak") {
                b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
            } else if (type === "allpass") {
                b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
            } else {
                b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
            }
            this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
        }
        process(x) {
            const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
            this.x2 = this.x1; this.x1 = x;
            this.y2 = this.y1; this.y1 = y;
            return y;
        }
    }

    // A two-pole resonator ringing at `freq` with a -60dB time of `decay`
    // seconds. Excited by an impulse it *is* a decaying sine, so it's the
    // unit of modal synthesis: a struck object is a sum of these. The input
    // gain is normalised so a unit impulse rings at about unit amplitude
    // whatever the frequency and decay.
    class Resonator {
        constructor(freq = 440, decay = 1) {
            this.y1 = this.y2 = 0;
            this.set(freq, decay);
        }
        set(freq, decay) {
            const f = clamp(freq, 1, SR * 0.49);
            const r = decay <= 0 ? 0 : Math.exp(-6.907755 / (decay * SR));
            const w = TAU * f / SR;
            this.c1 = 2 * r * Math.cos(w);
            this.c2 = -r * r;
            this.g = Math.sin(w);
        }
        process(x) {
            const y = this.c1 * this.y1 + this.c2 * this.y2 + this.g * x;
            this.y2 = this.y1;
            this.y1 = y;
            return y;
        }
        energy() {
            return Math.abs(this.y1) + Math.abs(this.y2);
        }
    }

    // First-order DC blocker.
    class DCBlock {
        constructor() {
            this.x1 = 0; this.y1 = 0;
            this.r = 1 - TAU * 10 / SR;
        }
        process(x) {
            const y = x - this.x1 + this.r * this.y1;
            this.x1 = x; this.y1 = y;
            return y;
        }
    }

    // ── Delay lines ─────────────────────────────────────────────────────
    // A power-of-two circular buffer with fractional reads. `read(d)` is d
    // samples ago; linear interpolation by default, `readHermite` when a
    // moving delay needs to stay clean (a pitch shifter, a chorus, a tape).
    class Delay {
        constructor(maxSamples) {
            let size = 16;
            while (size < maxSamples + 4) size <<= 1;
            this.buf = new Float32Array(size);
            this.mask = size - 1;
            this.w = 0;
        }
        write(x) {
            this.buf[this.w] = x;
            this.w = (this.w + 1) & this.mask;
        }
        tap(d) {
            return this.buf[(this.w - 1 - d) & this.mask];
        }
        read(d) {
            const di = Math.floor(d);
            const f = d - di;
            const i = this.w - 1 - di;
            const a = this.buf[i & this.mask];
            const b = this.buf[(i - 1) & this.mask];
            return a + (b - a) * f;
        }
        readHermite(d) {
            const di = Math.floor(d);
            const f = d - di;
            const i = this.w - 1 - di;
            const xm1 = this.buf[(i + 1) & this.mask];
            const x0 = this.buf[i & this.mask];
            const x1 = this.buf[(i - 1) & this.mask];
            const x2 = this.buf[(i - 2) & this.mask];
            const c1 = 0.5 * (x1 - xm1);
            const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
            const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
            return ((c3 * f + c2) * f + c1) * f + x0;
        }
        clear() {
            this.buf.fill(0);
        }
    }

    // Schroeder allpass with its own integer delay — the diffusion unit of
    // every reverb here and the dispersion unit of the spring.
    class Allpass {
        constructor(samples, gain = 0.6) {
            this.line = new Delay(samples + 1);
            this.d = samples;
            this.g = gain;
        }
        process(x) {
            const delayed = this.line.tap(this.d - 1);
            const v = x + this.g * delayed;
            this.line.write(v);
            return delayed - this.g * v;
        }
    }

    // A first-order allpass (one multiply) — chained, it disperses: high
    // frequencies come out before low ones. That chirp is a spring.
    class Allpass1 {
        constructor(a = 0.5) {
            this.a = a; this.x1 = 0; this.y1 = 0;
        }
        process(x) {
            const y = -this.a * x + this.x1 + this.a * this.y1;
            this.x1 = x; this.y1 = y;
            return y;
        }
    }

    // Peak-ish envelope follower with separate attack and release.
    class Follower {
        constructor(attack = 0.005, release = 0.1) {
            this.e = 0;
            this.set(attack, release);
        }
        set(attack, release) {
            this.a = smoothing(attack);
            this.r = smoothing(release);
        }
        process(x) {
            const v = Math.abs(x);
            const c = v > this.e ? this.a : this.r;
            this.e = v + (this.e - v) * c;
            return this.e;
        }
    }

    // A short fixed-length sine table for LFOs and carriers that need a lot
    // of cheap oscillators (Spectra's carrier, Deep Pad's drift).
    const SINE_SIZE = 4096;
    const SINE = new Float32Array(SINE_SIZE + 1);
    for (let i = 0; i <= SINE_SIZE; i++) SINE[i] = Math.sin((TAU * i) / SINE_SIZE);
    const sinT = (phase) => {
        // phase in cycles, any value
        const p = (phase - Math.floor(phase)) * SINE_SIZE;
        const i = p | 0;
        return SINE[i] + (SINE[i + 1] - SINE[i]) * (p - i);
    };

    // In-place radix-2 complex FFT (re/im Float32Arrays of length n, a power
    // of two). Spectra's photograph uses it, a few times a second at most, so
    // clarity beats speed.
    function fft(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const ang = -TAU / len;
            const wr = Math.cos(ang), wi = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let cr = 1, ci = 0;
                for (let j = 0; j < len / 2; j++) {
                    const ar = re[i + j], ai = im[i + j];
                    const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
                    const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
                    re[i + j] = ar + br; im[i + j] = ai + bi;
                    re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
                    const nr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = nr;
                }
            }
        }
    }

    // ── Plate / membrane physics (Big Modal) ────────────────────────────
    // Bessel function of the first kind J_m(x), by its power series. The
    // series cancels catastrophically for large x, but the sixteen lowest
    // modes of a disc all have Bessel zeros below 12, where it is accurate
    // to ~1e-9 — the only range this is ever asked about.
    function besselJ(m, x) {
        const half = x / 2;
        let term = 1;
        for (let k = 1; k <= m; k++) term *= half / k;
        let sum = term;
        for (let k = 0; k < 80; k++) {
            term *= -(half * half) / ((k + 1) * (k + 1 + m));
            sum += term;
            if (Math.abs(term) < 1e-17 * Math.abs(sum) && k > half) break;
        }
        return sum;
    }

    // The sixteen lowest (m, n) modes of a circular membrane: each with its
    // Bessel zero j_mn (J_m(j_mn) = 0), found by a sign-change scan and
    // bisection, sorted by j. For the stiff-membrane dispersion used below,
    // ω grows monotonically with j whatever the tension and stiffness, so
    // these sixteen are the lowest sixteen for *every* object — only their
    // ratios change between a drum and a plate.
    function discModeTable(count = 16) {
        const modes = [];
        for (let m = 0; m <= 10; m++) {
            let x = m === 0 ? 0.5 : m * 0.9 + 0.5;
            let prev = besselJ(m, x);
            let n = 0;
            while (x < 14 && n < 6) {
                const next = x + 0.02;
                const value = besselJ(m, next);
                if (prev === 0 || (prev < 0) !== (value < 0)) {
                    let lo = x, hi = next;
                    for (let i = 0; i < 60; i++) {
                        const mid = (lo + hi) / 2;
                        if ((besselJ(m, lo) < 0) === (besselJ(m, mid) < 0)) lo = mid; else hi = mid;
                    }
                    const j = (lo + hi) / 2;
                    n++;
                    // Mode shape norm ∫J_m(j r)² r dr over the unit disc.
                    const norm = Math.sqrt(0.5) * Math.abs(besselJ(m + 1, j));
                    modes.push({ m, n, j, norm });
                }
                prev = value;
                x = next;
            }
        }
        modes.sort((a, b) => a.j - b.j);
        return modes.slice(0, count);
    }

    // Frequencies of those modes for a disc of radius `radius` (m), thickness
    // `thick` (m), membrane tension `tension` (N/m) and material {rho, E}:
    //     ω² = (T/σ)·k² + (D/σ)·k⁴,   k = j/a,   σ = ρh,   D = E h³ / 12(1-ν²)
    // — the membrane term pulls the ratios towards harmonic, the bending
    // term towards the dispersive, inharmonic plate. `stiffness` scales D.
    // A negative ω² (Anti-Wood's negative stiffness) comes back as a
    // negative frequency: the caller decides what "restoring force backwards"
    // sounds like.
    function discFrequencies(table, { radius, thick, tension, rho, E, stiffness = 1 }, into) {
        const sigma = rho * thick;
        const nu = 0.3;
        const D = (E * stiffness * thick * thick * thick) / (12 * (1 - nu * nu));
        const out = into || new Float64Array(table.length);
        for (let i = 0; i < table.length; i++) {
            const k = table[i].j / radius;
            const w2 = (tension / sigma) * k * k + (D / sigma) * k * k * k * k;
            const f = Math.sqrt(Math.abs(w2)) / TAU;
            out[i] = w2 < 0 ? -f : f;
        }
        return out;
    }

    // How much each mode is excited by a strike at radius r (0 centre..1
    // rim) and angle theta (radians, relative to where the object is heard
    // from): the mode shape at that point, J_m(j·r)·cos(m·θ), over its norm.
    // A centre strike excites only m = 0 — every other mode has a node there.
    function discStrike(table, r, theta, into) {
        const out = into || new Float64Array(table.length);
        for (let i = 0; i < table.length; i++) {
            const { m, j, norm } = table[i];
            out[i] = (besselJ(m, j * r) * Math.cos(m * theta)) / (norm || 1);
        }
        return out;
    }

    // ── Sample reading ──────────────────────────────────────────────────
    // A Hermite-interpolated read of a Float32Array at a fractional index,
    // silent outside the buffer.
    function readAt(buffer, position) {
        const i = Math.floor(position);
        if (i < 1 || i >= buffer.length - 2) return i >= 0 && i < buffer.length ? buffer[i] : 0;
        const f = position - i;
        const xm1 = buffer[i - 1], x0 = buffer[i], x1 = buffer[i + 1], x2 = buffer[i + 2];
        const c1 = 0.5 * (x1 - xm1);
        const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
        const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        return ((c3 * f + c2) * f + c1) * f + x0;
    }

    // One sample of a loop [start, start+length) read at `position` (which
    // the caller keeps inside the loop), crossfaded across the seam over
    // `fade` samples so it never clicks: approaching the end, the read blends
    // into the same distance before the start. Works for either direction of
    // travel, since the blend depends only on where in the loop you are.
    function readLoop(buffer, position, start, length, fade) {
        const into = position - start;
        const tail = length - into;
        if (fade > 0 && tail < fade) {
            const w = tail / fade;
            return readAt(buffer, position) * w + readAt(buffer, position - length) * (1 - w);
        }
        return readAt(buffer, position);
    }

    // ── Parameters ──────────────────────────────────────────────────────
    // Reads every AudioParam's current k-rate value into one plain object,
    // reused across blocks so reading params allocates nothing.
    function readParams(parameters, into) {
        for (const key in parameters) into[key] = parameters[key][0];
        return into;
    }

    // ── Polyphonic voice hosting ────────────────────────────────────────
    // Owns the pending-note queue and the live voices of a synth processor.
    // The main thread posts {type: "note", time, ...} a lookahead window
    // ahead (see RibbitWorkletSynth.trigger); here each note starts at its
    // exact sample. A voice is any object with
    //     render(outL, outR, from, to) -> boolean (still sounding)
    // that *adds* into the outputs. Notes whose time has already passed by
    // more than 50ms (the module was still loading, the tab stalled) are
    // dropped rather than played late — a late drum hit is worse than none.
    //
    // Past `maxVoices` the oldest voice is stolen with a 5ms fade, rendered
    // through a scratch buffer so the voice classes never need to know.
    class VoiceHost {
        constructor(makeVoice, maxVoices = 16) {
            this.make = makeVoice;
            this.max = maxVoices;
            this.pending = [];
            this.voices = [];
            this.fading = [];
            this.scratchL = new Float32Array(128);
            this.scratchR = new Float32Array(128);
        }
        push(message) {
            const pending = this.pending;
            let i = pending.length;
            while (i > 0 && pending[i - 1].time > message.time) i--;
            pending.splice(i, 0, message);
        }
        get count() {
            return this.voices.length + this.fading.length;
        }
        releaseAll() {
            for (const voice of this.voices) voice.release?.();
        }
        run(outL, outR, params, owner) {
            const frames = outL.length;
            const blockEnd = currentTime + frames / SR;
            const pending = this.pending;
            while (pending.length && pending[0].time < blockEnd) {
                const message = pending.shift();
                if (message.time < currentTime - 0.05) continue;
                const voice = this.make(message, params, owner);
                if (!voice) continue;
                voice.startOffset = Math.max(0, Math.min(frames - 1, Math.round((message.time - currentTime) * SR)));
                this.voices.push(voice);
                if (this.voices.length > this.max) {
                    const stolen = this.voices.shift();
                    stolen.fadeGain = 1;
                    this.fading.push(stolen);
                }
            }

            for (let v = this.voices.length - 1; v >= 0; v--) {
                const voice = this.voices[v];
                const from = voice.startOffset || 0;
                voice.startOffset = 0;
                if (!voice.render(outL, outR, from, frames, params)) this.voices.splice(v, 1);
            }

            if (this.fading.length) {
                const step = 1 / (0.005 * SR);
                for (let v = this.fading.length - 1; v >= 0; v--) {
                    const voice = this.fading[v];
                    this.scratchL.fill(0, 0, frames);
                    this.scratchR.fill(0, 0, frames);
                    voice.render(this.scratchL, this.scratchR, 0, frames, params);
                    let g = voice.fadeGain;
                    for (let i = 0; i < frames; i++) {
                        g = Math.max(0, g - step);
                        outL[i] += this.scratchL[i] * g;
                        outR[i] += this.scratchR[i] * g;
                    }
                    voice.fadeGain = g;
                    if (g <= 0) this.fading.splice(v, 1);
                }
            }
        }
    }

    // The whole processor class for a polyphonic synth: a VoiceHost, the
    // param snapshot, and the message plumbing every voice processor shares.
    // `makeVoice(message, params, processor)` builds one voice per note.
    // Optional hooks run with `this` = the processor:
    //   init()                     after construction (shared state)
    //   message(m)                 any message that isn't a note/dispose
    //   before(L, R, params)       before voices render (e.g. a drone bed)
    //   after(L, R, params)        after — in-place processing of the voice
    //                              sum (a voice's built-in delay or reverb,
    //                              which must outlive the voice that fed it)
    // Any other function in `hooks` becomes a method of the class, so a
    // processor's helpers can live beside its hooks.
    function withMethods(Class, hooks, known) {
        for (const key of Object.keys(hooks)) {
            if (!known.includes(key) && typeof hooks[key] === "function") Class.prototype[key] = hooks[key];
        }
        return Class;
    }

    function voiceProcessor(Base, makeVoice, maxVoices = 16, hooks = {}) {
        return withMethods(class extends Base {
            constructor(options) {
                super(options);
                this.P = {};
                this.opts = (options && options.processorOptions) || {};
                this.host = new VoiceHost(makeVoice, maxVoices);
                this.dead = false;
                if (hooks.init) hooks.init.call(this);
                this.port.onmessage = (event) => {
                    const m = event.data;
                    if (m.type === "dispose") this.dead = true;
                    else if (m.type === "note") this.host.push(m);
                    else if (hooks.message) hooks.message.call(this, m);
                };
            }
            process(inputs, outputs, parameters) {
                if (this.dead) return false;
                const out = outputs[0];
                const L = out[0];
                const R = out[1] || out[0];
                readParams(parameters, this.P);
                if (hooks.before) hooks.before.call(this, L, R, this.P);
                this.host.run(L, R, this.P, this);
                if (hooks.after) hooks.after.call(this, L, R, this.P);
                return true;
            }
        }, hooks, ["init", "message", "before", "after"]);
    }

    // The same for an effect: `setup()` builds state (this.opts holds the
    // processorOptions), `render(inL, inR, outL, outR, params, frames)` does
    // the block, and timed messages arrive through `onMessage(m, offset)`
    // via a TimedQueue drained at the top of every block. A missing input
    // (nothing connected) arrives as silence.
    function effectProcessor(Base, hooks) {
        return withMethods(class extends Base {
            constructor(options) {
                super(options);
                this.P = {};
                this.opts = (options && options.processorOptions) || {};
                this.queue = new TimedQueue();
                this.dead = false;
                this.silence = new Float32Array(128);
                if (hooks.setup) hooks.setup.call(this);
                this.port.onmessage = (event) => {
                    const m = event.data;
                    if (m.type === "dispose") this.dead = true;
                    else this.queue.push(m);
                };
            }
            process(inputs, outputs, parameters) {
                if (this.dead) return false;
                const input = inputs[0] || [];
                const out = outputs[0];
                const frames = out[0].length;
                if (this.silence.length !== frames) this.silence = new Float32Array(frames);
                const inL = input[0] || this.silence;
                const inR = input[1] || input[0] || this.silence;
                readParams(parameters, this.P);
                if (hooks.onMessage) this.queue.drain(frames, (m, offset) => hooks.onMessage.call(this, m, offset));
                hooks.render.call(this, inL, inR, out[0], out[1] || out[0], this.P, frames, parameters);
                return true;
            }
        }, hooks, ["setup", "onMessage", "render"]);
    }

    // The musical clock, inside a worklet: fed anchors ("beat B at time T,
    // at this bpm") by RibbitWorkletModulator.onSchedule, it answers the beat
    // at any AudioContext time. Null until the first anchor (the transport
    // hasn't run yet), which callers treat as "not synced yet".
    class BeatClock {
        constructor() {
            this.anchorTime = null;
            this.anchorBeat = 0;
            this.bpm = 120;
        }
        anchor(m) {
            this.anchorTime = m.time;
            this.anchorBeat = m.beat;
            this.bpm = m.bpm;
        }
        beatAt(time) {
            if (this.anchorTime === null) return null;
            return this.anchorBeat + ((time - this.anchorTime) * this.bpm) / 60;
        }
    }

    // A clean sample-accurate event queue for processors that are not
    // voice hosts but still receive timed messages (a freeze toggled at a
    // beat, a looper told to record on the cycle).
    class TimedQueue {
        constructor() {
            this.items = [];
        }
        push(message) {
            const items = this.items;
            let i = items.length;
            while (i > 0 && items[i - 1].time > message.time) i--;
            items.splice(i, 0, message);
        }
        // Calls fn(message, offset) for everything due inside this block.
        drain(frames, fn) {
            const blockEnd = currentTime + frames / SR;
            while (this.items.length && (this.items[0].time ?? 0) < blockEnd) {
                const message = this.items.shift();
                const offset = Math.max(0, Math.min(frames - 1, Math.round(((message.time ?? currentTime) - currentTime) * SR)));
                fn(message, offset);
            }
        }
    }

    return {
        SR, TAU, clamp, lerp, mtof, dbToGain, registerPitch, t60, smoothing,
        tanh, fold, asym, curveEnv,
        Rng, OnePole, SVF, Biquad, Resonator, DCBlock,
        Delay, Allpass, Allpass1, Follower,
        sinT, fft, readParams,
        besselJ, discModeTable, discFrequencies, discStrike,
        readAt, readLoop,
        VoiceHost, TimedQueue, BeatClock, voiceProcessor, effectProcessor,
    };
};
