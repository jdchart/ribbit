# The AE Machine in ribbit

A rebuild of **AE Machine**, Emiliano Pennisi's generative percussion engine
for Max/MSP ([manual](https://www.peamarte.it/ae/_Machine_Manual.html)), as
36 ribbit types you can use on their own or together. It was reconstructed
from the manual alone — the original patch and its code were never seen — so
every sound here is ribbit's own; the manual's structure, behaviours and
numbers are what was followed. How it was broken down, and the research
behind the DSP: [docs/dev/ae-machine.md](../dev/ae-machine.md).

Six sessions ship with it (open them in lilypad with `/?session=<name>`, or
in nllc at `/code-editor/<name>`):

| session | what it is |
|---|---|
| `ae-machine` | the whole machine: 16 voices, 12 effect/utility buses, 11 modulators |
| `ae-sieve` | the eight kit voices and one sequencer — learn how notes choose instruments |
| `ae-materials` | three Big Modal objects, one playing another |
| `ae-landscape` | the machine with the drums taken out: pads, drone, feedback, a disintegrating loop |
| `ae-clusters` | one recording read three ways: timbre families, a sliced window, micro-loops |
| `ae-dark` | a sparse, dark, Autechre-ish patch generated from one seed — a steady beat that varies in the details, and a slow synth line |

Each prints a readme with commands to try when it opens.

---

## 1. The idea: notes choose instruments

The sequencer (`markovseq`) sends every note on a **lane** — the AE's *Trig*
family, 1–6 — and **every voice hears every note**. Each voice then decides
for itself whether the note is its own: its `lane` must match, and the note
must pass its `sieve` — "divide the note by my number, and see if the
remainder matches mine".

| lane | who answers | what the note does |
|---|---|---|
| 1 | `bassdrum` | nothing but trigger it (it bends tune slightly) |
| 2, 3, 4 | the three `microsampler`s | real pitch — note 48 plays the file at its own speed |
| 5 | the kit, through the sieve | **chooses the instruments**, and sets their pitch |
| 6 | `foldkick` (even notes) and `bigmodal` (odd notes) | only its parity matters |

The kit's sieves (lane 5):

| voice | plays when | |
|---|---|---|
| `fmperc` | note ÷ 4 leaves 0 | `sieve=4:0` |
| `modal` | note ÷ 3 leaves 1 | `3:1` |
| `drone` | note ÷ 4 leaves 2 | `4:2` |
| `noisehat` | note ÷ 4 leaves 3 | `4:3` |
| `subdrum` | note ÷ 5 leaves 4 | `5:4` |
| `twostring` | note ÷ 6 leaves 5 | `6:5` |
| `metalbass` | note ÷ 8 leaves 1 | `8:1` |
| `crack` | note ÷ 7 leaves 3 | `7:3` |

Because the divisors are 3 to 8, who answers repeats only every 840 notes.
Seventeen notes between 36 and 72 are solos; learn five: **36** FM alone,
**37** modal alone, **42** drone alone, **45** crack alone, **59** hats + sub +
string + crack. **Transposing a pattern re-orchestrates it** — `/seq
note=…` with every value +1 is a different kit playing the same rhythm.

(The manual's printed note map disagrees with its own rule table on five
notes — 49, 52, 53, 55, 57. The rules are what's implemented.)

`lane` and `sieve` are ordinary options, so any voice can be moved: `/hats
sieve=all` answers everything; `/crack lane=6 sieve=3:0` joins lane 6. A note
that doesn't come from `markovseq` (your own `add_event`, a pianoroll, another
generator) carries no lane and every voice simply plays it — so each voice is
also a normal ribbit synth. A voice that declines a note doesn't light its
lamp.

---

## 2. The sequencer — `markovseq`

Sixteen steps, eleven columns, each an option of sixteen comma-separated
values (a shorter list repeats: `note=36,37` alternates). In lilypad, click the
node's step strip (or *grid…* in the inspector) for the grid editor.

| column | range | |
|---|---|---|
| `trig` | 0–6 | the lane; 0 is a rest |
| `note` | 0–127 | on lane 5 an address, not a melody |
| `vel` | 0–127 | loudness — and on the struck voices, hardness |
| `shift` | 0–127, 64 centre | micro-detune, ±1.25 semitones |
| `metrics` | `1/4` `1/8` `1/16` `1/32` `1/64` `1/8t` `1/16t` `1/32t` `1/8d` `1/16d` | the step's length |
| `ratchet` | 1–8 | retriggers inside the step |
| `ssize` | 1–4 | multiplies the step length |
| `ratprob` | 0–100 | chance the ratchet fires |
| `swing` | 0–100 | per step: lengthens/shortens alternate steps of the walk |
| `prob` | 0–100 | chance the step plays at all |
| `micro` | 0–127, 64 centre | pushes the note ±25 ms without moving the clock |

**The matrix.** `matrix` lists, for each step, the steps it may jump to
(`2|3|4,1|…`, 1-based, `.` for none). With several exits one is picked at
random each pass; an empty row jumps anywhere, so it can never get stuck.
`shape=chain|returns|cells|wide|random|clear` loads a starting point (the
manual's four: a loop; bars that fold back every four; five three-step cells;
dense, no downbeat). "Fewer dots is stronger."

**A matrix that rewrites itself.** `rewrite=on every=32 density=1
morph=mutate` — every 32 steps take away one or two jumps and add one or two:
the grammar drifts and you can't point at the moment it changed. `morph=rewrite`
redraws it outright.

**Column animation.** `animate=note,metrics` turns those columns into shift
registers: they rotate one step per step and, with chance `inject`, a new
value enters at the top. An injection on `note` or `shift` fires the
jumpers (a change of note becomes a change of effect). Animating `trig` draws
new families from `weights` (rest, voce1, drum, smp, bd·mat — proportions):
"on, listen, off" — freeze it with `animate=none` when it lands on an
orchestration you like. `dispatch=0,2,2,1,…` draws the orchestration by hand
(0 rest, 1 a sampler, 2 the kit, 3 kick/big modal).

---

## 3. The voices

Every voice has `level`; the pitched ones `quant` (snap to the shared tuning,
below). Recipes are the manual's.

- **`fmperc`** — two-operator FM. `harm` is the ratio ("the ratio knob is the
  instrument"), `index` brightness, `a_dec`/`i_dec` separate amplitude and
  timbre decays, `curve`, `drive`/`fold`/`down`. Wood block: harm 2–3, index
  2–5, short decays, curve negative. Bell: harm 1.4 or 3.5, index 15–25,
  a_dec long, i_dec short.
- **`modal`** — eight resonators struck by noise. `material` crossfades drum,
  mixed, harmonic, bell, metal; `inharm`, `disp`; `decay` up to 5.5 s;
  `damp` — the realism control; `bright` the strike. Velocity changes the
  strike, not only the level. Tom: 0 / 0.3 / 0.6 / 0.3; bell: 0.75, decay
  0.8, damp 0.15, inharm 0.3.
- **`drone`** — the one voice that sustains. `trig`% of notes retrigger it,
  `rebirth`% also jump its octave; `hold=on` keeps it open and ignores notes
  (toggle it off and on to re-excite). `cutoff` is exponential: 0.25 ≈ 85 Hz.
- **`noisehat`** — closed hat `decay=25 mix=0.8 curve=-0.6`, open `decay=300`,
  shaker `decay=60 mix=0.5 lowq=0.1 hiq=0.1`, rim tick `mix=0.1 low=900
  lowq=2 decay=15`.
- **`subdrum`** — `chtime` is the character: under 20 ms tight, ~80 a 909
  tail, over 200 a falling tone.
- **`twostring`** — kalimba `bright=0.4 decay=0.5 pick=0.25 stiff=0.1
  couple=0`; sitar `scatter=0.5 couple=0.7 bright=0.7`; metal rod `stiff=0.9
  bright=0.9 decay=0.9 pick=0.5`.
- **`metalbass`** — sub + metal; its `d_*` delay is part of the instrument.
- **`crack`** — rim `cracks=0 tone=0.7 q=0.8 body=0.4 rattle=0`; clap
  `cracks=1 spread=0.5 nse_dcy=0.4 body=0 rattle=0.2`; snare `cracks=0.3
  body=0.6 rattle=0.7 tone=0.4`.
- **`foldkick`** — pitch in Hz; `punch` holds, `body` folds, `comp` squeezes.
- **`bassdrum`** — never rings; every hit varies (`vary`). `rvb` is its own
  rumble reverb, `lsy`/`freq`/`pack` a degradation macro. `dice=random`
  rerolls it, hidden `lsy_mode` included.
- **`bigmodal`** — see §4.
- **`tapedrone`** — a switch, not an instrument: it plays while its track is
  started, fading in over `att` (up to 20 s). The chord never moves; its
  colour drifts on a one-to-two-minute clock.
- **`microsampler`** — see §6.
- **`slicer`**, **`multicluster`** — see §6.

### Tuning

`/harmony tuning=<name>` sets the shared tuning every `quant=on` voice snaps
to: `chromatic`, `major`, `minor`, `pentatonic`, `wholetone`, `ji_major` (just
thirds and fifths), `et19` (19 notes per octave), `bohlen_pierce` (13 steps of
the 3:1 twelfth — "strange and coherent"), a cents list (`tuning=0,150,300,450
period=1200`), or `off` (snap to `/harmony scale=` in semitones). Degrees
elsewhere in ribbit are unaffected.

---

## 4. Big Modal — `bigmodal`

"A struck disc, solved rather than tuned." Set a material, a size, a
thickness, a tension and where you hit it; the sixteen partials are
computed from the equation of a stiff circular membrane (Bessel functions
solved at load).

- **Materials**: `mat_a`, `mat_b`, crossfaded logarithmically by `morph`.
  Eighteen real (mylar, kevlar, spruce, ebony, bamboo, bone, ice, glass,
  quartz, aluminium, titanium, steel, bronze, lead, gold, tungsten, rubber,
  graphite) and seven impossible: `lead_aerogel`, `immortal_glass` (minutes
  of ring), `dark_matter`, `neutronium` (the model gives up), `anti_wood`
  (negative stiffness — its modes swell before they die), `liquid_diamond`,
  `velvet_iron`.
- **Geometry**: `radius` (mm), `thick` (mm), `tension` — **0 is a plate**
  (inharmonic: gong, cymbal, sheet), high is a membrane (a drum). `stretch`
  multiplies stiffness; `damp_tilt` positive makes highs die first.
- **Where you hit it**: `contact_r` 0 (centre: only symmetric modes, dull) to
  1 (rim: bright, complicated); `contact_theta` rotates. `hit` is how hard.
- **Behaving like a thing**: `couple` (modes drive each other — try it
  first), `drift`, `grime`/`bite`/`grain`, `oct`.
- **Read-outs**: `/object` prints f1, the wave speed and f16/f1 — "aim with
  the read-outs": a pitched drum wants high tension and a small ratio, a bell
  tension 0 and a wide one.
- **Chaotic modulation**: six rows, `mod_<contact_r|contact_theta|tension|
  couple|grime|morph>=<chaos|vel|note>:<-100..100>[:run]`. Latched (default):
  read once at the strike — every hit a slightly different object. `:run`:
  keeps moving while it rings — "objects that sound haunted". `rate`,
  `spread`, `wander` shape the attractors, and each note *pushes* them.
- **Presets**: `preset=<name>` loads one of 22 factory objects (mylar_tom,
  kevlar_snare, floor_drum, spruce_plate, ebony_block, bone_disc, ice_sheet,
  glass_bowl, steel_gong, bronze_cymbal, aluminium_pan, gold_coin,
  tungsten_disc, rubber_pad, lead_thud, graphite_plate, aerogel_zap,
  immortal_bell, dark_matter_skin, neutron_star, anti_wood_plank,
  bone_to_glass). `mylar_tom` is the manual's own example and reads, as there,
  f1 284 Hz and f16/f1 4.85.

---

## 5. The effects

Each is a processor; put it on a bus and send voices to it (`/fm
add_send=echo send_gain=0.3`), as the machine's mixer strips send to shared
effects.

- **`resonators`** — four tuned strings; percussion in, harmony out. `root`,
  `scale`, `decay`, `damp` (higher = darker), `inharm`, `prob` (the root
  wanders on transients). Also the tuning the jumpers use.
- **`cascade`** — a pitch shifter in the delay loop. `shift=7 feedback=0.8`:
  echoes climb away in fifths — "the single most recognisable sound in this
  machine".
- **`notverb`** — `freeze=on` holds the room forever. A frozen notverb keeps
  sounding after everything stops; `mix` is what silences it.
- **`glaze`** — grains of the last six seconds; with `feed` it outlives the
  music too.
- **`drivenet`** — four folded delay lines at irrational ratios; `time` under
  30 ms is a metallic resonance, over 100 a dense echo.
- **`spectra`** + **`lossyverb`** — the robot. It photographs twelve
  partials of what it hears and speaks your rhythm through a vocoder tuned to
  them, over sympathetic strings. `photo=now` takes a photograph by hand;
  `oct` folds it down if it sits too high. Put `lossyverb` after it: a reverb
  built like a failing codec — `kbps=40` and the tail grinds away.
- **`breathe`** — three-band compression and ducking for the pads bus. It
  needs a key: `/patch source=kick dest=breathe.key depth=1`.
- **`microdelay`** — two of them, differently tuned, for stutter call and
  response.
- **`deeppad`** — see §7.

**`fbmatrix`** (a modulator) routes the effect buses into each other: `/add_modulator
type=fbmatrix buses=res,echo,space,cloud,dirt,robot depth=0.2`. It can't run
away (zero diagonal, rows summing to one, a cutout), but it can get loud —
come up from 0. `rot` changes who feeds whom, `dice=now` deals a random
matrix, `auto=on` re-deals every `sec` seconds.

---

## 6. The samplers

All three take `sample=` (a library path, quoted if it has spaces, or
`random`) and `folder=`; lilypad's inspector has a picker.

- **`microsampler`** (samplers 2–4, lanes 2/3/4) — `mod=on` is the micro-loop
  engine: each hit relocates through the file's `slices` (`chaos` = jump
  chance) and loops a fragment whose length is **velocity** — `vel_invert=off`
  loud hits turn into tones, `on` into textures. Feed it long recordings.
- **`slicer`** — plays continuously while its track runs: a looping window
  (`start`..`end`, `window` fades, `rate` −4..4) over an onset-sliced file
  (`thresh`, `min_hop`). Every sequencer step relocates it: `dev_slice`,
  `dev_rate`, `dev_end` follow the note, `dev_window` the velocity;
  `dev_slice=1` wanders the whole file. Under ~50 ms a loop becomes a tone.
  Patch `curveloop`s into `rate`/`end`/`window` for the manual's Shapes.
- **`multicluster`** — one track per timbre family: same `sample`, same
  `seed`, `cluster=0..7`. Every step all of them draw the same random slice;
  only its family plays it. Families are sorted darkest first.

---

## 7. The pads and the convolution you can play

**`tapedrone`** on a track, **`deeppad`** on a bus — route both into a bus
with `breathe`. The Deep Pad plays itself (up to forty seconds to arrive), but
the moment you send something into its bus with `excite` up, that becomes the
excitation: "any drum fired through a tunable resonant space instead of
through a reverb". Tune `pitch` to the key of what goes in; `decay` 0.2–0.4
for distinct strikes. Ribbit's sends are post-fader (the machine's were
pre-fader): to hear *only* the resonated result, route the track there
(`/hats out=atmo`) instead of pulling its fader down.

---

## 8. Motion

- **`dicejumpers`** — `dice` is the chance per step that every jumper
  fires; each effect then rolls its own `probs` and jumps its own way (delay
  times *in tune*, timed freezes, new roots). `listen=seq` also fires them
  on note injections. 0 still, 5–15 surprises, 25–40 an instrument, 60+
  constant reconfiguration.
- **`elastictempo`** — `on=on`: every `epoch` steps an episode may start
  (`prob`): sparse, accel, brake, relaunch, landing on ½, ⅔, ¾, 4/3, 3/2 or 2
  times the tempo it was switched on at (or back, with `grid`). Recipes: amt
  0.6, epoch 32, prob 100, grid 20 — obvious; amt 0.25, grid 80 — subtle.
  `fire=now`.
- **`terrarium`** — agents riding a Lorenz attractor borrow params anywhere
  and give them back exactly. `rho` is the regime (below 1 dead, 1–24.7
  settles, ~28 chaos). Controlled evolution: rho 27–28, 1–2 wanderers, depth
  0.1–0.25, holds 500–3000 ms, grab 30–50. `hold=on` sculpts permanently —
  save the result. `shuffle=seq sh=15` lets it reorder the grid on lobe
  crossings. `panic=now` releases everything.
- **`modlfo`** — one per param: `shape=drift` (alive) or `sh` with
  `strike=<track>` (re-rolls on hits), `sync=on div=1bar` or free `hz`.
- **`driftbank`** — `kind=sends bus=cloud`: voices wander in and out of an
  effect; `kind=pan`: pans travel edge to edge, never centred.
- **`attractor`** — Coullet, Lorenz or Rössler as a patchable signal;
  `strike=<track>` makes the music push it.
- **`curveloop`** — draw a curve (`points=`, or in lilypad's inspector), loop
  it on `div`×`mult`; give several curves different `rate`s and they drift
  against each other.

---

## 9. Recording and the loop

- **Stems**: `/recording mode=multitrack` then `/record` — every track and
  bus to its own file (the machine's "one button, twenty-seven files").
- **`looper`** on a bus fed from the mix (`/mix add_send=loop`): `rec=on`,
  `rec=off` (the first take sets the length), `play=on`; all take
  `at=cycle`. The playhead can follow `curve_a`/`curve_b` (`depth`, `morph`):
  a staircase is a hand-designed stutter.
- **`oxide`** after it: `spool` slows the tape; `wear` + `disint=on` makes it
  shed its coating for good — top end and level sink together while hiss
  climbs. `/oxide` counts the Time to Degradation. `disint=off` threads a
  fresh reel. To hear it, bring the live voices down. `trim` (up to 6) is the
  attendant's gain.

## 10. Presets, morphing, random

`/save name=<state>` stores the whole machine; `/recall name=<state> 30` walks
to it over thirty seconds — the machine's preset morph. `/<object> random`
rolls one object within its ranges. Like the original, a preset stores the
recipe, not the weather: dice, LFO phases, what Terrarium holds and what the
looper recorded are not saved.

## Growing a patch from a seed — `ae-dark`

`.claude/tools/ae_dark.py <seed>` writes the console commands for a whole
patch in which every choice — tempo (88–104), a low key in phrygian, aeolian
or locrian, the drum pattern, each voice's timbre within dark ranges, the Big
Modal object, the effect settings and every sub-seed — comes from that one
number. Paste them into a blank session. The design, whatever the seed:

- **A stable beat** from one `markovseq` (`beat`) that never rewrites itself:
  kicks on 1 plus a variant, a backbeat snare, hats elsewhere at their own
  probabilities, a ghost kick, a sub and a Big Modal hit at low chances, a
  couple of rests and hat rolls. Its matrix is the chain plus three moments
  of doubt. Variation is small and constant: velocity and micro-timing
  animate slowly, and one pair of steps lurches as `1/16d + 1/32` — exactly
  two sixteenths, so the bar never drifts.
- **Dark synths** from a second `markovseq` (`drift`) on slow uneven steps
  that mutates every 64: drone, metal bass and string, snapped to the key; a
  Deep Pad tuned to it, struck by the snare and the object; a tape pad under
  everything, ducked by the bass drum.
- **Restrained motion**: jumpers at dice 3 on three effects, Terrarium with
  one agent on synths and effects only (never the drums).

It runs at about a quarter of `ae-machine`'s note density. The shipped
`ae-dark` session is seed 16902.

## What's different from the original

- Sends are post-fader; the Deep Pad's excitation comes from sending to its
  bus. Pre-fader-style listening: route the track to the bus.
- The master has a limiter in the shipped session (the original deliberately
  has none).
- Mod panels are separate `modlfo`s patched per param rather than a panel per
  voice; Random All, the preset grid and morph slider map onto `/x random`,
  `/save`, `/recall … <time>`; the Assembler (preset-bank generator) and the
  external drum-synth integration are not rebuilt.
- FluCoMa's analysis is replaced by a spectral-flux onset detector and k-means
  on a small feature set; long files are analysed and played up to 120 s.
