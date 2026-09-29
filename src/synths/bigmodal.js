import { RibbitWorkletSynth } from "../dsp/voice.js";
import { registerWorkletProcessor } from "../dsp/worklet.js";
import { dspLibrary } from "../dsp/lib.js";
import { workletParams } from "../dsp/spec.js";

// A struck disc, *solved* rather than tuned — the AE machine's Materials /
// Big Modal (`aemd_v2`). You describe an object — its material, radius,
// thickness, how tight it is, where you hit it — and the sixteen partials it
// would have are computed, not chosen.
//
// **The physics** (dsp/lib.js: discModeTable / discFrequencies / discStrike).
// The sixteen lowest modes of a circular disc, each a Bessel zero j_mn solved
// at load, with frequencies from the stiff-membrane dispersion relation
//     ω² = (T/σ)·k² + (D/σ)·k⁴,    k = j_mn / a,  σ = ρh,  D = E h³/12(1-ν²).
// `tension` 0 is a plate — only stiffness restores it, the partials sit at
// ratios no scale contains (gong, cymbal, sheet). Raise it and the membrane
// term takes over, the ratios pull towards harmonic, and it becomes a drum.
// `stretch` multiplies the stiffness (up to 41×) without touching the
// material. Each mode decays from the material's own loss factor —
// T60 = 2.2 / (η·f), so glass rings for seconds and rubber doesn't — tilted
// by `damp_tilt` (positive: highs die first, what real objects do).
//
// **Where you hit it** decides which modes get any energy at all:
// `contact_r` 0 is the centre (only the m=0 modes move — dull), 1 the rim
// (bright, complicated); `contact_theta` rotates the strike relative to the
// listening point. `hit` is how hard, which also shortens the contact and so
// reaches higher modes; velocity multiplies it.
//
// **Materials** (options `mat_a`, `mat_b`, crossfaded by `morph`) carry
// real constants — density, Young's modulus, loss factor — and the morph is
// logarithmic in each, because density alone spans 0.02 to 4×10¹⁷ across
// the table and a linear blend would sit near one end the whole way. The
// last seven don't exist (see MATERIALS).
//
// **Behaving like a thing:** `couple` feeds each mode into the next in a
// ring through a soft saturation (beating, intermodulation, a rumble in none
// of the sixteen); `drift` detunes every mode by its own blend of three slow
// oscillators (0.27, 0.18, 0.11Hz, up to 1.5%); `grime` blends in a dirtier
// copy from four short delays tuned to modes 1, 5, 10 and 16 and folded back
// on themselves (`bite` = how hard, `grain` = their length multiplier);
// `oct` transposes without touching the physics; `mix` is body against the
// bare strike.
//
// **Chaotic modulation.** Six Coullet attractors — one per destination, at
// irrational speed ratios (`spread`) so no two ever line up, blended towards
// a random walk by `wander`, run at `rate`, and *pushed* by each note's
// velocity (a hard note makes its orbit accelerate — the music deflects the
// chaos instead of replacing it). Six mod rows, each an option
// `mod_<dest>=<source>:<amount>[:run]` with source `chaos`, `vel`, `note` or
// `off` and amount -100..100: latched by default (read once at the strike —
// every hit a slightly different object, each internally consistent) or
// `run` (keeps moving while it rings — the skin tightens mid-decay; objects
// that sound haunted). Destinations: contact_r, contact_theta, tension,
// couple, grime, morph.
//
// `describeState()` prints the manual's three read-outs for the object as
// dialled — f1, the wave speed c = √(E/ρ), and f16/f1 (small: pitched; wide:
// a noise with a centre) — plus the last strike's per-mode amplitudes.
//
// Lane 6, odd notes by default (the kick takes the even ones). Pitch comes
// from the object, never the note.
export const BIGMODAL_PARAMS = {
    morph: { value: 0, min: 0, max: 1 },
    radius: { value: 150, min: 10, max: 600 },
    thick: { value: 0.3, min: 0.01, max: 20 },
    tension: { value: 3000, min: 0, max: 20000 },
    stretch: { value: 1, min: 1, max: 41 },
    damp_tilt: { value: 0.3, min: -1, max: 1 },
    contact_r: { value: 0.42, min: 0, max: 1 },
    contact_theta: { value: 0, min: 0, max: 360 },
    couple: { value: 0.1, min: 0, max: 1 },
    drift: { value: 0.2, min: 0, max: 1 },
    grime: { value: 0, min: 0, max: 1 },
    bite: { value: 0.3, min: 0, max: 1 },
    grain: { value: 1, min: 0.1, max: 4 },
    oct: { value: 0, min: -4, max: 2 },
    hit: { value: 1, min: 0, max: 4 },
    mix: { value: 1, min: 0, max: 1 },
    out_db: { value: 0, min: -24, max: 12 },
    rate: { value: 0.1, min: 0.001, max: 1 },
    spread: { value: 1, min: 0.2, max: 3 },
    wander: { value: 0.05, min: 0, max: 1 },
};

