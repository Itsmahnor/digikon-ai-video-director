import { FFMPEG_ASSET_TEMPLATE, planStage, renderFfmpegStage, stageLayers, usesStage } from "./asset-stage.js";
import { execFile, execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { RenderAdapter, RenderJob } from "./adapter.js";
import type { LearnedTransition } from "./learned-types.js";
import { hasInvalidControl, normaliseText, wrapText } from "./text.js";

const run = promisify(execFile);
const FONT_SIGNATURES = ["\u0000\u0001\u0000\u0000", "OTTO", "true", "ttcf"];

/** The original template, kept under its own name for callers that refer to it. */
export const TEXT_CARD_TEMPLATE = "ffmpeg/text-card";

type SceneKind = "text-card" | "title-subtitle" | "bullet-list" | "stat-callout" | "image-scene" | "clip";
type Kind = SceneKind | "crossfade" | "cut" | "match-cut";
type OpType = "render_graphics_scene" | "concat" | "trim_clip";

/** Every template this adapter implements. A reference that is not here is refused, whatever the recipe says. */
export const FFMPEG_TEMPLATES: Readonly<Record<string, { kind: Kind; type: OpType }>> = {
  [TEXT_CARD_TEMPLATE]: { kind: "text-card", type: "render_graphics_scene" },
  "ffmpeg/title-subtitle": { kind: "title-subtitle", type: "render_graphics_scene" },
  "ffmpeg/bullet-list": { kind: "bullet-list", type: "render_graphics_scene" },
  "ffmpeg/stat-callout": { kind: "stat-callout", type: "render_graphics_scene" },
  "ffmpeg/image-scene": { kind: "image-scene", type: "render_graphics_scene" },
  "ffmpeg/xfade-fade": { kind: "crossfade", type: "concat" },
  /** A hard cut and a match cut are joins made where the scene clips meet, by the assembler; they draw nothing. */
  "ffmpeg/concat-cut": { kind: "cut", type: "concat" },
  "ffmpeg/match-cut": { kind: "match-cut", type: "concat" },
  "ffmpeg/clip-play": { kind: "clip", type: "trim_clip" },
};

/** What this adapter can show beyond plain graphics, in the form the coverage check takes. A learned capability adds to it, see `ffmpegCapabilities`. */
export const FFMPEG_CAPABILITIES = { image_templates: ["ffmpeg/image-scene"], video_templates: ["ffmpeg/clip-play"], transition_templates: { crossfade: ["ffmpeg/xfade-fade"], match_cut: ["ffmpeg/match-cut"] } } as const;

/** Fixed colours, chosen by name. Parameter text never reaches an FFmpeg argument. */
const BACKGROUNDS = { navy: "0x16213e", charcoal: "0x2b2d31", forest: "0x1e3d2f" } as const;
const ACCENTS = { amber: "0xf5b942", teal: "0x2dd4bf", coral: "0xfb7185" } as const;
type Background = keyof typeof BACKGROUNDS;
type Accent = keyof typeof ACCENTS;
/** Parameter bounds. They mirror the recipes' own; the adapter does not rely on the recipe having been checked. */
const RANGES = { fade_in_s: [0.2, 2], stagger_s: [0.2, 1], duration_s: [0.2, 1.5] } as const;
/** Transition length bounds, per template. Each equals its recipe's duration_s range, so the adapter refuses what the recipe would. Any other crossfade template keeps the shared range. */
const TRANSITION_DURATION: Readonly<Record<string, readonly [number, number]>> = {
  "ffmpeg/xfade-fade": [0.2, 1.5], // crossfade
  "ffmpeg/xfade-fadeblack": [0.3, 1.5], // dip-to-black
  "ffmpeg/xfade-wipe": [0.2, 1.0], // directional-wipe
};
const ENUMS: Record<string, readonly string[]> = { background: Object.keys(BACKGROUNDS), accent: Object.keys(ACCENTS), fit: ["contain", "cover"], motion: ["none", "slow_zoom"], source_audio: ["keep", "drop"] };
const PARAMS: Record<Kind, readonly string[]> = {
  "text-card": ["fade_in_s", "background"],
  "title-subtitle": ["fade_in_s", "background", "accent"],
  "bullet-list": ["fade_in_s", "stagger_s", "background", "accent"],
  "stat-callout": ["fade_in_s", "background", "accent"],
  "image-scene": ["fade_in_s", "background", "fit", "motion"],
  clip: ["fade_in_s", "background", "fit", "source_audio"],
  crossfade: ["duration_s"],
  cut: [],
  "match-cut": [],
};
/** The built-in templates plus the learned transitions this adapter was given. A learned template is data for the crossfade engine, never code. */
function templatesWith(learned: readonly LearnedTransition[] = []): Record<string, { kind: Kind; type: OpType; learned?: LearnedTransition }> {
  return { ...FFMPEG_TEMPLATES, ...Object.fromEntries(learned.map((l) => [l.template, { kind: "crossfade" as const, type: "concat" as const, learned: l }])) };
}

/** What this adapter can show, including the transitions it has learned, by the storyboard's transition name. */
export function ffmpegCapabilities(learned: readonly LearnedTransition[] = []) {
  const transitions: Record<string, string[]> = { crossfade: [...FFMPEG_CAPABILITIES.transition_templates.crossfade], match_cut: [...FFMPEG_CAPABILITIES.transition_templates.match_cut] };
  for (const l of learned) (transitions[l.storyboard_transition] ??= []).push(l.template);
  return { image_templates: FFMPEG_CAPABILITIES.image_templates, video_templates: FFMPEG_CAPABILITIES.video_templates, transition_templates: transitions };
}

const VIDEO_EXT = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv"]);
const MAX_FPS = 240;
const MAX_SCENES = 60, MAX_TEXT = 120, MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const BADGE_TEXT = "Concept illustration";
const CHAR_W = 0.55; // average glyph width as a share of the font size: deliberately generous, so text is refused rather than clipped

export interface FfmpegAdapterOptions {
  /** A TrueType/OpenType font file. Required: text is never drawn with a font the adapter has not been given. */
  fontFile: string;
  /** The folder render outputs must be inside. Same value as `RenderDeps.outputRoot`. */
  outputRoot: string;
  ffmpegPath?: string;
  /** Used to measure supplied clips again just before they are rendered. Defaults to ffprobe on the PATH. */
  ffprobePath?: string;
  /** Validated learned transitions (see `capabilities.ts`). Each adds one template that the crossfade engine runs with its own xfade name. */
  learned?: readonly LearnedTransition[];
  /** Where the temporary text, font and image files go. Defaults to the system temp folder. */
  workRoot?: string;
}

/** One piece of approved text, placed. Coordinates are FFmpeg expressions or integers built here, never from user text. */
interface Block { lines: string[]; fs: number; x: string; y: string; align: "center" | "left"; accent: boolean; start: number; box?: boolean }
interface Bar { x: string; y: string; w: string; h: number }
export interface TextCardScene {
  operation_id: string;
  kind: SceneKind;
  frames: number;
  text: string;
  /** The lines of the first block (the whole text for a text card). */
  lines: string[];
  fade_in_s: number;
  background: Background;
  accent: Accent;
  blocks: Block[];
  bars: Bar[];
  image: null | { asset_id: string; uri: string; ext: string; fit: "contain" | "cover"; motion: "none" | "slow_zoom"; concept: boolean; box: { w: number; h: number; x: number; y: number } };
  /** A supplied video clip played unchanged, or null. */
  clip: null | { asset_id: string; path: string; source_in_s: number; duration_s: number; fit: "contain" | "cover" };
  /** Frames of crossfade into the next scene, 0 for none. */
  crossfade_frames: number;
  /** The xfade transition used for that blend. Absent means the plain fade. */
  xfade?: string;
}

/** What ffprobe says about a supplied clip. */
export interface ClipProbe { width: number; height: number; duration_s: number; fps: number; audio_tracks: number; video_codec: string }

/** Measures a clip's streams without a shell. Null when the file cannot be read as video. */
export function probeClip(path: string, ffprobePath = "ffprobe"): ClipProbe | null {
  try {
    const out = execFileSync(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" });
    const j = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string; disposition?: { attached_pic?: number } }[] };
    const v = (j.streams ?? []).find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
    if (!v?.width || !v.height) return null;
    const [n, d] = (v.avg_frame_rate ?? "").split("/").map(Number);
    const duration = Number(v.duration ?? j.format?.duration ?? NaN);
    return { width: v.width, height: v.height, duration_s: duration, fps: n && d ? n / d : NaN, audio_tracks: (j.streams ?? []).filter((s) => s.codec_type === "audio").length, video_codec: v.codec_name ?? "unknown" };
  } catch { return null; }
}

