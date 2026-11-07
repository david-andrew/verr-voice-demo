// Presentation only: controls delegate to the existing browser audio pipeline.
const $ = id => document.getElementById(id);
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const titles = {
 'sanctus_satb.musicxml':['Sanctus','Traditional liturgical polyphony · SATB · Latin'],
 'ave_verum_corpus_satb.musicxml':['Ave verum corpus','W. A. Mozart · SATB · Latin'],
 'tallis_canon_english_satb.musicxml':["Tallis’ Canon",'Thomas Tallis · SATB · English'],
 'amazing_grace_solo.musicxml':['Amazing Grace','Traditional · Solo · English'],
};
let presets = [];
export function mountStudio(config) {
 presets = config.presets;
 $('score-list').innerHTML = [...$('library').options].map(o => {
   const [title,detail] = titles[o.value] || [o.textContent,''];
   o.textContent = title;
   return `<label class="choice"><input type="radio" name="score-choice" value="${escape(o.value)}"><span class="face"><span class="t">${escape(title)}</span><span class="s">${escape(detail)}</span></span></label>`;
 }).join('');
 $('score-list').onchange = e => { $('library').value=e.target.value; $('library').dispatchEvent(new Event('change')); };
 $('ensemble-grid').innerHTML = presets.map(p => `<label class="choice"><input type="radio" name="ensemble-choice" value="${escape(p.id)}"><span class="face"><span class="t">${escape(p.name)}</span><span class="s">${p.controls.size} per part · ${p.controls.vibrato < .3 ? 'a hint of vibrato' : 'expressive vibrato'}</span></span></label>`).join('');
 $('ensemble-grid').onchange = e => { $('preset').value=e.target.value; $('preset').dispatchEvent(new Event('change')); };
 for (const [title,keys] of [['Ensemble',['size','blend','tuning','precision']],['Voice & tone',['phonation','weight','timbre','vibrato','age']],['Articulation & room',['articulation','space']]]) {
   const group=document.createElement('details');group.className='group';group.open=true;
   const summary=document.createElement('summary');summary.textContent=title;group.append(summary);
   for(const key of keys) {
     const control=$('control-'+key).closest('.control');
     const reset=document.createElement('button');reset.type='button';reset.className='reset-control';reset.textContent='Reset';reset.setAttribute('aria-label','Reset '+control.querySelector('label').textContent);
     reset.onclick=()=>{const p=presets.find(p=>p.id===$('preset').value);if(p){$('control-'+key).value=p.controls[key];$('control-'+key).dispatchEvent(new Event('input'));}};
     control.append(reset);group.append(control);
   }
   $('controls').append(group);
 }
 $('mini-play').onclick=()=>$('play').click();
 $('back-player').onclick=()=>$('player-card').scrollIntoView({behavior:'smooth',block:'start'});
 let playerVisible=true;
 const refreshBar=()=> $('minibar').classList.toggle('show',!playerVisible);
 new IntersectionObserver(entries=>{playerVisible=entries[0].isIntersecting;refreshBar();},{threshold:0}).observe($('player-card'));
 const drop=$('drop-zone');
 for(const event of ['dragenter','dragover'])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.add('over');});
 drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
 drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('over');if(e.dataTransfer.files.length)$('upload').onchange({target:{files:e.dataTransfer.files}});});
}
export function syncStudio(controls, isA=false) {
 if(!presets.length)return;
 const preset=presets.find(p=>p.id===controls.preset_id) || presets[0];
 $('preset').value=preset.id;
 $('ensemble-name').textContent=preset.name;
 $('ensemble-tradition').textContent=preset.tradition || '';
 $('preset-description').textContent=preset.description;
 const changed=Object.keys(preset.controls).filter(k=>typeof preset.controls[k]==='number' && Math.abs(controls[k]-preset.controls[k])>1e-6).length;
 $('preset-badge').textContent=changed ? `Custom · based on ${preset.name}` : `Preset · ${preset.name}`;
 $('preset-badge').classList.toggle('custom',!!changed);
 document.querySelectorAll('[name=ensemble-choice]').forEach(r=>r.checked=r.value===preset.id);
 document.querySelectorAll('[name=score-choice]').forEach(r=>r.checked=r.value===$('library').value && !$('drop-zone').classList.contains('selected'));
 $('take-letter').textContent=isA?'A':'B';
 $('mini-play').disabled=$('play').disabled;
 $('mini-play').textContent=$('play').textContent;
 $('mini-title').textContent=$('title').textContent;
 $('mini-time').textContent=$('time').textContent;
 document.querySelectorAll('input[type=range]').forEach(input => input.style.setProperty('--fill', `${100*(Number(input.value)-Number(input.min))/(Number(input.max)-Number(input.min)||1)}%`));
}