// density kg/m³, Young's modulus Pa, loss factor η (1/Q). The first
// eighteen are real (textbook values; composites and woods vary a lot with
// grain and weave — these are representative). The last seven are not:
//   lead_aerogel    a whisper's density with steel's stiffness: sound runs
//                   ~30× faster than in metal.
//   immortal_glass  glass with almost no internal damping — minutes of ring.
//   dark_matter     weighs almost nothing.
//   neutronium      4×10¹⁷ kg/m³: every frequency collapses towards zero and
//                   the model gives up, which is itself a usable sound.
//   anti_wood       negative stiffness — the restoring force works backwards
//                   (its plate-dominated modes swell before they die).
//   liquid_diamond  a thousand gigapascals: bright beyond any real material.
//   velvet_iron     steel's stiffness with rubber's damping: a thud that
//                   should have rung.
export const MATERIALS = {
    mylar: { rho: 1390, E: 4.0e9, eta: 0.012 },
    kevlar: { rho: 1440, E: 70e9, eta: 0.008 },
    spruce: { rho: 450, E: 11e9, eta: 0.008 },
    ebony: { rho: 1150, E: 17e9, eta: 0.005 },
    bamboo: { rho: 700, E: 18e9, eta: 0.009 },
    bone: { rho: 1900, E: 17e9, eta: 0.02 },
    ice: { rho: 917, E: 9.3e9, eta: 0.0015 },
    glass: { rho: 2500, E: 70e9, eta: 0.0006 },
    quartz: { rho: 2650, E: 72e9, eta: 0.00004 },
    aluminium: { rho: 2700, E: 69e9, eta: 0.0004 },
    titanium: { rho: 4500, E: 116e9, eta: 0.0006 },
    steel: { rho: 7850, E: 200e9, eta: 0.0002 },
    bronze: { rho: 8800, E: 110e9, eta: 0.0003 },
    lead: { rho: 11340, E: 16e9, eta: 0.03 },
    gold: { rho: 19300, E: 79e9, eta: 0.0015 },
    tungsten: { rho: 19250, E: 411e9, eta: 0.0002 },
    rubber: { rho: 1100, E: 0.05e9, eta: 0.12 },
    graphite: { rho: 2100, E: 25e9, eta: 0.004 },
    lead_aerogel: { rho: 9, E: 200e9, eta: 0.001 },
    immortal_glass: { rho: 2500, E: 70e9, eta: 1e-7 },
    dark_matter: { rho: 0.02, E: 1e6, eta: 0.002 },
    neutronium: { rho: 4e17, E: 1e9, eta: 0.01 },
    anti_wood: { rho: 600, E: -12e9, eta: 0.01 },
    liquid_diamond: { rho: 3500, E: 1050e9, eta: 0.00005 },
    velvet_iron: { rho: 7850, E: 200e9, eta: 0.08 },
};
const MATERIAL_NAMES = Object.keys(MATERIALS);

