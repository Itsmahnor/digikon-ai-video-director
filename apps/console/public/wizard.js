// Guided intake wizard. Plain ES module, no build step. The first half is pure logic (no DOM) so it can be tested in Node; mountWizard() below uses the DOM.
// Everything the user typed or the server returned goes through esc() before it reaches the page.

export const GUIDELINE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"];

/** The steps, in order. A step is skippable only when every field in it can be skipped for this kind of video (the server's completeness check says which). */
export const STEPS = [
  { id: "goal", title: "Goal", fields: ["goal"] },
  { id: "audience", title: "Audience", fields: ["audience"] },
  { id: "platform", title: "Platform", fields: ["platform"] },
  { id: "brand", title: "Brand", fields: ["brand.colours", "brand.fonts", "brand.logo", "brand.tone"] },
  { id: "website", title: "Website", fields: ["website", "guideline"] },
  { id: "assets", title: "Material", fields: ["assets"] },
  // The last step is the review: nothing is asked there, it shows what was collected and creates the story.
  { id: "review", title: "Review", fields: [], local: true },
];

export const PLATFORMS = ["Instagram Reels", "TikTok", "YouTube Shorts", "YouTube", "LinkedIn", "Instagram or Facebook feed", "Website hero", "Other"];

const item = (c, field) => c.items.find((i) => i.field === field);

/** "done" (everything provided), "skipped" (everything skipped or provided), "partial", or "open". */
export function stepStatus(step, completeness) {
  if (step.local) return "open";
  const states = step.fields.map((f) => item(completeness, f)?.state ?? "missing");
  if (states.every((s) => s === "provided")) return "done";
  if (states.every((s) => s === "provided" || s === "skipped")) return "skipped";
  if (states.some((s) => s === "provided")) return "partial";
  return "open";
}
export const canSkipStep = (step, completeness) => !step.local && step.fields.every((f) => item(completeness, f)?.can_skip === true);
export const stepNeedsConfirmation = (step, completeness) => step.fields.some((f) => item(completeness, f)?.needs_confirmation);

