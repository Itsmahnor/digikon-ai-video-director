import { basename, isAbsolute, relative, resolve } from "node:path";
import { ArtDirection, SceneVisual, STORYBOARD_CAMERA, contrastRatio, type Palette, type SceneAssetRef } from "@digikon/contracts";
import { planLayers, type AssetFileResolver, type AssetLayer, type ResolvedAssetFile } from "./asset-layers.js";
import type { RenderJob } from "./adapter.js";
import { hasInvalidControl, normaliseText, wrapText } from "./text.js";
import { ESTIMATE_METER, type TextMeter } from "./font-metrics.js";
import { describeAttempts, detectOverflow, fitText, fits, layoutAreas, layoutSteps, layoutWindow, stepRect, wrapMeasured, type Areas, type StepsLayout, type WindowLayout } from "./layout.js";

/**
 * The scene-composition template: one scene drawn from a structured visual spec (message thread, product UI demo, process flow, data chart,
 * kinetic type, layered cards, end card), in the film's approved palette, type and motion language.
 *
 * The planner turns the approved spec into plain numbers. It lays text out from the SHORT side of the frame, so a portrait frame is
 * planned as carefully as a landscape one, and it shrinks type to fit before it refuses: a scene is refused only when its text could not be
 * read at the smallest size this template allows. Nothing in the spec reaches a style sheet except as a checked number or a fixed name.
 */

export const COMPOSITION_TEMPLATE = "remotion/scene-composition";
export const COMPOSITION_BADGE_UI = "Concept illustration";
export const COMPOSITION_BADGE_CHART = "Illustrative data";

/** Used when the treatment has no art direction (a project from before it existed). It is a dark neutral set, not a house style. */
export const DEFAULT_PALETTE: Palette = { background: "#0f172a", surface: "#1e293b", text: "#f8fafc", muted: "#94a3b8", accent: "#38bdf8", accent_2: "#a78bfa" };

const CHAR_W = 0.56; // average glyph width as a share of the font size; generous, so text is shrunk before it can clip
const MAX_FPS = 240;
const SPEED = { calm: 1.25, precise: 1, snappy: 0.75, playful: 0.9 } as const;
const SCALE = { compact: 0.85, standard: 1, large: 1.15 } as const;

export interface Box { x: number; y: number; w: number; h: number }

export interface CompositionScene {
  kind: "composition";
  scene_id: string;
  operation_ids: string[];
  from_frame: number;
  frames: number;
  width: number;
  height: number;
  portrait: boolean;
  palette: Palette;
  type: { bold: boolean; upper: boolean };
  motion: { speed: number; easing: "ease_out" | "ease_in_out" | "spring"; feel: string };
  headline: null | { text: string; lines: string[]; font_px: number; box: Box; align: "left" | "center" };
  content: Box;
  /** Block-specific sizes in pixels, chosen by fitting the text. */
  sizes: { body: number; small: number; big: number };
  /** Message bubbles / rows / steps as laid out: the planner's estimate of how many lines each takes. */
  lines: Record<string, string[]>;
  visual: SceneVisual;
  badge: string | null;
  /** The adaptive layout chosen for the blocks that have one (steps, window): the geometry the drawing uses, measured with the font. */
  /** A match cut into this scene: the previous scene's emphasised word, held as that scene ends, then carried into a card title. */
  held: null | { text: string; from_scene: string; card: number; font_px: number; x: number; y: number; bar: Box; hold_frames: number; move_frames: number };
  layout: null | { kind: "steps"; strategy: StepsLayout["strategy"]; steps: StepsLayout } | { kind: "window"; window: WindowLayout };
  /** Uploaded pictures in this scene, back to front. */
  asset_layers: AssetLayer[];
  /** Where an end card's stack of words starts, when a picture sits above it. */
  stack_top: number;
  /** A panel behind the headline when a picture fills the frame, so the text stays legible. */
  headline_scrim: Box | null;
}
export type CompositionPlan = { ok: true; scenes: CompositionScene[]; total_frames: number } | { ok: false; issues: string[] };