// Factory objects: the manual's "forty slots arrive filled" tour, as
// recipes. Loading one (`preset=glass_bowl`) sets its materials and params;
// it's a starting point, not a mode — nothing stays tied to it.
export const BIGMODAL_PRESETS = {
    mylar_tom: { mat_a: "mylar", mat_b: "kevlar", morph: 0, radius: 140, thick: 0.2, tension: 3000, contact_r: 0.42, damp_tilt: 0.4 },
    kevlar_snare: { mat_a: "kevlar", mat_b: "mylar", morph: 0.2, radius: 180, thick: 0.25, tension: 9000, contact_r: 0.7, damp_tilt: 0.6, grime: 0.25, bite: 0.5 },
    floor_drum: { mat_a: "mylar", mat_b: "spruce", morph: 0.1, radius: 400, thick: 0.25, tension: 1800, contact_r: 0.3, damp_tilt: 0.5, couple: 0.3 },
    spruce_plate: { mat_a: "spruce", mat_b: "ebony", morph: 0, radius: 200, thick: 4, tension: 0, contact_r: 0.6, damp_tilt: 0.5 },
    ebony_block: { mat_a: "ebony", mat_b: "bamboo", morph: 0.3, radius: 90, thick: 3, tension: 0, contact_r: 0.5, damp_tilt: 0.7, hit: 1 },
    bone_disc: { mat_a: "bone", mat_b: "glass", morph: 0, radius: 80, thick: 3, tension: 0, contact_r: 0.45, damp_tilt: 0.3 },
    ice_sheet: { mat_a: "ice", mat_b: "glass", morph: 0.2, radius: 300, thick: 6, tension: 0, contact_r: 0.8, damp_tilt: 0.2, drift: 0.4 },
    glass_bowl: { mat_a: "glass", mat_b: "quartz", morph: 0.3, radius: 110, thick: 3, tension: 0, contact_r: 0.9, damp_tilt: 0.1 },
    steel_gong: { mat_a: "steel", mat_b: "bronze", morph: 0.5, radius: 180, thick: 3, tension: 0, contact_r: 0.25, damp_tilt: 0.2, couple: 0.45, drift: 0.3 },
    bronze_cymbal: { mat_a: "bronze", mat_b: "steel", morph: 0.1, radius: 120, thick: 2, tension: 0, contact_r: 0.95, damp_tilt: -0.1, couple: 0.6, grime: 0.2 },
    aluminium_pan: { mat_a: "aluminium", mat_b: "titanium", morph: 0.2, radius: 160, thick: 1.5, tension: 1200, contact_r: 0.65, damp_tilt: 0.25 },
    gold_coin: { mat_a: "gold", mat_b: "bronze", morph: 0, radius: 25, thick: 1, tension: 0, contact_r: 0.8, damp_tilt: 0.2, hit: 1.6 },
    tungsten_disc: { mat_a: "tungsten", mat_b: "steel", morph: 0, radius: 90, thick: 5, tension: 0, contact_r: 0.5, damp_tilt: 0.15 },
    rubber_pad: { mat_a: "rubber", mat_b: "lead", morph: 0.2, radius: 120, thick: 8, tension: 500, contact_r: 0.4, damp_tilt: 0.8 },
    lead_thud: { mat_a: "lead", mat_b: "rubber", morph: 0, radius: 200, thick: 6, tension: 0, contact_r: 0.3, damp_tilt: 0.6 },
    graphite_plate: { mat_a: "graphite", mat_b: "spruce", morph: 0, radius: 180, thick: 3, tension: 200, contact_r: 0.55, damp_tilt: 0.35 },
    aerogel_zap: { mat_a: "lead_aerogel", mat_b: "aluminium", morph: 0.1, radius: 300, thick: 1, tension: 0, contact_r: 0.6, damp_tilt: 0.4 },
    immortal_bell: { mat_a: "immortal_glass", mat_b: "glass", morph: 0, radius: 160, thick: 4, tension: 0, contact_r: 0.85, damp_tilt: 0 },
    dark_matter_skin: { mat_a: "dark_matter", mat_b: "mylar", morph: 0.2, radius: 250, thick: 0.5, tension: 40, contact_r: 0.5, damp_tilt: 0.3 },
    neutron_star: { mat_a: "neutronium", mat_b: "lead", morph: 0, radius: 600, thick: 20, tension: 20000, contact_r: 0.3, damp_tilt: 0, grime: 0.6, bite: 0.8, mix: 0.6 },
    anti_wood_plank: { mat_a: "anti_wood", mat_b: "spruce", morph: 0, radius: 150, thick: 5, tension: 400, contact_r: 0.5, damp_tilt: 0.3, couple: 0.3 },
    bone_to_glass: { mat_a: "bone", mat_b: "glass", morph: 0, radius: 100, thick: 3, tension: 0, contact_r: 0.5, damp_tilt: 0.3, rate: 0.1, wander: 0.05, mod_morph: "chaos:30", mod_contact_r: "chaos:20" },
};
const PRESET_NAMES = Object.keys(BIGMODAL_PRESETS);

const MOD_DESTS = ["contact_r", "contact_theta", "tension", "couple", "grime", "morph"];
const MOD_SOURCES = ["off", "chaos", "vel", "note"];

