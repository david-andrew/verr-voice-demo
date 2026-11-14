import {digestBytes} from './asset-digest.js';
import {fingerprint} from './score-identity.js';
export async function loadIdentity(root,fetcher=fetch) {
 const response=await fetcher(new URL('identity.json',root));if(!response.ok)throw Error('Missing immutable release identity. Rebuild the browser app.');
 const {id,...manifest}=await response.json();
 if(manifest.schema!==1 || await fingerprint(JSON.stringify(manifest))!==id || !root.pathname.includes('/releases/'+id+'/'))throw Error('Release identity does not match the loaded code. Reload the app.');
 return Object.freeze({id,...manifest});
}
export async function wavIdentity(raw) {
 const bytes=raw instanceof Uint8Array?raw:new Uint8Array(raw),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let fmt=null,pcm=null;
 for(let at=12;at+8<=bytes.length;){const name=String.fromCharCode(...bytes.subarray(at,at+4)),n=view.getUint32(at+4,true);if(at+8+n>bytes.length)throw Error('Truncated WAV');
 if(name==='fmt ')fmt={channels:view.getUint16(at+10,true),sample_rate:view.getUint32(at+12,true),sample_width:view.getUint16(at+22,true)/8};
 if(name==='data')pcm=bytes.subarray(at+8,at+8+n);at+=8+n+(n%2);}
 if(!fmt||!pcm)throw Error('Missing PCM');
 return {schema:1,artifact_sha256:await digestBytes(bytes),pcm_sha256:await digestBytes(pcm),...fmt,frames:pcm.length/fmt.channels/fmt.sample_width,encoding:'wav-pcm-le'};
}
