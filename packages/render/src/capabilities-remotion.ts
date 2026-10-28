import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EditorOperation, RenderSettings } from "@digikon/contracts";
import type { RenderJob } from "./adapter.js";
import { registerFamily, type CapabilityFamily, type CatalogEntry, type FamilyImpl, type VariantOutcome } from "./capabilities.js";
import { findChrome, selectRemotionBrowser } from "./browser.js";
import { createHyperframesAdapter } from "./hyperframes.js";
import { validateOutput } from "./output.js";
import { createRemotionAdapter } from "./remotion.js";
import { inkIn, rawFrame } from "./verify.js";
import type { ComposedTemplate } from "./web-composed.js";

const run = promisify(execFile);

/**
 * Validators for the Remotion scene families (camera moves, text motions, end cards). A family is validated by rendering a synthetic film for
 * real through the Remotion adapter, and by measuring the frames independently of the adapter's own content check: the picture really
 * scales or shifts by the approved amount, the text really starts at the approved delay, the words really appear one after another, and a
 * card really has the colours of its variant. The adapter's own verification still runs inside every render.
 */

const W = 640, H = 360, FPS = 30, SECONDS = 3;

/** The Remotion capabilities this build can validate, as templates the adapter understands. */
export const templateOf = (e: Pick<CatalogEntry, "template" | "family" | "motion" | "operation_type">): ComposedTemplate => ({ template: e.template, family: e.family as ComposedTemplate["family"], type: (e.operation_type ?? "overlay_text") as ComposedTemplate["type"], motion: e.motion ?? "" });

/** A reference camera template used only inside the validation film of a text motion, to prove text over a moving picture. It is never registered by being used here. */
const referenceCamera = (engine: string): ComposedTemplate => ({ template: `${engine}/slow-push-in`, family: "camera_move", type: "trim_clip", motion: "zoom_in" });