/** Lower-case #rrggbb colours from text like "#C8501E, 0a7a5a #fff". Returns { colours, bad } so the wizard can say which entries it could not use. */
export function parseColours(text) {
  const colours = [], bad = [];
  for (const raw of String(text ?? "").split(/[\s,;]+/).filter(Boolean)) {
    let h = raw.replace(/^#/, "").toLowerCase();
    if (/^[0-9a-f]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
    if (/^[0-9a-f]{6}$/.test(h)) { if (!colours.includes(`#${h}`)) colours.push(`#${h}`); } else bad.push(raw);
  }
  return { colours, bad };
}
export const parseFactLines = (text) => [...new Set(String(text ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean))].slice(0, 20);
export const parseList = (text) => [...new Set(String(text ?? "").split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean))];

/** Checks a file before it is sent: the wrong type or a huge file is refused here with a plain reason. Returns null when it is fine. */
export function fileProblem(file, kind) {
  const name = String(file?.name ?? "").toLowerCase(), ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  if (kind === "guideline") {
    if (ext !== ".pdf") return `${file.name} is not a PDF. A brand guideline must be a PDF file; you can also type the colours and fonts in yourself.`;
    if (file.size > GUIDELINE_MAX_BYTES) return `${file.name} is ${Math.round(file.size / 1048576)} MB. A guideline can be at most ${GUIDELINE_MAX_BYTES / 1048576} MB; export a smaller PDF or type the details in.`;
  }
  if (kind === "logo") {
    if (!IMAGE_EXTENSIONS.includes(ext)) return `${file.name} is not a picture. Use a PNG, JPG, WebP or SVG file for the logo, or skip it.`;
    if (file.size > IMAGE_MAX_BYTES) return `${file.name} is ${Math.round(file.size / 1048576)} MB. A logo can be at most ${IMAGE_MAX_BYTES / 1048576} MB.`;
    if (file.size === 0) return `${file.name} is empty.`;
  }
  return null;
}

export const LENGTHS = [15, 20, 25, 30, 45, 60];
export const FORMATS = [["16:9", "Wide 16:9 (YouTube, LinkedIn, websites)"], ["9:16", "Vertical 9:16 (Reels, TikTok, Shorts)"], ["1:1", "Square 1:1 (feeds)"]];
export const SOUNDS = [["", "Let the Director decide"], ["music", "Music only"], ["narration", "Narration (voice-over)"], ["both", "Narration and music"], ["silent", "Silent, text on screen only"]];
const SOUND_TEXT = { music: "music only, no voice-over", narration: "narration (voice-over), no music", both: "narration and music", silent: "silent, text on screen only" };
/** The format a platform usually wants, so the choice starts in the right place. */
export function defaultFormat(platform) {
  const p = String(platform ?? "").toLowerCase();
  if (/reels|tiktok|shorts/.test(p)) return "9:16";
  if (/feed/.test(p)) return "1:1";
  if (p) return "16:9";
  return "";
}

/** The request text built from the kit, for the prompt box. Only provided values are used; nothing is invented. `extra` holds the answers that are not kit fields: product, length, format, sound, call to action. */
export function composePrompt(kit, extra = {}) {
  const v = (f) => (f.state === "provided" ? f.value : null);
  const parts = [];
  if (v(kit.goal)) parts.push(String(v(kit.goal)).replace(/[.\s]+$/, "") + ".");
  if (v(kit.audience)) parts.push(`Audience: ${String(v(kit.audience)).replace(/[.\s]+$/, "")}.`);
  const trim = (x) => String(x).replace(/[.\s]+$/, "");
  if (extra.product) parts.push(`Product or business: ${extra.product}${extra.does ? `, ${trim(extra.does)}` : ""}.`);
  else if (extra.does) parts.push(`What it is: ${trim(extra.does)}.`);
  if (v(kit.platform)) parts.push(`Platform: ${String(v(kit.platform)).replace(/[.\s]+$/, "")}.`);
  if (extra.format) parts.push(`Format: ${extra.format}${extra.format === "16:9" ? " (wide)" : extra.format === "9:16" ? " (vertical)" : " (square)"}.`);
  if (extra.length) parts.push(`Length: ${extra.length} seconds.`);
  if (extra.cta) parts.push(`Call to action: ${trim(extra.cta)}.`);
  if (extra.sound && SOUND_TEXT[extra.sound]) parts.push(`Sound: ${SOUND_TEXT[extra.sound]}.`);
  const brand = [];
  if (v(kit.brand.colours)) brand.push(`colours ${v(kit.brand.colours).join(", ")}`);
  if (v(kit.brand.fonts)) brand.push(`fonts ${v(kit.brand.fonts).join(", ")}`);
  if (v(kit.brand.tone)) brand.push(`tone ${String(v(kit.brand.tone)).replace(/[.\s]+$/, "")}`);
  if (brand.length) parts.push(`Brand: ${brand.join("; ")}.`);
  return parts.join(" ");
}
/** The facts the user typed or confirmed, one per line, for the facts box. Unconfirmed extracted facts are never included. */
export function factsFromKit(kit) {
  const f = kit.facts;
  return f.state === "provided" ? f.value.filter((x) => x.origin === "user" || x.confirmed).map((x) => x.text) : [];
}

/** First step that still needs an answer (a required field not provided, or a recommended one not answered); else the last step. */
export function firstOpenStep(completeness) {
  const i = STEPS.findIndex((s) => stepStatus(s, completeness) === "open" || stepStatus(s, completeness) === "partial");
  return i < 0 ? STEPS.length - 1 : i;
}
export const nextStepIndex = (i) => Math.min(STEPS.length - 1, i + 1);
export const prevStepIndex = (i) => Math.max(0, i - 1);

/** Plain names for the kit fields, as the user knows them. */
export const FIELD_LABELS = {
  goal: "Goal", audience: "Audience", platform: "Platform", "brand.colours": "Brand colours", "brand.fonts": "Fonts", "brand.logo": "Logo", "brand.tone": "Tone of voice",
  website: "Website", guideline: "Brand guideline", facts: "Facts about the business", assets: "Your files",
};
const LEVEL_ORDER = ["required", "recommended", "optional"];
export const stepIndexOfField = (field) => { const i = STEPS.findIndex((s) => s.fields.includes(field)); return i < 0 ? null : i; };
/** The strongest level among a step's fields, so the step can say whether it is required. */
export function stepLevel(step, completeness) {
  if (step.local) return "required";
  const levels = step.fields.map((f) => item(completeness, f)?.level ?? "optional");
  return LEVEL_ORDER.find((l) => levels.includes(l)) ?? "optional";
}
/** The kit as one readiness view: every field in its group (required, recommended, optional) with what is known, and a one-line verdict. No model, no guessing. */
export function kitSummary(completeness) {
  const groups = { required: [], recommended: [], optional: [] };
  for (const it of completeness.items) {
    const status = it.state === "provided" ? "provided" : it.state === "skipped" ? "skipped" : it.level === "required" ? "needed" : "open";
    groups[it.level].push({ field: it.field, label: FIELD_LABELS[it.field] ?? it.field, status, needsConfirmation: it.needs_confirmation, step: stepIndexOfField(it.field) });
  }
  const needed = groups.required.filter((r) => r.status !== "provided").map((r) => r.label);
  const confirm = completeness.items.filter((i) => i.needs_confirmation).map((i) => FIELD_LABELS[i.field] ?? i.field);
  const n = (g, s) => groups[g].filter((r) => r.status === s).length;
  const verdict = needed.length
    ? `Still needed before I can plan: ${needed.join(", ")}.`
    : confirm.length ? `Everything required is in. Confirm what was found for: ${confirm.join(", ")}.` : "Everything required is in. You can send it to the Director.";
  return {
    groups, ready: completeness.ready && !needed.length, verdict, needed, confirm,
    counts: { required: { done: n("required", "provided"), total: groups.required.length }, recommended: { done: n("recommended", "provided"), skipped: n("recommended", "skipped"), total: groups.recommended.length }, optional: { done: n("optional", "provided"), skipped: n("optional", "skipped"), total: groups.optional.length } },
  };
}
// ---------------------------------------------------------------- DOM
const KEY = "digikon.wizard.v1";
// Answers are kept for this tab only (a reload keeps them, closing the tab forgets them), so opening the console again starts a fresh plan. The older permanent copy is removed.
try { localStorage.removeItem(KEY); } catch { /* storage may be blocked */ }
const store = {
  read() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { return null; } },
  write(v) { try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode: answers are still kept on the server for this session */ } },
};

