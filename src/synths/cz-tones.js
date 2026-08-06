// The Boards of Canada CZ-101 tone library.
//
// Twenty-eight patches, decoded from the Casio system-exclusive dumps in
// `.claude/context/Casio CZ 101/syx/` — one folder per record. These are
// recreations of the sounds on those records, not Casio factory presets, and
// they are the whole reason `czsynth` has a preset library at all: a CZ tone is
// three eight-stage envelopes per line, which is ninety-odd numbers, and no
// console surface is going to let you type that. The synth's params ride on
// top of whatever is selected here.
//
// **The sysex format.** A single-tone dump is 264 bytes: seven of header
// (`F0 44 00 00 70 <fn> <program>`), 256 of payload, then `F7`. The payload is
// transmitted as half-bytes, low nibble first, so it joins back into 128 bytes
// of tone data laid out in 25 fixed-length sections. The decode is
// self-checking, which is why it can be trusted: `a03-square-lead` comes back
// as wave code 1 (square), `twoism-pulse-epiano` as code 2 (pulse), and
// `sixtyniner-sine-pad` as a saw-pulse whose DCW envelope terminates at level
// zero — which in phase distortion is exactly a sine, as its name promises.
//
// Fields, all in the machine's own units so they can be checked against a real
// CZ's display:
//
// - `lines` — the LINE SELECT: `1` or `2` is a single line, `1+1` doubles line
//   one against itself, `1+2` runs both lines. `detune` (cents, signed) is the
//   interval between them and is meaningless on a single line, so a few tones
//   here carry a large leftover value that never sounds.
// - `octave` — the OCTAVE switch, -1/0/+1.
// - `wave` / `wave2` — the phase-distortion waveform. `combination` means the
//   two alternate on successive periods rather than mixing, which is what puts
//   a sub-octave under `oirectine-epiano` and `orange-hexagon-sun`.
// - `dca` / `dcw` / `dco` — amplitude, waveshaper and pitch envelopes. `steps`
//   is `[rate, level]` pairs in the CZ's 0..99 units; `end` is the 1-based
//   sustain step, so steps before it run on the attack, the level there is held
//   while the key is down, and the steps after it are the release.
// - `dcaFollow` / `dcwFollow` — KEY FOLLOW, 0..9: how much higher notes decay
//   faster and sound darker.
// - `vibrato` — the shared LFO: `wave`, plus `delay`, `rate` and `depth` in
//   0..99 machine units.
//
// Regenerating: the decoder is `.claude/context/Casio CZ 101/` plus the script
// in that session's scratchpad; nothing at runtime reads the `.syx` files.

