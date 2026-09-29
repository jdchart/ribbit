# The AE Machine, rebuilt in ribbit

A reading of Emiliano Pennisi's *AE Machine* (a generative percussion engine
for Max/MSP 9 — user manual at <https://www.peamarte.it/ae/_Machine_Manual.html>)
and how its parts map onto ribbit's three kinds of object. This is a
**clean-room reconstruction from the manual's prose**: the Max patch, its gen~
code and its presets were never seen (the product's licence forbids extracting
them, and none of it is needed — the manual describes behaviour, and behaviour
is what is rebuilt here). Numbers quoted below (ranges, divisors, plateaus,
wear timings) are the manual's; every DSP decision behind them is ours.

Nothing here is a port. Where the manual is silent — how Cascade shifts
pitch, what Notverb's tank is, which equation Terrarium's agents read — the
choice is documented in the source file that makes it.

---

## 1. Breakdown

The machine is one surface in Max. In ribbit it decomposes into **15 synths,
12 processors and 9 modulators**, plus three small engine changes. The rule
used to split it: *a voice that is struck or switched on* is a synth (it sits
on a track); *something that treats a signal* is a processor (it sits in a
channel — the AE's shared effects become buses, exactly like its send
architecture); *something that decides, moves or routes* is a modulator.

### Synths — the voices

| AE module (file) | ribbit type | what it is |
|---|---|---|
| FM Voice `aemd_fm` | `fmperc` | 2-op FM, separate amplitude and index envelopes, drive/fold/downsample |
| Modal Voice `aemd_modal` | `modal` | 8 decaying resonators struck by noise; MATERIAL crossfades 5 ratio sets |
| Drone Voice `aemd_drone` | `drone` | 3 detuned saws → multimode resonant filter, sustains; TRIG%/REBIRTH%/HOLD |
| Hats Voice `aemd_hat` | `noisehat` | noise → one low + two high resonant bands, one envelope |
| Sub Voice `aemd_sub` | `subdrum` | falling sine + noise click + random-pitched spike |
| String Voice `aemd_ks` | `twostring` | two coupled Karplus-Strong strings: pick, stiffness, tension, scatter |
| Metal Bass Voice `aemd_mtl` | `metalbass` | sub sine + 4-mode metal resonator, comb, ring mod, own ping-pong delay |
| Crack Voice `aemd_crk` | `crack` | 1–4 noise bursts (rim → clap), tuned body, rattle (snare wires) |
| Kick Voice `aemd_v1b` | `foldkick` | one oscillator, pitch sweep, wavefolder, sub, built-in compressor |
| Bass drum `aemd_bd` (voce 1) | `bassdrum` | inharmonic non-resonant kick: sweep, 2-partial knock, click, asym. saturation, per-hit variation, rumble reverb, LSY degradation |
| Materials / Big Modal `aemd_v2` | `bigmodal` | a struck disc *solved*: 16 modes from Bessel zeros of a stiff membrane, 25 materials, strike position, ring coupling, grime network, six chaotic mod rows |
| Tape Pad `aemd_ewd` | `tapedrone` | free-running: 5 triangle voices at 432 Hz, imperceptible drift, wow/flutter, comb wash |
| Samplers 2, 3, 4 `voce_2..4` | `microsampler` | note = pitch (48 original); micro-loop engine where velocity is geometry |
| Slice Sampler `aems_v1` | `slicer` | onset slicing, window/declick, negative rate, four step deviations |
| Multicluster `smp8_analysis` | `multicluster` | slices sorted into timbre clusters; one instance per cluster, shared seeded choice |

### Processors — the effects

