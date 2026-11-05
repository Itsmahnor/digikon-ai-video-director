// Director Console: plain ES module, no build step. All model and user text goes through esc() before it reaches the DOM.
import { mountWizard, fileProblem } from "./wizard.js";
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDur = (s) => (s == null ? "" : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${(Math.round(s * 10) / 10).toString()}s`);

const ICON = {
  spark: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8zM19 14l.9 2.6L22.5 17.5l-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9z"/></svg>',
  layers: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M12 3l9 5-9 5-9-5 9-5zm-9 9l9 5 9-5M3 16l9 5 9-5"/></svg>',
  cut: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/></svg>',
  video: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M4 6h11a2 2 0 0 1 2 2v1.5l4-2.5v10l-4-2.5V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/></svg>',
  audio: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M4 10v4h3l5 4V6L7 10H4zm12.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm2 11l3-4 2.5 3 2-2.5L19 17H7z"/></svg>',
};
const MODES = {
  create_minimal: { tag: "A", icon: ICON.spark, title: "Create from an idea", text: "Little or no footage. I plan a graphics-led video and tell you what would make it better." },
  create_full: { tag: "B", icon: ICON.layers, title: "Create from your material", text: "You have clips, images or audio. I build the plan around them." },
  edit_existing: { tag: "C", icon: ICON.cut, title: "Edit an existing video", text: "You have a reel. Tell me what to change and the editing agent will do it." },
};
const STEPS = [
  ["intake", "Understand the brief"], ["analyse_assets", "Check your files"], ["video_type_step", "Choose video type"], ["treatment", "Write the treatment and claims"],
  ["storyboard", "Storyboard the scenes"], ["storyboard_gate", "Your approval of the storyboard"],
  ["edit_plan", "Choose a recipe for every edit"], ["edit_plan_gate", "Your approval of the edit plan"],
];
const PHASES = ["Describe", "Understand", "Plan", "Approve"];

const state = {
  sid: null, health: null, offline: false, assets: [], analysis: {}, turns: [], route: null, busy: false,
  fromVoice: false, language: null, videoType: null, proposedVideoTypes: [], previews: {},
  run: null, // { steps: {node: {status, lines}}, result, error }
  approval: null, gateNotes: "", tab: "treatment", transcripts: {}, mic: null,
};

// ---------- api ----------
const OFFLINE = "Cannot reach the console server. It may have stopped. Start it with npm run console (or npm run console:demo), then refresh this page.";
const offlineError = () => { const e = new Error(OFFLINE); e.code = "offline"; return e; };
async function api(path, opts = {}) {
  let res;
  try { res = await fetch(path, opts); } catch { throw offlineError(); }
  if (res.ok) return res.json();
  const body = await res.json().catch(() => ({}));
  const err = new Error(body.message || `Request failed (${res.status})`);
  err.code = body.error; err.status = res.status;
  throw err;
}
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`; el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "ok" ? 3500 : kind === "long" ? 15000 : 7000);
}
const fail = (e) => {
  toast(e instanceof Error ? e.message : String(e), String(e?.code ?? "").startsWith("llm_") ? "long" : "");
  if (String(e?.code ?? "").startsWith("llm_")) refreshHealth(); // so the status bar shows the problem too
};

// ---------- header ----------
function renderPills() {
  if (state.offline) {
    $("#pills").innerHTML = `<span class="pill bad" title="${esc(OFFLINE)}"><i></i>Console server <b>offline</b></span>`;
    return;
  }
  const h = state.health;
  if (!h) return;
  const p = [];
  const PROBLEM = { llm_billing: "no credit", llm_auth: "key rejected", llm_model: "model not found" };
  if (h.llm.demo) p.push(`<span class="pill demo"><i></i>Model <b>Demo (not Claude)</b></span>`);
  else if (h.llm.problem) p.push(`<span class="pill bad" title="${esc(h.llm.problem.message)}"><i></i>Claude <b>${PROBLEM[h.llm.problem.code] ?? "needs attention"}</b></span>`);
  else if (h.llm.available) p.push(`<span class="pill ok"><i></i>Claude <b>${esc(h.llm.model)}</b></span>`);
  else p.push(`<span class="pill bad"><i></i>Claude <b>No API key</b></span>`);
  const w = h.whisper;
  p.push(`<span class="pill ${w.state === "ready" ? "ok" : w.state === "error" ? "bad" : "warn"}"><i></i>Whisper <b>${w.state === "ready" ? esc(w.model.split("/").pop()) : w.state === "error" ? "unavailable" : "loading, up to a minute"}</b></span>`);
  p.push(`<span class="pill ${h.ffmpeg ? "ok" : "bad"}"><i></i>FFmpeg <b>${h.ffmpeg ? "ready" : "missing"}</b></span>`);
  p.push(`<span class="pill ${h.recipes.mode === "draft" ? "warn" : "ok"}"><i></i>Recipes <b>${h.recipes.available} ${esc(h.recipes.mode)}</b></span>`);
  $("#pills").innerHTML = p.join("");
  $("#demo-banner").hidden = !h.llm.demo;
}
async function refreshHealth() {
  try { state.health = await api("/api/health"); state.offline = false; }
  catch (e) { if (e.code === "offline") state.offline = true; }
  renderPills();
}
async function pollHealth() {
  await refreshHealth();
  if (!state.health || state.health.whisper.state === "loading") setTimeout(pollHealth, 2500);
}

function renderPhases() {
  const r = state.route, run = state.run;
  let idx = 0;
  if (r) idx = 1;
  if (run) idx = 2;
  const st = run?.result?.status;
  if (st === "awaiting_approval" || st === "approved" || st === "rejected") idx = 3;
  $("#phases").innerHTML = PHASES.map((n, i) => `<div class="phase ${i < idx || st === "approved" ? "done" : i === idx ? "on" : ""}"><span class="n">${i < idx || st === "approved" ? "&#10003;" : i + 1}</span>${n}</div>`).join("");
}

// ---------- assets ----------
const LANG_NAMES = (() => { try { const n = new Intl.DisplayNames(["en"], { type: "language" }); return (c) => n.of(c) ?? c; } catch { return (c) => c; } })();

/** What was measured from the file itself, shown as chips so the user can see what the Director will know. */
function analysisChips(a, asset) {
  if (!a) return "";
  if (a.status === "running") return `<span class="chip warn"><span class="spinner" style="margin:0 6px 0 0;width:12px;height:12px"></span>analysing</span>`;
  const c = [];
  if (a.status === "failed") c.push(`<span class="chip bad">not measured</span>`);
  if (a.shots > 1) c.push(`<span class="chip">${a.shots} shots</span>`);
  if (a.speech) c.push(`<span class="chip lang">${esc(LANG_NAMES(a.speech.language))} · ${a.speech.word_count} words</span>`);
  else if (asset.audio_tracks > 0 && a.note) c.push(`<span class="chip">${esc(a.note.replace(/\.$/, "").toLowerCase())}</span>`);
  if (a.silences) c.push(`<span class="chip warn">${a.silences} silent gap${a.silences > 1 ? "s" : ""}</span>`);
  if (a.black) c.push(`<span class="chip bad">${a.black} black stretch${a.black > 1 ? "es" : ""}</span>`);
  if (a.frozen) c.push(`<span class="chip warn">${a.frozen} still stretch${a.frozen > 1 ? "es" : ""}</span>`);
  if (a.loudness_lufs != null) c.push(`<span class="chip">${Math.round(a.loudness_lufs * 10) / 10} LUFS</span>`);
  if (asset.duration && a.usable_s != null && a.usable_s < asset.duration - 0.5) c.push(`<span class="chip warn">usable ${fmtDur(a.usable_s)} of ${fmtDur(asset.duration)}</span>`);
  return c.join("");
}

function renderAssets() {
  $("#assets").innerHTML = state.assets.map((a) => {
    const src = `/api/sessions/${state.sid}/files/${a.asset_id}`;
    const thumb = a.media_type === "image" ? `<img alt="" src="${src}">` : a.media_type === "video" ? `<video muted preload="metadata" src="${src}#t=0.4"></video>` : ICON.audio;
    const res = a.width && a.height ? `${a.width}x${a.height}` : "";
    const an = state.analysis[a.asset_id];
    return `<div class="asset">
      <div class="thumb">${thumb}</div>
      <div><div class="name" title="${esc(a.metadata.original_name)}">${esc(a.metadata.original_name)}</div>
        <div class="meta"><span class="chip">${a.media_type}</span>${a.duration ? `<span class="chip">${fmtDur(a.duration)}</span>` : ""}${res ? `<span class="chip">${res}</span>` : ""}${a.media_type === "video" ? `<span class="chip ${a.audio_tracks ? "ok" : "warn"}">${a.audio_tracks ? "audio" : "no audio"}</span>` : ""}</div>
        <div class="meta">${analysisChips(an, a)}</div>
        ${an?.speech ? `<button class="tx" data-action="view-transcript" data-id="${a.asset_id}">${state.transcripts[a.asset_id] ? "Hide transcript" : "View transcript"}</button>` : ""}</div>
      <button class="x" data-action="remove-asset" data-id="${a.asset_id}" aria-label="Remove ${esc(a.metadata.original_name)}">&times;</button>
    </div>`;
  }).join("");
}

/** Files are measured in the background after upload. Poll until nothing is still running. */
let analysisTimer = 0;
async function refreshAnalysis() {
  clearTimeout(analysisTimer);
  try {
    const s = await api(`/api/sessions/${state.sid}`);
    state.analysis = Object.fromEntries(s.analysis.map((a) => [a.asset_id, a]));
    renderAssets();
    const g = await refreshGallery();
    if (s.analysis.some((a) => a.status === "running") || g.some((i) => i.status === "running")) analysisTimer = setTimeout(refreshAnalysis, 1500);
  } catch { /* session may be gone */ }
}

