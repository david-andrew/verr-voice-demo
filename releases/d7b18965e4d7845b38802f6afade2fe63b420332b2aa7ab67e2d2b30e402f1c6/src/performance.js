import { vowelModel, vowelSpectrum } from "./vowel-model.js";
import { NativeRandom } from "./native-random.js";
import { sonorants } from "./sonorants.js";
import { sexShift } from "./part-controls.js";
import { filterBatch } from "./gpu-filters.js";
import { planPhrase, gaussian, VOWELS } from "./musical-plan.js";
import TOKENS from "./consonant-tokens.js";
export { planPhrase } from "./musical-plan.js";
import {
  smooth,
  clamp,
  SR,
  pulseClock,
  filters,
  synthesizeWindow,
  voiceEnergy,
  lowerBound,
} from "./dsp.js";
const mix = (a, b, w) => a * (1 - w) + b * w;
// Mirrors synth/trajectories.py: voiceless releases whose donors show a clean
// closure, release and aspiration/frication follow the measured noise contour
// and voice-onset delay instead of a generic pressure puff.
const MEASURED_RELEASE = new Set(["P", "CH"]);
function releaseLandmarks(u) {
  if (u.landmarks) return u.landmarks;
  const core = [];
  for (let j = 0; j < u.times.length; j++)
    if (u.times[j] >= u.duration * 0.15 && u.times[j] <= u.duration) core.push(j);
  let peak = 0;
  if (core.length) { peak = core[0]; for (const j of core) if (u.ratio[j] > u.ratio[peak]) peak = j; }
  const onset = core.find(j => j <= peak && u.ratio[j] >= 0.25 * u.ratio[peak]);
  const release = u.times[onset ?? peak];
  let top = -Infinity, voice = null;
  for (let j = 0; j < u.times.length; j++) if (u.times[j] > release) top = Math.max(top, u.hratio[j]);
  for (let j = 0; j < u.times.length; j++)
    if (u.times[j] > release && u.hratio[j] >= 0.25 * top) { voice = u.times[j]; break; }
  return (u.landmarks = [release, Math.max(voice ?? u.duration, release + 0.02)]);
}
const sample = (a, t) => {
  const p = clamp(t * 100, 0, a.length - 1),
    i = Math.floor(p);
  return mix(a[i], a[Math.min(i + 1, a.length - 1)], p - i);
};
export function phrases(lane) {
  const out = [];
  let current,
    previous = ["AA"];
  for (const e of lane.filter(e=>e.midi!=null).toSorted((a,b)=>a.start-b.start)) {
    if (!current || e.start - current.end > 0.025 || current.breath) {
      current = {
        start: e.start,
        end: e.start + e.duration,
        events: [],
        initial: previous,
      };
      out.push(current);
    }
    current.events.push(e);
    current.end = Math.max(current.end, e.start + e.duration);
    current.breath = e.breath;
    if (e.phones?.nucleus?.length) previous = e.phones.nucleus;
  }
  return out;
}
// Geometry uses exactly the same phrase split and origins as the render worker.
export function planNoteGeometry(lane,duration,controls,inventory){
  const plans=duration>90?phrases(lane):[{start:0,origin:0,end:duration,events:lane}];
  return plans.flatMap(p=>planPhrase(p,controls,inventory).notes);
}
const tractCache = new Map();
function tractVariation(seed) {
 if(!tractCache.has(seed)){tractCache.set(seed,new NativeRandom(seed+901).normal());while(tractCache.size>4096)tractCache.delete(tractCache.keys().next().value);}
 return tractCache.get(seed);
}
function unitCursor(unit, t, seed) {
  const position=Math.max(0,t)/.83,segment=Math.floor(position),a=smooth(position-segment);
  const cursor=slot=>{let x=(seed^Math.imul(slot+1,0x9e3779b1))>>>0;x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296*(unit.frames-1);};
  const p=cursor(segment),q=cursor(segment+1),lo=Math.floor(p),lo2=Math.floor(q);
  return {lo,hi:Math.min(lo+1,unit.frames-1),lo2,hi2:Math.min(lo2+1,unit.frames-1),w:p-lo,w2:q-lo2,a};
}
function readMotion(unit, c) {
  return mix(
    mix(unit.motion[c.lo], unit.motion[c.hi], c.w),
    mix(unit.motion[c.lo2], unit.motion[c.hi2], c.w2),
    c.a,
  );
}
// dB of band level per dB of level, fitted to Pando (native performers.py). Flat below 1 kHz.
const COLOUR_HZ = [1000, 1414, 1782, 2245, 2828, 3564, 4490, 5657, 7127, 8980, 11314],
  COLOUR_DB = [0, 0.345, 0.694, 0.68, 0.528, 0.469, 0.336, 0.227, 0.225, 0.144, 0.042];
