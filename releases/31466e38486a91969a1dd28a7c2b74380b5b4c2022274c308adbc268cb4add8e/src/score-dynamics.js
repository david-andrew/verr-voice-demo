// Twin of score/dynamics.py. Resolve musical time before evaluating notes:
// XML sibling order must not change a hairpin's start/target dynamic.
// Instruments follow the voices' wider range, so a soft passage keeps its balance.
// Unclipped target gain; each instrument reserves velocity headroom and restores
// it at its output. Unmarked .76 parts keep exactly the old settings and PCM.
export const instrumentVelocity=(dynamic)=>dynamic*(dynamic/.76)**1.35;
// Where a note samples the curve, as fractions of its length.
export const NOTE_POINTS=[.1,.3,.5,.7,.9];
// [midpoint dynamic, shape]; shape is null for a note the curve doesn't move.
export function noteShape(curve,beat,beats,toSeconds=x=>x){
  const end=beat+beats,origin=toSeconds(beat),length=Math.max(toSeconds(end)-origin,1e-9),
    points=[[0,curve(beat),curve(beat)]],
    knots=new Map(curve.breakpoints.map(([t,left,right])=>[t,[left,right]])),
    times=[...new Set([beat,end,...(toSeconds.breakpoints||[]),...knots.keys()])].sort((a,b)=>a-b);
  for(const t of times)if(t>beat&&t<end){const [left,right]=knots.get(t)||[curve(t),curve(t)];points.push([(toSeconds(t)-origin)/length,left,right]);}
  const left=knots.get(Math.round(end*1e8)/1e8)?.[0]??curve(end);
  points.push([1,left,left]);
  const values=points.flatMap(p=>p.slice(1));
  return [curve(beat+.5*beats),Math.max(...values)-Math.min(...values)>1e-9?points:null];
}
export function dynamicCurve(marks, wedges, initial=.76) {
  const key=t=>Math.round(t*1e8)/1e8;
  marks=new Map(marks.map(([t,v])=>[key(t),v]));
  const starts=new Map(wedges.filter(w=>w.end>w.start).map(w=>[key(w.start),[key(w.end),w.type]]));
  const times=[...new Set([0,...marks.keys(),...starts.keys(),...[...starts.values()].map(w=>w[0])])].sort((a,b)=>a-b);
  let value=initial,active=null;const segments=[],breakpoints=[];
  for(const t of times){
    if(active){const [a,b,low,high]=active;value=low+Math.min(1,(t-a)/(b-a))*(high-low);if(t>=b)active=null;}
    const left=Math.max(.28,Math.min(1,value));
    if(marks.has(t)){value=marks.get(t);if(active)active=[t,active[1],value,active[3]];}
    if(starts.has(t)){
      const [end,type]=starts.get(t),target=marks.get(end)??Math.max(.30,Math.min(1,value+(type==='crescendo'?.14:-.14)));
      active=[t,end,value,target];
    }
    segments.push([value,active]);
    breakpoints.push([t,left,Math.max(.28,Math.min(1,value))]);
  }
  const at=beat=>{
    let lo=0,hi=times.length;while(lo<hi){const mid=(lo+hi)>>1;if(times[mid]<=key(beat))lo=mid+1;else hi=mid;}
    let [value,ramp]=segments[Math.max(0,lo-1)];
    if(ramp){const [a,b,low,high]=ramp;value=low+Math.max(0,Math.min(1,(beat-a)/(b-a)))*(high-low);}
    return Math.max(.28,Math.min(1,value));
  };
  at.breakpoints=breakpoints;
  return at;
}

// Twin of score/fermata.py: a fermata holds the music, every part together.
const FERMATA_LENGTHENING=.5,FERMATA_LONGEST=8;
export function fermataHolds(spans,toSeconds){
  const longest=new Map();
  for(const [a,b] of spans){const key=Math.round(a*1e8)/1e8;if(!longest.has(key)||b>longest.get(key)[1])longest.set(key,[a,b]);}
  const holds=[];let last=-Infinity;
  for(const [a,b] of [...longest.values()].sort((x,y)=>x[0]-y[0])){
    if(a<last-1e-9)continue;
    const written=toSeconds(b)-toSeconds(a),extra=Math.max(0,Math.min(FERMATA_LENGTHENING*written,FERMATA_LONGEST-written));
    if(extra>0)holds.push([a,b,extra]);
    last=b;
  }
  return holds;
}
export const heldSeconds=(toSeconds,holds)=>{
  const at=beat=>{
    let sec=toSeconds(beat);
    for(const [a,b,extra] of holds)sec+=extra*Math.max(0,Math.min(1,(beat-a)/(b-a)));
    return sec;
  };
  at.breakpoints=[...new Set([...(toSeconds.breakpoints||[]),...holds.flatMap(([a,b])=>[a,b])])].sort((a,b)=>a-b);
  return at;
};