const stripes = (dir: string, ffmpegPath: string): string => {
  const file = join(dir, "stripes.png");
  // a dark picture with three white vertical stripes (the centre one is 200 px wide in the 1280 px source) and one white horizontal bar, at known places
  execFileSync(ffmpegPath, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x203040:s=1280x720:d=1:r=1", "-vf", "drawbox=x=540:y=0:w=200:h=720:color=white:t=fill,drawbox=x=180:y=0:w=60:h=720:color=white:t=fill,drawbox=x=1040:y=0:w=60:h=720:color=white:t=fill,drawbox=x=0:y=100:w=1280:h=60:color=white:t=fill", "-frames:v", "1", file], { windowsHide: true });
  return file;
};

const op = (id: string, scene: string, type: "trim_clip" | "overlay_text" | "render_graphics_scene", params: Record<string, string | number>, caption: { text: string; start: number } | null, assetIds: string[], recipe: string) => EditorOperation.parse({
  operation_id: id, target_scene_id: scene, operation_type: type, parameters: params, preconditions: [], expected_result: "capability validation", validation_status: "unvalidated",
  source_use_id: `U${id.slice(1)}`, recipe_id: recipe, recipe_version: "0.0.1", asset_ids: assetIds, timing: { start_s: 0, duration_s: SECONDS },
  caption: caption ? { text: caption.text, start_s: caption.start, end_s: SECONDS } : null, audio_cues: [],
});

interface Film { out: string; job: Omit<RenderJob, "signal">; render: () => Promise<{ ok: true; checks: string[]; sha256: string; bytes: number; width: number; height: number; fps: number; duration_s: number } | { ok: false; reasons: string[] }> }

/** A one-scene synthetic film for one template, and how to render and validate it as a file. */
function film(candidates: readonly ComposedTemplate[], entry: CatalogEntry, ops: ReturnType<typeof op>[], templates: Record<string, string>, imagePath: string | null, opts: { fontFile: string; ffmpegPath?: string }, workRoot: string): Film {
  const outDir = join(workRoot, "out");
  mkdirSync(outDir, { recursive: true });
  const render_id = `rn_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const job: Omit<RenderJob, "signal"> = {
    render_id,
    settings: RenderSettings.parse({ aspect_ratio: "16:9", width: W, height: H, fps: FPS, duration_s: SECONDS, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "capability validation values, not a platform specification" } }),
    operations: ops, templates,
    assets: imagePath ? [{ asset_id: "asset_cap00001", media_type: "image", uri: imagePath }] : [], clips: [], asset_info: {}, concept_asset_ids: [], output_path: join(outDir, `${render_id}.mp4`),
  };
  return {
    out: job.output_path, job,
    render: async () => {
      let adapter;
      const engineName = entry.engine === "hyperframes" ? "HyperFrames" : "Remotion";
      try { adapter = entry.engine === "hyperframes" ? createHyperframesAdapter({ fontFile: opts.fontFile, outputRoot: outDir, workRoot, learned: candidates }) : createRemotionAdapter({ fontFile: opts.fontFile, outputRoot: outDir, workRoot, learned: candidates }); } catch (e) { return { ok: false, reasons: [`${entry.template}: ${engineName} cannot start: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`] }; }
      const issues = adapter.check?.(job) ?? [];
      if (issues.length) return { ok: false, reasons: issues.map((i) => `${entry.template}: the adapter refuses the validation film: ${i}`) };
      try { await adapter.render({ ...job, signal: new AbortController().signal }); } catch (e) { return { ok: false, reasons: [`${entry.template}: the render failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 400)}`] }; }
      const checked = await validateOutput(job.output_path, job.settings, false);
      if (!checked.ok) return { ok: false, reasons: checked.issues.map((i) => `${entry.template}: ${i}`) };
      return { ok: true, checks: [`validateOutput passed: ${checked.output.width}x${checked.output.height} at ${checked.output.fps} fps, ${checked.output.duration_s}s, h264, no audio`, "the adapter's own content check passed on the rendered scene"], sha256: checked.output.sha256, bytes: checked.output.bytes, width: checked.output.width, height: checked.output.height, fps: checked.output.fps, duration_s: checked.output.duration_s };
    },
  };
}

const bright = (buf: Buffer, row: number): number[] => { const xs: number[] = []; for (let x = 0; x < W; x++) { const i = (row * W + x) * 3; if (Math.min(buf[i]!, buf[i + 1]!, buf[i + 2]!) > 200) xs.push(x); } return xs; };
/** The centre white stripe as [left edge, right edge], looked for around the middle of a row. */
const centreStripe = (buf: Buffer): [number, number] | null => {
  const xs = bright(buf, Math.round(H / 2));
  if (!xs.length) return null;
  // the run of bright pixels nearest the middle
  const runs: [number, number][] = []; let s = xs[0]!, p = xs[0]!;
  for (const x of xs.slice(1)) { if (x !== p + 1) { runs.push([s, p]); s = x; } p = x; }
  runs.push([s, p]);
  return runs.sort((a, b) => Math.abs((a[0] + a[1]) / 2 - W / 2) - Math.abs((b[0] + b[1]) / 2 - W / 2))[0]!;
};

async function validateCamera(entry: CatalogEntry, variant: string | null, opts: { fontFile: string; ffmpegPath?: string }, workRoot: string): Promise<VariantOutcome> {
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  mkdirSync(workRoot, { recursive: true });
  const image = stripes(workRoot, ffmpegPath);
  const params: Record<string, string | number> = entry.motion === "zoom_in" ? { scale_end: 1.2, easing: "linear" } : entry.motion === "zoom_out" ? { scale_start: 1.3, easing: "linear" } : entry.motion === "punch" ? { scale_end: 1.3, zoom_duration_s: 0.4 } : entry.motion === "crop" ? { center_x_pct: 60, center_y_pct: 40, zoom: 2 } : { direction: variant ?? "right", distance_pct: 10 };
  const t = templateOf(entry);
  const f = film([t], entry, [op("E01", "S01", "trim_clip", params, null, ["asset_cap00001"], entry.recipe_id)], { E01: entry.template }, image, opts, workRoot);
  const r = await f.render();
  if (!r.ok) return r;
  const first = await rawFrame(f.out, 0, W, H, ffmpegPath), last = await rawFrame(f.out, SECONDS * FPS - 1, W, H, ffmpegPath);
  const a = centreStripe(first), b = centreStripe(last);
  if (!a || !b) return { ok: false, reasons: [`${entry.template}: the supplied image's centre stripe could not be found in the first or last frame`] };
  const wa = a[1] - a[0] + 1, wb = b[1] - b[0] + 1, ca = (a[0] + a[1]) / 2, cb = (b[0] + b[1]) / 2;
  const checks = [...r.checks];
  const reasons: string[] = [];
  if (entry.motion === "zoom_in") {
    const ratio = wb / wa;
    if (Math.abs(ratio - 1.2) > 0.05) reasons.push(`${entry.template}: the picture scaled by ${ratio.toFixed(2)} from the first to the last frame, not the approved 1.2`); else checks.push(`the picture grows by ${ratio.toFixed(2)}x (approved 1.2x): the stripe is ${wa}px wide at the start and ${wb}px at the end`);
  } else if (entry.motion === "zoom_out") {
    const ratio = wb / wa;
    if (Math.abs(ratio - 1 / 1.3) > 0.04) reasons.push(`${entry.template}: the picture scaled by ${ratio.toFixed(2)} from the first to the last frame, not the approved ${(1 / 1.3).toFixed(2)}`); else checks.push(`the picture shrinks by ${ratio.toFixed(2)}x (approved ${(1 / 1.3).toFixed(2)}x): the stripe is ${wa}px wide at the start and ${wb}px at the end`);
  } else if (entry.motion === "punch") {
    // a fast zoom that lands: most of the growth is done early, the end state is the approved scale, and it is held
    const at = async (n: number) => centreStripe(await rawFrame(f.out, n, W, H, ffmpegPath));
    const early = await at(4), landed = await at(14);
    const ratio = wb / wa;
    if (Math.abs(ratio - 1.3) > 0.05) reasons.push(`${entry.template}: the picture scaled by ${ratio.toFixed(2)} from the first to the last frame, not the approved 1.3`); else checks.push(`the picture grows by ${ratio.toFixed(2)}x (approved 1.3x): the stripe is ${wa}px wide at the start and ${wb}px at the end`);
    if (!early || !landed) reasons.push(`${entry.template}: the stripe could not be found during the punch-in`);
    else {
      const re = (early[1] - early[0] + 1) / wa, rl = (landed[1] - landed[0] + 1) / wa;
      if (Math.abs(rl - ratio) > 0.04) reasons.push(`${entry.template}: the punch-in has not landed by 0.47 s (${rl.toFixed(2)}x against ${ratio.toFixed(2)}x at the end)`); else checks.push(`the punch-in lands within its approved 0.4 s: ${rl.toFixed(2)}x at 0.47 s`);
      if (!(re > 1.1 && re < rl - 0.03)) reasons.push(`${entry.template}: the zoom is not a fast ease-out (${re.toFixed(2)}x at 0.13 s, ${rl.toFixed(2)}x when landed)`); else checks.push(`the zoom is under way at 0.13 s (${re.toFixed(2)}x) and still short of its end state`);
    }
  } else if (entry.motion === "crop") {
    // a static tighter crop: the centre stripe is 200 px wide at 2x, and sits where the approved centre puts it; nothing moves
    const wantW = 200, wantC = W * (0.5 + 2 * (0.5 - 0.6));
    if (Math.abs(wb - wantW) > 8) reasons.push(`${entry.template}: the stripe is ${wb}px wide in the crop, not the ${wantW}px a 2x crop gives`); else checks.push(`the crop magnifies by 2x: the stripe is ${wb}px wide (expected ${wantW}px)`);
    if (Math.abs(cb - wantC) > 8) reasons.push(`${entry.template}: the cropped detail is centred ${cb.toFixed(0)}px across, not the approved ${wantC.toFixed(0)}px`); else checks.push(`the crop is centred on the approved detail: the stripe is at ${cb.toFixed(0)}px (expected ${wantC.toFixed(0)}px)`);
    if (Math.abs(ca - cb) > 2 || Math.abs(wa - wb) > 2) reasons.push(`${entry.template}: the crop moves during the scene, and it should be still`); else checks.push("the crop does not move during the scene");
  } else {
    // the centre stripe moves by the approved share of the frame, in the approved direction; the stripes are vertical, so only left and right are measurable on a row
    if (variant === "left" || variant === "right") {
      const want = (variant === "right" ? -1 : 1) * 0.1 * W;
      if (Math.abs(cb - ca - want) > 6) reasons.push(`${entry.template}: the picture moved ${(cb - ca).toFixed(0)}px ${variant}, not the approved ${want.toFixed(0)}px`); else checks.push(`the pan ${variant} moves the picture ${(cb - ca).toFixed(0)}px (approved ${want.toFixed(0)}px)`);
    } else {
      // up and down: the white horizontal bar (60 px tall in the 720 px source) is followed down a column that has no vertical stripe
      const barAt = (buf: Buffer): number | null => { const ys: number[] = []; for (let y = 0; y < H; y++) { const i = (y * W + 450) * 3; if (Math.min(buf[i]!, buf[i + 1]!, buf[i + 2]!) > 200) ys.push(y); } return ys.length ? (ys[0]! + ys.at(-1)!) / 2 : null; };
      const ya = barAt(first), yb = barAt(last);
      if (ya === null || yb === null) reasons.push(`${entry.template}: the picture's horizontal bar could not be found in the ${variant} pan`);
      else {
        const want = (variant === "up" ? 1 : -1) * 0.1 * H;
        if (Math.abs(yb - ya - want) > 6) reasons.push(`${entry.template}: the picture moved ${(yb - ya).toFixed(0)}px vertically in the ${variant} pan, not the approved ${want.toFixed(0)}px`); else checks.push(`the ${variant} pan moves the picture ${(yb - ya).toFixed(0)}px (approved ${want.toFixed(0)}px)`);
      }
    }
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, render: { variant: variant ?? "fixed", sha256: r.sha256, bytes: r.bytes, width: r.width, height: r.height, fps: r.fps, duration_s: r.duration_s }, checks };
}

