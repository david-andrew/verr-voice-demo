import { noiseInterval } from "./native-random.js";
// Classical WORLD pulse/filter equations. See ../licenses/WORLD.txt.
// No oscillator bank: the impulse response is rebuilt from moving recorded spectra.
export const SR = 24000,
  FFT_SIZE = 1024;
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const smooth = (x) => {
  x = clamp(x);
  return x * x * (3 - 2 * x);
};
export function hash(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
export const random = (seed, index) =>
  hash((index | 0) ^ hash(seed)) / 4294967296;
export function noise(seed, index) { return noiseInterval(seed, index, index + 1)[0]; }
// One continuous excitation field shared by overlapping spectral windows.
export function excitationInterval(clock, frames, seed, start, end) {
  const raw = noiseInterval(seed, start, end);
  if (clock.indices.length < 2 || !frames.some(f => f.coupling)) return raw;
  let pulse = Math.max(0, lowerBound(clock.indices, start) - 2), frame = 0;
  for (let i = 0; i < raw.length; i++) {
    const sample = start + i;
    while (pulse < clock.indices.length - 2 && clock.indices[pulse+1] + clock.fractions[pulse+1] < sample) pulse++;
    while (frame < frames.length - 2 && Math.round(frames[frame+1].center) < sample) frame++;
    const a = frames[frame], b = frames[Math.min(frame+1, frames.length-1)];
    const blend = clamp((sample-Math.round(a.center))/(Math.round(b.center)-Math.round(a.center) || 1));
    const depth = clamp(a.coupling || 0, 0, .25)*(1-blend) + clamp(b.coupling || 0, 0, .25)*blend;
    const left = clock.indices[pulse]+clock.fractions[pulse], right = clock.indices[pulse+1]+clock.fractions[pulse+1];
    const phase = pulse + clamp((sample-left)/(right-left));
    raw[i] *= Math.sqrt(1-depth*Math.cos(2*Math.PI*(phase%1)));
  }
  return raw;
}
let wasm = null;
export const usedDSPBackends=new Set();
export async function initDSP(source = new URL("./fft.wasm", import.meta.url)) {
  try {
    const bytes =
      source instanceof ArrayBuffer || ArrayBuffer.isView(source)
        ? source
        : await fetch(source).then((r) => {
            if (!r.ok) throw Error("WASM unavailable");
            return r.arrayBuffer();
          });
    const { instance } = await WebAssembly.instantiate(bytes, {
      env: { cos: Math.cos, sin: Math.sin, log: Math.log, exp: Math.exp },
    });
    const e = instance.exports;
    wasm = {
      e,
      re: new Float64Array(e.memory.buffer, e.real_ptr(), 8192),
      im: new Float64Array(e.memory.buffer, e.imag_ptr(), 8192),
    };
    return "wasm";
  } catch {
    return "javascript";
  }
}
const tables = new Map();
export function fft(re, im, inverse = false) {
  usedDSPBackends.add(wasm ? "wasm" : "javascript");
  const n = re.length;
  if (wasm) {
    wasm.re.set(re);
    wasm.im.set(im);
    wasm.e.fft(n, inverse ? 1 : 0);
    re.set(wasm.re.subarray(0, n));
    im.set(wasm.im.subarray(0, n));
    return [re, im];
  }
  let table = tables.get(n);
  if (!table) {
    const cos = new Float64Array(n / 2),
      sin = new Float64Array(n / 2),
      rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0,
        x = i;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>>= 1;
      }
      rev[i] = r;
    }
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    table = { cos, sin, rev };
    tables.set(n, table);
  }
  const { cos, sin, rev } = table;
  for (let i = 0; i < n; i++) {
    let j = rev[i];
    if (j > i) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2,
      step = n / size;
    for (let i = 0; i < n; i += size)
      for (let j = 0; j < half; j++) {
        const k = j * step,
          c = cos[k],
          s = sin[k] * (inverse ? 1 : -1),
          a = i + j,
          b = a + half,
          tr = re[b] * c - im[b] * s,
          ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
  }
  if (inverse)
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  return [re, im];
}
export function irfft(real, imag, n = (real.length - 1) * 2) {
  const re = new Float64Array(n),
    im = new Float64Array(n);
  for (let i = 0; i < real.length && i <= n / 2; i++) {
    re[i] = real[i];
    im[i] = imag?.[i] || 0;
    if (i && i < n / 2) {
      re[n - i] = re[i];
      im[n - i] = -im[i];
    }
  }
  fft(re, im, true);
  return re;
}
export function minimumPhase(power) {
  const n = (power.length - 1) * 2,
    log = Float64Array.from(power, (p) => 0.5 * Math.log(Math.max(p, 1e-18))),
    cep = irfft(log);
  for (let i = 1; i < n / 2; i++) cep[i] *= 2;
  cep.fill(0, n / 2 + 1);
  const im = new Float64Array(n);
  fft(cep, im);
  const re = new Float64Array(n / 2 + 1),
    outIm = new Float64Array(n / 2 + 1);
  for (let i = 0; i < re.length; i++) {
    let a = Math.exp(cep[i]);
    re[i] = a * Math.cos(im[i]);
    outIm[i] = a * Math.sin(im[i]);
  }
  return [re, outIm];
}
export function filters(power, ap) {
  usedDSPBackends.add(wasm ? "wasm" : "javascript");
  if (wasm?.e.spectral_filters && power.length === 513) {
    const e = wasm.e,
      m = e.memory.buffer;
    new Float64Array(m, e.power_ptr(), 513).set(power);
    new Float64Array(m, e.ap_ptr(), 513).set(ap);
    e.spectral_filters();
    return {
      kernel: new Float64Array(m, e.kernel_ptr(), 4096).slice(),
      noise: [
        new Float64Array(m, e.noise_re_ptr(), 513).slice(),
        new Float64Array(m, e.noise_im_ptr(), 513).slice(),
      ],
    };
  }
  const p = new Float64Array(power.length),
    q = new Float64Array(power.length);
  for (let j = 0; j < p.length; j++) {
    const r = Math.fround(clamp(Math.fround(ap[j]), Math.fround(.001), Math.fround(.999999)) ** 2);
    p[j] = Math.fround(Math.fround(power[j]) * Math.fround(1-r));
    q[j] = Math.fround(Math.fround(power[j]) * r);
  }
  const [re, im] = minimumPhase(p);
  re[re.length - 1] *= 0.5;
  im[im.length - 1] *= 0.5;
  const n = (p.length - 1) * 2,
    raw = irfft(re, im, n * 4),
    kernel = new Float64Array(n * 4);
  for (let i = 0; i < kernel.length; i++)
    kernel[i] = 4 * raw[(i + n * 2) % (n * 4)];
  return { kernel, noise: minimumPhase(q) };
}
export function pulseClock(f0, sr = SR, hop = 240) {
  const phases = new Float64Array(f0.length + 1);
  for (let i = 0; i < f0.length; i++) {
    const d =
      (i + 1 < f0.length ? f0[i + 1] : 2 * f0[i] - (f0[i - 1] || f0[i])) -
      f0[i];
    phases[i + 1] = phases[i] + (hop * f0[i] + 0.5 * (hop - 1) * d) / sr;
  }
  const indices = [],
    fractions = [];
  let frame = 0;
  for (let cycle = 1; cycle <= Math.floor(phases.at(-1)); cycle++) {
    while (frame < f0.length - 1 && phases[frame + 1] <= cycle) frame++;
    const d =
        (f0[frame + 1] ?? 2 * f0[frame] - (f0[frame - 1] || f0[frame])) -
        f0[frame],
      aa = (0.5 * d) / hop,
      bb = f0[frame] - aa,
      target = (cycle - phases[frame]) * sr,
      m =
        (2 * target) / (bb + Math.sqrt(Math.max(0, bb * bb + 4 * aa * target))),
      index = Math.floor(frame * hop + m - 1),
      j = index - frame * hop,
      left = (j + 1) * f0[frame] + aa * j * (j + 1);
    indices.push(index);
    fractions.push(clamp((target - left) / (f0[frame] + (d * (j + 1)) / hop)));
  }
  return {
    indices: Float64Array.from(indices),
    fractions: Float64Array.from(fractions),
    length: f0.length * hop,
  };
}
export function lowerBound(array, value) {
  let lo = 0,
    hi = array.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (array[m] < value) lo = m + 1;
    else hi = m;
  }
  return lo;
}
export function synthesizeWindow(clock, frames, start, end, seed = 0) {
  const excitationStart = start - 1024;
  const excitation = excitationInterval(clock, frames, seed, excitationStart, end + 1024);
  // Copy only the pulse neighborhood and spectral frames needed by this window.
  const firstPulse = Math.max(
      0,
      lowerBound(
        clock.indices,
        Math.min(start - 1024, frames[0]?.center - 512),
      ) - 1,
    ),
    lastPulse = Math.min(
      clock.indices.length,
      lowerBound(
        clock.indices,
        Math.max(end + 1024, frames.at(-1)?.center + 512),
      ) + 2,
    );
  if (
    wasm?.e.render_window &&
    frames.length > 0 &&
    frames.length <= 512 &&
    lastPulse - firstPulse <= 8192 &&
    end - start <= 131072
  ) {
    const e = wasm.e,
      m = e.memory.buffer,
      stride = 5124;
    const data = new Float64Array(m, e.frames_ptr(), frames.length * stride);
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i],
        at = i * stride;
      data[at] = f.center;
      data[at + 1] = f.coupling || 0;
      data.set(f.kernel, at + 2);
      data.set(f.noise[0], at + 4098);
      data.set(f.noise[1], at + 4611);
    }
    new Float64Array(m, e.pulses_ptr(), lastPulse - firstPulse).set(
      clock.indices.subarray(firstPulse, lastPulse),
    );
    new Float64Array(m, e.fractions_ptr(), lastPulse - firstPulse).set(
      clock.fractions.subarray(firstPulse, lastPulse),
    );
    new Float32Array(m, e.excitation_ptr(), excitation.length).set(excitation);
    e.render_window(start, end, frames.length, lastPulse - firstPulse, excitationStart);
    return new Float64Array(m, e.output_ptr(), end - start).slice();
  }

  const n = FFT_SIZE,
    width = n * 4,
    mask = width - 1,
    out = new Float64Array(end - start),
    dc = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n / 2; i++) {
    dc[i] = dc[n - 1 - i] =
      0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (n + 1));
    sum += 2 * dc[i];
  }
  for (let i = 0; i < n; i++) dc[i] /= sum;
  let frame = 0;
  const centers = frames.map((f) => f.center),
    response = new Float64Array(n);
  for (
    let k = lowerBound(clock.indices, start - n / 2);
    k <
    Math.min(clock.indices.length - 1, lowerBound(clock.indices, end + n / 2));
    k++
  ) {
    const index = clock.indices[k];
    while (frame < frames.length - 2 && centers[frame + 1] <= index) frame++;
    const lo = frames[frame],
      hi = frames[Math.min(frame + 1, frames.length - 1)],
      blend = clamp((index - lo.center) / (hi.center - lo.center || 1)),
      shift = clock.fractions[k] * 4,
      base = Math.floor(-shift),
      f = -shift - base,
      w0 = (-f * (1 - f) * (2 - f)) / 6,
      w1 = ((1 + f) * (1 - f) * (2 - f)) / 2,
      w2 = ((1 + f) * f * (2 - f)) / 2,
      w3 = (-(1 + f) * f * (1 - f)) / 6;
    let component = 0;
    for (let j = n / 2; j < n; j++) {
      const a = (j * 4 + base) & mask,
        b = (a + 1) & mask,
        prev = (a - 1) & mask,
        after = (a + 2) & mask;
      const v0 =
          lo.kernel[prev] * w0 +
          lo.kernel[a] * w1 +
          lo.kernel[b] * w2 +
          lo.kernel[after] * w3,
        v1 =
          hi.kernel[prev] * w0 +
          hi.kernel[a] * w1 +
          hi.kernel[b] * w2 +
          hi.kernel[after] * w3;
      response[j] = v0 * (1 - blend) + v1 * blend;
      component += response[j];
    }
    const offset = index - n / 2 + 1,
      scale = Math.sqrt(clock.indices[k + 1] - index);
    for (
      let j = Math.max(0, start - offset);
      j < Math.min(n, end - offset);
      j++
    )
      out[offset + j - start] +=
        ((j < n / 2 ? 0 : response[j]) - component * dc[j]) * scale;
  }
  const window = Float32Array.from({ length: n }, (_, i) =>
      Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)),
    ),
    weights = new Float64Array(out.length),
    noiseOut = new Float64Array(out.length);
  for (const frame of frames) {
    const origin = Math.round(frame.center) - n / 2;
    if (origin + n <= start || origin >= end) continue;
    const re = new Float64Array(n),
      im = new Float64Array(n);
    for (let j = 0; j < n; j++)
      re[j] = Math.fround(excitation[origin + j - excitationStart] * window[j]);
    fft(re, im);
    for (let j = 0; j < n; j++) {
      const k = j <= n / 2 ? j : n - j,
        hr = frame.noise[0][k],
        hi = frame.noise[1][k] * (j <= n / 2 ? 1 : -1),
        r = re[j];
      re[j] = r * hr - im[j] * hi;
      im[j] = r * hi + im[j] * hr;
    }
    fft(re, im, true);
    for (
      let j = Math.max(0, start - origin);
      j < Math.min(n, end - origin);
      j++
    ) {
      const k = origin + j - start;
      noiseOut[k] += re[j] * window[j];
      weights[k] += Math.fround(window[j] ** 2);
    }
  }
  for (let i = 0; i < out.length; i++)
    out[i] += noiseOut[i] / Math.max(weights[i], 1e-9);
  return out;
}
export function voiceEnergy(power, ap, f0) {
  let harmonic = 0,
    count = 0;
  for (let h = 1; h * f0 < 12000; h++) {
    const pos = (h * f0) / (SR / FFT_SIZE),
      a = Math.floor(pos),
      b = Math.min(a + 1, 512),
      w = pos - a;
    harmonic +=
      power[a] * (1 - ap[a] ** 2) * (1 - w) + power[b] * (1 - ap[b] ** 2) * w;
    count++;
  }
  let n = 0;
  for (let i = 0; i < power.length; i++) n += power[i] * ap[i] ** 2;
  return (harmonic * 2 * f0) / SR + n / power.length;
}
