import { basename, isAbsolute, relative, resolve } from "node:path";
import { ArtDirection, SceneVisual, STORYBOARD_CAMERA, contrastRatio, type Palette } from "@digikon/contracts";
import type { RenderJob } from "./adapter.js";
import { hasInvalidControl, normaliseText, wrapText } from "./text.js";

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
}
export type CompositionPlan = { ok: true; scenes: CompositionScene[]; total_frames: number } | { ok: false; issues: string[] };

export interface CompositionPlanOptions { outputRoot: string }

const wrapCount = (text: string, widthPx: number, fontPx: number, upper: boolean) => wrapText(text, Math.max(3, Math.floor(widthPx / (fontPx * CHAR_W * (upper ? 1.12 : 1)))));

/** The largest font size from `max` down to `min` at which every text fits its width within `maxLines` lines. Null when none does. */
export function fitFont(texts: readonly string[], widthPx: number, maxPx: number, minPx: number, maxLines: number, upper = false, maxHeightPx = Infinity): number | null {
  for (let f = Math.floor(maxPx); f >= minPx; f -= 1) if (texts.every((t) => { const n = wrapCount(t, widthPx, f, upper).length; return n <= maxLines && n * f * 1.15 <= maxHeightPx; })) return f;
  return null;
}

/** Layout areas: a headline column beside the picture in landscape, above it in portrait or square. */
export function areas(width: number, height: number, hasHeadline: boolean): { headline: Box | null; content: Box; portrait: boolean; wide: boolean } {
  const portrait = height >= width, wide = width / height >= 1.5;
  const m = Math.round(Math.min(width, height) * 0.07);
  if (!hasHeadline) return { headline: null, content: { x: wide ? Math.round(width * 0.14) : m, y: m, w: wide ? Math.round(width * 0.72) : width - 2 * m, h: height - 2 * m }, portrait, wide };
  if (wide) return { headline: { x: m, y: m, w: Math.round(width * 0.34), h: height - 2 * m }, content: { x: Math.round(width * 0.44), y: m, w: Math.round(width * 0.5), h: height - 2 * m }, portrait, wide };
  const hh = Math.round(height * (portrait ? 0.2 : 0.24));
  return { headline: { x: m, y: m, w: width - 2 * m, h: hh }, content: { x: m, y: m + hh + Math.round(m * 0.6), w: width - 2 * m, h: height - 2 * m - hh - Math.round(m * 0.6) }, portrait, wide };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Plans every scene-composition operation of a job (a job normally carries one scene). Anything it cannot draw as approved is an issue. */
export function planCompositionScenes(job: Omit<RenderJob, "signal">, opts: CompositionPlanOptions): CompositionPlan {
  const issues: string[] = [];
  const s = job.settings;
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
      if (job.templates[o.operation_id] !== COMPOSITION_TEMPLATE) issues.push(`operation ${o.operation_id}: ${job.templates[o.operation_id] ?? "(none)"} cannot be combined with ${COMPOSITION_TEMPLATE} in one scene`);
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
    const ar = areas(s.width, s.height, !!headlineText && visual.block !== "kinetic_type" && visual.block !== "end_card");
    const lines: Record<string, string[]> = {};
    let headline: CompositionScene["headline"] = null;
    const minPx = Math.round(short * 0.034);
    const sizes = { body: Math.round(short * 0.042 * scaleMult), small: Math.round(short * 0.026), big: Math.round(short * 0.1 * scaleMult) };
    let box = ar.content;

    if (headlineText && ar.headline) {
      const hb = ar.headline;
      const maxLines = ar.wide ? 6 : 3;
      const f = fitFont([headlineText], hb.w, Math.round(short * (ar.wide ? 0.085 : 0.075) * scaleMult), minPx, maxLines, upper, hb.h * 0.85);
      if (f === null) issues.push(`${at}: the headline "${headlineText.length > 30 ? `${headlineText.slice(0, 29)}â€¦` : headlineText}" does not fit its area at a legible size`);
      else {
        const ls = wrapCount(headlineText, hb.w, f, upper);
        if (ls.length * f * 1.15 > hb.h) issues.push(`${at}: the headline needs ${Math.round(ls.length * f * 1.15)}px of height and the area has ${hb.h}px`);
        headline = { text: headlineText, lines: ls, font_px: f, box: hb, align: "left" };
      }
    }

    switch (visual.block) {
      case "message_thread": {
        const texts = visual.messages.map((m) => m.text);
        const f = fitFont(texts, box.w * 0.72, Math.round(short * 0.054 * scaleMult), minPx, 2, upper);
        if (f === null) { issues.push(`${at}: a message does not fit a bubble at a legible size`); break; }
        sizes.body = f;
        visual.messages.forEach((m, i) => { lines[`m${i}`] = wrapCount(m.text, box.w * 0.72, f, upper); });
        const need = visual.messages.reduce((a, _m, i) => a + lines[`m${i}`]!.length * f * 1.25 + f * 1.1, 0) * (visual.mode === "pile_up" ? 0.7 : 1);
        if (need > box.h) issues.push(`${at}: the messages need ${Math.round(need)}px of height and the area has ${box.h}px`);
        break;
      }
      case "ui_demo": {
        const labelW = box.w * (visual.sidebar.length ? 0.4 : 0.55);
        const f = fitFont([...visual.rows.map((r) => r.label), visual.window_title, ...(visual.confirm_text ? [visual.confirm_text] : [])], labelW, sizes.body, minPx, 1, upper);
        if (f === null) { issues.push(`${at}: a row label or the window title does not fit on one line at a legible size`); break; }
        sizes.body = f;
        const side = fitFont(visual.sidebar, box.w * 0.2, sizes.small, Math.round(short * 0.022), 1, upper);
        if (visual.sidebar.length && side === null) { issues.push(`${at}: a sidebar item does not fit at a legible size`); break; }
        if (side) sizes.small = side;
        const need = f * 2 + visual.rows.length * f * 2.1 + f * 3;
        if (need > box.h) issues.push(`${at}: the window needs ${Math.round(need)}px of height and the area has ${box.h}px`);
        break;
      }
      case "process_flow": {
        const horizontal = box.w / box.h > 1.15;
        const n = visual.steps.length;
        const nodeW = horizontal ? (box.w - (n - 1) * box.w * 0.06) / n : box.w * 0.84;
        const f = fitFont([...visual.steps.map((st) => st.label), ...visual.steps.flatMap((st) => (st.detail ? [st.detail] : []))], nodeW - sizes.body * 1.4, sizes.body, minPx, horizontal ? 3 : 2, upper);
        if (f === null) { issues.push(`${at}: a step does not fit its node at a legible size`); break; }
        sizes.body = f;
        const nodeH = horizontal ? f * 6.2 : (box.h - (n - 1) * box.h * 0.07) / n;
        if (!horizontal && nodeH < f * 2.6) issues.push(`${at}: ${n} steps do not fit the height at a legible size`);
        break;
      }
      case "data_chart": {
        const n = visual.points.length;
        const f = fitFont(visual.points.map((p) => p.label), box.w / n - sizes.small * 0.4, sizes.small * 1.15, Math.round(short * 0.022), 1, upper);
        if (f === null) { issues.push(`${at}: a chart label does not fit under its bar at a legible size`); break; }
        sizes.small = f;
        const t = fitFont([visual.title], box.w, sizes.body, minPx, 2, upper);
        if (t === null) { issues.push(`${at}: the chart title does not fit at a legible size`); break; }
        sizes.body = t;
        lines["title"] = wrapCount(visual.title, box.w, t, upper);
        break;
      }
      case "kinetic_type": {
        if (!headlineText) break;
        const m = Math.round(short * 0.07);
        const bw = s.width - 2 * m;
        const f = fitFont([headlineText], bw * 0.9, Math.round(short * (portrait ? 0.13 : 0.15) * scaleMult), minPx, portrait ? 7 : 4, upper);
        if (f === null) { issues.push(`${at}: the text does not fit at a legible size`); break; }
        const ls = wrapCount(headlineText, bw * 0.9, f, upper);
        if (ls.length * f * 1.12 > s.height - 2 * m) { issues.push(`${at}: the text needs more height than the frame has`); break; }
        sizes.big = f;
        box = { x: m, y: m, w: bw, h: s.height - 2 * m };
        headline = { text: headlineText, lines: ls, font_px: f, box, align: "left" };
        if (visual.emphasis_word !== null && visual.emphasis_word >= headlineText.split(/\s+/).filter(Boolean).length) issues.push(`${at}: emphasis_word ${visual.emphasis_word} is not a word of the text`);
        break;
      }
      case "layered_cards": {
        const f = fitFont(visual.cards.flatMap((c) => [c.title, ...(c.detail ? [c.detail] : [])]), box.w * 0.62 - sizes.body, sizes.body, minPx, 2, upper);
        if (f === null) { issues.push(`${at}: a card does not fit at a legible size`); break; }
        sizes.body = f;
        break;
      }
      case "end_card": {
        const m = Math.round(short * 0.07), bw = s.width - 2 * m;
        const f = headlineText ? fitFont([headlineText], bw * 0.9, Math.round(short * (portrait ? 0.1 : 0.115) * scaleMult), minPx, portrait ? 4 : 3, upper) : sizes.big;
        if (f === null) { issues.push(`${at}: the headline does not fit at a legible size`); break; }
        sizes.big = f;
        const bf = fitFont([visual.button], bw * 0.6 - sizes.body * 2, sizes.body, minPx, 1, upper);
        if (bf === null) { issues.push(`${at}: the button label does not fit on one line`); break; }
        sizes.body = bf;
        if (visual.subline && fitFont([visual.subline], bw, sizes.small, Math.round(short * 0.022), 2, upper) === null) issues.push(`${at}: the subline does not fit`);
        box = { x: m, y: m, w: bw, h: s.height - 2 * m };
        if (headlineText) headline = { text: headlineText, lines: wrapCount(headlineText, bw * 0.9, f, upper), font_px: f, box, align: "center" };
        break;
      }
    }

    // colour and legibility of what is drawn, from the palette itself
    if (contrastRatio(palette.text, palette.background) < 4.5) issues.push(`${at}: the palette's text colour is not legible on its background`);

    if (issues.length === before) {
      const motion = { speed: SPEED[direction?.motion_language.feel ?? "precise"], easing: direction?.motion_language.easing ?? "ease_out", feel: direction?.motion_language.feel ?? "precise" } as const;
      scenes.push({
        kind: "composition", scene_id: sceneId, operation_ids: ops.map((o) => o.operation_id), from_frame: cursorFrame, frames, width: s.width, height: s.height, portrait, palette,
        type: { bold, upper }, motion: { ...motion }, headline, content: box, sizes, lines, visual,
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
export function jobVisuals(h: { storyboard: { scenes: readonly { scene_id: string; visual: unknown; visual_purpose: string | null; overlay: { text: string } | null }[] }; treatment: { art_direction: unknown } }): Pick<RenderJob, "scene_visuals" | "art_direction"> {
  const scene_visuals: NonNullable<RenderJob["scene_visuals"]> = {};
  for (const s of h.storyboard.scenes) if (s.visual) scene_visuals[s.scene_id] = { visual: s.visual, overlay_text: s.overlay?.text ?? null, visual_purpose: s.visual_purpose };
  return { scene_visuals, art_direction: h.treatment.art_direction ?? null };
}


