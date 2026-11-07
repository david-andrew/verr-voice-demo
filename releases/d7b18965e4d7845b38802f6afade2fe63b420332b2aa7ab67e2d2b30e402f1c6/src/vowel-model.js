/** Measured spectral-envelope registration; matches sample_bank/vowel_model.py. */
import { PROFILES, TARGETS, FEMALE_FRONT, EH_RISE } from './vowel-models.js';
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