// ---------- the asset gallery ----------
const CATEGORIES = [["brand_logo", "Brand logo"], ["company_logo", "Company logo"], ["product_photo", "Product photograph"], ["person_or_team_photo", "Person or team photograph"], ["website_screenshot", "Website screenshot"], ["app_screenshot", "Application screenshot"], ["dashboard_ui", "Dashboard or software UI"], ["icon_symbol", "Icon or symbol"], ["illustration", "Illustration"], ["background_texture", "Background or texture"], ["marketing_graphic", "Marketing graphic"], ["document_infographic", "Document or infographic"], ["other_unknown", "Other / unknown"]];
const USAGES = [["auto", "Director decides"], ["must_use", "Must appear"], ["optional", "Optional"], ["reference_only", "Reference only, do not show"], ["do_not_use", "Do not use"]];
const CONTEXT = [
  { label: "Our official logo", body: { category: "company_logo", description: "This is our official company logo.", usage: "must_use" } },
  { label: "The product we advertise", body: { category: "product_photo", description: "This is the product we are advertising." } },
  { label: "Reference only", body: { description: "This is a reference design. Do not use it directly.", usage: "reference_only" } },
  { label: "The real dashboard", body: { category: "dashboard_ui", description: "This is the actual dashboard that must appear.", usage: "must_use", genuine_product_ui: true } },
];
const STATUS_TEXT = { pending: "Waiting", running: "Analysing", analyzed: "Analysed", partial: "Partly analysed", failed: "Analysis failed", unsupported: "Not usable" };

const pictureName = (id) => (state.gallery ?? []).find((i) => i.asset_id === id)?.original_filename ?? id;

async function refreshGallery() {
  if (!state.sid) return [];
  const r = await api(`/api/sessions/${state.sid}/gallery`);
  state.gallery = r.items;
  renderGallery();
  return r.items;
}
function galleryCard(i) {
  const top = i.categories[0];
  const type = top ? `${top.label}${top.source === "user" ? " (your correction)" : ` (${Math.round(top.confidence * 100)}%)`}` : "Not known";
  const others = i.categories.slice(1).filter((c) => c.category !== "other_unknown").map((c) => c.label).join(", ");
  const desc = i.description ?? (i.status === "running" ? "Looking at this picture..." : "No description. The analysis did not produce one, so please describe this picture.");
  const uncertain = i.status !== "running" && (!top || top.category === "other_unknown" || (top.source !== "user" && top.confidence < 0.35));
  return `<article class="g-card" data-id="${i.asset_id}">
    <div class="g-thumb">${i.thumbnail_url ? `<img src="${i.thumbnail_url}" alt="${esc(i.description ?? i.original_filename)}" loading="lazy">` : `<span>No preview</span>`}</div>
    <div class="g-body">
      <div class="g-name" title="${esc(i.original_filename)}">${esc(i.original_filename)}</div>
      <dl>
        <dt>Detected type</dt><dd>${esc(type)}${others ? `<small> also: ${esc(others)}</small>` : ""}</dd>
        <dt>Description</dt><dd>${esc(desc)}</dd>
        ${i.visible_text.length ? `<dt>Visible text</dt><dd>${esc(i.visible_text.slice(0, 5).join(" / "))}</dd>` : ""}
        <dt>Dimensions</dt><dd>${i.width ?? "?"} &times; ${i.height ?? "?"}</dd>
        <dt>Transparency</dt><dd>${i.transparent === null ? "Not known" : i.transparent ? "Yes" : "No"}</dd>
        <dt>Status</dt><dd><span class="chip ${i.status === "analyzed" ? "ok" : i.status === "running" || i.status === "partial" ? "warn" : "bad"}">${STATUS_TEXT[i.status] ?? esc(i.status)}</span>${i.availability !== "available" ? ` <span class="chip bad">${esc(i.availability.replaceAll("_", " "))}</span>` : ""}</dd>
        <dt>Project</dt><dd><code>${esc(i.session_id)}</code>${i.used_in_projects > 1 ? ` <small>analysis shared with ${i.used_in_projects - 1} other project(s)</small>` : ""}</dd>
        <dt>Storyboard usage</dt><dd>${i.storyboard_usage.length ? esc(i.storyboard_usage.join(", ")) : "Not used yet"}</dd>
      </dl>
      ${i.error ? `<p class="g-error">${esc(i.error)}</p>` : ""}
      ${uncertain ? `<p class="g-ask">I am not sure what this is. Please tell me below.</p>` : ""}
      <details class="g-fix"><summary>Correct or add context</summary>
        <div class="g-chips">${CONTEXT.map((c, n) => `<button class="ghost" data-action="asset-context" data-id="${i.asset_id}" data-n="${n}">${esc(c.label)}</button>`).join("")}</div>
        <label>Type<select data-field="category"><option value="">Keep detected type</option>${CATEGORIES.map(([v, l]) => `<option value="${v}" ${i.user?.category === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
        <label>How to use it<select data-field="usage">${USAGES.map(([v, l]) => `<option value="${v}" ${(i.user?.usage ?? "auto") === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
        <label>In your words<textarea data-field="description" rows="2" maxlength="500" placeholder="What is this picture?">${esc(i.user?.description ?? "")}</textarea></label>
        <div class="row"><button class="primary sm" data-action="asset-save" data-id="${i.asset_id}">Save</button>${i.retryable || i.status === "failed" ? `<button class="ghost" data-action="asset-retry" data-id="${i.asset_id}">Analyse again</button>` : ""}</div>
      </details>
    </div>
  </article>`;
}
function renderGallery() {
  const items = state.gallery ?? [];
  const el = $("#gallery");
  if (!el) return;
  el.innerHTML = items.length ? `<h3>What I see in your images</h3><div class="g-grid">${items.map(galleryCard).join("")}</div>` : "";
}
async function saveAsset(id, body) {
  await api(`/api/sessions/${state.sid}/assets/${id}/correction`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  state.route = null;
  await refreshGallery();
  toast("Saved. The Director will use this on the next plan.", "ok");
}
async function uploadFiles(files) {
  if (!files.length) return;
  const drop = $("#drop");
  const limitMb = state.health?.limits.maxRequestMb ?? 400;
  drop.classList.add("busy");
  let added = 0;
  // One request per file: a large batch cannot hit the size limit together, and one bad file cannot sink the others.
  for (const [i, f] of files.entries()) {
    $("#drop-hint").innerHTML = `<span class="spinner"></span>Checking ${esc(f.name)} (${i + 1} of ${files.length})...`;
    if (f.size > limitMb * 1048576) {
      // Sending it would make the browser show "Failed to fetch": the server refuses before the upload finishes.
      toast(`${f.name} is ${Math.round(f.size / 1048576)} MB. This console takes up to ${limitMb} MB per file. Compress it first (for example 1080p H.264) or upload a shorter clip.`);
      continue;
    }
    const fd = new FormData();
    fd.append("files", f, f.name);
    try {
      const res = await api(`/api/sessions/${state.sid}/assets`, { method: "POST", body: fd });
      state.assets = res.assets; state.route = null; state.run = null; added += res.added.length;
      for (const r of res.rejected) toast(`${r.name}: ${r.issues.map((x) => x.message).join(" ")}`);
      renderAssets(); refreshAnalysis();
    } catch (e) { fail(e); if (e.code === "offline") break; }
  }
  if (added) toast(`${added} file${added > 1 ? "s" : ""} added`, "ok");
  drop.classList.remove("busy"); $("#drop-hint").textContent = "or click to browse";
  renderAll();
}
// ---------- voice ----------
const wave = { raf: 0, ctx: null, analyser: null };
function drawWave(active) {
  const c = $("#wave"), g = c.getContext("2d"), w = c.width, h = c.height;
  g.clearRect(0, 0, w, h);
  const bars = 56, bw = w / bars;
  const data = new Uint8Array(wave.analyser ? wave.analyser.frequencyBinCount : 0);
  if (active && wave.analyser) wave.analyser.getByteFrequencyData(data);
  const grad = g.createLinearGradient(0, 0, w, 0); grad.addColorStop(0, "#7c5cff"); grad.addColorStop(1, "#22d3ee");
  g.fillStyle = active ? grad : "rgba(255,255,255,.12)";
  for (let i = 0; i < bars; i++) {
    const v = active && data.length ? data[Math.floor((i / bars) * data.length * 0.6)] / 255 : 0.06;
    const bh = Math.max(3, v * h * 0.95);
    g.beginPath(); g.roundRect(i * bw + 1.5, (h - bh) / 2, bw - 3, bh, 2); g.fill();
  }
  if (active) wave.raf = requestAnimationFrame(() => drawWave(true));
}
const micStatus = (t, err = false) => { const el = $("#mic-status"); el.textContent = t; el.className = `mic-status${err ? " err" : ""}`; };

/** Says what actually went wrong, so the user knows whether to plug something in, change a setting or close another app. */
function micErrorMessage(e) {
  const upload = " You can also upload a recording below.";
  switch (e?.name) {
    case "NotAllowedError": case "PermissionDeniedError":
      return "Microphone access is blocked. Allow it for this site in the browser (the icon next to the address), and check Windows Settings > Privacy > Microphone." + upload;
    case "NotFoundError": case "DevicesNotFoundError":
      return "No microphone is connected. Plug one in or connect your headset, then try again." + upload;
    case "NotReadableError": case "TrackStartError": case "AbortError":
      return "The microphone could not start. Another app may be using it, or it is switched off. Close other apps that use the microphone and try again." + upload;
    case "SecurityError":
      return "The browser blocked the microphone on this page. Open the console at http://localhost:4173." + upload;
    default:
      return `The microphone could not be used (${e?.name || "unknown error"}).` + upload;
  }
}

async function toggleMic() {
  if (state.mic) return stopMic();
  if (!navigator.mediaDevices?.getUserMedia) return micStatus("Recording needs a secure page. Open this console at http://localhost:4173." + " You can also upload a recording below.", true);
  // Without any input device there is nothing to ask permission for, so say so straight away.
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some((d) => d.kind === "audioinput")) return micStatus(micErrorMessage({ name: "NotFoundError" }), true);
  } catch { /* some browsers hide the list before permission is granted; carry on and let getUserMedia decide */ }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (first) {
    // A device that cannot do echo cancellation or noise suppression rejects those options. Retry plainly before giving up.
    if (first?.name !== "OverconstrainedError") return micStatus(micErrorMessage(first), true);
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (second) { return micStatus(micErrorMessage(second), true); }
  }
  const ctx = new AudioContext(); const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser(); analyser.fftSize = 256; src.connect(analyser);
  Object.assign(wave, { ctx, analyser });
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = []; const started = Date.now();
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); ctx.close(); cancelAnimationFrame(wave.raf); drawWave(false); transcribeBlob(new Blob(chunks, { type: rec.mimeType }), "voice.webm"); };
  const max = state.health?.limits.maxVoicePromptSeconds ?? 180;
  const tick = setInterval(() => {
    const s = (Date.now() - started) / 1000;
    micStatus(`Listening... ${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}. Tap to stop.`);
    if (s >= max) stopMic();
  }, 250);
  state.mic = { rec, tick };
  rec.start(250);
  $("#mic").classList.add("rec"); $("#mic").setAttribute("aria-pressed", "true");
  drawWave(true);
}
function stopMic() {
  const m = state.mic; if (!m) return;
  clearInterval(m.tick); state.mic = null;
  $("#mic").classList.remove("rec"); $("#mic").setAttribute("aria-pressed", "false");
  m.rec.stop();
}

