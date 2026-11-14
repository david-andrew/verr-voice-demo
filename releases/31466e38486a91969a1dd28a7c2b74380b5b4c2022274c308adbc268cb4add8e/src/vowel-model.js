/** Measured spectral-envelope registration; matches sample_bank/vowel_model.py. */
import { PROFILES, TARGETS, FEMALE_FRONT, EH_RISE, RECORDED_KERNEL_SEMITONES, RECORDED_BUMP_DB, RECORDED_MID } from './vowel-models.js';
import { VOWELS, gaussian } from './musical-plan.js';

const models = new WeakMap();
export function vowelModel(units) {
  if (!models.has(units)) {
    const source = units.find(u => u.vowel === 'a')?.source?.split(/[\\/]/).pop();
    const model = Object.values(PROFILES).find(p => p.source === source);
    if (!model) throw new Error(`Missing public vowel calibration for ${source || 'this voice'}`);
    models.set(units, model);
  }
  return models.get(units);
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const frequencies = Float64Array.from({length:513}, (_, i) => i * 24000 / 1024);

export function vowelSpectrum(model, weights, f0) {
  const centers = [0, 0, 0], female = model.scale > 1;
  for (let i = 0; i < VOWELS.length; i++)
    for (let j = 0; j < 3; j++)
      centers[j] += weights[i] * (female && FEMALE_FRONT[VOWELS[i]] ? FEMALE_FRONT[VOWELS[i]][j] : TARGETS[VOWELS[i]][j] * model.scale);
  if (female) {
    // Sung [ɛ] opens with pitch; mirrors formant_targets().
    const [low, high, rise] = EH_RISE, x = clamp((f0 - low) / (high - low), 0, 1);
    centers[0] += weights[VOWELS.indexOf('EH')] * rise * x * x * (3 - 2 * x);
  }
  centers[0] = Math.max(centers[0], .90 * f0);
  centers[1] = Math.max(centers[1], centers[0] + 180 * model.scale);
  centers[2] = Math.max(centers[2], centers[1] + 220 * model.scale);
  if (model.recorded) return recordedSpectrum(model, weights, centers, f0);
  const [first, second, third] = model.anchors, [w1, w2] = model.widths;
  const [t1, t2, t3] = centers, gap = t2 - t1;
  const b1 = Math.min(w1, t1 * .65, gap * .32);
  const b2 = Math.min(w2, gap * .32, (t3 - t2) * .32);
  const source = [0, first-w1, first, first+w1, second-w2, second, second+w2, third, 4800, 12000];
  const destination = [0, t1-b1, t1, t1+b1, t2-b2, t2, t2+b2, t3, 4800, 12000];
  const cover = weights[VOWELS.indexOf('IY')] + .45 * weights[VOWELS.indexOf('IH')];
  const widths = [100,140,180].map((value,j) => Math.max(value*model.scale,f0*[.60,.70,.85][j]));
  widths[1] += cover*100*model.scale;
  const response = frequency => {
    let total = 0;
    for(let j=0;j<3;j++) total-=Math.log((1-(frequency/centers[j])**2)**2+(frequency*widths[j]/centers[j]**2)**2+1e-20);
    return total;
  };
  const reference = response(4800);
  const measured = new Float64Array(513), guide = new Float64Array(513);
  frequencies.forEach((f, bin) => {
    let position = 0;
    for (let i = 0; i < source.length - 1; i++)
      position += (source[i+1]-source[i]) * clamp((f-destination[i]) / (destination[i+1]-destination[i]), 0, 1);
    const p = clamp(position / (24000/1024), 0, 512), lo = Math.floor(p), hi = Math.min(lo+1, 512), a = p-lo;
    measured[bin] = model.envelope[lo]*(1-a) + model.envelope[hi]*a;
    let taper=clamp((4800-f)/600,0,1);taper=taper*taper*(3-2*taper);
    guide[bin]=model.residual[bin]+(response(f)-reference)*taper;
  });
  // Broad recorded color as a 200 Hz-smoothed, ±3 dB-bounded correction to the
  // guide; narrow donor peaks rang out (VV-BODY candidate 1). Mirrors transport().
  const color = gaussian(measured.map((m, bin) => m - guide[bin]), 200 / (24000/1024)), limit = 3*Math.LN10/10;
  return frequencies.map((f, bin) => {
    const result = guide[bin] + limit*Math.tanh(color[bin]/limit);
    const distance=Math.abs(f-t2)/Math.max(220*model.scale,widths[1]*2);
    let shade=clamp(2-distance,0,1);shade=shade*shade*(3-2*shade);
    return result-cover*5*Math.LN10/10*shade;
  });
}

// VV-REAL-VOWELS: blend the singer's own recorded a/e/i/o/u, each registered
// so its F1/F2 land on the targets; mirrors sample_bank/recorded_vowels.py.
const mixings = new WeakMap();
function mixing(model) {
  if (!mixings.has(model)) {
    const female = model.scale > 1, rec = model.recorded, sigma = RECORDED_KERNEL_SEMITONES;
    const rows = VOWELS.map(v => {
      const t = female && FEMALE_FRONT[v] ? FEMALE_FRONT[v] : TARGETS[v].map(x => x * model.scale);
      let w = rec.positions.map(p => Math.exp(-.5 * ((12*Math.log2(t[0]/p[0]))**2 + (12*Math.log2(t[1]/p[1]))**2) / sigma**2));
      let sum = w.reduce((a, b) => a + b, 0);
      w = w.map(x => x / Math.max(sum, 1e-30)).map(x => x < .02 ? 0 : x);
      sum = w.reduce((a, b) => a + b, 0);
      return w.map(x => x / Math.max(sum, 1e-30));
    });
    mixings.set(model, rows);
  }
  return mixings.get(model);
}
const interpClamped = (x, xs, ys) => {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i-1] + (ys[i]-ys[i-1]) * (x-xs[i-1]) / (xs[i]-xs[i-1]);
  return ys[ys.length-1];
};
function recordedSpectrum(model, weights, centers, f0) {
  const rec = model.recorded, M = mixing(model), count = rec.formants.length, step = 24000/1024;
  const aw = new Float64Array(count);
  for (let v = 0; v < VOWELS.length; v++) if (weights[v]) for (let k = 0; k < count; k++) aw[k] += weights[v] * M[v][k];
  const total = Math.max(aw.reduce((a, b) => a + b, 0), 1e-12);
  for (let k = 0; k < count; k++) aw[k] /= total;
  const [t1, t2] = centers;
  // Back-vowel middle (VV-BACK-MID; native recorded_vowels.mid_gate): only
  // frames sung on cardinal [o]/[u] or English [u] take the fitted fill.
  let gate = 0;
  if (rec.register_profile?.mid_db) {
    let share = 0, sum = 0;
    for (let v = 0; v < VOWELS.length; v++) { sum += weights[v]; if (RECORDED_MID.vowels.includes(VOWELS[v])) share += weights[v]; }
    const [g0, g1] = RECORDED_MID.gate, x = clamp((share/Math.max(sum, 1e-12)-g0)/(g1-g0), 0, 1);
    gate = x*x*(3-2*x);
  }
  let own3 = 0;
  for (let k = 0; k < count; k++) own3 += aw[k] * rec.formants[k][2];
  const t3 = Math.max(own3, t2 + 220 * model.scale), gap = t2 - t1;
  const out = new Float64Array(513);
  for (let k = 0; k < count; k++) {
    if (!(aw[k] > 1e-6)) continue;
    const [f1, f2, f3] = rec.formants[k], [w1, w2] = rec.widths[k], env = rec.envelopes[k];
    const b1 = Math.min(w1, t1 * .65, gap * .32), b2 = Math.min(w2, gap * .32, Math.max(t3 - t2, 1) * .32);
    const correction = rec.register_profile ? anchorRegisterField(rec, k, f0, 'envelope_db') : null;
    const protectedEnd = Math.max(2500, t2+250, 2*f0+100);
    const fill = gate > 0 && rec.register_profile.mid_db[k].some(row => row.some(x => x !== 0)) ? anchorRegisterField(rec, k, f0, 'mid_db') : null;
    const midStart = Math.max(t2+250, RECORDED_MID.start_f0*f0);
    const source = [0, f1-w1, f1, f1+w1, f2-w2, f2, f2+w2, f3, 4800, 12000];
    const destination = [0, t1-b1, t1, t1+b1, t2-b2, t2, t2+b2, t3, 4800, 12000];
    for (let bin = 0; bin < 513; bin++) {
      const f = frequencies[bin];
      let position = 0;
      for (let i = 0; i < source.length - 1; i++)
        position += (source[i+1]-source[i]) * clamp((f-destination[i]) / Math.max(destination[i+1]-destination[i], 1e-6), 0, 1);
      const p = clamp(position / step, 0, 512), lo = Math.floor(p), hi = Math.min(lo+1, 512), a = p-lo;
      let shaped = env[lo]*(1-a) + env[hi]*a;
      if (correction) {
        const x = clamp((f-protectedEnd)/300, 0, 1);
        shaped += (correction[lo]*(1-a)+correction[hi]*a)*Math.LN10/10*x*x*(3-2*x);
      }
      if (fill) {
        const m = clamp((f-midStart)/300, 0, 1), top = clamp((f-RECORDED_MID.top_hz)/300, 0, 1);
        shaped += (fill[lo]*(1-a)+fill[hi]*a)*Math.LN10/10*m*m*(3-2*m)*(1-top*top*(3-2*top))*gate;
      }
      out[bin] += aw[k]*shaped;
    }
  }
  // Unresolved recorded F1/F2: a bounded bump at the target (mirrors transport()).
  [t1, t2].forEach((t, j) => {
    let amount = 0;
    for (let k = 0; k < count; k++) amount += aw[k] * rec.unresolved[k][j];
    if (!(amount > 0)) return;
    const width = Math.max(50 * model.scale, .18 * t), height = amount * RECORDED_BUMP_DB * Math.LN10 / 10;
    for (let bin = 0; bin < 513; bin++) out[bin] += height * Math.exp(-.5 * ((frequencies[bin] - t) / width) ** 2);
  });
  let delta = 0;
  for (let k = 0; k < count; k++) delta += aw[k] * interpClamped(Math.log(f0), rec.shelf_pitch[k].map(Math.log), rec.shelf_db[k]);
  const cover = weights[VOWELS.indexOf('IY')] + .45 * weights[VOWELS.indexOf('IH')];
  const bw = Math.max(140 * model.scale, f0 * .70) + cover * 100 * model.scale;
  for (let bin = 0; bin < 513; bin++) {
    const f = frequencies[bin];
    let x = clamp((2*f0 - f) / f0, 0, 1);
    out[bin] += delta * Math.LN10 / 10 * x * x * (3 - 2*x);
    const distance = Math.abs(f - t2) / Math.max(220 * model.scale, bw * 2);
    let shade = clamp(2 - distance, 0, 1); shade = shade * shade * (3 - 2*shade);
    out[bin] -= cover * 5 * Math.LN10 / 10 * shade;
  }
  return out;
}

