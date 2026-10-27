import { statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { Renderer } from "@digikon/contracts";
import type { RenderJob } from "./adapter.js";

/**
 * What the browser-based renderers (Remotion, HyperFrames) have in common: the checks that run before anything starts, and the
 * one scene description both of them draw. A scene that cannot be drawn exactly as approved is an issue, never a simplification.
 * Both renderers draw the same geometry from the same numbers, so a plan looks the same whichever of them renders it.
 */

export type WebKind = "text" | "image";
export interface WebTemplate { kind: WebKind; type: "render_graphics_scene" }

/** Fixed colours, chosen by name. Parameter text never reaches a style sheet or a prop. */
export const WEB_BACKGROUNDS = { navy: "#16213e", charcoal: "#2b2d31", forest: "#1e3d2f" } as const;
export const WEB_ACCENTS = { amber: "#f5b942", teal: "#2dd4bf", coral: "#fb7185" } as const;
export const CONCEPT_BADGE = "Concept illustration";
export const WEB_FONT_FAMILY = "DigikonFont";

const FADE: readonly [number, number] = [0.2, 2];
const ENUMS = { background: Object.keys(WEB_BACKGROUNDS), accent: Object.keys(WEB_ACCENTS), fit: ["contain", "cover"], motion: ["none", "slow_zoom"] } as const;
const PARAMS: Record<WebKind, readonly string[]> = { text: ["fade_in_s", "background", "accent"], image: ["fade_in_s", "background", "fit", "motion"] };
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_SCENES = 60, MAX_TEXT = 120, MAX_IMAGE_BYTES = 50 * 1024 * 1024, MAX_FPS = 240;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CHAR_W = 0.55; // average glyph width as a share of the font size: deliberately generous, so text is refused rather than clipped

export interface WebScene {
  operation_id: string;
  kind: WebKind;
  /** First frame and length of the scene in the output, whole frames. */
  from_frame: number;
  frames: number;
  text: string;
  fade_in_s: number;
  background: string;
  accent: string;
  /** The approved text as it will be wrapped: a conservative estimate that decided whether it fits. The browser wraps by itself. */
  line_count: number;
  lines: string[];
  font_px: number;
  /** Where the text block sits, as a share of the frame height (its vertical centre) and of the frame width available to it. */
  text_y: number;
  text_w: number;
  image: null | { asset_id: string; uri: string; ext: string; fit: "contain" | "cover"; motion: "none" | "slow_zoom"; concept: boolean; box: { x: number; y: number; w: number; h: number } };
}

export type WebPlan = { ok: true; scenes: WebScene[]; total_frames: number } | { ok: false; issues: string[] };

export interface WebPlanOptions {
  renderer: Renderer;
  templates: Readonly<Record<string, WebTemplate>>;
  outputRoot: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The conservative line break the planner uses to decide whether text fits. The browser wraps by itself and never needs more lines than this. */
export function wrapLines(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > max) { if (line) { lines.push(line); line = ""; } lines.push(word.slice(0, max)); word = word.slice(max); }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Checks a job against everything the browser renderers can do, before any process starts. It refuses: other operation types and
 * templates (transitions included), audio cues, containers or codecs other than mp4/h264, audio, unknown or out-of-range
 * parameters, text that is unsafe or does not fit, assets that are not exactly one supplied image on an image scene, assets nothing
 * shows, a timeline with gaps, overlaps or partial frames, a total that differs from the settings, and an output path outside the
 * output folder.
 */
export function planWebScenes(job: Omit<RenderJob, "signal">, opts: WebPlanOptions): WebPlan {
  const issues: string[] = [];
  const s = job.settings;
  const who = opts.renderer;
  if (s.container !== "mp4" || s.video_codec !== "h264") issues.push(`the ${who} adapter writes mp4 with h264, not ${s.container} with ${s.video_codec}`);
  if (s.audio_codec !== null) issues.push(`the ${who} adapter writes no audio; the settings ask for an audio track`);
  if (!(s.fps > 0 && s.fps <= MAX_FPS)) issues.push(`the frame rate ${s.fps} is outside 1 to ${MAX_FPS}`);

  const out = resolve(job.output_path), rel = relative(resolve(opts.outputRoot), out);
  if (rel.startsWith("..") || isAbsolute(rel) || !/^rn_[a-f0-9]{16}\.mp4$/.test(basename(out)) || basename(out) !== basename(job.output_path)) issues.push("the output path is not a render file inside the output folder");

  if (!job.operations.length) issues.push("there are no operations to render");
  if (job.operations.length > MAX_SCENES) issues.push(`more than ${MAX_SCENES} scenes`);
  const half = 0.5 / s.fps;
  const assets = new Map(job.assets.map((a) => [a.asset_id, a]));
  const used = new Set<string>();
  const template = (id: string) => opts.templates[job.templates[id] ?? ""];

  for (const op of job.operations) {
    const at = `operation ${op.operation_id}`;
    const t = template(op.operation_id);
    if (op.operation_type !== "render_graphics_scene") issues.push(`${at}: ${op.operation_type} is not supported by the ${who} adapter (only render_graphics_scene; transitions, clips, audio and camera moves are not built)`);
    else if (!t) issues.push(`${at}: template ${job.templates[op.operation_id] ?? "(none)"} is not supported by the ${who} adapter (supported: ${Object.keys(opts.templates).join(", ")})`);
    if (op.audio_cues.length) issues.push(`${at}: audio cues cannot be produced and are not dropped silently`);
  }

  const scenes: WebScene[] = [];
  let cursor = 0, cursorFrame = 0;
  const ordered = [...job.operations].filter((o) => o.operation_type === "render_graphics_scene" && template(o.operation_id)).sort((a, b) => a.timing.start_s - b.timing.start_s);
  for (const op of ordered) {
    const at = `operation ${op.operation_id}`;
    const kind = template(op.operation_id)!.kind;
    const before = issues.length;
    const keys = PARAMS[kind];
    for (const k of Object.keys(op.parameters)) if (!keys.includes(k)) issues.push(`${at}: unknown parameter ${k}`);
    const fade = num(op.parameters["fade_in_s"]);
    if (fade === null || fade < FADE[0] || fade > FADE[1]) issues.push(`${at}: fade_in_s must be a number from ${FADE[0]} to ${FADE[1]}`);
    const choice = <K extends keyof typeof ENUMS>(name: K): (typeof ENUMS)[K][number] | null => {
      const v = op.parameters[name];
      if (typeof v !== "string" || !(ENUMS[name] as readonly string[]).includes(v)) { issues.push(`${at}: ${name} must be one of ${ENUMS[name].join(", ")}`); return null; }
      return v as (typeof ENUMS)[K][number];
    };
    const background = choice("background");
    const accent = kind === "text" ? choice("accent") : "amber";
    const fit = kind === "image" ? choice("fit") : "contain";
    const motion = kind === "image" ? choice("motion") : "none";

    const text = op.caption?.text;
    if (typeof text !== "string" || !text.trim()) issues.push(`${at}: the scene has no text to show`);
    else if (text.length > MAX_TEXT) issues.push(`${at}: text is longer than ${MAX_TEXT} characters`);
    else if (CONTROL.test(text)) issues.push(`${at}: text contains control characters`);

    let image: WebScene["image"] = null;
    if (kind === "image") {
      const id = op.asset_ids[0];
      const a = id ? assets.get(id) : undefined;
      if (op.asset_ids.length !== 1) issues.push(`${at}: an image scene shows exactly one supplied image`);
      else if (!a) issues.push(`${at}: asset ${id} was not supplied to the renderer`);
      else if (a.media_type !== "image") issues.push(`${at}: asset ${id} is ${a.media_type}, and only images are shown; nothing is substituted for it`);
      else if (!isAbsolute(a.uri) || !IMAGE_EXT.has(extname(a.uri).toLowerCase())) issues.push(`${at}: the file for asset ${id} must be an absolute path to a .png, .jpg, .jpeg or .webp file`);
      else {
        const st = statSync(a.uri, { throwIfNoEntry: false });
        if (!st?.isFile() || st.size === 0) issues.push(`${at}: the file for asset ${id} is missing or empty`);
        else if (st.size > MAX_IMAGE_BYTES) issues.push(`${at}: the file for asset ${id} is larger than ${MAX_IMAGE_BYTES / 1048576} MB`);
        else {
          used.add(a.asset_id);
          const aw = even(s.width * 0.84), ah = even(s.height * 0.62);
          image = { asset_id: a.asset_id, uri: resolve(a.uri), ext: extname(a.uri).toLowerCase(), fit: (fit ?? "contain") as "contain" | "cover", motion: (motion ?? "none") as "none" | "slow_zoom", concept: job.concept_asset_ids.includes(a.asset_id), box: { x: Math.round((s.width - aw) / 2), y: Math.round(s.height * 0.07), w: aw, h: ah } };
        }
      }
    } else if (op.asset_ids.length) issues.push(`${at}: this template uses no assets`);

    const { start_s, duration_s } = op.timing;
    const frames = Math.round(duration_s * s.fps);
    if (frames < 1 || Math.abs(frames / s.fps - duration_s) > 1e-6) issues.push(`${at}: ${duration_s}s is not a whole number of frames at ${s.fps} fps`);
    if (Math.abs(start_s - cursor) > half) issues.push(`${at}: starts at ${start_s}s but the previous scene ends at ${cursor}s (gaps and overlaps are not rendered)`);
    if (fade !== null && fade > duration_s) issues.push(`${at}: fade_in_s is longer than the scene`);
    cursor = start_s + duration_s;

    if (issues.length === before && typeof text === "string" && fade !== null && background && accent) {
      const S = Math.min(s.height, Math.round((s.width * 9) / 16));
      const fontPx = kind === "text" ? Math.round(s.height / 10) : Math.round(S / 14);
      const widthShare = kind === "text" ? 0.8 : 0.84, maxLines = kind === "text" ? 6 : 2;
      const wrapped = wrapLines(text, Math.max(4, Math.floor((s.width * widthShare) / (fontPx * CHAR_W))));
      const lines = wrapped.length;
      if (lines > maxLines) issues.push(`${at}: the text "${text.length > 30 ? `${text.slice(0, 29)}…` : text}" does not fit in ${maxLines} lines at this frame size`);
      else {
        scenes.push({ operation_id: op.operation_id, kind, from_frame: cursorFrame, frames, text, fade_in_s: fade, background: WEB_BACKGROUNDS[background as keyof typeof WEB_BACKGROUNDS], accent: WEB_ACCENTS[accent as keyof typeof WEB_ACCENTS], line_count: lines, lines: wrapped, font_px: fontPx, text_y: kind === "text" ? 0.5 : 0.86, text_w: widthShare, image });
        cursorFrame += frames;
      }
    }
  }
  if (Math.abs(cursor - s.duration_s) > half) issues.push(`the scenes end at ${cursor}s but the settings say ${s.duration_s}s`);
  for (const a of job.assets) if (!used.has(a.asset_id)) issues.push(`asset ${a.asset_id} is not shown by any operation (the ${who} adapter shows supplied images in image scenes only)`);

  if (issues.length) return { ok: false, issues };
  return { ok: true, scenes, total_frames: cursorFrame };
}

/** What each browser renderer can show, in the form the coverage check takes. */
export const WEB_NO_TRANSITIONS = {} as const;