async function validateText(entry: CatalogEntry, variant: string | null, opts: { fontFile: string; ffmpegPath?: string }, workRoot: string): Promise<VariantOutcome> {
  if (entry.motion === "lower_third") return validateLowerThird(entry, variant, opts, workRoot);
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  mkdirSync(workRoot, { recursive: true });
  const over = variant === "over_image";
  const params: Record<string, string | number> = entry.motion === "fade_up" ? { delay_s: 0.5, duration_s: 0.5, distance_px: 40 } : { stagger_ms: 100, word_duration_s: 0.3 };
  const delay = entry.motion === "fade_up" ? 0.5 : 0;
  const text = entry.motion === "stagger" ? "One two three four" : "Approved headline";
  const t = templateOf(entry);
  const ops = [op("E01", "S01", "overlay_text", params, { text, start: delay }, [], entry.recipe_id)];
  const templates: Record<string, string> = { E01: entry.template };
  const cands: ComposedTemplate[] = [t];
  let image: string | null = null;
  if (over) {
    image = stripes(workRoot, ffmpegPath);
    ops.push(op("E02", "S01", "trim_clip", { scale_end: 1.1, easing: "linear" }, null, ["asset_cap00001"], "slow-push-in"));
    const ref = referenceCamera(entry.engine); templates["E02"] = ref.template; cands.push(ref);
  }
  const f = film(cands, entry, ops, templates, image, opts, workRoot);
  const r = await f.render();
  if (!r.ok) return r;
  const checks = [...r.checks], reasons: string[] = [];
  const frame = (n: number) => rawFrame(f.out, n, W, H, ffmpegPath);
  const band = (buf: Buffer) => inkIn(buf, W, H, over ? H * 0.84 - 34 : H * 0.5 - 60, over ? H * 0.84 + 34 : H * 0.5 + 60); // over a picture the window stays inside the caption strip
  const end = SECONDS * FPS - 1;
  const full = band(await frame(end));
  if (full.count < 200) return { ok: false, reasons: [`${entry.template}: the approved text is not visible on the last frame`] };
  if (entry.motion === "fade_up") {
    const dFrames = Math.round(delay * FPS);
    const early = band(await frame(Math.max(0, dFrames - 2)));
    const mid = band(await frame(dFrames + 9)), done = band(await frame(Math.min(end, dFrames + 20)));
    if (early.count > 0.03 * full.count) reasons.push(`${entry.template}: the text is on screen ${early.count} ink units before its approved delay of ${delay}s`); else checks.push(`nothing is on screen before the approved delay (${delay}s): ${Math.round(early.count)} ink units against ${Math.round(full.count)} at the end`);
    if (mid.count <= 0) reasons.push(`${entry.template}: the text has not started 9 frames after its approved delay`); else checks.push("the text has started 9 frames after the approved delay");
    if (done.count < 0.85 * full.count) reasons.push(`${entry.template}: the text is not complete when its approved entrance has finished`); else checks.push("the text is complete once the approved entrance has finished");
    if (!(mid.cy - full.cy > 40 * 0.2)) reasons.push(`${entry.template}: the text does not rise into place (centre ${mid.cy.toFixed(1)} against ${full.cy.toFixed(1)} at the end)`); else checks.push(`the text rises into place: ${(mid.cy - full.cy).toFixed(1)}px lower early in the entrance`);
  } else {
    const e1 = band(await frame(5)), e2 = band(await frame(14)); // 100 ms apart, 0.3 s each: at frame 5 the first words are partly in, at frame 14 most are
    if (!(e1.count > 0 && e1.count < 0.7 * full.count)) reasons.push(`${entry.template}: the words do not start one by one (${Math.round((e1.count / full.count) * 100)}% visible at 0.17 s)`); else checks.push(`only part of the text is visible early (${Math.round((e1.count / full.count) * 100)}% at 0.17 s)`);
    if (!(e2.count > e1.count && e2.count < 0.98 * full.count + 1) || !(e1.x1 < full.x1)) reasons.push(`${entry.template}: the words do not appear in order`); else checks.push("more words appear as time passes and the first word is on screen before the last");
  }
  if (over) checks.push("the text animation works over a camera-moved supplied image");
  return reasons.length ? { ok: false, reasons } : { ok: true, render: { variant: variant ?? "fixed", sha256: r.sha256, bytes: r.bytes, width: r.width, height: r.height, fps: r.fps, duration_s: r.duration_s }, checks };
}

