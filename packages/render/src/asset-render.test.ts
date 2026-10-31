import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EditorOperation, SceneAssetRef } from "@digikon/contracts";
import type { RenderJob } from "./adapter.js";
import { containRect, planLayers, plateColour, rectAt, type ResolvedAssetFile } from "./asset-layers.js";
import { MATCH_MIN, matchLayer, validateRenderedAssets } from "./asset-validation.js";
import { FFMPEG_ASSET_TEMPLATE, HYPERFRAMES_ASSET_TEMPLATE, planStage } from "./asset-stage.js";
import { findChrome, findRemotionBrowser } from "./browser.js";
import { COMPOSITION_TEMPLATE, planCompositionScenes, type CompositionScene } from "./composition.js";
import { EXAMPLE_ART_DIRECTION } from "./composition-examples.js";
import { createFfmpegAdapter } from "./ffmpeg.js";
import { createHyperframesStageAdapter } from "./hyperframes-stage.js";
import { createRemotionAdapter } from "./remotion.js";
import { realPrerequisites, skipReal } from "./test-env.js";
import { rawFrame } from "./verify.js";

const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
const hasRemotion = !!font && !!findRemotionBrowser();
const hasChrome = !!font && !!findChrome();
realPrerequisites({ font: !!font, remotion_browser: !!findRemotionBrowser() });

const tmp = mkdtempSync(join(tmpdir(), "asset-render-"));
const outputRoot = join(tmp, "out");
mkdirSync(outputRoot);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const W = 1280, H = 720, FPS = 30, SECONDS = 2;
const rid = () => `rn_${Math.random().toString(16).slice(2).padEnd(16, "0").slice(0, 16)}`;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

let logoFile: ResolvedAssetFile, photoFile: ResolvedAssetFile, otherFile: ResolvedAssetFile;

beforeAll(async () => {
  const logo = join(tmp, "logo.png"), photo = join(tmp, "photo.png"), other = join(tmp, "other.png");
  // a transparent 3:1 mark: a ring and bars, so shape and aspect both show
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><circle cx="150" cy="150" r="120" fill="#81d870"/><circle cx="150" cy="150" r="60" fill="none" stroke="#ffffff" stroke-width="30"/><rect x="320" y="60" width="520" height="60" fill="#81d870"/><rect x="320" y="180" width="360" height="60" fill="#f2c94c"/></svg>`)).png().toFile(logo);
  const scene = (a: string, b: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1600" height="900" fill="url(#g)"/><circle cx="420" cy="380" r="240" fill="#ffffff"/><rect x="820" y="180" width="560" height="520" fill="#101820"/><rect x="900" y="260" width="400" height="60" fill="#e8590c"/></svg>`);
  await sharp(scene("#1e3a8a", "#a7f3d0")).png().toFile(photo);
  await sharp(scene("#7f1d1d", "#fde68a")).flop().png().toFile(other);
  const file = (path: string, id: string, width: number, height: number, transparent: boolean, colours: string[]): ResolvedAssetFile => ({ asset_id: id, path, variant: "original", sha256: sha(path), width, height, transparent, background: null, colours });
  logoFile = file(logo, "asset_logo0001", 900, 300, true, ["#81d870", "#f2c94c"]);
  photoFile = file(photo, "asset_phot0001", 1600, 900, false, []);
  otherFile = file(other, "asset_othe0001", 1600, 900, false, []);
});

const ref = (over: Partial<SceneAssetRef> & { asset_id: string }): SceneAssetRef => ({ role: "hero", placement: "center", scale: 0.8, fit: "contain", crop: null, layer: 1, animation: "none", frame: "none", mandatory: true, reason: "test", ...over });
const op = (i: number): EditorOperation => ({ operation_id: `E${i + 1}`, target_scene_id: `S${String(i + 1).padStart(2, "0")}`, operation_type: "render_graphics_scene", parameters: {}, timing: { start_s: i * SECONDS, duration_s: SECONDS }, asset_ids: [], audio_cues: [], caption: null } as unknown as EditorOperation);

