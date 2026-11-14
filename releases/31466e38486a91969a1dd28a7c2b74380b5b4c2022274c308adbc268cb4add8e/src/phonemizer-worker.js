// GPL-3.0-or-later: standalone eSpeak NG pronunciation worker.
// License and corresponding sources: ../public/espeak/NOTICE.html.
import { createEspeak } from '../public/espeak/dist/browser.js';
let engine, queue=Promise.resolve();
onmessage=({data})=>{
 queue=queue.catch(()=>{}).then(async()=>{
  try {
   engine ||= await createEspeak({dataUrl:new URL('../public/espeak/espeak-ng-data/',import.meta.url).href});
   const results=[];
   for(const request of data.requests){
    await engine.loadVoice(request.voice);
    results.push({...request,ipa:engine.phonemes(request.word,{separator:'\u200d',tie:true}).trim()});
   }
   postMessage({id:data.id,results,version:engine.version});
  } catch(error){postMessage({id:data.id,error:error.message || String(error)});}
 });
};
