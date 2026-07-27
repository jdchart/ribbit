// Maps a linear 0-1 control position (fader position, command param) to a
// perceptually-even 0-1 gain value. Loudness is perceived roughly
// logarithmically, so an exponential curve here makes equal steps in
// position feel like equal steps in loudness, with finer control at the
// quiet end where the ear is most sensitive.
const TAPER_K = 6;

export function positionToGain(position) {
    const clamped = Math.max(0, Math.min(1, position));
    return (Math.exp(TAPER_K * clamped) - 1) / (Math.exp(TAPER_K) - 1);
};

export function gainToPosition(gain) {
    const clamped = Math.max(0, Math.min(1, gain));
    return Math.log(clamped * (Math.exp(TAPER_K) - 1) + 1) / TAPER_K;
};