function film(template: string, scenes: { refs: SceneAssetRef[]; overlay?: string | null }[]): Omit<RenderJob, "signal"> {
  const id = rid();
  const files = () => Object.fromEntries([logoFile, photoFile, otherFile].map((f) => [f.asset_id, f]));
  return {
    render_id: id, settings: { aspect_ratio: "16:9", width: W, height: H, fps: FPS, duration_s: scenes.length * SECONDS, container: "mp4", video_codec: "h264", audio_codec: null, source: { type: "user_approved", reference: "test" } } as never,
    operations: scenes.map((_s, i) => op(i)), templates: Object.fromEntries(scenes.map((_s, i) => [`E${i + 1}`, template])), assets: [], clips: [], asset_info: {}, concept_asset_ids: [],
    scene_visuals: Object.fromEntries(scenes.map((s, i) => [`S${String(i + 1).padStart(2, "0")}`, { visual: { block: "asset_stage", backdrop: "flat", camera: "static", reveal: "none" }, overlay_text: s.overlay ?? null, visual_purpose: "test" }])),
    scene_assets: Object.fromEntries(scenes.map((s, i) => [`S${String(i + 1).padStart(2, "0")}`, { refs: s.refs, files: files() }])),
    art_direction: EXAMPLE_ART_DIRECTION, output_path: join(outputRoot, `${id}.mp4`),
  };
}

const plannedScenes = (job: Omit<RenderJob, "signal">, template: string): CompositionScene[] => {
  const p = template === COMPOSITION_TEMPLATE ? planCompositionScenes(job, { outputRoot }) : planStage(job, template, { outputRoot });
  if (!p.ok) throw new Error(p.issues.join("; "));
  return p.scenes;
};
const validate = (video: string, scenes: readonly CompositionScene[], uses: { scene_id: string; asset_id: string; role?: string; mandatory?: boolean }[]) => validateRenderedAssets(video, W, H, uses.map((u) => ({ role: "hero", mandatory: true, ...u })), scenes.map((s) => ({ scene_id: s.scene_id, from_frame: s.from_frame, frames: s.frames, rendered: true, reason: null, layers: s.asset_layers, occluders: s.headline ? [{ box: s.headline.box }] : [] })));