function registerField(rec, aw, f0, field) {
  const profile = rec.register_profile, pitches = profile.pitch_hz.map(Math.log), lp = Math.log(f0);
  const values = profile[field], result = new Float64Array(profile.frequency_hz.length);
  for (let k = 0; k < aw.length; k++) for (let j = 0; j < pitches.length; j++) {
    const basis = interpClamped(lp, pitches, pitches.map((_, i) => +(i === j)));
    for (let b = 0; b < result.length; b++) result[b] += aw[k]*basis*values[k][j][b];
  }
  return frequencies.map(f => interpClamped(f, profile.frequency_hz, result));
}

// The lift and fitted noise may raise the floor only below 2 kHz; above 2.4 kHz they
// may only lower it (native recorded_vowels.ceiling).
function ceiling(db, f) {
  const w = interpClamped(f, [2000, 2400], [0, 1]);
  return db*(1-w) + Math.min(db, 0)*w;
}

export function vowelAperiodicity(model, weights, f0) {
  const rec = model.recorded;
  const lift = frequencies.map((f) => interpClamped(f,[0,700,1000,2000,2800],[5,5,11,11,0]));
  if (!rec?.register_profile) return frequencies.map((f, b) => model.ap[b]*10**(ceiling(lift[b], f)/20));
  const M = mixing(model), aw = new Float64Array(rec.formants.length);
  for (let v = 0; v < VOWELS.length; v++) if (weights[v]) for (let k = 0; k < aw.length; k++) aw[k] += weights[v]*M[v][k];
  const total = Math.max(aw.reduce((a,b) => a+b, 0), 1e-12);
  for (let k = 0; k < aw.length; k++) aw[k] /= total;
  return registerField(rec, aw, f0, 'aperiodicity_delta_db').map((db, b) => model.ap[b]*10**(ceiling(lift[b]+db, frequencies[b])/20));
}

function anchorRegisterField(rec, anchor, f0, field) {
  const p=rec.register_profile, pitches=p.pitch_hz.map(Math.log), lp=Math.log(f0), values=p[field][anchor];
  const result=new Float64Array(p.frequency_hz.length);
  for(let j=0;j<pitches.length;j++) {
    const basis=interpClamped(lp,pitches,pitches.map((_,i)=>+(i===j)));
    for(let b=0;b<result.length;b++)result[b]+=basis*values[j][b];
  }
  return frequencies.map(f=>interpClamped(f,p.frequency_hz,result));
}
