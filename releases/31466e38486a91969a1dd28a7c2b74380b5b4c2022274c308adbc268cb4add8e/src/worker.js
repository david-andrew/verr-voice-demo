let vowelActor=null;
import {singerCounts} from "./voice-assets.js";
import { initRandom,randomBackend } from "./native-random.js";
import { initDSP, filters,usedDSPBackends } from "./dsp.js";
import { initializeGPU, gpuStatus,usedGPUBackends } from "./gpu-filters.js";
import { preparePronunciation } from "./pronunciation.js";
import { Bank } from "./bank.js";
import { PhraseSinger, phrases, centerEnsemble } from "./performance.js";
import { staggerConsonants } from "./stagger.js";
import { seats, stageActive, vibratoCharacters } from "./stage.js";
import { NativeSoundFont } from "./native-soundfont.js";
const instruments = new Map();
const assetRequests = new Map();
let assetSerial = 0;
function publicAsset(entry, base) {
  return new Promise((resolve, reject) => {
    const assetId = ++assetSerial;
    assetRequests.set(assetId, { resolve, reject });
    postMessage({ type: "asset", assetId, entry, base });
  });
}
let rendererIndex = 0,
  rendererCount = 1;
let bank,
  config,
  font,
  score,
  takes = new Map();
const base = new URL("../public/assets/", import.meta.url).href;
const fonts = new Map();
async function getFont(id = "") {
  if (!fonts.has(id)) {
    const entry = id
      ? bank.manifest.soundfonts?.find((f) => f.id === id)
      : bank.manifest.soundfont;
    if (!entry)
      throw Error("That SoundFont is not available in this static build");
    const promise = publicAsset(entry, base).then((b) =>
      NativeSoundFont.load(b),
    );
    fonts.set(id, promise);
    promise.catch(() => fonts.delete(id));
  }
  return (font = await fonts.get(id));
}
async function render(msg) {
  usedDSPBackends.clear();usedGPUBackends.clear();
  const { id, start, end, controls, quality = 8 } = msg;
  let take = takes.get(id);
  if (!take) {
    const takeScore = structuredClone(score);
    const pronunciationConfig={...config,dictionary:{...config.dictionary}};
    for(const [language,words] of Object.entries(msg.dictionary||{}))pronunciationConfig.dictionary[language]={...pronunciationConfig.dictionary[language],...words};
    preparePronunciation(
      takeScore,
      pronunciationConfig,
      msg.pronunciations || {},
      msg.english_diction || "choral",
      undefined,
      msg.vowel_profile || null,
    );
    take = {
      score: takeScore,
      lanes: takeScore.parts.map((p) =>
        p.lanes.map((l) =>
          takeScore.duration > 90
            ? phrases(l)
            : [{ start: 0, origin: 0, end: takeScore.duration, events: l }],
        ),
      ),
      cache: new Map(),
    };
    takes.set(id, take);
    while (takes.size > 3) takes.delete(takes.keys().next().value);
  }
  const time = performance.now(),
    stems = [],
    counts = singerCounts(take.score, controls, quality, msg.instruments, msg.partControls);
  if(!take.prefetched) {
    take.prefetched=true;
    // Decode later entrances during the opening passage. Respect instrument
    // overrides and solo size; loaders share in-flight work with actual singing.
    const identities=new Set();
    take.score.parts.forEach((part,pi)=>{
      if(pi%rendererCount!==rendererIndex||(msg.instruments?.[pi]??part.instrument)!=='voice')return;
      for(const voice of part.laneVoices||[part.voice]) {
        const family=['soprano','alto'].includes(voice)?'f':'m';
        const order=['alto','bass'].includes(voice)?[2,1,3,4]:[1,2,3,4];
        for(let ai=0;ai<Math.min(counts[pi],4);ai++)identities.add(family+order[ai]);
      }
    });
    for(const identity of identities)bank.load(identity).catch(()=>{});
    if(identities.size)bank.loadMouth().catch(()=>{});
  }
  for (let pi = 0; pi < score.parts.length; pi++) {
    // A vowel-workshop loop renders one part only (msg.onlyPart).
    if (pi % rendererCount !== rendererIndex || (msg.onlyPart != null && pi !== msg.onlyPart)) {
      stems.push(new Float32Array(0));
      continue;
    }
    const controls = msg.partControls?.[pi] || msg.controls, count = counts[pi];
    const part = take.score.parts[pi],
      mode = msg.instruments?.[pi] ?? part.instrument,
      program = msg.programs?.[pi] ?? part.program;
    const frames = Math.round((end - start) * 48000),
      stereo = mode === "voice" && msg.stage !== false && stageActive(count);
    let audio = new Float32Array(stereo ? 2 * frames : frames);
    if (mode === "sample") {
      const fontId = msg.fonts?.[pi] || "";
      const sf = await getFont(fontId);
      const bankNumber = msg.banks?.[pi] ?? part.bank ?? 0;
      const key = `${pi}:${fontId}:${program}:${bankNumber}`;
      if (!instruments.has(key))
        instruments.set(key, sf.part(part.events, program, bankNumber));
      const sourceEnd = Math.min(end, (Math.ceil((score.duration+(program===19?.18:2))*100)+1)/100);
      const partRenderer = instruments.get(key);
      if (start < sourceEnd) audio.set(partRenderer.render(start, sourceEnd));
      instruments.delete(key);
      instruments.set(key, partRenderer);
      while (instruments.size > Math.max(4, score.parts.length * 2)) {
        const oldest = instruments.keys().next().value;
        instruments.get(oldest).dispose();
        instruments.delete(oldest);
      }
    } else if (mode === "voice") {
      for (let li = 0; li < take.lanes[pi].length; li++)
        for (const [fi, phrase] of take.lanes[pi][li].entries()) {
          if (phrase.end + 0.2 < start || phrase.start - 0.26 > end) continue;
          const key = `${pi}:${li}:${fi}`, voice=part.laneVoices?.[li]||part.voice;
          let actors = take.cache.get(key);
          if (!actors) {
            actors = [];
            await bank.loadMouth();
            for (let ai = 0; ai < count; ai++) {
              const family = ["soprano", "alto"].includes(voice)
                  ? "f"
                  : "m",
                baseIndex = ["alto", "bass"].includes(voice) ? 1 : 0,
                identity =
                  family + (baseIndex ? [2, 1, 3, 4] : [1, 2, 3, 4])[ai % 4],
                units = await bank.load(identity);
              postMessage({
                type: "progress",
                stage: "preparing",
                part: part.voice,
                singer: ai + 1,
                singers: count,
              });
              actors.push(
                new PhraseSinger(
                  phrase,
                  {...part,voice},
                  controls,
                  config.inventory,
                  bank.mouth,
                  units,
                  ai,
                  1009 + pi * 4099 + li * 1879 + fi * 7919 + ai * 701,
                  vibratoCharacters(count, 1009 + pi * 4099 + li * 1879)[ai],
                ),
              );
            }
            centerEnsemble(actors, controls.size);
            staggerConsonants(actors);
            take.cache.set(key, actors);
          }
          const scale = 1 / Math.sqrt(count);
          const places = stereo ? seats(count, 1009 + pi * 4099 + li * 1879, part.pan) : null;
          actors.forEach((actor, ai) => {
            if (places) {
              actor.render48(start, end, config.resampleFilter, places[ai], audio, scale);
              return;
            }
            const rendered = actor.render48(start, end, config.resampleFilter);
            for (let i = 0; i < audio.length; i++)
              audio[i] += rendered[i] * scale;
          });
          // Retain only a bounded number of prepared phrases (not whole-score audio).
          take.cache.delete(key);
          take.cache.set(key, actors);
          while (
            take.cache.size >
            Math.max(
              2,
              Math.min(8, Math.ceil(score.parts.length / rendererCount) * 2),
            )
          )
            take.cache.delete(take.cache.keys().next().value);
        }
    }
    if (mode === "voice" && part.lanes.length > 1) {
      // Divide only among simultaneously active divisi lines, with the main
      // renderer's 120 ms absolute-time crossfade at entrances and releases.
      const activity = new Float32Array(frames);
      for (const lane of part.lanes) {
        const level = new Float32Array(frames);
        for (const e of lane) {
          if (e.start > end + 0.06 || e.start + e.duration < start - 0.06)
            continue;
          const lo = Math.max(0, Math.floor((e.start - 0.06 - start) * 48000)),
            hi = Math.min(
              frames,
              Math.ceil((e.start + e.duration + 0.06 - start) * 48000),
            );
          for (let i = lo; i < hi; i++) {
            const t = start + i / 48000;
            level[i] = Math.max(
              level[i],
              Math.max(0, Math.min(1, (t - e.start + 0.06) / 0.12)) *
                Math.max(
                  0,
                  Math.min(1, (e.start + e.duration + 0.06 - t) / 0.12),
                ),
            );
          }
        }
        for (let i = 0; i < frames; i++) activity[i] += level[i];
      }
      for (let i = 0; i < audio.length; i++)
        audio[i] /= Math.sqrt(Math.max(1, activity[i % frames]));
    }
    // Silent stems retain timeline metadata without storing/scheduling zero PCM.
    stems.push(audio.some((x) => x !== 0) ? audio : new Float32Array(0));
  }
  const elapsed = performance.now() - time;
  postMessage(
    {
      type: "chunk",
      request: msg.request,
      id,
      start,
      end,
      stems,
      elapsed,
      backends:[...usedDSPBackends,...usedGPUBackends,randomBackend()],
      bankBytes: bank.bytes,
      fontBytes: font?.buffer.byteLength || 0,
      actorCount: Math.max(...counts),
    },
    stems.map((a) => a.buffer),
  );
}
let queue = Promise.resolve();
onmessage = ({ data: m }) => {
  if (m.type === "asset-result") {
    const request = assetRequests.get(m.assetId);
    assetRequests.delete(m.assetId);
    if (m.error) request?.reject(Error(m.error));
    else request?.resolve(m.buffer);
    return;
  }
  queue = queue
    .then(async () => {
      if (m.type === "init") {
        const backend = await initDSP();
        await initRandom();
        config = m.config;
        rendererIndex = m.rendererIndex || 0;
        rendererCount = m.rendererCount || 1;
        bank = new Bank(m.manifest, base, publicAsset);
        const gpu = initializeGPU(filters);
        postMessage({
          type: "ready",
          backend: gpu.enabled ? "webgl2+wasm" : backend,
          gpu,
        });
      } else if (m.type === "score") {
        score = m.score;
        for (const part of instruments.values()) part.dispose();
        instruments.clear();
        takes.clear();
        const identities = new Set();
        score.parts.forEach((part, pi) => {
          if (
            pi % rendererCount === rendererIndex &&
            part.instrument === "voice"
          ) {
            for(const voice of part.laneVoices || [part.voice]) {
              const family = ["soprano", "alto"].includes(voice) ? "f" : "m";
              for (let i = 1; i <= 4; i++) identities.add(family + i);
            }
          }
        });
        bank.retain(identities);
        postMessage({ type: "score-ready", request: m.request });
      } else if (m.type === "vowel") {
        const voice=m.voice, pitch=m.pitch;
        const family=['soprano','alto'].includes(voice)?'f':'m';
        const order=['alto','bass'].includes(voice)?[2,1,3,4]:[1,2,3,4];
        // A section audition is the part's own ensemble, built as a one-note part
        // is (same donors, seeds and centring); otherwise one singer (seed 1009).
        const count=Math.max(1,Math.min(m.actors||1,Math.round(m.controls.size)||1));
        await bank.loadMouth();
        const key=JSON.stringify([voice,pitch,m.weights,m.controls,count]);
        if(vowelActor?.key!==key) {
          const phrase={start:0,origin:0,end:120,vowelWeights:m.weights,events:[{start:0,duration:120,midi:pitch,dynamic:.7,lyric:''}]};
          const actors=[];
          for(let ai=0;ai<count;ai++)actors.push(new PhraseSinger(phrase,{voice},m.controls,config.inventory,bank.mouth,await bank.load(family+order[ai%4]),ai,1009+ai*701,vibratoCharacters(count,1009)[ai]));
          if(count>1)centerEnsemble(actors,m.controls.size);
          vowelActor={key,actors};
        }
        usedDSPBackends.clear();usedGPUBackends.clear();
        const pcm=new Float32Array(Math.round((m.end-m.start)*48000)),scale=1/Math.sqrt(count);
        for(const actor of vowelActor.actors){
          const rendered=actor.render48(m.start,m.end,config.resampleFilter);
          for(let i=0;i<pcm.length;i++)pcm[i]+=count>1?rendered[i]*scale:rendered[i];
          // Only spectra near this window are needed; the pulse clock is retained.
          actor.frames.clear();
        }
        postMessage({type:'vowel',request:m.request,backends:[...usedDSPBackends,...usedGPUBackends,randomBackend()],pcm},[pcm.buffer]);
      } else if (m.type === "render") await render(m);
      else if (m.type === "font") {
        const sf = await getFont();
        postMessage({
          type: "font",
          presets: sf.presets.map(({ name, program, bank }) => ({
            name,
            program,
            bank,
          })),
        });
      }
    })
    .catch((error) =>
      postMessage({
        type: "error",
        request: m.request,
        message: error.message,
        stack: error.stack,
      }),
    );
};
