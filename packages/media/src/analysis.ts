import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Asset, AssetNotes, ImageMeasure } from "@digikon/contracts";
import { describeMeasure } from "./image.js";

const run = promisify(execFile);

export interface Span { start: number; end: number }

/** Everything measured from the file itself. No model is involved. */
export interface MediaAnalysis {
  duration_s: number;
  silence: Span[];
  black: Span[];
  freeze: Span[];
  /** Times of detected cuts between shots. */
  shots: number[];
  loudness: { integrated_lufs: number | null; true_peak_db: number | null } | null;
  keyframes: { t: number; path: string }[];
  warnings: string[];
}

export interface AnalysisOptions {
  hasVideo: boolean;
  hasAudio: boolean;
  duration_s: number;
  /** Where to save sampled frames for the later vision pass. Omit to skip frame extraction. */
  framesDir?: string;
  framePrefix?: string;
  maxFrames?: number;
  timeoutMs?: number;
}

// ---------- parsers (pure, unit tested) ----------

const num = (s: string) => Number.parseFloat(s);

/** Pairs "silence_start / silence_end" lines. An unclosed start runs to the end of the file. */
export function parseSilence(log: string, duration: number): Span[] {
  const out: Span[] = [];
  let open: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, num(s[1]!));
    if (e && open !== null) { out.push({ start: open, end: num(e[1]!) }); open = null; }
  }
  if (open !== null && duration > open) out.push({ start: open, end: duration });
  return out.filter((r) => r.end > r.start);
}

export function parseBlack(log: string): Span[] {
  return [...log.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)].map((m) => ({ start: num(m[1]!), end: num(m[2]!) })).filter((r) => r.end > r.start);
}

export function parseFreeze(log: string, duration: number): Span[] {
  const out: Span[] = [];
  let open: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const s = /freeze_start:\s*([\d.]+)/.exec(line);
    const e = /freeze_end:\s*([\d.]+)/.exec(line);
    if (s) open = num(s[1]!);
    if (e && open !== null) { out.push({ start: open, end: num(e[1]!) }); open = null; }
  }
  if (open !== null && duration > open) out.push({ start: open, end: duration }); // video ends on a still frame
  return out.filter((r) => r.end > r.start);
}

export function parseShots(log: string): number[] {
  return [...new Set([...log.matchAll(/pts_time:([\d.]+)/g)].map((m) => Math.round(num(m[1]!) * 100) / 100))].filter((t) => t > 0.2).sort((a, b) => a - b);
}

export function parseLoudness(log: string): { integrated_lufs: number | null; true_peak_db: number | null } {
  // The summary block at the end of the log is the last "I:" and the last "Peak:" under "True peak".
  const integrated = [...log.matchAll(/^\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/gm)].at(-1)?.[1];
  const peak = [...log.matchAll(/^\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/gm)].at(-1)?.[1];
  const val = (v?: string) => (v === undefined || v === "-inf" ? null : num(v));
  return { integrated_lufs: val(integrated), true_peak_db: val(peak) };
}

/** Removes the given spans from [0, duration] and keeps pieces that are long enough to use. */
export function subtractSpans(duration: number, remove: Span[], minLen = 0.5): Span[] {
  const sorted = [...remove].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.start > cursor) out.push({ start: cursor, end: Math.min(r.start, duration) });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < duration) out.push({ start: cursor, end: duration });
  return out.filter((s) => s.end - s.start >= minLen).map((s) => ({ start: round(s.start), end: round(s.end) }));
}
const round = (n: number) => Math.round(n * 1000) / 1000;

// ---------- ffmpeg passes ----------

async function ffmpegLog(args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return stderr;
  } catch (e) {
    // ffmpeg exits non-zero on partial failures; keep whatever it logged so a bad stream does not hide the rest.
    const err = e as { stderr?: string; killed?: boolean };
    if (err.killed) throw new Error("analysis timed out");
    return err.stderr ?? "";
  }
}

