// Where the singers of a section stand: mirrors src/verr_voice/synth/stage.py.
// Whole-sample delays and pure arithmetic, so both engines agree exactly.
export const STAGE_WIDTH = 0.65, STAGE_DELAY_MS = 0.35, STAGE_EDGE = 0.9;
const SR = 48000, GOLDEN = 0.6180339887498949, PLASTIC = 0.7548776662466927;
const frac = (x) => x - Math.floor(x);
const VIBRATO_SPREAD = 1;
// How much of the control's vibrato each singer uses (mirrors stage.py).
export function vibratoCharacters(count, seed) {
  if (count <= 1) return new Array(Math.max(count, 0)).fill(1);
  const rotation = frac(seed * GOLDEN),
    key = (i) => frac((i + 1) * PLASTIC + rotation),
    order = [...Array(count).keys()].sort((a, b) => key(a) - key(b) || a - b),
    raw = order.map((_, rank) => Math.exp(VIBRATO_SPREAD * (-1 + (2 * rank) / (count - 1)))),
    mean = raw.reduce((x, y) => x + y, 0) / count,
    out = new Array(count);
  order.forEach((singer, rank) => { out[singer] = raw[rank] / mean; });
  return out;
}
export const stageActive = (count) => count > 1 && STAGE_WIDTH > 0;
// Python's round(): ties go to the even integer.
const roundEven = (x) => {
  const f = Math.floor(x), d = x - f;
  return d > 0.5 || (d === 0.5 && f % 2) ? f + 1 : f;
};
export function seats(count, seed, pan = 0) {
  const rotation = frac(seed * PLASTIC),
    key = (i) => frac((i + 1) * GOLDEN + rotation),
    order = [...Array(count).keys()].sort((a, b) => key(a) - key(b) || a - b),
    out = new Array(count);
  order.forEach((singer, rank) => {
    const place = Math.max(-STAGE_EDGE, Math.min(STAGE_EDGE, pan + STAGE_WIDTH * (-1 + (2 * rank) / (count - 1)))),
      angle = ((place + 1) * Math.PI) / 4,
      delay = roundEven((Math.abs(place) * STAGE_DELAY_MS * SR) / 1000);
    out[singer] = { left: Math.cos(angle), right: Math.sin(angle), delayLeft: place > 0 ? delay : 0, delayRight: place < 0 ? delay : 0 };
  });
  return out;
}
// A stereo stem travels planar in one Float32Array: all of left, then all of right.
export const planes = (pcm, frames) =>
  pcm.length > frames ? [pcm.subarray(0, frames), pcm.subarray(frames, 2 * frames)] : [pcm];
// A seated section already stands at its place; the mixer's pan is an offset from it.
export const panOffset = (channels, pan, seatedPan) =>
  channels === 2 ? Math.max(-1, Math.min(1, pan - seatedPan)) : pan;
