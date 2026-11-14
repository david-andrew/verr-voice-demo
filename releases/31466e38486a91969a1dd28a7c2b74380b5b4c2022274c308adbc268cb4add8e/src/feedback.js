// Frozen audio is durable before delivery. Receipts never rewrite its contents.
import {wavIdentity} from './render-identity.js';
// Score-passage reports may arrive without a note: the frozen passage is the report.
// A saved vowel profile is logged as settings only: no clip and no note.
export const noteOptional=snapshot=>snapshot?.kind==='score-passage'||snapshot?.kind==='vowel-profile';
export const audioOptional=snapshot=>snapshot?.kind==='vowel-profile';
export function reportPayload(report) {
  const {snapshot,audio_base64,note,expected,disputed_word,producer_manifest}=report;
  return {client_report_id:report.id,captured_at:report.created,saved_at:report.saved_at,snapshot,audio_base64,note,expected,disputed_word,producer_manifest};
}
export class FeedbackInbox {
  constructor(fetcher,identity,{dbName='choir-vowel-feedback',deliveryKey='choirStudio.feedbackDelivery'}={}){this.fetch=fetcher;this.identity=identity;this.running=null;this.dbName=dbName;this.deliveryKey=deliveryKey;}
  async db(){return new Promise((resolve,reject)=>{
    const open=indexedDB.open(this.dbName,1);
    open.onupgradeneeded=()=>open.result.createObjectStore('reports',{keyPath:'id'});
    open.onerror=()=>reject(open.error);open.onsuccess=()=>resolve(open.result);
  });}
  async all(){const db=await this.db();try{return await new Promise((resolve,reject)=>{const r=db.transaction('reports').objectStore('reports').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}finally{db.close();}}
  async put(report){const db=await this.db();try{await new Promise((resolve,reject)=>{const tx=db.transaction('reports','readwrite');tx.objectStore('reports').put(report);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Feedback storage aborted'));});}finally{db.close();}}
  async updateDelivery(id,change){
    const db=await this.db();try{await new Promise((resolve,reject)=>{
      const tx=db.transaction('reports','readwrite'),store=tx.objectStore('reports'),get=store.get(id);
      get.onsuccess=()=>{if(get.result){change(get.result);store.put(get.result);}};
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Feedback update aborted'));
    });}finally{db.close();}
  }
  enabled(){try{return localStorage.getItem(this.deliveryKey)==='true';}catch{return false;}}
  async save(body){
    if(!body.snapshot||!noteOptional(body.snapshot)&&!String(body.note||'').trim())throw Error('Feedback needs an audition and a note');
    body={...body,note:String(body.note||'').trim()};
    const bytes=audioOptional(body.snapshot)&&!body.audio_base64?null:Uint8Array.from(atob(body.audio_base64||''),c=>c.charCodeAt(0));
    const audio=bytes&&await wavIdentity(bytes);
    if(audio&&body.snapshot.audio_identity&&Object.keys(audio).some(k=>audio[k]!==body.snapshot.audio_identity[k]))throw Error('Feedback audio differs from the frozen snapshot');
    const report={...body,id:globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`,created:body.captured_at||Date.now(),saved_at:Date.now(),status:'new',delivery:this.enabled()?'pending':'local'};
    if(body.snapshot.producer_identity?.id===this.identity.id)report.producer_manifest=this.identity;
    if(new TextEncoder().encode(JSON.stringify(reportPayload(report))).length>2_000_000)throw Error('Feedback is too large; shorten the note or choose a shorter clip');
    await this.put(report);
    if(this.enabled())this.flush().catch(()=>{});
    return {id:report.id,status:report.status,storage:'local',delivery:report.delivery};
  }
  async setEnabled(enabled){
    localStorage.setItem(this.deliveryKey,String(!!enabled));
    if(enabled){for(const report of await this.all())await this.updateDelivery(report.id,current=>{if(current.delivery!=='delivered')current.delivery='pending';});this.flush().catch(()=>{});}
  }
  flush(){if(this.running)return this.running;
    this.running=this.deliver().finally(()=>this.running=null);return this.running;
  }
  async deliver(){
    if(!this.enabled())return;
    for(const report of await this.all()){
      if(!this.enabled()||report.delivery!=='pending')continue;
      try{
        const response=await this.fetch('/api/feedback-inbox',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(reportPayload(report)),signal:AbortSignal.timeout(5000)});
        if(!response.ok)break;
        const receipt=await response.json();
        if(!/^[a-f0-9]{64}$/.test(receipt.id||'')||!Number.isFinite(receipt.received_at))break;
        await this.updateDelivery(report.id,current=>{current.delivery='delivered';current.receipt=receipt;current.delivered_at=Date.now();});
      }catch{break;} // Retry only the immutable payload; receiver is idempotent.
    }
  }
}
