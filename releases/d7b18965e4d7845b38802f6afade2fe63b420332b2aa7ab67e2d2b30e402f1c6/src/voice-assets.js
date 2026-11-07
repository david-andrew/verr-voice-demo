// Match performer allocation; fetching never substitutes fewer singers.
export function singerCounts(score, controls, quality=8, instruments=[], partControls=[]) {
  const voices=score.parts.filter((p,i)=>(instruments[i]??p.instrument)==='voice').length;
  return score.parts.map((p,i)=>Math.max(1,Math.min(quality,(partControls[i]||controls).size,Math.max(2,Math.floor(32/Math.max(1,voices))))));
}
export function voiceAssets(manifest,score,controls,instruments=[],partControls=[]) {
  const counts=singerCounts(score,controls,8,instruments,partControls),ids=new Set();
  score.parts.forEach((p,i)=>{
    if((instruments[i]??p.instrument)!=='voice')return;
    for(const voice of p.laneVoices||[p.voice]){
      const family=['soprano','alto'].includes(voice)?'f':'m',order=['alto','bass'].includes(voice)?[2,1,3,4]:[1,2,3,4];
      for(let n=0;n<Math.min(counts[i],4);n++)ids.add(family+order[n]);
    }
  });
  return ids.size?[manifest.mouthData,manifest.articulationData,...[...ids].map(id=>manifest.units[id])].filter(Boolean):[];
}
export function loadingText(m) {
  const mb=n=>(n/1048576).toFixed(1),amount=m.requiredBytes?`${mb(m.loadedBytes)} / ${mb(m.requiredBytes)} MB · ${m.percent}%`:`${mb(m.received||0)} MB received`;
  const eta=m.etaSeconds>=1?` · about ${m.etaSeconds<60?Math.ceil(m.etaSeconds)+' s':Math.ceil(m.etaSeconds/60)+' min'} left`:'';
  return `Loading sound · ${amount}${m.stage==='retrying'?' · retrying connection':eta}`;
}