describe("laying out an uploaded picture", () => {
  it("keeps a logo's shape inside its box, and centres it", () => {
    const r = containRect(900, 300, { x: 100, y: 100, w: 600, h: 600 });
    expect(r.w / r.h).toBeCloseTo(3, 5);
    expect(r.x).toBe(100);
    expect(r.y + r.h / 2).toBeCloseTo(400, 5);
  });
  it("puts a panel behind a dark mark on a dark background, and not behind one that shows", () => {
    expect(plateColour({ transparent: true, background: null, colours: ["#1d3338", "#7cd67e"] }, "#03171d")).toBe("#ffffff");
    expect(plateColour({ transparent: true, background: null, colours: ["#81d870"] }, "#03171d")).toBeNull();
  });
  it("refuses a picture with no real file, instead of leaving it out", () => {
    const p = planLayers([ref({ asset_id: "asset_gone0001" })], {}, { width: W, height: H, fps: FPS, frames: 60, region: { x: 0, y: 0, w: W, h: H }, background: "#000000", overlay: false, motionSpeed: 1 });
    expect(p.issues.join(" ")).toMatch(/asset_gone0001 is not available/);
    expect(p.layers).toEqual([]);
  });
  it("keeps a picture on a drawn scene to a corner, at a small size", () => {
    const base = { width: W, height: H, fps: FPS, frames: 60, region: { x: 36, y: 36, w: W - 72, h: H - 72 }, background: "#000000", overlay: true, motionSpeed: 1 };
    const files = { [logoFile.asset_id]: logoFile };
    expect(planLayers([ref({ asset_id: logoFile.asset_id, placement: "center", scale: 0.2 })], files, base).issues.join(" ")).toMatch(/corner or along the top/);
    expect(planLayers([ref({ asset_id: logoFile.asset_id, placement: "top_right", scale: 0.2 })], files, base).issues).toEqual([]);
  });
  it("refuses a corner picture that would cover the scene's text", () => {
    const p = planLayers([ref({ asset_id: logoFile.asset_id, placement: "top_right", scale: 0.3 })], { [logoFile.asset_id]: logoFile }, { width: W, height: H, fps: FPS, frames: 60, region: { x: 36, y: 36, w: W - 72, h: H - 72 }, background: "#000000", overlay: true, motionSpeed: 1, keepClear: [{ x: 100, y: 40, w: 1100, h: 300 }] });
    expect(p.issues.join(" ")).toMatch(/would cover the scene's text/);
  });
  it("gives a wide screen the width of the frame, with the headline above it", () => {
    const job = film(COMPOSITION_TEMPLATE, [{ refs: [ref({ asset_id: photoFile.asset_id, scale: 1, frame: "browser" })], overlay: "Kinetic.OPS tracks clients in one dashboard" }]);
    const sc = plannedScenes(job, COMPOSITION_TEMPLATE)[0]!;
    expect(sc.headline!.box.y).toBeLessThan(sc.asset_layers[0]!.clip.y);
    expect(sc.asset_layers[0]!.clip.w).toBeGreaterThan(W * 0.55);
  });
  it("moves an end card's words down to make room for a logo above them", () => {
    const job = film(COMPOSITION_TEMPLATE, [{ refs: [ref({ asset_id: logoFile.asset_id, role: "logo", placement: "top", scale: 0.3 })], overlay: "Kinetic.OPS, by DigiKon Solutions" }]);
    job.scene_visuals!["S01"]!.visual = { block: "end_card", wordmark: null, button: "Book a demo", subline: null, camera: "static", reveal: "none", backdrop: "flat" };
    const sc = plannedScenes(job, COMPOSITION_TEMPLATE)[0]!, l = sc.asset_layers[0]!;
    expect(sc.stack_top).toBeGreaterThanOrEqual(l.clip.y + l.clip.h);
    expect(sc.stack_top).toBeLessThan(H * 0.6);
  });
  it("ends a move exactly where it was planned", () => {
    const l = { from: { x: 0, y: 100, w: 300, h: 100 }, to: { x: 0, y: 0, w: 300, h: 100 }, move_frames: 30 };
    expect(rectAt(l, 30).y).toBe(0);
    expect(rectAt(l, 90).y).toBe(0);
  });
});

describe.skipIf(skipReal(hasRemotion))("uploaded pictures rendered by Remotion, read back from real frames", () => {
  const scenesSpec = () => [
    { refs: [ref({ asset_id: logoFile.asset_id, role: "logo", scale: 0.6, animation: "scale_in" })] },
    { refs: [ref({ asset_id: photoFile.asset_id, placement: "full_frame", scale: 1, fit: "cover", animation: "ken_burns_in", layer: 0 }), ref({ asset_id: logoFile.asset_id, role: "logo", placement: "top_right", scale: 0.22, layer: 2, animation: "fade_in" })] },
    { refs: [ref({ asset_id: photoFile.asset_id, frame: "browser", animation: "slide_up" })], overlay: "A real picture" },
    { refs: [ref({ asset_id: photoFile.asset_id, fit: "crop", crop: { x: 0.5, y: 0.15, w: 0.45, h: 0.65 }, animation: "zoom_to_region", scale: 1 })] },
  ];
  it("shows each file where it was approved, keeps the logo's shape and transparency, and notices the wrong file", async () => {
    const job = film(COMPOSITION_TEMPLATE, scenesSpec());
    const adapter = createRemotionAdapter({ fontFile: font!, outputRoot, workRoot: tmp });
    expect(adapter.check?.(job) ?? []).toEqual([]);
    await adapter.render({ ...job, signal: new AbortController().signal });
    const scenes = plannedScenes(job, COMPOSITION_TEMPLATE);
    const report = await validate(job.output_path, scenes, [{ scene_id: "S01", asset_id: logoFile.asset_id, role: "logo" }, { scene_id: "S02", asset_id: photoFile.asset_id }, { scene_id: "S02", asset_id: logoFile.asset_id, role: "logo" }, { scene_id: "S03", asset_id: photoFile.asset_id }, { scene_id: "S04", asset_id: photoFile.asset_id }]);
    expect(report.checks.map((c) => [c.scene_id, c.asset_id, c.verdict, c.failure])).toEqual(report.checks.map((c) => [c.scene_id, c.asset_id, "visible", null]));
    expect(report.failures).toEqual([]);
    expect(report.checks.every((c) => c.stages.at(-1) === "visually_validated")).toBe(true);

    // transparency: the scene's background shows through the logo's see-through pixels, so the file's box is not filled in
    const s1 = scenes[0]!, l = s1.asset_layers[0]!, f = await rawFrame(job.output_path, s1.frames - 1, W, H, "ffmpeg");
    const r = rectAt(l, s1.frames - 1);
    expect(r.w / r.h).toBeCloseTo(3, 1);
    const at = (x: number, y: number) => { const i = (Math.round(y) * W + Math.round(x)) * 3; return [f[i]!, f[i + 1]!, f[i + 2]!] as const; };
    const see = at(r.x + r.w * 0.9, r.y + r.h * 0.92), bg = l.plate ? at(l.plate.box.x + 8, l.plate.box.y + l.plate.box.h / 2) : at(30, 30);
    expect(Math.abs(see[0] - bg[0]) + Math.abs(see[1] - bg[1]) + Math.abs(see[2] - bg[2])).toBeLessThan(24);

    // the wrong file in that place is seen as wrong, and a mandatory use then reports its scene, asset and reason
    const swapped = scenes.map((s) => ({ ...s, asset_layers: s.asset_layers.map((x) => (x.asset_id === photoFile.asset_id ? { ...x, source: otherFile.path, sha256: otherFile.sha256 } : x)) }));
    const bad = await validate(job.output_path, swapped, [{ scene_id: "S03", asset_id: photoFile.asset_id }]);
    expect(bad.checks[0]!.verdict).toBe("not_visible");
    expect(bad.failures[0]).toMatch(/S03: asset_phot0001 is not visible as planned/);

    // a picture shown at the wrong shape does not pass either
    const s3 = scenes[2]!, layer = s3.asset_layers[0]!, end = await rawFrame(job.output_path, s3.from_frame + s3.frames - 1, W, H, "ffmpeg");
    const stretched = await matchLayer(end, W, H, { ...layer, from: { ...layer.to, w: layer.to.w * 0.6 }, to: { ...layer.to, w: layer.to.w * 0.6 } }, s3.frames - 1);
    expect(stretched.score).toBeLessThan(MATCH_MIN);
  }, 240_000);
  it("reports a mandatory picture whose scene was not rendered, or that has no layer", async () => {
    const report = await validateRenderedAssets("nothing.mp4", W, H, [{ scene_id: "S01", asset_id: "asset_a", role: "logo", mandatory: true }, { scene_id: "S02", asset_id: "asset_b", role: "hero", mandatory: true }, { scene_id: "S03", asset_id: "asset_c", role: "hero", mandatory: false }], [{ scene_id: "S01", from_frame: 0, frames: 30, rendered: false, reason: "no engine", layers: [], occluders: [] }, { scene_id: "S02", from_frame: 30, frames: 30, rendered: true, reason: null, layers: [], occluders: [] }]);
    expect(report.failures.join(" | ")).toMatch(/S01: the scene was not rendered: no engine/);
    expect(report.failures.join(" | ")).toMatch(/S02: the renderer has no layer for asset_b/);
    expect(report.failures).toHaveLength(2); // the optional one is noted, not a failure
    expect(report.checks[2]!.verdict).toBe("not_rendered");
  });
});

describe.skipIf(skipReal(!!font))("uploaded pictures overlaid by FFmpeg", () => {
  it("overlays them on their alpha channel, and refuses motion it cannot draw", async () => {
    const adapter = createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot: tmp });
    const job = film(FFMPEG_ASSET_TEMPLATE, [{ refs: [ref({ asset_id: photoFile.asset_id, scale: 1, placement: "full_frame", fit: "cover", layer: 0 }), ref({ asset_id: logoFile.asset_id, role: "logo", placement: "top_right", scale: 0.25, layer: 2, animation: "fade_in" })] }, { refs: [ref({ asset_id: photoFile.asset_id, frame: "browser", animation: "slide_up" })], overlay: "A real picture" }]);
    expect(adapter.check?.(job) ?? []).toEqual([]);
    await adapter.render({ ...job, signal: new AbortController().signal });
    const report = await validate(job.output_path, plannedScenes(job, FFMPEG_ASSET_TEMPLATE), [{ scene_id: "S01", asset_id: photoFile.asset_id }, { scene_id: "S01", asset_id: logoFile.asset_id, role: "logo" }, { scene_id: "S02", asset_id: photoFile.asset_id }]);
    expect(report.failures).toEqual([]);
    expect(report.checks.map((c) => c.verdict)).toEqual(["visible", "visible", "visible"]);
    expect(adapter.check?.(film(FFMPEG_ASSET_TEMPLATE, [{ refs: [ref({ asset_id: photoFile.asset_id, animation: "ken_burns_in" })] }])).join(" ")).toMatch(/cannot draw the ken_burns_in animation/);
  }, 120_000);
});

describe.skipIf(skipReal(hasChrome))("uploaded pictures drawn by HyperFrames", () => {
  it("draws them, keeping the logo's transparency", async () => {
    const adapter = createHyperframesStageAdapter({ fontFile: font!, outputRoot, workRoot: tmp });
    const job = film(HYPERFRAMES_ASSET_TEMPLATE, [{ refs: [ref({ asset_id: photoFile.asset_id, scale: 1, placement: "full_frame", fit: "cover", layer: 0 }), ref({ asset_id: logoFile.asset_id, role: "logo", placement: "top_right", scale: 0.25, layer: 2, animation: "fade_in" })] }]);
    expect(adapter.check?.(job) ?? []).toEqual([]);
    await adapter.render({ ...job, signal: new AbortController().signal });
    const report = await validate(job.output_path, plannedScenes(job, HYPERFRAMES_ASSET_TEMPLATE), [{ scene_id: "S01", asset_id: photoFile.asset_id }, { scene_id: "S01", asset_id: logoFile.asset_id, role: "logo" }]);
    expect(report.failures).toEqual([]);
  }, 180_000);
});