/** Measures silence, black frames, frozen frames, cuts and loudness. One decode pass for the detectors, one more for cuts. */
export async function analyseMedia(path: string, opts: AnalysisOptions): Promise<MediaAnalysis> {
  const timeout = opts.timeoutMs ?? 180_000;
  const warnings: string[] = [];
  const result: MediaAnalysis = { duration_s: opts.duration_s, silence: [], black: [], freeze: [], shots: [], loudness: null, keyframes: [], warnings };

  const args = ["-i", path];
  if (opts.hasVideo) args.push("-vf", "blackdetect=d=0.3:pic_th=0.98:pix_th=0.10,freezedetect=n=0.003:d=1");
  else args.push("-vn");
  if (opts.hasAudio) args.push("-af", "silencedetect=noise=-35dB:d=0.5,ebur128=peak=true");
  else args.push("-an");
  args.push("-f", "null", "-");

  try {
    const log = await ffmpegLog(args, timeout);
    if (opts.hasAudio) {
      result.silence = parseSilence(log, opts.duration_s);
      result.loudness = parseLoudness(log);
    }
    if (opts.hasVideo) {
      result.black = parseBlack(log);
      result.freeze = parseFreeze(log, opts.duration_s);
    }
  } catch (e) { warnings.push(`measurement skipped: ${e instanceof Error ? e.message : String(e)}`); }

  if (opts.hasVideo) {
    try {
      const log = await ffmpegLog(["-i", path, "-an", "-vf", "select='gt(scene,0.35)',showinfo", "-f", "null", "-"], timeout);
      result.shots = parseShots(log);
    } catch (e) { warnings.push(`shot detection skipped: ${e instanceof Error ? e.message : String(e)}`); }

    if (opts.framesDir) {
      await mkdir(opts.framesDir, { recursive: true });
      const max = opts.maxFrames ?? 6;
      const usable = subtractSpans(opts.duration_s, [...result.black, ...result.freeze], 0.4);
      const times = pickFrameTimes(usable.length ? usable : [{ start: 0, end: opts.duration_s }], result.shots, max);
      for (const [i, t] of times.entries()) {
        const out = join(opts.framesDir, `${opts.framePrefix ?? "frame"}_${String(i + 1).padStart(2, "0")}.jpg`);
        try {
          await run("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", path, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", out], { timeout: 30_000 });
          result.keyframes.push({ t, path: out });
        } catch { warnings.push(`could not extract a frame at ${t}s`); }
      }
    }
  }
  return result;
}

/** Evenly spread sample times inside usable spans, nudged just after cuts so each shot is represented. */
export function pickFrameTimes(usableSpans: Span[], shots: number[], max: number): number[] {
  // Stay clear of the edges: detectors report boundaries to the nearest frame, and an edge frame may be black or frozen.
  const MARGIN = 0.15;
  const usable = usableSpans.map((s) => (s.end - s.start > 4 * MARGIN ? { start: s.start + MARGIN, end: s.end - MARGIN } : s));
  const inUsable = (t: number) => usable.some((s) => t >= s.start && t < s.end);
  const total = usable.reduce((a, s) => a + (s.end - s.start), 0);
  if (total <= 0 || max <= 0) return [];
  const times = new Set<number>();
  for (const cut of shots) if (inUsable(cut + 0.3)) times.add(round(cut + 0.3));
  let want = Math.max(0, max - times.size);
  if (times.size > max) return [...times].sort((a, b) => a - b).slice(0, max);
  // fill with evenly spaced points across usable time
  for (let i = 0; i < want; i++) {
    let target = ((i + 0.5) / want) * total;
    for (const s of usable) { const len = s.end - s.start; if (target < len) { times.add(round(s.start + target)); break; } target -= len; }
  }
  return [...times].sort((a, b) => a - b).slice(0, max);
}

// ---------- notes ----------

/**
 * Deterministic asset notes from measurements. Black and frozen stretches are not usable; silence is flagged but
 * stays usable. Content is left empty and marked uncertain until a vision pass has looked at the footage.
 */
export function buildAssetNotes(
  asset: Asset,
  a: MediaAnalysis | null,
  speech: { language: string; text: string; word_count: number } | null = null,
  image: ImageMeasure | null = null,
): AssetNotes {
  const duration = asset.duration ?? 0;
  const lowRes = asset.width !== null && asset.height !== null && Math.min(asset.width, asset.height) < 720;
  const flags: AssetNotes["quality_flags"] = [];
  const unusable: Span[] = [];
  if (a) {
    for (const r of a.black) { flags.push({ flag: "black_frames", start: r.start, end: r.end }); unusable.push(r); }
    for (const r of a.freeze) { flags.push({ flag: "frozen", start: r.start, end: r.end }); unusable.push(r); }
    for (const r of a.silence) flags.push({ flag: "silence", start: r.start, end: r.end });
  }
  if (lowRes && duration > 0) flags.push({ flag: "low_resolution", start: 0, end: duration });

  const uncertain = image
    ? ["Nobody has reviewed what this picture shows. Do not assume it shows people, a product, a place or any particular content; only its kind was measured."]
    : ["Content has not been looked at by a vision pass: the summary is empty. Do not assume what the footage shows."];
  if (!a && asset.media_type !== "image") uncertain.push("Measurements were not available: usable segments assume the whole file is usable.");
  for (const w of a?.warnings ?? []) uncertain.push(w);

  return {
    asset_id: asset.asset_id,
    usable_segments: asset.media_type === "image" || duration <= 0 ? [] : subtractSpans(duration, unusable),
    quality_flags: flags,
    content_summary: image ? describeMeasure(image) : "",
    uncertain,
    transcript_ref: speech ? `transcript:${asset.asset_id}` : asset.transcript_ref,
    shots: a?.shots ?? [],
    loudness_lufs: a?.loudness?.integrated_lufs ?? null,
    speech,
    keyframe_refs: a?.keyframes.map((k) => k.path) ?? [],
    image_measure: image,
    visual_review: null,
  };
}
