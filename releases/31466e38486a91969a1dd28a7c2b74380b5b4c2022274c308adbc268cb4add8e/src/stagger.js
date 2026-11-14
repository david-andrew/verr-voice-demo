// Singers in a section do not place a consonant at the same moment. Mirror of
// native synth/stagger.py: each consonant cluster gets a per-singer offset,
// re-centred on the section mean (a stagger, not a shift); one singer gets none.
import { smooth } from "./dsp.js";
const SPREAD = 0.012,
  LIMIT = 2.5,
  ENTRANCE = 0.04;

function mix32(x) {
  x >>>= 0;
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function normal(seed, cluster, singer) {
  const h1 = mix32((Math.imul(seed, 0x9e3779b1) + Math.imul(cluster, 0x85ebca6b) + Math.imul(singer, 0xc2b2ae35) + 0x27d4eb2f) >>> 0),
    h2 = mix32((h1 ^ 0x165667b1) >>> 0),
    u1 = (h1 + 0.5) / 4294967296,
    u2 = (h2 + 0.5) / 4294967296;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function clusters(gestures) {
  const out = [];
  gestures.forEach((g, i) => {
    if (out.length && g.start <= gestures[out.at(-1).at(-1)].end + 1e-3) out.at(-1).push(i);
    else out.push([i]);
  });
  return out;
}

export function stagger(gestures, seed, count) {
  if (count < 2 || !gestures.length) return Array.from({ length: count }, () => gestures);
  const groups = clusters(gestures),
    shifted = Array.from({ length: count }, () => gestures.slice()),
    scale = SPREAD * Math.sqrt(count / (count - 1));
  groups.forEach((group, k) => {
    const start = gestures[group[0]].start,
      end = gestures[group.at(-1)].end,
      before = k ? start - gestures[groups[k - 1].at(-1)].end : ENTRANCE,
      after = k + 1 < groups.length ? gestures[groups[k + 1][0]].start - end : ENTRANCE,
      bound = Math.min(LIMIT * SPREAD, 0.5 * before, 0.5 * after, Math.max(0,start));
    if (bound <= 0) return;
    let offsets = Array.from({ length: count }, (_, i) => scale * normal(seed, group[0], i));
    const mean = offsets.reduce((a, b) => a + b, 0) / count;
    offsets = offsets.map((x) => x - mean);
    // Narrow the whole cluster's spread rather than clip one singer: the mean stays exact.
    const widest = Math.max(...offsets.map(Math.abs));
    if (widest > bound) offsets = offsets.map((x) => (x * bound) / widest);
    for (let i = 0; i < count; i++)
      for (const j of group) {
        const g = gestures[j];
        shifted[i][j] = { ...g, start: Math.max(0,g.start + offsets[i]), end: g.end + offsets[i] };
      }
  });
  return shifted;
}

// Give each singer of one section its own consonant timing (actors[0] holds the phrase seed).
export function staggerConsonants(actors) {
  const shifted = stagger(actors[0].plan.gestures, actors[0].seed, actors.length);
  actors.forEach((actor, i) => { actor.setGestures(shifted[i]); });
}

export function singerAir(plan,gestures) {
  const air=plan.raw.amp.slice();
  plan.gestures.forEach((old,j)=>{
    const g=gestures[j];if(Math.abs(old.start-g.start)<1e-12)return;
    const lo=Math.max(0,Math.ceil((g.start-.012)*200)),hi=Math.min(air.length-1,Math.floor((g.end+.03)*200));
    for(let i=lo;i<=hi;i++){
      const t=i/200,support=smooth((t-g.start+.012)/.012)*smooth((g.end+.03-t)/.03),
        pressure=.76**1.35*10**(plan.raw.levelDb[i]/20);
      air[i]=Math.max(air[i],pressure*support);
    }
  });
  return air;
}