const LOUDNESS_COLOUR = Float64Array.from({ length: 513 }, (_, b) => {
  const f = (b * SR) / 1024;
  if (f <= COLOUR_HZ[0] || f > COLOUR_HZ.at(-1)) return 0;
  let i = 0;
  while (f > COLOUR_HZ[i + 1]) i++;
  return COLOUR_DB[i] + ((f - COLOUR_HZ[i]) / (COLOUR_HZ[i + 1] - COLOUR_HZ[i])) * (COLOUR_DB[i + 1] - COLOUR_DB[i]);
});
export function sourceSpectrum(units, t, f0, weights, c, seed, index, levelDb = 0) {
  const model = vowelModel(units),
    logPower = vowelSpectrum(model, weights, f0),
    ap = model.ap;
  const variation =
      c.size > 1
        ? (0.024 + 0.054 * c.blend) * tractVariation(seed)
        : 0,
    tract = clamp(
      1 +
        0.08 * (c.timbre - 0.5) +
        0.09 * (0.5 - c.age) -
        0.025 * (c.weight - 0.5) +
        .24 * sexShift(c) +
        variation,
      0.76,
      1.28,
    ),
    out = new Float64Array(513),
    outAp = new Float64Array(513);
  for (let b = 0; b < 513; b++) {
    const p = clamp(b / tract, 0, 512),
      lo = Math.floor(p),
      hi = Math.min(lo + 1, 512),
      w = p - lo,
      f = (b * SR) / 1024,
      oct = Math.log2(Math.max(f, 100) / 700),
      db = clamp(
        (c.phonation - 0.7) * 4 * oct +
          (c.timbre - 0.5) * 1.8 * oct -
          sexShift(c) * 2.5 * oct +
          ((c.weight - 0.5) * 5) / (1 + (f / 500) ** 2),
        -15,
        9,
      );
    out[b] = Math.exp(
      mix(
        logPower[lo],
        logPower[hi],
        w,
      ) +
        (db * Math.LN10) / 10 +
        // Louder voices are brighter; only the harmonic envelope tilts, so the
        // noise's ratio to the harmonics does not move.
        (levelDb * LOUDNESS_COLOUR[b] * Math.LN10) / 10,
    );
    outAp[b] = clamp(
      mix(ap[lo], ap[hi], w) * (1.5 - 0.75 * c.phonation) +
        (1 - c.phonation) * 0.025 * (f > 900),
      0.001,
      0.98,
    );
  }
  // Harmonic-aware calibration, identical to native voice_energy.
  for (let b = 0; b < 513; b++) out[b] = clamp(out[b], Math.exp(-24), Math.exp(16));
  const energy = voiceEnergy(out, outAp, f0);
  for (let b = 0; b < 513; b++) out[b] = clamp(out[b] / energy, Math.exp(-24), Math.exp(16));
  return { power: out, ap: outAp, motion: 0 };
}
// Real occurrences measured from VocalSet: scripts/analysis/consonant_tokens.py.
const TOKEN_GRID = TOKENS.grid.map((f) => Math.log(f));
const ROUNDING = 0.08,
  ROUNDED = ["AO", "UH", "UW", "U", "O", "OH"].map((v) => VOWELS.indexOf(v)),
  CONSONANT_COLOUR = 0.75;
