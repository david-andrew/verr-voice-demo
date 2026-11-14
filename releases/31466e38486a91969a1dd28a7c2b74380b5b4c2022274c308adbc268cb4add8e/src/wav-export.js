// Bounded-workspace export: mix/convolve one passage at a time, then encode
// with one gain for the whole performance. No full-length stem buffers or
// OfflineAudioContext are allocated. Temporary PCM stays on this device.
import { AudioEngine, renderOffline } from "./audio.js";
import { panOffset, planes } from "./stage.js";
class TemporaryPCM {
  constructor() {
    this.name = `choir-export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.blocks = [];
    this.db = null;
  }
  async open() {
    // Recover temporary stores left by a crashed browser. Never inspect or
    // remove the public asset cache, uploads, or another recent export.
    try {
      for (const entry of (await indexedDB.databases?.()) || []) {
        const match = /^choir-export-(\d+)-/.exec(entry.name || "");
        if (match && Date.now() - Number(match[1]) > 7 * 86400000)
          indexedDB.deleteDatabase(entry.name);
      }
    } catch {}
    try {
      this.db = await new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            done = true;
            resolve(null);
          }, 1500),
          r = indexedDB.open(this.name, 1);
        r.onupgradeneeded = () => r.result.createObjectStore("pcm");
        r.onsuccess = () => {
          clearTimeout(timer);
          if (done) {
            r.result.close();
            indexedDB.deleteDatabase(this.name);
          } else resolve(r.result);
        };
        r.onerror = r.onblocked = () => {
          clearTimeout(timer);
          resolve(null);
        };
      });
    } catch {}
  }
  async put(channels) {
    const index = this.blocks.length;
    this.blocks.push(channels[0].length);
    if (!this.db) {
      this.blocks[index] = new Blob(channels);
      return;
    }
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction("pcm", "readwrite");
      tx.objectStore("pcm").put(channels, index);
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () =>
        reject(
          Error(
            "Temporary download storage is full. Free some browser storage and retry.",
          ),
        );
    });
  }
  async get(index, channels) {
    if (!this.db) {
      const all = new Float32Array(await this.blocks[index].arrayBuffer()),
        n = all.length / channels;
      return Array.from({ length: channels }, (_, c) =>
        all.subarray(c * n, (c + 1) * n),
      );
    }
    return new Promise((resolve, reject) => {
      const request = this.db.transaction("pcm").objectStore("pcm").get(index);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async close() {
    this.blocks = [];
    if (this.db) {
      this.db.close();
      indexedDB.deleteDatabase(this.name);
      this.db = null;
    }
  }
}
function header(frames, channels) {
  const b = new ArrayBuffer(44),
    v = new DataView(b),
    str = (at, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
    };
  str(0, "RIFF");
  v.setUint32(4, 36 + frames * channels * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, 48000, true);
  v.setUint32(28, 48000 * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, frames * channels * 2, true);
  return b;
}
export async function exportPassages(
  take,
  body,
  manifest,
  render,
  signal,
  progress = () => {},
) {
  const check = () => {
      if (signal?.aborted) throw new DOMException("Canceled", "AbortError");
    },
    storage = new TemporaryPCM();
  const channels = body.stem_id ? take.header.stems.find((s) => s.part_id === body.stem_id)?.channels || 1 : 2,
    roomEngine = new AudioEngine(manifest),
    room = body.stem_id ? null : take.header.playback.room,
    tail = room ? room.frames - 1 : 0,
    frames = take.frames + tail,
    stemIndex = take.header.stems.findIndex((s) => s.part_id === body.stem_id);
  const mix = take.header.stems.map((s) => {
    const m = body.balance?.[s.part_id] || {};
    const db = m.db ?? 0,
      pan = m.pan ?? s.pan;
    if (
      !Number.isFinite(db) ||
      db < -24 ||
      db > 6 ||
      !Number.isFinite(pan) ||
      pan < -1 ||
      pan > 1
    )
      throw Error("Invalid voice balance");
    return { pan: panOffset(s.channels, pan, s.pan), level: 10 ** (db / 20), mute: !!m.mute, solo: !!m.solo };
  });
  let carry = Array.from({ length: channels }, () => new Float32Array(tail)),
    peak = 0;
  async function save(data) {
    for (const channel of data)
      for (const x of channel) {
        if (!Number.isFinite(x)) throw Error("Invalid audio during export");
        peak = Math.max(peak, Math.abs(x));
      }
    await storage.put(data);
  }
  try {
    await storage.open();
    for (let at = 0; at < take.frames; at += 96000) {
      check();
      const end = Math.min(take.frames, at + 96000),
        count = end - at,
        result = await render(take, at / 48000, end / 48000, signal);
      let data;
      if (body.stem_id) {
        data = result.stems[stemIndex].length
          ? planes(result.stems[stemIndex], count)
          : Array.from({ length: channels }, () => new Float32Array(count));
      } else {
        const off = new OfflineAudioContext(2, count + tail, 48000),
          graph = await roomEngine.graphFor(
            off,
            mix,
            room ? take.room : "dry",
            room ? room.wet_mix / 0.48 : 0,
          );
        const sources=[];
        for (let i = 0; i < result.stems.length; i++) {
          const pcm = result.stems[i];
          if (!pcm.length) continue;
          const channelData = planes(pcm, count),
            buffer = off.createBuffer(channelData.length, count, 48000);
          channelData.forEach((plane, c) => buffer.copyToChannel(plane, c));
          const source = off.createBufferSource();
          source.buffer = buffer;
          source.connect(graph.channels[i].gain);
          source.start();
          sources.push(source);
        }
        const output = await renderOffline(off,sources,graph),
          merged = [output.getChannelData(0), output.getChannelData(1)];
        for (let c = 0; c < 2; c++)
          for (let i = 0; i < carry[c].length; i++) merged[c][i] += carry[c][i];
        carry = merged.map((a) => a.slice(count));
        data = merged.map((a) => a.slice(0, count));
      }
      await save(data);
      progress({ stage: "exporting", completed: end, total: take.frames });
    }
    if (tail) await save(carry);
    const scale = Math.min(1, 0.98 / Math.max(peak, 1e-12)),
      parts = [header(frames, channels)];
    for (let block = 0; block < storage.blocks.length; block++) {
      check();
      const data = await storage.get(block, channels),
        n = data[0].length,
        bytes = new Uint8Array(n * channels * 2),
        v = new DataView(bytes.buffer);
      for (let i = 0; i < n; i++)
        for (let c = 0; c < channels; c++)
          v.setInt16(
            (i * channels + c) * 2,
            Math.round(Math.max(-1, Math.min(1, data[c][i] * scale)) * 32767),
            true,
          );
      parts.push(new Blob([bytes]));
    }
    return {
      blob: new Blob(parts, { type: "audio/wav" }),
      reductionDb: scale < 1 ? -20 * Math.log10(scale) : 0,
    };
  } finally {
    await storage.close();
  }
}