async function validateLowerThird(entry: CatalogEntry, variant: string | null, opts: { fontFile: string; ffmpegPath?: string }, workRoot: string): Promise<VariantOutcome> {
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  const align = variant === "center" ? "center" : "left";
  const f = film([templateOf(entry)], entry, [op("E01", "S01", "overlay_text", { align, hold_s: 1 }, { text: "Approved lower third", start: 0 }, [], entry.recipe_id)], { E01: entry.template }, null, opts, workRoot);
  const r = await f.render();
  if (!r.ok) return r;
  const checks = [...r.checks], reasons: string[] = [];
  const ink = async (n: number) => inkIn(await rawFrame(f.out, n, W, H, ffmpegPath), W, H, H * 0.84 - 40, H * 0.84 + 40);
  // 12 frames in, 30 held, 12 out
  const first = await ink(0), mid = await ink(12 + 15), sliding = await ink(5), last = await ink(SECONDS * FPS - 1);
  if (mid.count < 150) return { ok: false, reasons: [`${entry.template}: the approved text is not on screen while the lower third is held`] };
  if (first.count > 0.05 * mid.count) reasons.push(`${entry.template}: the lower third is on screen at the first frame`); else checks.push("nothing is on screen at the first frame: the lower third has not slid in yet");
  if (!(sliding.x0 < mid.x0 - 4 || sliding.count < 0.7 * mid.count)) reasons.push(`${entry.template}: the lower third does not slide in (it is in place 0.17 s into the slide)`); else checks.push("the lower third is still sliding in at 0.17 s, short of its place");
  if (last.count > 0.05 * mid.count) reasons.push(`${entry.template}: the lower third has not left by the last frame`); else checks.push("the lower third has slid out again by the last frame");
  const cx = (mid.x0 + mid.x1) / 2;
  if (align === "left") { if (Math.abs(mid.x0 - (W * 0.1 + 20)) > 12) reasons.push(`${entry.template}: the left-aligned text starts at ${mid.x0}px, not near the box edge`); else checks.push(`the text is left-aligned in its box (starts at ${mid.x0}px)`); }
  else if (Math.abs(cx - W / 2) > 14) reasons.push(`${entry.template}: the centred text is centred at ${cx.toFixed(0)}px, not ${W / 2}px`); else checks.push(`the text is centred in its box (${cx.toFixed(0)}px)`);
  return reasons.length ? { ok: false, reasons } : { ok: true, render: { variant: align, sha256: r.sha256, bytes: r.bytes, width: r.width, height: r.height, fps: r.fps, duration_s: r.duration_s }, checks };
}