/** Turns a recording, or an uploaded audio file, into text in the request box. Shared by the microphone and the upload button. */
async function transcribeBlob(blob, filename) {
  if (blob.size < 1500) return micStatus("That was too short or empty. Record again, or choose a longer file.", true);
  const mic = $("#mic"); mic.classList.add("busy");
  micStatus(state.health?.whisper.state === "ready" ? "Transcribing on this computer..." : "Warming up speech recognition, then transcribing...");
  const fd = new FormData(); fd.append("audio", blob, filename);
  try {
    const t = await api(`/api/sessions/${state.sid}/transcribe`, { method: "POST", body: fd });
    const box = $("#prompt");
    box.value = box.value.trim() ? `${box.value.trim()} ${t.text}` : t.text;
    state.fromVoice = true; state.language = t.language;
    const chip = $("#lang-chip");
    chip.hidden = false; chip.className = `chip ${t.warnings.includes("low_language_confidence") ? "warn" : "lang"}`;
    chip.textContent = `${t.language_name}${t.language_confidence < 0.6 ? " (unsure)" : ""} · from voice`;
    micStatus(`Heard ${t.words.length} words in ${t.language_name}. Edit the text if needed, then send.`);
    updateCount(); box.focus();
  } catch (e) { micStatus(e.message, true); }
  mic.classList.remove("busy");
}
// ---------- routing ----------
const updateCount = () => { $("#count").textContent = `${$("#prompt").value.length} / 4000`; };

async function sendText(text) {
  if (!text.trim()) return toast("Write or say what you want first.");
  if (state.busy) return;
  state.busy = true; setSendBusy(true);
  try {
    const res = await post(`/api/sessions/${state.sid}/route`, { text: text.trim(), from_voice: state.fromVoice, language: state.language });
    state.turns = res.turns; state.route = res.result; state.run = null; state.approval = null;
    state.fromVoice = false; state.language = null;
    $("#prompt").value = ""; $("#lang-chip").hidden = true; updateCount();
  } catch (e) { fail(e); }
  state.busy = false; setSendBusy(false); renderAll();
  revealStage(state.route?.status === "needs_input");
}
/** Moves the answer into view, because on small screens it lands below the input. Focuses the reply box when a question is waiting. */
function revealStage(focusReply) {
  setTimeout(() => {
    const stage = $("#stage"), top = stage.getBoundingClientRect().top;
    if (top > window.innerHeight * 0.55 || top < 0) {
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      stage.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
      // Smooth scrolling can be disabled or stall (power saving, embedded views). If we have not moved, jump.
      const y0 = window.scrollY;
      setTimeout(() => { if (Math.abs(window.scrollY - y0) < 2) stage.scrollIntoView({ behavior: "auto", block: "start" }); }, 700);
    }
    if (focusReply) $("#reply")?.focus({ preventScroll: true });
  }, 60);
}
function setSendBusy(b) {
  const s = $("#send"); s.disabled = b;
  s.firstElementChild.innerHTML = b ? '<span class="spinner"></span>Thinking...' : "Send to Director";
}

// ---------- director run ----------
/** The chosen kind of video, or null when the select is left unset. */
function videoCategory() { const v = $("#video-category")?.value; return v === "saas" || v === "ecommerce" || v === "general-promo" ? v : null; }
function factsLines() { return $("#facts").value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 20); }

async function refreshVideoTypes() {
  if (!state.sid) return;
  const card = $("#video-type-card");
  const options = $("#video-type-options");
  if (!card || !options) return;
  try {
    const data = await api(`/api/sessions/${state.sid}/video-types`);
    state.proposedVideoTypes = data.proposals ?? [];
    if (data.chosen) state.videoType = data.chosen;
    else if (!state.videoType && state.proposedVideoTypes.length) {
      state.videoType = state.proposedVideoTypes.find((p) => p.recommended)?.id ?? state.proposedVideoTypes[0]?.id ?? null;
    }
    if (!state.proposedVideoTypes.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    options.innerHTML = state.proposedVideoTypes.map((p) => `
      <div class="video-type-option ${p.id === state.videoType ? "active" : ""}" data-type-id="${esc(p.id)}">
        <div class="head"><b>${esc(p.title)}</b>${p.recommended ? '<span class="chip ok">recommended</span>' : ""}</div>
        <div class="desc">${esc(p.description)}</div>
        <div class="ex">Example: "${esc(p.example)}"</div>
      </div>
    `).join("");
    options.querySelectorAll(".video-type-option").forEach((el) => {
      el.addEventListener("click", async () => {
        const typeId = el.dataset.typeId;
        state.videoType = typeId;
        options.querySelectorAll(".video-type-option").forEach((opt) => opt.classList.toggle("active", opt.dataset.typeId === typeId));
        try {
          await post(`/api/sessions/${state.sid}/video-type`, { video_type: typeId });
        } catch (e) {
          toast(e.message, "warn");
        }
      });
    });
  } catch {
    card.hidden = true;
  }
}

async function buildPlan() {
  if (state.busy) return;
  state.busy = true;
  state.run = { steps: Object.fromEntries(STEPS.map(([k]) => [k, { status: "pending", lines: [] }])), result: null, error: null };
  state.run.steps.intake.status = "run";
  state.gateNotes = "";
  state.tab = "treatment"; renderAll();
  const order = STEPS.map(([k]) => k);
  try {
    let res;
    try { res = await fetch(`/api/sessions/${state.sid}/direct`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facts: factsLines(), video_category: videoCategory(), video_type: state.videoType }) }); } catch { throw offlineError(); }
    if (!res.ok) { const b = await res.json().catch(() => ({})); const er = new Error(b.message || `Request failed (${res.status})`); er.code = b.error; throw er; }
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!ev || !data) continue;
        onRunEvent(ev, JSON.parse(data), order);
      }
    }
  } catch (e) {
    const offline = e.code === "offline" || e instanceof TypeError; // a dropped stream surfaces as a TypeError
    state.run.error = offline ? OFFLINE : e.message;
    if (String(e.code ?? "").startsWith("llm_") || e instanceof TypeError) refreshHealth();
  }
  state.busy = false; renderAll();
}
function onRunEvent(ev, d, order) {
  const steps = state.run.steps;
  if (ev === "step") {
    if (steps[d.node]) { steps[d.node].status = "done"; steps[d.node].lines = d.trace; }
    const next = order[order.indexOf(d.node) + 1];
    if (next && !next.endsWith("_gate") && steps[next].status === "pending") steps[next].status = "run"; // gates are set from the result, not from the stream
  } else if (ev === "state") {
    state.run.result = d;
    for (const k of order) if (steps[k].status === "run" && d.status !== "awaiting_approval") steps[k].status = d.status === "escalated" ? "fail" : "done";
    if (d.status === "awaiting_approval") syncSteps(d);
  } else if (ev === "failure") { state.run.error = d.message; if (String(d.code ?? "").startsWith("llm_")) refreshHealth(); for (const k of order) if (steps[k].status === "run") steps[k].status = "fail"; }
  renderAll();
}
/** Marks the pipeline steps from the server's summary, so each gate shows as waiting, done or not reached yet. */
function syncSteps(d) {
  const st = state.run.steps;
  const sbApproved = d.approvals.some((a) => a.stage === "storyboard" && a.decision === "approved" && a.plan_version === d.versions.storyboard);
  if (d.scenePlan) st.storyboard.status = "done";
  st.storyboard_gate.status = d.gate === "storyboard" ? "run" : sbApproved ? "done" : "pending";
  st.edit_plan.status = d.editPlan ? "done" : sbApproved ? "run" : "pending";
  st.edit_plan_gate.status = d.gate === "edit_plan" ? "run" : d.status === "approved" ? "done" : "pending";
}

/** Sends one decision for the gate on screen, naming its stage and version so a decision on an out-of-date screen is refused. */
async function decide(decision) {
  const cur = state.run?.result;
  if (state.busy || !cur?.gate) return;
  const notes = state.gateNotes.trim();
  if (decision === "revision_requested" && !notes) { toast("Say what should change, then request changes.", ""); $("#gate-notes")?.focus(); return; }
  state.busy = true; renderAll();
  try {
    const res = await post(`/api/sessions/${state.sid}/approve`, {
      stage: cur.gate, plan_version: cur.versions[cur.gate], storyboard_version: cur.versions.storyboard, decision, notes,
    });
    const d = res.state;
    state.run.result = d; state.approval = res.record; state.gateNotes = "";
    if (d.status === "escalated") for (const k of Object.keys(state.run.steps)) { if (state.run.steps[k].status === "run") state.run.steps[k].status = "fail"; }
    else syncSteps(d);
    state.tab = d.status === "approved" ? "audit" : d.gate === "edit_plan" ? "edits" : "scenes";
    if (d.status === "escalated") toast("The change limit was reached, so this needs your decision.", "");
    else if (d.status === "approved") toast("Both approvals are recorded. Preparing the preview in your chosen format.", "ok");
    else if (decision === "approved") toast("Storyboard approved. The edit plan is ready for review.", "ok");
    else toast(`Changes applied. Version ${d.versions[d.gate]} is ready for review.`, "ok");
  } catch (e) { fail(e); }
  state.busy = false; renderAll();
  if (state.run?.result?.status === "approved" && decision === "approved") autoPreview();
}
/** Right after the second approval: run the Editor, size the film to the approved format and render the preview. Only ever runs once both approvals are recorded; a problem is shown in the panel, never hidden. */
async function autoPreview() {
  const r = rstate();
  if (r.busy || r.result) return;
  await renderStep("editor");
  if (r.error || !r.view || !(r.view.can_render ?? r.view.eligible)) return;
  await renderStep("render");
}

// ---------- stage rendering ----------
const modeCards = (active, confidence) => `<div class="modes">${Object.entries(MODES).map(([k, m]) => `
  <div class="mode ${active === k ? "on" : ""}"><span class="tag">${m.tag}</span><div class="ic">${m.icon}</div><h3>${m.title}</h3><p>${m.text}</p></div>`).join("")}</div>
  ${confidence != null ? `<div class="conf">Confidence<div class="meter"><div style="width:${Math.round(confidence * 100)}%"></div></div>${Math.round(confidence * 100)}%</div>` : ""}`;