export interface CompositionPlanOptions {
  outputRoot: string;
  /** Measures text with the real font. Without it widths are estimated, generously. */
  meter?: TextMeter;
  /** The template being planned for, when another engine lays out a scene with this planner. */
  template?: string;
}

const wrapCount = (text: string, widthPx: number, fontPx: number, upper: boolean) => wrapText(text, Math.max(3, Math.floor(widthPx / (fontPx * CHAR_W * (upper ? 1.12 : 1)))));

/** The largest font size from `max` down to `min` at which every text fits its width within `maxLines` lines. Null when none does. */
export function fitFont(texts: readonly string[], widthPx: number, maxPx: number, minPx: number, maxLines: number, upper = false, maxHeightPx = Infinity): number | null {
  for (let f = Math.floor(maxPx); f >= minPx; f -= 1) if (texts.every((t) => { const n = wrapCount(t, widthPx, f, upper).length; return n <= maxLines && n * f * 1.15 <= maxHeightPx; })) return f;
  return null;
}

/** Layout areas: a headline column beside the picture in landscape, above it in portrait or square. */
export function areas(width: number, height: number, hasHeadline: boolean, variant: "side" | "top" = "side"): Areas {
  return layoutAreas(width, height, hasHeadline, variant);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Plans every scene-composition operation of a job (a job normally carries one scene). Anything it cannot draw as approved is an issue. */
export function planCompositionScenes(job: Omit<RenderJob, "signal">, opts: CompositionPlanOptions): CompositionPlan {
  const issues: string[] = [];
  const s = job.settings;
  const template = opts.template ?? COMPOSITION_TEMPLATE;
  if (s.container !== "mp4" || s.video_codec !== "h264") issues.push(`the remotion adapter writes mp4 with h264, not ${s.container} with ${s.video_codec}`);
  if (s.audio_codec !== null) issues.push("the remotion adapter writes no audio; the settings ask for an audio track");
  if (!(s.fps > 0 && s.fps <= MAX_FPS)) issues.push(`the frame rate ${s.fps} is outside 1 to ${MAX_FPS}`);
  const out = resolve(job.output_path), rel = relative(resolve(opts.outputRoot), out);
  if (rel.startsWith("..") || isAbsolute(rel) || !/^rn_[a-f0-9]{16}\.mp4$/.test(basename(out)) || basename(out) !== basename(job.output_path)) issues.push("the output path is not a render file inside the output folder");
  if (!job.operations.length) issues.push("there are no operations to render");

  const art = job.art_direction ? ArtDirection.safeParse(job.art_direction) : null;
  if (art && !art.success) issues.push(`the art direction is not valid: ${art.error.issues.map((i) => i.message).slice(0, 2).join("; ")}`);
  const direction = art?.success ? art.data : null;
  const palette = direction?.palette ?? DEFAULT_PALETTE;
  const half = 0.5 / s.fps;

  const byScene = new Map<string, typeof job.operations>();
  for (const op of job.operations) byScene.set(op.target_scene_id, [...(byScene.get(op.target_scene_id) ?? []), op]);
  const ordered = [...byScene.entries()].sort((a, b) => Math.min(...a[1].map((o) => o.timing.start_s)) - Math.min(...b[1].map((o) => o.timing.start_s)));
  const scenes: CompositionScene[] = [];
  let cursor = 0, cursorFrame = 0;

  for (const [sceneId, ops] of ordered) {
    const before = issues.length;
    const at = `scene ${sceneId}`;
    for (const o of ops) {
      if (job.templates[o.operation_id] !== template) issues.push(`operation ${o.operation_id}: ${job.templates[o.operation_id] ?? "(none)"} cannot be combined with ${template} in one scene`);
      else if (o.operation_type !== "render_graphics_scene") issues.push(`operation ${o.operation_id}: ${COMPOSITION_TEMPLATE} implements render_graphics_scene operations, not ${o.operation_type}`);
      if (o.audio_cues.length) issues.push(`operation ${o.operation_id}: audio cues cannot be produced and are not dropped silently`);
      if (Object.keys(o.parameters).length) issues.push(`operation ${o.operation_id}: ${COMPOSITION_TEMPLATE} takes no parameters; the scene's approved visual spec carries them`);
    }
    if (ops.length > 1) issues.push(`${at}: it has ${ops.length} composition operations; one is supported per scene`);
    const start_s = ops[0]!.timing.start_s, duration_s = ops[0]!.timing.duration_s;
    const frames = Math.round(duration_s * s.fps);
    if (frames < 1 || Math.abs(frames / s.fps - duration_s) > 1e-6) issues.push(`${at}: ${duration_s}s is not a whole number of frames at ${s.fps} fps`);
    if (Math.abs(start_s - cursor) > half) issues.push(`${at}: starts at ${start_s}s but the previous scene ends at ${cursor}s (gaps and overlaps are not rendered)`);
    cursor = start_s + duration_s;

    const info = job.scene_visuals?.[sceneId];
    const parsed = info ? SceneVisual.safeParse(info.visual) : null;
    if (!info || !parsed) { issues.push(`${at}: it has no approved visual spec, so there is nothing to draw`); cursorFrame += frames; continue; }
    if (!parsed.success) { issues.push(`${at}: its visual spec is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 2).join("; ")}`); cursorFrame += frames; continue; }
    const visual = parsed.data;
    const raw = info.overlay_text;
    const text = typeof raw === "string" ? normaliseText(raw) : null;
    if (text !== null && (!text.trim() || text.length > 120 || hasInvalidControl(text))) issues.push(`${at}: the overlay text is empty, longer than 120 characters or contains control characters`);
    const headlineText = text && text.trim() && text.length <= 120 && !hasInvalidControl(text) ? text : null;
    if (visual.block === "kinetic_type" && !headlineText) issues.push(`${at}: kinetic type animates the scene's overlay text, and there is none`);
    // the template carries the approved camera motion itself; one that it cannot draw is reported, not dropped
    // (checked against the storyboard by the coverage check, which reads `drawn_camera`)

    const upper = direction?.typography.case === "upper";
    const bold = direction?.typography.weight !== "regular";
    const scaleMult = SCALE[direction?.typography.scale ?? "standard"];
    const portrait = s.height >= s.width;
    const short = Math.min(s.width, s.height);
    const style = { upper, bold };
    const meter = opts.meter ?? ESTIMATE_METER;
    /** The largest size from `maxPx` to `minPx` at which every text wraps within the width, the line count and the height. Null when none does. */
    const fitPx = (texts: readonly string[], widthPx: number, maxPx: number, minPxFloor: number, maxLines: number, maxH = Infinity): number | null => {
      const r = fitText({ texts, meter, style, maxW: widthPx, maxPx, minPx: minPxFloor, maxLines, maxH, lineHeight: 1.15, breakWords: true });
      return fits(r) ? r.px : null;
    };
    const wrapAt = (text: string, widthPx: number, px: number): string[] => wrapMeasured(text, meter, px, widthPx, style, true).lines;
    const hasHeadlineArea = !!headlineText && visual.block !== "kinetic_type" && visual.block !== "end_card";
    const placed = job.scene_assets?.[sceneId];
    // a wide picture gets the width of the frame and the headline goes above it: a screen beside a text column is too small to read
    const stageTop = visual.block === "asset_stage" && hasHeadlineArea && s.width > s.height && !!placed?.refs.some((r) => { const f = placed.files[r.asset_id]; return r.role !== "logo" && r.placement !== "full_frame" && !!f && f.width / f.height >= 1.3; });
    const ar = areas(s.width, s.height, hasHeadlineArea, stageTop ? "top" : "side");
    const lines: Record<string, string[]> = {};
    let headline: CompositionScene["headline"] = null;
    let layout: CompositionScene["layout"] = null;
    let held: CompositionScene["held"] = null;
    const minPx = Math.round(short * 0.034);
    const sizes = { body: Math.round(short * 0.042 * scaleMult), small: Math.round(short * 0.026), big: Math.round(short * 0.1 * scaleMult) };
    let box = ar.content;

    /** Fits the headline into an area's headline box: the headline, or why it does not fit. */
    const placeHeadline = (a: Areas): { headline: CompositionScene["headline"]; issue: string | null } => {
      if (!headlineText || !a.headline) return { headline: null, issue: null };
      const hb = a.headline;
      const f = fitPx([headlineText], hb.w, Math.round(short * (a.wide && a.variant === "side" ? 0.085 : 0.075) * scaleMult), minPx, a.wide && a.variant === "side" ? 6 : 3, hb.h * 0.85);
      if (f === null) return { headline: null, issue: `${at}: the headline "${headlineText.length > 30 ? `${headlineText.slice(0, 29)}...` : headlineText}" does not fit its area at a legible size` };
      const ls = wrapAt(headlineText, hb.w, f);
      if (ls.length * f * 1.15 > hb.h) return { headline: null, issue: `${at}: the headline needs ${Math.round(ls.length * f * 1.15)}px of height and the area has ${hb.h}px` };
      return { headline: { text: headlineText, lines: ls, font_px: f, box: hb, align: "left" }, issue: null };
    };
    /** A headline band above the picture is only as tall as its text needs; the rest of the height goes to the picture. */
    const tighten = (a: Areas, h: CompositionScene["headline"]): Areas => {
      if (!h || a.variant !== "top" || !a.headline) return a;
      const used = Math.min(a.headline.h, Math.ceil(h.font_px * 0.6 + h.lines.length * h.font_px * 1.15));
      const gap = Math.round(Math.min(s.width, s.height) * 0.07 * 0.6), top = a.headline.y;
      return { ...a, headline: { ...a.headline, h: used }, content: { x: a.content.x, y: top + used + gap, w: a.content.w, h: s.height - Math.round(Math.min(s.width, s.height) * 0.07) - (top + used + gap) } };
    };
    const adaptive = visual.block === "ui_demo" || visual.block === "process_flow" || visual.block === "message_thread";
    // a wide frame may put the headline in a band above the picture when that is what lets the picture be legible
    const variants: ("side" | "top")[] = ar.wide && hasHeadlineArea ? ["side", "top"] : ["side"];
    if (!adaptive) {
      const h = placeHeadline(ar);
      if (h.issue) issues.push(h.issue); else headline = h.headline;
      if (stageTop) box = tighten(ar, headline).content;
    }
    switch (visual.block) {
      case "message_thread": {
        // the largest legible type at which the whole thread fits: bubbles may take up to three lines and a wider share of the area, and a wide frame may
        // put the headline in a band above the thread; the thread is never drawn smaller than the legibility floor and never clipped
        const mult = visual.mode === "pile_up" ? 0.7 : 1;
        type Cand = { a: Areas; h: CompositionScene["headline"]; f: number; lines: Record<string, string[]>; tight: boolean };
        const cands: Cand[] = [], notes: string[] = [];
        for (const v of variants) {
          const a0 = areas(s.width, s.height, hasHeadlineArea, v), h = placeHeadline(a0), a = tighten(a0, h.headline);
          if (h.issue) { notes.push(`${v} area: ${h.issue.replace(`${at}: `, "")}`); continue; }
          let last = "";
          search: for (let f = Math.round(short * 0.054 * scaleMult); f >= minPx; f--) {
            for (const [share, tight] of [[0.72, false], [0.78, false], [0.78, true]] as const) {
              const ls: Record<string, string[]> = {};
              visual.messages.forEach((m, i) => { ls[`m${i}`] = wrapAt(m.text, a.content.w * share, f); });
              const need = visual.messages.reduce((acc, _m, i) => acc + ls[`m${i}`]!.length * f * (tight ? 1.15 : 1.25) + f * (tight ? 0.8 : 1.1), 0) * mult;
              if (visual.messages.some((_m, i) => ls[`m${i}`]!.length > 3)) { last = `a message needs more than 3 lines at ${f}px`; continue; }
              if (need <= a.content.h * 0.9) { cands.push({ a, h: a.headline && h.headline ? { ...h.headline, box: a.headline } : h.headline, f, lines: ls, tight }); break search; }
              last = `the ${visual.messages.length} messages need ${Math.round(need)}px of height at ${f}px and the area has ${Math.round(a.content.h * 0.9)}px usable`;
            }
          }
          if (!cands.some((c) => c.a === a)) notes.push(`${v} area (${a.content.w}x${a.content.h}px): ${last}`);
        }
        const best = cands.sort((x, y) => y.f - x.f)[0];
        if (!best) { issues.push(`${at}: the thread cannot be laid out at a legible size (minimum ${minPx}px) in a ${s.width}x${s.height} frame: ${notes.join(" | ")}`); break; }
        box = best.a.content; headline = best.h; sizes.body = best.f;
        Object.assign(lines, best.lines);
        lines["tight"] = [best.tight ? "1" : "0"];
        // measured width of each bubble's widest line, so the drawing does not have to guess it
        visual.messages.forEach((_m, i) => { lines[`w${i}`] = [String(Math.max(...best.lines[`m${i}`]!.map((l) => meter.width(l, best.f, style))))]; });
        break;
      }
      case "ui_demo": {
        type Cand = { a: Areas; h: CompositionScene["headline"]; w: WindowLayout };
        const cands: Cand[] = [], notes: string[] = [];
        for (const v of variants) {
          const a0 = areas(s.width, s.height, hasHeadlineArea, v), h = placeHeadline(a0), a = tighten(a0, h.headline);
          if (h.issue) { notes.push(`${v} area: ${h.issue.replace(`${at}: `, "")}`); continue; }
          // the picture is labelled "Concept illustration" along the bottom of its area; that strip is kept clear
          const wbox = { ...a.content, h: a.content.h - Math.round(sizes.small * 1.9) };
          const r = layoutWindow({ title: visual.window_title, sidebar: visual.sidebar, rows: visual.rows, confirm: visual.confirm_text, box: wbox, meter, style, maxPx: sizes.body, minPx, minSmallPx: Math.round(short * 0.022), maxSmallPx: sizes.small });
          if (r.ok) cands.push({ a, h: a.headline && h.headline ? { ...h.headline, box: a.headline } : h.headline, w: r.layout }); else notes.push(`${v} area (${a.content.w}x${a.content.h}px): ${describeAttempts(r.attempts)}`);
        }
        const best = cands.sort((x, y) => y.w.font_px - x.w.font_px)[0];
        if (!best) { issues.push(`${at}: the window (${visual.rows.length} rows) cannot be laid out at a legible size (minimum ${minPx}px) in a ${s.width}x${s.height} frame: ${notes.join(" | ")}`); break; }
        const over = detectOverflow(best.w.placed, best.a.content, { overlapOk: (p, q) => p === "the window" || q === "the window" });
        if (over.length) { issues.push(`${at}: the window layout is not clean: ${over.join("; ")}`); break; }
        box = best.a.content; headline = best.h; layout = { kind: "window", window: best.w };
        sizes.body = best.w.font_px; sizes.small = best.w.small_px;
        break;
      }
      case "process_flow": {
        type Cand = { a: Areas; h: CompositionScene["headline"]; l: StepsLayout };
        const cands: Cand[] = [], notes: string[] = [];
        for (const v of variants) {
          const a0 = areas(s.width, s.height, hasHeadlineArea, v), h = placeHeadline(a0), a = tighten(a0, h.headline);
          if (h.issue) { notes.push(`${v} area: ${h.issue.replace(`${at}: `, "")}`); continue; }
          const r = layoutSteps({ steps: visual.steps, box: a.content, meter, style, maxPx: sizes.body, minPx, minDetailPx: Math.round(short * 0.022), maxDetailPx: sizes.small, durationS: duration_s });
          if (r.ok) cands.push({ a, h: a.headline && h.headline ? { ...h.headline, box: a.headline } : h.headline, l: r.layout }); else notes.push(`${v} area (${a.content.w}x${a.content.h}px): ${describeAttempts(r.attempts)}`);
        }
        // all steps on one page beat pages; then the larger type; then the plainer reading order
        const best = cands.sort((x, y) => Number(x.l.strategy === "pages") - Number(y.l.strategy === "pages") || y.l.font_px - x.l.font_px)[0];
        if (!best) { issues.push(`${at}: the ${visual.steps.length} steps cannot be laid out at a legible size (minimum ${minPx}px) in a ${s.width}x${s.height} frame, even in pages: ${notes.join(" | ")}`); break; }
        const rects = (best.l.pages.flat()).map((i) => ({ name: `step ${i + 1}`, rect: stepRect(best.l, i) }));
        const perPage = best.l.pages.map((p) => p.map((i) => ({ name: `step ${i + 1}`, rect: stepRect(best.l, i) })));
        const over = (best.l.strategy === "pages" ? perPage : [rects]).flatMap((pg) => detectOverflow(pg, best.a.content));
        if (over.length) { issues.push(`${at}: the steps layout is not clean: ${over.join("; ")}`); break; }
        box = best.a.content; headline = best.h; layout = { kind: "steps", strategy: best.l.strategy, steps: best.l };
        sizes.body = best.l.font_px; sizes.small = best.l.detail_px;
        break;
      }
      case "data_chart": {
        const n = visual.points.length;
        const f = fitPx(visual.points.map((p) => p.label), box.w / n - sizes.small * 0.4, sizes.small * 1.15, Math.round(short * 0.022), 1);
        if (f === null) { issues.push(`${at}: a chart label does not fit under its bar at a legible size`); break; }
        sizes.small = f;
        const t = fitPx([visual.title], box.w, sizes.body, minPx, 2);
        if (t === null) { issues.push(`${at}: the chart title does not fit at a legible size`); break; }
        sizes.body = t;
        lines["title"] = wrapAt(visual.title, box.w, t);
        break;
      }
      case "kinetic_type": {
        if (!headlineText) break;
        const m = Math.round(short * 0.07);
        const bw = s.width - 2 * m;
        const f = fitPx([headlineText], bw * 0.9, Math.round(short * (portrait ? 0.13 : 0.15) * scaleMult), minPx, portrait ? 7 : 4);
        if (f === null) { issues.push(`${at}: the text does not fit at a legible size`); break; }
        const ls = wrapAt(headlineText, bw * 0.9, f);
        if (ls.length * f * 1.12 > s.height - 2 * m) { issues.push(`${at}: the text needs more height than the frame has`); break; }
        sizes.big = f;
        box = { x: m, y: m, w: bw, h: s.height - 2 * m };
        headline = { text: headlineText, lines: ls, font_px: f, box, align: "left" };
        if (visual.emphasis_word !== null && visual.emphasis_word >= headlineText.split(/\s+/).filter(Boolean).length) issues.push(`${at}: emphasis_word ${visual.emphasis_word} is not a word of the text`);
        break;
      }
      case "layered_cards": {
        const f = fitPx(visual.cards.flatMap((c) => [c.title, ...(c.detail ? [c.detail] : [])]), box.w * 0.62 - sizes.body, sizes.body, minPx, 2);
        if (f === null) { issues.push(`${at}: a card does not fit at a legible size`); break; }
        sizes.body = f;
        if (visual.held) {
          const hd = visual.held, src = job.scene_visuals?.[hd.from_scene];
          const sv = src ? SceneVisual.safeParse(src.visual) : null;
          if (!src || !sv?.success || sv.data.block !== "kinetic_type" || typeof src.overlay_text !== "string") { issues.push(`${at}: it holds a word from ${hd.from_scene}, which has no kinetic type text to hold`); break; }
          if (frames < Math.round((0.3 + 0.8 + 1) * s.fps)) { issues.push(`${at}: ${duration_s}s is too short to hold a word, carry it into its card and show the scene (at least 2.1s)`); break; }
          // the previous scene's headline, laid out exactly as that scene lays it out, so the held word is where that scene left it
          const text = normaliseText(src.overlay_text), m = Math.round(short * 0.07), bw = s.width - 2 * m;
          const kf = fitPx([text], bw * 0.9, Math.round(short * (portrait ? 0.13 : 0.15) * scaleMult), minPx, portrait ? 7 : 4);
          if (kf === null) { issues.push(`${at}: the text of ${hd.from_scene} does not fit, so its word cannot be held`); break; }
          const ls = wrapAt(text, bw * 0.9, kf), blockH = ls.length * kf * 1.12, top = m + (s.height - 2 * m - blockH) / 2;
          const hits: { r: number; x: number; w: string }[] = [];
          let wi = 0;
          ls.forEach((l, r) => { let x = m + kf * 0.4; for (const w of l.split(" ")) { if (wi === hd.word_index) hits.push({ r, x, w }); x += meter.width(w, kf, style) + kf * 0.28; wi++; } });
          const word = hits[0];
          const norm = (t: string) => t.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
          if (!word) { issues.push(`${at}: word ${hd.word_index} does not exist in the text of ${hd.from_scene}`); break; }
          if (norm(word.w) !== norm(visual.cards[hd.card]?.title ?? "")) { issues.push(`${at}: word ${hd.word_index} of ${hd.from_scene} is "${word.w}", which is not the title of card ${hd.card}`); break; }
          held = { text: word.w, from_scene: hd.from_scene, card: hd.card, font_px: kf, x: word.x, y: top + word.r * kf * 1.12, bar: { x: m, y: top, w: Math.max(4, kf * 0.1), h: blockH }, hold_frames: Math.round(0.3 * s.fps), move_frames: Math.round(0.8 * s.fps) };
        }
        break;
      }
      case "asset_stage":
        // the pictures are the scene: they are laid out below, in the area the headline leaves
        break;
      case "end_card": {
        const m = Math.round(short * 0.07), bw = s.width - 2 * m;
        const f = headlineText ? fitPx([headlineText], bw * 0.9, Math.round(short * (portrait ? 0.1 : 0.115) * scaleMult), minPx, portrait ? 4 : 3) : sizes.big;
        if (f === null) { issues.push(`${at}: the headline does not fit at a legible size`); break; }
        sizes.big = f;
        const bf = fitPx([visual.button], bw * 0.6 - sizes.body * 2, sizes.body, minPx, 1);
        if (bf === null) { issues.push(`${at}: the button label does not fit on one line`); break; }
        sizes.body = bf;
        if (visual.subline && fitPx([visual.subline], bw, sizes.small, Math.round(short * 0.022), 2) === null) issues.push(`${at}: the subline does not fit`);
        box = { x: m, y: m, w: bw, h: s.height - 2 * m };
        if (headlineText) headline = { text: headlineText, lines: wrapAt(headlineText, bw * 0.9, f), font_px: f, box, align: "center" };
        break;
      }
    }

    // colour and legibility of what is drawn, from the palette itself
    if (contrastRatio(palette.text, palette.background) < 4.5) issues.push(`${at}: the palette's text colour is not legible on its background`);

    if (visual.block === "asset_stage" && !placed?.refs.length) issues.push(`${at}: asset_stage has no pictures to show`);
    const stage = visual.block === "asset_stage" ? box : { x: Math.round(short * 0.05), y: Math.round(short * 0.05), w: s.width - 2 * Math.round(short * 0.05), h: s.height - 2 * Math.round(short * 0.05) };
    // what a corner picture must keep clear of: the words, wherever this block puts them. An end card moves its words down to make room under a picture at the top.
    const keepClear: Box[] = visual.block !== "asset_stage" && visual.block !== "end_card" && headline ? [headline.box] : [];
    const planned = placed ? planLayers(placed.refs, placed.files, { width: s.width, height: s.height, fps: s.fps, frames, region: stage, background: palette.background, overlay: visual.block !== "asset_stage", motionSpeed: SPEED[direction?.motion_language.feel ?? "precise"], keepClear }) : { layers: [], issues: [] };
    for (const m of planned.issues) issues.push(`${at}: ${m}`);
    let stack_top = 0;
    if (visual.block === "end_card" && planned.layers.length) {
      const f = headline?.font_px ?? sizes.big, b = sizes.body, sm = sizes.small;
      const stack = (headline ? headline.lines.length * f * 1.12 : 0) + f * 0.7 + b * 2.7 + (visual.wordmark ? sm * 1.4 + f * 0.5 : 0) + (visual.subline ? b * 0.9 + sm * 2.8 : 0);
      const gap = Math.round(short * 0.05);
      stack_top = Math.ceil(Math.max(...planned.layers.filter((l) => l.clip.y + l.clip.h / 2 < s.height / 2).map((l) => (l.plate ? l.plate.box.y + l.plate.box.h : l.clip.y + l.clip.h)), 0)) + gap;
      if (stack_top <= gap) stack_top = 0;
      const box2 = { x: 0, y: stack_top + (s.height - stack_top - stack) / 2, w: s.width, h: stack };
      if (stack > s.height - stack_top - gap) issues.push(`${at}: the end card's text does not fit under its picture; make the picture smaller`);
      else if (planned.layers.some((l) => l.clip.y + l.clip.h / 2 >= s.height / 2 && l.clip.y < box2.y + box2.h && box2.y < l.clip.y + l.clip.h && l.clip.x < s.width * 0.75 && l.clip.x + l.clip.w > s.width * 0.25)) issues.push(`${at}: a picture would cover the end card's text; put it in a corner or along the top`);
    }

    if (issues.length === before) {
      const motion = { speed: SPEED[direction?.motion_language.feel ?? "precise"], easing: direction?.motion_language.easing ?? "ease_out", feel: direction?.motion_language.feel ?? "precise" } as const;
      scenes.push({
        kind: "composition", scene_id: sceneId, operation_ids: ops.map((o) => o.operation_id), from_frame: cursorFrame, frames, width: s.width, height: s.height, portrait, palette,
        type: { bold, upper }, motion: { ...motion }, headline, content: box, sizes, lines, visual, layout, held, asset_layers: planned.layers, stack_top, headline_scrim: headline && planned.layers.some((l) => l.clip.w >= s.width * 0.9 && l.clip.h >= s.height * 0.9) ? { x: headline.box.x - Math.round(short * 0.03), y: headline.box.y - Math.round(short * 0.03), w: headline.box.w + Math.round(short * 0.06), h: Math.ceil(headline.lines.length * headline.font_px * 1.3 + short * 0.06) } : null,
        badge: visual.block === "ui_demo" ? COMPOSITION_BADGE_UI : visual.block === "data_chart" ? COMPOSITION_BADGE_CHART : null,
      });
    }
    cursorFrame += frames;
  }
  if (Math.abs(cursor - s.duration_s) > half) issues.push(`the scenes end at ${cursor}s but the settings say ${s.duration_s}s`);
  if (issues.length) return { ok: false, issues };
  return { ok: true, scenes, total_frames: cursorFrame };
}

/** The storyboard camera motion the drawn composition carries out, for the coverage check. */
export const drawnCameraMotion = (v: SceneVisual): string => STORYBOARD_CAMERA[v.camera];

export const numberOrNull = num;

/** The approved visual specs and art direction of a handoff, in the form a render job carries them. Only scenes that have a spec appear. */
export function jobVisuals(h: { storyboard: { scenes: readonly { scene_id: string; visual: unknown; visual_purpose: string | null; overlay: { text: string } | null; asset_refs?: readonly SceneAssetRef[] }[] }; treatment: { art_direction: unknown } }, resolve?: AssetFileResolver): Pick<RenderJob, "scene_visuals" | "art_direction" | "scene_assets"> {
  const scene_visuals: NonNullable<RenderJob["scene_visuals"]> = {};
  for (const s of h.storyboard.scenes) if (s.visual) scene_visuals[s.scene_id] = { visual: s.visual, overlay_text: s.overlay?.text ?? null, visual_purpose: s.visual_purpose };
  const scene_assets: NonNullable<RenderJob["scene_assets"]> = {};
  for (const s of h.storyboard.scenes) {
    if (!s.asset_refs?.length) continue;
    const files: Record<string, ResolvedAssetFile> = {};
    for (const r of s.asset_refs) { const f = resolve?.(r.asset_id, r.role); if (f) files[r.asset_id] = f; }
    scene_assets[s.scene_id] = { refs: [...s.asset_refs], files };
  }
  return { scene_visuals, art_direction: h.treatment.art_direction ?? null, scene_assets };
}


