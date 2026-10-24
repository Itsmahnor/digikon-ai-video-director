// Director Console: plain ES module, no build step. All model and user text goes through esc() before it reaches the DOM.
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
  ["intake", "Understand the brief"], ["analyse_assets", "Check your files"], ["treatment", "Write the treatment and claims"],
  ["storyboard", "Storyboard the scenes"], ["storyboard_gate", "Your approval of the storyboard"],
  ["edit_plan", "Choose a recipe for every edit"], ["edit_plan_gate", "Your approval of the edit plan"],
];
const PHASES = ["Describe", "Understand", "Plan", "Approve"];

const state = {
  sid: null, health: null, offline: false, assets: [], analysis: {}, turns: [], route: null, busy: false,
  fromVoice: false, language: null,
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
    if (s.analysis.some((a) => a.status === "running")) analysisTimer = setTimeout(refreshAnalysis, 1500);
  } catch { /* session may be gone */ }
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
function factsLines() { return $("#facts").value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 20); }

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
    try { res = await fetch(`/api/sessions/${state.sid}/direct`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facts: factsLines() }) }); } catch { throw offlineError(); }
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
    else if (d.status === "approved") toast("Both approvals are recorded. Nothing is rendered yet.", "ok");
    else if (decision === "approved") toast("Storyboard approved. The edit plan is ready for review.", "ok");
    else toast(`Changes applied. Version ${d.versions[d.gate]} is ready for review.`, "ok");
  } catch (e) { fail(e); }
  state.busy = false; renderAll();
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
  return pipe + err + results(res);
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
        ${feasibilityHtml(res.assetFeasibility)}
        ${sp.scenes.map((s) => `<div class="scene"><div class="head"><b>${s.scene_id} · ${esc(s.purpose)}</b><span class="mono hint">${fmtDur(s.start_time)} to ${fmtDur(s.start_time + s.duration_seconds)}</span></div>
          <div class="sub">${esc(s.shot.shot_size.replaceAll("_", " "))}, ${esc(s.shot.camera_motion.replaceAll("_", " "))}: ${esc(s.shot.visual_action)}</div>
          ${s.overlay ? `<div class="overlay-txt">${esc(s.overlay.text)}</div>` : ""}
          ${s.voiceover ? `<div class="sub">Voiceover: "${esc(s.voiceover)}"</div>` : ""}
          ${(s.required_assets ?? []).length ? `<div class="chips">${s.production_method ? `<span class="chip">${esc(s.production_method.replaceAll("_", " "))}</span>` : ""}${s.required_assets.map((r) => `<span class="chip ${{ supplied: "ok", generate_graphics: r.placeholder ? "warn" : "ok", needs_external: "bad", missing_blocking: "bad" }[r.availability]}" title="${esc(r.fallback ?? "")}">${esc(r.need)}: ${esc(r.placeholder ? "placeholder graphic" : r.availability.replaceAll("_", " "))}</span>`).join("")}</div>` : ""}
          ${(s.unresolved ?? []).map((u) => `<div class="notice info" style="margin:6px 0 0">${esc(u.kind.replace("_", " "))}: ${esc(u.note)}</div>`).join("")}
          <div class="chips">${s.asset_ids.length ? s.asset_ids.map((a) => `<span class="chip">${esc(assetName(a))}${s.source_in_seconds ? ` @${fmtDur(s.source_in_seconds)}` : ""}</span>`).join("") : '<span class="chip warn">graphics only</span>'}${s.claim_ids.map((c) => `<span class="chip ok">claim ${esc(c)}</span>`).join("")}<span class="chip">then ${esc(s.transition_out.replaceAll("_", " "))}</span></div></div>`).join("")}`;
    },
    edits: () => `<div class="notice info" style="margin-bottom:12px">Built on storyboard version ${res.versions.storyboard} <span class="mono">(${esc(String(res.hashes.storyboard).slice(0, 12))})</span>, which you approved. Edit plan version ${res.versions.edit_plan}.</div>` + sp.scenes.map((s) => {
      const uses = ep.uses.filter((u) => u.scene_id === s.scene_id);
      return `<div class="scene"><div class="head"><b>${s.scene_id} · ${esc(s.purpose)}</b><span class="mono hint">${fmtDur(s.duration_seconds)}</span></div>${uses.length ? uses.map((u) => `<div style="margin:8px 0"><span class="chip recipe">${esc(u.recipe_id)}</span> ${Object.keys(u.params).length ? `<span class="mono hint">${esc(JSON.stringify(u.params))}</span>` : '<span class="hint">default parameters</span>'}<div class="sub" style="margin:4px 0 0">${esc(u.rationale)}</div></div>`).join("") : '<div class="sub">No special treatment</div>'}</div>`;
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
  const bar = gate ? `<div class="approve-bar gate"><div><b>Approve this ${what}?</b><div class="hint">Version ${res.versions[gate]}. ${gate === "storyboard" ? "Approving lets the Director make the edit plan." : "Approving records your second approval."} Nothing is rendered. ${used >= max ? "This is the last change request: another one needs a human decision." : ""}</div></div>
      <textarea id="gate-notes" rows="2" aria-label="What should change?" placeholder="To request changes, say what should change in this ${what}">${esc(state.gateNotes)}</textarea>
      <div class="row"><button class="ghost" data-action="revise" ${state.busy ? "disabled" : ""}>Request changes</button><button class="primary sm" data-action="approve" ${state.busy ? "disabled" : ""}>Approve ${what}</button></div></div>` : "";
  const finished = done ? `<div class="notice info">Both approvals are recorded (storyboard version ${res.versions.storyboard}, edit plan version ${res.versions.edit_plan}). Nothing is rendered: rendering is not built yet, and a future render must pass the approval check first. ${res.renderable.ok ? "The check passes for these exact versions." : `The check does not pass: ${esc(res.renderable.reasons.join("; "))}`}</div>` : "";
  return `${header}<div class="card"><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? "on" : ""}" role="tab" data-action="tab" data-tab="${k}">${l}</button>`).join("")}</div><div style="padding-top:16px">${body[tab]()}</div></div>
    ${bar}
    ${finished}`;
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

// ---------- events ----------
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]"); if (!el) return;
  const a = el.dataset.action;
  if (a === "remove-asset") {
    try { const r = await api(`/api/sessions/${state.sid}/assets/${el.dataset.id}`, { method: "DELETE" }); state.assets = r.assets; state.route = null; state.run = null; delete state.transcripts[el.dataset.id]; delete state.analysis[el.dataset.id]; renderAll(); } catch (er) { fail(er); }
  } else if (a === "view-transcript") {
    const id = el.dataset.id;
    if (state.transcripts[id]) delete state.transcripts[id];
    else { try { state.transcripts[id] = await api(`/api/sessions/${state.sid}/assets/${id}/transcript`); } catch (er) { fail(er); } }
    renderAll();  } else if (a === "reply") sendText($("#reply").value);
  else if (a === "build") buildPlan();
  else if (a === "approve") decide("approved");
  else if (a === "revise") decide("revision_requested");
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
    Object.assign(state, { turns: [], route: null, run: null, approval: null, transcripts: {}, fromVoice: false, language: null });
    $("#prompt").value = ""; $("#lang-chip").hidden = true; updateCount(); micStatus("Speak instead of typing. Runs locally with Whisper."); renderAll();
  });
  drawWave(false);
  try {
    state.sid = (await post("/api/sessions")).id;
    pollHealth();
    setInterval(refreshHealth, 8000);
  } catch (e) { fail(e); renderPills(); }
  renderAll();
}
init();
