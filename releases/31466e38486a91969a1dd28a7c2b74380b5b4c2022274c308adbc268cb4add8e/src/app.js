import { RenderPool } from "./render-pool.js";
import { mountStudio, syncStudio } from "./presentation.js";
import { fingerprint } from "./score-identity.js";
import { parseScore, unpackMusicXML } from "./score.js";
import { preparePronunciation } from "./pronunciation.js";
import {
  AudioEngine,
  findChunk,
  ranges,
  encodeWav,
  saveBlob,
} from "./audio.js";
const $ = (id) => document.getElementById(id),
  esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const controlsInfo = [
  ["size", "Section size", "Solo", "64 singers"],
  ["blend", "Blend", "Unified", "Individual"],
  ["tuning", "Intonation", "Locked", "Floating"],
  ["precision", "Ensemble timing", "Together", "Staggered"],
  ["phonation", "Voice core", "Airy", "Clear core"],
  ["weight", "Weight", "Fluty", "Grounded"],
  ["timbre", "Tone color", "Covered", "Forward"],
  ["vibrato", "Vibrato", "Straight", "Expressive"],
  ["age", "Maturity", "Youthful", "Mature"],
  ["articulation", "Articulation", "Legato", "Crisp"],
  ["space", "Room amount", "Close", "Spacious"],
];
let config,
  manifest,
  worker,
  engine,
  score,
  originalScore,
  xmlText = "",
  controls,
  selected,
  active,
  savedA,
  takeB,
  mix = [],
  overrides = {},
  serial = 0,
  requests = new Map(),
  busy = false,
  desiredPlay = false,
  position = 0,
  changing = false,
  exporting = false,
  cancelExport = false,
  loadEpoch = 0,
  scoreKey = "",
  fontPresets = [],
  error = "",
  started = 0;
