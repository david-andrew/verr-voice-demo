import { sha256 } from "./score-identity.js";
let kernel;
export async function digestBytes(bytes, source) {
  if (!source && globalThis.crypto?.subtle)
    return Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  kernel ||= (async () => {
    try {
      const raw =
        source ||
        (await fetch(new URL("./sha256.wasm", import.meta.url)).then((r) => {
          if (!r.ok) throw Error();
          return r.arrayBuffer();
        }));
      return (await WebAssembly.instantiate(raw)).instance.exports;
    } catch {
      return null;
    }
  })();
  const e = await kernel;
  if (!e) return sha256(bytes);
  const input = new Uint8Array(e.memory.buffer, e.input_ptr(), 65536);
  e.reset();
  // No await between reset/update/finish: concurrent asset arrivals cannot
  // interleave separate hashes through the one small scratch instance.
  for (let at = 0; at < bytes.length; at += 65536) {
    const part = bytes.subarray(at, Math.min(bytes.length, at + 65536));
    input.set(part);
    e.update(part.length);
  }
  return Array.from(new Uint8Array(e.memory.buffer, e.finish(), 32), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
