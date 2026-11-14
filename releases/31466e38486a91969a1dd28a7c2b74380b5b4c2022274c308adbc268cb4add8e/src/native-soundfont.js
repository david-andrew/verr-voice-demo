import { instrumentVelocity } from "./score-dynamics.js";
// The main studio's TinySoundFont engine, compiled to local WASM.
// Samples are shared by handles; retained PCM is bounded per instrument.
export class NativeSoundFont {
  static async load(buffer, wasmBytes) {
    const bytes =
      wasmBytes ||
      (await fetch(new URL("./soundfont.wasm", import.meta.url)).then((r) => {
        if (!r.ok) throw Error("Missing SoundFont renderer");
        return r.arrayBuffer();
      }));
    const { instance } = await WebAssembly.instantiate(bytes, {
      math: {
        pow: Math.pow,
        exp: Math.exp,
        log: Math.log,
        log10: Math.log10,
        tan: Math.tan,
      },
    });
    return new NativeSoundFont(instance.exports, buffer);
  }
  constructor(exports, buffer) {
    this.e = exports;
    this.buffer = { byteLength: buffer.byteLength };
    const p = this.e.allocate(buffer.byteLength);
    if (!p) throw Error("Not enough memory to load SoundFont");
    new Uint8Array(this.e.memory.buffer, p, buffer.byteLength).set(
      new Uint8Array(buffer),
    );
    this.source = this.e.tsf_load_memory(p, buffer.byteLength);
    this.e.release(p);
    if (!this.source) throw Error("Cannot read SoundFont");
    this.presets = [];
    for (let bank = 0; bank <= 128; bank++)
      for (let program = 0; program < 128; program++) {
        const index = this.e.tsf_get_presetindex(this.source, bank, program);
        if (index < 0) continue;
        const ptr = this.e.tsf_get_presetname(this.source, index),
          bytes = new Uint8Array(this.e.memory.buffer, ptr, 64),
          end = bytes.indexOf(0);
        this.presets.push({
          name: new TextDecoder().decode(bytes.subarray(0, end)),
          bank,
          program,
          index,
        });
      }
  }
  part(events, program, bank = 0) {
    return new NativeInstrument(this, events, program, bank);
  }
}
export class NativeInstrument {
  constructor(font, events, program, bank) {
    this.font = font;
    this.e = font.e;
    this.bank = bank;
    this.preset = this.e.tsf_get_presetindex(font.source, bank, program);
    if (this.preset < 0)
      throw Error(`SoundFont has no bank ${bank}, program ${program + 1}`);
    this.headroom=events.reduce((m,e)=>Math.max(m,instrumentVelocity(e.dynamic)),1);
    this.events = events
      .flatMap((e) => [
        {
          at: Math.round(e.start * 48000),
          on: 1,
          key: Math.round(e.midi),
          velocity: instrumentVelocity(e.dynamic)/this.headroom,
        },
        {
          at: Math.round((e.start + e.duration) * 48000),
          on: 0,
          key: Math.round(e.midi),
        },
      ])
      .sort((a, b) => a.at - b.at || a.on - b.on || a.key - b.key);
    this.cache = new Map();
    this.scratch = this.e.allocate(12000 * 4);
    if (!this.scratch) throw Error("Not enough instrument memory");
    this.reset();
  }
  reset() {
    if (this.handle) this.e.tsf_close(this.handle);
    this.handle = this.e.tsf_copy(this.font.source);
    if (!this.handle) throw Error("Not enough instrument memory");
    this.e.tsf_set_output(this.handle, 2, 48000, -14+20*Math.log10(this.headroom));
    this.generated = 0;
    this.event = 0;
    this.cache.clear();
  }
  dispose() {
    if (this.handle) this.e.tsf_close(this.handle);
    this.handle = 0;
    this.e.release(this.scratch);
    this.cache.clear();
  }
  render(start, end) {
    const a = Math.round(start * 48000),
      b = Math.round(end * 48000),
      out = new Float32Array(b - a),
      first = Math.floor(a / 12000) * 12000;
    if (first < this.generated && !this.cache.has(first)) this.reset();
    while (this.generated < b) {
      const begin = this.generated,
        finish = begin + 12000;
      let cursor = begin;
      const render = (count) => {
        if (count > 0) {
          this.e.tsf_render_float(
            this.handle,
            this.scratch + (cursor - begin) * 4,
            count,
            0,
          );
          cursor += count;
        }
      };
      while (
        this.event < this.events.length &&
        this.events[this.event].at < finish
      ) {
        const event = this.events[this.event++];
        render(event.at - cursor);
        if (event.on)
          this.e.tsf_note_on(
            this.handle,
            this.preset,
            event.key,
            event.velocity,
          );
        else if (this.bank !== 128)
          this.e.tsf_note_off(this.handle, this.preset, event.key);
      }
      render(finish - cursor);
      this.cache.set(
        begin,
        new Float32Array(this.e.memory.buffer, this.scratch, 12000).slice(),
      );
      this.generated = finish;
      while (this.cache.size > 64)
        this.cache.delete(this.cache.keys().next().value);
    }
    for (let at = first; at < b; at += 12000) {
      const pcm = this.cache.get(at);
      if (!pcm) throw Error("Instrument window exceeds retained cache");
      const left = Math.max(a, at),
        right = Math.min(b, at + 12000);
      out.set(pcm.subarray(left - at, right - at), left - a);
    }
    return out;
  }
}
