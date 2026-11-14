// NumPy v2.3.5 SeedSequence/PCG64/normal compatibility. MIT/BSD attributions
// and pinned source checksums are in licenses/NumPy-random.txt and dsp/numpy/.
import { ki_double, wi_double, fi_double, ziggurat_nor_r, ziggurat_nor_inv_r } from './normal-constants.js';
export function seedSequence(entropy,count=8){
 const words=[];for(let n of Array.isArray(entropy)?entropy:[entropy]){if(!Number.isSafeInteger(n)||n<0)throw Error('Random seed must be a nonnegative safe integer');do{words.push(n>>>0);n=Math.floor(n/4294967296);}while(n);}
 let constant=0x43b0d7e5;
 const hash=value=>{value^=constant;constant=Math.imul(constant,0x931e8875)>>>0;value=Math.imul(value,constant)>>>0;return (value^(value>>>16))>>>0;};
 const mix=(x,y)=>{const value=(Math.imul(0xca01f9dd,x)-Math.imul(0x4973f715,y))>>>0;return (value^(value>>>16))>>>0;};
 const pool=Uint32Array.from({length:4},(_,i)=>hash(words[i]||0));
 for(let i=0;i<4;i++)for(let j=0;j<4;j++)if(i!==j)pool[j]=mix(pool[j],hash(pool[i]));
 for(let i=4;i<words.length;i++)for(let j=0;j<4;j++)pool[j]=mix(pool[j],hash(words[i]));
 constant=0x8b51f9dd;
 return Uint32Array.from({length:count},(_,i)=>{let value=pool[i%4]^constant;constant=Math.imul(constant,0x58f38ded)>>>0;value=Math.imul(value,constant)>>>0;return (value^(value>>>16))>>>0;});
}
let backend=null;
export const randomBackend=()=>backend?"wasm-pcg64":"javascript-pcg64";
export async function initRandom(bytes){
 if(backend)return true;
 try{bytes ||= await fetch(new URL('./random.wasm',import.meta.url)).then(r=>{if(!r.ok)throw Error('Random WASM missing');return r.arrayBuffer()});const {instance}=await WebAssembly.instantiate(bytes,{env:{log1p:Math.log1p,exp:Math.exp}});backend=instance.exports;return true;}catch{return false;}
}
const MASK=(1n<<128n)-1n,MASK64=(1n<<64n)-1n,MULT=0x2360ed051fc65da44385df649fccf645n;
export class NativeRandom {
 constructor(entropy,{javascript=false}={}){
  const words=seedSequence(entropy);this.backend=javascript?null:backend;
  if(this.backend){const e=this.backend;new Uint32Array(e.memory.buffer,e.seed_ptr(),8).set(words);e.seed();this.state=new Uint32Array(e.memory.buffer,e.state_ptr(),8).slice();}
  else {const u64=i=>BigInt(words[i*2])|(BigInt(words[i*2+1])<<32n),initial=(u64(0)<<64n)|u64(1),sequence=(u64(2)<<64n)|u64(3);this.state=0n;this.increment=((sequence<<1n)|1n)&MASK;this.step();this.state=(this.state+initial)&MASK;this.step();}
 }
 step(){this.state=(this.state*MULT+this.increment)&MASK;}
 next64(){this.step();const value=((this.state>>64n)^this.state)&MASK64,rotation=this.state>>122n;return ((value>>rotation)|(value<<((-rotation)&63n)))&MASK64;}
 invoke(method,n){const e=this.backend;new Uint32Array(e.memory.buffer,e.state_ptr(),8).set(this.state);e.restore();const value=e[method](n);e.save();this.state.set(new Uint32Array(e.memory.buffer,e.state_ptr(),8));return value;}
 uniform(low=0,high=1){const value=this.backend?this.invoke('uniform'):Number(this.next64()>>11n)*2**-53;return low+(high-low)*value;}
 standardNormal(){
  if(this.backend)return this.invoke('normal');
  for(;;){let r=this.next64(),idx=Number(r&255n);r>>=8n;const sign=Number(r&1n),rabs=Number((r>>1n)&0xfffffffffffffn);let x=rabs*wi_double[idx];if(sign)x=-x;if(rabs<ki_double[idx])return x;
   if(idx===0){for(;;){const xx=-ziggurat_nor_inv_r*Math.log1p(-this.uniform()),yy=-Math.log1p(-this.uniform());if(yy+yy>xx*xx)return (Math.floor(rabs/256)%2)?-(ziggurat_nor_r+xx):ziggurat_nor_r+xx;}}
   else if((fi_double[idx-1]-fi_double[idx])*this.uniform()+fi_double[idx]<Math.exp(-.5*x*x))return x;
  }
 }
 normal(scale=1,mean=0){return mean+scale*this.standardNormal();}
 normals(count,scale=1){const out=new Float64Array(count);if(!this.backend){for(let i=0;i<count;i++)out[i]=this.normal(scale);return out;}
  for(let at=0;at<count;at+=8192){const n=Math.min(8192,count-at);this.invoke('normals',n);const raw=new Float64Array(this.backend.memory.buffer,this.backend.output_ptr(),n);for(let i=0;i<n;i++)out[at+i]=raw[i]*scale;}return out;
 }
}
const noiseBlocks=new Map();
export function noiseInterval(seed,start,end){const result=new Float32Array(end-start);for(let block=Math.floor(start/4096);block<=Math.floor((end-1)/4096);block++){
 const key=`${seed}:${block}`;let data=noiseBlocks.get(key);if(!data){data=Float32Array.from(new NativeRandom([seed,block+2**31]).normals(4096));noiseBlocks.set(key,data);while(noiseBlocks.size>128)noiseBlocks.delete(noiseBlocks.keys().next().value);}
 const a=Math.max(start,block*4096),b=Math.min(end,(block+1)*4096);result.set(data.subarray(a-block*4096,b-block*4096),a-start);
 }return result;}