function parseModRow(value) {
    const text = String(value ?? "off").trim().toLowerCase();
    if (text === "off" || text === "") return { source: "off", amount: 0, run: false };
    const [source, amountText = "0", mode = "latch"] = text.split(":");
    const amount = Number(amountText);
    if (!MOD_SOURCES.includes(source) || !Number.isFinite(amount) || !["latch", "run"].includes(mode)) {
        throw new Error(`invalid mod row "${value}" — expected <${MOD_SOURCES.join("|")}>:<-100..100>[:latch|run], or off`);
    }
    return { source, amount: Math.max(-100, Math.min(100, amount)), run: mode === "run" };
};

function formatModRow(row) {
    return row.source === "off" ? "off" : `${row.source}:${row.amount}${row.run ? ":run" : ""}`;
};

export function bigmodalProcessor(Base, DSP) {
    const { SR, TAU, clamp, lerp, tanh, fold, discModeTable, discFrequencies, discStrike, Delay, OnePole, Rng, voiceProcessor } = DSP;
    const TABLE = discModeTable(16);
    const COUNT = TABLE.length;
    const PICKUP_R = 0.63;
    const pickup = discStrike(TABLE, PICKUP_R, 0);
    const RANGES = { contact_r: [0, 1], contact_theta: [0, 360], tension: [0, 20000], couple: [0, 1], grime: [0, 1], morph: [0, 1] };
    const DRIFT_HZ = [0.27, 0.18, 0.11];
    const GRIME_MODES = [0, 4, 9, 15];
    const DESTS = ["contact_r", "contact_theta", "tension", "couple", "grime", "morph"];
    const UPDATE = 32;

    // One Coullet attractor: x' = y, y' = z, z' = a·x + b·y + c·z − x³
    // (Arneodo–Coullet–Tresser, Sprott's a=0.8 b=-1.1 c=-0.45). Integrated
    // with small Euler steps at control rate; `x` sits roughly in ±1.5.
    class Coullet {
        constructor(seed) {
            const r = new Rng(seed);
            this.x = 0.1 + r.bi() * 0.2;
            this.y = r.bi() * 0.2;
            this.z = r.bi() * 0.2;
            this.walk = 0;
            this.rng = r;
        }
        step(dt, wander) {
            // Midpoint (RK2) steps, at most 0.02 time units each: plain Euler
            // with a cubic term diverges at the fast end of `rate`.
            const n = Math.max(1, Math.ceil(dt / 0.02));
            const h = dt / n;
            const f = (x, y, z) => 0.8 * x - 1.1 * y - 0.45 * z - x * x * x;
            for (let i = 0; i < n; i++) {
                const { x, y, z } = this;
                const mx = x + 0.5 * h * y;
                const my = y + 0.5 * h * z;
                const mz = z + 0.5 * h * f(x, y, z);
                this.x = x + h * my;
                this.y = y + h * mz;
                this.z = z + h * f(mx, my, mz);
            }
            if (!(Math.abs(this.x) < 10 && Math.abs(this.y) < 10 && Math.abs(this.z) < 10)) {
                this.x = 0.1; this.y = 0; this.z = 0;
            }
            // A bounded gaussian random walk, blended in by `wander`.
            this.walk = clamp(this.walk * 0.999 + this.rng.gauss() * 0.02, -1, 1);
            const chaos = clamp(this.x / 1.5, -1, 1);
            return chaos + (this.walk - chaos) * wander;
        }
    }

    const logLerp = (a, b, t) => Math.exp(lerp(Math.log(a), Math.log(b), t));
    // asinh space lets Anti-Wood's negative modulus morph through zero.
    const modLerp = (a, b, t) => Math.sinh(lerp(Math.asinh(a / 1e6), Math.asinh(b / 1e6), t)) * 1e6;

    class Voice {
        constructor(m, P, proc) {
            this.proc = proc;
            this.velocity = m.velocity;
            this.note = m.note ?? 60;
            this.freqs = new Float64Array(COUNT);
            this.strike = new Float64Array(COUNT);
            this.gainTarget = new Float64Array(COUNT);
            this.gain = new Float64Array(COUNT);
            this.re = new Float64Array(COUNT);
            this.im = new Float64Array(COUNT);
            this.c = new Float64Array(COUNT);
            this.s = new Float64Array(COUNT);
            this.r = new Float64Array(COUNT);
            this.swell = new Float64Array(COUNT);
            this.driftW = [];
            for (let i = 0; i < COUNT; i++) this.driftW.push([proc.rng.bi(), proc.rng.bi(), proc.rng.bi()]);
            // The strike: a raised-cosine contact whose length shrinks as the
            // hit hardens (0.4..3ms) — a short contact reaches high modes.
            const hardness = clamp((P.hit * m.velocity) / 4, 0, 1);
            this.pulseLen = Math.max(4, Math.round((0.0004 + 0.0026 * (1 - hardness)) * SR));
            this.pulseGain = (2 / this.pulseLen) * Math.min(1, P.hit) * m.velocity;
            // Latched modulation: the value each row resolves to right now.
            this.latched = proc.resolveMods(P, this);
            this.solve(P, this.latched, true);
            this.gain.set(this.gainTarget);
            // Grime: four short delays tuned to modes 1, 5, 10, 16.
            this.grimeLines = GRIME_MODES.map(() => new Delay(Math.ceil(0.1 * SR)));
            this.grimeLp = new OnePole(6000);
            this.n = 0;
            this.quiet = 0;
            this.prev = new Float64Array(COUNT);
            this.maxSamples = 45 * SR;
        }

        // Resolves the physics into per-mode frequency, decay and target
        // amplitude. `first` also latches which modes exist; later calls
        // (run rows, drift) only move them.
        solve(P, mods, first) {
            const proc = this.proc;
            const morph = clamp(P.morph + mods.morph, 0, 1);
            const a = proc.matA, b = proc.matB;
            const rho = logLerp(a.rho, b.rho, morph);
            const E = modLerp(a.E, b.E, morph);
            const eta = logLerp(a.eta, b.eta, morph);
            const tension = clamp(P.tension + mods.tension, 0, 20000);
            discFrequencies(TABLE, {
                radius: P.radius / 1000,
                thick: P.thick / 1000,
                tension,
                rho,
                E,
                stiffness: P.stretch,
            }, this.freqs);
            const cr = clamp(P.contact_r + mods.contact_r, 0, 1);
            const theta = ((P.contact_theta + mods.contact_theta) * Math.PI) / 180;
            discStrike(TABLE, cr, theta, this.strike);
            const octave = Math.pow(2, Math.round(P.oct));
            const f1 = Math.max(1, Math.abs(this.freqs[0]) * octave);
            let norm = 0;
            let rawNorm = 0;
            for (let i = 0; i < COUNT; i++) {
                const raw = this.freqs[i];
                // A 20Hz floor: Neutronium's frequencies collapse towards
                // zero, and "the model gives up" should be a sub-audio thump
                // under its grime, not nothing at all.
                let f = Math.max(20, Math.abs(raw) * octave);
                const audible = f < SR * 0.45;
                f = Math.min(f, SR * 0.45);
                this.freqs[i] = f;
                // Loss: the material's η, a floor for radiation, tilted so
                // (positive tilt) higher modes lose more.
                const tilt = Math.pow(f / f1, P.damp_tilt * 1.5);
                const loss = Math.max(1e-9, (eta + 0.00015) * tilt);
                const t60 = Math.min(40, 2.2 / (loss * f));
                const r = Math.exp(-6.907755 / (t60 * SR));
                this.r[i] = r;
                const w = (TAU * f) / SR;
                this.c[i] = Math.cos(w);
                this.s[i] = Math.sin(w);
                if (first) this.swell[i] = raw < 0 ? 1 : 0;
                // Response at the pickup, falling as 1/√(f/f1) (velocity to
                // pressure, roughly).
                const amp = audible ? (this.strike[i] * pickup[i]) / Math.sqrt(f / f1) : 0;
                this.gainTarget[i] = amp;
                // How much of the strike's energy reaches this mode: the
                // raised-cosine contact's spectrum at f (1 at DC, a null past
                // 2/τ). Normalising the *excited* sum, not the raw one, keeps a
                // soft strike on a tiny bright object as loud as a hard one on
                // a drum — hardness and size change the colour, `hit` and
                // velocity the level.
                const ft = (f * this.pulseLen) / SR;
                const spectrum = ft < 1e-6 ? 1 : Math.abs(Math.sin(Math.PI * ft) / (Math.PI * ft) / (1 - ft * ft + 1e-9));
                norm += Math.abs(amp) * Math.min(1, spectrum);
                rawNorm += Math.abs(amp);
            }
            // …but never by more than ~22dB: past that the strike genuinely
            // misses the object, and the null's exact depth isn't worth trusting.
            const scale = 0.9 / Math.max(1e-4, norm, rawNorm * 0.08);
            for (let i = 0; i < COUNT; i++) this.gainTarget[i] *= scale;
            this.couple = clamp(P.couple + mods.couple, 0, 1);
            this.grime = clamp(P.grime + mods.grime, 0, 1);
            if (first) {
                proc.lastStrike = Array.from(this.strike);
                proc.lastFreqs = Array.from(this.freqs);
            }
        }

        render(L, R, from, to, P) {
            const proc = this.proc;
            const drift = P.drift * 0.015;
            const mix = P.mix;
            // `hit` beyond 1 drives harder rather than just louder.
            const out = Math.pow(10, P.out_db / 20) * 0.5 * Math.min(2, Math.max(1, P.hit));
            const grainMul = P.grain;
            const biteDrive = 1 + P.bite * 6;
            const biteFb = P.bite * 0.85;
            for (let i = from; i < to; i++) {
                if ((this.n & (UPDATE - 1)) === 0) {
                    // Run rows re-resolve; drift re-detunes.
                    if (proc.hasRun) this.solve(P, proc.resolveMods(P, this, this.latched), false);
                    if (drift > 0) {
                        for (let k = 0; k < COUNT; k++) {
                            const wv = this.driftW[k];
                            const d = drift * (wv[0] * proc.driftSin[0] + wv[1] * proc.driftSin[1] + wv[2] * proc.driftSin[2]) / 1.7;
                            const w = (TAU * this.freqs[k] * (1 + d)) / SR;
                            this.c[k] = Math.cos(w);
                            this.s[k] = Math.sin(w);
                        }
                    }
                }
                let x = 0;
                if (this.n < this.pulseLen) x = (0.5 - 0.5 * Math.cos((TAU * this.n) / this.pulseLen)) * this.pulseGain;

                let body = 0;
                const couple = this.couple * 0.004;
                for (let k = 0; k < COUNT; k++) {
                    const g = this.gain[k] += (this.gainTarget[k] - this.gain[k]) * 0.002;
                    let input = x * Math.sign(g || 1);
                    if (couple > 0) input += tanh(this.prev[(k + COUNT - 1) % COUNT] * 4) * couple;
                    let r = this.r[k];
                    // Anti-Wood: a backwards restoring force swells for a
                    // moment before the loss wins.
                    if (this.swell[k] > 0 && this.n < 0.15 * SR) r = 1.00004;
                    const re = this.re[k], im = this.im[k];
                    const c = this.c[k], s = this.s[k];
                    let nre = r * (c * re - s * im) + input;
                    let nim = r * (s * re + c * im);
                    // Soft saturation on each mode's energy: coupled modes
                    // that land on one frequency (the neutronium floor, a
                    // drift crossing) can't feed each other without bound.
                    const mag2 = nre * nre + nim * nim;
                    if (mag2 > 4) {
                        const k2 = 2 / Math.sqrt(mag2);
                        nre *= k2; nim *= k2;
                    }
                    this.re[k] = nre;
                    this.im[k] = nim;
                    this.prev[k] = nim;
                    body += nim * Math.abs(g);
                }

                let y = body;
                if (this.grime > 0) {
                    let dirt = 0;
                    const lines = this.grimeLines;
                    for (let l = 0; l < 4; l++) {
                        const d = Math.min(0.099 * SR, (SR / this.freqs[GRIME_MODES[l]]) * grainMul);
                        const back = lines[l].read(Math.max(1, d - 1));
                        const v = fold(body * biteDrive + back * biteFb);
                        lines[l].write(v * 0.7);
                        dirt += v;
                    }
                    dirt = this.grimeLp.lp(dirt * 0.25);
                    y = body + (dirt - body) * this.grime;
                }
                y = y * mix + x * (1 - mix) * 4;
                y *= out;
                L[i] += y;
                R[i] += y;
                this.n++;
                if (this.n > this.pulseLen && Math.abs(y) < 1e-5) {
                    if (++this.quiet > 4096) return false;
                } else this.quiet = 0;
                if (this.n > this.maxSamples) return false;
            }
            return true;
        }
    }

    const Processor = voiceProcessor(Base, (m, P, proc) => {
        proc.push(m.velocity);
        return new Voice(m, P, proc);
    }, 6, {
        init() {
            this.rng = new Rng(0xb16);
            this.matA = this.opts.matA ?? { rho: 1390, E: 4e9, eta: 0.012 };
            this.matB = this.opts.matB ?? this.matA;
            this.mods = this.opts.mods ?? {};
            this.hasRun = Object.values(this.mods).some((row) => row && row.run);
            this.attractors = [0, 1, 2, 3, 4, 5].map((i) => new Coullet(0x1000 + i * 7919));
            this.chaos = new Float64Array(6);
            this.pushState = 0;
            this.driftPhase = [0, 0.3, 0.7];
            this.driftSin = [0, 0, 0];
            this.lastStrike = null;
            this.lastFreqs = null;
            this.frame = 0;
            this.posted = 0;
        },
        message(m) {
            if (m.type === "materials") {
                this.matA = m.a;
                this.matB = m.b;
            } else if (m.type === "mods") {
                this.mods = m.mods;
                this.hasRun = Object.values(this.mods).some((row) => row && row.run);
            }
        },
        before(L, R, P) {
            const frames = L.length;
            const dt = frames / SR;
            // Attractors advance once per block. Their speeds are the golden
            // ratio's powers scaled by `spread`: irrational ratios, so the six
            // destinations never line up. A note's push decays over ~1s.
            this.pushState *= Math.exp(-dt / 0.8);
            const base = P.rate * 6 * (1 + this.pushState * 3);
            for (let i = 0; i < 6; i++) {
                const speed = base * Math.pow(1.6180339887, (i - 2.5) * P.spread * 0.5);
                this.chaos[i] = this.attractors[i].step(speed * dt * 5, P.wander);
            }
            for (let k = 0; k < 3; k++) {
                this.driftPhase[k] += DRIFT_HZ[k] * dt;
                this.driftSin[k] = Math.sin(TAU * this.driftPhase[k]);
            }
            // Report the last strike to the main thread, at most 4×/second.
            this.frame += frames;
            if (this.lastStrike && this.frame - this.posted > SR / 4) {
                this.posted = this.frame;
                this.port.postMessage({ type: "strike", strike: this.lastStrike, freqs: this.lastFreqs });
                this.lastStrike = null;
            }
        },
    });

    // A note pushes the attractors' speed by its velocity — the music
    // deflects the chaos rather than replacing it.
    Processor.prototype.push = function push(velocity) {
        this.pushState = Math.min(2, this.pushState + velocity);
    };

    // The offset each mod row adds to its destination, in that
    // destination's own units. With `latched` given, a latch row keeps the
    // value it had at the strike and only run rows are read fresh.
    Processor.prototype.resolveMods = function resolveMods(P, voice, latched) {
        const out = {};
        for (let d = 0; d < DESTS.length; d++) {
            const dest = DESTS[d];
            const row = this.mods[dest];
            if (!row || row.source === "off") {
                out[dest] = 0;
                continue;
            }
            if (latched && !row.run) {
                out[dest] = latched[dest];
                continue;
            }
            let value = 0;
            if (row.source === "chaos") value = this.chaos[d];
            else if (row.source === "vel") value = voice.velocity * 2 - 1;
            else if (row.source === "note") value = clamp((voice.note - 60) / 24, -1, 1);
            const [lo, hi] = RANGES[dest];
            out[dest] = (row.amount / 100) * (hi - lo) * value;
        }
        return out;
    };

    return Processor;
};