| AE module | ribbit type | where it goes |
|---|---|---|
| Deep Pad `aemd_thmk` + *Send to Drone / Excite* | `deeppad` | a bus. Ten resonators in permanent self-excitation; whatever is sent into the bus becomes the excitation (the "convolution you can play") |
| Resonators `aem_fx_res` | `resonators` | send bus: 4 tuned strings on a scale |
| Cascade `aem_fx_cascade` | `cascade` | send bus: delay with a pitch shifter inside the loop |
| Notverb `aem_fx_notverb` | `notverb` | send bus: FDN reverb that freezes |
| Glaze `aem_fx_glaze` | `glaze` | send bus: 6 grains reading a rolling buffer |
| Drive `aem_fx_drive` | `drivenet` | send bus: 4 folded delay lines at irrational ratios |
| Spectra `aem_fx_spectra` | `spectra` | send bus: 12-partial photograph → robot vocoder + sympathetic strings |
| LSYX `aemd_lsyx` | `lossyverb` | after `spectra` on the same bus (or anywhere): a reverb built like a failing codec |
| Breathe `aem_fx_breathe` | `breathe` | the pads bus: 3-band compressor + per-band duck, keyed by a patch |
| Micro Delays `aem_fx_mdelay` ×2 | `microdelay` | two buses: tuned stutter combs that burst on hits |
| Circular looper `aemd_looper` | `looper` | a bus fed by the mix: 30 s buffer, hand-drawn playhead curves |
| Oxide `aemd_tape` | `oxide` | after `looper`: tape transport (spool, wear, disintegration) + spring tank |
| Master chain: colour / plate / DC block | existing `saturator` (mix), `reverb`, `svf mode=highpass` | master |

### Modulators — the brain and the weather

