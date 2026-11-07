export const usedGPUBackends=new Set();
// Optional float32 GPU cepstral filtering. WebGL2 also works on ordinary LAN
// HTTP where WebGPU is unavailable. Every device is checked against the WASM
// reference and benchmarked before use; a lost context falls back immediately.
const vertex = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}`;
const fragment = `#version 300 es
precision highp float;precision highp int;
uniform highp sampler2D source;uniform int mode;uniform int n;uniform int stage;uniform int inverse;
out vec4 color;
// Range-reduced polynomials avoid low-accuracy driver transcendental intrinsics.
float sine(float x){x-=floor((x+3.141592653589793)/6.283185307179586)*6.283185307179586;if(x>1.570796326794897)x=3.141592653589793-x;if(x< -1.570796326794897)x=-3.141592653589793-x;float z=x*x;return x*(1.+z*(-.1666666666666667+z*(.008333333333333333+z*(-.0001984126984126984+z*(.000002755731922398589+z*(-.00000002505210838544172+z*.0000000001605904383682161))))));}
float cosine(float x){return sine(x+1.570796326794897);}
float exponential(float x){float k=floor(x*1.4426950408889634+.5),r=x-k*.6931471805599453;return exp2(k)*(1.+r*(1.+r*(.5+r*(.1666666666666667+r*(.04166666666666667+r*(.008333333333333333+r*(.001388888888888889+r*.0001984126984126984)))))));}
vec2 at(int x,int y){return texelFetch(source,ivec2(x,y),0).rg;}
int reverseBits(int x,int size){int r=0;for(int i=0;i<12;i++){if((1<<i)>=size)break;r=(r<<1)|(x&1);x>>=1;}return r;}
void main(){int x=int(gl_FragCoord.x),y=int(gl_FragCoord.y);vec2 v=vec2(0);
 if(mode==0){int b=x<=512?x:1024-x;vec2 a=at(b,y/2);v.x=(y&1)==1?a.y:a.x;}
 else if(mode==1){v=at(reverseBits(x,n),y);}
 else if(mode==2){int halfSize=stage/2,j=x%halfSize,base=(x/stage)*stage;vec2 a=at(base+j,y),b=at(base+j+halfSize,y);float theta=(inverse==1?1.:-1.)*6.283185307179586*float(j)/float(stage);vec2 w=vec2(cosine(theta),sine(theta));vec2 z=vec2(b.x*w.x-b.y*w.y,b.x*w.y+b.y*w.x);v=a+(x%stage<halfSize?z:-z);if(inverse==1&&stage==n)v/=float(n);}
 else if(mode==3){v.x=at(x,y).x*(x==0||x==512?1.:x<512?2.:0.);}
 else if(mode==4){vec2 a=at(x,y);v=exponential(a.x)*vec2(cosine(a.y),sine(a.y));}
 else if(mode==5){int b=x<=512?x:4096-x;if(b<=512){v=at(b,y*2);if(x>512)v.y=-v.y;if(b==512)v*=.5;}}
 else if(mode==6){color=vec4(at(x*4,y).x,at(x*4+1,y).x,at(x*4+2,y).x,at(x*4+3,y).x);return;}
 else if(mode==7){color=vec4(at(x*2,y*2+1),at(min(x*2+1,512),y*2+1));return;}
 color=vec4(v,0,1);
}`;
export class GPUFilters {
  constructor() {
    if (typeof OffscreenCanvas === "undefined")
      throw Error("OffscreenCanvas unavailable");
    const gl = new OffscreenCanvas(1, 1).getContext("webgl2", {
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl || !gl.getExtension("EXT_color_buffer_float"))
      throw Error("Float GPU rendering unavailable");
    this.gl = gl;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    this.renderer = debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    function compile(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(shader));
      return shader;
    }
    const program = gl.createProgram(),
      vs = compile(gl.VERTEX_SHADER, vertex),
      fs = compile(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    this.program = program;
    this.uniforms = Object.fromEntries(
      ["source", "mode", "n", "stage", "inverse"].map((k) => [
        k,
        gl.getUniformLocation(program, k),
      ]),
    );
    gl.uniform1i(this.uniforms.source, 0);
    this.fbo = gl.createFramebuffer();
    this.textures = [];
    this.capacity = 0;
    this.input = gl.createTexture();
    this.packed = gl.createTexture();
  }
  texture(texture, w, h, data = null, rgba = false) {
    const g = this.gl;
    g.bindTexture(g.TEXTURE_2D, texture);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    g.texImage2D(
      g.TEXTURE_2D,
      0,
      rgba ? g.RGBA32F : g.RG32F,
      w,
      h,
      0,
      rgba ? g.RGBA : g.RG,
      g.FLOAT,
      data,
    );
  }
  draw(source, target, mode, n, rows, stage = 0, inverse = 0) {
    const g = this.gl;
    g.bindFramebuffer(g.FRAMEBUFFER, this.fbo);
    g.framebufferTexture2D(
      g.FRAMEBUFFER,
      g.COLOR_ATTACHMENT0,
      g.TEXTURE_2D,
      target,
      0,
    );
    g.bindTexture(g.TEXTURE_2D, source);
    g.viewport(0, 0, n, rows);
    for (const [key, value] of Object.entries({ mode, n, stage, inverse }))
      g.uniform1i(this.uniforms[key], value);
    g.drawArrays(g.TRIANGLES, 0, 3);
  }
  other(texture) {
    return this.textures.find((t) => t !== texture);
  }
  fft(source, n, rows, inverse) {
    let target = this.other(source);
    this.draw(source, target, 1, n, rows);
    source = target;
    for (let size = 2; size <= n; size *= 2) {
      target = this.other(source);
      this.draw(source, target, 2, n, rows, size, inverse);
      source = target;
    }
    return source;
  }
  read(source, n, rows) {
    const g = this.gl,
      result = new Float32Array(n * rows * 4);
    g.bindFramebuffer(g.FRAMEBUFFER, this.fbo);
    g.framebufferTexture2D(
      g.FRAMEBUFFER,
      g.COLOR_ATTACHMENT0,
      g.TEXTURE_2D,
      source,
      0,
    );
    g.readPixels(0, 0, n, rows, g.RGBA, g.FLOAT, result);
    if (g.getError() !== g.NO_ERROR) throw Error("GPU readback failed");
    return result;
  }
  filters(items) {
    const g = this.gl;
    if (g.isContextLost()) throw Error("GPU context lost");
    const count = items.length,
      rows = count * 2;
    if (!count) return [];
    if (rows > g.getParameter(g.MAX_TEXTURE_SIZE))
      throw Error("GPU batch too large");
    if (rows > this.capacity) {
      for (const t of this.textures) g.deleteTexture(t);
      this.capacity = rows;
      this.textures = Array.from({ length: 2 }, () => g.createTexture());
      for (const t of this.textures) this.texture(t, 4096, rows);
      this.texture(this.packed, 1024, count, null, true);
    }
    const data = new Float32Array(count * 513 * 2);
    items.forEach((s, i) => {
      for (let k = 0; k < 513; k++) {
        const ratio = Math.fround(Math.max(Math.fround(.001), Math.min(Math.fround(.999999), Math.fround(s.ap[k]))) ** 2);
        data[(i * 513 + k) * 2] =
          0.5 * Math.log(Math.max(1e-18, Math.fround(Math.fround(s.power[k]) * Math.fround(1-ratio))));
        data[(i * 513 + k) * 2 + 1] =
          0.5 * Math.log(Math.max(1e-18, Math.fround(Math.fround(s.power[k]) * ratio)));
      }
    });
    this.texture(this.input, 513, count, data);
    let current = this.textures[0];
    this.draw(this.input, current, 0, 1024, rows);
    current = this.fft(current, 1024, rows, 1);
    let next = this.other(current);
    this.draw(current, next, 3, 1024, rows);
    current = this.fft(next, 1024, rows, 0);
    next = this.other(current);
    this.draw(current, next, 4, 1024, rows);
    current = next;
    this.draw(current, this.packed, 7, 257, count);
    const spectrum = this.read(this.packed, 257, count);
    next = this.other(current);
    this.draw(current, next, 5, 4096, count);
    current = this.fft(next, 4096, count, 1);
    this.draw(current, this.packed, 6, 1024, count);
    const raw = this.read(this.packed, 1024, count);
    return items.map((_, i) => ({
      kernel: Float64Array.from(
        { length: 4096 },
        (_, k) => 4 * raw[i * 4096 + ((k + 2048) & 4095)],
      ),
      noise: [
        Float64Array.from(
          { length: 513 },
          (_, k) => spectrum[i * 1028 + k * 2],
        ),
        Float64Array.from(
          { length: 513 },
          (_, k) => spectrum[i * 1028 + k * 2 + 1],
        ),
      ],
    }));
  }
  dispose() {
    const g = this.gl;
    for (const t of [...this.textures, this.input, this.packed])
      g.deleteTexture(t);
    g.deleteFramebuffer(this.fbo);
    g.deleteProgram(this.program);
    g.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
let active = null;
export const gpuStatus = {
  available: false,
  enabled: false,
  reason: "Not initialized",
};
export function initializeGPU(reference, { force = false } = {}) {
  try {
    const gpu = new GPUFilters();
    gpuStatus.available = true;
    gpuStatus.renderer = gpu.renderer;
    if (
      !force &&
      /swiftshader|llvmpipe|softpipe|software/i.test(gpu.renderer)
    ) {
      gpu.dispose();
      gpuStatus.reason = "Software graphics; using WASM synthesis";
      return gpuStatus;
    }
    const items = Array.from({ length: 64 }, (_, i) => ({
      power: Float64Array.from(
        { length: 513 },
        (_, b) => Math.exp(-b / 100) * (1 + 0.4 * Math.cos(b * 0.037 + i)),
      ),
      ap: Float64Array.from({ length: 513 }, (_, b) => 0.01 + (0.5 * b) / 512),
    }));
    const expected = items.map((s) => reference(s.power, s.ap));
    let start = performance.now();
    items.map((s) => reference(s.power, s.ap));
    const cpuMs = performance.now() - start;
    const actual = gpu.filters(items);
    let error = 0,
      power = 0;
    for (let i = 0; i < items.length; i++)
      for (const key of ["kernel", "noise"]) {
        const aa =
            key === "noise"
              ? actual[i].noise.flatMap((v) => Array.from(v))
              : actual[i].kernel,
          bb =
            key === "noise"
              ? expected[i].noise.flatMap((v) => Array.from(v))
              : expected[i].kernel;
        for (let j = 0; j < aa.length; j++) {
          error += (aa[j] - bb[j]) ** 2;
          power += bb[j] ** 2;
        }
      }
    const relative = Math.sqrt(error / power);
    if (!Number.isFinite(relative) || relative > 1e-4) {
      gpu.dispose();
      throw Error(`GPU accuracy check failed (${relative})`);
    }
    start = performance.now();
    gpu.filters(items);
    const gpuMs = performance.now() - start;
    Object.assign(gpuStatus, { relativeError: relative, cpuMs, gpuMs });
    if (!force && gpuMs >= cpuMs * 0.9) {
      gpu.dispose();
      gpuStatus.reason = "WASM was faster in the device benchmark";
      return gpuStatus;
    }
    active = gpu;
    gpuStatus.enabled = true;
    gpuStatus.reason = null;
  } catch (error) {
    gpuStatus.reason = error.message;
  }
  return gpuStatus;
}
export function filterBatch(items, reference) {
  if (active && items.length >= 8) {
    try {
      const result=active.filters(items);usedGPUBackends.add("webgl2");return result;
    } catch (error) {
      active.dispose();
      active = null;
      Object.assign(gpuStatus, { enabled: false, reason: error.message });
    }
  }
  return items.map((s) => reference(s.power, s.ap));
}
