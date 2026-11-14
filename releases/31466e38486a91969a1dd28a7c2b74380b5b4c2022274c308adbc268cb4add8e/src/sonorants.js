// Same resonance transport, oral closures and recorded CV edges as performers.py.
import { clamp, smooth, lowerBound, voiceEnergy, SR } from "./dsp.js";
import { VOWELS } from "./musical-plan.js";
const F = Float64Array.from({ length: 513 }, (_, i) => (i * SR) / 1024);
const lerp = (a, b, w) => a + (b - a) * w;
function interpolate(x, xp, yp) {
  const i = clamp(lowerBound(xp, x) - 1, 0, xp.length - 2);
  return lerp(yp[i], yp[i + 1], clamp((x - xp[i]) / (xp[i + 1] - xp[i] || 1)));
}
function constrict(logp, ap, amount, spec, scale, vowels, inventory) {
  if (amount <= 0) return;
  const power = logp.map(Math.exp),
    source = logp.slice(),
    points = [0];
  const guide = [0, 1, 2].map((j) =>
    vowels
      ? vowels.reduce(
          (sum, w, i) => sum + w * inventory[VOWELS[i]].formants[j] * scale,
          0,
        )
      : [590, 1600, 2900][j],
  );
  const edges = vowels
    ? [
        100,
        (guide[0] + guide[1]) / 2,
        (guide[1] + guide[2]) / 2,
        Math.max(3600, guide[2] + 600),
      ]
    : [180, 1000, 2200, 3600];
  for (let j = 0; j < 3; j++) {
    let numerator = 0,
      denom = 0;
    for (let i = 0; i < 513; i++)
      if (F[i] >= edges[j] && F[i] < edges[j + 1]) {
        const w = power[i] ** 2;
        numerator += w * F[i];
        denom += w;
      }
    points.push(
      denom > 1e-100 ? numerator / denom : (edges[j] + edges[j + 1]) / 2,
    );
  }
  points.push(12000);
  const target = points.map((p, i) =>
    i > 0 && i < 4 ? lerp(p, spec.formants[i - 1] * scale, amount) : p,
  );
  for (let i = 0; i < 513; i++) {
    const pos = interpolate(F[i], target, points) / (SR / 1024),
      lo = clamp(Math.floor(pos), 0, 512),
      hi = Math.min(lo + 1, 512);
    logp[i] = lerp(source[lo], source[hi], pos - lo);
    if (spec.kind === "nasal") {
      const [first, second] = {
        M: [900, 2100],
        N: [1200, 2900],
        NG: [1700, 3100],
        NY: [1500, 3200],
      }[spec.symbol] || [1200, 2900];
      const notch =
        (1 -
          0.94 *
            Math.exp(-0.5 * ((F[i] - first * scale) / (190 * scale)) ** 2)) *
        (1 -
          0.65 *
            Math.exp(-0.5 * ((F[i] - second * scale) / (250 * scale)) ** 2));
      logp[i] +=
        amount *
        Math.log(Math.max(notch / (1 + (F[i] / (650 * scale)) ** 2), 1e-5));
    } else if (["L", "LY"].includes(spec.symbol))
      logp[i] +=
        amount *
        Math.log(
          (1 -
            0.9 *
              Math.exp(-0.5 * ((F[i] - 2350 * scale) / (260 * scale)) ** 2)) *
            (1 +
              1.4 *
                Math.exp(
                  -0.5 *
                    ((F[i] - spec.formants[1] * scale) / (220 * scale)) ** 2,
                )),
        );
    ap[i] *= 1 - 0.25 * amount;
  }
}
export function sonorants(
  power,
  ap,
  t,
  gestures,
  voice,
  mouth,
  inventory,
  f0,
  vowels,
  sex = 0,
) {
  const before = voiceEnergy(power, ap, f0),
    logp = power.map((p) => Math.log(Math.max(p, 1e-12))),
    scale = ({ bass: 0.88, tenor: 0.95, alto: 1.05, soprano: 1.14 }[voice] || 1)*Math.max(.76,Math.min(1.28,1+.24*sex));
  let changed = false;
  for (const g of gestures) {
    if (mouth[g.phone] || g.end + 0.1 < t || g.start > t) continue;
    const spec = inventory[g.phone];
    if (!spec) continue;
    const duration = g.end - g.start,
      local = (t - g.start) / Math.max(0.005, duration),
      following = Math.min(
        Infinity,
        ...gestures
          .filter((other) => other !== g && other.start >= g.end - 0.001)
          .map((g) => g.start),
      );
    let envelope = smooth(local / 0.22) * smooth((1 - local) / 0.25);
    if (["nasal", "liquid", "glide"].includes(spec.kind)) {
      const closure = spec.kind === "nasal" || ["L", "LY"].includes(g.phone),
        finish = Math.min(g.end + (closure ? 0.012 : 0.03), following);
      envelope =
        smooth(
          (t - g.start) / Math.min(closure ? 0.01 : 0.02, duration * 0.22),
        ) *
        smooth(
          (finish - t) /
            Math.min(closure ? 0.018 : 0.045, (finish - g.start) * 0.45),
        );
      constrict(logp, ap, envelope, spec, scale, vowels, inventory);
      changed ||= envelope > 0;
    } else if (spec.kind === "tap") {
      for (let i = 0; i < 513; i++)
        logp[i] -= envelope * Math.log1p((F[i] / 1800) ** 2) * 0.25;
      changed ||= envelope > 0;
    } else if (["DH", "TH", "V"].includes(g.phone)) {
      constrict(logp, ap, envelope, spec, scale, vowels, inventory);
      for (let i = 0; i < 513; i++)
        logp[i] -=
          envelope *
          Math.log1p((F[i] / (1800 * scale)) ** 2) *
          (g.phone === "DH" ? 0.25 : 0.65);
      changed ||= envelope > 0;
    } else if (spec.kind === "fricative" && spec.voiced) {
      for (let i = 0; i < 513; i++)
        logp[i] -= envelope * Math.log1p((F[i] / 1300) ** 2) * 1.2;
      changed ||= envelope > 0;
    } else if (["plosive", "affricate"].includes(spec.kind)) {
      const release = g.start + 0.55 * duration,
        transition =
          t >= release && t < g.end + 0.06
            ? Math.exp(-Math.max(t - release, 0) / 0.025)
            : 0,
        fc =
          ({ bilabial: 650, alveolar: 1900, velar: 2600 }[spec.place] || 1800) *
          scale;
      for (let i = 0; i < 513; i++)
        logp[i] +=
          transition *
          (1.7 * Math.exp(-0.5 * ((F[i] - fc) / 500) ** 2) -
            0.8 * Math.exp(-0.5 * ((F[i] - 450) / 250) ** 2));
      changed ||= transition > 0;
      if (spec.voiced) {
        const oral = smooth(local / 0.18) * (1 - smooth((t - release) / 0.035)),
          closed = smooth(local / 0.15) * (1 - smooth((t - release) / 0.03));
        constrict(logp, ap, oral, spec, scale, vowels, inventory);
        for (let i = 0; i < 513; i++)
          logp[i] -= closed * Math.log1p((F[i] / (500 * scale)) ** 4);
        changed ||= oral > 0 || closed > 0;
      }
    }
    const unit = mouth.profiles?.[g.phone];
    if (!unit?.edge_times) continue;
    const start = unit.voiced_core ? g.start : g.end + unit.edge_times[0];
    if (!unit.voiced_core && following <= start) continue;
    const finish = Math.min(g.end + unit.edge_times.at(-1), following);
    if (t < start || t > finish) continue;
    // boundary_delta maps the voiced body proportionally, while the release stays native-time.
    const nativeStart = unit.edge_times[0];
    const relative = t - g.end;
    const pos =
      unit.voiced_core && relative < 0
        ? (relative * -nativeStart) / Math.max(duration, 0.005)
        : relative;
    const row = clamp(
        lowerBound(unit.edge_times, pos) - 1,
        0,
        unit.edge_times.length - 2,
      ),
      w = clamp(
        (pos - unit.edge_times[row]) /
          (unit.edge_times[row + 1] - unit.edge_times[row]),
      );
    const boundary =
      clamp((unit.edge_times.at(-1) - pos) / 0.035) *
      clamp((pos - unit.edge_times[0]) / 0.025);
    const fade =
      smooth(boundary) *
      (pos >= unit.edge_times[0] && pos <= unit.edge_times.at(-1)) *
      (following < g.end + unit.edge_times.at(-1)
        ? smooth((following - t) / 0.025)
        : 1);
    for (let i = 0; i < 513; i++) {
      const bin = clamp(i / (scale / 1.14), 0, 512),
        lo = Math.floor(bin),
        hi = Math.min(lo + 1, 512),
        a = bin - lo;
      const read = (data) =>
        lerp(
          lerp(data[row * 513 + lo], data[row * 513 + hi], a),
          lerp(data[(row + 1) * 513 + lo], data[(row + 1) * 513 + hi], a),
          w,
        ) * fade;
      logp[i] += (unit.voiced_core ? 0.25 : 0.75) * read(unit.log_delta);
      ap[i] = clamp(ap[i] + 0.55 * read(unit.ap_delta), 0.001, 0.98);
    }
    changed = true;
  }
  if (changed) {
    for (let i = 0; i < 513; i++) power[i] = Math.exp(logp[i]);
    const correction = clamp(before / voiceEnergy(power, ap, f0), 0.1, 10);
    for (let i = 0; i < 513; i++) power[i] *= correction;
  }
}