async function validateLogo(entry: CatalogEntry, variant: string | null, opts: { fontFile: string; ffmpegPath?: string }, workRoot: string): Promise<VariantOutcome> {
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  mkdirSync(workRoot, { recursive: true });
  const logo = join(workRoot, "logo.png");
  execFileSync(ffmpegPath, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=400x300:d=1:r=1", "-frames:v", "1", logo], { windowsHide: true });
  const f = film([templateOf(entry)], entry, [op("E01", "S01", "render_graphics_scene", { scale_from: 0.9, duration_s: 0.8 }, null, ["asset_cap00001"], entry.recipe_id)], { E01: entry.template }, logo, opts, workRoot);
  const r = await f.render();
  if (!r.ok) return r;
  const checks = [...r.checks], reasons: string[] = [];
  const spread = (buf: Buffer, x0: number, y0: number, x1: number, y1: number) => { let s = 0, ss = 0, n = 0; for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const i = (y * W + x) * 3, l = 0.299 * buf[i]! + 0.587 * buf[i + 1]! + 0.114 * buf[i + 2]!; s += l; ss += l * l; n++; } const m = s / n; return Math.sqrt(Math.max(0, ss / n - m * m)); };
  const first = await rawFrame(f.out, 0, W, H, ffmpegPath), mid = await rawFrame(f.out, 6, W, H, ffmpegPath), last = await rawFrame(f.out, SECONDS * FPS - 1, W, H, ffmpegPath);
  // a 4:3 logo fitted inside the middle half of a 640 x 360 frame is 240 x 180 at x 200 to 440, y 90 to 270
  const logoSpread = spread(last, 220, 100, 420, 260), firstSpread = spread(first, 220, 100, 420, 260);
  if (logoSpread < 20) reasons.push(`${entry.template}: the supplied logo is not visible on the last frame`); else checks.push(`the supplied logo is on screen at the end (brightness spread ${logoSpread.toFixed(0)})`);
  if (firstSpread > 5) reasons.push(`${entry.template}: the logo is already fully there at the first frame, so nothing is revealed`); else checks.push("nothing of the logo is visible at the first frame: it is revealed");
  if (!(spread(mid, 220, 100, 420, 260) > 2 && spread(mid, 220, 100, 420, 260) < logoSpread)) reasons.push(`${entry.template}: the logo is not part-way revealed 0.2 s in`); else checks.push("the logo is part-way revealed at 0.2 s");
  const outside = spread(last, 0, 0, 160, 360), cornerOk = [last[0]!, last[1]!, last[2]!].every((v, i) => Math.abs(v - [22, 33, 62][i]!) < 16);
  if (outside > 5 || !cornerOk) reasons.push(`${entry.template}: the area around the logo is not the plain background`); else checks.push("the logo sits on the plain background, with nothing else drawn");
  return reasons.length ? { ok: false, reasons } : { ok: true, render: { variant: "fixed", sha256: r.sha256, bytes: r.bytes, width: r.width, height: r.height, fps: r.fps, duration_s: r.duration_s }, checks };
}