const metrics = {
  firstAudioMs: null,
  renderMs: 0,
  audioSeconds: 0,
  chunks: 0,
  bankBytes: 0,
  fontBytes: 0,
  actorCount: 0,
  underruns: 0,
};
function status(text) {
  // Background buffering must not erase an error before it can be read.
  $("status").textContent = error || text;
}
function fail(e) {
  error = e.message || String(e);
  status(error);
  console.error(e);
  $("play").disabled = !score;
}
function message(type, data = {}) {
  const request = ++serial;
  return new Promise((resolve, reject) => {
    requests.set(request, { resolve, reject });
    worker.postMessage({ type, request, ...data });
  });
}
function setupWorker() {
  worker = new RenderPool();
  worker.onmessage = ({ data: m }) => {
    if (m.type === "progress") {
      metrics.progress = m;
      if (!engine.playing && (busy || desiredPlay)) {
        if (m.stage === "downloading" || m.stage === "retrying")
          status(
            `Loading voices · ${(m.received / 1048576).toFixed(1)} MB received${m.stage === "retrying" ? " · retrying connection" : ""}`,
          );
        else if (m.stage === "preparing")
          status(`Preparing ${m.part} · singer ${m.singer} of ${m.singers}`);
      }
      return;
    }
    if (m.type === "error") {
      requests.get(m.request)?.reject(Error(m.message));
      requests.delete(m.request);
      if (!m.request) fail(Error(m.message));
      return;
    }
    if (m.request) {
      requests.get(m.request)?.resolve(m);
      requests.delete(m.request);
    }
    if (m.type === "font") {
      fontPresets = m.presets;
      buildMixer();
    }
  };
  worker.onerror = (e) => {
    const error = Error(
      e.message ||
        "The audio worker could not start. Reload the page to try again.",
    );
    for (const request of requests.values()) request.reject(error);
    requests.clear();
    fail(error);
  };
  worker.postMessage({ type: "init", config, manifest });
}
function selectedRoom() {
  const choice = $("room").value;
  if (choice !== "auto") return choice;
  const space =
    config.presets.find((p) => p.id === controls.preset_id)?.controls.space ??
    controls.space;
  return space >= 0.78
    ? "cathedral"
    : space >= 0.4
      ? "concert_hall"
      : space >= 0.15
        ? "chamber"
        : "studio";
}
function newTake() {
  const sourceDuration =
    score.duration + (mix.some((m) => m.instrument === "sample") ? 2 : 0.2);
  const roomTail =
    manifest.rooms[selectedRoom()]?.fields.ir.shape[1] /
      (manifest.roomSampleRate || 24000) || 0;
  return {
    sourceDuration,
    duration: sourceDuration + (controls.space > 0 ? roomTail : 0),
    id: ++serial,
    controls: { ...controls },
    pronunciations: structuredClone(overrides),
    english_diction: $("diction").value,
    quality: +$("quality").value,
    room: selectedRoom(),
    roomChoice: $("room").value,
    instruments: mix.map((m) => m.instrument),
    programs: mix.map((m) => m.program),
    banks: mix.map((m) => m.bank || 0),
    chunks: new Map(),
    created: performance.now(),
  };
}
function updateControls() {
  for (const [key] of controlsInfo) {
    $("control-" + key).value = controls[key];
    $("value-" + key).textContent =
      key === "size" ? controls[key] : Math.round(controls[key] * 100) + "%";
  }
}
let editTimer;
function edited(roomOnly = false) {
  engine.preview(controls, active !== savedA);
  clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    const previous = selected;
    selected = newTake();
    if (roomOnly && previous) selected.chunks = new Map(previous.chunks);
    takeB = selected;
    error = "";
    status(
      desiredPlay
        ? "Preparing selected settings…"
        : "Preparing at current position…",
    );
    pump();
    saveSettings();
  }, 180);
}
function savePronunciation() {
  try {
    localStorage.setItem(
      "choir-pron:" + scoreKey,
      JSON.stringify({
        pronunciations: overrides,
        english_diction: $("diction").value,
      }),
    );
  } catch {}
}
function saveSettings() {
  try {
    localStorage.setItem(
      "choir-browser-settings",
      JSON.stringify({
        controls,
        room: $("room").value,
        quality: $("quality").value,
        engineVersion: 2,
      }),
    );
  } catch {}
}
function buildMixer() {
  if (!score) return;
  $("mixer").innerHTML = mix
    .map(
      (m, i) =>
        `<div class="channel"><div class="name">${esc(score.parts[i].name)}<select aria-label="Instrument for ${esc(score.parts[i].name)}" data-instrument="${i}"><option value="voice" ${m.instrument === "voice" ? "selected" : ""}>Recorded choir</option>${(fontPresets.length
          ? fontPresets
          : [
              { program: 0, name: "Piano" },
              { program: 19, name: "Church organ" },
              { program: 48, name: "Strings" },
            ]
        )
          .map(
            (p) =>
              `<option value="${p.bank ? p.bank + ":" : ""}${p.program}" ${m.instrument === "sample" && m.program === p.program && (m.bank || 0) === (p.bank || 0) ? "selected" : ""}>${esc(p.name)}${p.bank === 128 ? " · percussion" : ""}</option>`,
          )
          .join(
            "",
          )}<option value="silent" ${m.instrument === "silent" ? "selected" : ""}>Silent</option></select></div><button data-mute="${i}" class="${m.mute ? "active" : ""}" aria-label="Mute ${esc(score.parts[i].name)}">M</button><button data-solo="${i}" class="${m.solo ? "active" : ""}" aria-label="Solo ${esc(score.parts[i].name)}">S</button><label>LEVEL<input aria-label="Level ${esc(score.parts[i].name)}" data-level="${i}" type="range" min="0" max="1.5" step="0.01" value="${m.level}"></label><label>PAN<input aria-label="Pan ${esc(score.parts[i].name)}" data-pan="${i}" type="range" min="-1" max="1" step="0.01" value="${m.pan}"></label></div>`,
    )
    .join("");
  $("mixer")
    .querySelectorAll("[data-mute],[data-solo]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          const key = b.dataset.mute != null ? "mute" : "solo",
            i = Number(b.dataset[key]);
          mix[i][key] = !mix[i][key];
          engine.setMix(mix);
          buildMixer();
        }),
    );
  $("mixer")
    .querySelectorAll("input")
    .forEach(
      (el) =>
        (el.oninput = () => {
          const key = el.dataset.level != null ? "level" : "pan",
            i = Number(el.dataset[key]);
          mix[i][key] = +el.value;
          engine.setMix(mix);
        }),
    );
  $("mixer")
    .querySelectorAll("select")
    .forEach((el) => {
      el.onfocus = () => {
        if (!fontPresets.length) worker.postMessage({ type: "font" });
      };
      el.onchange = () => {
        const m = mix[+el.dataset.instrument];
        const sampled = /^\d+(?::\d+)?$/.test(el.value);
        m.instrument = sampled ? "sample" : el.value;
        if (sampled) {
          const values = el.value.split(":").map(Number);
          m.program = values.at(-1);
          m.bank = values.length > 1 ? values[0] : 0;
        }
        if (m.instrument === "sample") worker.postMessage({ type: "font" });
        edited();
      };
    });
}
let wordPage = 0;
function showWords() {
  const plan = score.pronunciation,
    query = $("word-search").value.toLowerCase(),
    filtered = plan.words.filter((w) => w.text.toLowerCase().includes(query));
  wordPage = Math.min(
    wordPage,
    Math.max(0, Math.ceil(filtered.length / 150) - 1),
  );
  $("word-count").textContent =
    `${filtered.length} words · page ${wordPage + 1} / ${Math.max(1, Math.ceil(filtered.length / 150))}`;
  $("words").innerHTML = filtered
    .slice(wordPage * 150, (wordPage + 1) * 150)
    .map(
      (w) =>
        `<button data-word="${esc(w.id)}" class="${w.review ? "uncertain" : ""}" title="${esc(w.source)} · ${esc(w.language)}">${esc(w.text)}<small>${esc(w.phones.join(" "))}</small></button>`,
    )
    .join("");
  $("words")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          const w = plan.words.find((w) => w.id === b.dataset.word);
          $("correction-word").textContent =
            `${w.text} · ${w.language} · ${w.source}`;
          $("correction-phones").value = "";
          $("correction-phones").placeholder = "e.g. liːd or lɛd";
          $("correction-choice").innerHTML =
            '<option value="">Keep rule/dictionary choice</option>' +
            Object.entries(w.alternatives || {})
              .map(
                ([key, c]) =>
                  `<option value="${key}" ${key === w.choice ? "selected" : ""}>${esc(c.label)}</option>`,
              )
              .join("");
          $("correction-language").value = w.language;
          $("correction-error").textContent = "";
          $("correction").dataset.word = w.id;
          $("correction").showModal();
        }),
    );
}
async function installScore(parsed) {
  loadEpoch++;
  desiredPlay = false;
  engine.stop(0);
  position = 0;
  selected = active = savedA = takeB = null;
  $("ab").disabled = true;
  score = parsed;
  const pitches = score.parts.flatMap((p) => p.events.map((e) => e.midi));
  score.minPitch = pitches.reduce((a, b) => Math.min(a, b), Infinity) - 3;
  score.maxPitch = pitches.reduce((a, b) => Math.max(a, b), -Infinity) + 3;
  preparePronunciation(score, config, overrides, $("diction").value);
  await message("score", { score });
  mix = score.parts.map((p) => ({
    level: 1,
    pan: p.pan,
    mute: false,
    solo: false,
    instrument: p.instrument,
    program: p.program,
    bank: p.bank || 0,
  }));
  $("title").textContent = score.title;
  $("subtitle").textContent =
    `${score.composer ? score.composer + " · " : ""}${score.parts.length} parts · ${format(score.duration)} · ${score.language} · processed locally`;
  $("seek").max = score.duration;
  $("warnings").textContent = score.warnings.join(" ");
  buildMixer();
  if (mix.some((m) => m.instrument === "sample") && !fontPresets.length)
    worker.postMessage({ type: "font" });
  $("stem-part").innerHTML = score.parts
    .map((p, i) => `<option value="${i}">${esc(p.name)}</option>`)
    .join("");
  showWords();
  selected = newTake();
  takeB = selected;
  $("play").disabled = false;
  $("play").textContent = "Play";
  started = performance.now();
  metrics.firstAudioMs = null;
  status("Preparing first passage…");
  pump();
}
async function loadXml(xml) {
  // Validate before replacing the current score's identity or saved choices.
  const parsed = parseScore(xml, $("language").value);
  const key = await fingerprint(xml);
  error = "";
  xmlText = xml;
  scoreKey = key;
  overrides = {};
  try {
    const saved = JSON.parse(localStorage.getItem("choir-pron:" + scoreKey));
    if (saved) {
      overrides = saved.pronunciations || {};
      $("diction").value = saved.english_diction || "choral";
    }
  } catch {}
  originalScore = parsed;
  await installScore(structuredClone(originalScore));
}
async function loadLibrary() {
  try {
    const response = await fetch("./public/scores/" + $("library").value);
    if (!response.ok) throw Error("Score missing");
    await loadXml(await response.text());
    $("drop-zone").classList.remove("selected");
    $("drop-zone").querySelector(".txt").textContent =
      "Have your own? Drop a MusicXML file here (.musicxml, .xml or compressed .mxl).";
  } catch (e) {
    fail(e);
  }
}
async function requestChunk(
  take,
  start,
  exportRequest = false,
  initial = false,
) {
  const previous = exportRequest ? null : take.chunks.get(start);
  const actualStart = previous?.end ?? start;
  const end = Math.min(
      exportRequest ? take.sourceDuration : take.duration,
      start + 1,
      initial
        ? Math.max(actualStart + 0.25, currentPosition() + 0.25)
        : Infinity,
    ),
    epoch = loadEpoch;
  const m = await message("render", {
    id: take.id,
    start: actualStart,
    end,
    controls: take.controls,
    quality: take.quality,
    instruments: take.instruments,
    programs: take.programs,
    banks: take.banks,
    pronunciations: take.pronunciations,
    english_diction: take.english_diction,
  });
  if (epoch !== loadEpoch) throw Error("Score changed");
  if (!exportRequest) {
    if (previous) {
      const before = Math.round((previous.end - start) * 48000),
        after = Math.round((end - previous.end) * 48000);
      m.stems = m.stems.map((pcm, i) => {
        if (!pcm.length && !previous.stems[i].length) return pcm;
        const joined = new Float32Array(before + after);
        joined.set(previous.stems[i]);
        joined.set(pcm, before);
        return joined;
      });
      m.start = start;
    }
    take.chunks.set(start, m);
    metrics.renderMs += m.elapsed;
    metrics.audioSeconds += end - actualStart;
    metrics.chunks++;
    metrics.bankBytes = m.bankBytes;
    metrics.fontBytes = m.fontBytes;
    metrics.actorCount = m.actorCount;
    if (metrics.firstAudioMs == null) {
      metrics.firstAudioMs = performance.now() - started;
      status("Ready · first passage buffered");
    }
  }
  return m;
}
function currentPosition() {
  return engine.playing ? engine.now() : position;
}
function playable(take, position) {
  const range = ranges(take).find(
    ([a, b]) => a <= position + 1e-5 && b > position,
  );
  return (
    !!range && (range[1] - position >= 0.65 || range[1] >= take.duration - 1e-5)
  );
}
async function adopt(take) {
  if (changing) return;
  changing = true;
  try {
    const p = currentPosition();
    if (desiredPlay) {
      await engine.start(take, p, mix, take.room, take.controls.space);
    } else if (engine.playing) engine.stop(p);
    active = take;
    position = p;
    status(desiredPlay ? "Playing" : "Ready");
    $("play").textContent = desiredPlay ? "Pause" : "Play";
  } finally {
    changing = false;
  }
}
async function pump() {
  if (!score || !selected || busy || exporting) return;
  busy = true;
  try {
    const p = currentPosition(),
      take = selected,
      target = Math.min(
        Math.floor(take.duration - 0.001),
        Math.floor(
          p + (desiredPlay && active && active !== selected ? 1.25 : 0),
        ),
      ),
      epoch = loadEpoch;
    if (!take.chunks.has(target) && p < take.duration)
      await requestChunk(take, target, false, !desiredPlay);
    if (epoch !== loadEpoch) return;
    if (
      take === selected &&
      findChunk(take, currentPosition()) &&
      (!desiredPlay || playable(take, currentPosition()))
    ) {
      if (active !== take || (desiredPlay && !engine.playing))
        await adopt(take);
      else if (!desiredPlay) status("Ready");
    }
    const pos = currentPosition(),
      byteRate = score.parts.length * 48000 * 4,
      capacity = Math.max(2, Math.floor((24 * 1048576) / byteRate)),
      ahead = Math.min(8, Math.max(1, capacity - 2)),
      behind = Math.min(15, Math.max(0, capacity - ahead - 1)),
      horizon = desiredPlay ? ahead : 2;
    for (
      let s = Math.floor(pos);
      s < Math.min(take.duration, pos + horizon);
      s++
    ) {
      if (
        !take.chunks.has(s) ||
        take.chunks.get(s).end < Math.min(take.duration, s + 1) - 1e-6
      ) {
        await requestChunk(take, s);
        break;
      }
    }
    for (const t of new Set(
      [selected, active, savedA, takeB].filter(Boolean),
    )) {
      for (const [s] of t.chunks)
        if (s < Math.floor(pos) - behind || s > Math.floor(pos) + ahead + 1)
          t.chunks.delete(s);
      let bytes = [...t.chunks.values()].reduce(
        (sum, c) => sum + c.stems.reduce((sum, a) => sum + a.byteLength, 0),
        0,
      );
      const candidates = [...t.chunks.keys()]
        .filter((s) => s !== Math.floor(pos))
        .sort((a, b) => Math.abs(b - pos) - Math.abs(a - pos));
      for (const key of candidates) {
        if (bytes <= 24 * 1048576) break;
        bytes -= t.chunks
          .get(key)
          .stems.reduce((sum, a) => sum + a.byteLength, 0);
        t.chunks.delete(key);
      }
    }
    if (engine.playing) {
      engine.schedule(active);
      if (engine.underrun() && currentPosition() < active.duration - 0.03) {
        position = engine.now();
        engine.stop(position);
        metrics.underruns++;
        status("Buffering · playback will resume");
      }
    }
  } catch (e) {
    if (e.message !== "Score changed") {
      desiredPlay = false;
      engine.stop();
      fail(e);
    }
  } finally {
    busy = false;
  }
}
function format(t) {
  const m = Math.floor(t / 60),
    s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function drawCanvas(id, overview = false) {
  const canvas = $(id),
    dpr = devicePixelRatio || 1,
    width = canvas.clientWidth,
    height = canvas.clientHeight;
  if (
    canvas.width !== Math.round(width * dpr) ||
    canvas.height !== Math.round(height * dpr)
  ) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const theme = getComputedStyle(document.documentElement);
  const color = (name) => theme.getPropertyValue(name).trim();
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!score) return;
  const p = currentPosition(),
    duration = selected?.duration || score.duration,
    span = overview ? duration : Math.min(22, duration),
    begin = overview ? 0 : Math.max(0, Math.min(duration - span, p - 4)),
    sx = (t) => ((t - begin) / span) * width;
  const retained = ranges(selected);
  for (const [a, b] of retained) {
    ctx.fillStyle = color("--card-2");
    ctx.fillRect(sx(a), 0, ((b - a) / span) * width, height);
  }
  const colors = ["--soprano", "--alto", "--tenor", "--bass", "--other"].map(
    color,
  );
  if (!overview) {
    ctx.strokeStyle = color("--line");
    ctx.lineWidth = 0.5;
    for (
      let midi = Math.ceil(score.minPitch / 4) * 4;
      midi <= score.maxPitch;
      midi += 4
    ) {
      const y =
        height -
        ((midi - score.minPitch) / (score.maxPitch - score.minPitch)) * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.fillStyle = color("--ink-3");
    ctx.font = "9px system-ui";
    for (let t = Math.ceil(begin / 2) * 2; t < begin + span; t += 2)
      ctx.fillText(format(t), sx(t) + 3, 12);
  }
  score.parts.forEach((part, pi) => {
    for (const e of part.events) {
      const a = Math.max(begin, e.start),
        b = Math.min(begin + span, e.start + e.duration);
      if (b <= a) continue;
      const y = overview
          ? 5 + (pi * (height - 10)) / score.parts.length
          : height -
            ((e.midi - score.minPitch) / (score.maxPitch - score.minPitch)) *
              height,
        h = overview ? Math.max(2, (height - 12) / score.parts.length) : 5;
      ctx.fillStyle = color("--line-2");
      ctx.fillRect(sx(a), y, Math.max(1, sx(b) - sx(a) - 0.5), h);
      ctx.fillStyle = colors[pi % colors.length];
      for (const [r0, r1] of retained) {
        const left = Math.max(a, r0),
          right = Math.min(b, r1);
        if (right > left)
          ctx.fillRect(
            sx(left),
            y,
            Math.max(0.5, sx(right) - sx(left) - 0.5),
            h,
          );
      }
    }
  });
  ctx.strokeStyle = color("--accent");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(sx(p), 0);
  ctx.lineTo(sx(p), height);
  ctx.stroke();
  canvas.onclick = (e) =>
    seek(
      begin +
        ((e.clientX - canvas.getBoundingClientRect().left) / width) * span,
    );
}
let lastDraw = 0;
function tick(now = 0) {
  if (now - lastDraw < 50) {
    requestAnimationFrame(tick);
    return;
  }
  lastDraw = now;
  syncStudio(controls, !!savedA && selected === savedA);
  if (score) {
    const p = currentPosition();
    $("time").textContent =
      `${format(p)} / ${format(selected?.duration || score.duration)}`;
    $("seek").max = selected?.duration || score.duration;
    $("seek").value = p;
    $("previous").textContent =
      active && active !== selected && engine.playing
        ? engine.graph?.preview?.active
          ? "Live tone preview · new settings preparing"
          : "Previous settings playing"
        : "";
    if (p >= (active?.duration || score.duration) - 0.015 && desiredPlay) {
      desiredPlay = false;
      position = active?.duration || score.duration;
      engine.stop(position);
      $("play").textContent = "Play";
      status("Complete");
    }
    const current = score.parts.map((part) => {
      const e = part.events.find(
        (e) => e.start <= p && e.start + e.duration > p,
      );
      return { name: part.name, lyric: e?.displayLyric || e?.lyric || "—" };
    });
    $("lyrics").innerHTML = current
      .slice(0, 4)
      .map((c) => `<span><small>${esc(c.name)}</small>${esc(c.lyric)}</span>`)
      .join("");
    $("all-lyrics").textContent = current
      .map((c) => `${c.name}: ${c.lyric}`)
      .join(" · ");
    if (engine.playing) engine.schedule(active);
    drawCanvas("overview", true);
    drawCanvas("roll");
    const retained = [
      ...new Set([selected, active, savedA, takeB].filter(Boolean)),
    ].reduce(
      (s, t) =>
        s +
        [...t.chunks.values()].reduce(
          (n, c) => n + c.stems.reduce((n, a) => n + a.byteLength, 0),
          0,
        ),
      0,
    );
    $("metrics").textContent =
      `First usable passage: ${metrics.firstAudioMs == null ? "preparing" : (metrics.firstAudioMs / 1000).toFixed(2) + " s"} · Worker throughput: ${(metrics.audioSeconds / (metrics.renderMs / 1000 || 1)).toFixed(2)}× realtime · Retained PCM: ${(retained / 1048576).toFixed(1)} MiB · Source bank: ${(metrics.bankBytes / 1048576).toFixed(1)} MiB · SF2: ${(metrics.fontBytes / 1048576).toFixed(1)} MiB · ${metrics.actorCount} representatives per lane · ${metrics.underruns} underruns · Main-thread heap: ${performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + " MiB" : "unavailable in this browser"}`;
  }
  requestAnimationFrame(tick);
}
async function seek(value) {
  position = Math.max(
    0,
    Math.min((selected?.duration || score.duration) - 0.001, value),
  );
  engine.stop(position);
  status("Seeking…");
  await pump();
}
async function download(dry = false, stemIndex = null) {
  if (exporting || !score) return;
  if (score.duration > 600) {
    $("export-status").textContent =
      "Full browser export is limited to 10 minutes; playback and seeking remain available for longer scores.";
    return;
  }
  exporting = true;
  cancelExport = false;
  $("cancel-export").hidden = false;
  const take = selected,
    renderScore = score,
    exportMix = structuredClone(mix);
  try {
    desiredPlay = false;
    position = currentPosition();
    engine.stop(position);
    $("play").textContent = "Play";
    const room =
        dry || stemIndex !== null || take.controls.space === 0
          ? "dry"
          : take.room,
      raw = await engine.roomData(room),
      tail = raw ? raw.length / 4 / (manifest.roomSampleRate || 24000) : 0,
      length = Math.ceil((take.sourceDuration + tail) * 48000),
      offline = new OfflineAudioContext(
        stemIndex === null ? 2 : 1,
        length,
        48000,
      ),
      graph =
        stemIndex === null
          ? await engine.graphFor(offline, exportMix, room, take.controls.space)
          : null;
    for (let start = 0; start < take.sourceDuration; start++) {
      if (cancelExport || score !== renderScore)
        throw Error("Export cancelled");
      const cached = take.chunks.get(start);
      const chunk =
        cached && cached.end >= Math.min(take.sourceDuration, start + 1) - 1e-6
          ? cached
          : await requestChunk(take, start, true);
      chunk.stems.forEach((pcm, i) => {
        if (!pcm.length || (stemIndex !== null && i !== stemIndex)) return;
        const buffer = offline.createBuffer(1, pcm.length, 48000);
        buffer.copyToChannel(pcm, 0);
        const source = offline.createBufferSource();
        source.buffer = buffer;
        source.connect(graph ? graph.channels[i].gain : offline.destination);
        source.start(
          start,
          0,
          Math.min(pcm.length / 48000, take.sourceDuration - start),
        );
      });
      $("export-status").textContent =
        `Rendering locally… ${Math.min(100, Math.round(((start + 1) / take.sourceDuration) * 100))}%`;
    }
    if (cancelExport) throw Error("Export cancelled");
    const output = await offline.startRendering(),
      wav = encodeWav(
        Array.from({ length: output.numberOfChannels }, (_, i) =>
          output.getChannelData(i),
        ),
      );
    saveBlob(
      wav.blob,
      `${renderScore.title.replace(/[^\p{L}\p{N} _-]/gu, "")}${stemIndex !== null ? " " + renderScore.parts[stemIndex].name.replace(/[^\p{L}\p{N} _-]/gu, "") : dry ? " dry" : ""}.wav`,
    );
    $("export-status").textContent =
      `Downloaded ${format(take.sourceDuration + tail)} · 48 kHz ${stemIndex === null ? "stereo" : "mono"} PCM · peak adjustment ${wav.reductionDb.toFixed(2)} dB`;
  } catch (e) {
    $("export-status").textContent = e.message;
  } finally {
    exporting = false;
    $("cancel-export").hidden = true;
  }
}
async function init() {
  try {
    [config, manifest] = await Promise.all(
      ["./public/config.json", "./public/assets/bank.json"].map((url) =>
        fetch(url).then((r) => {
          if (!r.ok)
            throw Error(
              "Public bank missing. Run browser/scripts/export_bank.py before serving.",
            );
          return r.json();
        }),
      ),
    );
    config.context = await fetch("./public/context.json").then((r) => r.json());
    config.dictionary = await fetch("./public/dictionary.json").then((r) =>
      r.json(),
    );
    const cmuResponse = await fetch("./public/english-cmu.json.gz");
    if (!cmuResponse.ok) throw Error("Offline English dictionary is missing");
    config.englishFallback = await new Response(
      cmuResponse.body.pipeThrough(new DecompressionStream("gzip")),
    ).json();
    engine = new AudioEngine(manifest);
    controls = {
      ...config.presets.find((p) => p.id === "baltic_chamber").controls,
    };
    try {
      const stored = JSON.parse(localStorage.getItem("choir-browser-settings"));
      if (stored) {
        controls = { ...controls, ...stored.controls };
        $("room").value = stored.room || "auto";
        $("quality").value =
          stored.engineVersion === 2 ? stored.quality || "8" : "8";
      }
    } catch {}
    $("controls").innerHTML = controlsInfo
      .map(
        ([key, name, low, high]) =>
          `<div class="control"><label for="control-${key}">${name}<output id="value-${key}"></output></label><input id="control-${key}" type="range" min="${key === "size" ? 1 : 0}" max="${key === "size" ? 64 : 1}" step="${key === "size" ? 1 : 0.01}"><small><span>${low}</span><span>${high}</span></small></div>`,
      )
      .join("");
    updateControls();
    controlsInfo.forEach(
      ([key]) =>
        ($("control-" + key).oninput = (e) => {
          controls[key] = +e.target.value;
          updateControls();
          edited(key === "space");
        }),
    );
    $("preset").innerHTML = config.presets
      .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
      .join("");
    $("preset").value = controls.preset_id;
    $("preset-description").textContent =
      config.presets.find((p) => p.id === controls.preset_id)?.description ||
      "";
    $("preset").onchange = () => {
      const p = config.presets.find((p) => p.id === $("preset").value);
      controls = { ...p.controls };
      $("preset-description").textContent = p.description;
      updateControls();
      edited();
    };
    $("reset").onclick = () => $("preset").onchange();
    $("room").onchange = () => edited(true);
    $("quality").onchange = () => edited();
    setupWorker();
    const library = await fetch("./public/scores.json").then((r) => r.json());
    $("library").innerHTML = library
      .map(
        (f) =>
          `<option value="${f}">${f.replace(/_satb.musicxml$/, "").replaceAll("_", " ")}</option>`,
      )
      .join("");
    $("library").onchange = loadLibrary;
    $("upload").onchange = async (e) => {
      try {
        const file = e.target.files[0];
        if (!file) return;
        status("Reading score locally…");
        await loadXml(await unpackMusicXML(await file.arrayBuffer()));
        $("drop-zone").classList.add("selected");
        $("drop-zone").querySelector(".txt").textContent = file.name;
      } catch (e) {
        fail(e);
      }
    };
    $("play").onclick = async () => {
      if (!score) return;
      try {
        error = "";
        await engine.resume();
        if (desiredPlay) {
          desiredPlay = false;
          position = currentPosition();
          engine.stop(position);
          $("play").textContent = "Play";
          status("Paused");
        } else {
          if (position >= (selected?.duration || score.duration) - 0.03)
            position = 0;
          desiredPlay = true;
          started = performance.now();
          $("play").textContent = "Pause";
          if (playable(selected, position)) await adopt(selected);
          else status("Preparing audio…");
          pump();
        }
      } catch (e) {
        fail(e);
      }
    };
    $("stop").onclick = () => {
      desiredPlay = false;
      position = 0;
      engine.stop(0);
      $("play").textContent = "Play";
      status("Stopped");
      pump();
    };
    $("seek").oninput = (e) => seek(+e.target.value);
    $("save-a").onclick = () => {
      savedA = selected;
      takeB = selected;
      $("ab").disabled = false;
      status("Take A saved · buffered audio + settings");
    };
    $("ab").onclick = () => {
      if (selected === savedA && takeB !== savedA) {
        selected = takeB;
        $("ab").textContent = "Hear A";
      } else {
        if (selected !== savedA) takeB = selected;
        selected = savedA;
        $("ab").textContent = "Hear B";
      }
      controls = { ...selected.controls };
      $("quality").value = selected.quality;
      overrides = structuredClone(selected.pronunciations);
      $("diction").value = selected.english_diction;
      preparePronunciation(score, config, overrides, $("diction").value);
      showWords();
      $("room").value = selected.roomChoice || selected.room;
      mix.forEach((m, i) => {
        m.instrument = selected.instruments[i];
        m.program = selected.programs[i];
        m.bank = selected.banks[i];
      });
      buildMixer();
      updateControls();
      pump();
    };
    $("language").onchange = () => loadXml(xmlText);
    $("tempo").onchange = async () => {
      const factor = +$("tempo").value / 100;
      $("tempo-label").textContent = Math.round(factor * 100) + "%";
      const parsed = structuredClone(originalScore);
      parsed.duration /= factor;
      for (const p of parsed.parts)
        for (const e of p.events) {
          e.start /= factor;
          e.duration /= factor;
        }
      await installScore(parsed);
    };
    $("correction-save").onclick = async (e) => {
      e.preventDefault();
      const key = $("correction").dataset.word,
        old = overrides[key],
        value = { language: $("correction-language").value };
      if ($("correction-choice").value)
        value.choice = $("correction-choice").value;
      if ($("correction-phones").value.trim())
        value.ipa = $("correction-phones").value.trim();
      overrides[key] = value;
      try {
        preparePronunciation(score, config, overrides, $("diction").value);
        await message("score", { score });
        $("correction").close();
        savePronunciation();
        showWords();
        edited();
      } catch (error) {
        if (old) overrides[key] = old;
        else delete overrides[key];
        $("correction-error").textContent = error.message;
      }
    };
    $("diction").onchange = async () => {
      preparePronunciation(score, config, overrides, $("diction").value);
      await message("score", { score });
      savePronunciation();
      showWords();
      edited();
    };
    $("word-search").oninput = () => {
      wordPage = 0;
      showWords();
    };
    $("words-prev").onclick = () => {
      wordPage = Math.max(0, wordPage - 1);
      showWords();
    };
    $("words-next").onclick = () => {
      wordPage++;
      showWords();
    };
    $("plan-download").onclick = () =>
      saveBlob(
        new Blob([JSON.stringify(score.pronunciation, null, 2)], {
          type: "application/json",
        }),
        "pronunciation-plan.json",
      );
    $("download").onclick = () => download(false);
    $("download-dry").onclick = () => download(true);
    $("download-stem").onclick = () => download(true, +$("stem-part").value);
    $("reset-mix").onclick = () => {
      mix.forEach((m, i) =>
        Object.assign(m, {
          level: 1,
          pan: score.parts[i].pan,
          mute: false,
          solo: false,
        }),
      );
      engine.setMix(mix);
      buildMixer();
    };
    document.addEventListener("keydown", (e) => {
      if (
        e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.target.closest(
          "input,select,textarea,button,[contenteditable=true],dialog",
        ) ||
        !score
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        $("play").click();
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        e.preventDefault();
        seek(currentPosition() + (e.code === "ArrowLeft" ? -5 : 5));
      } else if (e.key.toLowerCase() === "t" && !$("ab").disabled) {
        e.preventDefault();
        $("ab").click();
      }
    });
    $("cancel-export").onclick = () => (cancelExport = true);
    mountStudio(config);
    await loadLibrary();
    setInterval(pump, 100);
    requestAnimationFrame(tick);
    globalThis.choir = {
      get score() {
        return score;
      },
      get selected() {
        return selected;
      },
      get active() {
        return active;
      },
      get metrics() {
        return { ...metrics, heap: performance.memory?.usedJSHeapSize };
      },
      get engine() {
        return engine;
      },
      get mix() {
        return mix;
      },
      get controls() {
        return controls;
      },
      get busy() {
        return busy;
      },
      get desiredPlay() {
        return desiredPlay;
      },
      get exporting() {
        return exporting;
      },
      loadXml,
      seek,
      requestChunk,
      edited,
      ranges,
      download,
      get config() {
        return config;
      },
      get scoreKey() {
        return scoreKey;
      },
    };
  } catch (e) {
    fail(e);
  }
}
init();
