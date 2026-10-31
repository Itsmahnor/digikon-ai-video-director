import { contrastRatio, type NormBox, type SceneAssetRef } from "@digikon/contracts";
import type { Box } from "./composition.js";


/** One picture as the registry found it for this project: which real file to load, and the facts layout depends on. */
export interface ResolvedAssetFile {
  asset_id: string;
  /** The file to load. It is the upload itself unless a normalized or trimmed copy is safer, and `variant` says which. */
  path: string;
  variant: "original" | "normalized" | "trimmed";
  sha256: string;
  width: number;
  height: number;
  /** The file has see-through pixels. */
  transparent: boolean;
  /** The file's own flat background colour when it has one. */
  background: string | null;
  /** The file's main colours, most used first, the background left out. */
  colours: string[];
}

/** Finds a picture's real file through the registry, by id. Null when this project holds no such picture. */
export type AssetFileResolver = (asset_id: string, role: SceneAssetRef["role"]) => ResolvedAssetFile | null;

export interface AssetLayer {
  asset_id: string;
  role: SceneAssetRef["role"];
  mandatory: boolean;
  /** Absolute path of the file loaded. Replaced by a served name before the renderer sees it. */
  source: string;
  sha256: string;
  variant: ResolvedAssetFile["variant"];
  z: number;
  /** The area the picture is clipped to, in frame pixels. */
  clip: Box;
  /** Where the whole image sits at the first and last frame of its motion, in frame pixels. It may be larger than `clip` when the picture is cropped. */
  from: Box;
  to: Box;
  /** Frames the movement takes. */
  move_frames: number;
  /** Frames over which the picture fades in. Zero means it is there from the first frame. */
  fade_frames: number;
  /** A panel behind a picture that would otherwise vanish on the scene's background. */
  plate: null | { box: Box; colour: string; radius: number };
  frame: SceneAssetRef["frame"];
  chrome_h: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** Where the image sits at a frame of the scene. The drawing does exactly this, so a real frame can be compared with the file at the right size and place. */
export function rectAt(l: Pick<AssetLayer, "from" | "to" | "move_frames">, frame: number): Box {
  const t = l.move_frames > 0 ? easeOut(Math.max(0, Math.min(1, frame / l.move_frames))) : 1;
  return { x: lerp(l.from.x, l.to.x, t), y: lerp(l.from.y, l.to.y, t), w: lerp(l.from.w, l.to.w, t), h: lerp(l.from.h, l.to.h, t) };
}

/** The box a placement gives inside a region, at the requested share of it. */
export function placementBox(placement: SceneAssetRef["placement"], scale: number, region: Box, frame: { width: number; height: number }): Box {
  if (placement === "full_frame") return { x: 0, y: 0, w: frame.width, h: frame.height };
  const w = Math.round(region.w * scale), h = Math.round(region.h * scale);
  const left = region.x, right = region.x + region.w - w, cx = region.x + (region.w - w) / 2;
  const top = region.y, bottom = region.y + region.h - h, cy = region.y + (region.h - h) / 2;
  const at: Record<Exclude<SceneAssetRef["placement"], "full_frame">, [number, number]> = {
    center: [cx, cy], left: [left, cy], right: [right, cy], top: [cx, top], bottom: [cx, bottom], top_left: [left, top], top_right: [right, top], bottom_left: [left, bottom], bottom_right: [right, bottom],
  };
  const [x, y] = at[placement];
  return { x: Math.round(x), y: Math.round(y), w, h };
}

/** The whole picture inside a box, keeping its shape and centred. */
export function containRect(iw: number, ih: number, b: Box): Box {
  const s = Math.min(b.w / iw, b.h / ih);
  const w = iw * s, h = ih * s;
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
}
/** The picture filling a box, keeping its shape; what overflows is clipped evenly. */
export function coverRect(iw: number, ih: number, b: Box): Box {
  const s = Math.max(b.w / iw, b.h / ih);
  const w = iw * s, h = ih * s;
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
}
/** The whole image placed so that a region of it fills `view`. */
export function regionRect(crop: NormBox, iw: number, ih: number, view: Box): { clip: Box; rect: Box } {
  const clip = containRect(crop.w * iw, crop.h * ih, view);
  const w = clip.w / crop.w, h = clip.h / crop.h;
  return { clip, rect: { x: clip.x - crop.x * w, y: clip.y - crop.y * h, w, h } };
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const grown = (r: Box, by: number): Box => ({ x: r.x + (r.w - r.w * by) / 2, y: r.y + (r.h - r.h * by) / 2, w: r.w * by, h: r.h * by });
const round = (b: Box): Box => ({ x: Math.round(b.x * 100) / 100, y: Math.round(b.y * 100) / 100, w: Math.round(b.w * 100) / 100, h: Math.round(b.h * 100) / 100 });

/** A plate is needed when the picture's main colours would sink into the scene's background. It uses the file's own background, or white. */
export function plateColour(f: Pick<ResolvedAssetFile, "transparent" | "background" | "colours">, background: string): string | null {
  if (!f.transparent) return f.background;
  const worst = Math.min(...(f.colours.length ? f.colours : ["#ffffff"]).slice(0, 3).map((c) => contrastRatio(c, background)));
  if (worst >= 2.2) return null;
  const light = f.colours.every((c) => contrastRatio(c, "#ffffff") < 2.2);
  return light ? "#0b0f19" : "#ffffff";
}

export interface LayerPlanInput { width: number; height: number; fps: number; frames: number; region: Box; background: string; overlay: boolean; motionSpeed: number; keepClear?: readonly Box[] }

/**
 * Turns approved references into exact geometry, back to front. A picture with no real file is an issue: nothing stands in for it. An overlay on a drawn
 * scene stays small and in a corner or along the top, so it cannot sit on top of what the scene draws.
 */
export function planLayers(refs: readonly SceneAssetRef[], files: Record<string, ResolvedAssetFile>, p: LayerPlanInput): { layers: AssetLayer[]; issues: string[] } {
  const issues: string[] = [];
  const layers: AssetLayer[] = [];
  const fade = Math.max(1, Math.round(0.5 * p.motionSpeed * p.fps));
  const settle = Math.max(2, Math.round(Math.min(0.9, 0.9 * p.motionSpeed) * p.fps));
  for (const r of [...refs].sort((a, b) => a.layer - b.layer)) {
    const f = files[r.asset_id];
    if (!f) { issues.push(`picture ${r.asset_id} is not available to the renderer in this project, so nothing can be shown for it`); continue; }
    if (p.overlay && !(["top_left", "top_right", "bottom_left", "bottom_right", "top"] as const).includes(r.placement as never)) { issues.push(`picture ${r.asset_id}: on a drawn scene a picture goes in a corner or along the top; use asset_stage to feature it`); continue; }
    if (p.overlay && r.scale > 0.34) { issues.push(`picture ${r.asset_id}: on a drawn scene a picture can take up to a third of the frame, not ${Math.round(r.scale * 100)}%`); continue; }
    const box = placementBox(r.placement, r.scale, p.region, p);
    const chrome_h = r.frame === "browser" ? Math.round(Math.min(p.width, p.height) * 0.04) : 0;
    const view: Box = { x: box.x, y: box.y + chrome_h, w: box.w, h: box.h - chrome_h };
    let clip: Box, to: Box;
    if (r.fit === "crop" && r.crop) { const g = regionRect(r.crop, f.width, f.height, view); clip = g.clip; to = g.rect; }
    else if (r.fit === "cover") { clip = view; to = coverRect(f.width, f.height, view); }
    else { to = containRect(f.width, f.height, view); clip = to; }

    let from = to, move_frames = 0, fade_frames = 0;
    if (r.animation === "fade_in") fade_frames = fade;
    else if (r.animation === "scale_in") { from = grown(to, 0.9); move_frames = settle; fade_frames = fade; }
    else if (r.animation === "slide_up") { from = { ...to, y: to.y + Math.round(p.height * 0.06) }; move_frames = settle; fade_frames = fade; }
    else if (r.animation === "ken_burns_in") { from = to; to = grown(to, 1.08); move_frames = p.frames - 1; }
    else if (r.animation === "ken_burns_out") { from = grown(to, 1.08); move_frames = p.frames - 1; }
    else if (r.animation === "pan_left" || r.animation === "pan_right") {
      const room = Math.min(to.w - clip.w, p.width * 0.08);
      if (room < 2) issues.push(`picture ${r.asset_id}: a pan needs a picture wider than its area; use fit cover or a crop`);
      const mid = to.x, half = room / 2;
      from = { ...to, x: mid + (r.animation === "pan_left" ? half : -half) };
      to = { ...to, x: mid + (r.animation === "pan_left" ? -half : half) };
      move_frames = p.frames - 1;
    } else if (r.animation === "zoom_to_region" && r.crop) {
      const whole = containRect(f.width, f.height, view);
      clip = view; from = whole; to = regionRect(r.crop, f.width, f.height, view).rect;
      move_frames = Math.max(settle, Math.round(p.frames * 0.55));
    }

    if ((p.keepClear ?? []).some((k) => overlaps(k, clip))) { issues.push(`picture ${r.asset_id} would cover the scene's text; move it, make it smaller or give the scene to asset_stage`); continue; }
    // a photograph on its own background needs no panel; a logo keeps its own, or gets one if it would sink into the scene
    const colour = r.role === "background" || r.fit === "cover" || r.fit === "crop" || (r.role !== "logo" && !f.transparent) ? null : plateColour(f, p.background);
    const pad = Math.round(Math.min(p.width, p.height) * 0.03);
    const plateBox: Box = { x: to.x - pad, y: to.y - pad, w: to.w + 2 * pad, h: to.h + 2 * pad };
    const plate = colour && r.frame === "none" && contrastRatio(colour, p.background) > 1.2 ? { box: round(plateBox), colour, radius: Math.round(pad * 0.7) } : null;
    if (plate && (plate.box.x < 0 || plate.box.y < 0 || plate.box.x + plate.box.w > p.width || plate.box.y + plate.box.h > p.height)) issues.push(`picture ${r.asset_id}: its panel leaves the frame; reduce its scale`);
    const vis = { x: Math.max(0, clip.x), y: Math.max(0, clip.y), r: Math.min(p.width, clip.x + clip.w), b: Math.min(p.height, clip.y + clip.h) };
    if (vis.r - vis.x < 2 || vis.b - vis.y < 2) { issues.push(`picture ${r.asset_id} would be outside the frame`); continue; }
    layers.push({ asset_id: r.asset_id, role: r.role, mandatory: r.mandatory, source: f.path, sha256: f.sha256, variant: f.variant, z: r.layer, clip: round(clip), from: round(from), to: round(to), move_frames, fade_frames, plate, frame: r.frame, chrome_h });
  }
  return { layers, issues };
}
