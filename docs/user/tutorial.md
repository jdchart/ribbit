# Tutorial

Ribbit is a live-coding engine: you drive it with slash-commands (through its
built-in command router) that create and control tracks (synths/samplers),
processors (effects), and the master output, all playing in a loop against a
shared clock — like a very small, text-driven Ableton/Max-MSP.

## Running it

The commands below are exactly what `createCommandRouter(engine)` accepts, so any
host app with a text console will do. The reference host app in this workspace is
**nllc** — see its [docs](../../../nllc/docs/) to start it (`npm run dev`) and open
its console. Its homepage offers the same console+mixer page two ways:

- **Blank session** — starts from nothing but the master channel. This is where the
  rest of this tutorial happens.
- **A saved session**, picked from a dropdown of everything the app has on disk.
  The one that ships, `demo`, auto-loads a couple of tracks, a reverb bus, an LFO
  patched into it, and a couple of saved states to `/recall` between. Open this
  one first if you just want to hear something immediately, or as a worked
  example to read once you've been through this tutorial — `/tracks`, `/buses`,
  `/modulators`, `/patches`, and `/states` all show you what it's made of.
  Anything you later `/save_session` can be dropped in beside it and picked the
  same way.

(Output-device/latency options, the mixer pane, and the session routes are the
host app's concern — the nllc docs cover them. Everything below is pure engine.)

## Your first sounds

Open `/code-editor`. It starts genuinely empty — no tracks, nothing playing — and the
engine itself is off. Create a track and give it something to play:

```
/add_track name=lead
/lead add_event beat=0 pitch=60
/lead add_event beat=2 pitch=64
```

`add_track` with no `synth=` defaults to `oscsynth` (a simple oscillator voice). A
fresh track's synth always starts with **no events** — silent until you author a
pattern onto it with `add_event`, which is what the two lines above just did (see
[Authoring events](#authoring-events) below for the full field list). Now start the
engine:

```
/start
```

You should hear `lead` loop. The mixer's master strip (far right) will show the
power light pulsing on each loop and a level meter.

Now add a drum track:

```
/add_track name=drums synth=sampler
```

This creates a second track using the sample-based synth instead of the default
oscillator — every track loops independently against the same clock. Like `lead`
above, `drums` starts silent until you author a pattern onto it (next section).

## Authoring events

Every track's synth has an event list you build up with `add_event`. For a
`sampler`, `pitch` selects a slot (0 = first sample, wrapping if out of range):

```
/drums add_event beat=0 pitch=0 velocity=0.9 duration=0.25
/drums add_event beat=1 pitch=2 velocity=0.8 duration=0.25
/drums add_event beat=2 pitch=0 velocity=0.9 duration=0.25
/drums add_event beat=3 pitch=2 velocity=0.8 duration=0.25
```

That's a basic four-on-the-floor kick/snare pattern (`pitch=0`/`pitch=2` are the
first two sample slots — see [objects.md](objects.md) for the full slot list).
Every field but `beat` is optional. For `oscsynth`, use `pitch=<midi note>` for a
raw pitch, or `degree=<n>` to use a scale-degree resolved against the shared
harmony context instead (see [objects.md](objects.md#events)):

```
/track_1 add_event beat=0 degree=0 velocity=0.6 duration=0.5
/track_1 add_event beat=2 degree=4 velocity=0.6 duration=0.5
```

Clear a track's pattern entirely with `/drums clear_events`.

## Tempo and loop length

The whole pattern loops over a fixed number of beats at a given tempo — both
adjustable at runtime with `/clock`:

```
/clock
```
```
bpm=120 num_beats=4
```

```
/clock bpm=140
/clock num_beats=8
```

Changing `num_beats` while the engine is running can shift where the loop
boundary currently falls — an accepted live-coding glitch, not a bug.

## Controlling tracks

Every track (and the master channel) is addressable by name. With no parameters, a
channel command just prints its current status:

```
/track_1
```
```
track_1 — gain=0.80 pan=0.00 inserts=[p1:reverb] synth=oscsynth("A basic subtractive synth voice...")
```

Set gain (0–1) and pan (-1 to 1):

```
/drums gain=0.6
/drums pan=-0.3
```

Pause and resume a single track without touching anything else (its events just stop
being scheduled — already-sounding notes finish naturally):

```
/drums stop
/drums start
```

List every track at once:

```
/tracks
```

Every track/bus/master/processor/modulator also answers `help` for the full
command and param reference, not just the one-line summary above — see
[Getting help](commands.md#getting-help).

## Mute, solo, and groups

Three things for playing a session rather than building one.

**Mute** takes a channel out without touching its fader, so putting it back
lands exactly where you were:

```
/hats mute
/hats unmute
/hats mute at=cycle       drop out on the next loop boundary
```

**Solo** does the opposite — everything else drops out:

```
/lead solo
/lead unsolo
```

Solo is smarter than "mute everything else": anything that feeds a soloed
channel, or is fed by one, keeps playing. Solo a track and its reverb bus keeps
working; solo the reverb bus and the tracks feeding it keep playing. Note the
relationship is to the channel you *soloed*, not to anything it dragged in —
soloing one of three tracks that share a reverb keeps the reverb, but the other
two tracks still drop out, including their own reverb tails. You can
solo several channels at once. Both states show up in `/tracks` — a track
that's quiet because something *else* is soloed says `[silenced by solo]`,
which saves a lot of staring at a fader that's up. Both are also the **M** and
**S** buttons on each mixer strip.

**Groups** save you typing the same thing at four objects. A group is just a
name standing for several other names:

```
/add_group name=kit members=kick,snare,hats
/kit gain=0.4
/kit gain=0 4b at=cycle     fade the whole kit out together, on the boundary
/kit mute
/kit random                 roll every member's params at once
```

Anything you type at the group is run at each member, so it works with every
command in this tutorial — there's no separate list of "group commands". A
group is *not* a bus: it doesn't sum anything, doesn't have a fader, and
doesn't change the signal path at all. The two go together — group the four
drum tracks that already send to a drum bus, and you can address them either
way depending on what you mean.

## The console

Beyond just running whatever you type, the console (the left-hand pane)
gives you three shortcuts:

- **Suggestions**: as you type, a greyed-out completion appears right after
  your cursor — press `→` to accept it into the input (without running
  anything yet), or just press `Enter` to accept *and* run it in one step:

  ```
  > /trac█k_1              type "/trac", see "k_1" suggested in grey
  > /track_1 █              press → to accept — cursor lands right after, ready to keep typing
  > /track_1 ga█in=         type "ga", see "in=" suggested
  > /add_modulator type=r█andomnotes   values complete too, once you've typed at least one character
  ```

  This works anywhere in the line, not just at the end — accepting a
  suggestion in the middle can push already-typed text after it over, rather
  than only ever appending at the end. Three things get suggested: the
  `/name` token itself (any addressable object or top-level command); once
  you're past the name, a bare param key (`gain=`, `wet=`, `remove_self`,
  `help`, ...); or, once you've typed at least one character of a key's
  value, the value itself, but only for keys with a small known set of
  choices (`synth=`, `type=`, `at=`, `add_processor=`, an existing
  track/bus/processor/modulator name for `out=`/`add_send=`/`source=`/
  `dest=`, an existing state/patch/send id, ...) — an open-ended value (a
  number, a name you're inventing) is left alone. A value you've typed *in
  full* is never completed past, either: with an option whose choices include
  both `1` and `1+1`, typing `1` and pressing Enter runs `1`. Typing a key's `=` with
  **nothing** after it yet shows no suggestion on purpose — narrow it to at
  least one character first, so pressing Enter right after `type=` doesn't
  silently accept whichever candidate happens to be listed first. If nothing
  matches what you've typed, no suggestion appears; keep typing and it'll
  pick up again as soon as something does.
- **History**: press `↑`/`↓` to recall previously submitted commands, like a
  shell. If you'd started typing something new when you press `↑`, that
  in-progress text is preserved — pressing `↓` back past your oldest recalled
  command returns you to it rather than losing it. `↑`/`↓` only recall
  history when the input is empty (or you're already mid-recall) — with
  something freshly typed in the box, they're reserved for suggestions
  instead (see above) and don't do anything on their own yet.
- **Click-to-paste**: clicking a track/bus/master/processor/modulator's name
  anywhere in the mixer (or a param label, e.g. "gain"/"pan" under a
  fader/pan dial, or a modulator's own param readout) inserts it at the
  console's current cursor position, ready to build a command around — click
  `track_1`, then click `gain`, and the console reads `track_1 gain=`, cursor
  right after the `=`.

## Ramps

Add a trailing duration to `gain=`/`pan=` (or any processor param, see
[Effects](#effects) below) to ramp instead of jumping instantly:

```
/drums gain=0 3        fade drums out over 3 seconds
/drums gain=0.6 4b      fade back in over 4 beats ("b" = beats, no suffix = seconds)
```

By default a ramp starts the instant you hit Enter. Add `at=beat` or `at=cycle`
to line it up with the next beat or the next loop boundary instead — handy for
keeping changes musically in time rather than landing mid-phrase:

```
/drums gain=0 4b at=cycle
```

**`at=` isn't just for ramps.** It works on *anything* that changes something,
which matters because most of what you do live is discrete — swapping a
waveform, muting a part, reseeding a generator — and hitting Enter mid-bar is
almost never when you want it to land:

```
/lead waveform=square at=beat      swap the oscillator on the beat
/drums stop at=cycle               drop the part at the end of the bar
/harmony root=64 at=cycle          change key at the top of the next loop
```

A deferred command answers twice. Straight away it tells you what *will*
happen, then when it fires it reports back on a line marked with `·`:

```
> /drums stop at=cycle
drums will stop (next cycle)
· drums stopped
```

You can also fire several commands from one line, all together:

```
/track_1 gain=0 8 /drums gain=0 8
```

## Options, loop automation, and harmony

Three more live controls, all of them console-first:

**Options** are runtime settings without an AudioParam behind them — set
them like a param, they just can't ramp. (They *can* still be scheduled with
`at=`; "not rampable" only means there's no curve to draw between two
values.) A track routes its synth's options through its own name:

```
/lead waveform=square        the oscillator shape, from the next note on
/lfo1 waveform=triangle      an LFO reshapes in place
/rand1 scale=0,3,5,7,10      a randomnotes generator repicks from a new scale
/reverb duration=4           regenerates the reverb's impulse response
```

See [commands.md](commands.md#params-vs-options) and each type's table in
[objects.md](objects.md).

**Loop automation** attaches a ramp to a *position in the loop*, replayed
every pass — where `gain=0 3` fires once from "now", `automate=` is part of
the pattern:

```
/drums automate=gain from=0.8 to=0.3 beat=2 duration=2
/reverb automate=wet to=0.9 beat=0 duration=4 curve=exponential
/drums automations               list them (with indices)
/drums remove_automation=0       remove one
```

It's captured by `/save`/`/recall` and session files like everything else —
see [commands.md](commands.md#loop-automation).

**Harmony**: every event authored with `degree=` (and every `randomnotes`
stream) resolves against one shared key/scale *at the moment the note
fires*, so changing it retunes everything already playing, live:

```
/harmony                          root=60 scale=0,1,2,...
/harmony root=57 scale=0,2,3,5,7,8,10    A natural minor, mid-loop
```

Events you authored with a raw `pitch=` are unaffected — only `degree=`
listens to the harmony context. Similarly, `/lead events` lists a pattern
with indices and `remove_event=<n>` deletes a single note, so you can edit
a pattern without `clear_events`-ing the whole thing.

## Effects

Attach a processor to a track's insert chain:

```
/drums add_processor=delay
```

The router assigns it a default name (`delay`) and an id (e.g. `p2`), which is
addressable on its own:

```
/delay wet=0.5
/delay feedback=0.45
```

Run a processor with no arguments to see a one-line summary, or with `help`
for the full reference — every param (with its current value/range) and every
command it accepts:

```
/delay help
```
```
delay (p2): A stereo delay: independent left/right delay lines with cross-feedback (ping-pong) and a small time offset between channels for width.

params:
  time=0.375 (range 0..5)
  feedback=0.350 (range 0..0.95)
  wet=0.300 (range 0..2)

commands:
  <param>=<val>                    set instantly; add a trailing duration to ramp, e.g. wet=0.5 3 (3s) or wet=0.5 4b (4 beats)
  at=beat|cycle                    defer a set/ramp above to the next beat/loop boundary instead of firing now
  remove_self                      remove and delete this object
  ...
```

(A param that never declared bounds — e.g. a patch's `depth`, deliberately
unbounded so a negative value can invert the modulation — shows no
`(range ...)` suffix — see [objects.md](objects.md) and
[Getting help](commands.md#getting-help).)

Bypass it without removing it by clicking its name in the mixer's insert list (each
track strip shows its inserts as small buttons — click to toggle bypass, shown with
strikethrough when off), or remove it entirely:

```
/drums remove_processor=p2
```

Two of the processors are less "set it and leave it" than the rest, and are
worth meeting early because they're the ones you *play*. `svf` is a filter —
one cutoff, one resonance, and a switch for which shape comes out:

```
/drums add_processor=svf
/svf mode=lowpass cutoff=400
/svf cutoff=8000 8b            open it over eight beats
/svf mode=highpass at=cycle    switch shape on the next loop boundary
```

`comb` is the same signal delayed by a few milliseconds and added back to
itself, which reads as tone rather than as an echo — a ringing resonance in
`mode=feedback`, a flanger in `mode=feedforward`:

```
/drums add_processor=comb
/comb mode=feedforward time=0.004 feedback=-0.8
```

Full parameter tables for both are in [objects.md](objects.md#svf--ribbitsvf);
the one thing to know up front is that `mode=feedback` can't ring above about
344Hz (Web Audio won't make a feedback loop shorter than one processing block),
and `/comb` tells you when you've asked for less.

## Rolling the dice

Anywhere a param takes a number, it also takes the word `random`:

```
/delay feedback=random     pick a feedback amount from its 0..0.95 range
/delay wet=random 4b       ...and glide there over 4 beats instead of jumping
```

It's an ordinary value, so everything you already know applies — ramps,
`at=beat`/`at=cycle`, all of it. Narrow the range with `min=`/`max=` when the
full sweep is too wild:

```
/delay time=random min=0.1 max=0.4
```

The bare word `random` on its own rolls **every** param on that object at
once — the fastest way to find something you wouldn't have typed:

```
/delay random          new time, feedback and wet, all at once
/delay random=8b       the same roll, arrived at over 8 beats
```

On a track it covers the channel *and* its synth. One param is left out by
default: `gain`, because a random fader isn't a new sound, it's a track that
vanished. You control what's included per param, and it's remembered when you
save:

```
/delay feedback.r=false    stop rolling feedback
/drums gain.r=true         start rolling the drum fader after all
```

`/delay help` marks anything a bulk roll will skip with `[no random: ...]`.

One honest caveat: the range a param declares is a *safety clamp*, not a
tasteful range. `/lfo1 random` picks from `0..20000` Hz, which is what the
oscillator accepts and almost never what you wanted from an LFO. Use
`min=`/`max=` whenever the result keeps coming out silly.

## Buses and sends

Every track (and master) has at least one **send** — where its signal
actually goes, `master` by default. A **bus** is an empty channel (no synth)
that exists purely to be a shared send destination — useful once you want
more than one track running through the same reverb/delay, without repeating
that processor per track:

```
/add_bus name=fx1
/fx1 add_processor=reverb
/track_1 add_send=fx1 send_gain=0.3
/drums add_send=fx1 send_gain=0.15
```

`track_1` and `drums` still play dry through their original send to master
*and* now also feed `fx1` at their own levels — `fx1`'s own reverb reaches
the output through its own (default) send to master. Adjust or remove a send
by the id shown when it was created:

```
/track_1 send=s2 send_gain=0.5 3
/track_1 remove_send=s2
```

Or replace every send at once with `out=`, if you just want a track to feed
somewhere else entirely instead of adding another destination:

```
/track_1 out=fx1
```

See [commands.md](commands.md#buses-and-sends) for the full reference.

## Making it sound good

`reverb` and `delay` add something *beside* your signal. The other five
processors act *on* it — they're for making a mix louder, steadier and better
balanced rather than making it different.

The quickest version is one command:

```
/master add_processor=goodenizer
```

That's a compressor, a saturator, a tilt EQ and a limiter chained in that
order. Ask it what it's doing:

```
/goodenizer
```
```
goodenizer (p1): The whole chain in one box: ... [threshold=-20.000, ratio=4.000,
attack=0.010, release=0.120, makeup=1.400, drive=1.000, tone=0.150, pivot=900.000,
ceiling=-1.000, mix=1.000, character=soft, oversample=2x] comp -4.2 dB, limit -0.7 dB
```

That trailing `comp -4.2 dB, limit -0.7 dB` is live gain reduction — how hard
each end of the chain is currently working. It's the one thing about a
compressor no parameter can tell you, because it depends entirely on what's
going through it.

`mix` is a true crossfade, not a wet level, so it's an instant A/B:

```
/goodenizer mix=0        the mix with nothing on it
/goodenizer mix=1 2      fade the treatment back in over two seconds
```

It ships polite. `drive` — the saturation stage — defaults to `1`, which is
clean. Compression, tilt and limiting make a mix more like itself; saturation
makes it into something else, so it waits to be asked:

```
/goodenizer drive=9
/goodenizer character=fold
/goodenizer drive=1
```

### The four on their own

Use them individually when you want one thing rather than the lot. Each is a
normal processor: it goes on any channel's insert chain, its params ramp, and
it's addressed by its type name.

**`tilt`** is the one to try first, because most of what people mean by a mix
sounding wrong is a broad tonal tilt. One control trades low end for high:

```
/master add_processor=tilt
/tilt tone=-0.5 8b       slowly pull everything darker and fuller
/tilt tone=0.4 4b        and back up bright
```

**`saturator`** is drive into one of four curves — `soft`, `hard`, `fold`,
`tape`. `drive` is the amount, `character` the flavour:

```
/track_1 add_processor=saturator
/saturator drive=14 character=tape
/saturator drive=25 character=fold     a wavefolder; nothing like the others
/saturator mix=0.4                     parallel distortion
```

**`limiter`** is `boost` into a ceiling. The boost is what makes things loud;
the ceiling stops it running away:

```
/master add_processor=limiter
/limiter boost=2.5 ceiling=-1
```

**`compressor`** has the usual controls, plus a `mix` — and that `mix` is what
makes **parallel compression** possible. Send drums to a bus, squash what
arrives there completely, and blend it back under the untouched originals:

```
/add_bus name=smash
/smash add_processor=compressor
/compressor threshold=-38 ratio=12 attack=0.002 makeup=3.5
/drums add_send=smash send_gain=0.6
/smash gain=0            then bring it up under the dry drums
/smash gain=0.5 4b
```

That adds weight without flattening dynamics, because the dry path is
untouched — a very different result from simply compressing the drums harder.

### Pumping

Every one of those params is a real param, which means it's a `/patch`
destination. Patching an LFO into a compressor's *threshold* moves the
threshold in time, so the whole mix breathes with the beat:

```
/add_modulator type=lfo freq=0.5 name=pump
/patch source=pump dest=goodenizer.threshold depth=15
```

Raise `depth` for more. This is the sidechain-pumping trick without needing a
sidechain input, and it falls out of the engine's ordinary patching rather
than being a feature anyone built.

Every session that ships with ribbit runs a `goodenizer` on master named
`glue`, so `/glue mix=0` works in any of them. The `goodenizer-demo` session
is a guided tour of all five. Full reference:
[objects.md](objects.md#processors-add_processor-on-any-channel).

## Modulators and patching

So far every parameter change has been you typing a value or a ramp. A
**modulator** is a standalone control source that wobbles a parameter
continuously and automatically — the modular-synthesis piece of Ribbit. Create
one, then **patch** it into whatever you want it to affect:

```
/add_modulator type=lfo freq=2 name=lfo1
/patch source=lfo1 dest=reverb.wet depth=0.2
```

`lfo1` is now continuously wobbling `reverb`'s `wet` mix at 2Hz, by up to
±0.2 around whatever value it's already at (including any ramp you set on it
separately — the modulator adds on top, it doesn't fight your other
changes). `depth` controls how strongly it pushes that particular
destination; patch the same modulator somewhere else at a different depth
and it'll drive both at once:

```
/patch source=lfo1 dest=track_1.gain depth=0.1
```

Every patch gets a short id (`x1`, `x2`, ...), listed with `/patches`. Adjust
a patch's depth later, or remove it, without touching the modulator itself:

```
/patch id=x1 depth=0.5 2
/unpatch id=x1
```

A modulator's own params are rampable exactly like a processor's — `/lfo1
freq=8 3` glides its rate from 2Hz to 8Hz over 3 seconds.

Not every modulator has to move by itself. A `cv` is a modulator with no
waveform and no rate — just a held `value` you set or ramp yourself:

```
/add_modulator type=cv name=cv1
/patch source=cv1 dest=reverb.wet depth=0.5
/patch source=cv1 dest=track_1.pan depth=0.8
/cv1 value=1 8b
```

That last line sweeps *both* destinations from one command, each scaled by
its own patch depth — a single control moving several things at once, which
is what patch cables are for.

To play one written part on several instruments, write it into a
`pianoroll` rather than onto a track, and patch it into each of them:

```
/add_modulator type=pianoroll name=riff length=4
/riff set_events=0:60:0.5,0.5:63:0.5,1:67:1,2:70:0.5,3:67:1
/patch source=riff dest=lead.notes
/patch source=riff dest=bass.notes
```

And one modulator takes no patch at all. `randomgestures` roams the session
by itself, picking a parameter every so often and gliding it somewhere new:

```
/add_modulator type=randomgestures name=drift
/drift gesture_beats=8 glide=6 depth=0.15
```

That's a hand slowly moving controls while you work on something else. It only
touches params the bulk `random` command would touch, so faders are safe and
`/lead cutoff.r=false` puts one parameter off limits. Point it somewhere
narrower with `scope=`, `targets=` (a group name works, and is the tidy way to
do it) or `params=`, and ask it what it's up to:

```
/drift targets=kit params=dynamics
/drift
drift: ... [3 params in range · 12 gestures · last: hats.dynamics 0.100 -> 0.087 over 6b]
```

`0 params in range` means it has nothing to do — usually a `params=` name that
nothing in `targets=` actually has (`params=cutoff` aimed at a drum kit).

It's seeded, so `/stop` `/start` replays the same take. See
[commands.md](commands.md#modulators-and-patches) for the full reference, and
[objects.md](objects.md#modulators-type-on-add_modulator) for every modulator
type.

## Algorithmic notes: event-generating modulators

`lfo` wobbles a *parameter*. A `randomnotes` modulator instead generates
*notes*, algorithmically, and feeds them into a track's synth — the
modular-synth "control voltage triggering notes" idea, applied to this app's
event system. Patch one into a track's reserved `.notes` destination instead
of a `name.param`:

```
/add_track name=lead
/add_modulator type=randomnotes name=rand1 probability=0.7 min_gap=0.5 scale=0,2,4,5,7,9,11
/patch source=rand1 dest=lead.notes
/start
```

`lead` now plays a wandering, probability-thinned stream of notes picked from
that scale — forever, not looping identically every cycle, since generation
tracks absolute time rather than a fixed pattern. Crucially, this runs
**alongside** anything you `add_event`'d onto `lead` by hand — generated and
authored notes both fire from the same synth, and `clear_events` only ever
touches the authored ones. Tune it live like any other param:

```
/rand1 probability=0.3 4       thin it out over 4 seconds
/rand1 min_gap=0.25 4b         and speed up the candidate grid over 4 beats
```

`/unpatch id=<id>` (or `/rand1 remove_self`) stops it. See
[commands.md](commands.md#event-generating-modulators-patching-notes-into-a-synth)
and [objects.md](objects.md#modulators-type-on-add_modulator) for the full reference.

## Drums: a kit and a rhythm generator

`percsampler` and `markovpercs` are a matched pair — a drum kit and something
to play it. The kit builds itself:

```
/add_track name=drums synth=percsampler
/add_modulator type=markovpercs name=rhy
/patch source=rhy dest=drums.notes
/start
```

That's a full drum track. `percsampler` picked 16 samples at random from the
host's library — four each of kicks, snares, hats and percs — and
`markovpercs` generated a rhythm and is looping it.

Unlike `randomnotes`, which re-rolls forever, `markovpercs` commits to **one
pattern** and repeats it until you ask for another. Query it to see what it
came up with:

```
/rhy
```

Alongside the params, you'll get something like `.sk.HhshSp.s...k` — one
character per step (`k`/`s`/`h`/`p` per category, `.` for a rest, uppercase on
the beat). Don't like it? Reseed:

```
/rhy seed=random          a different rhythm, same character
/rhy style=kickheavy      a different character (sparse, rolling, broken, kickheavy, chaotic)
/rhy density=0.5          thin it out
/rhy swing=0.3 8b         ease into a shuffle over 8 beats
```

`velocity` and `swing` are params, so they ramp and apply to the pattern
already playing. Everything else is an option that regenerates the pattern —
including `seed`, which is why a saved session rebuilds the *same* rhythm
rather than rolling a new one.

### When you need a downbeat

Try as you might, you won't get `markovpercs` to put a kick on every beat.
That isn't a missing feature — it's structural. A Markov chain picks each step
by looking at *the step before it*, so it has no idea where in the bar it is.
It's very good at texture and hopeless at architecture.

`euclidpercs` is the other half of the pair. It decides each step from the
step's **own index**, spreading a category's hits as evenly as possible across
the grid (Bjorklund's algorithm — the same maths behind a surprising number of
traditional rhythms):

```
/add_modulator type=euclidpercs name=grid preset=fourfloor
/patch source=grid dest=drums.notes
/grid
```

Now you get a grid instead of a single line — one row per category, `X` on a
whole beat, `x` between, `.` for a gap:

```
kicks  X...X...X...X...
snares ....X.......X...
hats   X.x.X.x.X.x.X.x.
percs  ................
```

That kick lands on all four downbeats, every pass, forever. Notice the other
difference too: these are four **independent layers**, so a step can be a kick
*and* a hat at once — a Markov step was only ever one thing.

Presets are starting points, not genres; everything stays editable afterwards:

```
/grid preset=tresillo          fourfloor, backbeat, tresillo, bossa, polyrhythm, sparse
/grid kicks=3                  three kicks, spread evenly
/grid snares_rotate=4          move the snare layer to land on beat 2
/grid steps=12                 a 12-step grid phases against a 4-beat loop
```

Two kinds of randomization keep it from sounding like a drum machine, neither
of which can move a hit off the grid:

```
/grid variation=0.8            each hit picks a different sample from its category
/grid dropout=0.4 8b           hits start dropping out, ramped over 8 beats
```

`variation` is seeded and fixed (part of the pattern); `dropout` re-rolls
every pass, so the pattern breathes.

### Both at once

The two generators are designed to be used together — and because several can
feed the same track, you just patch both:

```
/add_modulator type=markovpercs name=ghosts density=0.4 velocity=0.3
/patch source=ghosts dest=drums.notes
```

`grid` holds the backbone you can count against; `ghosts` scatters quiet notes
around it. That's the whole idea behind the `euclid-ghosts` example session —
open it from the homepage to hear a tuned version, with each drum on its own
track.

### A new kit

```
/drums samples=random     re-roll this track's samples
/drums per_category=2     two per category instead of four (also re-rolls)
```

Found a kit you like? `/save name=good` records the actual filenames, so
`/recall good` brings those samples back rather than rolling again.

### Each drum through its own effects

A kit on one track shares one insert chain. To send kicks somewhere different
from snares, give each category its own track with `categories=`:

```
/add_track name=kick  synth=percsampler categories=kicks
/add_track name=snare synth=percsampler categories=snares
/add_track name=hats  synth=percsampler categories=hats

/add_bus name=verb
/verb add_processor=reverb
/snare add_send=verb send_gain=0.35

/add_modulator type=markovpercs name=rhy
/patch source=rhy dest=kick.notes
/patch source=rhy dest=snare.notes
/patch source=rhy dest=hats.notes
```

One generator drives all three, and each track plays only the hits it owns —
slot numbers stay the same whichever categories a track loads, so a snare hit
lands on a placeholder on the `kick` track and simply makes no sound. Now
each drum has its own fader, pan, inserts and sends.

### Humanizing

Every hit is randomized a little, which is what stops a pattern sounding
pasted together. Three rampable params control how much:

```
/hats dynamics=0.5          vary level (all categories; never silent)
/hats pan_spread=0.8 4b     spread across the stereo field (hats/percs only)
/hats speed_spread=0.25     vary pitch and length (snares/hats/percs only)
```

Kicks stay centred and at pitch on purpose — they anchor everything else.
Being real params, these also work as patch destinations, so a slow LFO can
open the stereo picture up and close it again:

```
/add_modulator type=lfo name=drift freq=0.06
/patch source=drift dest=hats.pan_spread depth=0.4
```

Load `/code-editor/percs-demo` for a worked version of all of this.

## Playing music you wrote yourself

Every generator so far invents its material from a rule. Sometimes you know
exactly what you want to hear — and for that there's `patternvariator`, which
plays a **pattern file** you write by hand and varies it as it goes.

Three packs of patterns ship. Point one at a drum kit:

```
/add_track name=drums synth=percsampler
/add_modulator type=patternvariator name=beat pack=hiphopdrums pattern=boom-bap
/patch source=beat dest=drums.notes
/start
```

Ask it what it's playing:

```
/beat
```

```
kicks  x.....x...x.....
snares ....x.......x...
hats   x.x.x.x.x.xx...g
```

**Your grid won't match that one**, and that's the point: an unseeded variator
picks a random seed, so every fresh one is a different take. Compare it against
the source file — `hiphopdrums/boom-bap.json` has kicks on steps 0, 6 and 10,
snares on 4 and 12, and straight eighth hats. Most of that survives; the
default `variation` is 0.3, so it's only nudging things gently. In the grid
above a `g` (a quiet **ghost note**) has appeared in a hat rest, and one hat
slid a step. Yours will have done something else, somewhere else.

To get a specific take back, give it a seed — `pattern=boom-bap seed=42` is
reproducible forever, which is also why a saved session reloads exactly what
you left.

Turn the variation up:

```
/beat variation=0.8
/beat
```

Hits get dropped, ghosts appear in the gaps, and the occasional hit slides one
step off the grid — but the backbone is still recognisably the same beat. That's
deliberate: every operation transforms what's already there rather than
inventing something new, so even at `variation=1` most of the source survives.

Don't like this particular take? Roll another:

```
/beat seed=random
```

Each take is reproducible from its seed, so a saved session reloads the exact
same one. `/beat density=0.6` thins it out; `/beat pattern=halftime` swaps to a
different pattern in the same pack.

### Chords and melodies

The same modulator plays pitched material, and `karplus` — a plucked string,
and one of the two polyphonic synths — is what to point it at:

```
/add_track name=keys synth=karplus
/add_modulator type=patternvariator name=chords pack=darkchords pattern=seventh-fall
/patch source=chords dest=keys.notes
```

Patterns are written in **scale degrees**, not fixed notes, and degrees resolve
against the harmony context when each note plays. So the whole progression
moves with:

```
/harmony root=57
```

Variation works differently here, and more musically than you might expect: it
reads the pattern's *own notes* as its vocabulary and stays inside them —
inverting a chord, dropping a voice an octave, swapping a degree for another
one the progression already uses. It won't wander into notes you never wrote.

```
/chords variation=0.7
/chords transpose=3      shift up a minor third, diatonically
/keys damping=0.9 8b     let the strings go dull over 8 beats
```

### Writing your own

A pattern is a small JSON file, and a drum pattern is just a character grid:

```json
{
  "kind": "drums",
  "step_beats": 0.25,
  "lanes": {
    "kicks":  "x... ..x. ..x. ....",
    "snares": ".... x... .... x...",
    "hats":   "x.x."
  }
}
```

`x` is a hit, `.` a rest, and **spaces are ignored** — they're there so you can
see the bar. Note the hats lane is only four steps: a lane repeats at its own
length, so you write only as much as the part actually needs (and a 6-step lane
against a 16-step one gives you polymeter for free).

Drop that in `static/patterns/<yourpack>/<yourpattern>.json`, refresh, and it's
selectable. Full format reference, including chords and melodies:
**[patterns.md](patterns.md)**.

`/code-editor/pattern-drums` and `/code-editor/pattern-chords` are worked
versions of both halves of this.

## Pads out of noise: the granular synth

Everything so far has made sound from oscillators, drum hits or plucked
strings. `granular` makes it from **a recording of something else entirely** —
rain, a river, birds, glass — by chopping it into dozens of overlapping
fragments per note:

```
/add_track name=pad synth=granular
/pad add_event beat=0 degree=0 duration=4
/start
```

That's a pad, out of a field recording that has no pitch and no pulse. Ask the
track what it landed on:

```
/pad
```

It picked a recording at random from `static/samples/foley/`, the same way
`percsampler` picks a kit, and tells you which one and how long it is. Try
another:

```
/pad sample=random
```

### The two halves of a grain cloud

A note here is an **envelope** wrapped around a **cloud**, and they're
controlled separately. That split is worth feeling directly. First the
envelope — this is what makes it a pad rather than a sample:

```
/pad attack=4         slow swell
/pad release=6        long tail
```

Now the cloud inside it. Each grain is a short slice read from a playhead
somewhere in the recording:

```
/pad density=8        few, separate grains — you can hear them individually
/pad density=60       a solid wash
/pad grain_size=0.02  tiny grains: the grain rate becomes a pitch of its own
/pad grain_size=0.8   long grains: you hear the recording's own movement
```

`position` is where in the recording the playhead sits, and it's the control
worth putting your hand on. Ramp it and the pad walks through the material:

```
/pad position=0.9 16b
```

Three more shape the scatter: `spray` (how far grains wander either side of
the playhead — `0` is a frozen, almost tonal drone, `3` smears a whole phrase
into one chord), `pitch_spread` (a fraction of a semitone is chorus, several
is a cloud that disagrees with itself), and `drift` (how fast the playhead
moves *while a note is held* — the way to keep a long note evolving).

```
/pad spray=0 4b       freeze onto one instant
/pad spray=3 8b       and smear back out
/pad drift=0.5        let each held note travel
```

### Chords from unpitched material

`granular` is polyphonic, so a chord is several clouds at once — and the
`ambientchords` pack exists to drive it:

```
/add_modulator type=patternvariator name=bloom pack=ambientchords pattern=slow-bloom
/patch source=bloom dest=pad.notes
```

Transposing a recording is a **tape-speed** gesture: pitch and content move
together, so a low note doesn't just sound lower, it reads slower through the
material. `root` says which note plays it at natural speed, and moving it
shifts the whole part's character:

```
/pad root=72          everything an octave down, slower and deeper
/pad root=48          twice as fast, an octave up
```

Two last things worth knowing. Recordings are **gain-matched on load** — the
shipped foley folder spans about 30dB, so without it every roll of the dice
would need a new fader setting; the track summary shows the match (`x20.0`).
And `density` is the CPU knob, because every grain is a couple of audio nodes
built and thrown away. 20–40 is a pad; 200 is a stress test — and past about 40
grains sounding at once (`density x grain_size`) the cloud thins itself rather
than let the audio thread fall over.

`/code-editor/granular-pad` is the worked version: three granular tracks — a
watery pad, reversed rain, and a shimmer an octave up — over a long reverb.

## Pads through a tape machine: `tapepad`

`granular` gets its character from a recording. `tapepad` gets it from the
*medium*: an ordinary stack of detuned oscillators, then a tape transport that
bends the pitch and a tape stage that saturates, crushes and hisses.

```
/add_track name=pad synth=tapepad
/pad add_event beat=0 degree=0 duration=6
/pad add_event beat=0 degree=7 duration=6
/pad wow=60 8b                  # warp the tape over 8 beats
/pad bits=5                     # and print it to something cheap
```

Note what `wow=60 8b` does that no synth param you've met so far can: it warps
a chord **that is already sounding**. Every other synth param here —
`granular`'s `position`, `karplus`'s `brightness` — is read once when a note
is scheduled, so a ramp on it only reaches the *next* note. `tapepad`'s
`wow`, `wow_rate`, `flutter`, `hiss` and `sat` live on shared nodes that run
continuously, so they behave like a channel's `gain` instead. Its other six
(`cutoff`, `detune`, `pan_spread`, `sub`, `attack`, `release`) follow the
usual per-note rule. Nothing in the command surface distinguishes them; the
tables in [objects.md](objects.md#tapepad--ribbittapepad) mark which is which.

The transport is one machine for the whole synth, not one per voice — so the
chord bends *together*, the way a warped reel sounds, rather than each note
drifting somewhere different (which is a chorus pedal).

`/code-editor/ambient-tape` is the worked version: three tapepad layers over
the `ambientchords` pack, plus a dusty beat.

## Harmony that never stops: `chorale`

Every generator so far has made a *rhythm* — hits on a grid, however that grid
was decided. `chorale` makes the other thing: long overlapping notes moving
through chords, with no rhythm anywhere in it.

```
/add_track name=pad synth=tapepad
/add_modulator type=chorale name=bed mode=aeolian progression=0,5,3,4
/patch source=bed dest=pad.notes
/start
/bed                            # the progression, as actually voiced
```

`/bed` prints `aeolian | 0: 0,3,19,22 | 5: -4,12,15,19 | ...` — each chord as
the degrees the voices will actually sing. That's worth reading rather than
inferring, because `mode` and `progression` only say how the chords were
*derived*. (Those gaps are the default `spread=2` giving each voice its own
octave; `/bed spread=1` closes it up to `0,3,7,10`, an ordinary minor seventh.)

Two clocks run underneath. `chord_beats` advances the progression; `note_beats`
re-attacks each voice. Nothing lines them up, which is the point — a voice that
attacked before a chord change holds its old note across it, and those
overhangs are the suspensions you can hear.

Continuity comes from `overlap`: each note holds *longer* than it takes to
play the next one, so a voice crossfades with itself instead of leaving a gap.
Try turning the texture inside out:

```
/bed stagger=0 8b               # all voices attack together: block chords
/bed stagger=1 8b               # back to a continuous wash
/bed overlap=1.4 8b             # notes hold nearly twice their period
/bed spread=3 16b               # fan the voices apart over an octave and a half
```

There's a wrinkle worth understanding. Ramping `spread` doesn't slide the
chord around — a chorale param is read when a voice **attacks**, not
continuously, so the change arrives voice by voice as each one re-enters and
the pad revoices itself over a cycle. That's the per-note rule from the last
chapter, made audible over a long enough time to watch it happen.

The harmony itself is all options:

```
/bed mode=lydian                # same progression, brighter
/bed mode=phrygian              # same progression, much darker
/bed stack=4                    # stop stacking thirds: open fifths, no third
/bed chord_size=5               # ninths instead of sevenths
/bed progression=0,3,5,1        # rewrite the changes
/bed chord_beats=32 at=cycle    # half as much harmonic motion
```

`chord_beats` is an option rather than a param for a reason worth knowing: the
current chord is found by dividing the beat by it, so *ramping* it would
renumber every chord boundary underneath the music instead of slowing the
progression down. Set it, with `at=cycle` if you want it to land on a
boundary.

One last thing that makes `chorale` unlike every other generator: it has **no
seed**. There's nothing random in it at all — every note is a pure function of
the beat — so it plays the same thing on every pass and after any `/stop`
`/start`. It's a bed to put other things on, not a pattern that develops.

`/code-editor/chorale-drift` runs three at once: close sevenths, ninths an
octave up (`transpose=12`), and a one-voice bass line (`chord_size=1
transpose=-12`), with the first patched into *two* tracks so a `tapepad` and a
`karplus` sing the identical voicing.

## When a note isn't a pitch: `chaossynth`

Every synth so far has treated a note the way you'd expect: `pitch` picks a
frequency (or, for a sampler, a slot). `chaossynth` breaks that on purpose,
and it's worth a chapter because nothing else in the engine works this way.

It's a chaotic instrument — two sine oscillators wired into each other, each
one driven hard through a saturator into a resonant filter whose cutoff is
controlled by how loud that voice currently is. Nothing settles. Ten controls
steer it, all `0..1`, five per voice:

```
/add_track name=riff synth=chaossynth
/riff add_event beat=0 pitch=36 duration=0.75
/riff add_event beat=2 pitch=41 duration=0.5
/riff add_event beat=3.5 pitch=55 duration=1
/start
```

Three notes, three completely different sounds. That's the point:

```
/riff
```

prints the seed and the ten values note 60 currently resolves to. **`seed`
builds one configuration of all ten controls per MIDI note**, 0 to 127 — so
note 36 is a sound, note 41 is a different sound, and note 36 is *the same
sound every time it comes round*. Chaotic, not random.

```
/riff seed=random               # a whole new instrument, same three notes
/riff seed=7                    # seeds reproduce; a saved session rebuilds
```

Which means any generator you've already met becomes a way to sequence
**timbres**. Point `randomnotes` at it and every note is a new state; point a
`chorale` at it and the progression turns into a slowly-rotating set of
sounds:

```
/add_modulator type=randomnotes name=roll
/patch source=roll dest=riff.notes
```

The ten controls are still yours. `spread` decides how much the seed is
allowed to argue with them:

```
/riff spread=0 8b               # your params exactly; every note identical
/riff spread=1 8b               # the seeded state outright; params ignored
/riff spread=0.6 8b             # somewhere in between — the usual place
```

At `spread=0` this is an ordinary (if unruly) synth you dial in by hand. Turn
it up and your settings become a *centre* that each note departs from. Either
way you can still reach every control point on its own, ramp it, or patch an
LFO into it:

```
/riff a_cross=0.5 4b            # more coupling: pitch stops meaning anything
/riff a_cross=0.02 4b           # almost decoupled — two clean drones
/riff a_track=0 4b              # kill the loudness→filter loop
/riff a_res=0.95                # and now it rings
/riff random                    # re-roll all ten at once
```

`a_cross` is the chaos knob (how hard the *other* voice bends this one's
pitch) and `a_track` is the self-regulating loop (how much a voice's own
loudness closes its filter). `b_`-prefixed versions do the same for voice B,
which is the right channel — `/riff output=a` puts one voice on both channels
if you want to hear which half is doing what.

If you do want the notes to behave like notes again, `pitch_track` blends that
back in:

```
/riff pitch_track=1 8b          # a note now transposes as well as selecting
```

`/code-editor/chaos-states` is the worked example: the same synth at `spread`
0.6, 0.95 and 0 — a hand-written riff, a `randomnotes`-driven wild layer, and
a drone with two LFOs walking its control points — over a euclidean kit.

## A synth with presets: `czsynth`

Every other synth here is built from its params. `czsynth` isn't, and that's
worth a chapter for two reasons: it's the only one that ships a preset
library, and the thing its main knob does isn't what it sounds like.

It's an emulation of the Casio CZ-101 from 1984 — the synth behind most of
what people mean by "the Boards of Canada sound". Twenty-eight presets ship
with it, decoded from real patch dumps:

```
/add_track name=keys synth=czsynth preset=turquoise-hexagon-sun-epiano
/keys add_event beat=0 degree=0 duration=0.25
/keys add_event beat=2 degree=7 duration=0.25
/keys add_event beat=3 degree=12 duration=0.25
/start
```

Short notes, long tails — on this instrument a note is mostly its *release*,
which is why `duration=0.25` still rings for seconds.

Now the knob:

```
/keys dcw=0 8b
/keys dcw=1 8b
```

That sounds like a filter closing and opening. **There is no filter.** The CZ
works by phase distortion: a cosine table is read with a phase that's been
bent by a piecewise-linear function, so each period still takes exactly one
period but gets traversed unevenly — fast through part of it, slow or stopped
through the rest. `dcw` moves how hard it's bent. At `0` the bend is the
identity and you get a pure sine, whichever waveform is selected; opening it
up adds harmonics. Same audible gesture as a filter sweep, completely
different mechanism.

The presets are the *base*, and all seven params are modifiers on top of
whatever is loaded — so you can swap tones without losing your edits:

```
/keys env_time=4 8b             # stretch every envelope; an epiano becomes a pad
/keys preset=zander-two-bells   # your dcw and env_time survive the change
/keys preset=random
```

Options work the other way round: each one defaults to the sentinel `preset`,
meaning "whatever the tone says". Override one and set it back when you're
done:

```
/keys wave=square               # override the waveform, tone untouched
/keys wave=preset               # give it back
/keys lines=1+2                 # both lines, detuned as the tone specifies
/keys octave=-1
```

`/keys` on its own prints what everything resolved to, including both
envelopes in the CZ's own units — `DCW 67>0*` means the DCW envelope rises at
rate 67 to level **0** and sustains there, which is how you can tell that
`sixtyniner-sine-pad` really is nothing but a sine.

One genuine trap, inherited from the hardware: `wave=reso1`, `reso2` and
`reso3` are *not* phase distortion at all — they're a hard-synced sine through
a per-cycle window — so on those three `dcw` moves a frequency rather than a
brightness. Casio named them "resonant sawtooth/triangle/trapezoid" after the
window shape, and it has been confusing people ever since.

`/code-editor/cz-tapes` is the worked version: five `czsynth` tracks over a
dusty kit, with the effect routing lifted from the notes that came with the
patches.

## The mixer

At the top, the **Transport** bar has the engine on/off button, a pulsing
clock LED with the current beat/bpm readout — the LED blinks each beat, and
the thin ring around it sweeps once per loop, so both "where in the beat"
and "where in the cycle" read at a glance — then the **recorder** controls,
and two buttons on the right — **Save JSON**/**Load JSON** — that run the exact
same `/save_json`/`/load_json` commands you could type yourself (see
[Saving and loading](#saving-and-loading) below), just one click instead.

The recorder group is a blinking **REC** button, a readout showing either the
running length and channel count or the finished take's length, an **ST**/**MT**
toggle for stereo vs. multitrack (locked while recording, since the mode
decides how many files a take has), and **Save**/**×** for downloading or
discarding the take. Every one of them runs the corresponding console command
(`/record`, `/stop_record`, `/recording mode=…`, `/save_record`,
`/clear_record`), so what happened shows up in the scrollback rather than
succeeding silently — which matters here, because "saved
ribbit-….zip — 4 files, 24.0s" is the only confirmation you get that a
download actually contained something. See
[Recording what you played](#recording-what-you-played).

Below that, **Tracks**, **Buses**, and **Master** sit side by side in one
row — Tracks grows to fill the available width and scrolls its own strips
internally once there are enough to overflow, so a long track list can never
push Master out of view; Master always stays visible at a fixed size (it's
neither collapsible nor resizable — you'd never want to lose sight of it).
Tracks and Buses can each be collapsed (an arrow in their vertical label) or
dragged narrower/wider by a handle at their right edge — a collapsed section
keeps its label visible (rotated), so it still reads as "this is what's
hidden," not just a bare arrow. **Modulators** is its own full-width row
below that (collapsible, not resizable — a section that's already full-width
has nowhere for a resize handle to sensibly go), one tile per modulator (e.g.
`lfo1`, `rand1`) with a live meter and its params. **Patches**, at the very
bottom, lists every active patch cable with its live depth (or, for an
event-generating modulator's patch into a synth, "generated notes" in place
of a depth — see [Algorithmic notes](#algorithmic-notes-event-generating-modulators))
and a remove button.

Each track/bus strip mirrors and controls the same state the console does: a
vertical fader (gain, with a level meter next to it), a rotary pan dial
(click-drag vertically), **M** and **S** buttons for mute and solo (see
[Mute, solo, and groups](#mute-solo-and-groups) — M fills red when engaged, S
fills when soloed and shows as an outline on a channel something *else* is
silencing; master has no S), and the insert-chain buttons below that (click to
toggle bypass — active inserts render in the accent color, bypassed ones dim
and struck-through; shift+click instead pastes that insert's id into the
console — see [The console](#the-console)). A track strip also shows its
synth's type (e.g. `oscsynth`) under its name, itself click-to-paste for
`synth=`. Dragging any of these updates the audio graph directly — the
console and mixer are just two views onto the same `Ribbit` instance, so a
`/track_1 gain=0.4` and dragging that track's fader do the same thing. If a
patch is currently modulating a strip's gain or pan, a small pulsing dot
appears next to that label (the fader/dial itself still only ever shows the
*base* value — a live-modulated `AudioParam` can't report its own
momentary value back through a plain read). Below the inserts, each strip
lists its **sends** (`→master 1.00`, `→fx1 0.30`, live gain included) —
click one and the console gets `send=s2 send_gain=` teed up, ready for a
value; adjusting routing itself stays a console action. Every strip's own
name, "gain"/"pan" labels, a modulator's name, and each of its param
readouts are also click-to-paste. A modulator tile and a patch row are
otherwise read-only in the mixer (control values from the console); their
live values still update in real time as you type commands. An
event-generating modulator's tile (e.g. `rand1`) swaps the bipolar meter —
which would read a flat 0, since it has no continuous output — for a dot
that lights up each time a generated note actually fires.

Toggle the whole mixer pane with the collapse arrow between the console and
mixer (it shrinks to a thin rail showing just the master power button, clock
LED, and level meter) — useful for maximizing the console when you're just
typing.

## Saving and loading

Two related but different things: **states** are named snapshots you flip
between while working, kept in memory; **session files** are the whole thing
written to (and read back from) an actual `.json` file on disk.

Capture where things stand right now under a name:

```
/save name=verse1
```

(A bare leading value is shorthand for `name=` — `/save verse1` works too,
and the same goes for `/recall` below.)

Change some things — mute the drums, bring a bus in, whatever — then jump
back:

```
/recall name=verse1
```

`/recall` doesn't hard-cut back to the saved state — it glides: anything that
changed ramps toward the saved value, anything that needs to be created fades
in, anything that needs to disappear fades out first. Give it a duration (the
same trailing-duration syntax as [Ramps](#ramps)) to control how long that
takes:

```
/recall name=verse1 4b at=cycle
```

That recalls `verse1` over 4 beats, starting at the top of the next loop —
handy for switching between a couple of saved arrangements of the same
tracks as a live "scene" tool, rather than a jarring jump. `/states` lists
every saved name; `/remove_state name=verse1` deletes one.

States only live in memory — reloading the page loses them, same as
everything else. `/save_session` writes the *entire* session (every track,
bus, processor, modulator, patch, and every state you've `/save`d) to a
downloaded `.json` file:

```
/save_session
```

`/load_session` opens a file picker and rebuilds the session from a chosen
file — unlike `/recall`, this is a hard reset: everything currently live is
torn down first, since loading an entirely different session from disk isn't
something you'd want to hear glide into place. This is also how
`/code-editor/demo` works under the hood, just automatic instead of picked by
hand — see [Running it](#running-it) above. The mixer's Transport bar has
Save JSON/Load JSON buttons that run these same two commands (`/save_json`/
`/load_json`, plain aliases for `/save_session`/`/load_session`) — see
[The mixer](#the-mixer).

### Giving a session a readme

A session file can introduce itself. Add a top-level `readme` — an array of
lines — and the console prints it the moment the session opens:

```json
{
  "version": 1,
  "readme": [
    "verse — a euclidean grid with ghost notes on top.",
    "",
    "Try:",
    "  /grid dropout=0.4 8b     thin the backbone out",
    "  /ghosts seed=random      re-roll only the decoration"
  ],
  "clock": { "bpm": 92, "loopLengthBeats": 4 }
}
```

It's the right place for what the session *is* and which commands are worth
trying — the things you'd otherwise have to rediscover by reading the JSON.
`/save_json` writes it back out, so it survives a round trip; a `/save`d
*state* doesn't carry one, since it describes the session as a whole rather
than any one snapshot. Every session shipped with the app has one — open any
of them from the homepage to see it.

See [commands.md](commands.md#session-and-states) for the full reference.

## Recording what you played

A session file says how to *make* the sound. Once you've made something worth
keeping, `/record` captures the sound itself:

```
/record at=cycle
... play ...
/stop_record at=cycle
/save_record
```

Both ends take `at=`, which is the whole reason to type them rather than
clicking: starting and stopping on cycle boundaries gives you a take that's a
whole number of loops long, so it loops cleanly in whatever you drop it into.
`/save_record` downloads a 32-bit float `.wav`.

That records master — what you heard. The other mode records the *parts*:

```
/recording mode=multitrack
/record
```

Now every track, every bus, and master is captured as its own stereo file,
downloaded together as one `.zip` with the files numbered in mixer order. That
is a stem export: open it in a DAW and you have your session's channels
separately, to remix, edit, or mix by hand. Set the mode before you start —
it can't change mid-take.

`/recording` on its own reports where things stand, including how much memory
the take is holding, which is worth watching: a take is raw audio, and a
multitrack one grows several times faster than a stereo one. There's a safety
stop at five minutes (`/recording max_minutes=10` to raise it) and
`/clear_record` to throw a take away once you've saved it.

Taps are post-fader, so a muted track records silence, and nothing at all is
captured while the engine is stopped. The mixer's Transport bar has all of
this as buttons — see [The mixer](#the-mixer). Full reference:
[commands.md](commands.md#recording).

## Cleaning up

```
/track_1 remove_self
/fx1 remove_self
/lfo1 remove_self
/stop
```

`remove_self` works on tracks, buses, processors, and modulators (not
master) — removing any of them also removes any patch or send elsewhere that
was touching it, so there's nothing left to separately clean up with
`/unpatch`/`remove_send=` unless you're removing a specific one on its own.
`/stop` suspends the whole audio engine; `/start` resumes it.

## Audio options

The homepage (`/`) has a small panel for two things that only take effect
when a session page next starts its audio engine (changing them doesn't
affect a session already open in another tab):

- **Output device** — which speakers/interface the engine renders to.
  Browser device labels are hidden until you click "Show device names" (this
  briefly requests microphone permission, purely as the standard browser
  workaround for revealing output device names — nothing is recorded).
  Requires `AudioContext.setSinkId` support; not every browser has it yet,
  in which case the selector is disabled.
- **Latency** — "interactive" (the default) favors the lowest latency at
  the cost of more CPU; "playback" accepts higher latency for the fewest
  glitches; "balanced" sits in between. This is a Web Audio setting fixed at engine
  startup, so it can't be changed after a session page has already opened.

Both choices are remembered (in the browser, on this device) and applied the
next time you open `/code-editor` or `/code-editor/demo`.

See [commands.md](commands.md) for the full command reference and
[objects.md](objects.md) for every synth/processor/modulator type and its
parameters.
