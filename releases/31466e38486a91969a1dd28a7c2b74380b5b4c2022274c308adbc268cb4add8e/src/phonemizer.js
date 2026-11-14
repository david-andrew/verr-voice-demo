import { preparePronunciation } from './pronunciation.js';
const voices={english:'en-gb',american:'en-us',french:'fr-fr',greek:'el',german:'de'};
// User lyrics live only in memory and local worker messages. Only public
// dictionary files are fetched; there is no pronunciation service endpoint.
export class LocalPronunciation {
 constructor(){this.cache=new Map();this.pending=new Map();this.serial=0;this.worker=null;}
 start(){
  if(this.worker)return;
  this.worker=new Worker(new URL('./phonemizer-worker.js',import.meta.url),{type:'module'});
  this.worker.onmessage=({data})=>{const p=this.pending.get(data.id);if(!p)return;this.pending.delete(data.id);clearTimeout(p.timer);data.error?p.reject(Error(data.error)):p.resolve(data.results);};
  this.worker.onerror=e=>this.fail(Error(e.message||'Local pronunciation worker failed'));
 }
 fail(error){this.worker?.terminate();this.worker=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
 request(requests){
  this.start();const id=++this.serial;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>this.fail(Error('Local pronunciation files did not load. Reload to retry.')),30000);this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,requests});});
 }
 async prepare(score,config,overrides={},accent='choral',vowelProfile=null){
  const missing=new Map(),dictionary={};
  const lookup=(word,language,accent)=>{
   const category=language==='english'&&accent==='american'?'american':language;
   if(!voices[category])return;
   const key=`${category}:${word}`;
   if(this.cache.has(key)){const ipa=this.cache.get(key);(dictionary[category]||={})[word]=ipa;return ipa;}
   missing.set(key,{key,word,category,voice:voices[category]});
  };
  const localConfig={...config,lookupPronunciation:lookup};
  // Whole-word lookup can reveal a syllable-count mismatch that then needs
  // fragment lookups. Resolve both stages before handing a take to workers.
  for(let pass=0;pass<3;pass++){
   missing.clear();
   // The same vowel profile as the render worker, so the summary the studio
   // shows (profile pronunciations, vowel maps) is what is sung.
   preparePronunciation(score,localConfig,overrides,accent,undefined,vowelProfile);
   if(!missing.size)break;
   if(pass===2)throw Error('Could not resolve the score pronunciation');
   const results=await this.request([...missing.values()]);
   for(const r of results)this.cache.set(r.key,r.ipa);
  }
  while(this.cache.size>8192)this.cache.delete(this.cache.keys().next().value);
  return dictionary;
 }
}
