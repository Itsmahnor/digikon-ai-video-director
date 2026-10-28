import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ComposedScene } from "./web-composed.js";
import { checkText, inkIn, rawFrame, referenceText, rgb, type FidelityOptions, type FidelityResult } from "./verify.js";
import type { WebScene } from "./web-scenes.js";

const run = promisify(execFile);
const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** The supplied image fitted to the frame (cover) and carried to the state it has on the scene's last frame. */
async function referenceMoved(dir: string, sc: ComposedScene, width: number, height: number, ffmpegPath: string): Promise<Buffer> {
  const im = sc.image!;
  await copyFile(im.uri, join(dir, `ref-moved${im.ext}`));
  const cover = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  const m = im.move;
  const z = m.kind === "zoom" || m.kind === "punch" ? m.to : m.kind === "crop" ? m.zoom : m.scale;
  const sh = m.kind === "pan" ? { x: -m.dx1 * width, y: -m.dy1 * height } : m.kind === "crop" ? { x: (m.cx - 0.5) * width * m.zoom, y: (m.cy - 0.5) * height * m.zoom } : { x: 0, y: 0 };
  const moved = z === 1 && !sh.x && !sh.y ? "" : `,scale=iw*${z.toFixed(5)}:ih*${z.toFixed(5)},crop=${width}:${height}:(iw-${width})/2+(${sh.x.toFixed(3)}):(ih-${height})/2+(${sh.y.toFixed(3)})`;
  const { stdout } = await run(ffmpegPath, ["-v", "error", "-i", `ref-moved${im.ext}`, "-vf", `${cover}${moved},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"], { cwd: dir, encoding: "buffer", maxBuffer: width * height * 3 + 4096, timeout: 60_000, windowsHide: true });
  return stdout as unknown as Buffer;
}

/** The supplied logo fitted into the middle half of the frame (contain) on the scene's background: the state of a logo reveal on its last frame. */
async function referenceLogo(dir: string, sc: ComposedScene, width: number, height: number, ffmpegPath: string): Promise<Buffer> {
  const lg = sc.logo!;
  await copyFile(lg.uri, join(dir, `ref-logo${lg.ext}`));
  const bw = Math.round(width * 0.5), bh = Math.round(height * 0.5);
  const { stdout } = await run(ffmpegPath, ["-v", "error", "-i", `ref-logo${lg.ext}`, "-vf", `scale=${bw}:${bh}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x${sc.background.replace("#", "")},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"], { cwd: dir, encoding: "buffer", maxBuffer: width * height * 3 + 4096, timeout: 60_000, windowsHide: true });
  return stdout as unknown as Buffer;
}

/** Mean absolute colour difference, and the correlation of brightness, between two RGB buffers over the first `rows` rows. */
function compare(a: Buffer, b: Buffer, width: number, rows: number): { mad: number; corr: number; variance: number } {
  let diff = 0, n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = 0; y < rows; y += 2) for (let x = 0; x < width; x += 2) {
    const i = (y * width + x) * 3;
    diff += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
    const la = lum(a[i]!, a[i + 1]!, a[i + 2]!), lb = lum(b[i]!, b[i + 1]!, b[i + 2]!);
    sa += la; sb += lb; saa += la * la; sbb += lb * lb; sab += la * lb; n++;
  }
  const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
  return { mad: diff / (3 * n), corr: (sab / n - (sa / n) * (sb / n)) / Math.sqrt(Math.max(va, 1e-6) * Math.max(vb, 1e-6)), variance: vb };
}

/** Text as white-on-black, whatever its colours: how far each pixel is from the scene's background, scaled to the expected contrast. */
function contrastView(buf: Buffer, bg: [number, number, number], expected: number): Buffer {
  const out = Buffer.alloc(buf.length), lb = lum(...bg);
  for (let i = 0; i + 2 < buf.length; i += 3) { const v = Math.min(255, (Math.abs(lum(buf[i]!, buf[i + 1]!, buf[i + 2]!) - lb) * 255) / expected); out[i] = out[i + 1] = out[i + 2] = v; }
  return out;
}

const asWeb = (sc: ComposedScene): WebScene => ({
  operation_id: sc.scene_id, kind: "text", from_frame: sc.from_frame, frames: sc.frames, text: sc.text!.text, fade_in_s: 0.5, background: sc.background, accent: "#f5b942",
  line_count: sc.text!.lines.length, lines: sc.text!.lines, font_px: sc.text!.font_px, text_y: sc.text!.y, text_w: sc.text!.w, image: null,
});

/**
 * Checks each composed scene on its last frame against what was approved: the colours of a card, the supplied image at the end state of its
 * camera move, the approved text (present, in place, the right amount), the end card's accent bar, and, from frames inside the scene, that the
 * picture really moved and that delayed or staggered text really started when approved. Limits are returned with the result.
 */
export async function verifyComposedScenes(video: string, scenes: readonly ComposedScene[], width: number, height: number, opts: FidelityOptions): Promise<FidelityResult> {
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  const problems: string[] = [];
  const dir = await mkdtemp(join(opts.workRoot ?? tmpdir(), "verify-composed-"));
  try {
    await copyFile(opts.fontFile, join(dir, "font.ttf"));
    for (const sc of scenes) {
      const at = `scene ${sc.scene_id}`;
      const lastN = sc.from_frame + sc.frames - 1;
      let last: Buffer, first: Buffer;
      try { last = await rawFrame(video, lastN, width, height, ffmpegPath); first = await rawFrame(video, sc.from_frame, width, height, ffmpegPath); } catch { problems.push(`${at}: its frames could not be read back from the output`); continue; }
      if (last.length < width * height * 3 || first.length < width * height * 3) { problems.push(`${at}: its frames are missing from the output`); continue; }
      const bg = rgb(sc.background);
      if (!sc.image) {
        if (Math.abs(last[0]! - bg[0]) > 24 || Math.abs(last[1]! - bg[1]) > 24 || Math.abs(last[2]! - bg[2]) > 24) problems.push(`${at}: the background colour is not ${sc.background}`);
      }
      if (sc.image) {
        try {
          const ref = await referenceMoved(dir, sc, width, height, ffmpegPath);
          const rows = Math.round(height * (sc.text ? 0.68 : 1));
          const c = compare(last, ref, width, rows);
          if (c.mad > 28) problems.push(`${at}: the image on screen is not the supplied image ${sc.image.asset_id} at the end of its camera move (colour difference ${c.mad.toFixed(0)} of 255, allowed 28)`);
          else if (c.variance > 100 && c.corr < 0.9) problems.push(`${at}: the image on screen does not have the structure of the supplied image ${sc.image.asset_id} at the end of its camera move (match ${c.corr.toFixed(2)}, needs 0.90)`);
          // the camera must really move: the first and last frames of a structured picture differ
          const d = compare(last, first, width, rows);
          if (sc.image.move.kind !== "crop" && c.variance > 100 && d.mad < 1.5) problems.push(`${at}: the camera move is not visible (the first and last frames differ by ${d.mad.toFixed(1)} of 255)`);
        } catch (e) { problems.push(`${at}: the supplied image could not be compared (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`); }
      }
      if (sc.logo) {
        try {
          const ref = await referenceLogo(dir, sc, width, height, ffmpegPath);
          const c = compare(last, ref, width, height);
          if (c.mad > 28) problems.push(`${at}: the logo on screen is not the supplied logo ${sc.logo.asset_id} (colour difference ${c.mad.toFixed(0)} of 255, allowed 28)`);
          else if (c.variance > 100 && c.corr < 0.9) problems.push(`${at}: the logo on screen does not have the structure of the supplied logo ${sc.logo.asset_id} (match ${c.corr.toFixed(2)}, needs 0.90)`);
          // it reveals: at the first frame the logo is not yet there
          const d = compare(first, last, width, height);
          if (c.variance > 100 && d.mad < 1.5) problems.push(`${at}: the logo does not reveal (the first and last frames differ by ${d.mad.toFixed(1)} of 255)`);
        } catch (e) { problems.push(`${at}: the supplied logo could not be compared (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`); }
      }
      if (sc.text && sc.text.mode === "lower_third") {
        // The lower third has left again by the last frame, so it is measured in its hold, and its absence before and after is measured too.
        try {
          const t = sc.text;
          const cy = t.y * height, half = (t.lines.length * t.font_px * 1.3) / 2 + t.font_px * 0.6 + 16;
          const left = Math.round(width * ((1 - t.w) / 2)), right = Math.round(width * (1 - (1 - t.w) / 2));
          const frameAt = (n: number) => rawFrame(video, n, width, height, ffmpegPath);
          // text ink inside the bar's columns, and the brightness of a strip of the bar's padding, where there is never any text
          const measure = async (n: number) => { const b = await frameAt(n); const k = inkIn(b, width, height, cy - half, cy + half); let ink = 0; for (let x = left + 2; x < right - 2; x++) ink += k.cols[x]!; let l = 0, m = 0; for (let y = Math.round(cy - t.font_px * 0.5); y < Math.round(cy + t.font_px * 0.5); y++) for (let x = left + 3; x < left + 17; x++) { const i = (y * width + x) * 3; l += lum(b[i]!, b[i + 1]!, b[i + 2]!); m++; } return { ink, luma: l / m, x0: k.x0 }; };
          const first = await measure(sc.from_frame), hold = await measure(sc.from_frame + t.slide_frames + Math.floor(t.hold_frames / 2)), last = await measure(lastN);
          if (hold.ink < 100) problems.push(`${at}: the lower-third text is not on screen while it should be held (${Math.round(hold.ink)} ink units)`);
          if (first.ink > 0.05 * hold.ink + (sc.image ? hold.ink * 0.9 : 0) && !sc.image) problems.push(`${at}: the lower third is already on screen on the scene's first frame`);
          if (last.ink > 0.05 * hold.ink + (sc.image ? hold.ink * 0.9 : 0) && !sc.image) problems.push(`${at}: the lower third has not left by the scene's last frame`);
          if (sc.image) {
            // over a picture, the dark bar is what comes and goes: the strip of padding is much darker while held than before and after
            if (first.luma > 30 && last.luma > 30) {
              if (hold.luma > 0.5 * first.luma) problems.push(`${at}: the lower third's bar is already there on the scene's first frame, or never arrives`);
              if (hold.luma > 0.5 * last.luma) problems.push(`${at}: the lower third has not left by the scene's last frame`);
            }
          } else {
            const mid = await measure(sc.from_frame + Math.max(1, Math.floor(t.slide_frames / 2)));
            if (!(mid.x0 < hold.x0 - 4 || mid.ink < 0.6 * hold.ink)) problems.push(`${at}: the lower third does not slide in (halfway through the slide it is already in place)`);
          }        } catch (e) { problems.push(`${at}: the lower third could not be checked (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`); }
      } else if (sc.text) {
        try {
          const web = asWeb(sc);
          const view = (b: Buffer) => (sc.image ? b : contrastView(b, bg, Math.abs(lum(...(rgb(sc.text!.color) as [number, number, number])) - lum(...bg))));
          const refText = await referenceText(dir, web, width, height, ffmpegPath);
          checkText(web, view(last), refText, width, height, problems);
          const mass = (b: Buffer) => { const half = (web.lines.length * web.font_px * 1.3) / 2 + web.font_px * 0.6, cy = web.text_y * height; return inkIn(view(b), width, height, cy - half, cy + half).count; };
          const full = mass(last);
          const t = sc.text;
          // approved timing: nothing before the delay, the text complete after it
          if (t.mode === "fade_up" && t.delay_frames > 2) {
            const early = mass(await rawFrame(video, sc.from_frame + t.delay_frames - 2, width, height, ffmpegPath));
            if (early > 0.03 * full) problems.push(`${at}: the text is already on screen before its approved delay of ${t.delay_frames} frames`);
            const done = mass(await rawFrame(video, Math.min(lastN, sc.from_frame + t.delay_frames + t.duration_frames + 1), width, height, ffmpegPath));
            if (done < 0.85 * full) problems.push(`${at}: the text is not fully on screen when its approved entrance ends`);
          }
          if (t.mode === "stagger" && t.words.length > 1) {
            const mid = mass(await rawFrame(video, Math.min(lastN, sc.from_frame + t.delay_frames + Math.floor(((t.words.length - 1) * t.stagger_frames) / 2) + Math.floor(t.word_frames / 2)), width, height, ffmpegPath));
            if (!(mid > 0.05 * full && mid < 0.9 * full)) problems.push(`${at}: the words do not appear one after another (a quarter-way through the stagger ${Math.round((mid / Math.max(full, 1)) * 100)}% of the text is visible)`);
          }
          if (t.mode === "fade_up" && t.distance_px >= 8) {
            const early = await rawFrame(video, sc.from_frame + t.delay_frames, width, height, ffmpegPath);
            const mid = await rawFrame(video, Math.min(lastN, sc.from_frame + t.delay_frames + Math.max(1, Math.round(t.duration_frames * 0.6))), width, height, ffmpegPath);
            // over a picture the window stays inside the caption strip, so bright parts of the picture are never counted as text
            const cy = (b: Buffer) => { const full = (web.lines.length * web.font_px * 1.3) / 2 + web.font_px * 0.6 + t.distance_px, strip = (web.lines.length * web.font_px * 1.2) / 2 + 22, half = sc.image ? Math.min(full, strip) : full, c0 = web.text_y * height; return inkIn(view(b), width, height, c0 - half, c0 + half).cy; };
            if (!(cy(mid) - cy(last) > t.distance_px * 0.15)) problems.push(`${at}: the text does not rise into place (it should enter ${t.distance_px}px lower)`);
            void early;
          }
        } catch (e) { problems.push(`${at}: the approved text could not be checked (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`); }
      }
      if (sc.end_card) {
        const acc = rgb(sc.end_card.accent), i = ((Math.round(height * 0.72) + 3) * width + Math.round(width * 0.5)) * 3;
        if (Math.abs(last[i]! - acc[0]) + Math.abs(last[i + 1]! - acc[1]) + Math.abs(last[i + 2]! - acc[2]) > 90) problems.push(`${at}: the end card's accent bar is missing`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return {
    problems,
    limitations: [
      "Composed scenes were checked on their last frame, plus the first frame and one frame inside the animation, by pixel comparison. They were not read by OCR and the other frames were not compared.",
      "Text is matched on ink area, position and (for one line of 28 px or more) the outline of the glyphs against a reference drawn from the same font file; a different word with an almost identical outline could pass.",
      "A camera move is checked by the supplied image at its end state and by the picture differing between the first and last frame; its easing curve is not measured frame by frame.",
      "An image that is flat in colour can only be matched by its colour, and its movement cannot be seen at all.",
    ],
  };
}
