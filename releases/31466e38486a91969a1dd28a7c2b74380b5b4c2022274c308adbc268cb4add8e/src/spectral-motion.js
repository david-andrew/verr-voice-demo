// Mirrors synth/spectral_motion.py: absolute-time, seeded log-power motion.
// Cache smoothed grid blocks per singer, so seeking is deterministic and the
// convolution is paid once per block, not for each spectral frame.
import { NativeRandom } from './native-random.js';

const STEP = .01, BLOCK = 256, NODE_HZ = 80, DB = Math.LN10 / 10;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const frequencies = Float64Array.from({length: 513}, (_, i) => i * 24000 / 1024);
const nodes = Math.ceil(frequencies.at(-1) / NODE_HZ) + 1;
const points = [[300, .45], [1000, 1.2], [1750, 1.5], [4000, 2.4]];
const deviations = frequencies.map(f => {
  const x = Math.log(Math.max(f, 60));
  for (let i = 1; i < points.length; i++) if (x < Math.log(points[i][0])) {
    const w = clamp((x - Math.log(points[i-1][0])) / Math.log(points[i][0] / points[i-1][0]), 0, 1);
    return points[i-1][1] * (1-w) + points[i][1] * w;
  }
  return points.at(-1)[1];
});

export class SpectralMotion {
  constructor(seed) { this.seed = seed; this.cache = new Map(); }
  block(stream, block, width, tau) {
    const key = `${stream}:${block}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const sigma = tau / 2 / STEP, radius = Math.floor(4 * sigma + .5);
    const pad = Math.ceil(4 * sigma) + 2;
    let sum = 0, squares = 0;
    for (let i = -pad; i <= pad; i++) {
      const k = Math.exp(-.5 * (i / sigma) ** 2); sum += k; squares += k*k;
    }
    const norm = Math.sqrt(squares) / sum;
    const kernel = Float64Array.from({length: 2*radius+1}, (_, i) => Math.exp(-.5*((i-radius)/sigma)**2));
    const total = kernel.reduce((a, b) => a+b, 0);
    for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
    const first = block * BLOCK - radius, last = (block+1)*BLOCK + radius;
    const raw = new Float64Array((last-first)*width);
    for (let b = Math.floor(first/BLOCK); b <= Math.floor((last-1)/BLOCK); b++) {
      const data = new NativeRandom([this.seed >>> 0, stream, b + 2**31]).normals(BLOCK*width);
      const a = Math.max(first, b*BLOCK), z = Math.min(last, (b+1)*BLOCK);
      raw.set(data.subarray((a-b*BLOCK)*width, (z-b*BLOCK)*width), (a-first)*width);
    }
    const out = new Float64Array(BLOCK*width);
    for (let i = 0; i < BLOCK; i++) for (let j = 0; j < width; j++) {
      let value = 0;
      for (let k = 0; k < kernel.length; k++) value += raw[(i+k)*width+j]*kernel[k];
      out[i*width+j] = value/norm;
    }
    this.cache.set(key, out);
    while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
    return out;
  }
  sample(stream, t, width, tau) {
    const p = t/STEP, a = Math.floor(p), u = p-a;
    const b0 = Math.floor(a/BLOCK), b1 = Math.floor((a+1)/BLOCK);
    const x = this.block(stream, b0, width, tau), y = this.block(stream, b1, width, tau);
    const i0 = (a-b0*BLOCK)*width, i1 = (a+1-b1*BLOCK)*width;
    return Float64Array.from({length: width}, (_, j) => x[i0+j]*(1-u)+y[i1+j]*u);
  }
  at(t, depth = 1) {
    if (depth <= 0) return new Float64Array(frequencies.length);
    const level = this.sample(1, t, 1, .15)[0]*.5, tilt = this.sample(2, t, 1, .08)[0]*.45;
    const slow = this.sample(3, t, nodes, .08), fast = this.sample(4, t, nodes, .025);
    const residual = slow.map((v, i) => {
      const w = clamp((i*NODE_HZ-2500)/2500, 0, 1);
      return v*Math.sqrt(1-w)+fast[i]*Math.sqrt(w);
    });
    return frequencies.map((f, i) => {
      const oct = clamp(Math.log2(Math.max(f, 60)/1000), -.5, 3.5);
      const p = f/NODE_HZ, a = Math.floor(p), u = p-a, b = Math.min(a+1, nodes-1), sd = deviations[i];
      const r = (residual[a]*(1-u)+residual[b]*u)/Math.sqrt(1-2*u*(1-u));
      const variance = (depth*DB)**2*(.5**2+(.45*oct)**2+sd**2);
      return (level+tilt*oct+r*sd)*depth*DB-variance/2;
    });
  }
}
