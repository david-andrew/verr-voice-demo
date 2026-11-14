// Port of synth/performance.py: 200 Hz score-led mouth/pitch/phrase controls.
import { clamp, smooth } from "./dsp.js";
import { NOTE_POINTS } from "./score-dynamics.js";
import { TARGETS } from "./vowel-models.js";
// A note's level at phrase time t: the score's dynamic curve followed through it.
// Written dynamics to level, pivoting on an unmarked score's .76 (native performance.py).
const UNMARKED = 0.76, RANGE_LAW = 2.7, UNMARKED_LEVEL = UNMARKED ** 1.35;
const level = (dynamic) => UNMARKED_LEVEL * (dynamic / UNMARKED) ** RANGE_LAW;
export function noteLoudness(e, t) {
  if (!e.dynamics) return level(clamp(e.dynamic));
  if (Array.isArray(e.dynamics[0])) {
    const x=(t-e.start)/Math.max(e.duration,1e-9),p=e.dynamics;
    let i=0;while(i<p.length-2&&p[i+1][0]<=x)i++;
    const a=clamp((x-p[i][0])/Math.max(p[i+1][0]-p[i][0],1e-9));
    return level(clamp(p[i][2]+a*(p[i+1][1]-p[i][2])));
  }
  // Compatibility for older callers that supplied five interior samples.
  const x = (t - e.start) / Math.max(e.duration, 1e-9), p = NOTE_POINTS;
  if (x <= p[0]) return level(clamp(e.dynamics[0]));
  if (x >= p[4]) return level(clamp(e.dynamics[4]));
  const i = Math.min(3, Math.floor((x - p[0]) / (p[1] - p[0])));
  return level(clamp(e.dynamics[i] + ((x - p[i]) / (p[i + 1] - p[i])) * (e.dynamics[i + 1] - e.dynamics[i])));
}
export const VOWELS = [
  "AA",
  "AE",
  "AH",
  "AO",
  "EH",
  "ER",
  "IH",
  "IY",
  "UH",
  "UW",
  "AX",
  "A", // open front [a]; only through vowel changes (VV-VOWEL-SPACE)
  "I", // cardinal close [i] (VV-VOWEL-CORNERS)
  "U", // cardinal close back [u] (VV-VOWEL-CORNERS)
  "E", // close-mid [e] (VV-VOWEL-CORNERS)
  "O", // close-mid back [o] (VV-VOWEL-CORNERS)
  "Q", // cardinal open back [ɑ] (VV-VOWEL-BLEND)
  "OH", // cardinal open-mid back [ɔ] (VV-VOWEL-BLEND)
  "A6", // near-open central [ɐ] (VV-A6)
  "OQ", // open back rounded [ɒ] (VV-OQ)
];
const CARDINAL = {
  A: [0.8, 0.2, 0, 0, 0],
  I: [0, 0, 1, 0, 0],
  U: [0, 0, 0, 0, 1],
  E: [0, 1, 0, 0, 0],
  O: [0, 0, 0, 1, 0],
  Q: [1, 0, 0, 0, 0],
  OH: [0, 0, 0, 1, 0],
  A6: [0.6, 0.25, 0, 0, 0.15],
  OQ: [0.5, 0, 0, 0.5, 0],
  AA: [1, 0, 0, 0, 0],
  AE: [0.6, 0.4, 0, 0, 0],
  AH: [0.65, 0, 0, 0, 0.35],
  AX: [0.35, 0.3, 0, 0, 0.35],
  AO: [0, 0, 0, 1, 0],
  EH: [0, 1, 0, 0, 0],
  ER: [0.15, 0.5, 0, 0.35, 0],
  IH: [0, 0.28, 0.72, 0, 0],
  IY: [0, 0, 1, 0, 0],
  UH: [0, 0, 0, 0.3, 0.7],
  UW: [0, 0, 0, 0, 1],
};
const DIP = {
  AY: ["AA", "IH"],
  EY: ["E", "IH"], // starts on close-mid [e] (mirrors performance.DIPHTHONGS)
  OW: ["AO", "UH"],
  AW: ["AA", "UH"],
  OY: ["AO", "IH"],
};
const kernels = new Map();
function heldLevelDb(amplitude) {
  let held = amplitude.find((x) => x > 0) ?? UNMARKED_LEVEL;
  return Float64Array.from(amplitude, (x) => {
    if (x > 0) held = x;
    return 20 * Math.log10(held / UNMARKED_LEVEL);
  });
}
export function gaussian(values, sigma, reflect = false) {
  if (sigma < 1e-8) return values.slice();
  const radius = Math.floor(4 * sigma + 0.5),
    key = String(sigma);
  let weights = kernels.get(key);
  if (!weights) {
    weights = Float64Array.from({ length: radius * 2 + 1 }, (_, i) =>
      Math.exp(-0.5 * ((i - radius) / sigma) ** 2),
    );
    const sum = weights.reduce((a, b) => a + b, 0);
    weights = weights.map((x) => x / sum);
    kernels.set(key, weights);
  }
  const n = values.length,
    out = new Float64Array(n);
  // Only edge windows need extension. Keep tap order unchanged so this fast
  // interior path is bit-identical (also for reflected and very short inputs).
  const interiorEnd = Math.max(radius, n - radius);
  for (let i = radius; i < n - radius; i++) {
    let sum = 0;
    for (let j = -radius; j <= radius; j++)
      sum += values[i + j] * weights[j + radius];
    out[i] = sum;
  }
  for (let i = 0; i < n; i++) {
    if (i === radius) i = interiorEnd;
    if (i >= n) break;
    for (let j = -radius; j <= radius; j++) {
      let k = i + j;
      if (reflect) {
        k = ((k % (2 * n)) + 2 * n) % (2 * n);
        if (k >= n) k = 2 * n - k - 1;
      } else k = clamp(k, 0, n - 1);
      out[i] += values[k] * weights[j + radius];
    }
  }
  return out;
}
// Vowel unity (VV-VOWEL-UNITY): mirrors synth/vowel_unity.py.
const UNITY_CENTRE = 1500, UNITY_FULL_PULL = 0.886,
  UNITY_PARTNERS = { AE: "AH", EH: "OH", IH: "O", IY: "O", A: "Q", I: "U", E: "O" },
  UNITY_GLIDE_ONLY = new Set(),  // plain [ɪ] unified too: it must stay darker than unified [i]
  bark = (f) => (26.81 * f) / (1960 + f) - 0.53,
  unbark = (z) => (1960 * (z + 0.53)) / (26.28 - z);
