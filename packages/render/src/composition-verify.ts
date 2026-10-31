import type { CompositionScene } from "./composition.js";
import { rawFrame, rgb, type FidelityOptions, type FidelityResult } from "./verify.js";

/**
 * What can be measured about a drawn composition from its real frames, without a model: that the scene is on its palette, has content that
 * is neither missing nor a wall of colour, keeps that content off the frame edge, shows its headline, and really moves. These are
 * measurements, not a judgement of beauty: a scene can pass all of them and still be a poor design.
 */

export interface SceneMeasure {
  scene_id: string;
  /** Share of the last frame that differs clearly from the background. */
  coverage: number;
  /** Largest mean difference (0-255) between two consecutive sampled frames: how much the scene moves. */
  motion: number;
  /** Mean difference between the first and last sampled frames. */
  change: number;
  /** Mean difference between the last two sampled frames: near zero means the scene holds still at its end. */
  end_hold: number;
  /** Share of the outer 1.5% ring of the last frame that differs clearly from the background. */
  edge_ink: number;
  headline_ink: number | null;
  /** The last frame, 16x9 luminance cells, for comparing scenes with each other. */
  signature: number[];
}

const dist = (b: Buffer, i: number, c: readonly [number, number, number]) => Math.abs(b[i]! - c[0]) + Math.abs(b[i + 1]! - c[1]) + Math.abs(b[i + 2]! - c[2]);
const mad = (a: Buffer, b: Buffer, step = 3) => { let d = 0, n = 0; for (let i = 0; i + 2 < a.length; i += 3 * step) { d += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!); n++; } return d / (3 * n); };

export function measureFrames(frames: readonly Buffer[], scene: CompositionScene): SceneMeasure {
  const { width, height } = scene;
  const bg = rgb(scene.palette.background);
  const last = frames[frames.length - 1]!, first = frames[0]!;
  let ink = 0, n = 0, edge = 0, en = 0;
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.015));
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    const i = (y * width + x) * 3;
    const inkHere = dist(last, i, bg) > 90;
    n++; if (inkHere) ink++;
    // a gradient or dot backdrop tints the corners by up to ~100 of 765 away from the flat background; only strong content counts as touching the edge
    if (x < ring || y < ring || x >= width - ring || y >= height - ring) { en++; if (dist(last, i, bg) > 180) edge++; }
  }
  let motion = 0;
  for (let k = 1; k < frames.length; k++) motion = Math.max(motion, mad(frames[k - 1]!, frames[k]!));
  let headline_ink: number | null = null;
  if (scene.headline && scene.visual.block !== "kinetic_type" && scene.visual.block !== "end_card") {
    const b = scene.headline.box;
    let hi = 0, hn = 0;
    for (let y = Math.max(0, Math.round(b.y)); y < Math.min(height, Math.round(b.y + b.h)); y += 2) for (let x = Math.max(0, Math.round(b.x)); x < Math.min(width, Math.round(b.x + b.w)); x += 2) { hn++; if (dist(last, (y * width + x) * 3, bg) > 160) hi++; }
    headline_ink = hn ? hi / hn : 0;
  }
  const signature: number[] = [];
  for (let cy = 0; cy < 9; cy++) for (let cx = 0; cx < 16; cx++) {
    let s = 0, c = 0;
    for (let y = Math.floor((cy * height) / 9); y < Math.floor(((cy + 1) * height) / 9); y += 3) for (let x = Math.floor((cx * width) / 16); x < Math.floor(((cx + 1) * width) / 16); x += 3) { const i = (y * width + x) * 3; s += 0.299 * last[i]! + 0.587 * last[i + 1]! + 0.114 * last[i + 2]!; c++; }
    signature.push(c ? s / c : 0);
  }
  return { scene_id: scene.scene_id, coverage: ink / n, motion, change: mad(first, last), end_hold: frames.length > 1 ? mad(frames[frames.length - 2]!, last) : 0, edge_ink: edge / Math.max(1, en), headline_ink, signature };
}

export async function verifyCompositionScenes(video: string, scenes: readonly CompositionScene[], width: number, height: number, opts: FidelityOptions): Promise<FidelityResult & { measures: SceneMeasure[] }> {
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  const problems: string[] = [];
  const measures: SceneMeasure[] = [];
  for (const sc of scenes) {
    const at = `scene ${sc.scene_id}`;
    const marks = [0.02, 0.2, 0.4, 0.6, 0.8, 1].map((f) => sc.from_frame + Math.min(sc.frames - 1, Math.round(f * (sc.frames - 1))));
    let frames: Buffer[];
    try { frames = await Promise.all(marks.map((n) => rawFrame(video, n, width, height, ffmpegPath))); } catch { problems.push(`${at}: its frames could not be read back from the output`); continue; }
    if (frames.some((f) => f.length < width * height * 3)) { problems.push(`${at}: its frames are missing from the output`); continue; }
    const m = measureFrames(frames, sc);
    measures.push(m);
    // a scene of uploaded pictures is judged by comparing its frames with those files (asset-validation.ts), not by what a drawn scene should look like
    if (sc.visual.block === "asset_stage") continue;
    const bg = rgb(sc.palette.background);
    // the bottom-left corner: a gradient glows at the top right, so this one stays on the plain background
    const ci = (Math.round(height * 0.97) * width + Math.round(width * 0.03)) * 3;
    if (dist(frames[0]!, ci, bg) > 110) problems.push(`${at}: the scene is not on its approved background colour ${sc.palette.background}`);
    if (m.coverage < 0.025) problems.push(`${at}: almost nothing is drawn (${(m.coverage * 100).toFixed(1)}% of the last frame differs from the background)`);
    if (m.coverage > 0.88) problems.push(`${at}: the frame is almost entirely covered (${(m.coverage * 100).toFixed(0)}%), so there is no hierarchy or breathing space`);
    if (m.edge_ink > 0.01) problems.push(`${at}: content reaches the frame edge (${(m.edge_ink * 100).toFixed(1)}% of the edge ring), which means something is clipped or off its margin`);
    if (m.motion < 0.4 || m.change < 0.8) problems.push(`${at}: the scene hardly moves (largest step ${m.motion.toFixed(2)}, start to end ${m.change.toFixed(2)} of 255), but it was planned as an animated composition`);
    if (m.headline_ink !== null && m.headline_ink < 0.012) problems.push(`${at}: the headline area is empty on the last frame`);
  }
  return {
    problems, measures,
    limitations: [
      "Compositions were measured on six frames of each scene: background colour, how much is drawn, the frame edge, headline ink and movement. Text was not read back by OCR and its spelling was not compared against the plan.",
      "These checks find missing, clipped, blank, crowded and static scenes. They do not judge whether a design is good.",
    ],
  };
}
