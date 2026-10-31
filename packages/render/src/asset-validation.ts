import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { AssetValidationReport, type AssetLifecycleStage, type AssetSceneCheck } from "@digikon/contracts";
import { rectAt, type AssetLayer } from "./asset-layers.js";
import type { Box } from "./composition.js";
import { rawFrame } from "./verify.js";

/** The picture counts as present at this correlation with the file on real frames. A wrong, stretched or hidden picture stays well below it. */
export const MATCH_MIN = 0.72;
/** And no further than this from the file's actual colours (0-255), so a ghost at low opacity does not pass on shape alone. */
export const DIFF_MAX = 42;
/** A hard minimum for pictures with almost no tonal variety, where correlation says little. */
const FLAT_STDDEV = 6;

export interface Occluder { box: Box }

export interface FrameMatch { score: number; diff: number; visible_share: number; pixels: number }

/** The expected picture at this rect, as RGBA at frame scale, cropped to what the clip shows. Null when nothing of it is on screen. */
async function expected(file: string, rect: Box, clip: Box, width: number, height: number) {
  const x0 = Math.max(0, Math.ceil(Math.max(rect.x, clip.x))), y0 = Math.max(0, Math.ceil(Math.max(rect.y, clip.y)));
  const x1 = Math.min(width, Math.floor(Math.min(rect.x + rect.w, clip.x + clip.w))), y1 = Math.min(height, Math.floor(Math.min(rect.y + rect.h, clip.y + clip.h)));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const rw = Math.round(rect.w), rh = Math.round(rect.h);
  const left = Math.max(0, Math.min(rw - (x1 - x0), Math.round(x0 - rect.x))), top = Math.max(0, Math.min(rh - (y1 - y0), Math.round(y0 - rect.y)));
  const px = await sharp(file, { animated: false }).rotate().resize(rw, rh, { fit: "fill" }).ensureAlpha().extract({ left, top, width: x1 - x0, height: y1 - y0 }).raw().toBuffer();
  return { x0, y0, w: x1 - x0, h: y1 - y0, px };
}

/** Compares a real frame with the uploaded file where the plan says it is. Only opaque pixels of the file count, and anything planned on top is left out. */
export async function matchLayer(frame: Buffer, width: number, height: number, layer: Pick<AssetLayer, "source" | "from" | "to" | "move_frames" | "clip">, sceneFrame: number, occluders: readonly Occluder[] = []): Promise<FrameMatch> {
  const rect = rectAt(layer, sceneFrame);
  const e = await expected(layer.source, rect, layer.clip, width, height);
  if (!e) return { score: 0, diff: 255, visible_share: 0, pixels: 0 };
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, d = 0;
  const hidden = (x: number, y: number) => occluders.some((o) => x >= o.box.x && x < o.box.x + o.box.w && y >= o.box.y && y < o.box.y + o.box.h);
  const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
  for (let yy = 0; yy < e.h; yy += 2) for (let xx = 0; xx < e.w; xx += 2) {
    const i = (yy * e.w + xx) * 4;
    if (e.px[i + 3]! < 200) continue;
    const fx = e.x0 + xx, fy = e.y0 + yy;
    if (hidden(fx, fy)) continue;
    const j = (fy * width + fx) * 3;
    const a = lum(e.px[i]!, e.px[i + 1]!, e.px[i + 2]!), b = lum(frame[j]!, frame[j + 1]!, frame[j + 2]!);
    n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    d += (Math.abs(e.px[i]! - frame[j]!) + Math.abs(e.px[i + 1]! - frame[j + 1]!) + Math.abs(e.px[i + 2]! - frame[j + 2]!)) / 3;
  }
  if (n < 16) return { score: 0, diff: 255, visible_share: 0, pixels: n };
  const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n, cov = sab - (sa * sb) / n;
  const flat = Math.sqrt(Math.max(0, va) / n) < FLAT_STDDEV;
  const score = flat ? (d / n <= DIFF_MAX / 2 ? 1 : 0) : va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
  const area = Math.max(1, Math.min(rect.w, layer.clip.w) * Math.min(rect.h, layer.clip.h));
  return { score: Math.round(score * 1000) / 1000, diff: Math.round((d / n) * 10) / 10, visible_share: Math.min(1, Math.round(((e.w * e.h) / area) * 1000) / 1000), pixels: n };
}

