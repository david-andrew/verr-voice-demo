// One public-asset fetch per page, shared by all section workers. IndexedDB
// works on ordinary LAN HTTP too; private scores/recordings never enter it.
import { digestBytes } from "./asset-digest.js";
export class PublicAssets {
  constructor(progress = () => {}) {
    this.progress = progress;
    this.pending = new Map();
    this.finished = new Map();
    this.received = 0;
    this.plan = new Map();
    this.transfer = new Map();
    this.started = 0;
    this.cached = 0;
    this.database = null;
    this.unavailable = false;
  }
  setPlan(entries) {
    this.plan = new Map(entries.map(e => [e.file, e.compressedBytes || 0]));
    this.started = performance.now();
    this.receivedAtPlan = this.received;
  }
  async db() {
    if (this.unavailable) return null;
    if (!this.database)
      this.database = new Promise((resolve) => {
        // Browser storage may be blocked by profile policy. A cache is optional,
        // so it must never hold audio preparation hostage.
        const timeout = setTimeout(() => { this.unavailable = true; resolve(null); }, 1500);
        const finish = (value) => { clearTimeout(timeout); resolve(value); };
        try {
          const request = indexedDB.open("choir-public-assets", 1);
          request.onupgradeneeded = () =>
            request.result.createObjectStore("assets");
          request.onsuccess = () => {
            if (this.unavailable) { request.result.close(); return; }
            finish(request.result);
          };
          request.onerror = () => {
            this.unavailable = true;
            finish(null);
          };
          request.onblocked = () => {
            this.unavailable = true;
            finish(null);
          };
        } catch {
          this.unavailable = true;
          finish(null);
        }
      });
    return this.database;
  }
  async stored(key) {
    const db = await this.db();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = db.transaction("assets").objectStore("assets").get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  async persist(key, bytes) {
    const db = await this.db();
    if (!db) return;
    try {
      await new Promise((resolve) => {
        const tx = db.transaction("assets", "readwrite");
        tx.objectStore("assets").put(bytes, key);
        tx.oncomplete = tx.onerror = tx.onabort = resolve;
      });
    } catch {}
  }
  report(file, stage, loaded = 0, total = 0) {
    this.transfer.set(file, {loaded, total, stage});
    if (!this.plan.has(file)) this.plan.set(file, total);
    let requiredBytes = 0, loadedBytes = 0;
    for (const [name, size] of this.plan) {
      const state = this.transfer.get(name), bytes = size || state?.total || 0;
      requiredBytes += bytes;
      loadedBytes += Math.min(bytes, state?.loaded || 0);
    }
    const networkBytes = this.received - (this.receivedAtPlan || 0);
    const elapsed = (performance.now() - this.started) / 1000;
    const etaSeconds = this.started && elapsed > 1 && networkBytes > 0
      ? (requiredBytes - loadedBytes) / (networkBytes / elapsed) : null;
    this.progress({
      requiredBytes, loadedBytes, etaSeconds,
      percent: requiredBytes ? Math.min(100, Math.floor(100 * loadedBytes / requiredBytes)) : 0,
      file,
      stage,
      loaded,
      total,
      received: this.received,
      cached: this.cached,
      pending: this.pending.size,
    });
  }
  async get(entry, base) {
    const key = entry.sha256;
    if (!/^[a-f0-9]{64}$/.test(key)) throw Error("Invalid public asset digest");
    if (this.finished.has(key)) return this.finished.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = this.load(entry, base)
      .then((bytes) => {
        this.finished.set(key, bytes);
        let size = [...this.finished.values()].reduce(
          (s, b) => s + b.byteLength,
          0,
        );
        while (size > 48 * 1048576 && this.finished.size > 1) {
          const first = this.finished.keys().next().value;
          size -= this.finished.get(first).byteLength;
          this.finished.delete(first);
        }
        return bytes;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  async load(entry, base) {
    const cached = await this.stored(entry.sha256);
    if (cached) {
      this.cached += cached.byteLength;
      this.report(entry.file, "cached", cached.byteLength, cached.byteLength);
      return cached;
    }
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      let timer;
      const heartbeat = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), 20000);
      };
      try {
        heartbeat();
        this.report(
          entry.file,
          attempt ? "retrying" : "downloading",
          0,
          entry.compressedBytes || 0,
        );
        const url = new URL(entry.file, base);
        url.searchParams.set("v", entry.sha256);
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok)
          throw Error(`Could not download voice data (${response.status})`);
        const reader = response.body.getReader(),
          parts = [];
        let loaded = 0,
          total =
            Number(response.headers.get("Content-Length")) ||
            entry.compressedBytes ||
            0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          heartbeat();
          parts.push(value);
          loaded += value.length;
          this.received += value.length;
          this.report(entry.file, "downloading", loaded, total);
        }
        clearTimeout(timer);
        const bytes = new Uint8Array(loaded);
        let offset = 0;
        for (const p of parts) {
          bytes.set(p, offset);
          offset += p.length;
        }
        this.report(entry.file, "checking", loaded, loaded);
        const digest = await digestBytes(bytes);
        if (digest !== entry.sha256)
          throw Error("Public voice data checksum mismatch");
        await this.persist(entry.sha256, bytes.buffer);
        this.report(entry.file, "ready", loaded, loaded);
        return bytes.buffer;
      } catch (error) {
        last = error;
        clearTimeout(timer);
        controller.abort();
      }
    }
    throw Error(
      `Voice data could not be loaded: ${last?.message}. Check the connection and reload to retry; completed downloads are saved.`,
    );
  }
}
export function unpackFloatBank(raw, encoding) {
  if (!encoding) return raw;
  if (encoding !== "xor-shuffle-f32-v1" || raw.byteLength % 4)
    throw Error("Unsupported voice-data format");
  const bytes = new Uint8Array(raw),
    n = bytes.length / 4,
    out = new Uint32Array(n);
  let previous = 0;
  for (let i = 0; i < n; i++) {
    previous =
      (previous ^
        (bytes[i] |
          (bytes[n + i] << 8) |
          (bytes[2 * n + i] << 16) |
          (bytes[3 * n + i] << 24))) >>>
      0;
    out[i] = previous;
  }
  return out.buffer;
}