registerWorkletProcessor("ribbit-bigmodal", bigmodalProcessor, workletParams(BIGMODAL_PARAMS));

export class RibbitBigModal extends RibbitWorkletSynth {
    constructor(audioContext, options = {}) {
        // A preset is a recipe: its values fill in anything the caller
        // didn't give explicitly, so a saved session (which carries every
        // param and option) is never overridden by its own preset name.
        const preset = PRESET_NAMES.includes(options.preset) ? options.preset : null;
        const merged = preset ? { ...BIGMODAL_PRESETS[preset], ...options } : { ...options };
        const matA = MATERIAL_NAMES.includes(merged.mat_a) ? merged.mat_a : "mylar";
        const matB = MATERIAL_NAMES.includes(merged.mat_b) ? merged.mat_b : "glass";
        const mods = {};
        for (const dest of MOD_DESTS) mods[dest] = parseModRow(merged[`mod_${dest}`]);
        super(audioContext, { name: "bigmodal", ...merged }, {
            processor: "ribbit-bigmodal",
            params: BIGMODAL_PARAMS,
            lane: "6",
            sieve: "odd",
            processorOptions: { matA: MATERIALS[matA], matB: MATERIALS[matB], mods },
        });
        this.llm_summary = "A struck disc solved from physics (the AE machine's Big Modal): 16 modes from Bessel zeros of a stiff membrane; mat_a/mat_b (25 materials incl. 7 impossible ones) morphed logarithmically, radius/thick/tension (0 = plate, high = drum), stretch, damp_tilt, contact_r/contact_theta (where you hit it), couple/drift/grime/bite/grain. Six chaotic mod rows mod_<dest>=chaos|vel|note:<amount>[:run]. Lane 6, odd notes.";
        this.preset = preset ?? "none";
        this.mat_a = matA;
        this.mat_b = matB;
        this.mods = mods;
        this.lastStrike = null;
        this._dsp = dspLibrary();
        this._table = this._dsp.discModeTable(16);

        const sendMaterials = () => this.node.post({ type: "materials", a: MATERIALS[this.mat_a], b: MATERIALS[this.mat_b] });
        const materialOption = (field) => ({
            get: () => this[field],
            set: (value) => {
                const text = String(value).trim().toLowerCase();
                if (!MATERIAL_NAMES.includes(text)) throw new Error(`invalid ${field} "${value}" — expected ${MATERIAL_NAMES.join(", ")}`);
                this[field] = text;
                sendMaterials();
            },
            choices: MATERIAL_NAMES,
        });
        this.options.mat_a = materialOption("mat_a");
        this.options.mat_b = materialOption("mat_b");
        for (const dest of MOD_DESTS) {
            this.options[`mod_${dest}`] = {
                get: () => formatModRow(this.mods[dest]),
                set: (value) => {
                    this.mods[dest] = parseModRow(value);
                    this.node.post({ type: "mods", mods: this.mods });
                },
            };
        }
        // Loads a factory object: materials, params and mod rows. A gesture
        // over existing controls — every value it sets stays editable.
        this.options.preset = {
            get: () => this.preset,
            set: (value) => {
                const text = String(value).trim().toLowerCase();
                if (!PRESET_NAMES.includes(text)) throw new Error(`invalid preset "${value}" — expected ${PRESET_NAMES.join(", ")}`);
                this.applyPreset(text);
            },
            choices: PRESET_NAMES,
        };
        this.onWorkletMessage = (message) => {
            if (message.type === "strike") this.lastStrike = message;
        };
    };