export interface SceneForValidation {
  scene_id: string;
  from_frame: number;
  frames: number;
  rendered: boolean;
  reason: string | null;
  layers: readonly AssetLayer[];
  /** Planned on top of the pictures, such as a headline panel, so it is not a failure that the file is not visible there. */
  occluders: readonly Occluder[];
}

export interface PlannedUse { scene_id: string; asset_id: string; role: string; mandatory: boolean }

/**
 * Whether each approved use of a picture reached the viewer, judged only from the final file. It reads three frames from the hold of each scene, in the
 * middle where no transition reaches, and compares them with the very file the renderer loaded. Passing means the file is on screen where the plan put it.
 */
export async function validateRenderedAssets(video: string, width: number, height: number, uses: readonly PlannedUse[], scenes: readonly SceneForValidation[], opts: { ffmpegPath?: string; stagesBefore?: (asset_id: string) => readonly AssetLifecycleStage[] } = {}): Promise<AssetValidationReport> {
  const checks: AssetSceneCheck[] = [];
  for (const u of uses) {
    const scene = scenes.find((s) => s.scene_id === u.scene_id);
    const base: AssetSceneCheck = { asset_id: u.asset_id, scene_id: u.scene_id, mandatory: u.mandatory, role: u.role, stages: [...(opts.stagesBefore?.(u.asset_id) ?? []), "assigned_to_storyboard", "approved"], resolved_file: null, sha256: null, match_score: null, frames_checked: [], verdict: "not_rendered", failure: null };
    const layer = scene?.layers.find((l) => l.asset_id === u.asset_id);
    if (!scene || !scene.rendered) { checks.push({ ...base, failure: `${u.scene_id}: the scene was not rendered: ${scene?.reason ?? "no scene"}` }); continue; }
    if (!layer) { checks.push({ ...base, failure: `${u.scene_id}: the renderer has no layer for ${u.asset_id}` }); continue; }
    const stages: AssetLifecycleStage[] = [...base.stages, "resolved_by_renderer"];
    let sha: string;
    try { sha = createHash("sha256").update(await readFile(layer.source)).digest("hex"); } catch { checks.push({ ...base, stages, failure: `${u.scene_id}: the file for ${u.asset_id} can no longer be read` }); continue; }
    if (sha !== layer.sha256) { checks.push({ ...base, stages, resolved_file: layer.variant, sha256: sha, failure: `${u.scene_id}: the file for ${u.asset_id} is not the one that was resolved` }); continue; }
    stages.push("rendered");
    const marks = [0.6, 0.72, 0.84].map((f) => Math.min(scene.frames - 1, Math.round(f * (scene.frames - 1))));
    const front = scene.layers.filter((l) => l.z > layer.z).map((l) => ({ box: l.clip }));
    const ms: FrameMatch[] = [];
    for (const m of marks) {
      try { ms.push(await matchLayer(await rawFrame(video, scene.from_frame + m, width, height, opts.ffmpegPath ?? "ffmpeg"), width, height, layer, m, [...scene.occluders, ...front])); }
      catch { ms.push({ score: 0, diff: 255, visible_share: 0, pixels: 0 }); }
    }
    const good = ms.filter((m) => m.score >= MATCH_MIN && m.diff <= DIFF_MAX).length;
    const best = ms.reduce((a, b) => (b.score > a.score ? b : a));
    const visible = good >= 2;
    checks.push({
      ...base, stages: visible ? [...stages, "visually_validated"] : stages, resolved_file: layer.variant, sha256: sha, match_score: best.score, frames_checked: marks.map((m) => scene.from_frame + m), verdict: visible ? "visible" : "not_visible",
      failure: visible ? null : `${u.scene_id}: ${u.asset_id} is not visible as planned (best match ${best.score.toFixed(2)}, need ${MATCH_MIN}; colour difference ${best.diff.toFixed(0)}, allowed ${DIFF_MAX}); it may be hidden, clipped, distorted or the wrong file`,
    });
  }
  return AssetValidationReport.parse({
    checks,
    failures: checks.filter((c) => c.mandatory && c.verdict !== "visible").map((c) => c.failure ?? `${c.scene_id}: ${c.asset_id} could not be confirmed`),
    limitations: ["Each use is compared with its file on three frames of the scene's hold, by correlation and colour difference. This proves the pixels are there, not that the composition is good."],
  });
}
