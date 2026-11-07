export const VOWELS = [
  "AA",
  "AE",
  "AH",
  "AO",
  "EH",
  "ER",
  "IH",
  "IY",
  "UH",
  "UW",
  "AX",
  "AY",
  "EY",
  "OW",
  "AW",
  "OY",
  // Cardinal production vowels (VV-VOWEL-SPACE/CORNERS/BLEND); Latin and
  // non-English IPA sing on them (VV-TEXT-VOWELS).
  "A",
  "I",
  "U",
  "E",
  "O",
  "Q",
  "OH",
];
const normalize = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/[^a-z']/g, "");
// How an unstressed English schwa is sung (VV-SCHWA); mirrors
// verr_voice/phonetics/schwa.py, whose docstring holds the rule table.
const ENDINGS_IH = /(?:es|ed|est|less|ness|et)$/, ENDINGS_AH = /(?:us|ous|um|ful)$/, ENDINGS_R = /(?:er|or|ar|ure|our|ur|ir)s?$/;
export function sungSchwa(word, syllable, syllables, accent, beforeVowel) {
  if (word === 'the' && syllables === 1) return beforeVowel ? 'IY' : 'AH';
  if ((word === 'a' || word === 'of') && syllables === 1) return 'AH';
  const last = syllable === syllables - 1 && syllables > 1;
  if (last && ENDINGS_IH.test(word)) return 'IH';
  if (last && ENDINGS_AH.test(word)) return 'AH';
  if (last && accent === 'american' && ENDINGS_R.test(word)) return 'ER';
  return 'AX';
}
export function sungNucleus(nucleus, word, syllable, syllables, accent, beforeVowel) {
  if (!nucleus.includes('AX')) return [...nucleus];
  const vowel = sungSchwa(word, syllable, syllables, accent, beforeVowel);
  return nucleus.map(p => p === 'AX' ? vowel : p);
}
// Pronunciation systems are data (context.json "systems"); a Latin system is a
// table of what each spelling rule outputs, "basedOn" another system for the
// rest. Mirrors phonetics/inventory.py latin_rules.
export function latinRules(systems, id = "church-latin") {
  const system = systems?.[id] || systems?.["church-latin"];
  if (!system) throw Error("Pronunciation systems are missing");
  const base = system.basedOn ? latinRules(systems, system.basedOn) : { vowels: {} }, own = system.latin || {};
  return { ...base, ...own, vowels: { ...base.vowels, ...(own.vowels || {}) } };
}
export function latin(text, next = '', R, prev = '') {
  if (!R) throw Error("latin() needs a pronunciation system's rule table");
  // prev: the previous written syllable, for gn and ex+vowel across a split (mirrors inventory.py).
  const V=R.vowels,s=normalize(text).replace(/'/g,''),tail=normalize(next).replace(/'/g,''),before=normalize(prev).replace(/[^a-zæœ]/g,''),out=[];
  const front=(word,i)=>/^(e|i|y|ae|oe)/.test(word.slice(i));
  const simple={b:'B',d:'D',f:'F',k:'K',l:'L',m:'M',p:'P',r:'R',t:'T',v:'V',w:'W'};
  for(let i=0;i<s.length;) {
    const rem=s.slice(i),forward=n=>front(s,i+n)||(i+n===s.length&&front(tail,0));
    let matched=false;
    const pairs=[['sch',['S','K']],['xc',forward(2)?R.xc_front:['K','S','K']],['sc',forward(2)?R.sc_front:['S','K']],['gn',R.gn]];
    if(front(s,i+2))pairs.push(['gl',R.gl_front]);
    pairs.push(['qu',R.qu]);
    if(/[aeiouy]/.test(s[i+2]||'!'))pairs.push(['gu',R.gu]);
    pairs.push(['ph',['F']],['th',['T']],['ch',['K']],['ae',V.ae],['oe',V.oe],['au',V.au],['eu',V.eu]);
    for(const [key,phones] of pairs)if(rem.startsWith(key)){out.push(...phones);i+=key.length;matched=true;break;}
    if(matched)continue;
    if(rem.startsWith('ti')&&(/[aeiou]/.test(s[i+2]||'!')||(i+2===s.length&&/^[aeiou]/.test(tail)))&&!/[stx]/.test(s[i-1]||'!')){out.push(...R.ti_vowel,...V.i);i+=2;continue;}
    const c=s[i];
    if(c===s[i+1]&&!/[aeiouy]/.test(c)){
      if((c==='c'||c==='g')&&front(s,i+2)){out.push(...(c==='c'?R.cc_front:R.gg_front));i+=2;continue;}
      i++;continue;
    }
    if(c==='i'){if(i===0&&/[aeou]/.test(s[i+1]||'!'))out.push('Y');else out.push(...V.i);}
    else if(V[c]&&'aeouy'.includes(c))out.push(...V[c]);
    else if(c==='g'&&i+1===s.length&&tail.startsWith('n'))out.push(...R.gn_coda);
    else if(c==='c'||c==='g')out.push(...(forward(1)?(c==='c'?R.c_front:R.g_front):[c==='c'?'K':'G']));
    else if(c==='h'){
      if(['hi','hil'].includes(s)||/mih|nih/.test(s))out.push(...R.h_k);
      else if(s.startsWith('hos'))out.push('HH');
      else out.push(...R.h);
    } else if(c==='n'&&i===0&&before.endsWith('g'))out.push(...R.gn_onset);
    else if(c==='n')out.push(/[cgq]/.test(s[i+1]||(i+1===s.length?tail[0]:'')||'!')?'NG':'N');
    else if(c==='s')out.push(i>0&&/[aeiouy]/.test(s[i-1])&&(/[aeiouy]/.test(s[i+1]||'!')||(i+1===s.length&&/^[aeiouy]/.test(tail)))?'Z':'S');
    else if(c==='x'){
      if((i>0&&s.slice(0,i)==='e'||i===0&&before==='e')&&(/[aeiou]/.test(s[i+1]||'!')||/^[aeiou]/.test(tail)))out.push(...R.ex_vowel);
      else if((s[i+1]==='c'&&front(s,i+2))||(i+1===s.length&&tail.startsWith('c')&&front(tail,1)))out.push('K');
      else out.push('K','S');
    } else if(c==='z')out.push(...R.z);
    else if(c==='j')out.push(...R.j);
    else if(simple[c])out.push(simple[c]);
    i++;
  }
  return out;
}
export function structure(phones) {
  let first = phones.findIndex((p) => VOWELS.includes(p));
  if (first < 0) return { onset: phones, nucleus: [phones.some(p=>["M","N","NG","L","R","RN"].includes(p))?"AX":"AA"], coda: [] };
  let end = first + 1;
  while (end < phones.length && VOWELS.includes(phones[end]) && end < first + 2)
    end++;
  return {
    onset: phones.slice(0, first),
    nucleus: phones.slice(first, end),
    coda: phones.slice(end),
  };
}
// Port of parent phonetics/lyrics.py words-1. Shared context.json is copied verbatim.
const GLIDES = {
  AY: ["AA", "IH"],
  AW: ["AA", "UH"],
  OY: ["AO", "IH"],
  IA: ["IY", "AX"],
  EA: ["EH", "AX"],
  UA: ["UH", "AX"],
};
const NUCLEI = new Set([...VOWELS, ...Object.keys(GLIDES)]);
const ONSETS = new Set(
  "P B T D K G F V TH DH S Z SH ZH HH M N NG L R RN W Y CH JH"
    .split(" ")
    .concat(
      "P L,P R,B L,B R,T R,D R,K L,K R,G L,G R,F L,F R,S L,S M,S N,S P,S T,S K,S W,TH R,SH R,S P L,S P R,S T R,S K L,S K R".split(
        ",",
      ),
    ),
);
const LANGUAGES = {
  en: "english",
  eng: "english",
  english: "english",
  la: "latin",
  lat: "latin",
  latin: "latin",
  fr: "french",
  fra: "french",
  fre: "french",
  french: "french",
  el: "greek",
  ell: "greek",
  greek: "greek",
  sa: "sanskrit",
  san: "sanskrit",
  sanskrit: "sanskrit",
  de: "german",
  deu: "german",
  ger: "german",
  german: "german",
};
const MARKERS = {
  english:
    "in to be is was are were he she it we they i you an a the and my your thy thou yet of made lead seem limbs with from that for lord god grace sweet sound once was lost found blind see how me",
  latin:
    "ave verum corpus natum maria virgine sanctus dominus deus et in cum spiritu tuo gloria excelsis agnus dei dona nobis pacem qui tollis peccata mundi miserere me te se nos vos ad ab ex pro per sub super post ante sine quia ut sed non nisi est sunt eius tibi mihi",
  french:
    "le la les des du une un mon ma mes ton ta tes vos vous nous notre votre seigneur dieu amour âme ame lumière lumiere coeur cœur ciel terre et dans pour avec est que qui au aux",
  greek: "kyrie eleison christos theos agios kyrios",
  // Macaronic carols mix German with Latin (VV-PRONUNCIATION-SYSTEMS); mirrors lyrics.py.
  german: "und der die das des dem den ein eine einen ist sind nicht mit von zu zum zur auf für fur uns unser unsers unsrer du dich dir ich mich mir er wir ihr sie als wie nun doch alle aller gott herr herrn christ kind kindlein freude freud lob ehr ehre singet seid froh mein dein sein ihm ihn hat wird war sei gelobet lieber liebe heut himmel erden welt ja wo da hier ach sonne herzens wonne leit leuchtet schoss gnaden",
  sanskrit: "om aum shanti shantih namah namaste sarve bhavantu sukhinah",
};
// Written syllables of an IPA entry, as in choir school: [ˌfoʊ.nəˈtɪ.ʃən].
// Periods and stress marks separate syllables (a stress mark starts its
// syllable); ' and , stand in for ˈ and ˌ. Legacy a/lɛ/lu/i/a still splits on /.
export function ipaSyllables(text) {
  let s = String(text).normalize("NFC").trim().replaceAll("'", "ˈ").replaceAll(",", "ˌ");
  if (s.length > 1 && ["[]", "//"].includes(s[0] + s.at(-1))) s = s.slice(1, -1);
  return s.split(/[./]|(?=[ˈˌ])/).map((p) => p.trim()).filter(Boolean);
}
const IPA = {
  ɑ: "AA",
  a: "AA",
  ɐ: "AH",
  ʌ: "AH",
  æ: "AE",
  ɛ: "EH",
  e: "EH",
  ɪ: "IH",
  i: "IY",
  ɒ: "AA",
  ɔ: "AO",
  o: "AO",
  ʊ: "UH",
  u: "UW",
  ə: "AX",
  ɜ: "ER",
  ɚ: "ER",
  ɝ: "ER",
  p: "P",
  b: "B",
  t: "T",
  d: "D",
  k: "K",
  ɡ: "G",
  g: "G",
  f: "F",
  v: "V",
  θ: "TH",
  ð: "DH",
  s: "S",
  z: "Z",
  ʃ: "SH",
  ʒ: "ZH",
  h: "HH",
  m: "M",
  n: "N",
  ŋ: "NG",
  l: "L",
  ɹ: "R",
  r: "R",
  ɾ: "R",
  j: "Y",
  w: "W",
  y: "UW",
  ø: "ER",
  œ: "EH",
  ɥ: "W",
  ʁ: "R",
  ɲ: "N",
  c: "K",
  ɟ: "G",
  ç: "HH",
  x: "HH",
  ɣ: "G",
  ɨ: "IH",
  ɯ: "UW",
};
const PAIRS = {
  tʃ: "CH",
  dʒ: "JH",
  aɪ: "AY",
  ɑɪ: "AY",
  aʊ: "AW",
  ɑʊ: "AW",
  eɪ: "EY",
  oʊ: "OW",
  əʊ: "OW",
  ɔɪ: "OY",
};
export const normalizeWord = (text) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_'’]+/gu, "")
    .replaceAll("’", "'");
export const languageName = (s) =>
  LANGUAGES[
    (typeof s === "string" ? s : "")
      .toLowerCase()
      .replaceAll("_", "-")
      .split("-")[0]
  ] || "";
// Outside English, IPA vowels mean the cardinal vowels (VV-TEXT-VOWELS); English
// keeps the American choral set. Mirrors phonetics/lyrics.py ipa_phones.
const CARDINAL_IPA = { i: "I", e: "E", a: "A", ɑ: "Q", ɒ: "Q", ɔ: "OH", o: "O", u: "U" };
export function ipaPhones(text, language = "english") {
  const table = !language || language === "english" ? IPA : { ...IPA, ...CARDINAL_IPA };
  const clean = text.normalize("NFC").replace(/[ˈˌːˑ\u200d\u0361\u035c]/g, ""),
    phones = [],
    warnings = [];
  for (let i = 0; i < clean.length; ) {
    const pair = clean.slice(i, i + 2);
    if (PAIRS[pair]) {
      phones.push(PAIRS[pair]);
      i += 2;
      continue;
    }
    const ch = clean[i++];
    if (table[ch]) {
      phones.push(table[ch]);
      if ("yøœɥʁɲcɟçxɣɨɯ".includes(ch))
        warnings.push(`Approximate sound /${ch}/`);
    } else if (ch === "̃") warnings.push("Nasal vowel color is approximate");
    else if (!" .-_/[]()\n\t".includes(ch))
      warnings.push(`Unsupported IPA symbol ${ch}`);
  }
  return { phones, warnings: [...new Set(warnings)] };
}
export const ipa = (text) => ipaPhones(text).phones;
export function syllabify(phones) {
  const nuclei = phones
    .map((p, i) => (NUCLEI.has(p) ? i : -1))
    .filter((i) => i >= 0);
  if (!nuclei.length) return [];
  const bounds = [0];
  for (let i = 1; i < nuclei.length; i++) {
    const left = nuclei[i - 1],
      right = nuclei[i],
      cons = phones.slice(left + 1, right);
    let cut = right;
    for (let n = Math.min(3, cons.length); n > 0; n--)
      if (ONSETS.has(cons.slice(-n).join(" "))) {
        cut = right - n;
        break;
      }
    bounds.push(cut);
  }
  bounds.push(phones.length);
  return bounds
    .slice(0, -1)
    .map((a, i) =>
      structure(
        phones.slice(a, bounds[i + 1]).flatMap((p) => GLIDES[p] || [p]),
      ),
    );
}
export function dictionaryPhones(
  word,
  language,
  config,
  accent = "choral",
  syllableCount = 1,
) {
  if (language === "english" && accent !== "american" && config.lexicon[word]) {
    const result = config.lexicon[word],
      pairs = {
        "AA IH": "AY",
        "AA UH": "AW",
        "AO IH": "OY",
        "IY AX": "IA",
        "EH AX": "EA",
        "UH AX": "UA",
      },
      out = [];
    let remaining = result.filter((p) => NUCLEI.has(p)).length;
    for (let i = 0; i < result.length; ) {
      const p =
        remaining > syllableCount
          ? pairs[result.slice(i, i + 2).join(" ")]
          : null;
      out.push(p || result[i]);
      i += p ? 2 : 1;
      if (p) remaining--;
    }
    return { phones: out, warnings: [] };
  }
  const pronunciation =
    config.dictionary?.[
      language === "english" && accent === "american" ? "american" : language
    ]?.[word];
  if (pronunciation) return ipaPhones(pronunciation, language);
  const generated=config.lookupPronunciation?.(word,language,accent);
  if(generated)return ipaPhones(generated,language);
  if (language === "english" && config.englishFallback?.[word]) {
    const variants = config.englishFallback[word].map((value) =>
      value.split(" "),
    );
    // Prefer a dictionary variant fitting explicit syllabic underlay. Semantic
    // choices in context.json and user/score IPA have already taken precedence.
    const phones =
      variants.find(
        (p) => p.filter((phone) => NUCLEI.has(phone)).length === syllableCount,
      ) || variants[0];
    return { phones, warnings: [] };
  }
  return {
    phones: [],
    warnings: [`No offline dictionary entry for ${language}: ${word}`],
  };
}
export function contextualChoice(word, words, index, data) {
  const entry = data.words[word];
  if (!entry) return {};
  const start = Math.max(0, index - 5),
    window = words.slice(start, index + 6),
    text = window.join(" "),
    a = window.slice(0, index - start).reduce((s, w) => s + w.length + 1, 0),
    b = a + word.length,
    matches = new Set();
  for (const [choice, pattern] of entry.rules) {
    for (const match of text.matchAll(new RegExp(pattern, "g")))
      if (match.index <= a && match.index + match[0].length >= b)
        matches.add(choice);
  }
  return matches.size === 1
    ? { choice: [...matches][0], source: "context rule", review: false }
    : { choice: entry.default, source: "dictionary default", review: true };
}
// Spelling cues and scoring mirror lyrics.py infer_languages: a word's own
// evidence counts 4x, neighbours 1/(1+distance)²; shared marker words count 1.
const CUES = {
  latin: [/ae|oe|qu|(orum|arum|ibus|tio)$/, /(us|um|is|io|que|unt|ent)$|^...+[oi]$/],
  german: [/sch|tz|ß|[äöü]/, /ei|ie|ck|(en|et|nn|ung|lich)$/],
};
const MARKER_SETS = Object.fromEntries(Object.entries(MARKERS).map(([k, v]) => [k, new Set(v.split(" "))]));
const SHARED = new Set([...new Set(Object.values(MARKER_SETS).flatMap((m) => [...m]))].filter((w) => Object.values(MARKER_SETS).filter((m) => m.has(w)).length > 1));
function evidence(word, name, english) {
  let e = MARKER_SETS[name].has(word) ? (SHARED.has(word) ? 1 : 3) : 0;
  // Spelling cues only for words English doesn't know ("does", "glorious").
  const [strong, weak] = english(word) ? [] : CUES[name] || [];
  if (strong && strong.test(word)) e += 3;
  else if (weak && weak.test(word)) e += 1;
  return e;
}
export function inferLanguages(words, explicit, defaultLanguage, englishWord = () => false) {
  return words.map((word, i) => {
    if (explicit[i]) return explicit[i];
    if (/[\u0370-\u03ff\u1f00-\u1fff]/.test(word)) return "greek";
    if (/[\u0900-\u097f]/.test(word)) return "sanskrit";
    const scores = Object.fromEntries(Object.keys(MARKERS).map((name) => {
      let score = 0;
      for (let j = Math.max(0, i - 4); j < Math.min(words.length, i + 5); j++)
        score += (j === i ? 4 : 1 / (1 + Math.abs(i - j)) ** 2) * evidence(words[j], name, englishWord);
      return [name, score];
    }));
    if (/[àâçéèêëîïôûùÿœ]/.test(word)) scores.french += 4;
    let best = Object.keys(scores)[0];
    for (const name of Object.keys(scores)) if (scores[name] > scores[best]) best = name;
    let nearby = "";
    for (let d = 1; d < 5 && !nearby; d++)
      nearby = explicit[i - d] || explicit[i + d] || "";
    return scores[best] >= 1.5 ? best : nearby || defaultLanguage;
  });
}
// Piece-wide vowel fixes (VV-VOWEL-PROFILES); mirrors phonetics/vowel_profile.py,
// whose docstring holds the precedence rules.
const PROFILE_VOWELS = ['AA','AE','AH','AO','EH','ER','IH','IY','UH','UW','AX','A','I','U','E','O','Q','OH'];
const PROFILE_DIPHTHONGS = {AY:['AA','IH'],EY:['EH','IH'],OW:['AO','UH'],AW:['AA','UH'],OY:['AO','IH']};
// Written vowel of each diphthong component, as a singer spells it (VV-LOOP-2).
const PROFILE_WRITTEN = {AY:['A','IH'],EY:['E','IH'],OW:['O','UH'],AW:['A','UH'],OY:['AO','IH']};
const PROFILE_KEYS = PROFILE_VOWELS; // 'A', 'E', 'O' are also written [a], [e], [o]
export const vowelWordKey = word => String(word).normalize('NFC').toLowerCase();
function profileWeights(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).some(k => !PROFILE_VOWELS.includes(k)))
    throw Error('Vowel weights must name production vowels');
  const entries = Object.entries(value).map(([k, v]) => [k, Number(v)]);
  if (entries.some(([, v]) => !Number.isFinite(v) || v < 0)) throw Error('Vowel weights must be finite, nonnegative and nonzero');
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (!(total > 0)) throw Error('Vowel weights must be finite, nonnegative and nonzero');
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).filter(([, v]) => v > 0).map(([k, v]) => [k, v / total]));
}
// Mirrors phonetics/vowel_profile.py: written-vowel fixes for all parts or one,
// one word or every word; most specific wins.
export function normalizeVowelProfile(profile) {
  if (!profile || (typeof profile === 'object' && !Object.keys(profile).length)) return null;
  if (typeof profile !== 'object' || Array.isArray(profile)) throw Error('Vowel profile must be an object');
  const fixes = profile.fixes || [];
  if (!Array.isArray(fixes) || fixes.length > 512) throw Error('Vowel fixes must be a list of at most 512');
  const out = fixes.map(fix => {
    if (!fix || !PROFILE_KEYS.includes(fix.phone)) throw Error('Each vowel fix needs a written vowel');
    const part = fix.part ?? null, word = fix.word ?? null;
    if (part !== null && (typeof part !== 'string' || part.length > 128)) throw Error('Vowel fix part must be a part ID');
    if (word !== null && (typeof word !== 'string' || !word || word.length > 128)) throw Error('Vowel fix word must be a word');
    return { phone: fix.phone, weights: profileWeights(fix.weights), part, word: word === null ? null : vowelWordKey(word), diphthongs: fix.diphthongs !== false };
  });
  const words = profile.schwa_words || {};
  if (typeof words !== 'object' || Array.isArray(words) || Object.keys(words).length > 2000) throw Error('Per-word schwa must be an object of at most 2000 words');
  const schwaWords = Object.fromEntries(Object.entries(words).map(([w, v]) => [vowelWordKey(w), profileWeights(v)]));
  // Language-profile pronunciations (VV-LYRICS-WORKSHOP): word -> {ipa, language}.
  const lexicon = profile.words || {};
  if (typeof lexicon !== 'object' || Array.isArray(lexicon) || Object.keys(lexicon).length > 5000) throw Error('Profile pronunciations must be an object of at most 5000 words');
  const pronunciations = {};
  for (const [w, v] of Object.entries(lexicon)) {
    const ipa = v?.ipa, language = v?.language || 'any';
    if (!w || w.length > 128 || !v || typeof v !== 'object' || typeof ipa !== 'string' || !ipa.trim() || ipa.length > 512 || typeof language !== 'string' || language.length > 24)
      throw Error('Each profile pronunciation needs a word and an IPA spelling');
    pronunciations[vowelWordKey(w)] = { ipa, language };
  }
  return out.length || Object.keys(schwaWords).length || Object.keys(pronunciations).length ? { fixes: out, schwa_words: schwaWords, words: pronunciations } : null;
}
export function vowelMap(profile, plan, partId) {
  if (!profile || plan.source === 'your IPA') return {};
  const written = plan.nucleus || [], sung = plan.sung || plan.nucleus || [], word = vowelWordKey(plan.word || '');
  const best = key => {
    let found = null, rank = -1;
    for (const fix of profile.fixes) {
      if (fix.phone !== key || (fix.part !== null && fix.part !== partId) || (fix.word !== null && fix.word !== word)) continue;
      const r = 2 * (fix.word !== null) + (fix.part !== null);
      if (r > rank) { found = fix; rank = r; }
    }
    return found;
  };
  const result = {};
  written.forEach((w, i) => {
    const s = sung[i];
    if (s === undefined) return;
    if (w === 'AX' && s !== 'AX') {
      const fix = best('AX');
      if (fix && fix.word !== null) result[s] = fix.weights;
      else if (word in profile.schwa_words) result[s] = profile.schwa_words[word];
      return;
    }
    const parts = PROFILE_DIPHTHONGS[s] || [s], keys = PROFILE_WRITTEN[s] || [s], diphthong = parts.length > 1 || sung.length > 1;
    parts.forEach((p, k) => { const fix = best(keys[k]); if (fix && (fix.diphthongs || !diphthong || fix.word !== null)) result[p] = fix.weights; });
    if (s === 'AX' && word in profile.schwa_words && !best('AX')?.word) result.AX = profile.schwa_words[word];
  });
  return result;
}
export const BREAKS_KEY = "_word_breaks", SYSTEMS_KEY = "_systems", TIMING_KEY = "_timing";
// Timing-workshop edits per note (mirrors lyrics.py _validate_timing / apply_timing).
const TIMING_FIELDS = ["shift", "stretch", "delete", "onset", "coda", "lead", "release", "scoop", "turn"];
function validateTiming(timing) {
  const num = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  if (typeof timing !== "object" || Array.isArray(timing) || Object.keys(timing).length > 5000) throw Error("Timing edits must be an object of at most 5000 notes");
  for (const [k, v] of Object.entries(timing)) {
    if (k.length > 256 || !v || typeof v !== "object" || Object.keys(v).some((f) => !TIMING_FIELDS.includes(f))) throw Error("Each timing edit needs a note and known fields");
    for (const f of ["shift", "stretch", "lead", "release"]) if (f in v && !num(v[f], -4, 4)) throw Error(`Timing ${f} must be seconds between -4 and 4`);
    if ("delete" in v && typeof v.delete !== "boolean") throw Error("Timing delete must be true or false");
    for (const side of ["onset", "coda"]) if (side in v && !(Array.isArray(v[side]) && v[side].length <= 8 && v[side].every((x) => x && typeof x === "object" && Object.keys(x).every((f) => ["scale", "delete"].includes(f)) && num(x.scale ?? 1, 0, 8)))) throw Error(`Timing ${side} must be a list of consonant edits`);
    if ("turn" in v && !(v.turn && typeof v.turn === "object" && Object.keys(v.turn).every((f) => ["shift", "scale"].includes(f)) && num(v.turn.shift ?? 0, -4, 4) && num(v.turn.scale ?? 1, 0.1, 8))) throw Error("Timing turn needs shift -4-4 s and scale 0.1-8");
    if ("scoop" in v && !(v.scoop && typeof v.scoop === "object" && Object.keys(v.scoop).every((f) => ["amount", "length"].includes(f)) && num(v.scoop.amount ?? 1, 0, 4) && num(v.scoop.length ?? 1, 0.1, 4))) throw Error("Timing scoop needs amount 0-4 and length 0.1-4");
  }
}
// Match lyrics.py apply_timing: moved blocks keep their written order and
// cannot overlap their anchored neighbours. Original starts survive retries.
function constrainTimingLane(lane,timing,origin=0){
  const notes=lane.filter(e=>e.midi!=null),moved=new Set(notes.filter(e=>timing[e.id]?.shift).map(e=>e.id));
  const changed=new Set(notes.filter(e=>moved.has(e.id)||timing[e.id]?.stretch).map(e=>e.id));
  if(!changed.size)return;
  let spacing=.03;
  for(let j=1;j<notes.length;j++){const a=notes[j-1],b=notes[j],gap=(b.timingOriginalStart??b.start)-(a.timingOriginalStart??a.start);if(gap>0)spacing=Math.min(spacing,gap/2);}
  const anchors=new Array(notes.length);let anchor=null;
  for(let j=notes.length-1;j>=0;j--){anchors[j]=anchor;if(!moved.has(notes[j].id))anchor=j;}
  let previous=origin-spacing;
  for(let j=0;j<notes.length;j++){const e=notes[j];if(moved.has(e.id)){
    const end=anchors[j],upper=end==null?Infinity:notes[end].start-spacing*(end-j);
    e.start=Math.max(previous+spacing,Math.min(e.start,upper));}previous=e.start;}
  for(let j=0;j<notes.length;j++){const e=notes[j],before=e.duration;
    if(j+1<notes.length&&(changed.has(e.id)||moved.has(notes[j+1].id)))e.duration=Math.min(e.duration,notes[j+1].start-e.start);
    if(changed.has(e.id)||e.duration!==before)e.timing={...e.timing,_note:true};}
}
const PART_OF = /^([^:\s]{1,64}):(\d{1,2})$/;
export function preparePronunciation(
  score,
  config,
  overrides = {},
  accent = "choral",
  forcedLanguage = "",
  vowelProfile = null,
) {
  const profile = normalizeVowelProfile(vowelProfile);
  // Word breaks fixed in the lyrics workshop ride in the overrides under one
  // reserved key (mirrors phonetics/lyrics.py BREAKS_KEY).
  overrides = { ...(overrides || {}) };
  const breaks = overrides[BREAKS_KEY] || {};
  delete overrides[BREAKS_KEY];
  if (typeof breaks !== "object" || Array.isArray(breaks) || Object.keys(breaks).length > 10000 || Object.entries(breaks).some(([k, v]) => k.length > 256 || !["join", "split"].includes(v)))
    throw Error('Word breaks must map note IDs to "join" or "split"');
  const lexicon = profile?.words || {};
  const timing = overrides[TIMING_KEY] || {};
  delete overrides[TIMING_KEY];
  validateTiming(timing);
  // The pronunciation system per language (mirrors lyrics.py SYSTEMS_KEY).
  const systems = overrides[SYSTEMS_KEY] || {}, allSystems = config.context?.systems || {};
  delete overrides[SYSTEMS_KEY];
  if (typeof systems !== "object" || Array.isArray(systems) || Object.entries(systems).some(([k, v]) => languageName(k) !== k || allSystems[v]?.language !== k))
    throw Error("Pronunciation systems must map a language to one of its systems");
  if (systems.english) accent = allSystems[systems.english].accent;
  const latinTable = latinRules(allSystems, systems.latin || "church-latin");
  if (!["choral", "american"].includes(accent))
    throw Error("Choose choral or american English diction");
  const data = config.context || { words: {}, sung_words: {} },
    summary = [];
  const known = new Set();
  for (const part of score.parts)
    for (const lane of part.lanes) {
      const groups = [];
      let active = [], previous = null;
      for (const [index, event] of lane.entries()) {
        delete event.pronunciation;
        delete event.phones;
        if (!event.lyric) continue;
        const fixed = breaks[event.id];
        if (fixed === "join" && previous !== null) {
          if (!active.length && groups.length && groups.at(-1).at(-1) === previous) active = groups.pop();
          active.push(index);
        } else if (fixed === "split") {
          if (active.length) groups.push(active);
          active = [index];
        } else if (["middle", "end"].includes(event.syllabic) && active.length)
          active.push(index);
        else {
          if (active.length) groups.push(active);
          active = [index];
        }
        if (["end", "single"].includes(event.syllabic) || (fixed === "join" && !["begin", "middle"].includes(event.syllabic))) {
          groups.push(active);
          active = [];
        }
        previous = index;
      }
      if (active.length) groups.push(active);
      const words = groups.map((g) =>
          normalizeWord(g.map((i) => lane[i].lyric).join("")),
        ),
        explicit = groups.map((g) =>
          languageName(g.map((i) => lane[i].language).find(Boolean)),
        ),
        languages = inferLanguages(
          words,
          explicit,
          languageName(score.language) || "english",
          (w) => !!(config.lexicon?.[w] || data.words?.[w] || config.englishFallback?.[w]),
        );
      const summaryStart = summary.length;
      for (let wi = 0; wi < groups.length; wi++) {
        const group = groups[wi],
          word = words[wi],
          identifier = lane[group[0]].id,
          override = overrides[identifier] || {},
          language =
            languageName(override.language) ||
            languageName(forcedLanguage) ||
            languages[wi];
        known.add(identifier);
        if (
          typeof override !== "object" ||
          Object.keys(override).some(
            (k) => !["choice", "ipa", "language", "part_of"].includes(k),
          )
        )
          throw Error("Corrections must contain choice, ipa, language or part_of");
        if (override.part_of !== undefined && !(typeof override.part_of === "string" && PART_OF.test(override.part_of)))
          throw Error('part_of must be "word:first syllable", e.g. "remembering:2"');
        if (override.language && !languageName(override.language))
          throw Error("Unsupported pronunciation language");
        let syllables = [],
          source = "word dictionary",
          warnings = [],
          choice = null,
          review = false,
          alternatives = {};
        const entry = language === "english" ? data.words[word] : null;
        if (entry) {
          alternatives = entry.choices;
          ({ choice, source, review } = contextualChoice(
            word,
            words,
            wi,
            data,
          ));
          if (override.choice) {
            if (!alternatives[override.choice])
              throw Error(`Unknown pronunciation choice for ${word}`);
            choice = override.choice;
            source = "your choice";
            review = false;
          }
          syllables = syllabify(alternatives[choice].phones.split(" "));
        } else if (override.choice)
          throw Error(`No alternate meanings available for ${word}`);
        const special = data.sung_words[word]?.[String(group.length)];
        if (special && !entry) {
          syllables = special.map((x) => structure(x.split(" ")));
          source = "sung word";
        }
        if (!syllables.length && language === "latin") {
          syllables = group.map((i, j) =>
            latinSyllable(lane[i].lyric, lane[group[j + 1]]?.lyric || "", latinTable, j ? lane[group[j - 1]].lyric : ""),
          );
          source = "Latin rules";
        }
        if (!syllables.length) {
          const result = dictionaryPhones(
            word,
            language,
            config,
            accent,
            group.length,
          );
          warnings = result.warnings;
          syllables = syllabify(result.phones);
        }
        // A true partial word: these notes are syllables k.. of a longer word.
        if (override.part_of) {
          const [, whole, kText] = override.part_of.match(PART_OF), k = Number(kText);
          const phones = dictionaryPhones(normalizeWord(whole), language, config, accent, 1).phones, wholeSyllables = syllabify(phones);
          if (phones.length && k + group.length <= wholeSyllables.length) {
            syllables = wholeSyllables.slice(k, k + group.length); source = `part of “${whole}”`; warnings = []; review = false;
          } else warnings = [...warnings, `Could not find syllable ${k + 1} of “${whole}”`];
        }
        // A language profile's pronunciation, where this word has no edit of its own.
        const entryIpa = lexicon[word];
        if (entryIpa && !override.ipa && !override.part_of && ["any", language].includes(entryIpa.language)) {
          const pieces = ipaSyllables(entryIpa.ipa), parsed = pieces.map((p) => ipaPhones(p, language).phones);
          const sy = pieces.length > 1 ? parsed.map((p) => structure(p.flatMap((x) => GLIDES[x] || [x]))) : pieces.length ? syllabify(parsed[0]) : [];
          if (sy.length === group.length && sy.every((x) => x.nucleus.length)) { syllables = sy; source = "profile IPA"; warnings = []; review = false; }
        }
        // What the pronunciation system writes, kept beside your IPA (mirrors lyrics.py).
        const auto = syllables.length === group.length ? syllables.slice() : null;
        if (override.ipa) {
          const pieces = ipaSyllables(override.ipa),
            parsed = pieces.map((p) => ipaPhones(p, language));
          if (
            parsed.some(
              (p) => p.warnings.length || !p.phones.some((p) => NUCLEI.has(p)),
            )
          )
            throw Error(
              "IPA must contain supported phonemes and a vowel in each syllable",
            );
          syllables =
            pieces.length > 1
              ? parsed.map((p) =>
                  structure(p.phones.flatMap((p) => GLIDES[p] || [p])),
                )
              : syllabify(parsed[0].phones);
          if (syllables.length !== group.length)
            throw Error(
              `${word} needs ${group.length} written syllables; separate them with periods, e.g. [a.lɛˈlu.i.a]`,
            );
          source = "your IPA";
          review = false;
          warnings = [];
        }
        if (syllables.length !== group.length) {
          syllables = group.map((i) => {
            const result = dictionaryPhones(
              normalizeWord(lane[i].lyric),
              language,
              config,
              accent,
            );
            return structure(
              (result.phones.length
                ? result.phones
                : latin(lane[i].lyric, "", latinTable)
              ).flatMap((p) => GLIDES[p] || [p]),
            );
          });
          warnings.push(
            "Written syllables differ from dictionary; using syllable rules",
          );
          source = "syllable rules";
          review = true;
        }
        const context = groups
            .slice(Math.max(0, wi - 5), wi + 6)
            .map((g) => g.map((i) => lane[i].lyric).join(""))
            .join(" "),
          wordPlans = [];
        group.forEach((ei, j) => {
          const e = lane[ei];
          let syl = structuredClone(syllables[j]),
            noteSource = source,
            noteWarnings = [...warnings];
          if (language === "english" && !override.ipa && source !== "profile IPA") {
            syl.onset = syl.onset.map((p) => (p === "R" ? "RN" : p));
            syl.coda = syl.coda
              .filter((p) => accent === "american" || !["R", "RN"].includes(p))
              .map((p) => (p === "R" ? "RN" : p));
          }
          if (e.ipa && !override.ipa && !override.choice && !override.part_of) {
            const parsed = ipaPhones(e.ipa, language);
            if (parsed.phones.some((p) => NUCLEI.has(p))) {
              syl = structure(parsed.phones.flatMap((p) => GLIDES[p] || [p]));
              noteSource = "score IPA";
              noteWarnings.push(...parsed.warnings);
            }
          }
          const plan = {
            version: "words-1",
            word_id: identifier,
            word,
            display: group.map((i) => lane[i].lyric).join(""),
            context,
            language,
            accent,
            source: noteSource,
            choice,
            alternatives,
            review: noteSource === "score IPA" ? false : review,
            warnings: [...new Set(noteWarnings)],
            syllable: j,
            syllables: group.length,
            ...syl,
            note: e.id,
            ...(noteSource === "your IPA" && auto ? { auto: [...auto[j].onset, ...auto[j].nucleus, ...auto[j].coda] } : {}),
          };
          e.pronunciation = plan;
          e.phones = syl;
          e.wordId = identifier;
          wordPlans.push(plan);
        });
        const first = wordPlans[0];
        summary.push({
          ...first,
          note: undefined, // per-note only; the row lists `notes`
          auto: undefined,
          ...(wordPlans[0].auto ? { auto_phones: wordPlans.map((p) => p.auto) } : {}),
          id: identifier,
          text: first.display,
          part_id: part.id,
          part: part.name,
          t: lane[group[0]].start,
          start: lane[group[0]].start,
          phones: wordPlans.flatMap((p) => [
            ...p.onset,
            ...p.nucleus,
            ...p.coda,
          ]),
          // Shown and prefilled by the diction editor as slash-separated IPA.
          syllable_phones: wordPlans.map((p) => [...p.onset, ...p.nucleus, ...p.coda]),
          notes: group.map((i) => lane[i].id),
          // Written text of each syllable: the lyrics workshop's syllable chips.
          texts: group.map((i) => lane[i].lyric),
          // Syllable start times: the workshop's lyric row selects a syllable.
          times: group.map((i) => lane[i].start),
        });
      }
      // The next resolved onset, including explicit IPA, determines "the".
      // The plan keeps the written schwa [ə]; phones carry what is sung.
      groups.forEach((group, wi) => {
        const first = lane[group[0]].pronunciation;
        if (!first || first.language !== 'english') return;
        const following = lane[groups[wi + 1]?.[0]]?.pronunciation;
        const vowelInitial = !!(following && !following.onset.length && following.nucleus.length);
        group.forEach((ei, j) => {
          const plan = lane[ei].pronunciation;
          const explicit = ['your IPA', 'score IPA', 'profile IPA'].includes(plan.source);
          if (first.word === 'the' && group.length === 1 && !explicit) {
            plan.nucleus = [vowelInitial ? 'IY' : 'AX'];
            plan.source = vowelInitial ? 'English article before vowel' : 'English article before consonant';
          }
          plan.sung = sungNucleus(plan.nucleus, first.word, j, group.length, accent, vowelInitial);
          lane[ei].phones.nucleus = plan.sung;
        });
        const row = summary[summaryStart + wi];
        row.nucleus = first.nucleus; row.source = first.source;
        row.phones = group.flatMap(i => {const p = lane[i].pronunciation;return [...p.onset, ...p.nucleus, ...p.coda];});
        row.syllable_phones = group.map(i => {const p = lane[i].pronunciation;return [...p.onset, ...p.nucleus, ...p.coda];});
        // Written vs sung nucleus per syllable: lists words a schwa rule changes.
        row.sung = group.map(i => lane[i].pronunciation.sung || lane[i].pronunciation.nucleus);
      });
    }
  // Piece-wide vowel fixes and per-word schwa, once every pronunciation is final.
  for (const part of score.parts)
    for (const lane of part.lanes)
      for (const event of lane) {
        if (!event.pronunciation) continue;
        const mapping = vowelMap(profile, event.pronunciation, part.id);
        if (Object.keys(mapping).length) { event.pronunciation.vowel_map = mapping; event.phones.vowelMap = mapping; }
      }
  // Timing workshop: move, stretch or silence notes; articulation edits ride on the note.
  if (Object.keys(timing).length)
    for (const part of score.parts)
      for (const lane of part.lanes)
        for (const e of lane) {
          const edit = timing[e.id];
          if (!edit || e.midi == null || e.timingApplied) continue;
          e.timingApplied = true;
          e.timingOriginalStart=e.start;
          // Clamp in written-score coordinates, before the shared pickup.
          e.start = Math.max(score.timingOrigin || 0, e.start + (edit.shift || 0));
          e.duration = Math.max(0.03, e.duration + (edit.stretch || 0));
          if (edit.delete) e.midi = null;
          const rest = Object.fromEntries(Object.entries(edit).filter(([k]) => !["shift", "stretch", "delete"].includes(k)));
          if (Object.keys(rest).length) e.timing = rest;
        }
  if(Object.keys(timing).length)for(const p of score.parts)for(const lane of p.lanes){constrainTimingLane(lane,timing,score.timingOrigin||0);for(const e of lane)if(e.midi!=null)score.duration=Math.max(score.duration,e.start+e.duration);}
  if(Object.keys(timing).length){
    const byId=new Map(score.parts.flatMap(p=>p.lanes.flat()).map(e=>[e.id,e]));
    for(const row of summary){row.times=row.notes.map(id=>byId.get(id).start);row.t=row.start=row.times[0];}
  }
  for (const key of Object.keys(overrides))
    if (!known.has(key))
      throw Error("Pronunciation choices belong to another score");
  score.pronunciation = {
    version: "words-1",
    words: summary,
    pronunciations: overrides,
    english_diction: accent,
  };
  return score.pronunciation;
}
// Preserve forward consonant context across a written syllable boundary.
function latinSyllable(text, next, rules, prev = '') {
  return structure(latin(text,next,rules,prev));
}
