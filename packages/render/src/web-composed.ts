import { statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { RenderJob } from "./adapter.js";
import { hasInvalidControl, normaliseText } from "./text.js";
import { WEB_ACCENTS, WEB_BACKGROUNDS, wrapLines } from "./web-scenes.js";

/**
 * Composed scenes: one scene made of several approved operations (a camera move on a supplied image, an animated text entrance, an end card).
 * The planner groups a job's operations by scene, checks that the combination is one that has been validated, and turns it into plain numbers
 * (frames, scales, offsets) for the renderer's composition. Nothing in a parameter reaches a style sheet or a prop except as a checked number
 * or a name from a fixed list. A combination that has not been validated is an issue, never an approximation.
 */

export type ComposedFamily = "camera_move" | "text_motion" | "end_card" | "logo_reveal";
export type ComposedOpType = "trim_clip" | "overlay_text" | "render_graphics_scene";

/** What a learned Remotion template is, from its validated registry record. */
export interface ComposedTemplate {
  template: string;
  family: ComposedFamily;
  type: ComposedOpType;
  /** The family's constants: `motion` for a camera move (zoom_in, zoom_out, pan) or a text motion (fade_up, stagger). */
  motion: string;
}

export type Move =
  | { kind: "zoom"; from: number; to: number; easing: "linear" | "ease_in_out" }
  | { kind: "pan"; scale: number; dx0: number; dx1: number; dy0: number; dy1: number; easing: "linear" }
  /** A fast zoom that lands on a key moment: 1 to `to` over `zoom_frames` with an ease-out, then held to the end of the scene. */
  | { kind: "punch"; to: number; zoom_frames: number }
  /** A fixed tighter crop on one detail: scaled by `zoom` about the picture's centre, then shifted so that (cx, cy), as shares of the frame, is in the middle. */
  | { kind: "crop"; zoom: number; cx: number; cy: number };

export interface ComposedText {
  text: string;
  lines: string[];
  font_px: number;
  /** Vertical centre and width available, as shares of the frame. */
  y: number;
  w: number;
  /** A translucent strip behind the text, used when the text is over a picture. */
  strip: boolean;
  color: string;
  mode: "fade_up" | "stagger" | "lower_third";
  /** A lower third slides in over `slide_frames`, holds for `hold_frames`, and slides out again over `slide_frames`. */
  align: "left" | "center";
  hold_frames: number;
  slide_frames: number;
  delay_frames: number;
  duration_frames: number;
  distance_px: number;
  words: string[];
  stagger_frames: number;
  word_frames: number;
}

export interface ComposedScene {
  kind: "composed";
  scene_id: string;
  operation_ids: string[];
  from_frame: number;
  frames: number;
  background: string;
  /** True for a light card (dark text). */
  light: boolean;
  image: null | { asset_id: string; uri: string; ext: string; concept: boolean; move: Move };
  text: ComposedText | null;
  end_card: null | { accent: string; hold_frames: number; variant: "brand" | "dark" | "light" };
  /** A supplied logo scaled in softly on a plain background. */
  logo: null | { asset_id: string; uri: string; ext: string; concept: boolean; scale_from: number; reveal_frames: number };
}

export type ComposedPlan = { ok: true; scenes: ComposedScene[]; total_frames: number } | { ok: false; issues: string[] };

export interface ComposedPlanOptions {
  renderer: string;
  templates: Readonly<Record<string, ComposedTemplate>>;
  outputRoot: string;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_SCENES = 60, MAX_TEXT = 120, MAX_IMAGE_BYTES = 50 * 1024 * 1024, MAX_FPS = 240;
const CHAR_W = 0.55;
const EASINGS = ["linear", "ease_in_out"];
export const CARD_BACKGROUNDS = { brand: WEB_BACKGROUNDS.navy, dark: "#101114", light: "#f2efe6" } as const;
export const CARD_TEXT_LIGHT = "#16213e";

type Spec = { name: string } & ({ min: number; max: number } | { options: readonly string[] });
/** The parameter bounds of each template's recipe. They mirror the recipes'; the planner does not rely on the recipe having been checked. */
function specsFor(t: ComposedTemplate): Spec[] {
  switch (`${t.family}:${t.motion}`) {
    case "camera_move:zoom_in": return [{ name: "scale_end", min: 1.03, max: 1.25 }, { name: "easing", options: EASINGS }];
    case "camera_move:zoom_out": return [{ name: "scale_start", min: 1.1, max: 1.5 }, { name: "easing", options: EASINGS }];
    case "camera_move:pan": return [{ name: "direction", options: ["left", "right", "up", "down"] }, { name: "distance_pct", min: 3, max: 20 }];
    case "camera_move:punch": return [{ name: "scale_end", min: 1.15, max: 1.6 }, { name: "zoom_duration_s", min: 0.2, max: 0.8 }];
    case "camera_move:crop": return [{ name: "center_x_pct", min: 10, max: 90 }, { name: "center_y_pct", min: 10, max: 90 }, { name: "zoom", min: 1.3, max: 3 }];
    case "text_motion:lower_third": return [{ name: "align", options: ["left", "center"] }, { name: "hold_s", min: 1, max: 5 }];
    case "logo_reveal:reveal": return [{ name: "scale_from", min: 0.8, max: 0.98 }, { name: "duration_s", min: 0.4, max: 1.5 }];
    case "text_motion:fade_up": return [{ name: "delay_s", min: 0, max: 2 }, { name: "duration_s", min: 0.2, max: 1.2 }, { name: "distance_px", min: 8, max: 80 }];
    case "text_motion:stagger": return [{ name: "stagger_ms", min: 20, max: 120 }, { name: "word_duration_s", min: 0.15, max: 0.6 }];
    case "end_card:card": return [{ name: "hold_s", min: 1.5, max: 4 }, { name: "background", options: ["brand", "dark", "light"] }];
    default: return [];
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The storyboard camera motion a camera template carries out with these parameters, for the coverage check. */
export function cameraMotionOf(t: Pick<ComposedTemplate, "family" | "motion">, params: Record<string, unknown>): string | null {
  if (t.family !== "camera_move") return null;
  if (t.motion === "zoom_in") return "slow_push_in";
  if (t.motion === "zoom_out") return "pull_out";
  const d = params["direction"];
  return d === "left" ? "pan_left" : d === "right" ? "pan_right" : d === "up" ? "tilt_up" : d === "down" ? "tilt_down" : null;
}

/**
 * What an adapter that runs these learned templates can show, in the form the coverage check takes: camera moves (by the storyboard motion they carry
 * out), the templates that show their own image, and the templates that start text at the approved delay. Both browser renderers use it.
 */
export function composedCapabilities(learned: readonly ComposedTemplate[] = []) {
  const camera: Record<string, { template: string; param?: { name: string; value: string } }[]> = {};
  for (const t of learned.filter((x) => x.family === "camera_move")) {
    if (t.motion === "pan") for (const [value, m] of [["left", "pan_left"], ["right", "pan_right"], ["up", "tilt_up"], ["down", "tilt_down"]] as const) (camera[m] ??= []).push({ template: t.template, param: { name: "direction", value } });
    else if (t.motion === "zoom_in" || t.motion === "zoom_out") (camera[t.motion === "zoom_in" ? "slow_push_in" : "pull_out"] ??= []).push({ template: t.template });
    // a punch-in or a crop is no storyboard camera motion: it carries out none, and it is an approved operation of its own
  }
  return {
    camera_templates: camera,
    image_via_templates: learned.filter((x) => x.family === "camera_move" || x.family === "logo_reveal").map((x) => x.template),
    caption_timing_templates: learned.filter((x) => x.family === "text_motion" && x.motion === "fade_up").map((x) => x.template),
  };
}

/** Groups the job's operations by scene and plans each scene. See the file comment for what is and is not accepted. */
export function planComposedScenes(job: Omit<RenderJob, "signal">, opts: ComposedPlanOptions): ComposedPlan {
  const issues: string[] = [];
  const s = job.settings, who = opts.renderer;
  if (s.container !== "mp4" || s.video_codec !== "h264") issues.push(`the ${who} adapter writes mp4 with h264, not ${s.container} with ${s.video_codec}`);
  if (s.audio_codec !== null) issues.push(`the ${who} adapter writes no audio; the settings ask for an audio track`);
  if (!(s.fps > 0 && s.fps <= MAX_FPS)) issues.push(`the frame rate ${s.fps} is outside 1 to ${MAX_FPS}`);
  const out = resolve(job.output_path), rel = relative(resolve(opts.outputRoot), out);
  if (rel.startsWith("..") || isAbsolute(rel) || !/^rn_[a-f0-9]{16}\.mp4$/.test(basename(out)) || basename(out) !== basename(job.output_path)) issues.push("the output path is not a render file inside the output folder");
  if (!job.operations.length) issues.push("there are no operations to render");
  if (job.operations.length > MAX_SCENES * 3) issues.push(`more than ${MAX_SCENES} scenes`);
  const half = 0.5 / s.fps;
  const assets = new Map(job.assets.map((a) => [a.asset_id, a]));
  const used = new Set<string>();
  const tpl = (id: string) => opts.templates[job.templates[id] ?? ""];

  for (const op of job.operations) {
    const at = `operation ${op.operation_id}`;
    const t = tpl(op.operation_id);
    if (!t) issues.push(`${at}: template ${job.templates[op.operation_id] ?? "(none)"} is not supported by the ${who} adapter (supported: ${Object.keys(opts.templates).join(", ") || "none"})`);
    else if (t.type !== op.operation_type) issues.push(`${at}: ${t.template} implements ${t.type} operations, not ${op.operation_type}`);
    if (op.audio_cues.length) issues.push(`${at}: audio cues cannot be produced and are not dropped silently`);
  }

  // scenes in timeline order, each with its operations
  const byScene = new Map<string, typeof job.operations>();
  for (const op of job.operations) if (tpl(op.operation_id)) byScene.set(op.target_scene_id, [...(byScene.get(op.target_scene_id) ?? []), op]);
  const ordered = [...byScene.entries()].sort((a, b) => Math.min(...a[1].map((o) => o.timing.start_s)) - Math.min(...b[1].map((o) => o.timing.start_s)));

  const scenes: ComposedScene[] = [];
  let cursor = 0, cursorFrame = 0;
  for (const [sceneId, ops] of ordered) {
    const before = issues.length;
    const at = `scene ${sceneId}`;
    const start_s = ops[0]!.timing.start_s, duration_s = ops[0]!.timing.duration_s;
    for (const o of ops) if (Math.abs(o.timing.start_s - start_s) > half || Math.abs(o.timing.duration_s - duration_s) > half) issues.push(`operation ${o.operation_id}: its timing (${o.timing.start_s}s for ${o.timing.duration_s}s) is not the scene's (${start_s}s for ${duration_s}s)`);
    const frames = Math.round(duration_s * s.fps);
    if (frames < 1 || Math.abs(frames / s.fps - duration_s) > 1e-6) issues.push(`${at}: ${duration_s}s is not a whole number of frames at ${s.fps} fps`);
    if (Math.abs(start_s - cursor) > half) issues.push(`${at}: starts at ${start_s}s but the previous scene ends at ${cursor}s (gaps and overlaps are not rendered)`);
    cursor = start_s + duration_s;

    const camera = ops.filter((o) => tpl(o.operation_id)!.family === "camera_move");
    const textOps = ops.filter((o) => tpl(o.operation_id)!.family === "text_motion");
    const cards = ops.filter((o) => tpl(o.operation_id)!.family === "end_card");
    const logos = ops.filter((o) => tpl(o.operation_id)!.family === "logo_reveal");
    if (logos.length > 1) issues.push(`${at}: it has ${logos.length} logo reveals; one is supported per scene`);
    if (logos.length && (camera.length || textOps.length || cards.length)) issues.push(`${at}: a logo reveal combined with another operation is not a validated combination (the logo is the whole scene)`);
    if (camera.length > 1) issues.push(`${at}: it has ${camera.length} camera moves (${camera.map((o) => o.operation_id).join(", ")}); one is supported per scene`);
    if (textOps.length > 1) issues.push(`${at}: it has ${textOps.length} text animations (${textOps.map((o) => o.operation_id).join(", ")}); one is supported per scene`);
    if (cards.length > 1) issues.push(`${at}: it has ${cards.length} end cards; one is supported per scene`);
    if (cards.length && (camera.length || textOps.length)) issues.push(`${at}: an end card combined with ${camera.length ? "a camera move" : "a text animation"} is not a validated combination (the card is the whole scene)`);

    // every operation's parameters, against its template's bounds
    const params = new Map<string, Record<string, number | string>>();
    for (const o of ops) {
      const t = tpl(o.operation_id)!;
      const specs = specsFor(t);
      const names = specs.map((x) => x.name);
      for (const k of Object.keys(o.parameters)) if (!names.includes(k)) issues.push(`operation ${o.operation_id}: unknown parameter ${k}`);
      const got: Record<string, number | string> = {};
      for (const sp of specs) {
        const v = o.parameters[sp.name];
        if ("options" in sp) { if (typeof v !== "string" || !sp.options.includes(v)) issues.push(`operation ${o.operation_id}: ${sp.name} must be one of ${sp.options.join(", ")}`); else got[sp.name] = v; }
        else { const n = num(v); if (n === null || n < sp.min || n > sp.max) issues.push(`operation ${o.operation_id}: ${sp.name} must be a number from ${sp.min} to ${sp.max}`); else got[sp.name] = n; }
      }
      params.set(o.operation_id, got);
    }

    // the picture: exactly one supplied image, shown by the camera move (or, for a logo reveal, the logo)
    let image: ComposedScene["image"] = null;
    let logo: ComposedScene["logo"] = null;
    const pick = (o: (typeof ops)[number], what: string, verb: string) => {
      const id = o.asset_ids[0];
      const a = id ? assets.get(id) : undefined;
      if (o.asset_ids.length !== 1) issues.push(`operation ${o.operation_id}: ${what} works on exactly one supplied image`);
      else if (!a) issues.push(`operation ${o.operation_id}: asset ${id} was not supplied to the renderer`);
      else if (a.media_type !== "image") issues.push(`operation ${o.operation_id}: asset ${id} is ${a.media_type}; only an image can be ${verb} here, and nothing is substituted for it`);
      else if (!isAbsolute(a.uri) || !IMAGE_EXT.has(extname(a.uri).toLowerCase())) issues.push(`operation ${o.operation_id}: the file for asset ${id} must be an absolute path to a .png, .jpg, .jpeg or .webp file`);
      else {
        const st = statSync(a.uri, { throwIfNoEntry: false });
        if (!st?.isFile() || st.size === 0) issues.push(`operation ${o.operation_id}: the file for asset ${id} is missing or empty`);
        else if (st.size > MAX_IMAGE_BYTES) issues.push(`operation ${o.operation_id}: the file for asset ${id} is larger than ${MAX_IMAGE_BYTES / 1048576} MB`);
        else { used.add(a.asset_id); return a; }
      }
      return null;
    };
    for (const o of ops) {
      const t = tpl(o.operation_id)!;
      // The Editor lists the scene's assets on every operation of the scene. Only a camera move or a logo reveal shows one; an asset that none of them shows is reported as unused below.
      if (t.family !== "camera_move" && t.family !== "logo_reveal") continue;
      const a = t.family === "logo_reveal" ? pick(o, "a logo reveal", "shown") : pick(o, "a camera move", "moved");
      if (!a) continue;
      const p = params.get(o.operation_id)!;
      const concept = job.concept_asset_ids.includes(a.asset_id), ext = extname(a.uri).toLowerCase();
      if (t.family === "logo_reveal") { logo = { asset_id: a.asset_id, uri: resolve(a.uri), ext, concept, scale_from: Number(p["scale_from"] ?? 0.9), reveal_frames: Math.max(1, Math.round(Number(p["duration_s"] ?? 0.8) * s.fps)) }; if (Number(p["duration_s"] ?? 0.8) > duration_s + 1e-9) issues.push(`operation ${o.operation_id}: the reveal takes longer than the scene`); continue; }
      let move: Move;
      if (t.motion === "zoom_in") move = { kind: "zoom", from: 1, to: Number(p["scale_end"] ?? 1.1), easing: (p["easing"] as "linear" | "ease_in_out") ?? "ease_in_out" };
      else if (t.motion === "zoom_out") move = { kind: "zoom", from: Number(p["scale_start"] ?? 1.25), to: 1, easing: (p["easing"] as "linear" | "ease_in_out") ?? "ease_in_out" };
      else if (t.motion === "punch") {
        const zd = Number(p["zoom_duration_s"] ?? 0.4);
        if (zd > 0.6 * duration_s + 1e-9) issues.push(`operation ${o.operation_id}: the punch-in takes ${zd}s, more than 60% of the scene`);
        move = { kind: "punch", to: Number(p["scale_end"] ?? 1.3), zoom_frames: Math.max(1, Math.round(zd * s.fps)) };
      } else if (t.motion === "crop") {
        const z = Number(p["zoom"] ?? 1.8), cx = Number(p["center_x_pct"] ?? 50) / 100, cy = Number(p["center_y_pct"] ?? 50) / 100;
        // the crop window must stay inside the picture: nothing outside it is invented, and the approved centre is not moved to make it fit
        if (cx - 0.5 / z < -1e-9 || cx + 0.5 / z > 1 + 1e-9 || cy - 0.5 / z < -1e-9 || cy + 0.5 / z > 1 + 1e-9) issues.push(`operation ${o.operation_id}: a crop at ${Math.round(cx * 100)}% across and ${Math.round(cy * 100)}% down at ${z}x would reach outside the picture`);
        move = { kind: "crop", zoom: z, cx, cy };
      } else {
        const d = Number(p["distance_pct"] ?? 8) / 100, h = d / 2, dir = p["direction"];
        move = { kind: "pan", scale: 1 + d, dx0: dir === "right" ? h : dir === "left" ? -h : 0, dx1: dir === "right" ? -h : dir === "left" ? h : 0, dy0: dir === "down" ? h : dir === "up" ? -h : 0, dy1: dir === "down" ? -h : dir === "up" ? h : 0, easing: "linear" };
      }
      image = { asset_id: a.asset_id, uri: resolve(a.uri), ext, concept, move };
    }
    // the words: one text operation or the end card, never invented
    let text: ComposedText | null = null;
    let end_card: ComposedScene["end_card"] = null;
    let background: string = WEB_BACKGROUNDS.navy, light = false;
    const wordsOp = textOps[0] ?? cards[0];
    if (wordsOp) {
      const t = tpl(wordsOp.operation_id)!, p = params.get(wordsOp.operation_id)!;
      const rawWords = wordsOp.caption?.text;
      const words = typeof rawWords === "string" ? normaliseText(rawWords) : rawWords;
      if (typeof words !== "string" || !words.trim()) issues.push(`operation ${wordsOp.operation_id}: the scene has no text to show`);
      else if (words.length > MAX_TEXT) issues.push(`operation ${wordsOp.operation_id}: text is longer than ${MAX_TEXT} characters`);
      else if (hasInvalidControl(words)) issues.push(`operation ${wordsOp.operation_id}: text contains control characters`);
      else if (t.family === "end_card") {
        const variant = (p["background"] as "brand" | "dark" | "light") ?? "brand";
        background = CARD_BACKGROUNDS[variant]; light = variant === "light";
        const hold = Number(p["hold_s"] ?? 2);
        if (hold > duration_s + 1e-9) issues.push(`operation ${wordsOp.operation_id}: hold_s (${hold}s) is longer than the scene`);
        end_card = { accent: WEB_ACCENTS.amber, hold_frames: Math.round(hold * s.fps), variant };
      }
      if (typeof words === "string" && words.trim() && !hasInvalidControl(words) && words.length <= MAX_TEXT) {
        const lt = t.motion === "lower_third";
        const over = !!image || lt;
        const S = Math.min(s.height, Math.round((s.width * 9) / 16));
        const fs = t.family === "end_card" ? Math.round(s.height / 9) : over ? Math.round(S / 14) : Math.round(s.height / 10);
        const w = t.family === "end_card" ? 0.8 : lt ? 0.8 : over ? 0.84 : 0.8, maxLines = t.family === "end_card" ? 4 : over ? 2 : 6;
        const lines = wrapLines(words, Math.max(4, Math.floor((s.width * w) / (fs * CHAR_W))));
        if (lines.length > maxLines) issues.push(`operation ${wordsOp.operation_id}: the text "${words.length > 30 ? `${words.slice(0, 29)}…` : words}" does not fit in ${maxLines} lines at this frame size`);
        else {
          const delay = t.family === "text_motion" && t.motion === "fade_up" ? Number(p["delay_s"] ?? 0) : 0;
          // the Editor timed the caption from the scene start plus the approved delay; the renderer starts the text there, or the plan is refused
          if (wordsOp.caption && (Math.abs(wordsOp.caption.start_s - (start_s + delay)) > half + 1e-6 || Math.abs(wordsOp.caption.end_s - (start_s + duration_s)) > half + 1e-6)) {
            issues.push(`operation ${wordsOp.operation_id}: its caption is timed ${wordsOp.caption.start_s}s to ${wordsOp.caption.end_s}s but the approved delay puts the text at ${start_s + delay}s to ${start_s + duration_s}s`);
          }
          const dur = t.motion === "fade_up" ? Number(p["duration_s"] ?? 0.5) : t.family === "end_card" ? 0.4 : 0.5;
          if (t.motion === "fade_up" && delay + dur > duration_s + 1e-9) issues.push(`operation ${wordsOp.operation_id}: the text would not be fully shown before the scene ends (delay ${delay}s plus ${dur}s)`);
          if (t.motion === "fade_up" && dur > 0.6 * duration_s + 1e-9) issues.push(`operation ${wordsOp.operation_id}: the entrance takes ${dur}s, more than 60% of the scene`);
          const slide = Math.max(1, Math.round(0.4 * s.fps)), hold = Math.round(Number(p["hold_s"] ?? 2) * s.fps);
          if (lt && (2 * slide + hold) / s.fps > duration_s + 1e-9) issues.push(`operation ${wordsOp.operation_id}: sliding in, holding ${Number(p["hold_s"] ?? 2)}s and sliding out takes ${((2 * slide + hold) / s.fps).toFixed(2)}s, longer than the scene`);
          const ws = words.split(/\s+/).filter(Boolean);
          const stagger = Number(p["stagger_ms"] ?? 60) / 1000, wd = Number(p["word_duration_s"] ?? 0.3);
          if (t.motion === "stagger" && (ws.length - 1) * stagger + wd > duration_s + 1e-9) issues.push(`operation ${wordsOp.operation_id}: the last word would not be fully shown before the scene ends`);
          text = {
            text: words, lines, font_px: fs, y: t.family === "end_card" ? 0.45 : over ? 0.84 : 0.5, w, strip: over && !lt, color: light ? CARD_TEXT_LIGHT : "#ffffff",
            mode: lt ? "lower_third" : t.motion === "stagger" ? "stagger" : "fade_up", align: (p["align"] as "left" | "center") ?? "center", hold_frames: hold, slide_frames: slide, delay_frames: Math.round(delay * s.fps), duration_frames: Math.max(1, Math.round(dur * s.fps)), distance_px: Number(p["distance_px"] ?? 0),
            words: ws, stagger_frames: Math.max(1, Math.round(stagger * s.fps)), word_frames: Math.max(1, Math.round(wd * s.fps)),
          };
        }
      }
    } else if (!image && !logo) issues.push(`${at}: it has nothing to show`);
    if (!wordsOp && image) { /* a camera move alone: the picture only */ }

    if (issues.length === before) { scenes.push({ kind: "composed", scene_id: sceneId, operation_ids: ops.map((o) => o.operation_id), from_frame: cursorFrame, frames, background, light, image, text, end_card, logo }); }
    cursorFrame += frames;
  }
  if (Math.abs(cursor - s.duration_s) > half) issues.push(`the scenes end at ${cursor}s but the settings say ${s.duration_s}s`);
  for (const a of job.assets) if (!used.has(a.asset_id)) issues.push(`asset ${a.asset_id} is not shown by any operation (the ${who} adapter shows a supplied image through a camera move)`);
  if (issues.length) return { ok: false, issues };
  return { ok: true, scenes, total_frames: cursorFrame };
}
