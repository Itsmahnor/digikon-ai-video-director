import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WebScene } from "./web-scenes.js";

const run = promisify(execFile);

/** Decodes one frame of a finished video to raw RGB. Arguments as an array, no shell. */
async function rawFrame(video: string, n: number, width: number, height: number, ffmpegPath: string): Promise<Buffer> {
  const { stdout } = await run(ffmpegPath, ["-v", "error", "-i", video, "-vf", `select=eq(n\\,${n}),format=rgb24`, "-frames:v", "1", "-fps_mode", "passthrough", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: width * height * 3 + 4096, timeout: 60_000, windowsHide: true });
  return stdout as unknown as Buffer;
}

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/**
 * The first, cheapest layer. A finished file can have the right size, length and codec and still be blank. This looks at the last frame of
 * every approved scene (when everything has faded in) and requires it to show more than the plain background colour. It does not say
 * whether the content is the approved content; `verifySceneFidelity` does that as far as it can.
 */
export async function verifySceneContent(video: string, scenes: readonly WebScene[], width: number, height: number, ffmpegPath = "ffmpeg"): Promise<string[]> {
  const problems: string[] = [];
  const minChanged = Math.max(40, Math.round(width * height * 0.0004));
  for (const sc of scenes) {
    const n = sc.from_frame + sc.frames - 1;
    let buf: Buffer;
    try { buf = await rawFrame(video, n, width, height, ffmpegPath); } catch { problems.push(`${sc.operation_id}: its last frame (${n}) could not be read back from the output`); continue; }
    if (buf.length < width * height * 3) { problems.push(`${sc.operation_id}: its last frame (${n}) is missing from the output`); continue; }
    const [br, bg, bb] = rgb(sc.background);
    if (Math.abs(buf[0]! - br) > 24 || Math.abs(buf[1]! - bg) > 24 || Math.abs(buf[2]! - bb) > 24) problems.push(`${sc.operation_id}: the scene's background colour is not ${sc.background}`);
    let changed = 0;
    for (let i = 0; i + 2 < buf.length; i += 3) if (Math.abs(buf[i]! - br) + Math.abs(buf[i + 1]! - bg) + Math.abs(buf[i + 2]! - bb) > 90) changed++;
    if (changed < minChanged) problems.push(`${sc.operation_id}: the scene shows only its background (${changed} other pixels in frame ${n}); its ${sc.kind === "image" ? "image and caption were" : "text was"} not drawn`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// Second layer: is it the approved text and the supplied image, in the right scene, in the right place?
// There is no OCR here. The text is compared with a reference that FFmpeg draws from the same font file, the image with a reference
// scaling of the source file. What that can and cannot establish is returned with the result, never left implied.
// ---------------------------------------------------------------------------------------------------------------------

export interface FidelityResult {
  problems: string[];
  /** What the checks above cannot establish. Kept with the render record so no one reads the video as proven exact. */
  limitations: string[];
}

export interface FidelityOptions {
  /** The font file the scene text was drawn with. */
  fontFile: string;
  ffmpegPath?: string;
  workRoot?: string;
}

/** How much of a pixel is text: 0 for every background and accent colour used, 1 for white, in between for anti-aliased edges. */
const coverage = (r: number, g: number, b: number) => Math.max(0, Math.min(1, (Math.min(r, g, b) - 70) / 185));
const dist = (a: readonly number[], b: readonly number[]) => Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!);

interface Ink { count: number; x0: number; x1: number; y0: number; y1: number; cols: number[]; cy: number }

/** Text coverage inside a band of rows (the whole width), from raw RGB: its total, outline across the columns and bounding box. */
function inkIn(buf: Buffer, width: number, height: number, y0: number, y1: number): Ink {
  const lo = Math.max(0, Math.floor(y0)), hi = Math.min(height - 1, Math.ceil(y1));
  const cols = new Array<number>(width).fill(0);
  let count = 0, x0 = width, x1 = -1, ya = height, yb = -1, ysum = 0;
  for (let y = lo; y <= hi; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const k = coverage(buf[i]!, buf[i + 1]!, buf[i + 2]!);
      if (k > 0.05) { count += k; cols[x]! += k; ysum += y * k; if (k > 0.3) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < ya) ya = y; if (y > yb) yb = y; } }
    }
  }
  return { count, x0, x1, y0: ya, y1: yb, cols, cy: count ? ysum / count : 0 };
}