export type CardPlan = { ok: true; scenes: TextCardScene[]; total_frames: number } | { ok: false; issues: string[] };

const fitLines = (text: string, fs: number, width: number, maxLines: number): string[] | null => {
  const lines = wrapText(text, Math.max(4, Math.floor(width / (fs * CHAR_W))));
  return lines.length <= maxLines ? lines : null;
};
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

type Box = { w: number; h: number; x: number; y: number };
type Composed = { ok: true; blocks: Block[]; bars: Bar[]; box: Box | null } | { ok: false; issues: string[] };

/**
 * Places the approved words for one scene. Every visible word comes from the scene's overlay text; the layouts only decide where
 * each part goes. Templates that show sections read them from the text itself, separated by "|", so nothing is added or reworded.
 * A part that does not fit its space is an issue, never clipped or shrunk silently.
 */
function composeText(kind: SceneKind, text: string, W: number, H: number, fade: number, stagger: number, duration: number): Composed {
  const issues: string[] = [];
  const S = Math.min(H, Math.round((W * 9) / 16)); // size reference: H for 16:9, the width-limited equivalent otherwise
  const parts = kind === "text-card" ? [text] : text.split("|").map((p) => p.trim());
  if (parts.some((p) => !p)) return { ok: false, issues: ["an empty section between | marks"] };
  const take = (label: string, t: string, fs: number, widthShare: number, maxLines: number) => {
    const lines = fitLines(t, fs, W * widthShare, maxLines);
    if (!lines) issues.push(`the ${label} "${t.length > 30 ? `${t.slice(0, 29)}…` : t}" does not fit in ${maxLines === 1 ? "one line" : `${maxLines} lines`} at this frame size`);
    return lines ?? [];
  };

  if (kind === "text-card") {
    const fs = Math.round(H / 10);
    const lines = take("text", parts[0]!, fs, 0.8, 6);
    return issues.length ? { ok: false, issues } : { ok: true, blocks: [{ lines, fs, x: "(w-text_w)/2", y: "(h-text_h)/2", align: "center", accent: false, start: 0 }], bars: [{ x: "iw*0.4", y: "ih*0.8", w: "iw*0.2", h: 6 }], box: null };
  }
  if (kind === "title-subtitle") {
    if (parts.length > 2) issues.push("a title card takes a title and at most one subtitle (Title | Subtitle)");
    const sub = parts.length === 2;
    const title = take("title", parts[0]!, Math.round(S / 8), 0.84, 2);
    const blocks: Block[] = [{ lines: title, fs: Math.round(S / 8), x: "(w-text_w)/2", y: `h*${sub ? 0.36 : 0.45}-text_h/2`, align: "center", accent: false, start: 0 }];
    if (sub) blocks.push({ lines: take("subtitle", parts[1]!, Math.round(S / 16), 0.84, 2), fs: Math.round(S / 16), x: "(w-text_w)/2", y: "h*0.6-text_h/2", align: "center", accent: false, start: fade * 0.6 });
    return issues.length ? { ok: false, issues } : { ok: true, blocks, bars: [{ x: "iw*0.4", y: "ih*0.88", w: "iw*0.2", h: 6 }], box: null };
  }
  if (kind === "stat-callout") {
    if (parts.length < 2 || parts.length > 3) issues.push("a statistic takes a figure, a label and optionally a line of context (Figure | Label | Context)");
    const vfs = Math.round(S / 4), lfs = Math.round(S / 11), cfs = Math.round(S / 20);
    const blocks: Block[] = [
      { lines: take("figure", parts[0]!, vfs, 0.84, 1), fs: vfs, x: "(w-text_w)/2", y: "h*0.36-text_h/2", align: "center", accent: true, start: 0 },
      { lines: take("label", parts[1] ?? "", lfs, 0.84, 2), fs: lfs, x: "(w-text_w)/2", y: "h*0.62-text_h/2", align: "center", accent: false, start: fade * 0.5 },
    ];
    if (parts[2] !== undefined) blocks.push({ lines: take("context", parts[2], cfs, 0.84, 2), fs: cfs, x: "(w-text_w)/2", y: "h*0.82-text_h/2", align: "center", accent: false, start: fade });
    return issues.length ? { ok: false, issues } : { ok: true, blocks, bars: [{ x: "iw*0.4", y: "ih*0.5", w: "iw*0.2", h: 6 }], box: null };
  }
  if (kind === "bullet-list") {
    if (parts.length < 2 || parts.length > 6) issues.push("a list takes a heading and two to five items (Heading | Item | Item)");
    const hfs = Math.round(S / 11), ifs = Math.round(S / 16);
    const heading = take("heading", parts[0]!, hfs, 0.84, 2);
    const top = Math.round(H * 0.08), headBottom = top + Math.round(heading.length * hfs * 1.3), itemsTop = headBottom + Math.round(H * 0.07), row = Math.round(ifs * 1.9);
    const blocks: Block[] = [{ lines: heading, fs: hfs, x: "w*0.08", y: String(top), align: "left", accent: false, start: 0 }];
    parts.slice(1).forEach((p, i) => {
      const start = Math.round((fade * 0.5 + (i + 1) * stagger) * 1000) / 1000;
      blocks.push({ lines: take(`item ${i + 1}`, `• ${p}`, ifs, 0.8, 1), fs: ifs, x: "w*0.1", y: String(itemsTop + i * row), align: "left", accent: false, start });
      if (start + fade > duration + 1e-9) issues.push(`item ${i + 1} would not be fully visible before the scene ends (it appears at ${start}s and fades in over ${fade}s)`);
    });
    if (itemsTop + (parts.length - 1) * row > H * 0.96) issues.push("the list does not fit vertically at this frame size");
    return issues.length ? { ok: false, issues } : { ok: true, blocks, bars: [{ x: "iw*0.08", y: String(headBottom + Math.round(H * 0.015)), w: "iw*0.14", h: 5 }], box: null };
  }
  if (kind === "clip") {
    // a caption over supplied footage: the whole overlay text, on a translucent strip so it stays readable
    const fs = Math.round(S / 14);
    const lines = take("caption", parts[0]!, fs, 0.84, 2);
    return issues.length ? { ok: false, issues } : { ok: true, blocks: [{ lines, fs, x: "(w-text_w)/2", y: "h*0.84-text_h/2", align: "center", accent: false, start: 0, box: true }], bars: [], box: null };
  }
  // image-scene: the caption is the whole overlay text
  const cfs = Math.round(S / 14);
  const lines = take("caption", parts[0]!, cfs, 0.84, 2);
  const aw = even(W * 0.84), ah = even(H * 0.62);
  return issues.length ? { ok: false, issues } : { ok: true, blocks: [{ lines, fs: cfs, x: "(w-text_w)/2", y: "h*0.86-text_h/2", align: "center", accent: false, start: fade * 0.6 }], bars: [], box: { w: aw, h: ah, x: Math.round((W - aw) / 2), y: Math.round(H * 0.07) } };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Checks a job against everything this adapter can do, before any process starts. Anything it cannot do exactly is an issue:
 * other operation types or templates, assets that are not a supplied image on an image scene, audio, unknown or out-of-range
 * parameters, text that is unsafe or does not fit, a timeline with gaps or overlaps, scene lengths that are not whole frames,
 * transitions that do not fit, other containers or codecs, an output path outside the output folder.
 */
export function planScenes(job: Omit<RenderJob, "signal">, opts: Pick<FfmpegAdapterOptions, "outputRoot"> & Pick<Partial<FfmpegAdapterOptions>, "ffprobePath" | "learned">): CardPlan {
  const TEMPLATES = templatesWith(opts.learned);
  const issues: string[] = [];
  const s = job.settings;
  if (s.container !== "mp4" || s.video_codec !== "h264") issues.push(`this adapter writes mp4 with h264, not ${s.container} with ${s.video_codec}`);
  if (s.audio_codec !== null) issues.push("this adapter writes no audio; the settings ask for an audio track");

  const out = resolve(job.output_path), rel = relative(resolve(opts.outputRoot), out);
  if (rel.startsWith("..") || isAbsolute(rel) || !/^rn_[a-f0-9]{16}\.mp4$/.test(basename(out)) || basename(out) !== basename(job.output_path)) issues.push("the output path is not a render file inside the output folder");

  if (!job.operations.length) issues.push("there are no operations to render");
  if (job.operations.length > MAX_SCENES * 2) issues.push(`more than ${MAX_SCENES} scenes`);
  const half = 0.5 / s.fps;
  const assets = new Map(job.assets.map((a) => [a.asset_id, a]));
  const usedAssets = new Set<string>();

  const template = (opId: string) => TEMPLATES[job.templates[opId] ?? ""];
  const sceneOps = [...job.operations].filter((o) => o.operation_type !== "concat").sort((a, b) => a.timing.start_s - b.timing.start_s);
  const transitions = job.operations.filter((o) => o.operation_type === "concat");
  for (const op of job.operations) {
    const at = `operation ${op.operation_id}`;
    if (op.operation_type !== "render_graphics_scene" && op.operation_type !== "concat" && op.operation_type !== "trim_clip") issues.push(`${at}: ${op.operation_type} is not supported (only render_graphics_scene, trim_clip and concat)`);
    else if (!template(op.operation_id)) issues.push(`${at}: template ${job.templates[op.operation_id] ?? "(none)"} is not supported by this renderer (supported: ${Object.keys(TEMPLATES).join(", ")})`);
    else if (template(op.operation_id)!.type !== op.operation_type) issues.push(`${at}: template ${job.templates[op.operation_id]} implements ${template(op.operation_id)!.type} operations, not ${op.operation_type}`);
    if (op.audio_cues.length) issues.push(`${at}: audio cues cannot be produced and are not dropped silently`);
  }

  const scenes: TextCardScene[] = [];
  let cursor = 0;
  for (const op of sceneOps) {
    const t = template(op.operation_id);
    if (!t || t.type === "concat" || t.type !== op.operation_type) continue; // already reported
    const at = `operation ${op.operation_id}`;
    const kind = t.kind as SceneKind;
    const before = issues.length;
    const keys = PARAMS[kind];
    for (const k of Object.keys(op.parameters)) if (!keys.includes(k)) issues.push(`${at}: unknown parameter ${k}`);
    const numeric = (name: keyof typeof RANGES) => {
      const v = num(op.parameters[name]);
      if (v === null || v < RANGES[name][0] || v > RANGES[name][1]) { issues.push(`${at}: ${name} must be a number from ${RANGES[name][0]} to ${RANGES[name][1]}`); return null; }
      return v;
    };
    const choice = (name: string) => {
      const v = op.parameters[name];
      if (typeof v !== "string" || !ENUMS[name]!.includes(v)) { issues.push(`${at}: ${name} must be one of ${ENUMS[name]!.join(", ")}`); return null; }
      return v;
    };
    const captioned = kind !== "clip" || !!op.caption; // a clip without a caption has nothing to fade
    const fade = captioned ? numeric("fade_in_s") : 0.5;
    const stagger = kind === "bullet-list" ? numeric("stagger_s") : 0;
    const background = choice("background") as Background | null;
    const accent = (keys.includes("accent") ? choice("accent") : "amber") as Accent | null;
    const fit = kind === "image-scene" || kind === "clip" ? (choice("fit") as "contain" | "cover" | null) : "contain";
    const motion = kind === "image-scene" ? (choice("motion") as "none" | "slow_zoom" | null) : "none";
    const sourceAudio = kind === "clip" ? choice("source_audio") : null;

    const rawText = op.caption?.text;
    const text = typeof rawText === "string" ? normaliseText(rawText) : rawText;
    if (kind === "clip" && !op.caption) { /* footage with no caption */ }
    else if (typeof text !== "string" || !text.trim()) issues.push(`${at}: the scene has no text to show`);
    else if (text.length > MAX_TEXT) issues.push(`${at}: text is longer than ${MAX_TEXT} characters`);
    else if (hasInvalidControl(text)) issues.push(`${at}: text contains control characters`);

    // ----- a supplied video clip: identity, source file, trim range and media properties, checked against the approved analysis -----
    let clip: TextCardScene["clip"] = null;
    if (kind === "clip") {
      const id = op.asset_ids[0];
      const a = id ? assets.get(id) : undefined;
      const info = id ? job.asset_info[id] : undefined;
      const entry = job.clips.find((c) => c.operation_id === op.operation_id);
      if (op.asset_ids.length !== 1) issues.push(`${at}: a clip scene plays exactly one supplied video`);
      else if (!a) issues.push(`${at}: asset ${id} was not supplied to the renderer`);
      else if (a.media_type !== "video") issues.push(`${at}: asset ${id} is ${a.media_type}, not a video, and nothing is substituted for it`);
      else if (!VIDEO_EXT.has(extname(a.uri).toLowerCase()) || !isAbsolute(a.uri)) issues.push(`${at}: the file for asset ${id} must be an absolute path to a .mp4, .m4v, .mov, .webm or .mkv file`);
      else if (!entry || entry.asset_id !== a.asset_id || !Number.isFinite(entry.source_in_s) || entry.source_in_s < 0) issues.push(`${at}: the approved source start point for ${id} is missing or invalid`);
      else if (!info) issues.push(`${at}: the approved measurements of asset ${id} are missing`);
      else {
        const st = statSync(a.uri, { throwIfNoEntry: false });
        const probe = st?.isFile() && st.size > 0 ? probeClip(a.uri, opts.ffprobePath) : null;
        const out_s = entry.source_in_s + op.timing.duration_s;
        if (!st?.isFile() || st.size === 0) issues.push(`${at}: the file for asset ${id} is missing or empty`);
        else if (!probe) issues.push(`${at}: the file for asset ${id} cannot be read as a video`);
        else if (!(probe.fps > 0 && probe.fps <= MAX_FPS) || !Number.isFinite(probe.duration_s) || probe.duration_s <= 0) issues.push(`${at}: asset ${id} has no usable frame rate or duration`);
        else if ((info.width !== null && probe.width !== info.width) || (info.height !== null && probe.height !== info.height) || probe.audio_tracks !== info.audio_tracks || (info.duration !== null && Math.abs(probe.duration_s - info.duration) > 0.25)) issues.push(`${at}: the file for asset ${id} is not what was analysed and approved (${probe.width}x${probe.height}, ${probe.audio_tracks} audio track(s), ${probe.duration_s.toFixed(2)}s)`);
        else if (out_s > probe.duration_s + 1 / probe.fps) issues.push(`${at}: the approved trim ${entry.source_in_s}s to ${Math.round(out_s * 1000) / 1000}s runs past the end of asset ${id}, which lasts ${probe.duration_s.toFixed(2)}s`);
        else if (probe.audio_tracks > 0 && sourceAudio !== "drop") issues.push(`${at}: asset ${id} has an audio track, and audio cannot be produced yet; the approved plan does not say to drop it (source_audio is ${sourceAudio})`);
        else { usedAssets.add(a.asset_id); clip = { asset_id: a.asset_id, path: resolve(a.uri), source_in_s: entry.source_in_s, duration_s: op.timing.duration_s, fit: fit ?? "contain" }; }
      }
    }

    let image: TextCardScene["image"] = null;
    if (kind === "image-scene") {
      const id = op.asset_ids[0];
      const a = id ? assets.get(id) : undefined;
      if (op.asset_ids.length !== 1) issues.push(`${at}: an image scene shows exactly one supplied image`);
      else if (!a) issues.push(`${at}: asset ${id} was not supplied to the renderer`);
      else if (a.media_type !== "image") issues.push(`${at}: asset ${id} is ${a.media_type}, and only images are shown (no video clips yet)`);
      else if (!IMAGE_EXT.has(extname(a.uri).toLowerCase())) issues.push(`${at}: asset ${id} is not a .png, .jpg, .jpeg or .webp file`);
      else {
        const st = statSync(a.uri, { throwIfNoEntry: false });
        if (!st?.isFile() || st.size === 0) issues.push(`${at}: the file for asset ${id} is missing or empty`);
        else if (st.size > MAX_IMAGE_BYTES) issues.push(`${at}: the file for asset ${id} is larger than ${MAX_IMAGE_BYTES / 1048576} MB`);
        else { usedAssets.add(a.asset_id); image = { asset_id: a.asset_id, uri: a.uri, ext: extname(a.uri).toLowerCase(), fit: fit ?? "contain", motion: motion ?? "none", concept: job.concept_asset_ids.includes(a.asset_id), box: { w: 0, h: 0, x: 0, y: 0 } }; }
      }
    } else if (kind !== "clip" && op.asset_ids.length) issues.push(`${at}: this template uses no assets`);

    const { start_s, duration_s } = op.timing;
    const frames = Math.round(duration_s * s.fps);
    if (frames < 1 || Math.abs(frames / s.fps - duration_s) > 1e-6) issues.push(`${at}: ${duration_s}s is not a whole number of frames at ${s.fps} fps`);
    if (Math.abs(start_s - cursor) > half) issues.push(`${at}: starts at ${start_s}s but the previous scene ends at ${cursor}s (gaps and overlaps are not rendered)`);
    cursor = start_s + duration_s;
    if (fade !== null && fade > duration_s) issues.push(`${at}: fade_in_s is longer than the scene`);

    const noCaption = kind === "clip" && !op.caption;
    if (issues.length === before && (noCaption || typeof text === "string") && fade !== null && stagger !== null) {
      const c: Composed = noCaption ? { ok: true, blocks: [], bars: [], box: null } : composeText(kind, text!, s.width, s.height, fade, stagger, duration_s);
      if (!c.ok) issues.push(...c.issues.map((i) => `${at}: ${i}`));
      else {
        if (image && c.box) image.box = c.box;
        scenes.push({ operation_id: op.operation_id, kind, frames, text: text ?? "", lines: c.blocks[0]?.lines ?? [], fade_in_s: fade, background: background!, accent: accent!, blocks: c.blocks, bars: c.bars, image, clip, crossfade_frames: 0 });
      }
    }
  }
  if (Math.abs(cursor - s.duration_s) > half) issues.push(`the scenes end at ${cursor}s but the settings say ${s.duration_s}s`);
  for (const a of job.assets) if (!usedAssets.has(a.asset_id)) issues.push(`asset ${a.asset_id} is not shown by any operation (this renderer shows supplied images in image scenes and supplied videos in clip scenes only)`);

  // ----- transitions: a crossfade blends the end of a scene into the first picture of the next one -----
  const sceneEnds = new Map<string, { index: number; end: number }>();
  let t0 = 0;
  sceneOps.forEach((o, i) => { t0 = o.timing.start_s + o.timing.duration_s; sceneEnds.set(o.target_scene_id, { index: i, end: t0 }); });
  const seen = new Set<string>();
  for (const op of transitions) {
    const at = `operation ${op.operation_id}`;
    const t = template(op.operation_id);
    if (!t || t.type !== "concat") continue;
    if (t.kind === "cut" || t.kind === "match-cut") {
      for (const k of Object.keys(op.parameters)) issues.push(`${at}: unknown parameter ${k}`);
      if (t.kind === "match-cut") issues.push(`${at}: a match cut is checked between the finished clips of the two scenes it joins, which only the scene-by-scene assembly does`);
      continue;
    }
    const target = sceneEnds.get(op.target_scene_id);
    const sc = target ? scenes.find((x) => x.operation_id === sceneOps[target.index]!.operation_id) : undefined;
    if (!target || !sc) { issues.push(`${at}: its scene ${op.target_scene_id} is not rendered, so there is nothing to fade from`); continue; }
    if (target.index === sceneOps.length - 1) { issues.push(`${at}: the last scene has no following scene to cross-fade into`); continue; }
    if (seen.has(op.target_scene_id)) issues.push(`${at}: ${op.target_scene_id} already has a transition`);
    seen.add(op.target_scene_id);
    if (op.caption) issues.push(`${at}: a transition carries no text`); // the Editor lists its scene's assets on it; they are shown by the scene itself
    const learnedT = TEMPLATES[job.templates[op.operation_id] ?? ""]?.learned;
    const allowed = learnedT?.direction_map ? [...PARAMS.crossfade, "direction"] : PARAMS.crossfade;
    for (const k of Object.keys(op.parameters)) if (!allowed.includes(k)) issues.push(`${at}: unknown parameter ${k}`);
    let xfade = learnedT ? (learnedT.xfade ?? "") : "fade";
    if (learnedT?.direction_map) {
      const dir = op.parameters["direction"];
      const mapped = typeof dir === "string" && Object.hasOwn(learnedT.direction_map, dir) ? learnedT.direction_map[dir] : undefined;
      if (!mapped) { issues.push(`${at}: direction must be one of ${Object.keys(learnedT.direction_map).join(", ")}`); continue; }
      xfade = mapped;
    }
    const d = num(op.parameters["duration_s"]);
    const [dMin, dMax] = TRANSITION_DURATION[job.templates[op.operation_id] ?? ""] ?? RANGES.duration_s;
    if (d === null || d < dMin || d > dMax) { issues.push(`${at}: duration_s must be a number from ${dMin} to ${dMax}`); continue; }
    const frames = Math.round(d * s.fps);
    const next = scenes[target.index + 1];
    if (frames < 1 || Math.abs(frames / s.fps - d) > 1e-6) issues.push(`${at}: ${d}s is not a whole number of frames at ${s.fps} fps`);
    else if (frames > Math.floor(sc.frames / 2) || (next && frames > next.frames)) issues.push(`${at}: a ${d}s crossfade is longer than half of ${op.target_scene_id} or longer than the next scene`);
    else { sc.crossfade_frames = frames; sc.xfade = xfade; }
    if (Math.abs(op.timing.duration_s - d) > half || Math.abs(op.timing.start_s - (target.end - d)) > half) issues.push(`${at}: it is not placed at the end of ${op.target_scene_id} (${target.end - d}s to ${target.end}s)`);
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, scenes, total_frames: scenes.reduce((n, x) => n + x.frames, 0) };
}
/** The earlier name of the planner, from when only text cards existed. */
export const planTextCards = planScenes;

/** The files the graph reads, written next to the font in the work folder. */
export function sceneTextFiles(scenes: readonly TextCardScene[]): { name: string; content: string }[] {
  const files = scenes.flatMap((sc, i) => sc.blocks.map((b, k) => ({ name: `t${i}_${k}.txt`, content: b.lines.join("\n") })));
  if (scenes.some((sc) => sc.image?.concept)) files.push({ name: "badge.txt", content: BADGE_TEXT });
  return files;
}

/** FFmpeg input arguments for the image scenes, in scene order. The files are copied beside the font as img<scene><ext>. */
export function buildInputs(scenes: readonly TextCardScene[], fps: number): string[] {
  return scenes.flatMap((sc, i) =>
    sc.image ? ["-loop", "1", "-framerate", String(fps), "-t", (sc.frames / fps).toFixed(6), "-i", `img${i}${sc.image.ext}`]
    : sc.clip ? ["-ss", sc.clip.source_in_s.toFixed(6), "-t", sc.clip.duration_s.toFixed(6), "-i", sc.clip.path] // an absolute, validated path as its own argument, never inside the filter graph
    : []);
}

/** The filter graph. Built only from validated numbers and fixed names; the text is read from files, never written into it. */
export function buildFilterGraph(scenes: readonly TextCardScene[], width: number, height: number, fps: number): string {
  const S = Math.min(height, Math.round((width * 9) / 16));
  const chains: string[] = [];
  let input = 0;
  scenes.forEach((sc, i) => {
    const acc = ACCENTS[sc.accent], bg = BACKGROUNDS[sc.background];
    const base = `color=c=${bg}:s=${width}x${height}:r=${fps},trim=end_frame=${sc.frames},setpts=PTS-STARTPTS,format=yuv420p`;
    const bars = sc.bars.map((b) => `drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=${acc}:t=fill`);
    const texts = sc.blocks.map((b, k) => `drawtext=fontfile=font.ttf:textfile=t${i}_${k}.txt:expansion=none:fontcolor=${b.accent ? acc : "white"}:fontsize=${b.fs}:x=${b.x}:y=${b.y}:text_align=${b.align}${b.box ? ":box=1:boxcolor=black@0.55:boxborderw=14" : ""}:alpha='min(1,max(0,(t-${b.start})/${sc.fade_in_s}))'`);
    if (sc.clip) {
      const fitted = sc.clip.fit === "contain" ? `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${bg}` : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
      chains.push(`[${input++}:v]fps=${fps},setpts=PTS-STARTPTS,${fitted},setsar=1,format=yuv420p,trim=end_frame=${sc.frames}${texts.length ? `,${texts.join(",")}` : ""},fps=${fps}[s${i}]`);
      return;
    }
    if (!sc.image) { chains.push(`${base},${[...bars, ...texts].join(",")},fps=${fps}[s${i}]`); return; }
    const { box, fit, motion } = sc.image;
    const w2 = box.w * 2, h2 = box.h * 2;
    const fitted = fit === "contain" ? `scale=${w2}:${h2}:force_original_aspect_ratio=decrease,pad=${w2}:${h2}:(ow-iw)/2:(oh-ih)/2:color=${bg}` : `scale=${w2}:${h2}:force_original_aspect_ratio=increase,crop=${w2}:${h2}`;
    const move = motion === "slow_zoom" ? `zoompan=z='1+0.12*on/${sc.frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${box.w}x${box.h}:fps=${fps}` : `scale=${box.w}:${box.h}`;
    const badge = sc.image.concept ? [`drawtext=fontfile=font.ttf:textfile=badge.txt:expansion=none:fontcolor=white:fontsize=${Math.max(10, Math.round(S / 28))}:x=${box.x + 12}:y=${box.y + 12}:text_align=left:box=1:boxcolor=black@0.65:boxborderw=8`] : [];
    chains.push(`${base}[bg${i}]`);
    chains.push(`[${input++}:v]${fitted},${move},setsar=1,format=rgba,fade=t=in:st=0:d=${sc.fade_in_s}:alpha=1[im${i}]`);
    chains.push(`[bg${i}][im${i}]overlay=x=${box.x}:y=${box.y}:shortest=1,format=yuv420p,${[...texts, ...badge].join(",")},fps=${fps}[s${i}]`);
  });

  // Crossfades. Scene i fades into the first picture of scene i+1, held for the length of the fade, so the film keeps its length.
  const finals: string[] = [];
  scenes.forEach((sc, i) => {
    const needsHead = i > 0 && scenes[i - 1]!.crossfade_frames > 0;
    let main = `s${i}`;
    if (needsHead) { chains.push(`[s${i}]split=2[r${i}][h${i}]`); main = `r${i}`; }
    if (sc.crossfade_frames > 0 && i + 1 < scenes.length) {
      const cf = sc.crossfade_frames;
      chains.push(`[h${i + 1}]trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=${cf - 1},fps=${fps}[hd${i + 1}]`);
      chains.push(`[${main}][hd${i + 1}]xfade=transition=${sc.xfade ?? "fade"}:duration=${(cf / fps).toFixed(6)}:offset=${((sc.frames - cf) / fps).toFixed(6)},trim=end_frame=${sc.frames},setpts=PTS-STARTPTS,format=yuv420p,fps=${fps}[x${i}]`);
      finals.push(`[x${i}]`);
    } else finals.push(`[${main}]`);
  });
  return `${chains.join(";")};${finals.join("")}concat=n=${scenes.length}:v=1:a=0[out]`;
}

/**
 * The FFmpeg adapter. It implements the templates in FFMPEG_TEMPLATES: text cards, title and subtitle, a heading with a list,
 * a large figure with a label, a supplied image with a caption, and the crossfade between scenes. Each scene shows the approved
 * overlay text over a solid colour; scenes are joined in order. Every other operation, template, asset, audio cue or setting is
 * refused before FFmpeg starts. FFmpeg is run with an argument array (no shell), stops when the job's abort signal fires, and a
 * failed run leaves no output behind.
 */
export function createFfmpegAdapter(opts: FfmpegAdapterOptions): RenderAdapter {
  for (const l of opts.learned ?? []) if (!l.template.startsWith("ffmpeg/")) throw new Error(`${l.template} is not an FFmpeg template, so the FFmpeg adapter will not run it`);
  const ext = extname(opts.fontFile).toLowerCase();
  if (ext !== ".ttf" && ext !== ".otf") throw new Error("fontFile must be a .ttf or .otf file");
  if (!statSync(opts.fontFile, { throwIfNoEntry: false })?.isFile()) throw new Error(`font file not found: ${opts.fontFile}`);

  return {
    renderer: "ffmpeg",
    templates: { ...Object.fromEntries(Object.entries(templatesWith(opts.learned)).map(([ref, t]) => [ref, [t.type]])), [FFMPEG_ASSET_TEMPLATE]: ["render_graphics_scene"] },
    capabilities: { ...ffmpegCapabilities(opts.learned), image_templates: [...FFMPEG_CAPABILITIES.image_templates, FFMPEG_ASSET_TEMPLATE], drawn_templates: [FFMPEG_ASSET_TEMPLATE] },
    check(job) {
      if (usesStage(job, FFMPEG_ASSET_TEMPLATE)) { const s = planStage(job, FFMPEG_ASSET_TEMPLATE, { outputRoot: opts.outputRoot }); return s.ok ? [] : s.issues; }
      const p = planScenes(job, opts);
      return p.ok ? [] : p.issues;
    },
    assetLayers(job) {
      if (!usesStage(job, FFMPEG_ASSET_TEMPLATE)) return [];
      const s = planStage(job, FFMPEG_ASSET_TEMPLATE, { outputRoot: opts.outputRoot });
      return s.ok ? stageLayers(s.scenes) : [];
    },
    async render(job) {
      if (usesStage(job, FFMPEG_ASSET_TEMPLATE)) {
        const s = planStage(job, FFMPEG_ASSET_TEMPLATE, { outputRoot: opts.outputRoot });
        if (!s.ok) throw new Error(`rejected before ffmpeg ran: ${s.issues.join("; ")}`);
        await renderFfmpegStage(job, s.scenes, s.total_frames, opts);
        return { notes: ["ffmpeg overlaid the uploaded pictures on their own alpha channel"] };
      }
      const plan = planScenes(job, opts);
      if (!plan.ok) throw new Error(`rejected before ffmpeg ran: ${plan.issues.join("; ")}`);
      const { width, height, fps } = job.settings;
      const dir = await mkdtemp(join(opts.workRoot ?? tmpdir(), "scene-render-"));
      try {
        // FFmpeg quietly falls back to another font when it cannot read this one, and text must never be drawn in a font the adapter was not given
        if (!FONT_SIGNATURES.includes((await readFile(opts.fontFile)).subarray(0, 4).toString("latin1"))) throw new Error("the font file is not a readable font");
        await copyFile(opts.fontFile, join(dir, "font.ttf"));
        await Promise.all(sceneTextFiles(plan.scenes).map((f) => writeFile(join(dir, f.name), f.content, "utf8")));
        await Promise.all(plan.scenes.flatMap((sc, i) => (sc.image ? [copyFile(sc.image.uri, join(dir, `img${i}${sc.image.ext}`))] : [])));
        const args = [
          "-hide_banner", "-nostdin", "-v", "error", "-n",
          "-filter_threads", "1", "-filter_complex_threads", "1",
          ...buildInputs(plan.scenes, fps),
          "-filter_complex", buildFilterGraph(plan.scenes, width, height, fps), "-map", "[out]", "-an",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-threads", "1",
          "-fflags", "+bitexact", "-flags:v", "+bitexact", "-movflags", "+faststart", "-frames:v", String(plan.total_frames),
          resolve(job.output_path),
        ];
        await run(opts.ffmpegPath ?? "ffmpeg", args, { cwd: dir, signal: job.signal, maxBuffer: 1 << 20, windowsHide: true });
      } catch (e) {
        await rm(job.output_path, { force: true });
        if (job.signal.aborted) throw new Error("ffmpeg was stopped");
        const stderr = (e as { stderr?: string }).stderr;
        throw new Error(`ffmpeg failed: ${(stderr || (e instanceof Error ? e.message : String(e))).trim().slice(0, 500)}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