async function validateCard(entry: CatalogEntry, variant: string | null, opts: { fontFile: string; ffmpegPath?: string }, workRoot: string): Promise<VariantOutcome> {
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  const f = film([templateOf(entry)], entry, [op("E01", "S01", "render_graphics_scene", { hold_s: 2, background: variant ?? "brand" }, { text: "Book your table", start: 0 }, [], entry.recipe_id)], { E01: entry.template }, null, opts, workRoot);
  const r = await f.render();
  if (!r.ok) return r;
  const last = await rawFrame(f.out, SECONDS * FPS - 1, W, H, ffmpegPath);
  const px = [last[0]!, last[1]!, last[2]!];
  const luma = 0.299 * px[0]! + 0.587 * px[1]! + 0.114 * px[2]!;
  const ok = variant === "light" ? luma > 200 : variant === "dark" ? luma < 30 : luma > 20 && luma < 70;
  const ink = inkIn(last.length ? Buffer.from(last) : last, W, H, 0, H - 1);
  void ink;
  const checks = [...r.checks];
  if (!ok) return { ok: false, reasons: [`${entry.template}: the ${variant} card has the wrong background (luma ${luma.toFixed(0)})`] };
  checks.push(`the ${variant} card has its own background (luma ${luma.toFixed(0)})`);
  return { ok: true, render: { variant: variant ?? "fixed", sha256: r.sha256, bytes: r.bytes, width: r.width, height: r.height, fps: r.fps, duration_s: r.duration_s }, checks };
}

