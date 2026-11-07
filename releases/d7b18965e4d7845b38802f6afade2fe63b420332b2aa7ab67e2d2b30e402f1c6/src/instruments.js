// Routing aliases shared with the parent MusicXML importer (zero-based GM).
const aliases = [
  ["contrabassoon", 70],
  ["bassoon|fagott", 70],
  ["bass clarinet", 71],
  ["soprano sax", 64],
  ["tenor sax", 66],
  ["baritone sax", 67],
  ["sax", 65],
  ["double bass|contrabass|string bass", 43],
  ["bass guitar|electric bass", 33],
  ["english horn|cor anglais", 69],
  ["french horn|horn in|\\bhorn\\b|corno", 60],
  ["piccolo", 72],
  ["flute|flauto|fl\u00f6te", 73],
  ["oboe|hautbois", 68],
  ["clarinet", 71],
  ["trumpet|trompete", 56],
  ["trombone", 57],
  ["tuba", 58],
  ["chimes|tubular bell", 14],
  ["harpsichord|cembalo", 6],
  ["celesta", 8],
  ["glockenspiel", 9],
  ["vibraphone", 11],
  ["marimba", 12],
  ["xylophone", 13],
  ["timpani", 47],
  ["harp", 46],
  ["organ|orgue|orgel", 19],
  ["piano|pianoforte|keyboard", 0],
  ["violin|violino", 40],
  ["viola", 41],
  ["cello|violoncello", 42],
  ["strings|orchestra", 48],
  ["guitar", 24],
  ["recorder", 74],
  ["accordion", 21],
];
export function assignment(def, hasLyrics) {
  const name = def?.querySelector("part-name")?.textContent || "",
    description =
      name + " " + (def?.querySelector("instrument-name")?.textContent || ""),
    raw = def?.querySelector("midi-program")?.textContent,
    program = raw ? Number(raw) - 1 : null;
  if (
    program != null &&
    (!Number.isInteger(program) || program < 0 || program > 127)
  )
    throw Error("MusicXML MIDI program must be 1–128");
  const drum=/tom.tom|cymbal|tam.tam|gong|snare|bass drum|triangle|percussion|drum kit/i.test(description)||!!def?.querySelector("midi-unpitched")||def?.querySelector("midi-channel")?.textContent.trim()==="10";
  const bank = Math.max(
    0,
    Number(def?.querySelector("midi-bank")?.textContent || 1) - 1,
  );
  const named = aliases.find(([r]) => new RegExp(r, "i").test(name)),
    match = aliases.find(([r]) => new RegExp(r, "i").test(description));
  const vocal =
    /soprano|\balto\b|\btenor\b|\bbass\b|baritone|mezzo|choir|chorus|voice|vocal|cantor|singer|\b[SATB]{2,}\b/i.test(
      name,
    );
  if(vocal&&!named)return {instrument:'voice',program:52,bank:0};
  if(drum)return {instrument:'sample',program:program??0,bank:128};
  if(!named&&hasLyrics)return {instrument:'voice',program:52,bank:0};
  if (match)
    return { instrument: "sample", program: program ?? match[1], bank };
  if (program != null && ![52, 53, 54].includes(program))
    return { instrument: "sample", program, bank };
  return { instrument: "voice", program: 52 };
}

export function percussionKeys(def){
 const result=new Map();
 for(const item of def?.querySelectorAll('score-instrument')||[]){
  const text=(item.querySelector('instrument-name')?.textContent||'').toLowerCase();
  let key=text.includes('cymbal')?49:/tam|gong/.test(text)?52:text.includes('snare')?38:text.includes('bass drum')?36:text.includes('triangle')?81:60;
  if(text.includes('tom')){const number=text.match(/(\d+)/);key=number?[50,48,47,45,43][Math.min(4,Math.max(0,Number(number[1])-1))]:41;}
  result.set(item.id,key);
 }
 for(const item of def?.querySelectorAll('midi-instrument')||[]){const value=item.querySelector('midi-unpitched')?.textContent;if(value)result.set(item.id,Number(value)-1);}
 return result;
}
