import { assignment, percussionKeys } from "./instruments.js";
import { metronomeRate } from "./tempo.js";
import { dynamicCurve, noteShape, fermataHolds, heldSeconds } from "./score-dynamics.js";
const text = (el, selector, fallback = "") =>
  el?.querySelector(selector)?.textContent.trim() || fallback;
const num = (el, selector, fallback = 0) =>
  Number(text(el, selector, String(fallback)));
function inheritedLanguage(el) {
  for (let p = el; p; p = p.parentElement) {
    const lang = p.getAttribute("xml:lang");
    if (lang) return lang;
  }
  return "";
}
const direct = (el, name) =>
  Array.from(el.children).filter((x) => x.localName === name);
const decode = new TextDecoder();
// Verse number, rather than XML declaration order or a verse's name, decides
// the primary lyric. Mirrors musicxml._primary_lyric.
export function primaryLyric(lyrics) {
  const rank=l=>{
    const n=String(l.number??'1').trim()||'1';
    return /^[0-9]+$/.test(n)&&Number(n)>0?Number(n):Infinity;
  };
  return lyrics.reduce((best,l)=>!best||rank(l)<rank(best)?l:best,null);
}
export async function unpackMusicXML(buffer) {
  if (buffer.byteLength > 32 * 1024 * 1024)
    throw Error("Score exceeds 32 MB upload limit");
  const v = new DataView(buffer);
  if (v.getUint32(0, true) !== 0x04034b50) return decode.decode(buffer);
  let end = buffer.byteLength - 22;
  while (
    end >= Math.max(0, buffer.byteLength - 65558) &&
    v.getUint32(end, true) !== 0x06054b50
  )
    end--;
  if (end < 0) throw Error("Invalid MXL directory");
  const count = v.getUint16(end + 10, true),
    entries = new Map();
  let pos = v.getUint32(end + 16, true);
  if (count > 4096) throw Error("MXL contains too many files");
  for (let i = 0; i < count; i++) {
    if (v.getUint32(pos, true) !== 0x02014b50)
      throw Error("Invalid MXL member");
    const method = v.getUint16(pos + 10, true),
      size = v.getUint32(pos + 20, true),
      raw = v.getUint32(pos + 24, true),
      nl = v.getUint16(pos + 28, true),
      extra = v.getUint16(pos + 30, true),
      comment = v.getUint16(pos + 32, true),
      offset = v.getUint32(pos + 42, true),
      name = decode.decode(new Uint8Array(buffer, pos + 46, nl));
    entries.set(name, { method, size, raw, offset });
    pos += 46 + nl + extra + comment;
  }
  async function read(name, limit) {
    const e = entries.get(name);
    if (!e || e.raw > limit || e.size > limit)
      throw Error("Missing or oversized MXL member");
    const start =
        e.offset +
        30 +
        v.getUint16(e.offset + 26, true) +
        v.getUint16(e.offset + 28, true),
      bytes = buffer.slice(start, start + e.size);
    if (e.method === 0) return decode.decode(bytes);
    if (e.method !== 8) throw Error("Unsupported MXL compression");
    const reader = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"))
      .getReader();
    let total = 0,
      chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        throw Error("Inflated MXL exceeds limit");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return decode.decode(out);
  }
  let name;
  if (entries.has("META-INF/container.xml")) {
    const xml = new DOMParser().parseFromString(
      await read("META-INF/container.xml", 65536),
      "application/xml",
    );
    name = xml.querySelector("rootfile")?.getAttribute("full-path");
  }
  name ||= [...entries.keys()].find(
    (n) => /\.(musicxml|xml)$/i.test(n) && !n.startsWith("META-INF/"),
  );
  if (!name) throw Error("No MusicXML score inside MXL");
  return read(name, 16 * 1024 * 1024);
}
function voiceType(name,events){
 const avg=events.length?events.reduce((sum,e)=>sum+e.midi,0)/events.length:60;
 return /sop|descant/i.test(name)?'soprano':/alt|mezzo|counter/i.test(name)?'alto':/ten/i.test(name)?'tenor':/bas|barit/i.test(name)?'bass':avg>=67?'soprano':avg>=61?'alto':avg>=54?'tenor':'bass';
}
// Same deterministic score-level fallback as the native importer. Individual
// words can subsequently select a different language from their context.
export function detectLanguage(lyrics) {
  const words=new Set(lyrics.join(' ').toLowerCase().match(/[a-zæœ]+/g) || []);
  const latin_markers=new Set('aeterna aeternam agnus ave benedictus caeli christe corpus cruce cujus cum dei deus domini dominus dona eis eleison esto et examine excelsis fluxit gloria homine hosanna immolatum in kyrie latus luceat lux maria mihi miserere mortis mundi natum nihil nobis nomine pacem passum peccata perforatum pleni praegustatum qui requiem sabaoth sanctus sanguine spiritu sunt terra tua tuo unda venit vere verum virgine'.split(' '));
  const english_markers=new Set('all and blind earth father for from god grace heaven his holy joy lord love now our praise saved see shall sing sound spirit sweet that the thee thou thy unto with world'.split(' '));
  const hits=set=>[...words].filter(word=>set.has(word)).length;
  const latin=hits(latin_markers),english=hits(english_markers);
  if(latin!==english)return latin>english ? 'latin' : 'english';
  return [...words].filter(word=>/(um|us|ae|ibus|orum)$/.test(word)).length>=2 ? 'latin' : 'english';
}
export function parseScore(xml, language = "auto") {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw Error("Malformed MusicXML");
  const root = doc.documentElement;
  if (root.localName !== "score-partwise")
    throw Error("Only score-partwise MusicXML is supported");
  const warnings = new Set(),
    parts = [],
    tempos = [{ beat: 0, bpm: 84 }],
    dynamics = {
      ppp: 0.3,
      pp: 0.42,
      p: 0.54,
      mp: 0.66,
      mf: 0.78,
      f: 0.88,
      ff: 0.96,
      fff: 1,
      sfz: 0.95,
      fp: 0.7,
    };
  let maxBeat = 0,
    eventCount = 0, rawStreamCount = 0;
  const fermataSpans = []; // Notation spans, before tied notes are merged.
  if (doc.querySelector("repeat, ending, segno, coda"))
    warnings.add("Repeats/navigation are shown in written order.");
  if (doc.querySelector("grace"))
    warnings.add("Grace notes are not performed.");
  const defs = new Map(
    Array.from(doc.querySelectorAll("score-part")).map((p) => [p.id, p]),
  );
  if (direct(root, "part").length > 128) throw Error("Score exceeds 128 parts");
  for (const [partIndex, partEl] of direct(root, "part").entries()) {
    const def = defs.get(partEl.id),
      name = text(def, "part-name", `Part ${partIndex + 1}`);
    let divisions = 1,
      transpositions = new Map(),
      activeWedge = null,
      dynamic = 0.76,
      measureStart = 0,
      beatsPerMeasure = 4;
    const events = [],
      wedges = [],
      dynamicMarks = [],
      drumKeys = percussionKeys(def),
      ties = new Map();
    let serial=0;
    for (const measure of direct(partEl, "measure")) {
      let cursor = 0,
        furthest = 0,
        chordIndex = 0;
      const lastStarts = new Map();
      for (const el of measure.children) {
        const kind = el.localName;
        if (kind === "attributes") {
          divisions = num(el, "divisions", divisions);
          if (divisions <= 0) throw Error("Invalid divisions");
          for (const trans of direct(el, "transpose")) {
            const staff = trans.getAttribute("number");
            if (staff === null) transpositions.clear();
            transpositions.set(
              staff,
              num(trans, "chromatic") + 12 * num(trans, "octave-change"),
            );
          }
          if (el.querySelector("time"))
            beatsPerMeasure =
              (num(el, "time > beats", 4) * 4) / num(el, "time > beat-type", 4);
        } else if (kind === "backup") cursor -= num(el, "duration") / divisions;
        else if (kind === "forward") {
          cursor += num(el, "duration") / divisions;
          furthest = Math.max(furthest, cursor);
        } else if (kind === "direction" || kind === "sound") {
          const sound = kind === "sound" ? el : el.querySelector("sound"),
            offset = num(el, "offset") / divisions;
          const met = el.querySelector("metronome");
          let bpm = sound?.hasAttribute("tempo") ? Number(sound.getAttribute("tempo")) : null;
          const rate = metronomeRate(text(met, "per-minute"));
          if (bpm === null && rate !== null) {
            const unit = text(met, "beat-unit", "quarter"),
              scale =
                { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25 }[
                  unit
                ] || 1;
            bpm =
              rate *
              scale *
              (2 - 0.5 ** met.querySelectorAll("beat-unit-dot").length);
          }
          if (bpm !== null && (!Number.isFinite(bpm) || bpm < 20 || bpm > 300))
            throw Error(
              "Tempo must be between 20 and 300 quarter notes per minute",
            );
          if (bpm > 0)
            tempos.push({ beat: measureStart + cursor + offset, bpm });
          let explicitDynamic = null;
          const d = el.querySelector("dynamics")?.firstElementChild?.localName;
          if (d in dynamics) dynamic = explicitDynamic = dynamics[d];
          if (sound?.hasAttribute("dynamics"))
            dynamic = explicitDynamic = Math.max(
              0.28,
              Math.min(1, Number(sound.getAttribute("dynamics")) / 100),
            );
          const directionTime=Math.max(0,measureStart+cursor+offset);
          if(explicitDynamic!==null)dynamicMarks.push([directionTime,explicitDynamic]);
          for (const wedge of el.querySelectorAll("direction-type > wedge")) {
            const type = wedge.getAttribute("type"),
              at = directionTime;
            if (["crescendo", "diminuendo", "decrescendo"].includes(type))
              activeWedge = { start: at, type };
            else if (type === "stop" && activeWedge) {
              if (at > activeWedge.start)
                wedges.push({
                  ...activeWedge,
                  end: at,
                });
              activeWedge = null;
            }
          }
        } else if (kind === "note") {
          if (el.querySelector("grace")) continue;
          const duration = num(el, "duration", divisions) / divisions,
            chord = !!el.querySelector("chord"),
            staff=text(el,'staff','1'), voiceNumber=text(el,'voice','1'),
            baseLane=staff==='1'?voiceNumber:`${staff}_${voiceNumber}`,
            start = chord ? (lastStarts.get(baseLane) ?? cursor) : cursor;
          if (!chord) {lastStarts.set(baseLane,start);cursor+=duration;chordIndex=0;}
          else chordIndex++;
          const lane=baseLane+(chord?`_C${chordIndex}`:'');
          furthest = Math.max(furthest, start + duration);
          if (el.querySelector("rest") || duration <= 0) {
            continue;
          }
          const pitch = el.querySelector("pitch");
          if (!pitch && !el.querySelector("unpitched")) continue;
          const step = text(pitch, "step"),
            midi = pitch
              ? 12 * (num(pitch, "octave", 4) + 1) +
                ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[step] ?? 0) +
                num(pitch, "alter") +
                (transpositions.get(staff) ?? transpositions.get(null) ?? 0)
              : (drumKeys.get(
                  el.querySelector("instrument")?.getAttribute("id"),
                ) ??
                drumKeys.values().next().value ??
                60);
          const lyrics = direct(el, "lyric").map((l) => ({
            verse: l.getAttribute("number") || l.getAttribute("name") || "1",
            number: l.getAttribute("number") || "1",
            text: Array.from(l.children).filter(x=>["text","elision"].includes(x.localName)).map(x=>x.localName==="elision"?" ":x.textContent).join("").trim(),
            syllabic: text(l, "syllabic", "single"),
            language: inheritedLanguage(l.querySelector("text") || l),
            ipa: text(l, "ipa"),
            extend: !!l.querySelector("extend"),
          }));
          const lyric = primaryLyric(lyrics) || {};
          const tieKey = `${lane}:${midi}`,
            stop = el.querySelector('tie[type="stop"], tied[type="stop"]'),
            tieStart = el.querySelector(
              'tie[type="start"], tied[type="start"]',
            );
          const previous = ties.get(tieKey);
          if (el.querySelector("notations fermata"))
            fermataSpans.push([measureStart + start, measureStart + start + duration]);
          if (
            stop &&
            previous && (!lyric.text || lyric.text===previous.lyric) &&
            Math.abs(previous.beat + previous.beats - (measureStart + start)) <
              1e-6
          ) {
            previous.beats += duration;
            previous.breath ||= !!el.querySelector("breath-mark");
            previous.fermata ||= !!el.querySelector("notations fermata");
            if (!tieStart) ties.delete(tieKey);
            continue;
          }
          const event = {
            id: `${partEl.id}:m${measure.getAttribute("number")}:n${serial++}`,
            beat: measureStart + start,
            beats: duration,
            midi,
            dynamic,
            fermata: !!el.querySelector("notations fermata"),
            lane,
            lyric: lyric.text || "",
            syllabic: lyric.syllabic || "single",
            language: lyric.language || "",
            ipa: text(el, "play > ipa", lyric.ipa || ""),
            lyrics,
            breath: !!el.querySelector("breath-mark"),
            measure: measure.getAttribute("number"),
          };
          events.push(event);
          if (tieStart) ties.set(tieKey, event);
          if (++eventCount > 100000) throw Error("Score exceeds 100,000 notes");
        }
      }
      measureStart += Math.max(furthest, cursor) || beatsPerMeasure;
      maxBeat = Math.max(maxBeat, measureStart);
    }
    if (activeWedge && measureStart > activeWedge.start)
      wedges.push({ ...activeWedge, end: measureStart, target: null });
    // Preserve the native importer's stable staff/voice/chord streams. Their
    // order determines singer seeds, underlay inheritance and seating.
    const groups=new Map();
    for(const e of events){if(!groups.has(e.lane))groups.set(e.lane,[]);groups.get(e.lane).push(e);}
    const lanes=[...groups.keys()].sort().map(key=>({key,events:groups.get(key)}));
    const primary=lanes[0]?.events||[];
    // A divided chord's syllable can sit on its second note ("shi-neth"): the
    // main line takes it at the same instant. Main line's own chord lanes only.
    const lyricless=new Map(primary.filter(e=>e.midi!=null&&!e.lyric).map(e=>[Math.round(e.beat*1000),e]));
    for(const lane of lanes.slice(1)){if(!lanes[0]||!lane.key.startsWith(lanes[0].key+'_C'))continue;
      for(const e of lane.events){if(!e.lyric||e.midi==null)continue;const key=Math.round(e.beat*1000),main=lyricless.get(key);
        if(main){lyricless.delete(key);for(const k of ['lyric','syllabic','language','ipa','lyrics'])main[k]=structuredClone(e[k]);}}}
    const underlay=new Map(primary.filter(e=>e.lyric).map(e=>[Math.round(e.beat*1000),e]));
    for(const lane of lanes.slice(1))for(const e of lane.events)if(!e.lyric){
      const donor=underlay.get(Math.round(e.beat*1000));
      if(donor)for(const key of ['lyric','syllabic','language','ipa','lyrics'])e[key]=structuredClone(donor[key]);
    }
    const laneVoices=lanes.map(l=>voiceType(name,l.events)),voice=laneVoices[0]||voiceType(name,[]);
    const {instrument,program,bank}=assignment(def,events.some(e=>e.lyric));
    const rawIndex=rawStreamCount;rawStreamCount+=Math.max(1,lanes.length);
    for (const lane of lanes) {
      let previous = "";
      for (const event of lane.events) {
        if (event.lyric) previous = event.lyric;
        event.displayLyric = previous;
      }
    }
    parts.push({
      id: partEl.id,
      name,
      voice,
      instrument,
      program,
      bank,
      wedges, dynamicMarks, rawIndex, laneVoices,
      pan: { soprano: -0.42, alto: 0.38, tenor: -0.16, bass: 0.18 }[voice],
      events,
      lanes: lanes.map((l) => l.events),
    });
  }
  tempos.sort((a, b) => a.beat - b.beat);
  const unique = [];
  for (const t of tempos) {
    if (unique.at(-1)?.beat === t.beat) unique[unique.length - 1] = t;
    else unique.push(t);
  }
  let sec = 0;
  for (let i = 0; i < unique.length; i++) {
    const t = unique[i];
    if (i) sec += ((t.beat - unique[i - 1].beat) * 60) / unique[i - 1].bpm;
    t.sec = sec;
  }
  const written = (beat) => {
    let i = unique.length - 1;
    while (i && unique[i].beat > beat) i--;
    const t = unique[i];
    return t.sec + ((beat - t.beat) * 60) / t.bpm;
  };
  written.breakpoints = unique.map(t=>t.beat);
  // Applied to the shared clock, so every part holds together.
  const seconds = heldSeconds(written, fermataHolds(fermataSpans, written));
  for (const [pi, p] of parts.entries()) {
    p.pan = p.lanes.length>1 && p.instrument!=='voice' ? 0 : rawStreamCount===1 ? 0 : Math.max(-.75,Math.min(.75,p.pan+((p.rawIndex%4)-1.5)*.06));
    delete p.rawIndex;
    const dynamics=dynamicCurve(p.dynamicMarks,p.wedges);
    for (const e of p.events) {
      e.start = seconds(e.beat);
      e.duration = seconds(e.beat + e.beats) - e.start;
      [e.dynamic, e.dynamics] = noteShape(dynamics, e.beat, e.beats, seconds);
    }
    delete p.dynamicMarks;
    delete p.wedges;
  }
  if(language==='auto')language=detectLanguage(parts.flatMap(p=>p.events.map(e=>e.lyric || '')));
  const duration = seconds(maxBeat);
  if (
    !Number.isFinite(duration) ||
    duration > 7200 ||
    !parts.some((p) => p.events.length)
  )
    throw Error("Score must contain notes and last at most two hours");
  return {
    title: text(
      doc,
      "work-title",
      text(doc, "movement-title", "Untitled score"),
    ),
    composer: text(doc, 'creator[type="composer"]'),
    parts,
    duration,
    language,
    warnings: [...warnings],
    tempos: unique,
  };
}