function emptyStage() {
  return `<div class="empty"><div class="orb"></div><h2>Tell me what you need</h2>
    <p>Type or speak in any language, and add any videos, audio or images you have. I will work out whether to create something new or edit what you uploaded, ask only what I need, then plan it.</p></div>
    ${modeCards(null, null).replace('class="mode ', 'class="mode static ')}`;
}
function convo() {
  // While a question is open it is shown in its own card, so do not repeat it as a bubble.
  const turns = state.route?.status === "needs_input" && state.turns.at(-1)?.role === "assistant" ? state.turns.slice(0, -1) : state.turns;
  if (!turns.length) return "";
  return `<div class="bubbles">${turns.map((t) => `<div class="bubble ${t.role}">${t.from_voice ? '<span class="src">spoken</span>' : ""}${esc(t.text)}</div>`).join("")}</div>`;
}
function transcriptCard() {
  const entries = Object.entries(state.transcripts);
  return entries.map(([id, t]) => {
    const a = state.assets.find((x) => x.asset_id === id);
    return `<div class="card"><h3>Transcript · ${esc(a?.metadata.original_name ?? id)}</h3>
      <div class="row" style="margin-bottom:10px"><span class="chip lang">${esc(t.language_name)}</span><span class="chip">${t.words.length} words</span><span class="chip">${fmtDur(t.duration_s)}</span>${t.warnings.map((w) => `<span class="chip warn">${esc(w.replaceAll("_", " "))}</span>`).join("")}</div>
      <div class="transcript">${t.words.map((w) => `<span class="w" title="${w.start.toFixed(2)}s to ${w.end.toFixed(2)}s">${esc(w.text)}</span>`).join("") || esc(t.text)}</div></div>`;
  }).join("");
}

