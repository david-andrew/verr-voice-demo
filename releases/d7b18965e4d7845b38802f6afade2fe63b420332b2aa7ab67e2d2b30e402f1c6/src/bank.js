import { unpackFloatBank, PublicAssets } from "./assets.js";
const fallbackAssets = new PublicAssets();
export async function readBlob(
  entry,
  base = new URL("../public/assets/", import.meta.url).href,
  provider = null,
) {
  let bytes;
  if (provider) bytes = await provider(entry, base);
  else
    bytes = await fallbackAssets.get(
      entry,
      new URL(base, globalThis.location?.href || import.meta.url).href,
    );
  const packed = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).arrayBuffer();
  const raw = unpackFloatBank(packed, entry.encoding);
  if (raw.byteLength !== entry.bytes) throw Error("Bank length mismatch");
  const fields = {};
  for (const [key, f] of Object.entries(entry.fields))
    fields[key] = new Float32Array(
      raw,
      f.offset * 4,
      f.shape.reduce((a, b) => a * b, 1),
    );
  return { fields, bytes: raw.byteLength };
}
export class Bank {
  constructor(manifest, base, provider = null) {
    this.provider = provider;
    this.manifest = manifest;
    this.base = base;
    this.singers = new Map();
    this.bytes = 0;
    this.resident = new Map();
    this.mouthPromise = null;
    this.mouthBytes = 0;
  }
  retain(identities) {
    // New scores discard analyses that this section worker no longer needs.
    for (const identity of this.singers.keys())
      if (!identities.has(identity)) {
        this.singers.delete(identity);
        this.bytes -= this.resident.get(identity) || 0;
        this.resident.delete(identity);
      }
    if (!identities.size) {
      this.bytes -= this.mouthBytes;
      this.mouthBytes = 0;
      this.mouth = null;
      this.mouthPromise = null;
    }
  }
  async load(identity) {
    if (this.singers.has(identity)) return this.singers.get(identity);
    const entry = this.manifest.units[identity];
    const promise = readBlob(entry, this.base, this.provider).then(
      ({ fields, bytes }) => {
        if(this.singers.get(identity)===promise) {
          this.bytes += bytes;
          this.resident.set(identity,bytes);
        }
        return entry.units.map((u) => ({
          ...u,
          log: fields[u.key + "/log_power"],
          ap: fields[u.key + "/aperiodicity"],
          motion: fields[u.key + "/pitch_motion"],
        }));
      },
    );
    this.singers.set(identity, promise);
    promise.catch(()=>{if(this.singers.get(identity)===promise)this.singers.delete(identity);});
    return promise;
  }
  async loadMouth() {
    if(this.mouthPromise)return this.mouthPromise;
    const promise=(async()=>{
      const [base,articulation]=await Promise.all([
        readBlob(this.manifest.mouthData,this.base,this.provider),
        this.manifest.articulationData ? readBlob(this.manifest.articulationData,this.base,this.provider) : null,
      ]);
      const {fields}=base;
      const mouth=Object.fromEntries(Object.entries(this.manifest.mouth).map(([p,u])=>[p,{
        ...u,times:fields[p+'/times'],delta:fields[p+'/harmonic_delta'],noise:fields[p+'/noise_shape'],ratio:fields[p+'/noise_ratio'],hratio:fields[p+'/harmonic_ratio'],
      }]));
      mouth.profiles={};
      if(articulation)for(const [phone,meta] of Object.entries(this.manifest.articulation)){
        mouth.profiles[phone]={...meta};
        for(const key of ['noise_times','noise_power','noise_ratio','edge_times','log_delta','ap_delta'])mouth.profiles[phone][key]=articulation.fields[phone+'/'+key];
      }
      if(this.mouthPromise===promise){
        this.mouth=mouth;
        this.mouthBytes=base.bytes+(articulation?.bytes||0);
        this.bytes+=this.mouthBytes;
      }
      return mouth;
    })();
    this.mouthPromise=promise;
    promise.catch(()=>{if(this.mouthPromise===promise)this.mouthPromise=null;});
    return promise;
  }
}
