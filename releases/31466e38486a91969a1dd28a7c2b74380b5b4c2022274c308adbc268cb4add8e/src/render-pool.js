import { PublicAssets } from "./assets.js";
// Independent section workers: works on plain LAN HTTP without shared memory.
export class RenderPool {
  constructor(
    count = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1)),
  ) {
    this.assets = new PublicAssets((data) =>
      this.onmessage?.({ data: { type: "progress", ...data } }),
    );
    this.count = count;
    this.pending = new Map();
    this.workers = Array.from({ length: count }, (_, index) => {
      const worker = new Worker(new URL("./worker.js", import.meta.url), {
        type: "module",
      });
      worker.onmessage = ({ data }) => this.receive(index, data);
      worker.onerror = (e) => this.onerror?.(e);
      return worker;
    });
  }
  postMessage(message) {
    if (["font","vowel"].includes(message.type)) {
      this.workers[0].postMessage(message);
      return;
    }
    if (message.request)
      this.pending.set(message.request, {
        responses: new Map(),
        type: message.type,
      });
    this.workers.forEach((worker, index) =>
      worker.postMessage({
        ...message,
        rendererIndex: index,
        rendererCount: this.count,
      }),
    );
  }
  receive(index, data) {
    if (data.type === "asset") {
      this.assets
        .get(data.entry, data.base)
        .then((buffer) => {
          const copy = buffer.slice(0);
          this.workers[index].postMessage(
            { type: "asset-result", assetId: data.assetId, buffer: copy },
            [copy],
          );
        })
        .catch((error) =>
          this.workers[index].postMessage({
            type: "asset-result",
            assetId: data.assetId,
            error: error.message,
          }),
        );
      return;
    }
    if (!data.request || ["font","vowel"].includes(data.type)) {
      this.onmessage?.({ data });
      return;
    }
    const pending = this.pending.get(data.request);
    if (!pending) { this.onmessage?.({data}); return; }
    if (data.type === "error") {
      this.pending.delete(data.request);
      this.onmessage?.({ data });
      return;
    }
    pending.responses.set(index, data);
    if (pending.responses.size < this.count) return;
    this.pending.delete(data.request);
    if (data.type === "chunk") {
      const responses = [...pending.responses.values()];
      data = {
        ...data,
        stems: data.stems.map(
          (_, pi) => pending.responses.get(pi % this.count).stems[pi],
        ),
        backends: [...new Set(responses.flatMap(r=>r.backends||[]))].sort(),
        elapsed: Math.max(...responses.map((r) => r.elapsed)),
        cpuMs: responses.reduce((s, r) => s + r.elapsed, 0),
        bankBytes: responses.reduce((s, r) => s + r.bankBytes, 0),
        fontBytes: responses.reduce((s, r) => s + r.fontBytes, 0),
      };
    }
    this.onmessage?.({ data });
  }
  terminate() {
    this.workers.forEach((w) => w.terminate());
    this.pending.clear();
  }
}