    applyPreset(name) {
        const recipe = BIGMODAL_PRESETS[name];
        const now = this.audioContext.currentTime;
        for (const dest of MOD_DESTS) this.mods[dest] = { source: "off", amount: 0, run: false };
        for (const [key, value] of Object.entries(recipe)) {
            if (key === "mat_a" || key === "mat_b") this[key] = value;
            else if (key.startsWith("mod_")) this.mods[key.slice(4)] = parseModRow(value);
            else if (this.params[key]) {
                this.params[key].audioParam.cancelScheduledValues(now);
                this.params[key].set(this.params[key].clamp(value));
            }
        }
        this.preset = name;
        this.node.post({ type: "materials", a: MATERIALS[this.mat_a], b: MATERIALS[this.mat_b] });
        this.node.post({ type: "mods", mods: this.mods });
    };

    // The manual's three read-outs for the object as currently dialled —
    // computed with the same functions the worklet plays.
    readouts() {
        const get = (key) => this.params[key].get();
        const t = get("morph");
        const a = MATERIALS[this.mat_a], b = MATERIALS[this.mat_b];
        const rho = Math.exp(Math.log(a.rho) + (Math.log(b.rho) - Math.log(a.rho)) * t);
        const E = Math.sinh(Math.asinh(a.E / 1e6) + (Math.asinh(b.E / 1e6) - Math.asinh(a.E / 1e6)) * t) * 1e6;
        const freqs = this._dsp.discFrequencies(this._table, {
            radius: get("radius") / 1000, thick: get("thick") / 1000, tension: get("tension"), rho, E, stiffness: get("stretch"),
        });
        const octave = Math.pow(2, Math.round(get("oct")));
        const f1 = Math.abs(freqs[0]) * octave;
        const f16 = Math.abs(freqs[freqs.length - 1]) * octave;
        return { f1, c: Math.sqrt(Math.abs(E) / rho), ratio: f16 / Math.max(1e-9, f1), negative: freqs.some((f) => f < 0) };
    };

    describeState() {
        const { f1, c, ratio, negative } = this.readouts();
        const fmt = (x) => (x >= 100 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toPrecision(2));
        let text = `[${this.mat_a}→${this.mat_b} · f1 ${fmt(f1)}Hz · c ${fmt(c)}m/s · f16/f1 ${ratio.toFixed(2)}${negative ? " · negative stiffness" : ""}`;
        if (this.lastStrike) {
            const peak = Math.max(...this.lastStrike.strike.map(Math.abs), 1e-9);
            text += ` · last strike ${this.lastStrike.strike.map((v) => Math.round((Math.abs(v) / peak) * 9)).join("")}`;
        }
        return `${text}]`;
    };
};
