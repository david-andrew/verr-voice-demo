import { readBlob } from "./bank.js";
export function encodeWav(channels, sampleRate = 48000) {
  const frames = channels[0].length,
    n = channels.length,
    buffer = new ArrayBuffer(44 + frames * n * 2),
    v = new DataView(buffer),
    str = (p, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i));
    };
  str(0, "RIFF");
  v.setUint32(4, buffer.byteLength - 8, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, n, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * n * 2, true);
  v.setUint16(32, n * 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, frames * n * 2, true);
  let peak = 0;
  for (const c of channels)
    for (const x of c) peak = Math.max(peak, Math.abs(x));
  const scale = peak > 0.98 ? 0.98 / peak : 1;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < n; c++)
      v.setInt16(
        44 + 2 * (i * n + c),
        Math.round(Math.max(-1, Math.min(1, channels[c][i] * scale)) * 32767),
        true,
      );
  return {
    blob: new Blob([buffer], { type: "audio/wav" }),
    reductionDb: -20 * Math.log10(scale),
  };
}
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
// Keep scheduled nodes reachable across asynchronous offline work and release
// their connections only after rendering has completed.
export async function renderOffline(context, sources, graph = null) {
  try { return await context.startRendering(); }
  finally {
    for(const source of sources) source.disconnect();
    graph?.reverb?.disconnect();
  }
}
export class AudioEngine {
  constructor(manifest, provider = null) {
    this.provider = provider;
    this.manifest = manifest;
    this.rooms = new Map();
    this.context = null;
    this.graph = null;
    this.sources = [];
    this.playing = false;
    this.position = 0;
    this.scheduledEnd = 0;
    this.room = "chamber";
    this.space = 0.56;
    this.mix = [];
  }
  async resume() {
    this.context ||= new AudioContext({
      sampleRate: 48000,
      latencyHint: "interactive",
    });
    await this.context.resume();
  }
  async roomData(name) {
    if (name === "dry") return null;
    if (!this.rooms.has(name))
      this.rooms.set(
        name,
        readBlob(this.manifest.rooms[name], undefined, this.provider).then(({ fields }) => fields.ir),
      );
    return this.rooms.get(name);
  }
  async graphFor(context, mix, room, space) {
    const bus = context.createGain(),
      out = context.createGain();
    bus.channelCount = 2;
    const dry = context.createGain();
    dry.gain.value = room === "dry" ? 1 : 1 - space * 0.48;
    bus.connect(dry).connect(out);
    const raw = await this.roomData(room);
    let wet = null, reverb = null;
    if (raw) {
      const n = raw.length / 4,
        buffer = context.createBuffer(
          4,
          n,
          this.manifest.roomSampleRate || 24000,
        );
      for (let c = 0; c < 4; c++)
        buffer.copyToChannel(raw.subarray(c * n, (c + 1) * n), c);
      reverb = context.createConvolver();
      reverb.normalize = false;
      reverb.buffer = buffer;
      wet = context.createGain();
      wet.gain.value = space * 0.48;
      bus.connect(reverb).connect(wet).connect(out);
    }
    let preview = null;
    if (context === this.context) {
      const input = context.createGain(),
        low = context.createBiquadFilter(),
        body = context.createBiquadFilter(),
        high = context.createBiquadFilter();
      low.type = "lowshelf";
      low.frequency.value = 450;
      body.type = "peaking";
      body.frequency.value = 1100;
      body.Q.value = 0.65;
      high.type = "highshelf";
      high.frequency.value = 1800;
      input.connect(low).connect(body).connect(high);
      const straight = context.createGain(),
        modulated = context.createGain(),
        delay = context.createDelay(0.03),
        oscillator = context.createOscillator(),
        depth = context.createGain();
      delay.delayTime.value = 0.008;
      oscillator.frequency.value = 5.7;
      depth.gain.value = 0;
      modulated.gain.value = 0;
      oscillator.connect(depth).connect(delay.delayTime);
      oscillator.start();
      high.connect(straight).connect(bus);
      high.connect(delay).connect(modulated).connect(bus);
      preview = {
        input,
        low,
        body,
        high,
        straight,
        modulated,
        depth,
        oscillator,
        active: false,
        nodes: [
          input,
          low,
          body,
          high,
          straight,
          modulated,
          delay,
          depth,
          oscillator,
        ],
      };
    }
    const channels = mix.map((m) => {
      const gain = context.createGain(),
        pan = context.createStereoPanner();
      gain
        .connect(pan)
        .connect(preview && m.instrument === "voice" ? preview.input : bus);
      return { gain, pan };
    });
    out.connect(context.destination);
    const graph = { bus, out, channels, preview, dry, wet, space, reverb };
    this.setMix(mix, graph, context, true);
    return graph;
  }
  setMix(mix, graph = this.graph, context = this.context, initial = false) {
    this.mix = mix;
    if (!graph) return;
    const solo = mix.some((m) => m.solo),
      headroom = 1 / Math.sqrt(Math.max(1, mix.length));
    mix.forEach((m, i) => {
      const gain = (!m.mute && (!solo || m.solo) ? m.level : 0) * headroom;
      if (initial) {
        graph.channels[i].gain.gain.setValueAtTime(gain, context.currentTime);
        graph.channels[i].pan.pan.setValueAtTime(m.pan, context.currentTime);
      } else {
        graph.channels[i].gain.gain.setTargetAtTime(
          gain,
          context.currentTime,
          0.015,
        );
        graph.channels[i].pan.pan.setTargetAtTime(
          m.pan,
          context.currentTime,
          0.015,
        );
      }
    });
  }
  preview(controls, eligible = true) {
    const g = this.graph,
      p = g?.preview;
    if (!p || !g.controls) return;
    const delta = (key) =>
      eligible ? (controls[key] || 0) - (g.controls[key] || 0) : 0;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x)),
      now = this.context.currentTime;
    const smooth = (param, value) => {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, 0.025);
    };
    const low = clamp(5 * delta("weight") - 1.5 * delta("age"), -5, 5),
      high = clamp(
        5 * delta("phonation") + 3 * delta("timbre") - 1.5 * delta("age"),
        -6,
        6,
      ),
      body = clamp(2 * delta("age") + delta("timbre"), -3, 3),
      vibrato = delta("vibrato");
    smooth(p.low.gain, low);
    smooth(p.high.gain, high);
    smooth(p.body.gain, body);
    smooth(p.depth.gain, Math.max(0, vibrato) * 0.00065);
    smooth(p.straight.gain, vibrato > 0.005 ? 0 : 1);
    smooth(p.modulated.gain, vibrato > 0.005 ? 1 : 0);
    if (g.wet) {
      const amount = clamp(g.space * 0.48 + 0.48 * delta("space"), 0, 0.85);
      smooth(g.dry.gain, 1 - amount);
      smooth(g.wet.gain, amount);
    }
    p.active =
      Math.max(
        Math.abs(low),
        Math.abs(high),
        Math.abs(body),
        Math.abs(vibrato),
        Math.abs(delta("space")),
      ) > 0.0001;
  }
  disposeGraph(g) {
    g.preview?.oscillator.stop();
    g.preview?.nodes.forEach((n) => n.disconnect());
    g.out.disconnect();
  }
  now() {
    if (!this.playing) return this.position;
    return Math.min(
      this.scheduledEnd,
      this.position + Math.max(0, this.context.currentTime - this.startedAt),
    );
  }
  stop(position = this.now()) {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {}
    }
    this.sources = [];
    if (this.graph) {
      const g = this.graph;
      g.out.gain.setTargetAtTime(0, this.context.currentTime, 0.01);
      setTimeout(() => this.disposeGraph(g), 80);
    }
    this.graph = null;
    this.position = position;
    this.playing = false;
  }
  async start(take, position, mix, room, space) {
    await this.resume();
    const graph = await this.graphFor(this.context, mix, room, space),
      oldGraph = this.graph,
      oldSources = this.sources,
      wasPlaying = this.playing,
      when = this.context.currentTime + 0.04;
    this.sources = [];
    if (wasPlaying) position = this.now() + 0.04;
    if (oldGraph) {
      oldGraph.out.gain.cancelScheduledValues(this.context.currentTime);
      oldGraph.out.gain.setValueAtTime(oldGraph.out.gain.value, when);
      oldGraph.out.gain.linearRampToValueAtTime(0, when + 0.09);
      for (const source of oldSources) {
        try {
          source.stop(when + 0.1);
        } catch {}
      }
      setTimeout(() => this.disposeGraph(oldGraph), 180);
    }
    this.graph = graph;
    graph.controls = { ...take.controls };
    graph.out.gain.setValueAtTime(0, this.context.currentTime);
    graph.out.gain.setValueAtTime(0, when);
    graph.out.gain.linearRampToValueAtTime(1, when + 0.08);
    this.active = take;
    this.position = position;
    this.startedAt = when;
    this.scheduledEnd = position;
    this.playing = true;
    this.schedule(take);
  }
  schedule(take) {
    if (!this.playing || take !== this.active) return;
    let end = this.scheduledEnd;
    const deadline = this.now() + 5;
    while (end < deadline) {
      const chunk = findChunk(take, end + 0.00001);
      if (!chunk) break;
      const offset = Math.max(0, end - chunk.start),
        duration = chunk.end - end;
      if (duration < 0.0001) break;
      const when = this.startedAt + (end - this.position);
      if (when < this.context.currentTime - 0.03) break;
      chunk.stems.forEach((pcm, i) => {
        if (!this.graph.channels[i] || !pcm.length) return;
        const buffer = this.context.createBuffer(1, pcm.length, 48000);
        buffer.copyToChannel(pcm, 0);
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.graph.channels[i].gain);
        source.start(
          Math.max(this.context.currentTime, when),
          offset,
          duration,
        );
        this.sources.push(source);
        source.onended = () => {
          source.disconnect();
          const index = this.sources.indexOf(source);
          if (index >= 0) this.sources.splice(index, 1);
        };
      });
      end = chunk.end;
    }
    this.scheduledEnd = end;
  }
  underrun() {
    return (
      this.playing &&
      this.context.currentTime >
        this.startedAt + (this.scheduledEnd - this.position) + 0.015
    );
  }
}
export function findChunk(take, position) {
  if (!take) return null;
  const chunk = take.chunks.get(Math.floor(position));
  return chunk && chunk.start <= position + 0.00001 && chunk.end > position
    ? chunk
    : null;
}
export function ranges(take) {
  if (!take) return [];
  const chunks = [...take.chunks.values()].sort((a, b) => a.start - b.start),
    out = [];
  for (const c of chunks) {
    if (out.length && c.start <= out.at(-1)[1] + 0.00001)
      out.at(-1)[1] = Math.max(out.at(-1)[1], c.end);
    else out.push([c.start, c.end]);
  }
  return out;
}