export function unityWeights(phone, amount, glide = false) {
  const partner = UNITY_PARTNERS[phone];
  if (!partner || !(amount > 0) || (UNITY_GLIDE_ONLY.has(phone) && !glide)) return null;
  const f2 = TARGETS[phone][1], g2 = TARGETS[partner][1],
    pull = UNITY_FULL_PULL * Math.min(1, amount),
    goal = unbark(bark(f2) - pull * (bark(f2) - bark(UNITY_CENTRE))),
    w = (f2 - goal) / (f2 - g2);
  return { [phone]: 1 - w, [partner]: w };
}
// [ɛ] openness (VV-VOWEL-OPEN): mirrors default_weights in synth/vowel_unity.py.
// "Every vowel as written" (amount 0) sings [ɛ] unopened; full opening from 0.3.
// Plain [ɛ]/[i] (12 Nov) and [æ] (13 Nov) sing Matt's chosen blends. Keep
// unity's as-written endpoint; never re-apply unity to a chosen blend's parts.
const CHOSEN_TARGET = {
  EH: { AE: 0.5991, AA: 0.2349, A: 0.166 },
  IY: { I: 0.7402, U: 0.2598 },
  AE: { A: 0.4116465814958243, AE: 0.35291123211202396, ER: 0.23544218639215175 },
}, OPEN_FULL_AT = 0.3;
// Arrival overshoot in cents for an upward move of `rise` semitones (mirrors performance.overshoot_cents).
export function overshootCents(rise) {
  if (rise < 1.5) return 0;
  const xs = [1, 2, 3, 5, 8], ys = [0, 10, 20, 20, 40];
  if (rise >= 8) return 40;
  let j = 0; while (rise > xs[j + 1]) j++;
  return ys[j] + (ys[j + 1] - ys[j]) * (rise - xs[j]) / (xs[j + 1] - xs[j]);
}
export function defaultWeights(phone, amount, glide = false, start = false) {
  const unified = unityWeights(phone, amount, glide), target = CHOSEN_TARGET[phone],
    weight = Math.min(1, Math.max(0, amount) / OPEN_FULL_AT);
  if (!target || glide || start || !(weight > 0)) return unified;
  const out = {};
  for (const [k, v] of Object.entries(unified || { [phone]: 1 })) out[k] = v * (1 - weight);
  for (const [k, v] of Object.entries(target)) out[k] = (out[k] || 0) + v * weight;
  for (const k of Object.keys(out)) if (!(out[k] > 0)) delete out[k];
  return out;
}
// The vowel mapping a lyric note carries into its melisma and into the next
// phrase: its fixes, or exactness for IPA; mirrors performance.note_mapping.
export const noteMapping = (e) => e.phones?.vowelMap || {};
function vowelRow(phone, mapping, unity, glide = false, start = false) {
  const row = new Array(VOWELS.length).fill(0);
  let unified;
  if (mapping && mapping[phone]) for (const [name, weight] of Object.entries(mapping[phone])) row[VOWELS.indexOf(name)] = weight;
  else if (!mapping?._exact && (unified = defaultWeights(phone, unity, glide, start)))
    for (const [name, weight] of Object.entries(unified)) row[VOWELS.indexOf(name)] = weight;
  else row[VOWELS.indexOf(phone)] = 1;
  return row;
}
export function planPhrase(phrase, c, inventory) {
  const unity = c.vowel_unity ?? 0.5;
  const origin =
    phrase.origin ?? Math.max(0, Math.floor((phrase.start - 0.26) * 100 + 1e-9) / 100);
  const duration = phrase.end - origin,
    n = Math.ceil((duration + 0.18) * 200) + 1;
  const midi = new Float64Array(n).fill(60), overshoot = new Float64Array(n),
    amplitude = new Float64Array(n),
    gate = new Float64Array(n),
    bloom = new Float64Array(n),
    edgeGain = new Float64Array(n).fill(1);
  const vowels = VOWELS.map(() => new Float64Array(n));
  vowels[0].fill(1);
  const events = phrase.events
    .filter((e) => e.midi != null && e.duration > 0)
    .map((e) => ({ ...e, start: e.start - origin }))
    .sort((a, b) => a.start - b.start);
  const constrained = events.some(e => e.timing && Object.keys(e.timing).length);
  let previous = phrase.initial || ["AA"],
    // A phrase that opens on a lyricless continuation keeps its word's mapping.
    previousMap = phrase.initialMap || {},
    pending = [],
    phraseStart = 0,
    lastEnd = -1,
    lastBreath = true;
  const ranges = [],
    articulations = [],
    gestures = [],
    counted = new Map(),
    occurrences = (phone) => {
      const count = counted.get(phone) || 0;
      counted.set(phone, count + 1);
      return count;
    };
  for (let i = 0; i < events.length; i++) {
    const e = events[i],
      start = e.start,
      end = start + e.duration,
      attack = lastBreath || start - lastEnd > 0.025;
    if (attack) {
      phraseStart = start;
      ranges.push([start, end]);
    } else ranges.at(-1)[1] = end;
    const next = events[i + 1],
      connected = !!next && Math.abs(next.start - end) < 0.025 && !e.breath,
      melisma = connected && !next.lyric;
    const syll = e.lyric ? e.phones : null;
    // A piece-wide vowel fix replaces the one-hot vowel; mirrors plan_performance.
    const mapping = e.lyric ? noteMapping(e) : previousMap;
    previousMap = mapping;
    let nuclei = syll?.nucleus?.length ? syll.nucleus : previous;
    if (nuclei.length === 1) nuclei = DIP[nuclei[0]] || nuclei;
    const onset = syll?.onset || [];
    let coda = syll ? syll.coda || [] : pending;
    if (melisma) {
      pending = coda;
      coda = [];
    } else pending = [];
    previous = nuclei;
    const primary = VOWELS.includes(nuclei[0]) ? nuclei[0] : "AA",
      secondary = VOWELS.includes(nuclei.at(-1)) ? nuclei.at(-1) : primary,
      primaryRow = vowelRow(primary, mapping, unity, false, secondary !== primary);
    for (let k = 0; k < n; k++)
      if (k / 200 >= start - 1e-9 && k / 200 < end - 1e-9) {
        midi[k] = e.midi;
        amplitude[k] = noteLoudness(e, k / 200);
        gate[k] = 1;
        bloom[k] = smooth((k / 200 - phraseStart - 0.14) / 0.32);
        for (let j = 0; j < VOWELS.length; j++)
          vowels[j][k] = primaryRow[j];
      }
    function lengths(phones, budget) {
      const register = clamp((e.midi - 57) / 19);
      let result = phones.map((phone,phoneIndex) => {
        const spec = inventory[phone];
        let d = spec?.target_dur || 0.05;
        if (["nasal", "liquid", "glide"].includes(spec?.kind))
          d = Math.max(d, (phone === "RN" ? 0.074 : 0.085) + 0.025 * register);
        else if (["DH", "TH", "V"].includes(phone))
          d = Math.max(d, 0.078 + 0.012 * register);
        else if (["B", "D"].includes(phone))
          d = Math.max(d, 0.064 + 0.008 * register);
        else if (['K','G'].includes(phone) && ['R','RN'].includes(phones[phoneIndex+1])) d*=.78;
        else if (phone === "P") d = Math.max(d, 0.11);
        // Closure plus audible /ʃ/ frication before the vowel.
        else if (phone === "CH") d = Math.max(d, 0.14);
        else if (phone === "HH") d = Math.max(d, 0.07);
        return [phone, d * (0.85 + 0.35 * c.articulation)];
      });
      const factor = Math.min(
        1,
        budget /
          Math.max(
            1e-9,
            result.reduce((sum, x) => sum + x[1], 0),
          ),
      );
      let out = result.map(([p, d]) => [p, d * factor]);
      // An [ɹ] squeezed under ~45 ms is heard as a tap [ɾ]: keep its floor (mirrors plan_performance).
      const j = phones.indexOf("RN");
      if (j >= 0 && phones.length > 1) {
        const total = out.reduce((s, x) => s + x[1], 0), floor = Math.min(0.045, total * 0.65);
        if (out[j][1] < floor) {
          const others = total - out[j][1];
          out = out.map(([p, d], k) => [p, k === j ? floor : d * Math.max(total - floor, 0) / Math.max(others, 1e-9)]);
        }
      }
      return out;
    }
    // Timing workshop: stretch (scale) or delete each consonant (mirrors plan_performance).
    function edited(list, side) {
      const edits = e.timing?.[side] || [];
      return list.flatMap(([p, d], k) => {const length=d*(edits[k]?.scale??1);return edits[k]?.delete||length<=1e-9?[]:[[p,length,k]];});
    }
    const available=attack ? (i===0?start:Math.max(0,start-lastEnd+(lastBreath?Math.min(.07,events[i-1].duration*.12):0))) : Infinity;
    let on = edited(lengths(
      onset,
      Math.min(
        0.24,
        e.duration * 0.32,
        attack ? (available>1e-6?available:Infinity) : events[i - 1].duration * 0.32,
      ),
    ), "onset");
    // Moving the onset cluster moves where the vowel begins.
    let begin = Math.max(0, (!attack || available>1e-6 ? Math.max(0,start-on.reduce((sum,x)=>sum+x[1],0)) : start) + (e.timing?.lead || 0)),
      spokenEnd = end - (e.breath ? Math.min(0.07, e.duration * 0.12) : 0);
    if(constrained){
      if(next)spokenEnd=Math.min(spokenEnd,next.start);
      const nucleus=Math.min(.03,Math.max(0,spokenEnd-start)*.25),prev=articulations.at(-1);
      const lower=!prev?0:attack?prev.end:Math.max(prev.e.start,prev.begin+prev.on.reduce((s,x)=>s+x[1],0))+Math.min(.03,prev.e.duration*.25);
      const latest=Math.max(start,spokenEnd-nucleus);
      begin=Math.min(latest,Math.max(Math.min(lower,latest),begin));
      const total=on.reduce((s,x)=>s+x[1],0);
      if(total>latest-begin){const scale=Math.max(0,latest-begin)/Math.max(total,1e-9);on=on.map(([p,d,k])=>[p,d*scale,k]).filter(x=>x[1]>1e-9);}
    }

    if(attack&&begin<start){ranges.at(-1)[0]=begin;for(let k=0;k<n;k++)if(k/200>=begin-1e-9&&k/200<start-1e-9){midi[k]=e.midi;amplitude[k]=noteLoudness(e,k/200);gate[k]=1;vowels.forEach((v,j)=>v[k]=primaryRow[j]);}}
    articulations.push({
      mapping,
      begin,
      on,
      co: edited(lengths(coda, Math.min(0.22, e.duration * 0.3)), "coda"),
      end: spokenEnd,
      connected,
      e,
      primary,
      secondary,
      melisma,
    });
    if (e.breath) ranges.at(-1)[1] = spokenEnd;
    lastEnd = end;
    lastBreath = e.breath;
  }
  let previousCoda = [];
  const notes = [];
  for (let i = 0; i < articulations.length; i++) {
    const a = articulations[i];
    let cursor = a.begin, scoop = null;
    const placed = [], placedIndices = [], codaIndices = [], amount = a.e.timing?.scoop?.amount ?? 1;
    const requestedSpan=a.e.timing?.scoop?.length??1;
    let span=constrained?Math.min(requestedSpan,Math.max(.001,(a.end-a.e.start)/.2)):requestedSpan;
    const writtenOnset=a.e.phones?.onset||[], english=(a.e.pronunciation?.language||a.e.language||phrase.language)==='english', onsetId=a.e.id||String(i);
    for (const [phone, d, index] of a.on) {
      gestures.push({
        phone,
        start: cursor,
        end: cursor + d,
        dynamic: a.e.dynamic,
        occurrence: occurrences(phone),
        onset_id: onsetId,
        aspirated: english && ['P','T','K'].includes(phone) && ['RN','L','W'].includes(writtenOnset[index+1]) && writtenOnset[index-1]!=='S',
      });
      placed.push(gestures.at(-1)); placedIndices.push(index);
      cursor += d;
    }
    const movedStart=!!a.e.timing?.lead;
    const vowelStart=movedStart?cursor:Math.max(cursor,a.e.start);
    if(movedStart&&vowelStart<a.e.start)for(let k=0;k<n;k++)if(k/200>=vowelStart-1e-9&&k/200<a.e.start-1e-9){
      midi[k]=a.e.midi;amplitude[k]=noteLoudness(a.e,k/200);
      const row=vowelRow(a.primary,a.mapping,unity,false,a.secondary!==a.primary);vowels.forEach((v,j)=>v[k]=row[j]);
    }
    if (a.on.length && a.begin < a.e.start)
      for (let k = 0; k < n; k++)
        if (k / 200 >= a.begin - 1e-9 && k / 200 < a.e.start - 1e-9) {
          const toward = smooth(
            (k / 200 - a.begin - 0.01) /
              Math.min(0.035, (cursor - a.begin) * 0.35),
          );
          for (const v of vowels) v[k] *= 1 - toward;
          const row = vowelRow(a.primary, a.mapping, unity, false, a.secondary !== a.primary);
          vowels.forEach((v, j) => (v[k] += toward * row[j]));
        }
    // Pitch changes in the voiceless part of the inter-vowel consonants
    // (previous coda + this onset); all-voiced clusters keep it at the vowel.
    // Mirrors plan_performance (VV-SCOOPS).
    const runs = [];
    let wasVoiceless = false;
    for (const g of [...previousCoda, ...placed.filter((g) => g.end <= a.e.start + 1e-9)]) {
      const spec = inventory[g.phone], voiceless = !!spec && !spec.voiced;
      if (voiceless) wasVoiceless ? runs.at(-1).push(g) : runs.push([g]);
      wasVoiceless = voiceless;
    }
    let step = a.e.start;
    if (runs.length) {
      const run = runs.at(-1);
      step = 0.5 * (run[0].start + run.at(-1).end);
      if (step < a.e.start)
        for (let k = 0; k < n; k++)
          if (k / 200 >= step - 1e-9 && k / 200 < a.e.start - 1e-9) midi[k] = a.e.midi;
    }
    // Land moves across consonants as the reference singer does; mirrors
    // plan_performance (VV-SCOOPS candidate 3).
    const previous = i ? articulations[i - 1] : null;
    const cluster = [...previousCoda, ...placed.filter((g) => g.end <= a.e.start + 1e-9)];
    if (previous && previous.connected && cluster.length) {
      const rise = a.e.midi - previous.e.midi, v = movedStart?vowelStart:a.e.start;
      if(constrained)span=Math.min(span,Math.max(.001,(a.end-v)/.2));
      if (rise >= 3) {
        const voicedFrom = runs.length ? runs.at(-1).at(-1).end : cluster[0].start;
        if (voicedFrom < v - 0.02)
          for (let k = 0; k < n; k++) {
            const t = k / 200;
            if (runs.length && t >= step - 1e-9 && t < voicedFrom - 1e-9) midi[k] = a.e.midi - 0.5 * amount;
            if (t >= voicedFrom - 1e-9 && t < v - 1e-9) midi[k] = a.e.midi - 0.5 * amount * (1 - (t - voicedFrom) / (v - voicedFrom));
          }
        if (voicedFrom < v - 0.02) scoop = { start: voicedFrom, depth: 0.5 * amount };
      }
      // A scoop's amount scales its depth and overshoot; its length the overshoot's duration.
      // Overshoot sized by the rise, kept apart so each singer varies it (mirrors performance.py).
      const size = overshootCents(rise) * amount;
      if (size > 0) {
        const dur = (0.12 + 0.08 * Math.min(1, Math.max(0, (rise - 2) / 6))) * span, up = 0.3 * dur;
        for (let k = 0; k < n; k++) {
          const t = k / 200 - v;
          if (t >= -1e-9 && t < dur - 1e-9 && k / 200 < v + a.e.duration - 1e-9)
            overshoot[k] += size / 100 * (t < up ? 0.5 - 0.5 * Math.cos(Math.PI * t / up) : 0.5 + 0.5 * Math.cos(Math.PI * (t - up) / (dur - up)));
        }
        scoop = { ...(scoop || { start: v, depth: 0 }), end: v + dur, overshoot: size / 100, amount, length: span };
      }
    }
    const finish = a.connected
      ? Math.min(a.end, articulations[i + 1].begin)
      : a.end;
    const earliest = Math.max(cursor, a.e.start) + a.e.duration * 0.25,
      length = a.co.reduce((s, p) => s + p[1], 0),
      factor0 = Math.min(
        1,
        Math.max(0, finish - earliest) / Math.max(length, 1e-9),
      );
    let factor=factor0;
    cursor = finish - length * factor;
    // Moving the coda cluster moves where the vowel ends.
    if (a.e.timing?.release) cursor = Math.max(vowelStart, cursor + a.e.timing.release);
    if(constrained){
      const minimum=Math.min(.03,Math.max(0,finish-vowelStart));
      cursor=Math.min(finish,Math.max(vowelStart+minimum,cursor));
      factor=Math.min(factor,Math.max(0,finish-cursor)/Math.max(length,1e-9));
    }
    const vowelEnd = cursor;
    const edgeEdit=a.e.timing||{};
    if(edgeEdit.lead||edgeEdit.release){
      const fade=Math.min(.02,Math.max(1e-6,(vowelEnd-vowelStart)/3));
      for(let k=0;k<n;k++){const t=k/200;if(t<Math.min(a.begin,a.e.start)-1e-9||t>=finish-1e-9)continue;
        edgeGain[k]*=(edgeEdit.lead?smooth((t-vowelStart)/fade):1)*(edgeEdit.release?smooth((vowelEnd-t)/fade):1);}
    }
    let turn = null;
    if (a.primary !== a.secondary && !a.melisma) {
      const available = Math.max(0.001, cursor - vowelStart);
      // Timing workshop: the turn's window can be moved (shift) and stretched (scale).
      let turnStart = cursor - Math.min(0.16, available * 0.24) + (a.e.timing?.turn?.shift || 0),
        turnLength = Math.min(0.12, available * 0.18) * (a.e.timing?.turn?.scale ?? 1);
      if(constrained){turnLength=Math.min(turnLength,Math.max(1e-6,cursor-vowelStart));turnStart=Math.max(vowelStart,Math.min(turnStart,cursor-turnLength));}
      turn = [turnStart, turnStart + turnLength];
      for (let k = 0; k < n; k++)
        if (k / 200 >= (movedStart?vowelStart:a.e.start) - 1e-9 && k / 200 < a.e.start + a.e.duration - 1e-9) {
          const glide = smooth((k / 200 - turnStart) / turnLength);
          const from = vowelRow(a.primary, a.mapping, unity, false, a.secondary !== a.primary), to = vowelRow(a.secondary, a.mapping, unity, a.secondary !== a.primary);
          vowels.forEach((v, j) => (v[k] = (1 - glide) * from[j] + glide * to[j]));
        }
    }
    const placedCoda = [];
    for (const [phone, d, index] of a.co)
      if (d * factor > 1e-6) {
        gestures.push({
          phone,
          start: cursor,
          end: cursor + d * factor,
          dynamic: a.e.dynamic,
          occurrence: occurrences(phone),
        });
        placedCoda.push(gestures.at(-1)); codaIndices.push(index);
        cursor += d * factor;
      }
    previousCoda = a.connected ? placedCoda : [];
    const g = (gs, indices) => gs.map((x, k) => ({ phone: x.phone, start: x.start + origin, end: x.end + origin, index: indices[k] }));
    notes.push({ id: a.e.id, start: a.e.start + origin, end: a.e.start + a.e.duration + origin, midi: a.e.midi, lyric: a.e.lyric || "",
      onset: g(placed, placedIndices), coda: g(placedCoda, codaIndices), vowel: [vowelStart + origin, vowelEnd + origin], turn: turn && [turn[0] + origin, turn[1] + origin],
      scoop: scoop && { ...scoop, start: scoop.start + origin, ...(scoop.end != null ? { end: scoop.end + origin } : {}) } });
  }
  const first = gate.findIndex((x) => x > 0);
  let previousIndex = first;
  if (first >= 0)
    for (let k = 0; k < n; k++) {
      if (gate[k]) previousIndex = k;
      midi[k] = midi[previousIndex];
      for (const v of vowels) v[k] = v[previousIndex];
    }
  const pitch = gaussian(
    midi,
    (0.014 + 0.018 * (1 - c.articulation)) * 200,
  ).map((x) => 440 * 2 ** ((x - 69) / 12));
  const colors = vowels.map((v) =>
      gaussian(v, (0.018 + 0.016 * (1 - c.articulation)) * 200),
    ),
    // The level the singers are working at, held across rests, for loudness colour.
    levelDb = gaussian(heldLevelDb(amplitude), 3.6),
    amp = gaussian(amplitude, 3.6),
    voiceGate = new Float64Array(n).fill(1);
  gate.fill(0);
  for (const [start, end] of ranges) {
    const attack = Math.min(0.055, Math.max(0.012, (end - start) * 0.12));
    let release = Math.min(0.085, Math.max(0.015, (end - start) * 0.15));
    if (gestures.some((g) => Math.abs(g.end - end) < 0.006))
      release = Math.min(release, 0.018);
    for (let k = 0; k < n; k++)
      gate[k] = Math.max(
        gate[k],
        smooth((k / 200 - start) / attack) * smooth((end - k / 200) / release),
      );
  }
  for (const g of gestures) {
    const spec = inventory[g.phone];
    if (!spec) continue;
    for (let k = 0; k < n; k++) {
      const local = (k / 200 - g.start) / Math.max(g.end - g.start, 0.001),
        shape = smooth(local / 0.25) * smooth((1 - local) / 0.3);
      if (spec.kind === "nasal") voiceGate[k] *= 1 - 0.35 * shape;
      else if (["liquid", "glide", "tap"].includes(spec.kind))
        voiceGate[k] *= 1 - (spec.kind === "tap" ? 0.8 : 0.22) * shape;
      else if (["plosive", "affricate"].includes(spec.kind))
        voiceGate[k] *=
          1 -
          (spec.voiced ? 0.83 : 0.98) *
            smooth(local / 0.12) *
            smooth((0.88 - local) / 0.25);
      else if (!spec.voiced) voiceGate[k] *= 1 - 0.88 * shape;
      else if (spec.kind === "fricative") voiceGate[k] *= 1 - 0.62 * shape;
    }
  }
  const vg = gaussian(
    voiceGate,
    (0.002 + 0.004 * c.precision * (1 - 1 / Math.sqrt(c.size))) * 200,
  );
  const phraseAmp = amp.map((x, k) => x * gate[k]),
    calibration = phraseAmp.map((x, k) => x * vg[k]);
  if (phrase.vowelWeights) {
    const weights=VOWELS.map(v=>phrase.vowelWeights[v] || 0), total=weights.reduce((a,b)=>a+b,0);
    if(!weights.every(v=>Number.isFinite(v)&&v>=0)||!Number.isFinite(total)||total<=0)throw Error('Invalid vowel weights');
    colors.forEach((v,i)=>v.fill(weights[i]/total));
  }
  const cardinal = Array.from({ length: 5 }, (_, j) =>
    Float64Array.from({ length: n }, (_, k) =>
      colors.reduce((sum, v, i) => sum + v[k] * CARDINAL[VOWELS[i]][j], 0),
    ),
  );
  if(edgeGain.some(x=>x<1)){
    for(const g of gestures)for(let k=0;k<n;k++){const t=k/200;
      const air=smooth((t-g.start+.012)/.012)*smooth((g.end+.03-t)/.03);edgeGain[k]=Math.max(edgeGain[k],air);}
    for(let k=0;k<n;k++){phraseAmp[k]*=edgeGain[k];calibration[k]*=edgeGain[k];}
  }
  // Performer clocks run at 100 Hz; retain 200 Hz plans for time-warp interpolation.
  return {
    origin,
    n: Math.ceil(n / 2),
    pitch: Float64Array.from(
      { length: Math.ceil(n / 2) },
      (_, i) => pitch[i * 2],
    ),
    amp: Float64Array.from(
      { length: Math.ceil(n / 2) },
      (_, i) => phraseAmp[i * 2],
    ),
    vowels: cardinal.map((v) =>
      Float64Array.from({ length: Math.ceil(n / 2) }, (_, i) => v[i * 2]),
    ),
    gestures,
    notes,
    raw: {
      levelDb,
      pitch,
      overshoot,
      amp: phraseAmp,
      calibration,
      vowels: cardinal,
      phoneVowels: colors,
      gate,
      bloom,
    },
  };
}