export function mountWizard(deps) {
  const { $, esc, api, post, toast, uploadFiles, getAssets, getSid, onFinish } = deps;
  const root = $("#wizard");
  const w = { view: null, idx: 0, error: "", busy: false, extraction: null, notice: "", brands: [], restored: false, extra: {}, collapsed: false };
  const kit = () => w.view.kit;
  const comp = () => w.view.completeness;

  const field = async (f, action, value) => { w.view = await post(`/api/sessions/${getSid()}/kit/field`, { field: f, action, value }); };
  const persist = () => store.write({ sid: getSid(), idx: w.idx, kit: w.view?.kit ?? null, extra: w.extra });
  async function load() {
    w.view = await api(`/api/sessions/${getSid()}/kit`);
    w.brands = (await api("/api/brand-kits").catch(() => ({ brands: [] }))).brands;
  }
  /** After a reload the same session may still exist; if the server restarted, the answers saved in this browser are replayed into the new session. */
  async function restore() {
    const saved = store.read();
    if (!saved?.kit) return false;
    try {
      const k = saved.kit;
      const replay = [["goal", k.goal], ["audience", k.audience], ["platform", k.platform], ["brand.colours", k.brand.colours], ["brand.fonts", k.brand.fonts], ["brand.tone", k.brand.tone], ["website", k.website]];
      for (const [name, f] of replay) { if (f.state === "provided") await field(name, "provide", f.value); else if (f.state === "skipped") await field(name, "skip").catch(() => {}); }
      const typed = (k.facts.value ?? []).filter((x) => x.origin === "user" || x.confirmed).map((x) => x.text);
      if (typed.length) await field("facts", "provide", typed);
      for (const name of ["facts", "assets", "brand.logo", "guideline"]) { const st = name === "brand.logo" ? k.brand.logo.state : k[name].state; if (st === "skipped") await field(name, "skip").catch(() => {}); }
      if (k.video_category) w.view = await post(`/api/sessions/${getSid()}/kit/category`, { video_category: k.video_category });
      w.idx = Math.min(saved.idx ?? 0, STEPS.length - 1); w.restored = true; return true;
    } catch { return false; }
  }

  const chips = () => `<ol class="wz-steps" aria-label="Setup steps">${STEPS.map((s, i) => { const st = stepStatus(s, comp()); return `<li><button type="button" class="wz-chip ${i === w.idx ? "current" : ""} ${st}" data-wz="goto" data-i="${i}" aria-current="${i === w.idx ? "step" : "false"}"><span class="n">${st === "done" ? "&#10003;" : st === "skipped" ? "&ndash;" : i + 1}</span>${esc(s.title)}${st === "skipped" ? '<span class="sr">, skipped</span>' : ""}</button></li>`; }).join("")}</ol>`;
  const progress = () => { const done = STEPS.filter((s) => ["done", "skipped"].includes(stepStatus(s, comp()))).length; return `<div class="wz-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${STEPS.length}" aria-valuenow="${done}" aria-label="Setup progress"><span style="width:${(done / STEPS.length) * 100}%"></span></div><p class="hint wz-count">${done} of ${STEPS.length} steps done or skipped</p>`; };
  const val = (name) => { const f = name.startsWith("brand.") ? kit().brand[name.slice(6)] : kit()[name]; return f.state === "provided" ? f.value : null; };

  const bodies = {
    goal: () => `<label class="field-label" for="wz-goal">What is this video for?</label>
      <textarea id="wz-goal" rows="3" maxlength="500" placeholder="e.g. Get free-trial sign-ups for our invoicing app">${esc(val("goal") ?? "")}</textarea>
      <label class="field-label" for="wz-product">Product or business name <span class="hint">the name shown in the video</span></label>
      <input id="wz-product" type="text" maxlength="120" value="${esc(w.extra.product ?? "")}" placeholder="e.g. Slotly">
      <label class="field-label" for="wz-does">What it does, in one line</label>
      <input id="wz-does" type="text" maxlength="200" value="${esc(w.extra.does ?? "")}" placeholder="e.g. a scheduling app for small agencies">
      <label class="field-label" for="wz-category">Kind of video <span class="hint">optional</span></label>
      <select id="wz-category"><option value="">Not specified</option>${[["saas", "Software / SaaS"], ["ecommerce", "E-commerce / product"], ["general-promo", "General promotion"]].map(([v, t]) => `<option value="${v}" ${kit().video_category === v ? "selected" : ""}>${t}</option>`).join("")}</select>`,
    audience: () => `<label class="field-label" for="wz-audience">Who should watch it?</label>
      <input id="wz-audience" type="text" maxlength="500" value="${esc(val("audience") ?? "")}" placeholder="e.g. Freelancers and small agencies">
      <label class="field-label" for="wz-facts">True facts the video may state <span class="hint">one per line. Only these can appear as claims</span></label>
      <textarea id="wz-facts" rows="4" maxlength="3000" placeholder="Free for 14 days.&#10;Works with Google Calendar.">${esc(factsFromKit(kit()).join("\n"))}</textarea>
      <label class="field-label" for="wz-cta">What should viewers do at the end? <span class="hint">the button or invitation, in your words</span></label>
      <input id="wz-cta" type="text" maxlength="120" value="${esc(w.extra.cta ?? "")}" placeholder="e.g. Start your free trial">`,
    platform: () => { const cur = val("platform") ?? "", known = PLATFORMS.slice(0, -1).includes(cur); return `<label class="field-label" for="wz-platform">Where will it be shown?</label>
      <select id="wz-platform"><option value="">Choose...</option>${PLATFORMS.map((p) => `<option ${p === cur || (p === "Other" && cur && !known) ? "selected" : ""}>${esc(p)}</option>`).join("")}</select>
      <input id="wz-platform-other" type="text" maxlength="100" aria-label="Other platform" placeholder="Type the platform" value="${cur && !known ? esc(cur) : ""}" ${cur && !known ? "" : "hidden"}>
      <label class="field-label" for="wz-format">Shape of the video</label>
      <select id="wz-format">${FORMATS.map(([v, t]) => `<option value="${v}" ${(w.extra.format ?? defaultFormat(cur) ?? "") === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
      <label class="field-label" for="wz-length">Length</label>
      <select id="wz-length">${LENGTHS.map((n) => `<option value="${n}" ${Number(w.extra.length ?? 25) === n ? "selected" : ""}>${n} seconds</option>`).join("")}</select>
      <p class="hint">Short videos hold attention, but a video that explains several things needs 25 seconds or more.</p>`; },
    brand: () => `<p class="hint">Everything here is optional. Skip it and I will use neutral choices and say so.</p>
      <label class="field-label" for="wz-colours">Brand colours <span class="hint">hex codes, e.g. #c8501e #0a7a5a</span></label>
      <input id="wz-colours" type="text" value="${esc((val("brand.colours") ?? []).join(" "))}" autocomplete="off">
      <label class="field-label" for="wz-fonts">Fonts <span class="hint">separate with commas</span></label>
      <input id="wz-fonts" type="text" value="${esc((val("brand.fonts") ?? []).join(", "))}">
      <label class="field-label" for="wz-tone">Tone of voice</label>
      <input id="wz-tone" type="text" maxlength="300" value="${esc(val("brand.tone") ?? "")}" placeholder="e.g. warm and direct">
      <label class="field-label" for="wz-logo">Logo <span class="hint">PNG, JPG, WebP or SVG</span></label>
      <input id="wz-logo" type="file" accept="image/*,.svg">
      <p class="hint" id="wz-logo-status">${val("brand.logo") ? "Logo added." : kit().brand.logo.state === "skipped" ? "No logo: I will not draw one." : "No logo yet. You can skip it; I will not invent one."}</p>
      <div class="wz-row"><input id="wz-brand-name" type="text" maxlength="80" aria-label="Brand name to save" placeholder="Name this brand to reuse it later"><button type="button" class="ghost" data-wz="save-brand">Save brand</button></div>`,
    website: () => `<label class="field-label" for="wz-url">Your website <span class="hint">optional. I read the page for colours, fonts and facts, and you confirm what to use</span></label>
      <div class="wz-row"><input id="wz-url" type="url" inputmode="url" placeholder="https://example.com" value="${esc(val("website") ?? "")}"><button type="button" class="ghost" data-wz="read-site" ${w.busy ? "disabled" : ""}>Read my site</button></div>
      <label class="field-label" for="wz-guide">Brand guideline <span class="hint">optional PDF, up to ${GUIDELINE_MAX_BYTES / 1048576} MB</span></label>
      <input id="wz-guide" type="file" accept="application/pdf,.pdf">
      ${val("guideline") ? '<p class="hint">Guideline file added.</p>' : ""}
      ${extractionHtml()}`,
    assets: () => `<p class="hint">The best videos use real material. Add any of these, all optional: screenshots of your product, a screen recording, other video clips, a voice-over recording, music you have the right to use. Without them I draw concept graphics and label them as such.</p>
      <label class="field-label" for="wz-files">Add files</label>
      <input id="wz-files" type="file" multiple>
      <p class="hint" id="wz-files-status">${getAssets().length ? `${getAssets().length} file${getAssets().length === 1 ? "" : "s"} added.` : "No files yet."}</p>
      <label class="field-label" for="wz-sound">Sound</label>
      <select id="wz-sound">${SOUNDS.map(([v, t]) => `<option value="${v}" ${(w.extra.sound ?? "") === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`,
    review: () => reviewHtml(),
  };

  function reviewHtml() {
    const goto = (i) => `<button type="button" class="wz-link" data-wz="goto" data-i="${i}">Change</button>`;
    const idx = (id) => STEPS.findIndex((x) => x.id === id);
    const facts = factsFromKit(kit()), files = getAssets();
    const kinds = (t) => files.filter((a) => a.media_type === t).length;
    const rows = [
      ["Goal", val("goal"), idx("goal")],
      ["Product", [w.extra.product, w.extra.does].filter(Boolean).join(", ") || null, idx("goal")],
      ["Audience", val("audience"), idx("audience")],
      ["Facts it may state", facts.length ? `${facts.length} fact${facts.length === 1 ? "" : "s"}` : null, idx("audience")],
      ["Call to action", w.extra.cta ?? null, idx("audience")],
      ["Platform", val("platform"), idx("platform")],
      ["Shape and length", [w.extra.format ?? defaultFormat(val("platform")), (w.extra.length ?? 25) + " seconds"].filter(Boolean).join(", "), idx("platform")],
      ["Brand", [val("brand.tone"), (val("brand.colours") ?? []).join(" "), val("brand.logo") ? "logo added" : ""].filter(Boolean).join(" · ") || null, idx("brand")],
      ["Website", val("website"), idx("website")],
      ["Material", files.length ? [kinds("video") ? `${kinds("video")} video` : "", kinds("image") ? `${kinds("image")} image${kinds("image") === 1 ? "" : "s"}` : "", kinds("audio") ? `${kinds("audio")} audio` : ""].filter(Boolean).join(", ") : null, idx("assets")],
      ["Sound", (SOUNDS.find(([v]) => v === (w.extra.sound ?? "")) ?? SOUNDS[0])[1], idx("assets")],
    ];
    const notes = [];
    if (!files.length) notes.push("No pictures or recordings yet, so the scenes will be drawn graphics, labelled as concept illustrations.");
    if (!facts.length) notes.push("No facts given, so nothing in the video will be presented as a verified claim.");
    if (!w.extra.product) notes.push("No product name, so the video will not show one.");
    return `<p class="hint">This is everything I have. Change anything, then create the story.</p>
      <dl class="wz-review">${rows.map(([k, v, i]) => `<dt>${esc(k)}</dt><dd class="${v ? "" : "none"}">${v ? esc(String(v)) : "not given"} ${goto(i)}</dd>`).join("")}</dl>
      ${notes.length ? `<details class="wz-notes"><summary>${notes.length} thing${notes.length === 1 ? "" : "s"} to know</summary><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}`;
  }

  function extractionHtml() {
    const ex = w.view.pending_extractions?.[0] ?? null;
    if (w.notice) return `<p class="wz-note" role="status">${esc(w.notice)}</p>`;
    if (!ex) return "";
    const sw = ex.colours.map((c) => `<label class="wz-cand"><input type="checkbox" data-kind="colour" value="${esc(c.hex)}"><span class="sw" style="background:${esc(c.hex)}"></span>${esc(c.hex)}</label>`).join("");
    const fonts = ex.fonts.map((f) => `<label class="wz-cand"><input type="checkbox" data-kind="font" value="${esc(f)}">${esc(f)}</label>`).join("");
    const facts = ex.facts.map((f) => `<label class="wz-cand wide"><input type="checkbox" data-kind="fact" value="${esc(f.id)}">${esc(f.text)}</label>`).join("");
    return `<div class="wz-found" role="group" aria-label="Found on ${esc(ex.from)}"><p><strong>Found in ${esc(ex.source === "website" ? "the website" : "the guideline")}.</strong> <span class="hint">Nothing is used until you tick it and press Use selected.</span></p>
      ${sw ? `<p class="hint">Colours</p><div class="wz-cands">${sw}</div>` : ""}${fonts ? `<p class="hint">Fonts</p><div class="wz-cands">${fonts}</div>` : ""}${facts ? `<p class="hint">Possible facts about the business</p><div class="wz-cands">${facts}</div>` : ""}
      <div class="wz-row"><button type="button" class="ghost" data-wz="tick-all">Tick all</button><button type="button" class="ghost" data-wz="tick-none">Clear</button><button type="button" class="primary sm" data-wz="confirm" data-source="${esc(ex.source)}">Use selected</button></div></div>`;
  }

  const saved = () => (w.brands.length ? `<div class="wz-saved"><label class="field-label" for="wz-saved-brand">Welcome back? Start from a saved brand</label><div class="wz-row"><select id="wz-saved-brand"><option value="">Choose a saved brand...</option>${w.brands.map((b) => `<option value="${esc(b.brand_id)}">${esc(b.name)}</option>`).join("")}</select><button type="button" class="ghost" data-wz="load-brand">Use it</button></div></div>` : "");

  const STATUS_TEXT = { provided: "Provided", skipped: "Skipped", needed: "Needed", open: "Not answered" };
  function summaryHtml(open) {
    const s = kitSummary(comp());
    const group = (g, title) => `<div class="wz-group"><h4>${title} <span class="hint">${s.counts[g].done} of ${s.counts[g].total} provided${s.counts[g].skipped ? `, ${s.counts[g].skipped} skipped` : ""}</span></h4><ul>${s.groups[g].map((r) => `<li class="${r.status}"><span class="wz-st ${r.status}">${STATUS_TEXT[r.status]}</span> ${r.step === null ? esc(r.label) : `<button type="button" class="wz-link" data-wz="goto" data-i="${r.step}">${esc(r.label)}</button>`}${r.needsConfirmation ? ' <span class="wz-st warn">Confirm what was found</span>' : ""}</li>`).join("")}</ul></div>`;
    return `<details class="wz-summary" ${open ? "open" : ""}><summary><span class="wz-st ${s.ready ? "provided" : "needed"}">${s.ready ? "Ready" : "Not ready"}</span> Your kit: ${esc(s.verdict)}</summary>${group("required", "Required")}${group("recommended", "Recommended")}${group("optional", "Optional")}<p class="hint">Skipping is a choice, not a gap: I will use neutral choices for anything you skip and say so. Facts you add in the box below the wizard count too.</p></details>`;
  }
  function render() {
    if (!w.view) return;
    const step = STEPS[w.idx], last = w.idx === STEPS.length - 1, canSkip = canSkipStep(step, comp());
    root.hidden = w.collapsed;
    root.querySelector("#wz-body").innerHTML = `${w.idx === 0 ? saved() : ""}<h3 class="wz-title">${esc(step.title)} ${step.local ? "" : `<span class="wz-level ${stepLevel(step, comp())}">${stepLevel(step, comp())}</span>`} <span class="hint">step ${w.idx + 1} of ${STEPS.length}</span></h3>${bodies[step.id]()}<p class="wz-error" id="wz-error" role="alert">${esc(w.error)}</p>${step.local ? "" : summaryHtml(last)}`;
    root.querySelector("#wz-steps").innerHTML = chips();
    root.querySelector("#wz-progress-wrap").innerHTML = progress();
    root.querySelector("#wz-back").disabled = w.idx === 0 || w.busy;
    const skip = root.querySelector("#wz-skip"); skip.hidden = !canSkip; skip.disabled = w.busy;
    const next = root.querySelector("#wz-next"); next.disabled = w.busy; next.textContent = last ? "Create the story" : "Continue";
    const plat = root.querySelector("#wz-platform"); if (plat) plat.addEventListener("change", () => { root.querySelector("#wz-platform-other").hidden = plat.value !== "Other"; const f = defaultFormat(plat.value), fs = root.querySelector("#wz-format"); if (f && fs) fs.value = f; });
    persist();
  }

  /** Saves what is typed in the current step. Returns false (and shows why) when it cannot be saved. Blank answers are left open, not skipped. */
  async function saveStep() {
    const id = STEPS[w.idx].id, v = (sel) => root.querySelector(sel)?.value?.trim() ?? "";
    w.error = "";
    if (id === "goal") {
      const goal = v("#wz-goal"), cat = v("#wz-category") || null;
      if (cat !== kit().video_category) w.view = await post(`/api/sessions/${getSid()}/kit/category`, { video_category: cat });
      if (goal) await field("goal", "provide", goal); else if (!val("goal")) { w.error = "Say what the video is for, even in a few words."; return false; }
      w.extra.product = v("#wz-product"); w.extra.does = v("#wz-does");
    } else if (id === "audience") {
      const a = v("#wz-audience"); if (a) await field("audience", "provide", a); else if (!val("audience")) { w.error = "Say who should watch it."; return false; }
      const lines = parseFactLines(v("#wz-facts")); if (lines.length) await field("facts", "provide", lines); else if (factsFromKit(kit()).length) await field("facts", "unset");
      w.extra.cta = v("#wz-cta");
    } else if (id === "platform") {
      const p = v("#wz-platform") === "Other" ? v("#wz-platform-other") : v("#wz-platform");
      if (p) await field("platform", "provide", p); else if (!val("platform")) { w.error = "Choose where it will be shown, or pick Other and type it."; return false; }
      w.extra.format = v("#wz-format") || defaultFormat(p); w.extra.length = Number(v("#wz-length")) || 25;
    } else if (id === "brand") {
      const { colours, bad } = parseColours(v("#wz-colours"));
      if (bad.length) { w.error = `I could not read ${bad.map((b) => `"${b}"`).join(", ")} as a colour. Use hex codes like #c8501e.`; return false; }
      if (colours.length) await field("brand.colours", "provide", colours); else if (!v("#wz-colours") && val("brand.colours")) await field("brand.colours", "unset");
      const fonts = parseList(v("#wz-fonts")); if (fonts.length) await field("brand.fonts", "provide", fonts); else if (val("brand.fonts")) await field("brand.fonts", "unset");
      const tone = v("#wz-tone"); if (tone) await field("brand.tone", "provide", tone); else if (val("brand.tone")) await field("brand.tone", "unset");
    } else if (id === "assets") {
      w.extra.sound = v("#wz-sound");
    } else if (id === "website") {
      const u = v("#wz-url"); if (u && u !== val("website")) { try { new URL(u); } catch { w.error = "That does not look like a web address. It should start with https://"; return false; } await field("website", "provide", u); }
    }
    return true;
  }
  /** Runs an action with the buttons disabled. The step is not re-rendered until the action is done, because re-rendering first would wipe what the user has typed. */
  async function guarded(fn) {
    if (w.busy) return;
    w.busy = true; root.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try { await fn(); } catch (e) { w.error = e.message || String(e); }
    w.busy = false; render();
  }

  async function finish() {
    const c = comp();
    const open = c.next.map((f) => f.replace("brand.", "brand ")).join(", ");
    if (c.ready) w.collapsed = true;
    onFinish({ kit: kit(), prompt: composePrompt(kit(), w.extra), facts: factsFromKit(kit()), video_category: kit().video_category, ready: c.ready, open, autoSend: c.ready });
    w.notice = "";
    if (!c.ready) toast(`Not quite ready: ${open} is still open. Go back and fill it in.`, "");
  }

  async function go(i) { w.idx = Math.max(0, Math.min(STEPS.length - 1, i)); w.error = ""; w.notice = ""; }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-wz]"); if (!b || w.busy) return;
    const a = b.dataset.wz;
    if (a === "tick-all" || a === "tick-none") { root.querySelectorAll(".wz-found input[type=checkbox]").forEach((c) => { c.checked = a === "tick-all"; }); return; }
    guarded(async () => {
      if (a === "goto") { await saveStep().catch(() => {}); await go(Number(b.dataset.i)); }
      else if (a === "back") { await saveStep().catch(() => {}); await go(prevStepIndex(w.idx)); }
      else if (a === "next") { if (!(await saveStep())) return; if (w.idx === STEPS.length - 1) return finish(); await go(nextStepIndex(w.idx)); }
      else if (a === "skip") {
        for (const f of STEPS[w.idx].fields) await field(f, "skip");
        if (w.idx === STEPS.length - 1) return finish();
        await go(nextStepIndex(w.idx));
      } else if (a === "read-site") {
        const url = root.querySelector("#wz-url").value.trim();
        if (!url) { w.error = "Type your website address first, or skip this step."; return; }
        w.notice = "";
        const r = await post(`/api/sessions/${getSid()}/website`, { url });
        if (r.status === "could_not_read") { w.notice = r.ask; await load(); return; }
        await load(); w.notice = "";
      } else if (a === "confirm") {
        const pick = (kind) => [...root.querySelectorAll(`.wz-found input[data-kind="${kind}"]:checked`)].map((x) => x.value);
        const body = { source: b.dataset.source, colours: pick("colour"), fonts: pick("font"), fact_ids: pick("fact") };
        if (!body.colours.length && !body.fonts.length && !body.fact_ids.length) { w.error = "Tick what you want to use first."; return; }
        w.view = await post(`/api/sessions/${getSid()}/kit/confirm`, body);
        toast("Added to your brand setup.", "ok");
      } else if (a === "save-brand") {
        const name = root.querySelector("#wz-brand-name").value.trim();
        if (!name) { w.error = "Give the brand a name to save it."; return; }
        await saveStep(); w.view = await post(`/api/sessions/${getSid()}/kit/save-brand`, { name }); await load(); toast(`Saved "${name}". You can start from it next time.`, "ok");
      } else if (a === "load-brand") {
        const id = root.querySelector("#wz-saved-brand").value; if (!id) { w.error = "Choose a saved brand first."; return; }
        w.view = await post(`/api/sessions/${getSid()}/kit/load-brand`, { brand_id: id }); toast("Brand loaded. Your answers are filled in where the brand had them.", "ok");
      }
    });
  });
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "wz-logo" && t.files[0]) guarded(async () => {
      const f = t.files[0]; t.value = "";
      const problem = fileProblem(f, "logo"); if (problem) { w.error = problem; return; }
      const before = new Set(getAssets().map((a) => a.asset_id));
      await uploadFiles([f]);
      const added = getAssets().find((a) => !before.has(a.asset_id));
      if (!added) { w.error = "The logo was not accepted. Check the file, or skip the logo."; return; }
      await field("brand.logo", "provide", added.asset_id); w.error = "";
    });
    if (t.id === "wz-guide" && t.files[0]) guarded(async () => {
      const f = t.files[0]; t.value = "";
      const problem = fileProblem(f, "guideline"); if (problem) { w.error = problem; return; }
      const fd = new FormData(); fd.append("file", f, f.name);
      try {
        const r = await api(`/api/sessions/${getSid()}/guideline`, { method: "POST", body: fd });
        w.notice = r.status === "could_not_read" ? r.ask : "";
        await load();
      } catch (er) { w.error = er.message; }
    });
    if (t.id === "wz-files" && t.files.length) guarded(async () => { const files = [...t.files]; t.value = ""; await uploadFiles(files); if (getAssets().length) await field("assets", "provide", getAssets().map((a) => a.asset_id)); });
  });
  root.querySelector("#wz-back").dataset.wz = "back"; root.querySelector("#wz-skip").dataset.wz = "skip"; root.querySelector("#wz-next").dataset.wz = "next";

  return {
    async start() {
      try {
        await load();
        const saved = store.read();
        if (saved?.extra) w.extra = saved.extra;
        const fresh = !w.view.kit.goal.value && !w.view.kit.audience.value;
        if (fresh && saved?.sid !== getSid()) await restore();
        await load();
        w.idx = w.restored ? w.idx : saved?.sid === getSid() ? Math.min(saved.idx ?? 0, STEPS.length - 1) : firstOpenStep(comp());
        render();
      } catch (e) { root.hidden = true; toast(`Guided setup is unavailable: ${e.message}`); }
    },
    reload: async () => { await load(); render(); },
    setCollapsed(v) { w.collapsed = !!v; root.hidden = w.collapsed; },
    isCollapsed: () => w.collapsed,
  };
}