function roundedScale(scale, vowels) {
  if (!vowels) return scale;
  let weight = 0;
  for (const i of ROUNDED) weight += vowels[i] || 0;
  return scale * (1 - ROUNDING * clamp(weight));
}
function isMaleToken(voice, c) {
  const typical = ({ bass: 0.88, tenor: 0.95, alto: 1.05, soprano: 1.14 }[voice] || 1) / 1.14;
  return typical * (1 + 0.24 * sexShift(c)) < 0.88;
}
const tokenArrays = new Map();
function consonantToken(phone, occurrence, seed, male) {
  const entry = TOKENS.phones[phone];
  if (!entry) return null;
  const sex = male ? "m" : "f";
  let code = 0;
  for (const character of phone) code = (code * 31 + character.charCodeAt(0)) & 0xffff;
  const first = (Math.imul(seed, 2654435761) >>> 0) >>> 16,
    index = (first + code + (occurrence || 0)) % entry[sex].length,
    key = `${phone}/${sex}/${index}`;
  if (!tokenArrays.has(key)) {
    const token = entry[sex][index],
      spectrum = Float64Array.from({ length: 513 }, (_, b) => {
        const x = Math.log(Math.max((b * SR) / 1024, 1));
        if (x <= TOKEN_GRID[0]) return 10 ** (token.delta_db[0] / 10);
        let k = 1;
        while (k < TOKEN_GRID.length - 1 && TOKEN_GRID[k] < x) k++;
        if (x >= TOKEN_GRID[k]) return 10 ** (token.delta_db[k] / 10);
        return 10 ** (mix(token.delta_db[k - 1], token.delta_db[k], (x - TOKEN_GRID[k - 1]) / (TOKEN_GRID[k] - TOKEN_GRID[k - 1])) / 10);
      });
    tokenArrays.set(key, { spectrum, gain: 10 ** (token.level_db / 10) });
  }
  return tokenArrays.get(key);
}
const fallbackProfiles = new Map();
function fallbackProfile(phone) {
  if (!fallbackProfiles.has(phone))
    fallbackProfiles.set(
      phone,
      Float64Array.from({ length: 513 }, (_, b) => {
        const f = (b * SR) / 1024;
        const center =
            {
              S: 6500,
              Z: 5500,
              SH: 3300,
              CH: 3500,
              JH: 3100,
              TS: 5800,
              F: 3800,
              V: 2900,
              TH: 3800,
              DH: 2800,
              K: 2600,
              G: 2200,
              T: 4800,
              D: 3800,
              P: 650,
              B: 550,
              HH: 1600,
            }[phone] || 2400,
          width = ["F", "V", "TH", "DH", "HH"].includes(phone)
            ? 1900
            : Math.max(400, center * 0.28);
        let value =
          Math.exp(-0.5 * ((f - center) / width) ** 2) +
          0.08 / (1 + (f / 2000) ** 2);
        if (["DH", "TH"].includes(phone))
          value = (0.3 + (0.7 * f) / (f + 1800)) / (1 + (f / 6500) ** 4);
        else if (["B", "P"].includes(phone))
          value =
            1 / (1 + (f / 1500) ** 2) +
            0.45 * Math.exp(-0.5 * ((f - 700) / 450) ** 2);
        return (value * Math.min(1, (f / 160) ** 2)) / (1 + (f / 10500) ** 8);
      }),
    );
  return fallbackProfiles.get(phone);
}
function nativeFriction(
  power,
  ap,
  t,
  g,
  spec,
  profile,
  voice,
  c,
  f0,
  following = Infinity,
  referencePower = power, referenceAp = ap, seed = 101, phoneVowels = null, levelDb = 0,
) {
  const duration = Math.max(0.005, g.end - g.start),
    local = t - g.start;
  if (t < g.start - 0.012 || t > Math.min(following, g.end + 0.035)) return 0;
  const shape =
      smooth((local + 0.006) / Math.min(0.024, duration * 0.35)) *
      smooth((g.end + 0.014 - t) / Math.min(0.03, duration * 0.45)),
    stop = ["plosive", "affricate"].includes(spec.kind),
    release = g.start + 0.55 * duration;
  let gain;
  if (stop) {
    const closure =
      smooth((local + 0.002) / Math.min(0.01, duration * 0.18)) *
      (1 - smooth((t - release - (spec.voiced ? 0.004 : 0.009)) / 0.03));
    gain = 1 - (spec.voiced ? 0.72 : 0.995) * closure;
  } else if (spec.kind === "nasal") gain = 1 - 0.38 * shape;
  else if (["liquid", "glide", "tap"].includes(spec.kind))
    gain =
      1 -
      (spec.kind === "tap"
        ? 0.75
        : ["L", "LY"].includes(g.phone)
          ? 0.3
          : 0.18) *
        shape;
  else if (g.phone === "DH") gain = 1 - 0.22 * shape;
  else if (g.phone === "V") gain = 1 - 0.35 * shape;
  else gain = 1 - (spec.voiced ? 0.42 : 0.975) * shape;
  const scale =
    (({ bass: 0.88, tenor: 0.95, alto: 1.05, soprano: 1.14 }[voice] || 1) /
      1.14) *
    clamp(1 +
      0.08 * (c.timbre - 0.5) +
      0.09 * (0.5 - c.age) -
      0.025 * (c.weight - 0.5) + .24*sexShift(c) + (c.size>1 ? (.024+.054*c.blend)*tractVariation(seed) : 0),.76,1.28);
  const sonorant = ["nasal", "liquid", "glide", "tap"].includes(spec.kind),
    harmonic = new Float64Array(513),
    noisePower = new Float64Array(513),
    energy = voiceEnergy(referencePower, referenceAp, f0);
  for (let b = 0; b < 513; b++) {
    harmonic[b] = power[b] * (1 - ap[b] ** 2) * gain ** 2;
    noisePower[b] = power[b] * ap[b] ** 2 * gain ** 2;
  }
  if (!sonorant) {
    let pos, gate;
    if (stop) {
      pos = Math.max(0, t - release) + (profile?.release_offset || 0);
      const decay = profile?.noise_times
        ? smooth((profile.noise_times.at(-1) - pos) / 0.01)
        : Math.exp(
            -Math.max(t - release, 0) /
              (spec.kind === "affricate" ? 0.055 : 0.016),
          );
      gate =
        smooth((t - release) / 0.004) *
        decay *
        smooth((g.end + 0.02 - t) / 0.02);
    } else {
      pos =
        clamp(local / duration) * (profile?.noise_times?.at(-1) || duration);
      gate = shape;
    }
    let row = 0,
      blend = 0,
      level =
        {
          S: 0.18,
          Z: 0.11,
          SH: 0.15,
          CH: 0.17,
          JH: 0.12,
          F: 0.12,
          V: 0.1,
          TH: 0.12,
          DH: 0.075,
          P: 0.08,
          B: 0.09,
          K: 0.055,
          G: 0.045,
          T: 0.16,
          D: 0.11,
          HH: 0.19,
        }[g.phone] || 0.1;
    if (profile?.noise_times) {
      row = clamp(
        lowerBound(profile.noise_times, pos) - 1,
        0,
        profile.noise_times.length - 2,
      );
      blend = clamp(
        (pos - profile.noise_times[row]) /
          (profile.noise_times[row + 1] - profile.noise_times[row]),
      );
      level = mix(
        profile.noise_ratio[row],
        profile.noise_ratio[row + 1],
        blend,
      );
      if (["V", "Z", "JH", "B", "G"].includes(g.phone)) level *= 0.65;
      else if (g.phone === "D") level *= 0.85;
      level = Math.min(level, 0.65);
    }
    const spectrum = new Float64Array(513),
      mouthShape = new Float64Array(513);
    let mouthMean = 0,
      total = 0;
    mouthShape.set(gaussian(referencePower, 18, true));
    mouthMean = mouthShape.reduce((s, x) => s + x, 0) / 513;
    const frameScale = roundedScale(scale, phoneVowels),
      token = g.phone === "HH" ? null : consonantToken(g.phone, g.occurrence, seed, isMaleToken(voice, c));
    for (let b = 0; b < 513; b++) {
      const x = clamp(b / frameScale, 0, 512),
        a = Math.floor(x),
        z = Math.min(a + 1, 512),
        w = x - a,
        f = (x * SR) / 1024;
      if (g.phone === "HH") spectrum[b] = referencePower[b];
      else if (profile?.noise_power) {
        spectrum[b] = mix(
          mix(
            profile.noise_power[row * 513 + a],
            profile.noise_power[row * 513 + z],
            w,
          ),
          mix(
            profile.noise_power[(row + 1) * 513 + a],
            profile.noise_power[(row + 1) * 513 + z],
            w,
          ),
          blend,
        );
      } else {
        const fallback = fallbackProfile(g.phone);
        spectrum[b] = mix(fallback[a], fallback[z], w);
      }
      if (g.phone !== "HH")
        spectrum[b] *=
          Math.max(mouthShape[b] / Math.max(mouthMean, 1e-12), 0.015) ** 0.16;
      if (token) spectrum[b] *= token.spectrum[b];
      total += spectrum[b] / 513;
    }
    const projection =
        (0.95 + 0.48 * c.articulation) * (g.phone === "K" ? 1.2 : 1),
      amount = energy * (level * gate * projection) ** 2 * (token ? token.gain : 1),
      colour = g.phone === "HH" ? 0 : (CONSONANT_COLOUR * levelDb * Math.LN10) / 10;
    for (let b = 0; b < 513; b++)
      noisePower[b] +=
        ((amount * spectrum[b]) / Math.max(total, 1e-12)) *
        (colour ? Math.exp(colour * LOUDNESS_COLOUR[b]) : 1);
  }
  for (let b = 0; b < 513; b++) {
    power[b] = Math.max(1e-12, harmonic[b] + noisePower[b]);
    ap[b] = Math.sqrt(clamp(noisePower[b] / power[b], 1e-6, 0.999998));
  }
  return spec.kind === "fricative" && spec.voiced
    ? (g.phone === "DH" ? 0.1 : 0.2) * shape
    : g.phone === "HH"
      ? 0.12 * shape * (1 - shape)
      : 0;
}
export function articulate(
  power,
  ap,
  t,
  gestures,
  mouth,
  inventory,
  voice,
  c,
  f0,
  phoneVowels = null,
  seed = 101,
  levelDb = 0,
) {
  sonorants(power, ap, t, gestures, voice, mouth, inventory, f0, phoneVowels, sexShift(c));
  const referencePower=power.slice(), referenceAp=ap.slice();
  let coupling = 0;
  for (const [i, g] of gestures.entries()) {
    const spec = inventory[g.phone];
    if (!mouth[g.phone] && spec)
      coupling = Math.max(
        coupling,
        nativeFriction(
          power,
          ap,
          t,
          g,
          spec,
          mouth.profiles?.[g.phone],
          voice,
          c,
          f0,
          Infinity, referencePower, referenceAp, seed, phoneVowels, levelDb,
        ),
      );
  }
  const measuredH = new Float64Array(513),
    measuredN = new Float64Array(513),
    harmonicBase = Float64Array.from(power, (p, i) => p * (1 - ap[i] ** 2));
  let coverage = 0;
  for (const [gi, g] of gestures.entries()) {
    if (!mouth[g.phone]) continue;
    const previous=gestures.filter(o=>o!==g&&o.end<=g.start+.001).reduce((a,o)=>Math.max(a,o.end),-Infinity);
    const following=gestures.filter(o=>o!==g&&o.start>=g.end-.001).reduce((a,o)=>Math.min(a,o.start),Infinity);
    const start = Math.max(g.start-.012, previous-.008), end=Math.min(g.end+.03,following+.008);
    if (t < start || t > end) continue;
    const spec = inventory[g.phone];
    if (!spec) continue;
    const duration = Math.max(0.005, g.end - g.start),
      local = t - g.start,
      edge =
        smooth((local + 0.006) / Math.min(0.02, duration * 0.3)) *
        smooth((g.end + 0.018 - t) / 0.025),
      stop = ["plosive", "affricate"].includes(spec.kind),
      measured = MEASURED_RELEASE.has(g.phone) && !spec.voiced && !!mouth?.[g.phone]?.hratio,
      release = g.start + (measured && spec.kind === "affricate" ? 0.40 : 0.55) * duration,
      base = voiceEnergy(harmonicBase, new Float64Array(513), f0);
    let gain;
    if (measured) {
      const closure =
        smooth((local + 0.002) / Math.min(0.01, duration * 0.18)) *
        (1 - smooth((t - g.end + 0.012) / 0.03));
      gain = 1 - 0.995 * closure;
    } else if (stop) {
      const closure =
        smooth((local + 0.002) / Math.min(0.01, duration * 0.18)) *
        (1 - smooth((t - release - (spec.voiced ? 0.004 : 0.009)) / 0.03));
      gain = 1 - (spec.voiced ? 0.72 : 0.995) * closure;
    } else
      gain =
        1 -
        (1 -
          ({ nasal: 0.64, liquid: 0.74, glide: 0.84 }[spec.kind] ??
            (spec.voiced ? 0.78 : 0.025))) *
          edge;
    const u = mouth?.[g.phone],
      scale =
        (({ bass: 0.88, tenor: 0.95, alto: 1.05, soprano: 1.14 }[voice] || 1) /
          1.14) *
        clamp(1 +
          0.08 * (c.timbre - 0.5) +
          0.09 * (0.5 - c.age) -
          0.025 * (c.weight - 0.5) + .24*sexShift(c),.76,1.28);
    let row = 0,
      blend = 0;
    if (u) {
      let pos = clamp(local / duration) * u.duration;
      if (measured) {
        const [r, v] = releaseLandmarks(u);
        pos =
          t < release
            ? (local * r) / Math.max(0.005, release - g.start)
            : t < g.end
              ? r + ((t - release) * (v - r)) / Math.max(g.end - release, 0.005)
              : v + t - g.end;
      } else if (stop) {
        let peak = 0;
        for (let j = 0; j < u.times.length; j++)
          if (
            u.times[j] >= u.duration * 0.15 &&
            u.times[j] <= u.duration &&
            u.ratio[j] > u.ratio[peak]
          )
            peak = j;
        const r = u.times[peak];
        pos =
          t < release
            ? (local * r) / Math.max(0.005, release - g.start)
            : r + t - release;
      }
      row = clamp(lowerBound(u.times, pos) - 1, 0, u.times.length - 2);
      blend = clamp((pos - u.times[row]) / (u.times[row + 1] - u.times[row]));
    }
    const h = new Float64Array(513),
      n = new Float64Array(513),
      shape = new Float64Array(513),
      noiseScale = roundedScale(scale, phoneVowels),
      token = consonantToken(g.phone, g.occurrence, seed, isMaleToken(voice, c)),
      colour = (CONSONANT_COLOUR * levelDb * Math.LN10) / 10;
    let shapeMean = 0;
    for (let b = 0; b < 513; b++) {
      let delta = 0,
        noiseShape = 0;
      const f = (b * SR) / 1024;
      if (u) {
        const x = clamp(b / scale, 0, 512),
          a = Math.floor(x),
          z = Math.min(512, a + 1),
          w = x - a;
        const read = (arr) =>
          mix(
            mix(arr[row * 513 + a], arr[row * 513 + z], w),
            mix(arr[(row + 1) * 513 + a], arr[(row + 1) * 513 + z], w),
            blend,
          );
        delta = read(u.delta) * edge;
        const nx = clamp(b / noiseScale, 0, 512),
          na = Math.floor(nx),
          nz = Math.min(512, na + 1),
          nw = nx - na;
        noiseShape = mix(
          mix(u.noise[row * 513 + na], u.noise[row * 513 + nz], nw),
          mix(u.noise[(row + 1) * 513 + na], u.noise[(row + 1) * 513 + nz], nw),
          blend,
        );
        if (token) noiseShape *= token.spectrum[b];
      } else if (["nasal", "liquid", "glide"].includes(spec.kind)) {
        const target = spec.formants[0] * scale;
        delta =
          edge *
          (1.3 * Math.exp(-0.5 * ((f - target) / 250) ** 2) -
            Math.log1p((f / (spec.kind === "nasal" ? 700 : 2200)) ** 2));
      } else
        noiseShape = Math.exp(
          -0.5 * ((f - (spec.fric_fc || 3500) * scale) / 1500) ** 2,
        );
      h[b] = power[b] * (1 - ap[b] ** 2) * Math.exp(delta);
      n[b] = power[b] * ap[b] ** 2 * gain ** 2;
      shape[b] = Math.max(0, noiseShape);
      shapeMean += shape[b] / 513;
    }
    const he = voiceEnergy(h, new Float64Array(513), f0),
      hGain = (base * gain ** 2) / Math.max(he, 1e-9),
      gate = stop
        ? smooth((t - release) / 0.004) *
          Math.exp(
            -Math.max(0, t - release) /
              (spec.kind === "affricate" ? 0.045 : 0.018),
          )
        : edge,
      projection = (0.85 + 0.4 * c.articulation) ** 2,
      pressure =
        ({
          P: 0.03,
          T: 0.025,
          B: 0.014,
          D: 0.018,
          CH: 0.035,
          SH: 0.026,
          DH: 0.005,
        }[g.phone] || 0.015),
      level = measured
        ? mix(u.ratio[row], u.ratio[row + 1], blend) *
          smooth((t - release + 0.004) / 0.008) * projection
        : pressure * projection * gate ** 2,
      friction = !["nasal", "liquid", "glide", "tap"].includes(spec.kind),
      amount = smooth((t - start) / 0.012) * smooth((end - t) / 0.018);
    for (let b = 0; b < 513; b++) {
      measuredH[b] += h[b] * hGain * amount;
      measuredN[b] +=
        (n[b] +
          (friction
            ? (shape[b] / Math.max(shapeMean, 1e-12)) *
              base *
              level *
              (token ? token.gain : 1) *
              (colour ? Math.exp(colour * LOUDNESS_COLOUR[b]) : 1)
            : 0)) *
        amount;
    }
    coverage += amount;
  }
  if (coverage > 0) {
    const amount = Math.min(1, coverage);
    for (let b = 0; b < 513; b++) {
      const harmonic =
          harmonicBase[b] * (1 - amount) + (measuredH[b] / coverage) * amount,
        noisePower =
          power[b] * ap[b] ** 2 * (1 - amount) +
          (measuredN[b] / coverage) * amount;
      power[b] = Math.max(1e-12, harmonic + noisePower);
      ap[b] = Math.sqrt(clamp(noisePower / power[b], 0.000001, 0.999998));
    }
  }
  return coupling * (1 - Math.min(1, coverage));
}
const VIBRATO_LIMIT=90;
export class PhraseSinger {
  constructor(phrase, part, controls, inventory, mouth, units, index, seed, vibratoCharacter = 1) {
    this.plan = planPhrase(phrase, controls, inventory);
    this.c = controls;
    this.inventory = inventory;
    this.mouth = mouth;
    this.units = units;
    this.index = index;
    this.seed = seed;
    this.voice = part.voice;
    this.frames = new Map();
    const p = this.plan,
      raw = p.raw,
      n = p.n;
    const sample200 = (values, t) => sample(values, t * 2);
    const rng=new NativeRandom(seed);
    const wandering = (period, scale) => {
      const grid = rng.normals(Math.ceil(((n-1)/100+period*2)/period),scale);
      return gaussian(
        Float64Array.from({ length: n }, (_, i) => {
          const x = i / 100 / period, j = Math.floor(x);
          return mix(grid[j], grid[j + 1], x - j);
        }),
        Math.max(0.5, (period / 0.01) * 0.15),
      );
    };
    const timing = wandering(.65,(.003+.022*controls.precision)*(1-1/Math.sqrt(controls.size)));
    const rate=5.35-.5*(controls.age-.5)+rng.uniform(-.45,.45);
    const rateCurve=wandering(1.3,.16),phaseOffset=rng.uniform(0,2*Math.PI);
    const depthCurve=wandering(.8,1),drift=wandering(.55,1+8*controls.tuning);
    const offset=controls.size>1?rng.normal(2+6*controls.tuning):0;
    const shimmer=wandering(.7,.025+.025*controls.blend);
    // Singers differ in how much vibrato they use (stage.js); nobody is pushed
    // past the limit unless the control itself asks for more.
    const character=vibratoCharacter!==1&&controls.vibrato?Math.min(vibratoCharacter,Math.max(1,VIBRATO_LIMIT/(5+62*controls.vibrato**1.3))):1;
    this.baseF0 = new Float64Array(n);
    this.f0 = new Float64Array(n);
    this.mapped = new Float64Array(n);
    this.amp = new Float64Array(n);
    this.calibration = new Float64Array(n);
    let rateSum=0;
    const logF0 = raw.pitch.map(Math.log);
    for (let i = 0; i < n; i++) {
      const t = i / 100,
        mapped = clamp(t + timing[i], 0, (raw.pitch.length - 1) / 200);
      this.mapped[i] = mapped;
      this.baseF0[i] = Math.exp(sample200(logF0, mapped));
      rateSum += rate + rateCurve[i];
      const phase=rateSum*2*Math.PI*.01+phaseOffset;
      const depth = controls.vibrato
        ? (5 + 62 * controls.vibrato ** 1.3) * (1 + 0.12 * depthCurve[i]) * character
        : 0;
      this.f0[i] =
        this.baseF0[i] *
        2 **
          ((depth * Math.sin(phase) * sample200(raw.bloom, mapped) +
            drift[i] +
            offset) /
            1200);
      const gate = +(sample200(raw.gate, t) > 1e-12),
        shimmerGain = Math.exp(shimmer[i]);
      const old = sample200(raw.calibration, mapped);
      // Match native's guarded removal of the vowel-only articulation gate.
      // Its near-zero branch stays silent at complete mouth closures.
      this.amp[i] = (old > 1e-10 ? sample200(raw.amp, mapped) : old) * gate * shimmerGain;
      this.calibration[i] = old * gate * shimmerGain;
    }
    this.vowels = p.raw.vowels.map(v => Float64Array.from(this.mapped, t => sample(v, t*2)));
    this.phoneVowels = p.raw.phoneVowels.map(v => Float64Array.from(this.mapped, t => sample(v, t*2)));
    this.finishTimeline();
  }
  finishTimeline() {
    const p = this.plan;
    this.pitch = new Float64Array(p.n);
    const source = this.units.filter(u => u.vowel === 'a').reduce((a, b) => a.pitch < b.pitch ? a : b);
    for (let i = 0; i < p.n; i++) {
      const motion = readMotion(source, unitCursor(source, i / 100, this.seed));
      this.pitch[i] =
        this.f0[i] *
        2 ** ((clamp(motion, -12, 12) * (0.3 + 0.3 * this.c.tuning) * Math.min(1,this.c.vibrato/.2)) / 1200);
    }
    this.warm = 3 + (this.seed % 13);
    this.phase = Math.floor(new NativeRandom(this.seed+17).uniform(0,SR/this.pitch[0]));
    this.begin = this.warm * 240 + this.phase;
    this.clock = pulseClock(
      Float64Array.from(
        { length: this.pitch.length + this.warm },
        (_, i) => this.pitch[Math.max(0, i - this.warm)],
      ),
    );
    const active = [];
    for (let i = 0; i < p.n; i++)
      if (this.calibration[i] > 0.01) active.push(i);
    let sum = 0,
      total = 0;
    for (let k = 0; k < Math.min(32, active.length); k++) {
      const i =
          active[
            Math.floor(
              (k * (active.length - 1)) /
                Math.max(1, Math.min(32, active.length) - 1),
            )
          ],
        s = this.spectrum(i / 100, false, false),
        weight = this.calibration[i] ** 2;
      sum += voiceEnergy(s.power, s.ap, this.pitch[i]) * weight;
      total += weight;
    }
    this.gain = 0.105 / Math.max(0.01, Math.sqrt(sum / Math.max(total, 1e-9)));
  }
  // Calibration leaves loudness colour out, as the native performer does.
  spectrum(t, articulation = true, colour = true) {
    const p = this.plan,
      mapped = sample(this.mapped, t),
      f0 = sample(this.pitch, t),
      weights = this.phoneVowels.map((v) => sample(v, t)),
      s = sourceSpectrum(
        this.units,
        t,
        sample(this.f0, t),
        weights,
        this.c,
        this.seed,
        this.index,
        colour ? sample(p.raw.levelDb, mapped * 2) : 0,
      );
    if (articulation)
      s.coupling = articulate(
        s.power,
        s.ap,
        mapped,
        p.gestures,
        this.mouth,
        this.inventory,
        this.voice,
        this.c,
        f0,
        this.phoneVowels.map((v) => sample(v, t)),
        this.seed,
        colour ? sample(p.raw.levelDb, mapped * 2) : 0,
      );
    return s;
  }
  // `seat` adds this singer into a planar stereo buffer at their place in the
  // section. The window's padding (64 samples, 20 of them the resampler's)
  // holds the earlier audio a delayed channel reads.
  render48(start, end, taps, seat = null, stereo = null, scale = 1) {
    const a = Math.round(start * 48000),
      b = Math.round(end * 48000),
      lo = Math.floor(a / 2) - 32,
      hi = Math.ceil(b / 2) + 32;
    const raw = this.render(lo / 24000, hi / 24000, false);
    if (seat) {
      const frames = b - a,
        reach = Math.max(seat.delayLeft, seat.delayRight),
        filtered = new Float64Array(frames + reach);
      for (let i = 0; i < filtered.length; i++) {
        const n = a + i - reach - 2 * lo;
        let value = 0;
        for (let j = n % 2; j < taps.length; j += 2) {
          const k = (n + 20 - j) / 2;
          if (k >= 0 && k < raw.length) value += raw[k] * taps[j];
        }
        filtered[i] = value;
      }
      for (let i = 0; i < frames; i++) {
        const level = sample(this.amp, (a + i) / 48000 - this.plan.origin) * this.gain * scale;
        stereo[i] += filtered[i + reach - seat.delayLeft] * level * seat.left;
        stereo[frames + i] += filtered[i + reach - seat.delayRight] * level * seat.right;
      }
      return stereo;
    }
    const out = new Float64Array(b - a);
    for (let i = 0; i < out.length; i++) {
      const n = a + i - 2 * lo;
      let value = 0;
      for (let j = n % 2; j < taps.length; j += 2) {
        const k = (n + 20 - j) / 2;
        if (k >= 0 && k < raw.length) value += raw[k] * taps[j];
      }
      out[i] =
        value *
        sample(this.amp, (a + i) / 48000 - this.plan.origin) *
        this.gain;
    }
    return out;
  }
  render(start, end, applyAmplitude = true) {
    const p = this.plan,
      a = Math.round((start - p.origin) * SR),
      b = a + Math.round((end - start) * SR);
    if (b <= 0 || a >= p.n * 240) return new Float64Array(b - a);
    const first = Math.max(
        -this.warm,
        Math.floor((a + this.phase - 1024) / 240),
      ),
      last = Math.min(p.n - 1, Math.ceil((b + this.phase + 1024) / 240)),
      frames = [];
    const frameIndices = [];
    for (let k = first; k <= last; k++) {
      const mapped = sample(this.mapped, k / 100),
        halfMapped = sample(this.mapped, (k + 0.5) / 100);
      const detailed = p.gestures.some(
        (g) => mapped >= g.start - 0.08 - 1e-9 && mapped <= g.end + 0.1 + 1e-9,
      );
      if ((k + this.warm) % 2 === 0 || detailed || k === first || k === last)
        frameIndices.push(k);
      if (
        k < last &&
        p.gestures.some(
          (g) => halfMapped >= g.start - 0.015 - 1e-9 && halfMapped <= g.end + 0.04 + 1e-9,
        )
      )
        frameIndices.push(k + 0.5);
    }
    const missing = frameIndices.filter((k) => !this.frames.has(k));
    const spectra = missing.map((k) => this.spectrum(Math.max(0, k / 100)));
    const prepared = filterBatch(spectra, filters);
    missing.forEach((k, i) =>
      this.frames.set(k, {
        center: (k + this.warm) * 240,
        coupling: spectra[i].coupling || 0,
        ...prepared[i],
      }),
    );
    for (const k of frameIndices) frames.push(this.frames.get(k));
    const audio = synthesizeWindow(
      this.clock,
      frames,
      a + this.begin,
      b + this.begin,
      this.seed,
    );
    if (applyAmplitude)
      for (let i = 0; i < audio.length; i++)
        audio[i] *= sample(this.amp, (a + i) / SR) * this.gain;
    // Fixed support and absolute frame grids, never window-dependent edge frames.
    for (const key of this.frames.keys())
      if (key < first - 8 || key > last + 8) this.frames.delete(key);
    return audio;
  }
}

export function centerEnsemble(actors, size) {
  if (size <= actors.length || !actors.length) return;
  const factor = 1 - Math.sqrt(actors.length / size);
  for (let k = 0; k < actors[0].f0.length; k++) {
    const center =
      (actors.reduce((sum, a) => sum + Math.log(a.f0[k] / a.baseF0[k]), 0) /
        actors.length) *
      factor;
    for (const a of actors) a.f0[k] /= Math.exp(center);
  }
  for (const a of actors) a.finishTimeline();
}