export const CZ_TONES = {

    // --- afot ---
    "5978-flute": {
        album: "afot",
        lines: "1", octave: 0, detune: 0, mod: "none",
        vibrato: { wave: "triangle", delay: 38, rate: 60, depth: 8 },
        line1: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[99, 50], [70, 93], [58, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
        line2: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[99, 50], [70, 93], [58, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
    },
    "5978-shimmer": {
        album: "afot",
        lines: "1+1", octave: 0, detune: 1200, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 6, depth: 0 },
        line1: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[99, 44], [66, 93], [41, 69], [12, 37], [27, 0]] },
            dcw: { end: 1, steps: [[67, 0], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
        line2: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[99, 50], [70, 93], [58, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
    },
    "boquarant-epiano": {
        album: "afot",
        lines: "1", octave: 0, detune: 4612, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 18, depth: 2 },
        line1: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 2, steps: [[99, 99], [99, 97], [28, 0]] },
            dcw: { end: 1, steps: [[69, 2], [57, 0]] },
            dco: { end: 1, steps: [[99, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 3, dcwFollow: 9,
            dca: { end: 3, steps: [[99, 56], [56, 44], [37, 0], [46, 0]] },
            dcw: { end: 1, steps: [[99, 40], [99, 0]] },
            dco: { end: 1, steps: [[99, 0], [53, 0]] },
        },
    },
    "boquarant-pads": {
        album: "afot",
        lines: "1", octave: 0, detune: 0, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 33, depth: 1 },
        line1: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 1, steps: [[99, 99], [95, 0]] },
            dcw: { end: 1, steps: [[99, 99], [57, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 1, steps: [[99, 99], [50, 0]] },
            dcw: { end: 1, steps: [[99, 99], [57, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
    },

    // --- hi scores ---
    "eydiab-flute-melody": {
        album: "hi scores",
        lines: "1", octave: 0, detune: 0, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 32, depth: 10 },
        line1: {
            wave: "pulse", wave2: "pulse", combination: false,
            dcaFollow: 3, dcwFollow: 0,
            dca: { end: 4, steps: [[93, 50], [70, 93], [57, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 41], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
        line2: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[99, 50], [70, 93], [57, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
    },
    "eydiab-intro-epiano": {
        album: "hi scores",
        lines: "1+1", octave: 0, detune: 1200, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 13, depth: 0 },
        line1: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 9,
            dca: { end: 3, steps: [[95, 99], [92, 99], [27, 0], [77, 0]] },
            dcw: { end: 1, steps: [[69, 0], [57, 0]] },
            dco: { end: 1, steps: [[99, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 9, dcwFollow: 9,
            dca: { end: 3, steps: [[99, 99], [99, 99], [21, 0], [58, 0]] },
            dcw: { end: 1, steps: [[99, 0], [99, 0]] },
            dco: { end: 1, steps: [[99, 0], [53, 0]] },
        },
    },
    "eydiab-pad": {
        album: "hi scores",
        lines: "1", octave: 0, detune: 0, mod: "none",
        vibrato: { wave: "triangle", delay: 38, rate: 20, depth: 0 },
        line1: {
            wave: "pulse", wave2: "pulse", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[50, 50], [45, 93], [57, 99], [12, 94], [52, 0]] },
            dcw: { end: 1, steps: [[67, 69], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
        line2: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[99, 50], [70, 93], [57, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
    },
    "turquoise-hexagon-sun-epiano": {
        album: "hi scores",
        lines: "1", octave: 0, detune: 0, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 36, depth: 1 },
        line1: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 2, steps: [[97, 99], [99, 99], [27, 0]] },
            dcw: { end: 1, steps: [[99, 0], [57, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 1, steps: [[99, 99], [50, 0]] },
            dcw: { end: 1, steps: [[99, 99], [57, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
    },

    // --- mhtrtc ---
    "color-of-the-fire-epiano": {
        album: "mhtrtc",
        lines: "1", octave: 1, detune: 2100, mod: "none",
        vibrato: { wave: "square", delay: 0, rate: 8, depth: 2 },
        line1: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 2, steps: [[99, 99], [99, 87], [26, 0]] },
            dcw: { end: 1, steps: [[99, 0], [57, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 2, steps: [[99, 0], [99, 24], [36, 0]] },
            dcw: { end: 1, steps: [[99, 0], [57, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
    },
    "happy-cycling-epiano": {
        album: "mhtrtc",
        lines: "1", octave: -1, detune: 4612, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 10, depth: 5 },
        line1: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 0, dcwFollow: 9,
            dca: { end: 2, steps: [[92, 99], [21, 0], [58, 0]] },
            dcw: { end: 1, steps: [[99, 0], [7, 0]] },
            dco: { end: 1, steps: [[99, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 3, dcwFollow: 9,
            dca: { end: 3, steps: [[99, 56], [56, 44], [37, 0], [46, 0]] },
            dcw: { end: 1, steps: [[99, 40], [99, 0]] },
            dco: { end: 1, steps: [[99, 0], [53, 0]] },
        },
    },
    "pete-standing-alone-5ths": {
        album: "mhtrtc",
        lines: "1", octave: 0, detune: 0, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 3, depth: 12 },
        line1: {
            wave: "doublesine", wave2: "doublesine", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 1, steps: [[99, 99], [27, 0]] },
            dcw: { end: 1, steps: [[99, 99], [7, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 1, steps: [[99, 99], [50, 0]] },
            dcw: { end: 1, steps: [[99, 99], [57, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
    },

    // --- otv2 ---
    "kiteracer-brass": {
        album: "otv2",
        lines: "1", octave: 0, detune: 0, mod: "none",
        vibrato: { wave: "triangle", delay: 10, rate: 20, depth: 5 },
        line1: {
            wave: "pulse", wave2: "pulse", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 2, steps: [[99, 0], [76, 99], [57, 0]] },
            dcw: { end: 1, steps: [[69, 72], [52, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 1, steps: [[99, 99], [50, 0]] },
            dcw: { end: 1, steps: [[99, 99], [57, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
    },
    "kiteracer-epiano": {
        album: "otv2",
        lines: "1+1", octave: 0, detune: 1200, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 21, depth: 2 },
        line1: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 2, steps: [[96, 99], [30, 0], [35, 0]] },
            dcw: { end: 3, steps: [[99, 79], [99, 0], [99, 0], [29, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 1, steps: [[99, 99], [50, 0]] },
            dcw: { end: 1, steps: [[99, 99], [57, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
    },
    "kiteracer-shimmer": {
        album: "otv2",
        lines: "1+1", octave: -1, detune: 1200, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 66, depth: 3 },
        line1: {
            wave: "saw", wave2: "sawpulse", combination: true,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 1, steps: [[72, 99], [23, 0]] },
            dcw: { end: 1, steps: [[99, 99], [57, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 1, steps: [[99, 99], [50, 0]] },
            dcw: { end: 1, steps: [[99, 99], [57, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
    },
    "orange-hexagon-sun": {
        album: "otv2",
        lines: "1", octave: 0, detune: 0, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 50, depth: 0 },
        line1: {
            wave: "pulse", wave2: "sawpulse", combination: true,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 2, steps: [[99, 99], [43, 62], [33, 0]] },
            dcw: { end: 2, steps: [[99, 58], [99, 44], [40, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 1, steps: [[99, 99], [50, 0]] },
            dcw: { end: 1, steps: [[99, 99], [57, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
    },
    "powerline-misfortune-epiano": {
        album: "otv2",
        lines: "1+1", octave: 1, detune: 1212, mod: "none",
        vibrato: { wave: "triangle", delay: 51, rate: 52, depth: 0 },
        line1: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 9,
            dca: { end: 2, steps: [[99, 99], [99, 94], [35, 0]] },
            dcw: { end: 1, steps: [[69, 0], [55, 0]] },
            dco: { end: 1, steps: [[99, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 3, dcwFollow: 9,
            dca: { end: 3, steps: [[93, 99], [55, 99], [21, 0], [60, 0]] },
            dcw: { end: 1, steps: [[69, 0], [55, 0]] },
            dco: { end: 1, steps: [[99, 0], [53, 0]] },
        },
    },
    "powerline-misfortune-flute": {
        album: "otv2",
        lines: "1", octave: 0, detune: 0, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 17, depth: 11 },
        line1: {
            wave: "pulse", wave2: "pulse", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[99, 50], [70, 92], [57, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 55], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
        line2: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[99, 50], [70, 93], [57, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
    },
    "zander-two-bells": {
        album: "otv2",
        lines: "1+2", octave: 0, detune: 2400, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 50, depth: 0 },
        line1: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 2, steps: [[99, 99], [36, 0], [30, 0]] },
            dcw: { end: 1, steps: [[99, 0], [7, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 1,
            dca: { end: 2, steps: [[99, 90], [32, 0], [30, 0]] },
            dcw: { end: 1, steps: [[99, 27], [88, 99], [7, 99], [25, 99], [99, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
    },

    // --- r35 ---
    "a03-bass": {
        album: "r35",
        lines: "1+2", octave: -1, detune: 1204, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 50, depth: 0 },
        line1: {
            wave: "square", wave2: "square", combination: false,
            dcaFollow: 9, dcwFollow: 0,
            dca: { end: 1, steps: [[95, 84], [47, 0]] },
            dcw: { end: 1, steps: [[99, 80], [52, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
        line2: {
            wave: "square", wave2: "square", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 1, steps: [[92, 87], [47, 0]] },
            dcw: { end: 1, steps: [[99, 92], [55, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
    },
    "a03-square-lead": {
        album: "r35",
        lines: "1+1", octave: 0, detune: 27, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 25, depth: 20 },
        line1: {
            wave: "square", wave2: "square", combination: false,
            dcaFollow: 9, dcwFollow: 0,
            dca: { end: 3, steps: [[87, 99], [36, 99], [70, 99], [92, 0]] },
            dcw: { end: 3, steps: [[79, 99], [53, 96], [43, 51], [32, 0]] },
            dco: { end: 1, steps: [[99, 26], [72, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 2, dcwFollow: 2,
            dca: { end: 3, steps: [[82, 99], [36, 93], [78, 67], [55, 0]] },
            dcw: { end: 3, steps: [[73, 99], [53, 96], [43, 51], [32, 0]] },
            dco: { end: 1, steps: [[99, 26], [72, 0]] },
        },
    },
    "b12-slow-flute": {
        album: "r35",
        lines: "1+2", octave: 0, detune: 12, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 22, depth: 12 },
        line1: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 7,
            dca: { end: 4, steps: [[99, 50], [70, 93], [57, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
        line2: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 7,
            dca: { end: 4, steps: [[99, 50], [70, 93], [57, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
    },
    "orangey-flute": {
        album: "r35",
        lines: "1", octave: 1, detune: 0, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 17, depth: 14 },
        line1: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 7,
            dca: { end: 4, steps: [[99, 50], [70, 93], [57, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
        line2: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 7,
            dca: { end: 4, steps: [[99, 50], [70, 93], [57, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
    },

    // --- twoism ---
    "oirectine-epiano": {
        album: "twoism",
        lines: "1", octave: 0, detune: 1200, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 50, depth: 0 },
        line1: {
            wave: "saw", wave2: "sawpulse", combination: true,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 2, steps: [[99, 99], [99, 96], [25, 56], [23, 0]] },
            dcw: { end: 1, steps: [[99, 12], [7, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 2, steps: [[99, 99], [99, 46], [22, 56], [23, 0]] },
            dcw: { end: 1, steps: [[99, 0], [57, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
    },
    "sixtyniner-epiano": {
        album: "twoism",
        lines: "1", octave: 0, detune: 4612, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 28, depth: 12 },
        line1: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 3, dcwFollow: 9,
            dca: { end: 3, steps: [[99, 99], [99, 88], [21, 0], [27, 0]] },
            dcw: { end: 1, steps: [[69, 0], [57, 0]] },
            dco: { end: 1, steps: [[99, 0], [53, 0]] },
        },
        line2: {
            wave: "saw", wave2: "saw", combination: false,
            dcaFollow: 3, dcwFollow: 9,
            dca: { end: 3, steps: [[99, 56], [56, 44], [37, 0], [46, 0]] },
            dcw: { end: 1, steps: [[99, 40], [99, 0]] },
            dco: { end: 1, steps: [[99, 0], [53, 0]] },
        },
    },
    "sixtyniner-flute-vignette": {
        album: "twoism",
        lines: "1", octave: 0, detune: 0, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 30, depth: 0 },
        line1: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[99, 50], [70, 93], [57, 99], [12, 94], [71, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
        line2: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[99, 50], [70, 93], [57, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
    },
    "sixtyniner-sine-pad": {
        album: "twoism",
        lines: "1", octave: 0, detune: 0, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 31, depth: 7 },
        line1: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 0,
            dca: { end: 4, steps: [[99, 32], [75, 57], [57, 67], [12, 58], [52, 0]] },
            dcw: { end: 1, steps: [[67, 0], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
        line2: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[99, 50], [70, 93], [57, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
    },
    "twoism-pulse-epiano": {
        album: "twoism",
        lines: "1+2", octave: 0, detune: 4, mod: "none",
        vibrato: { wave: "triangle", delay: 0, rate: 50, depth: 0 },
        line1: {
            wave: "pulse", wave2: "pulse", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 2, steps: [[99, 99], [99, 83], [16, 0]] },
            dcw: { end: 1, steps: [[99, 66], [29, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
        line2: {
            wave: "pulse", wave2: "pulse", combination: false,
            dcaFollow: 0, dcwFollow: 0,
            dca: { end: 2, steps: [[99, 99], [99, 83], [23, 0]] },
            dcw: { end: 1, steps: [[99, 66], [29, 0]] },
            dco: { end: 1, steps: [[53, 0], [53, 0]] },
        },
    },
    "twoism-pulse-pad": {
        album: "twoism",
        lines: "1", octave: 0, detune: 0, mod: "none",
        vibrato: { wave: "triangle", delay: 38, rate: 20, depth: 0 },
        line1: {
            wave: "pulse", wave2: "pulse", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[99, 50], [70, 93], [57, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 55], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
        line2: {
            wave: "sawpulse", wave2: "sawpulse", combination: false,
            dcaFollow: 1, dcwFollow: 8,
            dca: { end: 4, steps: [[99, 50], [70, 93], [57, 99], [12, 94], [66, 0]] },
            dcw: { end: 1, steps: [[67, 57], [7, 0]] },
            dco: { end: 1, steps: [[0, 0], [53, 0]] },
        },
    },
};

// Every tone name, in the order above (album by album, as the records run).
// Drives the `preset` option's `choices`, and so its ghost-text completion.
export const CZ_TONE_NAMES = Object.keys(CZ_TONES);