function routeSection() {
  const r = state.route; if (!r) return "";
  if (r.status === "needs_input") {
    // The question comes first so it is the first thing seen, even on a phone.
    return `<div class="card"><h3>I need a little more</h3>${r.questions.map((q) => `<p style="margin-bottom:8px">${esc(q)}</p>`).join("")}
        ${r.form_fallback ? `<div class="notice info" style="margin:10px 0">We have gone back and forth a few times. Try one message that gives the goal, the platform and the length.</div>` : ""}
        <div class="reply" style="margin-top:12px"><textarea id="reply" rows="2" aria-label="Your answer" placeholder="Your answer... (Ctrl Enter to send)"></textarea><button class="primary sm" data-action="reply">Reply</button></div></div>
      ${modeCards(r.mode_guess, null)}`;
  }
  const q = r.request;
  const rows = q.project
    ? [["Goal", q.project.objective], ["Audience", q.project.audience], ["Platform", q.project.platform], ["Format", q.project.aspect_ratio], ["Length", `${q.project.target_duration}s`], ["Language", q.language ?? "same as the request"]]
    : [["What to change", `<ul style="margin:0;padding-left:18px">${q.edit.instructions.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`], ["Format", q.edit.aspect_ratio ?? "keep the original"], ["Length", q.edit.target_duration_s ? `${q.edit.target_duration_s}s` : "natural length"], ["Source videos", String(q.edit.source_asset_ids.length)], ["Language", q.language ?? "same as the request"]];
  return `${modeCards(q.mode, r.confidence)}
    <div class="card"><h3>What I understood</h3><p style="color:var(--muted);margin-bottom:12px">${esc(r.rationale)}</p>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${q.project || k !== "What to change" ? esc(v) : v}</dd>`).join("")}</dl></div>
    ${q.assumptions.length ? `<div class="card"><h3>Assumptions I made (change them by replying)</h3><div class="chips">${q.assumptions.map((a) => `<span class="chip">${esc(a)}</span>`).join("")}</div></div>` : ""}`;
}

function planSection() {
  const r = state.route;
  if (r?.status !== "ready") return "";
  if (r.request.mode === "edit_existing") {
    return `<div class="card"><h3>Next</h3><p style="color:var(--muted)">This is an edit request, so it goes to the editing agent. That agent is the next milestone, so nothing is executed yet. Your request, source video and instructions are validated and ready for it.</p></div>`;
  }
  if (!state.run) {
    return `<div class="card"><h3>Ready</h3><p style="color:var(--muted);margin-bottom:14px">The Director will write the treatment and storyboard it against your real files, then wait for your approval. After that it chooses a recipe for every edit and waits for your second approval.</p>
      <button class="primary sm" data-action="build" ${state.busy ? "disabled" : ""}>Build the plan</button></div>`;
  }
  const run = state.run, res = run.result;
  const pipe = `<div class="card"><h3>Director pipeline</h3><div class="pipe">${STEPS.map(([k, label]) => {
    const s = run.steps[k];
    return `<div class="step ${s.status}"><div class="dot">${s.status === "done" ? "&#10003;" : s.status === "fail" ? "!" : STEPS.findIndex(([x]) => x === k) + 1}</div><div><h4>${label}</h4>${s.lines.length ? `<div class="lines">${s.lines.map(esc).join("<br>")}</div>` : ""}</div></div>`;
  }).join("")}</div></div>`;
  const err = run.error ? `<div class="notice bad">${esc(run.error)}</div>` : "";
  if (!res) return pipe + err;
  if (res.status === "escalated") {
    const e = res.escalation;
    return pipe + `<div class="card"><h3>Needs a human decision</h3><div class="notice bad" style="margin-bottom:12px">${esc(e.what_failed)}</div>
      <dl class="kv"><dt>Evidence</dt><dd>${e.evidence.map((x) => `<div class="mono">${esc(x)}</div>`).join("")}</dd><dt>Tried</dt><dd>${e.what_was_tried.map(esc).join("; ")}</dd><dt>Options</dt><dd>${e.options_left.map(esc).join("; ")}</dd><dt>Decision</dt><dd>${esc(e.decision_needed)}</dd></dl></div>`;
  }
  if (res.status === "needs_clarification") return pipe + err + questionsCard(res.intake?.questions ?? []);
  return pipe + err + results(res);
}

/** Typed questions from the Director: a text box, a choice or an upload each, with Skip where it is allowed. Questions tied to no field (older free text) are shown as notes. */
const ACCEPT = { image: "image/*,.svg", pdf: "application/pdf,.pdf", video: "video/*", audio: "audio/*", any: "" };
function questionsCard(qs) {
  if (!qs.length) return `<div class="card"><h3>I need a little more</h3><p class="hint">Nothing specific was asked. Add detail to your request and send it again.</p></div>`;
  const control = (q) => q.kind === "choice"
    ? `<select id="qa-${esc(q.id)}" aria-label="${esc(q.prompt)}"><option value="">Choose...</option>${q.options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</select>`
    : q.kind === "upload"
      ? `<input id="qa-${esc(q.id)}" type="file" ${q.accept === "any" || q.accept === "image" ? "multiple" : ""} accept="${esc(ACCEPT[q.accept] ?? "")}" aria-label="${esc(q.prompt)}">`
      : `<input id="qa-${esc(q.id)}" type="text" placeholder="${esc(q.placeholder)}" aria-label="${esc(q.prompt)}">`;
  return `<div class="card" id="qcard"><h3>I need a little more</h3>
    <p class="hint" style="margin-bottom:10px">Answer what you can${qs.some((q) => q.skippable) ? "; where it says you can skip, skipping is fine" : ""}.</p>
    ${qs.map((q) => q.field ? `<div class="q" data-qid="${esc(q.id)}" data-kind="${esc(q.kind)}" data-accept="${esc(q.accept ?? "")}" style="margin-bottom:14px"><label class="field-label" for="qa-${esc(q.id)}">${esc(q.prompt)}${q.level === "required" ? " <span class=\"hint\">required</span>" : ""}</label>${q.help ? `<p class="hint" style="margin-bottom:6px">${esc(q.help)}</p>` : ""}${control(q)}${q.skippable ? `<label class="hint" style="display:block;margin-top:6px"><input type="checkbox" class="q-skip"> Skip this</label>` : ""}</div>` : `<div class="notice warn" style="margin-bottom:10px">${esc(q.prompt)} <span class="hint">Add this to your request above and send it again.</span></div>`).join("")}
    <p class="wz-error" id="q-error" role="alert"></p>
    ${qs.some((q) => q.field) ? `<button class="primary sm" data-action="answer-questions" ${state.busy ? "disabled" : ""}>Send answers and continue</button>` : ""}</div>`;
}
async function answerQuestions() {
  const err = (m) => { const e = $("#q-error"); if (e) e.textContent = m; };
  const answers = [];
  for (const b of document.querySelectorAll("#qcard .q")) {
    const id = b.dataset.qid, kind = b.dataset.kind, input = b.querySelector("input:not(.q-skip), select");
    if (b.querySelector(".q-skip")?.checked) { answers.push({ question_id: id, action: "skip" }); continue; }
    if (kind === "upload") {
      const files = [...(input.files ?? [])]; if (!files.length) continue;
      if (b.dataset.accept === "pdf") {
        const problem = fileProblem(files[0], "guideline"); if (problem) return err(problem);
        const fd = new FormData(); fd.append("file", files[0], files[0].name);
        try { await api(`/api/sessions/${state.sid}/guideline`, { method: "POST", body: fd }); } catch (e) { return err(e.message); }
        continue; // the guideline route records the file in the kit itself
      }
      if (b.dataset.accept === "image") { const problem = fileProblem(files[0], "logo"); if (problem) return err(problem); }
      const before = new Set(state.assets.map((a) => a.asset_id));
      await uploadFiles(files);
      const ids = state.assets.filter((a) => !before.has(a.asset_id)).map((a) => a.asset_id);
      if (!ids.length) return err("That file was not accepted. Check it, or skip this question.");
      answers.push({ question_id: id, action: "answer", value: ids });
    } else {
      const v = input.value.trim(); if (v) answers.push({ question_id: id, action: "answer", value: v });
    }
  }
  if (!answers.length) return err("Answer at least one question, or tick Skip where it is allowed.");
  try { await post(`/api/sessions/${state.sid}/kit/answers`, { answers }); } catch (e) { return err(e.message); }
  await state.wiz?.reload?.();
  buildPlan();
}

function results(res) {
  const t = res.treatment, sp = res.scenePlan, ep = res.editPlan;
  // The edit plan does not exist until the storyboard is approved, so its tab appears only then.
  const tabs = [["treatment", "Treatment"], ["scenes", "Scenes"], ...(ep ? [["edits", "Edit plan"]] : []), ["claims", "Claims"], ["audit", "Audit"]];
  const tab = tabs.some(([k]) => k === state.tab) ? state.tab : "treatment";
  const body = {
    treatment: () => `<dl class="kv"><dt>Logline</dt><dd>${esc(t.logline)}</dd><dt>Hook</dt><dd>${esc(t.hook)}</dd><dt>Tone</dt><dd>${esc(t.tone)}</dd><dt>Call to action</dt><dd>${esc(t.cta)}</dd></dl>
      <h3 style="margin:16px 0 8px">Beats</h3>${t.beats.map((b) => `<div class="scene"><div class="head"><b>${esc(b.beat)}</b><span class="chip">${fmtDur(b.approx_seconds)}</span></div><div class="sub">${esc(b.purpose)}</div></div>`).join("")}
      ${t.conflicts_log.length ? `<h3 style="margin:16px 0 8px">Conflicts resolved</h3>${t.conflicts_log.map((c) => `<div class="notice info" style="margin-bottom:8px"><b>${esc(c.conflict)}</b><br>${esc(c.decision)}</div>`).join("")}` : ""}`,
    scenes: () => {
      const total = sp.scenes.reduce((a, s) => a + s.duration_seconds, 0);
      return `<div class="timeline">${sp.scenes.map((s, i) => `<div class="tl" style="flex:${s.duration_seconds};--h:${(i * 57 + 255) % 360}"><b>${s.scene_id}</b><span>${fmtDur(s.duration_seconds)}</span></div>`).join("")}</div>
        <p class="hint" style="margin:8px 0 6px">${sp.scenes.length} scenes, ${fmtDur(total)} total${res.timing ? (res.timing.matches_target ? `, matches the ${fmtDur(res.timing.target_s)} target` : `, does NOT match the ${fmtDur(res.timing.target_s)} target`) : ""}</p>
        ${requirementsSheetHtml(res.requirementsSheet)}
        ${feasibilityHtml(res.assetFeasibility)}
        ${sp.scenes.map((s) => `<div class="scene"><div class="head"><b>${s.scene_id} · ${esc(s.purpose)}</b><span class="mono hint">${fmtDur(s.start_time)} to ${fmtDur(s.start_time + s.duration_seconds)}</span></div>
          <div class="sub">${esc(s.shot.shot_size.replaceAll("_", " "))}, ${esc(s.shot.camera_motion.replaceAll("_", " "))}: ${esc(s.shot.visual_action)}</div>
          ${s.overlay ? `<div class="overlay-txt">${esc(s.overlay.text)}</div>` : ""}
          ${s.voiceover ? `<div class="sub">Voiceover: "${esc(s.voiceover)}"</div>` : ""}
          ${(s.required_assets ?? []).length ? `<div class="chips">${s.production_method ? `<span class="chip">${esc(s.production_method.replaceAll("_", " "))}</span>` : ""}${s.required_assets.map((r) => `<span class="chip ${{ supplied: "ok", generate_graphics: r.placeholder ? "warn" : "ok", needs_external: "bad", missing_blocking: "bad" }[r.availability]}" title="${esc(r.fallback ?? "")}">${esc(r.need)}: ${esc(r.placeholder ? "placeholder graphic" : r.availability.replaceAll("_", " "))}</span>`).join("")}</div>` : ""}
          ${(s.asset_refs ?? []).map((r) => `<div class="sub"><span class="chip ${r.mandatory ? "ok" : ""}">${r.mandatory ? "must appear" : "optional"}</span> ${esc(pictureName(r.asset_id))} as ${esc(r.role)}, ${esc(r.placement.replaceAll("_", " "))}, ${esc(r.animation.replaceAll("_", " "))}: ${esc(r.reason)}</div>`).join("")}
          ${(s.unresolved ?? []).map((u) => `<div class="notice info" style="margin:6px 0 0">${esc(u.kind.replace("_", " "))}: ${esc(u.note)}</div>`).join("")}
          <div class="chips">${s.asset_ids.length ? s.asset_ids.map((a) => `<span class="chip">${esc(assetName(a))}${s.source_in_seconds ? ` @${fmtDur(s.source_in_seconds)}` : ""}</span>`).join("") : '<span class="chip warn">graphics only</span>'}${s.claim_ids.map((c) => `<span class="chip ok">claim ${esc(c)}</span>`).join("")}<span class="chip">then ${esc(s.transition_out.replaceAll("_", " "))}</span></div></div>`).join("")}`;
    },
    edits: () => `<div class="notice info" style="margin-bottom:12px">Built on storyboard version ${res.versions.storyboard} <span class="mono">(${esc(String(res.hashes.storyboard).slice(0, 12))})</span>, which you approved. Edit plan version ${res.versions.edit_plan}.</div>` + sp.scenes.map((s) => {
      const uses = ep.uses.filter((u) => u.scene_id === s.scene_id);
      return `<div class="scene"><div class="head"><b>${s.scene_id} · ${esc(s.purpose)}</b><span class="mono hint">${fmtDur(s.duration_seconds)}</span></div>${uses.length ? uses.map((u) => `<div style="margin:8px 0"><span class="chip recipe">${esc(u.recipe_id)}</span> ${Object.keys(u.params).length ? `<span class="mono hint">${esc(JSON.stringify(u.params))}</span>` : '<span class="hint">default parameters</span>'}<div class="sub" style="margin:4px 0 0">${esc(u.rationale)}</div></div>`).join("") : '<div class="sub">No special treatment</div>'}${scenePreviewHtml(res, s)}</div>`;
    }).join(""),
    claims: () => `<table><thead><tr><th>Claim</th><th>Text</th><th>Status</th><th>Used in</th></tr></thead><tbody>${(res.claimsAudit ?? []).map((c) => {
      const chip = c.status === "supported" ? `<span class="chip ok">supported by ${esc(c.fact?.fact_id ?? "")}</span>` : c.status === "illustrative" ? '<span class="chip warn">illustrative concept, not a verified fact</span>' : '<span class="chip bad">unsupported factual claim, blocked</span>';
      return `<tr><td class="mono">${esc(c.claim_id)}</td><td>${esc(c.text)}<div class="hint">${esc(c.explanation)}${c.safe_alternative ? ` Safe alternative: ${esc(c.safe_alternative)}` : ""}</div></td><td>${chip}</td><td>${c.scene_ids.join(", ") || "-"}</td></tr>`;
    }).join("") || '<tr><td colspan="4" class="hint">No claims in this plan.</td></tr>'}</tbody></table>`,
    audit: () => `<h3 style="margin-bottom:8px">Skills applied</h3><div class="chips">${res.skillsUsed.map((s) => `<span class="chip">${esc(s)}</span>`).join("")}</div>
      <h3 style="margin:16px 0 8px">Skill reference files shown to the model</h3><div class="chips">${(res.referencesUsed ?? []).map((s) => `<span class="chip">${esc(s)}</span>`).join("") || '<span class="hint">none</span>'}</div>
      <h3 style="margin:16px 0 8px">Knowledge, facts and recipes shown to the model</h3><div class="chips">${res.citations.map((s) => `<span class="chip recipe">${esc(s)}</span>`).join("") || '<span class="hint">none</span>'}</div>
      <h3 style="margin:16px 0 8px">Approvals</h3>${approvalsHtml(res)}
      <h3 style="margin:16px 0 8px">Trace</h3><div class="mono" style="color:var(--muted)">${res.trace.map(esc).join("<br>")}</div>
      ${state.approval ? `<h3 style="margin:16px 0 8px">Run record</h3><pre class="mono" style="white-space:pre-wrap;color:var(--muted);margin:0">${esc(JSON.stringify(state.approval, null, 2))}</pre>` : ""}`,
  };
  const gate = res.status === "awaiting_approval" ? res.gate : null;
  const done = res.status === "approved";
  const what = gate === "edit_plan" ? "edit plan" : "storyboard";
  const used = gate ? res.revisions.used[gate] : 0, max = res.revisions.max;
  const earlier = gate ? res.approvals.filter((a) => a.stage === gate && a.decision === "revision_requested") : [];
  const header = gate ? `<div class="card gate-head"><div class="row"><b>${gate === "edit_plan" ? "Gate 2 of 2: edit plan" : "Gate 1 of 2: storyboard"}</b><span class="chip">version ${res.versions[gate]}</span><span class="chip mono">${esc(String(res.hashes[gate]).slice(0, 12))}</span><span class="chip ${used >= max ? "warn" : ""}">changes requested ${used} of ${max}</span></div>
      ${earlier.length ? `<div class="notice info" style="margin-top:10px"><b>Your earlier requests</b>${earlier.map((a) => `<div>Version ${a.plan_version}: ${esc(a.notes)}</div>`).join("")}</div>` : ""}</div>` : "";
  const bar = gate ? `<div class="approve-bar gate"><div><b>Approve this ${what}?</b><div class="hint">Version ${res.versions[gate]}. ${gate === "storyboard" ? "Approving lets the Director make the edit plan." : "Approving records your second approval."} Nothing is rendered. ${used >= max ? "This is the last change request: another one needs a human decision." : ""}</div>
        <details class="why"><summary>What does approving mean?</summary><ul>${gate === "storyboard"
          ? '<li>You are approving the <b>story</b>: what each scene says and shows, and the claims it makes. Claims without an approved fact are marked.</li><li>After this, the Director writes the edit plan (how it will be built). No video is made yet.</li><li>Not right? Write what to change and choose <b>Request changes</b>. Nothing moves on until you approve.</li>'
          : '<li>You are approving the <b>edit plan</b>: the animations, timing, transitions and sound that will be used. The story you approved stays exactly as it is.</li><li>Approving does not render anything. Making the video is a separate step you start afterwards, and it only runs when both approvals match the plans.</li><li>The scene previews above are <b>drafts</b> to help you decide. They are not the final film.</li>'}</ul></details></div>
      <textarea id="gate-notes" rows="2" aria-label="What should change?" placeholder="To request changes, say what should change in this ${what}">${esc(state.gateNotes)}</textarea>
      <div class="row"><button class="ghost" data-action="revise" ${state.busy ? "disabled" : ""}>Request changes</button><button class="primary sm" data-action="approve" ${state.busy ? "disabled" : ""}>Approve ${what}</button></div></div>` : "";
  const finished = done ? `<div class="notice info">Both approvals are recorded (storyboard version ${res.versions.storyboard}, edit plan version ${res.versions.edit_plan}). Nothing has been rendered. ${res.renderable.ok ? "The approval check passes for these exact versions." : `The approval check does not pass: ${esc(res.renderable.reasons.join("; "))}`}</div>${renderPanel()}` : "";
  return `${header}<div class="card"><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? "on" : ""}" role="tab" data-action="tab" data-tab="${k}">${l}</button>`).join("")}</div><div style="padding-top:16px">${body[tab]()}</div></div>
    ${bar}
    ${finished}`;
}

// ---------- scene previews ----------
// Before Gate 2 the preview is a DRAFT made by its own route (it is not the render and is never accepted as the final film); after both approvals it is a preview of the approved plan.
const ENGINE_NAME = { ffmpeg: "FFmpeg", remotion: "Remotion", hyperframes: "HyperFrames" };
function previewSettings(res) {
  const frame = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [900, 900] }[res.aspectRatio ?? "16:9"] ?? [1280, 720];
  return { aspect_ratio: res.aspectRatio ?? "16:9", width: frame[0], height: frame[1], fps: 30, duration_s: res.scenePlan.scenes.reduce((a, s) => a + s.duration_seconds, 0), container: "mp4", video_codec: "h264", audio_codec: null };
}
function previewOutcome(p, draft) {
  const lines = [];
  lines.push(draft
    ? "This is a <b>DRAFT</b> of this scene, drawn from the edit plan that is still waiting for your approval. It is not approved and it is not the final film: the video itself says DRAFT."
    : "This is a preview of this scene as approved. It is a single scene, not the final film.");
  lines.push(`Drawn by ${esc(ENGINE_NAME[p.engine] ?? p.engine)}.${p.cached ? " Nothing in this scene changed since the last preview, so the saved clip is shown." : ""}`);
  lines.push(p.sound ? "It has sound for this scene (any generated sound is labelled below)." : "This scene has no sound of its own in the plan.");
  return `<div class="notice ${draft ? "warn" : "info"}" style="margin:0">${lines.map((l) => `<div style="margin:2px 0">${l}</div>`).join("")}${(p.notes ?? []).map((n) => `<div class="hint" style="margin-top:4px">${esc(n)}</div>`).join("")}</div>`;
}
function scenePreviewHtml(res, s) {
  const gate2 = res.status === "awaiting_approval" && res.gate === "edit_plan", approved = res.status === "approved";
  if (!gate2 && !approved) return "";
  const p = state.previews[s.scene_id] ?? {}, draft = gate2;
  const button = `<button class="ghost sm" data-action="scene-preview" data-scene="${esc(s.scene_id)}" ${p.busy ? "disabled" : ""}>${p.busy ? "Drawing the scene..." : p.result ? "Preview again" : draft ? "Preview this scene (DRAFT)" : "Preview this scene"}</button>`;
  const shown = p.result ? `<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;margin-top:10px">
      <div style="flex:1 1 320px;max-width:640px"><div class="chip warn" style="margin-bottom:6px">${draft ? "DRAFT, not approved, not the final film" : "preview of the approved scene"}</div><video controls loop playsinline preload="metadata" src="${esc(p.result.video)}" style="width:100%;border-radius:12px;background:#000" aria-label="${draft ? "Draft preview" : "Preview"} of scene ${esc(s.scene_id)}"></video></div>
      <div style="flex:1 1 240px">${previewOutcome(p.result, draft)}</div></div>` : "";
  const err = p.error ? `<div class="notice bad" style="margin-top:8px">${esc(p.error)}</div>` : "";
  return `<div style="margin-top:10px">${button}${err}${shown}</div>`;
}
async function previewScene(sceneId) {
  const res = state.run?.result;
  if (!res || state.previews[sceneId]?.busy) return;
  const draft = res.status === "awaiting_approval" && res.gate === "edit_plan";
  state.previews[sceneId] = { busy: true }; renderAll();
  try {
    const r = await post(`/api/sessions/${state.sid}/scenes/${sceneId}/${draft ? "draft-preview" : "preview"}`, draft ? {} : { settings: previewSettings(res) });
    state.previews[sceneId] = { result: r };
  } catch (e) { state.previews[sceneId] = { error: e?.message ? `This scene could not be previewed: ${e.message}` : "This scene could not be previewed." }; }
  renderAll();
}
function requirementsSheetHtml(req) {
  if (!req) return "";
  const a = req.assets, f = req.fonts, s = req.sound;
  return `<div class="card" style="margin:10px 0;background:rgba(255,255,255,.04);border-left:3px solid var(--accent)">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <b>Gate 1 Story Requirements Sheet</b>
      <span class="chip ${req.ready_for_review ? 'ok' : 'warn'}">${req.ready_for_review ? 'ready for review' : 'needs attention'}</span>
    </div>
    <div class="sub" style="margin-bottom:8px">${esc(req.summary)}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px;font-size:12px;color:var(--muted)">
      <div><b>Assets:</b> ${a.supplied_count} supplied, ${a.graphics_count} graphics, ${a.needs_external_count} external</div>
      <div><b>Typography:</b> ${esc(f.face)} (${esc(f.weight)}, ${esc(f.scale)})</div>
      <div><b>Sound:</b> ${s.voiceover_scenes.length} VO scene(s), ${s.audio_cues.length} cue(s)</div>
    </div>
  </div>`;
}

/** What the scenes need: blockers stop production, warnings (placeholders, open decisions) need the user's eye. */
function feasibilityHtml(f) {
  if (!f || (!f.blockers.length && !f.warnings.length)) return "";
  return `${f.blockers.length ? `<div class="notice bad" style="margin-bottom:8px"><b>Blocks production</b>${f.blockers.map((b) => `<div>${esc(b)}</div>`).join("")}</div>` : ""}
    ${f.warnings.length ? `<div class="notice info" style="margin-bottom:8px"><b>Please review before approving</b>${f.warnings.map((w) => `<div>${esc(w)}</div>`).join("")}</div>` : ""}`;
}

function approvalsHtml(res) {
  const rows = res.approvals.map((a) => `<tr><td>${esc(a.stage === "edit_plan" ? "edit plan" : "storyboard")}</td><td>v${a.plan_version}</td><td>${a.decision === "approved" ? '<span class="chip ok">approved</span>' : '<span class="chip warn">changes requested</span>'}</td><td>${esc(a.notes) || "-"}</td><td class="mono">${esc(a.plan_hash.slice(0, 12))}</td></tr>`).join("");
  return `<table><thead><tr><th>Stage</th><th>Version</th><th>Decision</th><th>Notes</th><th>Plan hash</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="hint">No decisions yet.</td></tr>'}</tbody></table>
    <p class="hint" style="margin-top:8px">Approval check for a future render: ${res.renderable.ok ? "passes for these exact plan versions." : `not passed. ${res.renderable.reasons.map(esc).join("; ")}.`}</p>`;
}
const assetName = (id) => state.assets.find((a) => a.asset_id === id)?.metadata.original_name ?? id;

function renderStage() {
  const stage = $("#stage");
  const hasAnything = state.route || state.turns.length || Object.keys(state.transcripts).length;
  const keepReply = $("#reply")?.value;
  stage.innerHTML = hasAnything ? `${convo()}${transcriptCard()}${routeSection()}${planSection()}` : emptyStage();
  if (keepReply && $("#reply")) $("#reply").value = keepReply;
}
const PLACEHOLDER = $("#prompt").placeholder;
function renderAll() {
  renderPhases(); renderStage(); renderAssets();
  // While a question is open, the main box also works as the answer box.
  $("#prompt").placeholder = state.route?.status === "needs_input" ? "Answer the question here, or in the box beside it" : PLACEHOLDER;
}

// ---------- editor and preview render ----------
// The Editor and the renderer are opt-in steps after both approvals. Nothing here approves, advances a gate or renders by itself.
const rstate = () => (state.run.render ??= { editor: null, view: null, result: null, busy: false, error: null, settings: { width: "", height: "", fps: "" } });
async function rawPost(path, body) {
  let res;
  try { res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }); } catch { throw offlineError(); }
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const renderSettings = (r) => {
  const v = r.view, s = r.settings; if (!v) return undefined;
  const num = (x) => (String(x).trim() === "" ? undefined : Number(x)); // blank stays blank: nothing is filled in on the user's behalf
  return { aspect_ratio: v.needs.aspect_ratio, duration_s: v.needs.duration_s, ...v.needs.supported_output, width: num(s.width), height: num(s.height), fps: num(s.fps) };
};
/** Width and height in the plan's own format: the long side is `long` px. 16:9 -> 1280x720, 9:16 -> 720x1280, 1:1 -> 720x720. */
function sizeFor(aspect, long = 1280) {
  const m = /^(\d+):(\d+)$/.exec(String(aspect));
  const a = m ? Number(m[1]) : 16, b = m ? Number(m[2]) : 9;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return a >= b ? { width: even(a === b ? long * 0.5625 : long), height: even(((a === b ? long * 0.5625 : long) * b) / a) } : { width: even((long * a) / b), height: even(long) };
}
/** Sizes are never left to chance: when nothing was typed, the form is filled with a size in the approved format, visibly, and can be changed before rendering. */
function applyDefaultSize(r) {
  const s = r.settings;
  if (!r.view || s.width || s.height) return;
  const { width, height } = sizeFor(r.view.needs.aspect_ratio);
  Object.assign(s, { width: String(width), height: String(height), fps: s.fps || "30" });
}
const problem = (d) => `${d.message ?? "Request failed."}${d.reasons?.length ? ` ${d.reasons.join("; ")}` : ""}`;
async function refreshPlan(r) {
  const base = `/api/sessions/${state.sid}/render`;
  const typed = r.settings.width || r.settings.height || r.settings.fps;
  const { status, data } = typed ? await rawPost(`${base}/plan`, { settings: renderSettings(r) }) : { status: 200, data: await fetch(base).then((x) => x.json()).catch(() => ({ message: OFFLINE })) };
  if (data.plan) { r.view = data; r.error = null; } else r.error = problem(data);
  return status;
}
async function renderStep(kind) {
  const r = rstate(); r.busy = true; r.error = null; renderStage();
  try {
    if (kind === "editor") {
      const { status, data } = await rawPost(`/api/sessions/${state.sid}/editor`);
      if (status === 200) { r.editor = data; r.result = null; await refreshPlan(r); applyDefaultSize(r); if (r.settings.width) await refreshPlan(r); } else r.error = problem(data);
    } else if (kind === "plan") await refreshPlan(r);
    else if (kind === "render") {
      const { data } = await rawPost(`/api/sessions/${state.sid}/render`, { settings: renderSettings(r) });
      if (data.plan) r.view = data;
      if (data.delivery) { r.result = data; toast(data.kind === "complete" ? "Complete preview rendered and validated." : "Incomplete preview rendered. It is not the approved video.", data.kind === "complete" ? "ok" : "warn"); }
      else if (data.kind === "failed") { r.result = null; r.error = `The render failed. No video is offered. ${(data.errors ?? []).join("; ")}`; }
      else if (data.record) { r.result = data; if (data.record.state === "rendered") toast("Preview rendered and validated.", "ok"); else r.error = "The render failed. Nothing is offered for playback."; }
      else r.error = problem(data);
    }
  } catch (e) { fail(e); }
  r.busy = false; renderStage();
}
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function renderPanel() {
  const r = rstate(), v = r.view, b = r.busy ? "disabled" : "";
  const intro = `<div class="notice info" style="margin-bottom:12px">Both approvals are recorded. The next steps are optional and separate: the Editor turns the approved plans into concrete operations (no model is called), then a <b>preview</b> can be rendered if every approved scene can be shown. A preview is never production-ready.</div>`;
  const err = r.error ? `<div class="notice bad" style="margin:10px 0">${esc(r.error)}</div>` : "";
  if (!r.editor && !v) return `<div class="card"><h3>Editor and preview render</h3>${intro}${err}<button class="primary sm" data-action="editor-run" ${b}>${r.busy ? "Running..." : "Run the Editor"}</button></div>`;
  const editorHtml = v ? `<div class="row" style="margin-bottom:10px"><b>Editor</b><span class="chip ${v.editor.status === "ready" ? "ok" : "bad"}">${esc(v.editor.status.replaceAll("_", " "))}</span><span class="chip ${v.editor.validation.ok ? "ok" : "bad"}">${v.editor.validation.ok ? "contract valid" : "not valid"}</span><span class="chip">${v.editor.operations} operations</span><span class="chip warn">not rendered</span><button class="ghost" data-action="editor-run" ${b}>Run again</button></div>
    ${v.editor.conflicts.map((c) => `<div class="notice bad" style="margin-bottom:6px"><b>${esc(c.kind.replaceAll("_", " "))}</b> ${esc(c.description)}</div>`).join("")}
    ${v.editor.revision_requests.map((q) => `<div class="notice warn" style="margin-bottom:6px">Needs a new approval: ${esc(q.reason)}</div>`).join("")}` : "";
  const ops = v ? `<table><thead><tr><th>Operation</th><th>Scene</th><th>Recipe</th><th>Template</th><th>Renderer</th></tr></thead><tbody>${v.plan.operations.map((o) => `<tr><td class="mono">${esc(o.operation_id)}</td><td>${esc(o.scene_id)}</td><td>${esc(o.recipe_id)}</td><td class="mono">${esc(o.template)}</td><td>${o.supported ? `<span class="chip ok">${esc(o.renderer)}: supported</span>` : `<span class="chip bad" title="${esc(o.note ?? "")}">not supported${o.note ? ": audio, not built" : ""}</span>`}</td></tr>`).join("")}</tbody></table>
    <p class="hint" style="margin:6px 0 10px">${v.plan.supported} supported, ${v.plan.unsupported} not supported. Renderer for this plan: <b>${v.renderer.selected ? esc(v.renderer.selected) : "none selected"}</b>${v.renderer.composition_required ? " (the plan needs more than one renderer: each scene is rendered by its own renderer and FFmpeg assembles them; anything that cannot be rendered is listed and the preview is labelled incomplete)" : ""}. Available here: ${v.renderer.registered.length ? v.renderer.registered.map(esc).join(", ") : "none"}. The renderer comes from the recipes in your approved edit plan; nothing is swapped.</p>
    ${v.readiness ? `<h3 style="margin:12px 0 6px">Readiness, level by level</h3><p class="hint" style="margin-bottom:6px">Registered means a renderer has the template. Validated alone means a recorded real render of the template itself. Compatible means the engine accepts this scene's approved inputs. Rendered means it drew this scene and the clip passed its checks. In final means its effect was found in the finished video. A dash means not reached yet.</p><table><thead><tr><th>Operation</th><th>Scene</th><th>Template</th><th>Registered</th><th>Validated alone</th><th>Compatible</th><th>Rendered</th><th>In final</th><th>What is missing</th></tr></thead><tbody>${v.readiness.map((o) => { const lv = (b) => b === true ? '<span class="chip ok">yes</span>' : b === false ? '<span class="chip bad">no</span>' : '<span class="chip">-</span>'; return `<tr><td class="mono">${esc(o.operation_id)}</td><td>${esc(o.scene_id)}</td><td class="mono">${esc(o.template)}</td><td>${lv(o.registered)}</td><td>${lv(o.validated_in_isolation)}${o.validation_basis === "built_in" ? ' <span class="hint">built in</span>' : ""}</td><td>${lv(o.compatible_with_scene)}</td><td>${lv(o.rendered_with_scene_inputs)}</td><td>${lv(o.validated_in_final)}</td><td>${o.missing ? esc(o.missing) : "-"}</td></tr>`; }).join("")}</tbody></table>` : ""}    <div class="chips" style="margin-bottom:10px">${v.coverage.scenes.map((s) => `<span class="chip ${s.represented ? "ok" : "bad"}" title="${esc(s.missing.join("; "))}">${esc(s.scene_id)} ${s.represented ? "fully shown" : "not fully shown"}</span>`).join("")}</div>
    ${v.blockers.length ? `<div class="notice bad" style="margin-bottom:10px"><b>Why a preview cannot be made yet</b>${v.blockers.map((x) => `<div>${esc(x)}</div>`).join("")}</div>` : ""}
    <div class="notice ${v.production.ready ? "info" : "warn"}" style="margin-bottom:12px"><b>Production readiness: ${v.production.ready ? "ready" : "not ready"}.</b> ${v.production.blockers.slice(0, 4).map(esc).join("; ")}${v.production.blockers.length > 4 ? "; ..." : ""}${v.production.operations?.some((o) => o.missing) ? `<div class="hint" style="margin-top:6px">Missing: ${v.production.operations.filter((o) => o.missing).map((o) => `${esc(o.operation_id)} ${esc(o.missing)}`).join("; ")}</div>` : ""}</div>` : "";
  const field = (id, label, key) => `<label class="hint" style="display:block">${label}<input id="rs-${id}" inputmode="numeric" value="${esc(r.settings[key])}" style="display:block;width:110px;margin-top:4px" aria-label="${label}"></label>`;
  const form = v ? `<h3 style="margin:14px 0 8px">Output settings</h3>
    <p class="hint" style="margin-bottom:8px">Fixed by your approved plan: ${esc(v.needs.aspect_ratio)}, ${fmtDur(v.needs.duration_s)}. The only output the renderers write: ${esc(v.needs.supported_output.container)}, ${esc(v.needs.supported_output.video_codec)}, ${v.needs.supported_output.audio_codec ? esc(v.needs.supported_output.audio_codec) + " sound" : "no audio"}. Size and frame rate are yours to choose; none are assumed.</p>
    <div class="row" style="align-items:flex-end">${field("width", "Width (px)", "width")}${field("height", "Height (px)", "height")}${field("fps", "Frames per second", "fps")}
      <button class="ghost" data-action="fill-test" ${b}>Fill a small test size in the plan's format</button></div>
    <div class="row" style="margin-top:12px"><button class="ghost" data-action="render-plan" ${b}>Check the plan</button><button class="primary sm" data-action="render-go" ${b || ((v.can_render ?? v.eligible) ? "" : "disabled")}>${r.busy ? "Working..." : v.eligible ? "Render preview" : "Render preview (labelled incomplete if scenes are missing)"}</button></div>
    <p class="hint" style="margin-top:6px">${esc(v.label)}</p>` : "";
  return `<div class="card"><h3>Editor and preview render</h3>${editorHtml}${err}${ops}${form}${resultHtml(r)}</div>`;
}
const STATUS_TITLE = { final_delivery_ready: "Final delivery ready", complete_preview: "Complete preview", incomplete_preview: "Incomplete preview" };
const STATUS_CHIP = { final_delivery_ready: ["ok", "approved video, every check passed"], complete_preview: ["warn", "preview only, not final delivery"], incomplete_preview: ["bad", "NOT the approved video"] };
// One status, from the one decision in the delivery report. Nothing here works out delivery again.
function deliveryHtml(x) {
  const d = x.delivery, o = d.output, dec = d.decision;
  const status = d.status, [chipClass, chipText] = STATUS_CHIP[status] ?? STATUS_CHIP.incomplete_preview;
  const criteria = dec ? dec.criteria.map((c) => `<tr><td>${esc(c.title)}</td><td>${c.ok === true ? '<span class="chip ok">met</span>' : c.ok === false ? '<span class="chip bad">not met</span>' : '<span class="chip warn">not established</span>'}</td><td>${esc(c.detail)}${c.blockers.map((b) => `<div class="hint">${esc(b)}</div>`).join("")}</td></tr>`).join("") : "";
  const file = o ? `<span class="chip ${dec?.file_valid === false ? "bad" : "ok"}">MP4 file ${dec?.file_valid === false ? "failed" : "passed"} technical checks</span>` : "";
  return `<h3 style="margin:16px 0 8px">${esc(STATUS_TITLE[status] ?? status)} <span class="chip ${chipClass}">${esc(chipText)}</span> ${file}</h3>
    <div class="notice ${status === "final_delivery_ready" ? "info" : status === "incomplete_preview" ? "bad" : "warn"}" style="margin-bottom:10px">${esc(d.label)}</div>
    ${o ? `<video controls preload="metadata" src="${esc(o.video_url)}" style="width:100%;max-width:640px;border-radius:12px;background:#000" aria-label="${esc(STATUS_TITLE[status] ?? "Preview")}"></video>` : ""}
    ${dec ? `<table style="margin:10px 0"><thead><tr><th>Delivery criterion</th><th>Result</th><th>Why</th></tr></thead><tbody>${criteria}</tbody></table>` : ""}
    <table><thead><tr><th>Scene</th><th>Engine</th><th>Status</th><th>Missing or unmet</th></tr></thead><tbody>${d.scenes.map((s) => `<tr><td>${esc(s.scene_id)}</td><td>${s.engine ? esc(s.engine) : "-"}</td><td>${s.status === "placeholder" ? '<span class="chip bad">placeholder, not rendered</span>' : s.status === "rendered_and_verified" ? '<span class="chip ok">rendered, content checked</span>' : '<span class="chip warn">rendered, non-blank only</span>'}</td><td>${[s.omitted_reason, ...s.unmet].filter(Boolean).map((m) => `<div>${esc(m)}</div>`).join("") || "-"}</td></tr>`).join("")}</tbody></table>
    ${d.transitions.length ? `<table style="margin-top:10px"><thead><tr><th>Transition after</th><th>Template</th><th>In the video</th><th>What the frames showed</th></tr></thead><tbody>${d.transitions.map((t) => `<tr><td>${esc(t.after_scene)}</td><td class="mono">${esc(t.template)}</td><td>${t.status === "applied" ? '<span class="chip ok">applied</span>' : '<span class="chip bad">not applied</span>'}</td><td>${esc(t.check ?? t.reason)}</td></tr>`).join("")}</tbody></table>` : ""}
    ${d.asset_validation?.checks.length ? `<table style="margin-top:10px"><thead><tr><th>Scene</th><th>Picture</th><th>Found in the finished video</th><th>Detail</th></tr></thead><tbody>${d.asset_validation.checks.map((c) => `<tr><td>${esc(c.scene_id)}</td><td>${esc(pictureName(c.asset_id))}${c.mandatory ? ' <span class="chip">must appear</span>' : ""}</td><td>${c.verdict === "visible" ? '<span class="chip ok">visible</span>' : `<span class="chip bad">${esc(c.verdict.replaceAll("_", " "))}</span>`}</td><td>${esc(c.failure ?? `matched the uploaded file at ${Math.round((c.match_score ?? 0) * 100)}% on real frames`)}</td></tr>`).join("")}</tbody></table>` : ""}
    ${d.omitted_operations.length ? `<div class="notice bad" style="margin-top:10px"><b>Operations not shown</b>${d.omitted_operations.map((m) => `<div>${esc(m.scene_id)} ${esc(m.recipe_id)} (${esc(m.status)}): ${esc(m.reason)}</div>`).join("")}</div>` : ""}
    ${status !== "final_delivery_ready" ? `<div class="notice warn" style="margin-top:10px"><b>Why this is not final delivery</b>${d.final_delivery_blockers.map((b) => `<div>${esc(b)}</div>`).join("")}</div>` : ""}
    ${o ? `<dl class="kv" style="margin-top:10px"><dt>Duration</dt><dd>${fmtDur(o.duration_s)} (measured, ${o.frames} frames)</dd><dt>Size</dt><dd>${o.width} x ${o.height} at ${o.fps} fps</dd><dt>File</dt><dd>${kb(o.bytes)} <span class="mono hint">sha256 ${esc(o.sha256.slice(0, 12))}</span> <span class="mono hint">${esc(o.path)}</span></dd><dt>Engines</dt><dd>${d.engines_used.map(esc).join(", ")}</dd></dl>` : ""}`;
}
function resultHtml(r) {
  const x = r.result; if (x?.delivery) return deliveryHtml(x);
  if (!x?.record) return ""
  const rec = x.record, o = rec.output;
  if (rec.state !== "rendered") return `<div class="notice bad" style="margin-top:14px"><b>Render failed. No video was produced.</b>${rec.errors.map((er) => `<div>${esc(er.stage.replaceAll("_", " "))}: ${esc(er.message)}</div>`).join("")}</div>`;
  const qa = x.qa;
  return `<h3 style="margin:16px 0 8px">Preview <span class="chip warn">preview only, not production-ready</span></h3>
    <video controls preload="metadata" src="${esc(o.video_url)}" style="width:100%;max-width:640px;border-radius:12px;background:#000" aria-label="Rendered preview"></video>
    <dl class="kv" style="margin-top:10px"><dt>Duration</dt><dd>${fmtDur(o.duration_s)} (measured)</dd><dt>Size</dt><dd>${o.width} x ${o.height}</dd><dt>Frame rate</dt><dd>${o.fps} fps</dd><dt>Codec</dt><dd>${esc(o.video_codec)}, ${o.audio_codec ? esc(o.audio_codec) : "no audio"} in ${esc(o.container)}</dd><dt>File</dt><dd>${kb(o.bytes)} <span class="mono hint">sha256 ${esc(o.sha256.slice(0, 12))}</span></dd><dt>Checks</dt><dd>${o.checks.map((c) => `<div class="mono">${esc(c)}</div>`).join("")}</dd></dl>
    <h3 style="margin:12px 0 6px">QA</h3>${qa ? `${qa.passed.map((p) => `<div><span class="chip ok">passed</span> ${esc(p.check.replaceAll("_", " "))} <span class="mono hint">${esc(p.evidence)}</span></div>`).join("")}${qa.findings.map((f) => `<div class="notice ${f.severity === "info" ? "info" : "warn"}" style="margin-top:6px">${esc(f.severity)}: ${esc(f.description)}</div>`).join("")}` : '<div class="hint">QA could not run for this file.</div>'}
    <p class="hint" style="margin-top:8px">The recipes used are still drafts. This render is evidence for a later human review, not a review.</p>`;
}

// ---------- events ----------
document.addEventListener("input", (e) => {
  const m = /^rs-(width|height|fps)$/.exec(e.target.id ?? "");
  if (m && state.run) rstate().settings[m[1]] = e.target.value;
});
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]"); if (!el) return;
  const a = el.dataset.action;
  if (a === "editor-run") return renderStep("editor");
  if (a === "render-plan") return renderStep("plan");
  if (a === "render-go") return renderStep("render");
  if (a === "fill-test") { const r = rstate(), z = sizeFor(r.view?.needs.aspect_ratio, 640); Object.assign(r.settings, { width: String(z.width), height: String(z.height), fps: "30" }); return renderStep("plan"); }
  if (a === "asset-context") { try { await saveAsset(el.dataset.id, CONTEXT[Number(el.dataset.n)].body); } catch (er) { fail(er); } return; }
  if (a === "asset-save") {
    const card = el.closest(".g-card"), read = (f) => card.querySelector(`[data-field="${f}"]`).value;
    try { await saveAsset(el.dataset.id, { category: read("category") || null, usage: read("usage"), description: read("description").trim() || null }); } catch (er) { fail(er); }
    return;
  }
  if (a === "asset-retry") {
    try { el.disabled = true; await api(`/api/sessions/${state.sid}/assets/${el.dataset.id}/reanalyse`, { method: "POST" }); await refreshGallery(); } catch (er) { fail(er); }
    return;
  }
  if (a === "remove-asset") {
    try { const r = await api(`/api/sessions/${state.sid}/assets/${el.dataset.id}`, { method: "DELETE" }); state.assets = r.assets; state.route = null; state.run = null; delete state.transcripts[el.dataset.id]; delete state.analysis[el.dataset.id]; renderAll(); } catch (er) { fail(er); }
  } else if (a === "view-transcript") {
    const id = el.dataset.id;
    if (state.transcripts[id]) delete state.transcripts[id];
    else { try { state.transcripts[id] = await api(`/api/sessions/${state.sid}/assets/${id}/transcript`); } catch (er) { fail(er); } }
    renderAll();  } else if (a === "reply") sendText($("#reply").value);
  else if (a === "build") buildPlan();
  else if (a === "answer-questions") answerQuestions();
  else if (a === "approve") decide("approved");
  else if (a === "revise") decide("revision_requested");
  else if (a === "scene-preview") previewScene(el.dataset.scene);
  else if (a === "tab") { state.tab = el.dataset.tab; renderStage(); }
});

async function init() {
  $("#kbd-hint").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ Enter to send" : "Ctrl Enter to send";
  document.addEventListener("keydown", (e) => { if (e.target.id === "reply" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendText(e.target.value); });
  document.addEventListener("input", (e) => { if (e.target.id === "gate-notes") state.gateNotes = e.target.value; }); // survives re-renders and failed requests
  $("#prompt").addEventListener("input", updateCount);
  $("#prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendText($("#prompt").value); });
  $("#send").addEventListener("click", () => sendText($("#prompt").value));
  $("#mic").addEventListener("click", toggleMic);
  $("#voice-file").addEventListener("click", () => $("#voice-input").click());
  $("#voice-input").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) transcribeBlob(f, f.name); });
  const drop = $("#drop"), file = $("#file");
  drop.addEventListener("click", () => file.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } });
  file.addEventListener("change", () => { uploadFiles([...file.files]); file.value = ""; });
  for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
  drop.addEventListener("drop", (e) => uploadFiles([...e.dataTransfer.files]));
  $("#reset").addEventListener("click", async () => {
    try { await post(`/api/sessions/${state.sid}/reset`); } catch { /* session may be gone */ }
    Object.assign(state, { turns: [], route: null, run: null, approval: null, transcripts: {}, fromVoice: false, language: null, videoType: null, proposedVideoTypes: [], previews: {} });
    $("#prompt").value = ""; $("#lang-chip").hidden = true; updateCount(); micStatus("Speak instead of typing. Runs locally with Whisper."); renderAll();
    refreshVideoTypes();
  });
  $("#video-category")?.addEventListener("change", async () => {
    try { await post(`/api/sessions/${state.sid}/kit/category`, { video_category: videoCategory() }); } catch {}
    await refreshVideoTypes();
  });
  drawWave(false);
  try {
    state.sid = (await post("/api/sessions")).id;
    pollHealth();
    setInterval(refreshHealth, 8000);
  } catch (e) { fail(e); renderPills(); }
  renderAll();
  if (state.sid) {
    // Guided setup: its answers fill the request, facts and kind-of-video boxes below; the user reviews them and presses Send as before.
    const wiz = mountWizard({
      $, esc, api, post, toast, uploadFiles, getAssets: () => state.assets, getSid: () => state.sid,
      onFinish: ({ prompt, facts, video_category }) => {
        if (prompt) { $("#prompt").value = prompt; updateCount(); }
        $("#facts").value = facts.join("\n"); if (facts.length) $("details.facts").open = true;
        $("#video-category").value = video_category ?? "";
        refreshVideoTypes();
        $("#prompt").focus({ preventScroll: false });
      },
    });
    state.wiz = wiz;
    await wiz.start();
    await refreshVideoTypes();
  }
}
init();
