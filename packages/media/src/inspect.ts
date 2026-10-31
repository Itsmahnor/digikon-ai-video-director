import { execFile } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type { ImageTechnical, ImageVisual, NormBox } from "@digikon/contracts";

const run = promisify(execFile);

/** Formats a renderer can load as they are. Anything else, an EXIF-rotated file or a very large one gets a normalized copy. */
const DIRECT = new Set(["png", "jpeg", "webp"]);
const MAX_RENDER_EDGE = 4096;
const MIMES: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", tiff: "image/tiff", bmp: "image/bmp", avif: "image/avif" };
const EXTS: Record<string, readonly string[]> = { png: [".png"], jpeg: [".jpg", ".jpeg"], webp: [".webp"], gif: [".gif"], tiff: [".tif", ".tiff"], bmp: [".bmp"], avif: [".avif"] };

/** The format the file's own first bytes prove, so a renamed file is caught. Null when they match nothing known. */
export async function sniffImageFormat(path: string): Promise<string | null> {
  const fh = await open(path, "r");
  try {
    const b = Buffer.alloc(16);
    await fh.read(b, 0, 16, 0);
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
    if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
    if (b.toString("latin1", 0, 3) === "GIF") return "gif";
    if (b.toString("latin1", 0, 2) === "BM") return "bmp";
    if (b.toString("latin1", 0, 4) === "II*\0" || b.toString("latin1", 0, 4) === "MM\0*") return "tiff";
    if (b.toString("latin1", 4, 8) === "ftyp" && /avi[fs]/.test(b.toString("latin1", 8, 12))) return "avif";
    return null;
  } finally { await fh.close(); }
}