| AE module | ribbit type | shape |
|---|---|---|
| Sequencer + Markov matrix + self-rewriting + column animation + voice weights + Voice Dispatch (ch. 6–10, 14) | `markovseq` | event generator |
| Elastic tempo `aem_warp_CLOCK` (ch. 11) | `elastictempo` | session-acting (rides the clock's bpm) |
| Probability jumpers + DICE (ch. 12) | `dicejumpers` | session-acting (calls each effect's own `jump()`) |
| Terrarium `aemd_terra` + pattern shuffler `terra_control` (ch. 45) | `terrarium` | session-acting (Lorenz agents grab, move, return) |
| Mod panels, one modulator per parameter (ch. 42) | `modlfo` | continuous: 7 shapes incl. S&H and drift, synced or free |
| FX mod banks + pan drift `aem_panbank` (ch. 43–44) | `driftbank` | session-acting (send gains / pans) |
| Big Modal's attractors, as a general source | `attractor` | continuous: Coullet / Lorenz / Rössler at audio rate, pushed by notes |
| Feedback matrix `aemd_fbmatrix` (ch. 40) | `fbmatrix` | session-acting *and* audio: owns delayed cross-sends between effect buses |
| Shapes: four drawable envelopes `aems_shape` (ch. 27) | `curveloop` | continuous: a drawn curve looping on a musical length |

### What maps onto something ribbit already has

| AE | ribbit |
|---|---|
| 96-slot preset grid, STORE/recall | `/save <name>`, `/recall <name>`, session files |
| Preset morphing, GO over TIME s | `/recall <name> 30` (a ramped recall *is* a morph; switches flip at the end) |
| Random All | `/<object> random`, `random=4b` |
| Stem recording, 27 files | `/recording mode=multitrack` then `/record` |
| Mixer strips with six sends | tracks with `add_send=` to the six effect buses |
| Mute / pan / level | channel `mute`, `pan=`, `gain=` |

### Engine changes the rebuild needs

1. **AudioWorklet DSP** (`src/dsp/`). The voices and effects need
   single-sample feedback (a pitch shifter inside a delay loop, a string whose
   loop is 30 samples long, a freeze that must not decay) which Web Audio
   node graphs cannot express — any cycle is forced to 128 samples. The engine
   already compiles one worklet from an inline blob URL (`recorder.js`); this
   generalises that into a registry every type adds its processor to, loaded
   once per `AudioContext`, still asking the host for nothing.
2. **A synth may decline a note.** `trigger()` returning `false` means "not
   mine" and the clock then doesn't stamp `lastEventTime` — so the sieve (each
   voice checks whether a note belongs to it, exactly as the manual describes)
   doesn't light every voice's lamp on every note.
3. **A shared microtonal tuning** on the harmony context:
   `/harmony tuning=bohlen_pierce` (or a cents list with a period). Voices with
   `quant=on` snap to it; nothing else changes meaning.

---

## 2. The central mechanisms, and how they are rebuilt

### The sieve (ch. 14)

`markovseq` stamps every note it emits with a **lane** (the Trig family,
1–6). Every AE voice carries two options, `lane` and `sieve`, and plays a
note only if the lane matches and the note passes its sieve (`4:0` = "note
mod 4 is 0", `even`, `odd`, `all`). The defaults reproduce the manual's
table: FM 4:0, modal 3:1, drone 4:2, hats 4:3, sub 5:4, string 6:5, metal
8:1, crack 7:3 on lane 5; bassdrum on lane 1; microsamplers on 2 (change to
3, 4); foldkick `even` and bigmodal `odd` on lane 6. A note from anything
that isn't `markovseq` carries no lane and is simply played, so every voice
also works as an ordinary ribbit synth. Appendix A's note map falls out of
the arithmetic (verified: 17 solo notes in 36..72, note 59 = hats, sub,
string, crack). The manual's printed appendix A disagrees with its own rule
table on five notes — 49, 52, 53, 55, 57 (55 mod 4 = 3 is hats, not drone;
53 is the string alone, not the crack) — so the appendix was drawn by hand;
the rules win here.

### The Markov walk (ch. 7–9)

`markovseq` keeps its own step cursor in beats (Metrics make steps irregular,
so it cannot index off the loop). At each step: roll Step Prob; emit the
note (plus ratchets if Rat Prob fires) with Micro Timing as a time offset;
pick the next step from the row's exits (random step if the row is empty);
animate columns (rotate by one, inject with probability; an injection on
Note or Shift fires every `dicejumpers` listening to this sequencer); every
`every` steps rewrite or mutate the matrix. The step length is
`metrics × s_size × swing`, in beats; `elastictempo` bends the clock itself,
so everything in the session stretches together, as in the original.

### Elastic tempo (ch. 11)

An episode runs four phases — sparse (slow), accel (past the original),
brake, relaunch — as `clock.rampBpm` segments whose lengths scale with
`len`, landing on a plateau from {½, ⅔, ¾, 4/3, 3/2, 2} × base, or back on
base with probability `grid`.

### Terrarium (ch. 45)

A Lorenz system integrated at control rate (`rho` is the regime control:
below 1 it dies, 1–24.7 it settles, ~28 is the butterfly). Agents grab
params anywhere in the session (the same `canRandomize` pool
`randomgestures` uses), move them by the trajectory's coordinate, hold them
for `hold_min..hold_max` ms, and give back exactly the value they found
(unless `hold=on`). Crossing between lobes reshuffles the region→param map
with probability `scramble`, and may fire a pattern shuffle on a
`markovseq`. A trajectory that stops moving for half a second releases
everything.

### Big Modal's physics (ch. 30)

Mode frequencies of a stiff circular membrane:
`ω² = (T/σ)·k² + (D/σ)·k⁴`, `k = j_mn / a`, with `σ = ρh` the surface
density and `D = E h³ / 12(1−ν²)` the bending stiffness; `j_mn` are Bessel
zeros solved at load (bisection on `J_m`, series + recurrence). Tension 0 is
a plate (dispersive, inharmonic), high tension a membrane (harmonic-ish) —
the manual's "tension 0 = plate, high = membrane". Strike position gives each
mode `J_m(j_mn·r)·cos(mθ)`, so a centre strike excites only `m = 0` modes.
Materials are real constants (density, Young's modulus, loss factor) plus
seven that nature forbids. Morph between two materials is logarithmic in each
constant. Using the membrane's zeros for the plate term is the standard
"stiff membrane" approximation (a free or clamped plate has different
eigenvalues); it keeps one continuous family from plate to drum.

### The rest

Each type's source file opens with the manual's description and the DSP
chosen for it. Where the manual gives numbers (hats' band ranges, crack's
4–16 ms spread, Oxide's wear-to-bandwidth table and its 0.6 Hz / 6 Hz
wow/flutter, the attractors' 0.27/0.18/0.11 Hz drift, the looper's 30 s) they
are used as given.

---

## 3. How it turned out

Everything in §1 is built and registered (`src/synths`, `src/processors`,
`src/modulators`, shared DSP in `src/dsp` — see `worklets.md`). Checks that
tie it back to the manual:

- The sieve reproduces the rule table: `note=36` on every step plays FM
  alone, `note=59` exactly hats, sub, string and crack.
- Big Modal's `mylar_tom` (mylar, 140 mm, 0.2 mm, tension 3000) reads f1
  284 Hz and f16/f1 4.85 — the numbers in the manual's own screenshot
  caption — so the stiff-membrane model agrees with the original's.
- Oxide's wear model is fitted to the manual's timings (wear 0.15: noticed
  ~27 s, clearly old ~52 s, residue at 73 s) and its oxide→bandwidth/level
  table.
- The Coullet orbits run with an average period of ~2 s at the default rate,
  as the manual says; Cascade at +7 climbs in fifths (measured 654, 981,
  1529 Hz from 440).
- The whole machine (`ae-machine`: 16 voices, 13 worklet effects, 11
  modulators) keeps the audio clock at 100% of wall time in Chromium; the
  per-type costs, measured in Node's V8, sum to ~13% of one core for one of
  each type (tape pad and deep pad are the heaviest voices, spectra the
  heaviest effect).

Where the rebuild departs from the original, and why, is at the end of
`docs/user/ae-machine.md`.

## 4. Research notes

- **Coullet attractor** — the Arneodo–Coullet–Tresser family
  `x' = y, y' = z, z' = a·x + b·y + c·z − x³` (Sprott's parameters
  a = 0.8, b = −1.1, c = −0.45), the form the Wakefield/Taylor gen~ book's
  example is built on. Six instances at irrational speed ratios feed Big
  Modal; `attractor` exposes it (and Lorenz, Rössler) as a general source.
  ([Arneodo attractor, P. Bourke](https://paulbourke.net/fractals/arneodo/);
  [*Generating Sound & Organizing Time*](https://cycling74.com/books/go))
- **Circular membrane / plate modes** — Bessel zeros and the membrane–plate
  continuum ([Illinois PHYS 406 notes](https://courses.physics.illinois.edu/phys406/sp2017/Lecture_Notes/P406POM_Lecture_Notes/P406POM_Lect4_Part2.pdf);
  [Euphonics 3.6.1](https://euphonics.org/3-6-1-vibration-modes-of-a-circular-drum/)).
- **Spring reverb** — dispersion from long allpass cascades, the chirp that
  makes a spring a spring ([Parker, *Efficient Dispersion Generation
  Structures for Spring Reverb Emulation*](https://aaltodoc.aalto.fi/handle/123456789/26525);
  Välimäki, Parker & Abel, *Parametric Spring Reverberation Effect*).
- **The original inspiration** — Autechre's 2022–23 system videos: a drum
  sequencer driving a Modalys snare, transition matrices deciding step order
  ([Cycling '74 forum](https://cycling74.com/forums/autechre-system-videos-from-sean);
  [aepages](https://aepages.org/wiki/AE_2022%EF%BC%8D)).
- **Teletype `M RRND 150 2000`** — the manual's own origin for elastic
  tempo: a metro that re-rolls its interval every tick; elastic tempo replaces
  the blind roll with shaped arcs onto related ratios.
- **FluCoMa** (onset slicing, MFCC clustering) — replaced by a spectral-flux
  onset detector and k-means over a small per-slice feature vector (log band
  energies, centroid, flatness, loudness), computed in JS on load.