const packageVersion = (name: string): string => { try { return (createRequire(import.meta.url)(`${name}/package.json`) as { version: string }).version; } catch { return "unknown"; } };

/**
 * A fingerprint of the code a scene is drawn by: the composed-scene planner and its content check and, for Remotion, every file of the Remotion project, for HyperFrames the
 * composition builder. When any of them change, earlier validation evidence no longer describes the code and is relearned.
 */
export const implementationHash = (engine: string): string => {
  try {
    const h = createHash("sha256");
    for (const f of ["web-composed.ts", "web-composed-verify.ts"]) h.update(f).update(readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url))));
    if (engine === "hyperframes") for (const f of ["hyperframes.ts", "hyperframes-composed.ts"]) h.update(f).update(readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url))));
    else {
      const dir = fileURLToPath(new URL("../remotion-project/", import.meta.url));
      for (const f of readdirSync(dir).filter((x) => /\.(jsx?|tsx?|json)$/.test(x)).sort()) h.update(f).update(readFileSync(join(dir, f)));
    }
    return h.digest("hex").slice(0, 16);
  } catch { return "unknown"; }
};

function impl(family: CapabilityFamily, variants: (e: CatalogEntry) => (string | null)[], validate: FamilyImpl["validate"]): FamilyImpl {
  return {
    unavailable: (e) => {
      if (e.engine === "hyperframes") return findChrome() ? null : "no Chrome is installed for HyperFrames (nothing is downloaded)";
      if (e.engine !== "remotion") return `no ${e.engine} implementation of the ${family} family exists in this build`;
      return selectRemotionBrowser().path ? null : "no compatible 64-bit browser is installed for Remotion (nothing is downloaded)";
    },
    versions: async (o, entry) => {
      const ffmpeg_version = execFileSync(o.ffmpegPath ?? "ffmpeg", ["-version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 }).split(/\r?\n/)[0]!.trim();
      if (entry.engine === "hyperframes") { const chrome = findChrome(); return { ffmpeg_version, browser: chrome ? `${basename(chrome)}; hyperframes ${packageVersion("hyperframes")}; scenes ${implementationHash("hyperframes")}` : null, needs: [] }; }
      const b = selectRemotionBrowser();
      return { ffmpeg_version, browser: b.path ? `${basename(b.path)} ${b.bits}; remotion ${packageVersion("remotion")}; scenes ${implementationHash("remotion")}` : null, needs: [] };
    },
    variants,
    validate: (e, v, o, w) => validate(e, v, o, w),
  };
}

registerFamily("camera_move", impl("camera_move", (e) => (e.motion === "pan" ? ["right", "left", "up", "down"] : [null]), validateCamera as FamilyImpl["validate"]));
registerFamily("text_motion", impl("text_motion", (e) => (e.motion === "lower_third" ? ["left", "center"] : [null, "over_image"]), validateText as FamilyImpl["validate"]));
registerFamily("logo_reveal", impl("logo_reveal", () => [null], validateLogo as FamilyImpl["validate"]));
registerFamily("end_card", impl("end_card", () => ["brand", "dark", "light"], validateCard as FamilyImpl["validate"]));
void run;
