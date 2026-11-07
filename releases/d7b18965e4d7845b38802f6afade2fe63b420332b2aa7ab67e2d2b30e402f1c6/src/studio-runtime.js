// Run the native studio UI unchanged. Its API contract is implemented locally:
// fetches below never leave the page; score parsing and synthesis use Workers.
import {voiceAssets,loadingText,singerCounts} from "./voice-assets.js";
import { panOffset, planes, stageActive } from "./stage.js";
import { partControls } from "./part-controls.js";
import { RenderPool } from "./render-pool.js";
import { parseScore, unpackMusicXML } from "./score.js";
import { LocalPronunciation } from "./phonemizer.js";
import { normalizeWord } from "./pronunciation.js";
import { planNoteGeometry } from "./performance.js";
import { fingerprint } from "./score-identity.js";
import {digestBytes} from "./asset-digest.js";
import {FeedbackInbox} from "./feedback.js";
import {loadIdentity,wavIdentity} from "./render-identity.js";
import { readBlob } from "./bank.js";
import { AudioEngine, encodeWav, renderOffline } from "./audio.js";
import { exportPassages } from "./wav-export.js";
const root = new URL("../", import.meta.url);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const base64 = (bytes) => {
  let value = "";
  for (let i = 0; i < bytes.length; i += 16384)
    value += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(value);
};
const unbase64 = (value) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const abort = (signal) => {
  if (signal?.aborted) throw new DOMException("Canceled", "AbortError");
};
export async function installBrowserRuntime() {
  const identity=await loadIdentity(root);
  const feedback=new FeedbackInbox(fetch.bind(globalThis),identity);
  setInterval(()=>feedback.flush().catch(()=>{}),30000);
  addEventListener("online",()=>feedback.flush().catch(()=>{}));
  feedback.flush().catch(()=>{});
  if(globalThis.CHOIR_CLIENT_IDENTITY?.id!==identity.id)throw Error("The page and synthesis release differ. Reload the studio.");
  const originalFetch = globalThis.fetch.bind(globalThis);
  async function get(path) {
    const r = await originalFetch(new URL(path, root));
    if (!r.ok) throw Error(`Missing public app file: ${path}`);
    return r;
  }
  const [config, manifest, metadata, context, dictionary, cmu] =
    await Promise.all([
      get("public/config.json").then((r) => r.json()),
      get("public/assets/bank.json").then((r) => r.json()),
      get("public/studio.json").then((r) => r.json()),
      get("public/context.json").then((r) => r.json()),
      get("public/dictionary.json").then((r) => r.json()),
      get("public/english-cmu.json.gz").then((r) =>
        new Response(
          r.body.pipeThrough(new DecompressionStream("gzip")),
        ).json(),
      ),
    ]);
  Object.assign(config, { context, dictionary, englishFallback: cmu });
  const phonemizer=new LocalPronunciation();
  const pool = new RenderPool(),
    pending = new Map(),
    takes = new Map(),
    audioIds = new Map(),
    pcmCache = new Map(), pcmEvidence=new Map();
  let cachedBytes = 0;
  let serial = 0,
    currentScore = null,
    queue = Promise.resolve();
  const scoreInputs = [];
  const metrics = {
    windows: [],
    chunks: 0,
    renderMs: 0,
    progress: null,
    backend: "wasm",
    errors: [],
  };
  const message = (type, data = {}) =>
    new Promise((resolve, reject) => {
      const request = ++serial;
      pending.set(request, { resolve, reject });
      pool.postMessage({ type, request, ...data });
    });
  pool.onmessage = ({ data: m }) => {
    if (m.type === "progress") {
      metrics.progress = m;
      const status = document.querySelector("#statusText");
      if (
        status &&
        window.studio?.render.inFlight &&
        !window.studio?.player.playing
      ) {
        if (["downloading","retrying","checking","cached"].includes(m.stage))
          status.textContent = loadingText(m);
        else if (m.stage === "preparing")
          status.textContent = `Preparing ${m.part} · singer ${m.singer} of ${m.singers}`;
      }
      return;
    }
    if (m.type === "ready") {
      metrics.backend = m.backend;
      metrics.gpu = m.gpu;
      return;
    }
    if (m.request) {
      const p = pending.get(m.request);
      pending.delete(m.request);
      if (m.type === "error") p?.reject(Error(m.message));
      else p?.resolve(m);
    }
  };
  pool.onerror = (e) => {
    const error = Error(
      e.message || "The audio worker stopped. Reload to retry.",
    );
    metrics.errors.push(error.message);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  pool.postMessage({ type: "init", config, manifest });
  const rooms = new AudioEngine(manifest, (entry, base) => pool.assets.get(entry, base));
  async function prepare(body) {
    const source = body.custom_xml_b64 || body.preset,
      language = body.language || "auto";
    let found = scoreInputs.find(
      (entry) => entry.source === source && entry.language === language,
    );
    if (!found) {
      let xml;
      if (body.custom_xml_b64)
        xml = await unpackMusicXML(unbase64(body.custom_xml_b64).buffer);
      else {
        if (!metadata.presets.some((s) => s.filename === body.preset))
          throw Error("Choose a public example or open a score");
        xml = await (await get(`public/scores/${body.preset}`)).text();
      }
      const key = await fingerprint(xml + "\n" + language),
        score = parseScore(xml, language);
      found = { source, language, key, score };
      scoreInputs.push(found);
      if (scoreInputs.length > 4) scoreInputs.shift();
    }
    const { key } = found;
    const score=structuredClone(found.score), shifted=new Set();
    for(const part of score.parts)for(const event of [...part.events,...part.lanes.flat()])if(!shifted.has(event)){shifted.add(event);event.start+=.25;}
    score.duration+=.25;
    score.timingOrigin=.25;
    const signature = JSON.stringify([
      key,
      body.ensemble_preset,
      body.controls,
      body.instruments,
      body.part_settings,
      body.pronunciations,
      body.vowel_profile,
      body.english_diction,
      body.room,
    ]);
    if (takes.has(signature)) return takes.get(signature);
    const selected =
      config.presets.find((p) => p.id === body.ensemble_preset) ||
      config.presets.find((p) => p.id === "baltic_chamber");
    const controls = { ...selected.controls, ...body.controls };
    for (const [k, v] of Object.entries(controls))
      if (
        k !== "preset_id" &&
        (!Number.isFinite(v) ||
          v < (k === "size" ? 1 : 0) ||
          v > (k === "size" ? 64 : 1))
      )
        throw Error(`Invalid ${k} setting`);
    const sectionControls = score.parts.map(p => partControls(controls, body.part_settings || {}, config.presets, p.id, p.voice, selected.id));
    const copy = structuredClone(score);
    const pronunciationDictionary=await phonemizer.prepare(
      copy,
      config,
      body.pronunciations || {},
      body.english_diction || "choral",
      body.vowel_profile || null,
    );
    score.duration=copy.duration;
    const effective = copy.parts.map((p) => {
      const override = body.instruments?.[p.id] || {},
        mode =
          override.mode === "voice"
            ? "voice"
            : override.mode === "soundfont"
              ? "sample"
              : p.instrument;
      if (mode === "voice")
        return {
          mode: "voice",
          label: "Sung voice",
          font: "",
          bank: 0,
          program: 52,
        };
      const font =
        metadata.soundfonts.find((f) => f.id === override.font) ||
        metadata.soundfonts[0];
      if (!font) throw Error("Public instrument bank is missing");
      const program = override.program ?? p.program,
        bank = override.bank ?? p.bank ?? 0;
      let preset = font.presets.find(
        (p) => p.program === program && p.bank === bank,
      );
      if (!preset && (!override.mode || override.mode === "auto"))
        preset =
          font.presets.find(
            (p) => p.program === program && p.bank === (bank === 128 ? 128 : 0),
          ) || (bank === 128 ? font.presets.find((p) => p.bank === 128) : null);
      if (!preset)
        throw Error("This instrument is not available in that SoundFont");
      return {
        mode: "soundfont",
        label: preset.name,
        font: font.id,
        bank: preset.bank,
        program: preset.program,
      };
    });
    for (const id of Object.keys(body.instruments || {}))
      if (!copy.parts.some((p) => p.id === id))
        throw Error("Instrument choice belongs to another score");
    let room = body.room || "auto";
    if (room === "auto") {
      const s = selected.controls.space;
      room =
        s >= 0.78
          ? "cathedral"
          : s >= 0.4
            ? "concert_hall"
            : s >= 0.15
              ? "chamber"
              : "studio";
    }
    if (room !== "dry" && !manifest.rooms[room])
      throw Error("Unknown performance space");
    const wet = room === "dry" ? 0 : controls.space * 0.48,
      roomEntry = wet > 0.01 ? manifest.rooms[room] : null;
    // Start exactly this score's public assets while the UI assembles its player,
    // without waiting for Play or competing with unrelated voices/rooms.
    const assets = voiceAssets(manifest, copy, controls, effective.map(p=>p.mode==='voice'?'voice':'sample'), sectionControls);
    if(roomEntry)assets.push(roomEntry);
    for(const instrument of effective)if(instrument.mode!=='voice'){
      const entry=manifest.soundfonts?.find(f=>f.id===instrument.font);if(entry)assets.push(entry);
    }
    pool.assets.setPlan(assets);
    for(const entry of assets)pool.assets.get(entry,new URL('public/assets/',root).href).catch(()=>{});
    const roomFrames = roomEntry ? roomEntry.fields.ir.shape[1] : 0;
    const vocalFrames=score.duration>90 ? (Math.ceil((score.duration+.18)*100)+1)*480 : Math.ceil((Math.ceil((score.duration+.18)*200)+1)/2)*480;
    const frames=Math.max(...effective.map(p=>p.mode==='voice'?vocalFrames:(Math.ceil((score.duration+(p.program===19?.18:2))*100)+1)*480));
    const measures = new Map();
    for (const p of copy.parts)
      for (const e of p.events) {
        const n = Number(e.measure);
        if (!measures.has(n) || measures.get(n) > e.start)
          measures.set(n, e.start);
      }
    const counts = singerCounts(copy, controls, 8, effective.map(p=>p.mode==='voice'?'voice':'sample'), sectionControls);
    const header = {
      type: "start",
      producer_identity:{schema:1,id:identity.id,runtime:"static"},
      render_identity:{producer:{schema:1,id:identity.id,runtime:"static"},score_sha256:key,settings_sha256:await fingerprint(signature),plan_sha256:await fingerprint(JSON.stringify([copy,pronunciationDictionary,sectionControls,effective])),seed:1009,sample_rate:48000},
      title: score.title,
      composer: score.composer,
      language: score.language,
      pronunciation: copy.pronunciation,
      tempo_bpm: score.tempos[0]?.bpm || 72,
      score_duration_sec: score.duration,
      vocal_frames: frames,
      duration_sec: (frames + Math.max(0, roomFrames - 1)) / 48000,
      controls,
      room: body.room || "auto",
      windowed: score.duration > 90,
      measures: [...measures]
        .map(([n, t]) => ({ n, t }))
        .sort((a, b) => a.t - b.t),
      playback: {
        sample_rate: 48000,
        part_gain: 1 / Math.sqrt(copy.parts.length),
        room: roomEntry
          ? {
              channels: 4,
              layout: "LL,LR,RL,RR",
              frames: roomFrames,
              sample_rate: manifest.roomSampleRate,
              url: `/api/room/${room}-v1`,
              pure: true,
              wet_mix: wet,
              type: room,
            }
          : null,
      },
      stems: copy.parts.map((p, i) => ({
        part_id: p.id,
        name: p.name,
        voice_type: p.voice,
        pan: p.pan,
        channels: effective[i].mode === "voice" && stageActive(counts[i]) ? 2 : 1,
        instrument: effective[i],
        notes: p.events.map((e) => ({
          t: e.start,
          d: e.duration,
          midi: e.midi,
          text: e.lyric || "",
        })),
        lyrics: p.events
          .filter((e) => e.lyric)
          .map((e) => ({ t: e.start, text: e.lyric, midi: e.midi })),
      })),
    };
    const sonic = JSON.stringify([
      key,
      Object.entries(controls).filter(
        ([k]) => k !== "space" && k !== "preset_id",
      ),
      effective,
      sectionControls.map(c => Object.entries(c).filter(([k]) => k !== "space" && k !== "preset_id")),
      body.pronunciations,
      body.vowel_profile,
      body.english_diction,
    ]);
    if (!audioIds.has(sonic)) audioIds.set(sonic, ++serial);
    while (audioIds.size > 32) audioIds.delete(audioIds.keys().next().value);
    const take = {
      dictionary: pronunciationDictionary,
      id: audioIds.get(sonic),
      key,
      score,
      prepared: copy,
      header,
      body,
      controls,
      sectionControls,
      room,
      effective,
      frames,
      backends:new Set(),
    };
    takes.set(signature, take);
    while (takes.size > 5) takes.delete(takes.keys().next().value);
    return take;
  }
  function render(take, start, end, signal) {
    const job = queue
      .catch(() => {})
      .then(async () => {
        abort(signal);
        const a = Math.round(start * 48000),
          b = Math.round(end * 48000),
          keys = [];
        for (let k = a; k < b; k += 12000)
          keys.push(`${take.id}:${k}:${Math.min(12000, b - k)}`);
        if (a % 12000 === 0 && keys.every((k) => pcmCache.has(k))) {
          const stems = take.header.stems.map((s, i) => {
            const channels = s.channels || 1,
              out = new Float32Array((b - a) * channels);
            let at = 0;
            for (const k of keys) {
              const cached = pcmCache.get(k)[i],
                n = cached.length / channels;
              planes(cached, n).forEach((plane, c) => out.set(plane, at + c * (b - a)));
              at += n;
            }
            return out;
          });
          return { stems, elapsed: 0, backends:[...new Set(keys.flatMap(k=>pcmEvidence.get(k)||[]))] };
        }
        if (currentScore !== take.key) {
          await message("score", { score: take.score });
          currentScore = take.key;
        }
        abort(signal);
        const result = await message("render", {
          id: take.id,
          start,
          end,
          controls: take.controls,
          partControls: take.sectionControls,
          quality: 8,
          dictionary: take.dictionary,
          pronunciations: take.body.pronunciations,
          vowel_profile: take.body.vowel_profile || null,
          english_diction: take.body.english_diction,
          instruments: take.effective.map((i) =>
            i.mode === "voice" ? "voice" : "sample",
          ),
          programs: take.effective.map((i) => i.program),
          banks: take.effective.map((i) => i.bank),
          fonts: take.effective.map((i) => i.font),
        });
        for(const backend of result.backends||[])take.backends.add(backend);
        if (a % 12000 === 0) {
          for (let k = a; k < b; k += 12000) {
            const n = Math.min(12000, b - k),
              key = `${take.id}:${k}:${n}`;
            if (pcmCache.has(key)) continue;
            const slices = result.stems.map((p, i) => {
              const channels = take.header.stems[i].channels || 1,
                out = new Float32Array(n * channels);
              if (p.length)
                planes(p, b - a).forEach((plane, c) => out.set(plane.subarray(k - a, k - a + n), c * n));
              return out;
            });
            pcmCache.set(key, slices);pcmEvidence.set(key,result.backends||[]);
            cachedBytes += slices.reduce((total, x) => total + x.byteLength, 0);
          }
          while (cachedBytes > 64 * 1048576 && pcmCache.size) {
            const key = pcmCache.keys().next().value;
            cachedBytes -= pcmCache
              .get(key)
              .reduce((n, a) => n + a.byteLength, 0);
            pcmCache.delete(key);pcmEvidence.delete(key);
          }
        }
        metrics.cachedBytes = cachedBytes;
        metrics.windows.push({
          start,
          end,
          ms: result.elapsed,
          cpu: result.cpuMs,
        });
        if (metrics.windows.length > 32) metrics.windows.shift();
        metrics.chunks++;
        metrics.renderMs += result.elapsed;
        metrics.bankBytes = result.bankBytes;
        metrics.fontBytes = result.fontBytes;
        abort(signal);
        return result;
      });
    queue = job;
    return job;
  }
  // One part over one window, serialized with stream rendering (same queue).
  function queueSnippet(take, pi, start, end) {
    const job = queue.catch(() => {}).then(async () => {
      if (currentScore !== take.key) { await message("score", { score: take.score }); currentScore = take.key; }
      return message("render", {
        // The vowel workshop's loop stays one channel: it is judged close up.
        id: take.id, start, end, onlyPart: pi, stage: false, controls: take.controls, partControls: take.sectionControls, quality: 8,
        dictionary: take.dictionary, pronunciations: take.body.pronunciations, vowel_profile: take.body.vowel_profile || null,
        english_diction: take.body.english_diction,
        instruments: take.effective.map((i) => i.mode === "voice" ? "voice" : "sample"),
        programs: take.effective.map((i) => i.program), banks: take.effective.map((i) => i.bank), fonts: take.effective.map((i) => i.font),
      });
    });
    queue = job;
    return job;
  }
  function stream(take, body, signal, direct = false) {
    let start = Math.min(take.frames / 48000, Math.max(0, body.start_sec || 0));
    start = Math.floor(start * 4) / 4;
    const stop = take.header.windowed
      ? Math.min(
          take.frames / 48000,
          start + Math.ceil(4*Math.min(
              body.window_sec || 20,
              (64 * 1048576) / (take.header.stems.length * 48000 * 4),
            ))/4,
        )
      : take.frames / 48000;
    let ranges = [[start, stop]];
    if (!take.header.windowed && start > 0) ranges.push([0, start]);
    let header = false,
      first = true,
      finished = false,
      cancelled = false;
    const encoder = new TextEncoder();
    const events = new ReadableStream(
        {
          async pull(controller) {
            try {
              abort(signal);
              if (cancelled) return;
              if (!header) {
                header = true;
                controller.enqueue(direct ? take.header : encoder.encode(JSON.stringify(take.header) + "\n"));
                return;
              }
              while (ranges.length && ranges[0][0] >= ranges[0][1] - 0.000001)
                ranges.shift();
              if (!ranges.length) {
                finished = true;
                const done = {type: take.header.windowed ? "window_end" : "done"};
                controller.enqueue(direct ? done : encoder.encode(JSON.stringify(done) + "\n"));
                controller.close();
                return;
              }
              const [a, b] = ranges[0],
                end = Math.min(b, a + (first ? 0.25 : 1));
              first = false;
              const result = await render(take, a, end, signal);
              if (cancelled) return;
              const count = Math.round((end - a) * 48000);
              const event = {
                type: "chunk",
                start_frame: Math.round(a * 48000),
                frames: count,
                backends:result.backends,
                stems: await Promise.all(take.header.stems.map(async(s,i) => {
                  const pcm = result.stems[i].length ? result.stems[i] : new Float32Array(count * (s.channels || 1));
                  return {part_id:s.part_id,pcm_sha256:await digestBytes(new Uint8Array(pcm.buffer,pcm.byteOffset,pcm.byteLength)),...(direct ? {pcm} : {float32_base64:base64(new Uint8Array(pcm.buffer,pcm.byteOffset,pcm.byteLength))})};
                })),
              };
              ranges[0][0] = end;
              controller.enqueue(direct ? event : encoder.encode(JSON.stringify(event) + "\n"));
            } catch (error) {
              if (!finished && !cancelled) {
                finished = true;
                controller.error(error);
              }
            }
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 1 },
      );
    const response = new Response(direct ? null : events, {headers:{"Content-Type":direct ? "application/x-choir-events" : "application/x-ndjson"}});
    if(direct) response.localAudioEvents = events;
    return response;
  }
  async function full(take, body, signal, stemsNeeded = false) {
    const channels = body.stem_id ? take.header.stems.find((s) => s.part_id === body.stem_id)?.channels || 1 : 2,
      length = Math.round(take.header.duration_sec * 48000),
      off = new OfflineAudioContext(channels, length, 48000);
    const mix = take.header.stems.map((s) => {
      const m = body.balance?.[s.part_id] || {};
      return {
        pan: panOffset(s.channels, m.pan ?? s.pan, s.pan),
        level: Math.pow(10, (m.db || 0) / 20),
        mute: !!m.mute,
        solo: !!m.solo,
      };
    });
    const graph = body.stem_id
      ? null
      : await rooms.graphFor(
          off,
          mix,
          take.room,
          take.header.playback.room?.wet_mix / 0.48 || 0,
        );

    const sources=[];
    const buffers = stemsNeeded
      ? take.header.stems.map((s) => Array.from({ length: s.channels || 1 }, () => new Float32Array(length)))
      : null;
    for (let a = 0; a < take.frames / 48000; a += 2) {
      abort(signal);
      const b = Math.min(a + 2, take.frames / 48000),
        result = await render(take, a, b, signal);
      for (let i = 0; i < result.stems.length; i++) {
        const pcm = result.stems[i];
        if (!pcm.length) continue;
        const frames = Math.round((b - a) * 48000), channelData = planes(pcm, frames);
        channelData.forEach((plane, c) => buffers?.[i][c].set(plane, Math.round(a * 48000)));
        if (body.stem_id && take.header.stems[i].part_id !== body.stem_id)
          continue;
        const buffer = off.createBuffer(channelData.length, frames, 48000);
        channelData.forEach((plane, c) => buffer.copyToChannel(plane, c));
        const source = off.createBufferSource();
        source.buffer = buffer;
        if (body.stem_id) source.connect(off.destination);
        else source.connect(graph.channels[i].gain);
        source.start(a);
        sources.push(source);
      }
    }
    const rendered = await renderOffline(off,sources,graph),
      wav = encodeWav(
        Array.from({ length: channels }, (_, i) => rendered.getChannelData(i)),
      );
    return { wav, buffers };
  }
  globalThis.fetch = async (input, options = {}) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/") || url.pathname === "/api/diagnostics")
      return originalFetch(input, options);
    try {
      abort(options.signal);
      if (url.pathname === "/api/presets")
        return json({
          ...metadata,
          producer_identity:{schema:1,id:identity.id,runtime:"static"},
          ensemble_presets: config.presets,
          sample_bank: { ready: true },
          // Pronunciation systems and choir defaults (VV-PRONUNCIATION-SYSTEMS).
          pronunciation: { systems: context.systems, language_defaults: context.language_defaults, choir_systems: context.choir_systems },
        });
      if (url.pathname === "/api/identity") return json(identity);
      if (url.pathname.startsWith("/api/room/")) {
        const name = url.pathname
          .slice("/api/room/".length)
          .replace(/-v1$/, "");
        if (!manifest.rooms[name]) return json({ error: "Unknown room" }, 404);
        return new Response((await rooms.roomData(name)).buffer);
      }
      const body = JSON.parse(options.body || "{}");
      if (url.pathname === '/api/timing-plan') {
        // Timing workshop: the planner's notes, consonants, vowels and scoops per
        // part, as the render plans them (mirrors streaming.timing_plan).
        const take = await prepare(body);
        const parts = take.prepared.parts.map((p, i) => ({ part_id: p.id, name: p.name, sung: take.effective[i].mode === 'voice',
          notes: take.effective[i].mode !== 'voice' ? [] : p.lanes.flatMap((lane) => planNoteGeometry(lane,take.prepared.duration,take.sectionControls[i],config.inventory)) }));
        return json({ parts, tempo_bpm: take.header.tempo_bpm });
      }
      if (url.pathname === '/api/known-words') {
        // Mirrors phonetics/lyrics.py known_words: the lyrics workshop's error finder.
        const words = body.words;
        if (!Array.isArray(words) || words.length > 20000 || !words.every(w => typeof w === 'string' && w.length <= 128)) return json({ error: 'words must be a list of short strings' }, 400);
        const known = w => { const n = normalizeWord(w); return !!n && !!(config.lexicon?.[n] || config.context?.words?.[n] || config.context?.sung_words?.[n] || config.englishFallback?.[n]); };
        return json({ known: words.filter(known) });
      }
      if (url.pathname === '/api/vowel') {
        const voice=body.voice || 'tenor',pitch=Number(body.pitch ?? 57),weights=body.weights || {};
        if(!['soprano','alto','tenor','bass'].includes(voice)||!Number.isFinite(pitch)||pitch<36||pitch>84)throw Error('Choose a voice and pitch between C2 and C6');
        const allowed=['AA','AE','AH','AO','EH','ER','IH','IY','UH','UW','AX','A','I','U','E','O','Q','OH'];
        if(Object.keys(weights).some(k=>!allowed.includes(k))||!Object.values(weights).every(v=>Number.isFinite(v)&&v>=0)||Object.values(weights).reduce((a,b)=>a+b,0)<=0)throw Error('Invalid vowel weights');
        // section: the part's own size, up to the score's actor budget (as native).
        const section=!!body.section,actors=section?Math.round(Number(body.actors??1)):1;
        if(!(actors>=1&&actors<=8))throw Error('Choose between one and eight independent singers');
        const controls={...config.presets.find(p=>p.id==='baltic_chamber').controls,...body.controls,size:section?Math.max(1,Math.min(64,Math.round(Number(body.controls?.size??1)))):1};
        for(const [key,value] of Object.entries(controls))if(key!=='preset_id'&&!Number.isFinite(value))throw Error('Controls must be finite');
        const start=Number(body.start_sec ?? 0),end=Number(body.end_sec ?? start+2);
        if(!Number.isFinite(start+end)||start<0||end<=start||end>120||end-start>4)throw Error('Invalid audition window');
        const result=await message('vowel',{voice,pitch,weights,controls,start,end,actors});
        const singer={soprano:'f1',alto:'f2',tenor:'m1',bass:'m2'}[voice];
        const raw=new Uint8Array(await encodeWav([result.pcm]).blob.arrayBuffer());
        return json({audio_base64:base64(raw),snapshot:{engine:'recorded-world-vowel-v2',engine_hash:identity.id,
          producer_identity:{schema:1,id:identity.id,runtime:'static'},audio_identity:await wavIdentity(raw),
          source_hash:manifest.units[singer].sha256,singer,backend:result.backends,seed:1009,voice,pitch,section,actors,controls,weights,
          sample_rate:48000,start_sec:start,end_sec:end,duration_sec:120}});
      }
      if (url.pathname === '/api/snippet') {
        // Vowel workshop loop: one part, one short window, nothing else rendered.
        const take=await prepare(body),pi=take.header.stems.findIndex(s=>s.part_id===body.part_id);
        if(pi<0||take.effective[pi].mode!=='voice')throw Error('Choose a sung part of this score');
        const startSec=Number(body.start_sec),endSec=Number(body.end_sec);
        if(!Number.isFinite(startSec+endSec)||startSec<0||endSec<=startSec)throw Error('Invalid snippet window');
        const total=take.frames/48000,a=Math.floor(startSec*4)/4,b=Math.min(Math.ceil(total*4)/4,Math.ceil(endSec*4)/4);
        if(!(b>a)||b-a>30)throw Error('Choose a snippet between 0.25 and 30 seconds inside the piece');
        const result=await queueSnippet(take,pi,a,Math.min(b,total));
        const pcm=result.stems[pi].length?result.stems[pi]:new Float32Array(Math.round((Math.min(b,total)-a)*48000));
        return json({part_id:body.part_id,start_frame:Math.round(a*48000),frames:pcm.length,sample_rate:48000,
          producer_identity:{schema:1,id:identity.id,runtime:'static'},float32_base64:base64(new Uint8Array(pcm.buffer,pcm.byteOffset,pcm.byteLength))});
      }
      if(url.pathname === '/api/vowel-feedback' && (!options.method || options.method==='GET'))
        return json({reports:await feedback.all(),storage:'local',delivery_enabled:feedback.enabled()});
      if(url.pathname === '/api/vowel-feedback')return json(await feedback.save(body));
      if(url.pathname === '/api/vowel-feedback-delivery'){
        await feedback.setEnabled(body.enabled);return json({enabled:feedback.enabled()});
      }
      const take = await prepare(body);
      abort(options.signal);
      if (url.pathname === "/api/stream")
        return stream(take, body, options.signal, new Headers(options.headers).get("Accept") === "application/x-choir-events");
      if (url.pathname === "/api/download") {
        if (
          body.stem_id &&
          !take.header.stems.some((s) => s.part_id === body.stem_id)
        )
          throw Error("Unknown part");
        const wav = await exportPassages(
          take,
          body,
          manifest,
          render,
          options.signal,
          (progress) => {
            metrics.export = progress;
          },
        );
        return new Response(wav.blob, {
          headers: {
            "Content-Type": "audio/wav",
            "X-Lowered-Db": String(wav.reductionDb),
          },
        });
      }
      if (url.pathname === "/api/render") {
        const { wav, buffers } = await full(take, body, options.signal, true);
        const stems = [];
        for (let i = 0; i < buffers.length; i++)
          stems.push({
            ...take.header.stems[i],
            wav_base64: base64(
              new Uint8Array(await encodeWav(buffers[i]).blob.arrayBuffer()),
            ),
          });
        return json({
          ...take.header,
          producer_identity:{schema:1,id:identity.id,runtime:"static"},
          audio_identity:await wavIdentity(new Uint8Array(await wav.blob.arrayBuffer())),
          master_wav_base64: base64(
            new Uint8Array(await wav.blob.arrayBuffer()),
          ),
          stems,
        });
      }
      return json({ error: "Unknown local operation" }, 404);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      metrics.errors.push(error.message);
      return json({ error: error.message }, 400);
    }
  };
  window.browserChoir = {
    identity,
    metrics,
    pool,
    prepare,
    render,
    config,
    manifest,
    metadata,
    originalFetch,
  };
}