/** A sharp pipeline for the file. BMP is not read by sharp, so FFmpeg decodes it. */
async function loader(path: string, format: string, ffmpegPath: string): Promise<ReturnType<typeof sharp>> {
  if (format !== "bmp") return sharp(path, { animated: false, failOn: "error", limitInputPixels: 268_402_689 });
  const { stdout } = await run(ffmpegPath, ["-v", "error", "-i", path, "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "-"], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024, timeout: 30_000, windowsHide: true });
  return sharp(stdout as unknown as Buffer);
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
const round = (n: number) => Math.round(n * 10000) / 10000;

export interface PixelFacts {
  transparent_share: number;
  content_box: NormBox;
  dominant_colours: ImageVisual["dominant_colours"];
  background: ImageVisual["background"];
  composition: ImageVisual["composition"];
}

/** Measures small RGBA pixels: transparency, the box content sits in, its main colours and its background. It says nothing about what is shown. */
export function measureRgba(px: Buffer, w: number, h: number): PixelFacts {
  const at = (x: number, y: number) => (y * w + x) * 4;
  let see = 0;
  const ring: number[][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = at(x, y);
    if (px[i + 3]! < 32) see++;
    else if (x === 0 || y === 0 || x === w - 1 || y === h - 1) ring.push([px[i]!, px[i + 1]!, px[i + 2]!]);
  }
  const total = w * h, ringTotal = 2 * (w + h) - 4;
  const transparent_share = see / total;
  const ringMean = [0, 1, 2].map((c) => ring.reduce((a, p) => a + p[c]!, 0) / Math.max(1, ring.length)) as [number, number, number];
  const ringSpread = ring.reduce((a, p) => a + Math.abs(p[0]! - ringMean[0]) + Math.abs(p[1]! - ringMean[1]) + Math.abs(p[2]! - ringMean[2]), 0) / Math.max(1, ring.length) / 3;
  const openEdge = ring.length < ringTotal * 0.5;
  const flatEdge = !openEdge && ringSpread < 6;

  const isContent = (i: number) => px[i + 3]! >= 32 && (!flatEdge || Math.abs(px[i]! - ringMean[0]) + Math.abs(px[i + 1]! - ringMean[1]) + Math.abs(px[i + 2]! - ringMean[2]) > 30);
  let x0 = w, y0 = h, x1 = -1, y1 = -1, ink = 0;
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = at(x, y);
    if (px[i + 3]! >= 32) {
      const q = ((px[i]! >> 4) << 8) | ((px[i + 1]! >> 4) << 4) | (px[i + 2]! >> 4);
      const c = counts.get(q) ?? { n: 0, r: 0, g: 0, b: 0 };
      c.n++; c.r += px[i]!; c.g += px[i + 1]!; c.b += px[i + 2]!;
      counts.set(q, c);
    }
    if (!isContent(i)) continue;
    ink++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const opaque = total - see;
  const dominant_colours = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 6).map((c) => ({ hex: hex(c.r / c.n, c.g / c.n, c.b / c.n), share: round(c.n / Math.max(1, opaque)) }));
  const content_box: NormBox = x1 < 0 ? { x: 0, y: 0, w: 1, h: 1 } : { x: round(x0 / w), y: round(y0 / h), w: round((x1 - x0 + 1) / w), h: round((y1 - y0 + 1) / h) };

  const bright = 0.299 * ringMean[0] + 0.587 * ringMean[1] + 0.114 * ringMean[2];
  const sat = Math.max(...ringMean) - Math.min(...ringMean);
  const background: ImageVisual["background"] = openEdge ? { kind: "transparent", colour: null }
    : flatEdge ? { kind: sat > 30 ? "flat_colour" : bright > 200 ? "flat_light" : bright < 60 ? "flat_dark" : "flat_colour", colour: hex(...ringMean) }
    : ringSpread < 22 ? { kind: "gradient", colour: hex(...ringMean) } : { kind: "busy", colour: null };

  const cx = content_box.x + content_box.w / 2, cy = content_box.y + content_box.h / 2;
  const area = content_box.w * content_box.h;
  const subject_position = area > 0.8 ? "full_frame" : Math.abs(cx - 0.5) < 0.12 && Math.abs(cy - 0.5) < 0.12 ? "center" : Math.abs(cx - 0.5) >= Math.abs(cy - 0.5) ? (cx < 0.5 ? "left" : "right") : cy < 0.5 ? "top" : "bottom";
  return { transparent_share: round(transparent_share), content_box, dominant_colours, background, composition: { subject_position, fill_share: round(ink / total) } };
}

export type InspectResult =
  | { ok: true; technical: ImageTechnical; facts: PixelFacts }
  | { ok: false; code: "unsupported_format" | "corrupt" | "too_large" | "unreadable"; message: string; retryable: boolean };

/** Everything FFprobe and the image library can establish. A file that does not decode is reported, not guessed about. */
export async function inspectImage(path: string, opts: { ffprobePath?: string; ffmpegPath?: string } = {}): Promise<InspectResult> {
  let bytes: number;
  try { bytes = (await stat(path)).size; } catch { return { ok: false, code: "unreadable", message: "The uploaded file is not on disk.", retryable: false }; }
  const format = await sniffImageFormat(path).catch(() => null);
  if (!format) return { ok: false, code: "unsupported_format", message: `The file's contents are not a supported picture (PNG, JPEG, WebP, GIF, TIFF, BMP or AVIF), whatever its name says.`, retryable: false };
  const ext = extname(path).toLowerCase();
  let color_space: string | null = null, pixel_format: string | null = null;
  try {
    const { stdout } = await run(opts.ffprobePath ?? "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,color_space", "-of", "json", path], { timeout: 15_000, windowsHide: true });
    const st = (JSON.parse(stdout) as { streams?: { pix_fmt?: string; color_space?: string }[] }).streams?.[0];
    pixel_format = st?.pix_fmt ?? null; color_space = st?.color_space ?? null;
  } catch { /* the image library below decides whether the file is usable */ }
  try {
    const img = await loader(path, format, opts.ffmpegPath ?? "ffmpeg");
    const meta = await img.metadata();
    if (!meta.width || !meta.height) return { ok: false, code: "corrupt", message: "The picture has no readable size.", retryable: false };
    const swap = (meta.orientation ?? 1) >= 5;
    const width = swap ? meta.height : meta.width, height = swap ? meta.width : meta.height;
    const scale = Math.min(1, 256 / Math.max(width, height));
    const sw = Math.max(1, Math.round(width * scale)), sh = Math.max(1, Math.round(height * scale));
    const px = await img.clone().rotate().resize(sw, sh, { fit: "fill" }).ensureAlpha().raw().toBuffer();
    const facts = measureRgba(px, sw, sh);
    const technical: ImageTechnical = {
      format, mime: MIMES[format]!, extension_matches: (EXTS[format] ?? []).includes(ext), bytes, width, height, aspect_ratio: round(width / height),
      color_space: color_space ?? meta.space ?? null, pixel_format, decodes: true, has_alpha_channel: !!meta.hasAlpha, transparent_share: facts.transparent_share, content_box: facts.content_box, animated: (meta.pages ?? 1) > 1,
    };
    return { ok: true, technical, facts };
  } catch (e) {
    return { ok: false, code: "corrupt", message: `The picture could not be decoded, so it may be damaged: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`, retryable: false };
  }
}

export interface DerivedFiles { thumbnail_path: string; normalized_path: string | null; trimmed_path: string | null; normalize_reason: string | null; normalized_size: { width: number; height: number } | null; trimmed_size: { width: number; height: number } | null }

/** Writes the thumbnail and any copies the renderers need. The original is only ever read. */
export async function deriveFiles(path: string, technical: ImageTechnical, outDir: string, opts: { ffmpegPath?: string } = {}): Promise<DerivedFiles> {
  await mkdir(outDir, { recursive: true });
  const img = await loader(path, technical.format, opts.ffmpegPath ?? "ffmpeg");
  const thumbnail_path = join(outDir, "thumb.png");
  await img.clone().rotate().resize(360, 360, { fit: "inside", withoutEnlargement: true }).png().toFile(thumbnail_path);
  const meta = await img.metadata();
  const reasons: string[] = [];
  if (!DIRECT.has(technical.format)) reasons.push(`${technical.format.toUpperCase()} is not loaded directly by the renderers`);
  if (Math.max(technical.width, technical.height) > MAX_RENDER_EDGE) reasons.push(`it is ${technical.width}x${technical.height}, larger than the ${MAX_RENDER_EDGE}px the renderers take`);
  if ((meta.orientation ?? 1) !== 1) reasons.push("its EXIF rotation is applied");
  if (!technical.extension_matches) reasons.push(`its extension does not match its ${technical.format.toUpperCase()} contents`);
  let normalized_path: string | null = null, normalized_size: DerivedFiles["normalized_size"] = null;
  if (reasons.length) {
    normalized_path = join(outDir, "normalized.png");
    const out = await img.clone().rotate().resize(MAX_RENDER_EDGE, MAX_RENDER_EDGE, { fit: "inside", withoutEnlargement: true }).png().toFile(normalized_path);
    normalized_size = { width: out.width, height: out.height };
  }
  const b = technical.content_box;
  let trimmed_path: string | null = null, trimmed_size: DerivedFiles["trimmed_size"] = null;
  if (b.w * b.h < 0.8) {
    const pad = 0.012;
    const left = Math.max(0, Math.floor((b.x - pad) * technical.width)), top = Math.max(0, Math.floor((b.y - pad) * technical.height));
    const width = Math.min(technical.width - left, Math.ceil((b.w + 2 * pad) * technical.width)), height = Math.min(technical.height - top, Math.ceil((b.h + 2 * pad) * technical.height));
    trimmed_path = join(outDir, "trimmed.png");
    await sharp(await img.clone().rotate().png().toBuffer()).extract({ left, top, width, height }).png().toFile(trimmed_path);
    trimmed_size = { width, height };
  }
  return { thumbnail_path, normalized_path, trimmed_path, normalize_reason: reasons.length ? reasons.join("; ") : null, normalized_size, trimmed_size };
}