/** Pearson correlation of two profiles after the second is stretched to the first one's length. */
function profileCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 4 || b.length < 4) return 0;
  const bs = Array.from({ length: n }, (_, i) => { const t = (i * (b.length - 1)) / (n - 1), j = Math.floor(t), f = t - j; return b[j]! * (1 - f) + (b[Math.min(j + 1, b.length - 1)] ?? b[j]!) * f; });
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = bs.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i]! - ma) * (bs[i]! - mb); da += (a[i]! - ma) ** 2; db += (bs[i]! - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** A reference of the approved text drawn by FFmpeg with the same font, white on black, centred where the scene places it. */
async function referenceText(dir: string, sc: WebScene, width: number, height: number, ffmpegPath: string): Promise<Buffer> {
  await writeFile(join(dir, "ref.txt"), sc.lines.join("\n"), "utf8");
  const cy = Math.round(sc.text_y * height);
  const vf = `drawtext=fontfile=font.ttf:textfile=ref.txt:expansion=none:fontcolor=white:fontsize=${sc.font_px}:x=(w-text_w)/2:y=${cy}-text_h/2:text_align=center,format=rgb24`;
  const { stdout } = await run(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:d=1:r=1`, "-vf", vf, "-frames:v", "1", "-f", "rawvideo", "-"], { cwd: dir, encoding: "buffer", maxBuffer: width * height * 3 + 4096, timeout: 60_000, windowsHide: true });
  return stdout as unknown as Buffer;
}

/** The source image fitted into its box the way the scene fits it, at the zoom reached on the scene's last frame. */
async function referenceImage(dir: string, sc: WebScene, ffmpegPath: string): Promise<Buffer> {
  const im = sc.image!, { w, h } = im.box;
  await copyFile(im.uri, join(dir, `ref-image${im.ext}`));
  const bg = sc.background.replace("#", "0x");
  const fit = im.fit === "contain" ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${bg}` : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  const z = im.motion === "slow_zoom" ? 1 + 0.12 * ((sc.frames - 1) / sc.frames) : 1;
  const zoom = z === 1 ? "" : `,scale=iw*${z.toFixed(5)}:ih*${z.toFixed(5)},crop=${w}:${h}`;
  const { stdout } = await run(ffmpegPath, ["-v", "error", "-i", `ref-image${im.ext}`, "-vf", `${fit}${zoom},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"], { cwd: dir, encoding: "buffer", maxBuffer: w * h * 3 + 4096, timeout: 60_000, windowsHide: true });
  return stdout as unknown as Buffer;
}

/** Below this size a browser and FFmpeg rasterise the same glyphs too differently for an outline match to mean anything (measured: 0.48 to 0.83 on correct 15 px text). */
const OUTLINE_MIN_PX = 28;

function checkText(sc: WebScene, actual: Buffer, ref: Buffer, width: number, height: number, problems: string[]): void {
  const at = `${sc.operation_id}`;
  const half = (sc.lines.length * sc.font_px * 1.3) / 2 + sc.font_px * 0.6, cy = sc.text_y * height;
  const a = inkIn(actual, width, height, cy - half, cy + half);
  const r = inkIn(ref, width, height, cy - half, cy + half);
  if (!r.count) { problems.push(`${at}: the reference for its approved text could not be drawn, so the text cannot be checked`); return; }
  // Browsers draw text heavier than FFmpeg does, and small text most of all (measured: up to 1.3x at 36 px, 1.6x at 15 px), so the window is wide;
  // it catches missing, truncated or grossly different text. Telling words apart is the job of the outline match below.
  if (a.count < r.count * 0.7 || a.count > r.count * 1.8) { problems.push(`${at}: the text has ${Math.round(a.count)} pixels of ink where the approved text "${sc.text.slice(0, 40)}" needs about ${Math.round(r.count)}`); return; }
  const cx = (a.x0 + a.x1) / 2 - (r.x0 + r.x1) / 2;
  if (Math.abs(cx) > width * 0.02) problems.push(`${at}: the text is ${Math.round(cx)} px off centre`);
  if (Math.abs(a.cy - r.cy) > height * 0.05) problems.push(`${at}: the text sits ${Math.round(a.cy - r.cy)} px away from where the scene places it`);
  const aw = a.x1 - a.x0 + 1, rw = r.x1 - r.x0 + 1;
  if (sc.lines.length === 1) {
    // one line: the outline of the glyphs across the line must match the reference, which tells different words of equal size apart
    if (Math.abs(aw - rw) > rw * 0.1) problems.push(`${at}: the text line is ${aw} px wide but the approved text "${sc.text.slice(0, 40)}" is about ${rw} px wide`);
    else if (sc.font_px >= OUTLINE_MIN_PX) {
      const corr = profileCorrelation(r.cols.slice(r.x0, r.x1 + 1), a.cols.slice(a.x0, a.x1 + 1));
      if (corr < 0.8) problems.push(`${at}: the text does not match the approved text "${sc.text.slice(0, 40)}" (outline match ${corr.toFixed(2)}, needs 0.80)`);
    }
  } else if (aw > width * sc.text_w * 1.03) problems.push(`${at}: the text is ${aw} px wide, wider than the ${Math.round(width * sc.text_w)} px it is allowed`);
}

/**
 * Checks, scene by scene on the last frame of the scene, that: the background is the approved colour; the approved text is present, in
 * the right place and the right amount (and, for one line, the right outline); a text scene's accent bar is there; an image scene shows
 * the supplied image fitted and zoomed as approved, with the concept label when one is required. The verdicts are as strong as pixel
 * comparison allows and no stronger: see `limitations`.
 */
export async function verifySceneFidelity(video: string, scenes: readonly WebScene[], width: number, height: number, opts: FidelityOptions): Promise<FidelityResult> {
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  const problems = await verifySceneContent(video, scenes, width, height, ffmpegPath);
  const smallText = scenes.some((s) => s.lines.length === 1 && s.font_px < OUTLINE_MIN_PX);
  const dir = await mkdtemp(join(opts.workRoot ?? tmpdir(), "verify-"));
  try {
    await copyFile(opts.fontFile, join(dir, "font.ttf"));
    for (const sc of scenes) {
      const n = sc.from_frame + sc.frames - 1;
      let actual: Buffer;
      try { actual = await rawFrame(video, n, width, height, ffmpegPath); } catch { continue; } // already reported by the first layer
      if (actual.length < width * height * 3) continue;
      try { checkText(sc, actual, await referenceText(dir, sc, width, height, ffmpegPath), width, height, problems); }
      catch (e) { problems.push(`${sc.operation_id}: the approved text could not be checked (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`); }

      if (sc.kind === "text") {
        const acc = rgb(sc.accent), i = ((Math.round(height * 0.8) + 3) * width + Math.round(width * 0.5)) * 3;
        if (dist([actual[i]!, actual[i + 1]!, actual[i + 2]!], acc) > 90) problems.push(`${sc.operation_id}: the scene's accent bar (${sc.accent}) is missing`);
        continue;
      }
      const im = sc.image!;
      try {
        const ref = await referenceImage(dir, sc, ffmpegPath);
        const { x, y, w, h } = im.box;
        let diff = 0, n3 = 0, ga = 0, gr = 0, gaa = 0, grr = 0, gar = 0;
        for (let yy = 0; yy < h; yy += 2) {
          for (let xx = 0; xx < w; xx += 2) {
            const ri = (yy * w + xx) * 3, ai = ((y + yy) * width + (x + xx)) * 3;
            if (ai + 2 >= actual.length) continue;
            diff += dist([actual[ai]!, actual[ai + 1]!, actual[ai + 2]!], [ref[ri]!, ref[ri + 1]!, ref[ri + 2]!]);
            const la = (actual[ai]! + actual[ai + 1]! + actual[ai + 2]!) / 3, lr = (ref[ri]! + ref[ri + 1]! + ref[ri + 2]!) / 3;
            ga += la; gr += lr; gaa += la * la; grr += lr * lr; gar += la * lr; n3++;
          }
        }
        const mad = diff / (3 * n3);
        if (mad > 28) problems.push(`${sc.operation_id}: the image on screen is not the supplied image ${im.asset_id} (average colour difference ${mad.toFixed(0)} of 255, allowed 28)`);
        else {
          const va = gaa / n3 - (ga / n3) ** 2, vr = grr / n3 - (gr / n3) ** 2;
          if (vr > 100) { // a picture with structure: its layout must match too
            const corr = (gar / n3 - (ga / n3) * (gr / n3)) / Math.sqrt(Math.max(va, 1e-6) * vr);
            if (corr < 0.9) problems.push(`${sc.operation_id}: the image on screen does not have the structure of the supplied image ${im.asset_id} (match ${corr.toFixed(2)}, needs 0.90)`);
          }
        }
        if (im.concept) {
          let white = 0;
          for (let yy = y + 12; yy < y + 40; yy++) for (let xx = x + 12; xx < x + 190; xx++) { const i = (yy * width + xx) * 3; if (i + 2 < actual.length && Math.min(actual[i]!, actual[i + 1]!, actual[i + 2]!) > 200) white++; }
          if (white < 20) problems.push(`${sc.operation_id}: the "Concept illustration" label required for ${im.asset_id} is not on screen`);
        }
      } catch (e) { problems.push(`${sc.operation_id}: the supplied image could not be compared (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`); }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return {
    problems,
    limitations: [
      "Content was checked on each scene's last frame only, by pixel comparison. It was not read by OCR and the in-between frames were not compared.",
      "Text is matched on ink area (within a wide window, because browsers draw text heavier than FFmpeg), position and (for a single line) the outline of the glyphs against a reference drawn from the same font file; a different word with an almost identical outline, or text in the wrong font of the same shape, could pass.",
      "Text that wraps over more than one line is matched on ink area, centre and width only, not on the outline of each line.",
      ...(smallText ? [`Text smaller than ${OUTLINE_MIN_PX} px (such as a caption under an image) is matched on ink area, position and line width only: at that size no outline comparison is reliable, so a different caption of the same length could pass.`] : []),
      "A supplied image is matched to a reference scaling of its file by colour and, when it has structure, by layout; an image that is flat in colour can only be matched by its colour.",
    ],
  };
}
