import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Asset, Project, type AssetNotes, type DirectorHandoff } from "@digikon/contracts";
import { ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, runEditor, type DirectorStateType } from "@digikon/director";
import { analyseMedia, buildAssetNotes, probeFile } from "@digikon/media";
import { loadRecipes } from "@digikon/recipes";
import { cfg, deps, knowledge, root } from "../../director/src/fixtures.js";
import {
  AdapterRegistry, FFMPEG_CAPABILITIES, buildInputs, buildRenderEvidence, createFfmpegAdapter, executeRender, planRender, planScenes, previewCoverage, probeClip, runRenderQa,
  saveRenderEvidence, validateOutput, type RenderJob,
} from "./index.js";
import { realPrerequisites, recipeFileCount, skipReal } from "./test-env.js";

vi.setConfig({ testTimeout: 180_000 });
const FONTS = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];
const font = FONTS.find((f) => existsSync(f));
realPrerequisites({ font: !!font });
const tmp = mkdtempSync(join(tmpdir(), "clip-render-test-"));
const outputRoot = join(tmp, "out"), workRoot = join(tmp, "work"), media = join(tmp, "media");
for (const d of [outputRoot, workRoot, media]) mkdirSync(d);
/** Set RENDER_PROOF_DIR to keep the rendered films, contact sheets and evidence (for example storage/test-renders). */
const proofDir = process.env["RENDER_PROOF_DIR"];
/** Set RENDER_REAL_CLIP to a video file of your own (silent, or with sound) to render it too. */
const realClip = process.env["RENDER_REAL_CLIP"];
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ready = { status: "ready", questions: [] };
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "ignore" });

// ---- the footage. No camera footage exists on this machine, so these are ffmpeg-generated clips with continuous motion, in different
// ---- sizes, frame rates, containers and shapes, one with sound. Each frame carries moving content, so a wrong trim point is visible.
const CLIPS = {
  street: { file: "street.mp4", id: "asset_aa000001", make: () => ff("-f", "lavfi", "-i", "testsrc2=s=1280x720:r=25:d=14", "-pix_fmt", "yuv420p", join(media, "street.mp4")) }, // 16:9, 25 fps (the output is 30)
  harbour: { file: "harbour.mov", id: "asset_aa000002", make: () => ff("-f", "lavfi", "-i", "testsrc=s=1280x720:r=30:d=9,hue=h=120", "-pix_fmt", "yuv420p", join(media, "harbour.mov")) }, // 16:9, .mov
  tower: { file: "tower.mp4", id: "asset_aa000003", make: () => ff("-f", "lavfi", "-i", "testsrc2=s=540x960:r=30:d=10,hue=h=60", "-pix_fmt", "yuv420p", join(media, "tower.mp4")) }, // 9:16
  band: { file: "band.mp4", id: "asset_aa000004", make: () => ff("-f", "lavfi", "-i", "testsrc2=s=640x480:r=24:d=8", "-f", "lavfi", "-i", "sine=frequency=330:d=8", "-shortest", "-pix_fmt", "yuv420p", join(media, "band.mp4")) }, // 4:3 with sound
} as const;
type ClipKey = keyof typeof CLIPS;
const path = (k: ClipKey) => join(media, CLIPS[k].file);

/** Probes and analyses a clip once; the analysis (black, frozen and silent stretches) is the slow part and the clips never change. */
const analysed = new Map<ClipKey, Promise<{ asset: Asset; notes: AssetNotes }>>();
function supplied(k: ClipKey) {
  if (!analysed.has(k)) analysed.set(k, (async () => {
    const p = await probeFile(path(k), { assetId: CLIPS[k].id });
    if (!p.ok) throw new Error(`clip rejected: ${JSON.stringify(p.issues)}`);
    const m = await analyseMedia(path(k), { hasVideo: true, hasAudio: p.asset.audio_tracks > 0, duration_s: p.asset.duration ?? 0 });
    return { asset: p.asset, notes: buildAssetNotes(p.asset, m, null) };
  })());
  return analysed.get(k)!;
}

// ---- plan builders ----
interface SceneIn { id: string; dur: number; text?: string; clip?: ClipKey; in?: number; transition?: string; motion?: string; voiceover?: string }
const gfx = [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }];
const scene = (s: SceneIn) => ({
  scene_id: s.id, purpose: "p", duration_seconds: s.dur, asset_ids: s.clip ? [CLIPS[s.clip].id] : [], source_in_seconds: s.in ?? 0,
  required_assets: s.clip ? [{ need: "Supplied footage", kind: "footage", availability: "supplied", asset_id: CLIPS[s.clip].id }] : gfx, transition_out: s.transition ?? "cut",
  shot: { shot_size: "wide", camera_motion: s.motion ?? "static", visual_action: s.clip ? "The supplied footage" : "Text and shapes on a plain background" },
  ...(s.text ? { overlay: { text: s.text, safe_area: "platform_safe" } } : {}), ...(s.voiceover ? { voiceover: s.voiceover } : {}),
});
const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, number | string> = {}) => ({ use_id: `U${String(n).padStart(2, "0")}`, scene_id, recipe_id, params, rationale: "fits the beat" });
const treatment = (beats: number[]) => ({ logline: "A short, clear film", hook: "The opening line", tone: "friendly", beats: beats.map((s, i) => ({ beat: `Beat ${i + 1}`, purpose: "p", approx_seconds: s })), cta: "Learn more", claims: [] });
const project = (id: string, aspect: "16:9" | "9:16", seconds: number) => Project.parse({ project_id: id, owner_id: "u1", brief: "A short film made from supplied footage.", objective: "Show the footage", audience: "General", platform: aspect === "16:9" ? "YouTube" : "Instagram", aspect_ratio: aspect, target_duration: seconds });

async function directed(id: string, aspect: "16:9" | "9:16", beats: number[], scenes: unknown[], uses: unknown[], supply: Awaited<ReturnType<typeof supplied>>[]) {
  const d = deps(new ScriptedClient([ready, treatment(beats), { scenes }, { uses }]));
  const graph = buildDirectorGraph(d);
  const input = { project: project(id, aspect, beats.reduce((a, b) => a + b, 0)), assets: supply.map((x) => x.asset), facts: [], notes: supply.map((x) => x.notes) as AssetNotes[] };
  const g1 = await graph.invoke(input, cfg(id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(id))) as DirectorStateType;
  const handoff = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: id, model: "scripted" });
  const run = await runEditor(handoff, { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever });
  if (!run.ok) throw new Error(`editor rejected: ${run.reasons.join("; ")}`);
  return { handoff, output: run.output, recipes: d.recipes };
}
type Run = Awaited<ReturnType<typeof directed>>;

const settings = (w: number, h: number, duration: number, aspect: "16:9" | "9:16", fps = 30) => ({
  aspect_ratio: aspect, width: w, height: h, fps, duration_s: duration, container: "mp4", video_codec: "h264", audio_codec: null,
  source: { kind: "user_approved", reference: "test fixture values, not a platform specification" },
});
const F_SETTINGS = settings(640, 360, 18, "16:9"), G_SETTINGS = settings(720, 1280, 20, "9:16");
const registry = () => new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot })]);
const planFor = (r: Run, s: unknown, purpose: "preview" | "production" = "preview", over: { editor_output?: unknown; handoff?: unknown; adapters?: AdapterRegistry } = {}) => {
  const x = planRender({ editor_output: r.output, handoff: r.handoff, settings: s, purpose, ...over }, { recipes: r.recipes, adapters: over.adapters ?? registry(), outputRoot });
  if (!x.ok) throw new Error(`rejected: ${x.reasons.join("; ")}`);
  return x;
};
const coverageOf = (r: Run, x: ReturnType<typeof planFor>) => previewCoverage(r.handoff, r.output, x.record, FFMPEG_CAPABILITIES);
const rendered = new Map<string, Promise<Awaited<ReturnType<typeof executeRender>>>>();
const renderOnce = (key: string, r: Run, s: unknown) => { if (!rendered.has(key)) rendered.set(key, executeRender(planFor(r, s).plan!)); return rendered.get(key)!; };

/** A small grey picture of one frame, for comparing what was rendered with what the source shows at the approved point. */
const grey = (file: string, t: number, w: number, h: number) =>
  execFileSync("ffmpeg", ["-v", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: w * h * 4 });
const mad = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!); return s / a.length; };
/** Which moment of the source a rendered frame shows: the offset (seconds) from the expected moment whose source frame matches best, searched within two seconds either way. */
const offsetOf = (rendered: Buffer, source: string, expectedAt: number, w: number, h: number) => {
  let best = { off: 0, d: Infinity };
  for (let off = -2; off <= 2.001; off += 0.25) { const t = expectedAt + off; if (t < 0) continue; const d = mad(rendered, grey(source, t, w, h)); if (d < best.d) best = { off, d }; }
  return best.off;
};
const frameFile = (video: string, t: number, name: string) => { mkdirSync(proofDir ?? tmp, { recursive: true }); const png = join(proofDir ?? tmp, name); ff("-ss", String(t), "-i", video, "-frames:v", "1", png); return readFileSync(png); };
const sheet = (video: string, name: string, every: number) => { mkdirSync(proofDir ?? tmp, { recursive: true }); ff("-i", video, "-vf", `fps=1/${every},scale=240:-1,tile=5x4:padding=4:margin=4:color=gray`, "-frames:v", "1", join(proofDir ?? tmp, name)); };

// ================= two different films made from supplied footage =================
// F: 16:9, 18 s: a title, a 25 fps clip with a caption, a .mov clip, a closing card; one crossfade from the title into the first clip.
// G: 9:16, 20 s: a vertical clip, a 4:3 clip with sound (its sound dropped as the plan says) with a caption, a list, the vertical clip again from later on.
let F: Run, G: Run, KEEP: Run;
beforeAll(async () => {
  for (const c of Object.values(CLIPS)) c.make();
  const [street, harbour, tower, band] = await Promise.all([supplied("street"), supplied("harbour"), supplied("tower"), supplied("band")]);
  F = await directed("clips-f", "16:9", [4, 6, 5, 3], [
    scene({ id: "S01", dur: 4, text: "City Mornings | A short film", transition: "crossfade" }),
    scene({ id: "S02", dur: 6, text: "Morning rush", clip: "street", in: 3 }),
    scene({ id: "S03", dur: 5, clip: "harbour", in: 2 }),
    scene({ id: "S04", dur: 3, text: "Thanks for watching." }),
  ], [use(1, "S01", "title-subtitle"), use(2, "S01", "crossfade", { duration_s: 0.6 }), use(3, "S02", "clip-play-caption", { fit: "contain" }), use(4, "S03", "clip-play"), use(5, "S04", "text-card-fade")], [street, harbour]);
  G = await directed("clips-g", "9:16", [4, 6, 6, 4], [
    scene({ id: "S01", dur: 4, clip: "tower", in: 0 }),
    scene({ id: "S02", dur: 6, text: "Backstage", clip: "band", in: 1, transition: "crossfade" }),
    scene({ id: "S03", dur: 6, text: "Tonight | Doors at seven | Live trio at eight | Kitchen open late" }),
    scene({ id: "S04", dur: 4, text: "See you there.", clip: "tower", in: 4 }),
  ], [use(1, "S01", "clip-play", { fit: "cover" }), use(2, "S02", "clip-play-caption", { fit: "cover", source_audio: "drop" }), use(3, "S02", "crossfade", { duration_s: 0.5 }), use(4, "S03", "bullet-list", { stagger_s: 0.6 }), use(5, "S04", "clip-play-caption", { fit: "cover" })], [tower, band]);
  // the same footage with sound, but the plan does not say to drop it
  KEEP = await directed("clips-keep", "16:9", [4, 4], [scene({ id: "S01", dur: 4, text: "Opening." }), scene({ id: "S02", dur: 4, clip: "band", in: 0 })], [use(1, "S01", "text-card-fade"), use(2, "S02", "clip-play")], [band]);
}, 240_000);

describe.skipIf(skipReal(!!font))("two films made from supplied footage render, validate and pass QA", () => {
  it.each([
    ["F: 16:9 with a 25 fps clip, a .mov clip and a captioned clip", () => F, F_SETTINGS, { w: 640, h: 360, d: 18 }, "clips-f"],
    ["G: 9:16 with a vertical clip, a 4:3 clip with sound (dropped as approved) and a list", () => G, G_SETTINGS, { w: 720, h: 1280, d: 20 }, "clips-g"],
  ] as const)("%s", async (_name, get, s, expected, tag) => {
    const r = get();
    const p = planFor(r, s);
    expect(p.record.state, p.record.blockers.join("; ")).toBe("executable");
    expect(p.record.operations.every((o) => o.renderer === "ffmpeg" && !o.production_executable)).toBe(true);
    const cov = coverageOf(r, p);
    expect(cov.complete, JSON.stringify(cov.scenes.filter((x) => !x.represented))).toBe(true);
    const rec = await renderOnce(tag, r, s);
    expect(rec.state, JSON.stringify(rec.errors)).toBe("rendered");
    expect(rec.output).toMatchObject({ container: "mp4", width: expected.w, height: expected.h, fps: 30, duration_s: expected.d, video_codec: "h264", audio_codec: null, audio_tracks: 0 });
    const again = await validateOutput(rec.output!.path, rec.settings!, rec.audio_required);
    expect(again.ok && again.output.sha256).toBe(rec.output!.sha256);
    const qa = await runRenderQa(rec, r.handoff);
    expect(qa.findings, JSON.stringify(qa.findings)).toEqual([]);
    expect(qa.passed.map((x) => x.check)).toEqual(expect.arrayContaining(["duration", "resolution", "frame_rate", "black_frames"]));
    for (const id of new Set(rec.operations.map((o) => o.recipe_id))) { const ev = buildRenderEvidence(rec, r.recipes.get(id)!, qa); expect(ev.recipe_status).toBe("draft"); saveRenderEvidence(proofDir ?? join(tmp, "evidence"), ev); }
    sheet(rec.output!.path, `sheet-${tag}.png`, expected.d / 20);
    console.log(`RENDER ${tag}`, JSON.stringify({ output: { ...rec.output, path: undefined, checks: undefined }, qa: qa.passed.map((x) => x.check), notes: rec.notes.filter((n) => n.includes("sound")), audio_required: rec.audio_required }));
  });

  it("plays the approved part of the source: the rendered frames are the source frames at the approved in-point, in the approved order", async () => {
    const f = (await renderOnce("clips-f", F, F_SETTINGS)).output!.path, g = (await renderOnce("clips-g", G, G_SETTINGS)).output!.path;
    // film F, scene S02 (4s to 10s) plays street.mp4 from 3s; scene S03 (10s to 15s) plays harbour.mov from 2s
    for (const [local, abs] of [[1.0, 5.0], [3.5, 7.5]] as const) expect(offsetOf(grey(f, abs, 96, 54), path("street"), 3 + local, 96, 54), `street at ${local}s`).toBeCloseTo(0, 1);
    for (const local of [0.5, 3]) expect(offsetOf(grey(f, 10 + local, 96, 54), path("harbour"), 2 + local, 96, 54), `harbour at ${local}s`).toBeCloseTo(0, 1);
    // film G: scene S01 (0s to 4s) plays tower.mp4 from 0s; scene S04 (16s to 20s) plays it again from 4s, so the same footage appears at two approved points
    for (const [local, src, abs] of [[1, 1, 1], [1, 5, 17]] as const) expect(offsetOf(grey(g, abs, 54, 96), path("tower"), src, 54, 96), `tower scene at ${local}s`).toBeCloseTo(0, 1);
    // the scenes are in the approved order: the graphics scene lies between the two footage scenes and differs from both
    expect(Buffer.compare(frameFile(g, 9, "g-9.png"), frameFile(g, 13, "g-13.png"))).not.toBe(0);
  });

  it("shows the approved caption on the captioned clip only, and the crossfade into a clip", async () => {
    const f = (await renderOnce("clips-f", F, F_SETTINGS)).output!.path;
    // S02 (4s to 10s) has a caption, S03 (10s to 15s) has none: the captioned frame carries the strip at the bottom
    const bottom = (t: number) => grey(f, t, 64, 36).subarray(64 * 28);
    const captioned = bottom(6), plain = bottom(12);
    const source = grey(path("street"), 5, 64, 36).subarray(64 * 28), sourcePlain = grey(path("harbour"), 4, 64, 36).subarray(64 * 28);
    expect(mad(captioned, source)).toBeGreaterThan(mad(plain, sourcePlain) * 2);
    // the crossfade at 3.4s to 4s blends the title into the first picture of the clip
    expect(Buffer.compare(frameFile(f, 3.7, "f-3.7.png"), frameFile(f, 3.2, "f-3.2.png"))).not.toBe(0);
    expect(Buffer.compare(frameFile(f, 3.7, "f-3.7.png"), frameFile(f, 4.2, "f-4.2.png"))).not.toBe(0);
  });

  it("is deterministic: the same plan renders to the same bytes", async () => {
    const one = await renderOnce("clips-f", F, F_SETTINGS), two = await executeRender(planFor(F, F_SETTINGS).plan!);
    expect(one.output!.sha256).toBe(two.output!.sha256);
  });

  it("renders a clip of your own when RENDER_REAL_CLIP names one", async () => {
    if (!realClip) return;
    const probed = probeClip(realClip);
    expect(probed, "RENDER_REAL_CLIP must be a readable video").not.toBeNull();
    const d = Math.min(6, Math.floor((probed!.duration_s - 0.5) * 2) / 2);
    const copy = join(media, `real${realClip.slice(realClip.lastIndexOf("."))}`);
    copyFileSync(realClip, copy);
    const p = await probeFile(copy, { assetId: "asset_aa000009" });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    const m = await analyseMedia(copy, { hasVideo: true, hasAudio: p.asset.audio_tracks > 0, duration_s: p.asset.duration ?? 0 });
    const notes = buildAssetNotes(p.asset, m, null);
    const aspect = p.asset.width! >= p.asset.height! ? "16:9" : "9:16";
    const sc = { ...scene({ id: "S01", dur: d, text: "Your footage" }), asset_ids: ["asset_aa000009"], required_assets: [{ need: "Supplied footage", kind: "footage", availability: "supplied", asset_id: "asset_aa000009" }] };
    const r = await directed("clips-real", aspect, [d, d], [sc, scene({ id: "S02", dur: d, text: "The end." })], [use(1, "S01", "clip-play-caption", { fit: "contain", source_audio: p.asset.audio_tracks ? "drop" : "keep" }), use(2, "S02", "text-card-fade")], [{ asset: p.asset, notes }]);
    const rec = await executeRender(planFor(r, settings(aspect === "16:9" ? 640 : 360, aspect === "16:9" ? 360 : 640, d * 2, aspect)).plan!);
    expect(rec.state, JSON.stringify(rec.errors)).toBe("rendered");
  });
});

const jobF = (): Omit<RenderJob, "signal"> => structuredClone(planFor(F, F_SETTINGS).plan!.job);
const jobG = (): Omit<RenderJob, "signal"> => structuredClone(planFor(G, G_SETTINGS).plan!.job);
const op = (j: Omit<RenderJob, "signal">, id: string) => j.operations.find((o) => o.operation_id === id)!;
const issues = (j: Omit<RenderJob, "signal">) => { const p = planScenes(j, { outputRoot }); return p.ok ? [] : p.issues; };
const setParam = (j: Omit<RenderJob, "signal">, id: string, k: string, v: unknown) => { op(j, id).parameters = { ...op(j, id).parameters, [k]: v }; };
const clipOf = (j: Omit<RenderJob, "signal">, id: string) => j.clips.find((c) => c.operation_id === id)!;

describe.skipIf(skipReal(!!font))("clip operations: what is validated before FFmpeg runs", () => {
  it("accepts both planned jobs, with the approved source start of every clip", () => {
    expect(issues(jobF())).toEqual([]); expect(issues(jobG())).toEqual([]);
    expect(jobF().clips).toEqual([{ operation_id: "E03", asset_id: CLIPS.street.id, source_in_s: 3 }, { operation_id: "E04", asset_id: CLIPS.harbour.id, source_in_s: 2 }]);
    expect(jobG().clips.map((c) => [c.asset_id, c.source_in_s])).toEqual([[CLIPS.tower.id, 0], [CLIPS.band.id, 1], [CLIPS.tower.id, 4]]);
  });

  // film F operations: E01 title, E02 crossfade, E03 captioned clip (street, in 3), E04 clip (harbour, in 2), E05 text card
  it.each<[string, (j: Omit<RenderJob, "signal">) => void, string]>([
    ["a trim that starts before the clip", (j) => { clipOf(j, "E03").source_in_s = -1; }, "approved source start point"],
    ["a trim start that is not a number", (j) => { clipOf(j, "E03").source_in_s = Number.NaN; }, "approved source start point"],
    ["a trim that runs past the end of the clip", (j) => { clipOf(j, "E03").source_in_s = 9; }, "runs past the end of asset"],
    ["a trim that ends exactly at the end of the clip", (j) => { clipOf(j, "E03").source_in_s = 8; }, ""],
    ["a missing source start", (j) => { j.clips = j.clips.filter((c) => c.operation_id !== "E03"); }, "approved source start point"],
    ["a source start for another asset", (j) => { clipOf(j, "E03").asset_id = CLIPS.harbour.id; }, "approved source start point"],
    ["missing approved measurements", (j) => { delete j.asset_info[CLIPS.street.id]; }, "approved measurements"],
    ["a clip scene with no clip", (j) => { op(j, "E03").asset_ids = []; }, "exactly one supplied video"],
    ["a clip scene with two clips", (j) => { op(j, "E03").asset_ids = [CLIPS.street.id, CLIPS.harbour.id]; }, "exactly one supplied video"],
    ["a clip the renderer was not given", (j) => { j.assets = j.assets.filter((a) => a.asset_id !== CLIPS.street.id); }, "was not supplied to the renderer"],
    ["an image where a video is required, with nothing substituted", (j) => { j.assets.find((a) => a.asset_id === CLIPS.street.id)!.media_type = "image"; }, "is image, not a video, and nothing is substituted for it"],
    ["audio where a video is required", (j) => { j.assets.find((a) => a.asset_id === CLIPS.street.id)!.media_type = "audio"; }, "not a video"],
    ["a file type that is not supported", (j) => { j.assets.find((a) => a.asset_id === CLIPS.street.id)!.uri = path("street").replace(/\.mp4$/, ".avi"); }, "must be an absolute path to a .mp4"],
    ["a relative path", (j) => { j.assets.find((a) => a.asset_id === CLIPS.street.id)!.uri = "street.mp4"; }, "must be an absolute path"],
    ["a file that is missing", (j) => { j.assets.find((a) => a.asset_id === CLIPS.street.id)!.uri = join(media, "gone.mp4"); }, "missing or empty"],
    ["a file that is empty", (j) => { const f = join(media, "empty.mp4"); writeFileSync(f, ""); j.assets.find((a) => a.asset_id === CLIPS.street.id)!.uri = f; }, "missing or empty"],
    ["a file that is not video", (j) => { const f = join(media, "notvideo.mp4"); writeFileSync(f, "this is not a video"); j.assets.find((a) => a.asset_id === CLIPS.street.id)!.uri = f; }, "cannot be read as a video"],
    ["a different file than the one approved (other size)", (j) => { j.assets.find((a) => a.asset_id === CLIPS.street.id)!.uri = path("tower"); }, "is not what was analysed and approved"],
    ["a file whose length changed since approval", (j) => { j.asset_info[CLIPS.street.id]!.duration = 30; }, "is not what was analysed and approved"],
    ["a file whose sound changed since approval", (j) => { j.asset_info[CLIPS.street.id]!.audio_tracks = 1; }, "is not what was analysed and approved"],
    ["an unknown parameter", (j) => setParam(j, "E03", "speed", 2), "unknown parameter speed"],
    ["a fit outside the list", (j) => setParam(j, "E03", "fit", "stretch"), "fit must be one of contain, cover"],
    ["a source_audio outside the list", (j) => setParam(j, "E03", "source_audio", "mix"), "source_audio must be one of keep, drop"],
    ["a caption fade out of range", (j) => setParam(j, "E03", "fade_in_s", 9), "fade_in_s must be a number from 0.2 to 2"],
    ["a background outside the list", (j) => setParam(j, "E03", "background", "red;drawtext=text=x"), "background must be one of"],
    ["a caption that is too long", (j) => { op(j, "E03").caption = { text: "x".repeat(121), start_s: 6, end_s: 10 }; }, "longer than 120"],
    ["a caption with control characters", (j) => { op(j, "E03").caption = { text: "a\u0007b", start_s: 6, end_s: 10 }; }, "control characters"],
    ["a caption that does not fit", (j) => { op(j, "E03").caption = { text: "word ".repeat(22).trim(), start_s: 6, end_s: 10 }; }, "does not fit in 2 lines"],
    ["a clip scene that is not whole frames", (j) => { op(j, "E04").timing = { start_s: 10, duration_s: 5.01 }; }, "not a whole number of frames"],
    ["a gap before a clip", (j) => { op(j, "E04").timing = { start_s: 10.5, duration_s: 4.5 }; }, "gaps and overlaps are not rendered"],
    ["an audio cue on a clip scene", (j) => { op(j, "E04").audio_cues = ["wind"]; }, "audio cues cannot be produced"],
    ["a trim_clip operation on a text template", (j) => { j.templates["E04"] = "ffmpeg/text-card"; }, "implements render_graphics_scene operations, not trim_clip"],
    ["a clip template on the wrong operation type", (j) => { op(j, "E05").operation_type = "trim_clip"; j.templates["E05"] = "ffmpeg/clip-play"; op(j, "E05").asset_ids = []; }, "exactly one supplied video"],
    ["a template that is not implemented (trim-hold)", (j) => { j.templates["E04"] = "ffmpeg/trim-hold"; }, "ffmpeg/trim-hold is not supported by this renderer"],
    ["a clip that is not shown by any operation", (j) => { j.assets.push({ asset_id: "asset_unused", media_type: "video", uri: path("band") }); }, "asset asset_unused is not shown by any operation"],
  ])("refuses %s", (_n, change, text) => {
    const j = jobF(); change(j);
    const found = issues(j).join(" | ");
    if (text) expect(found).toContain(text); else expect(found).toBe("");
  });

  it("refuses a clip with sound unless the plan says to drop it, and renders it silently when it does", async () => {
    const jg = jobG();
    expect(issues(jg)).toEqual([]);
    setParam(jg, "E02", "source_audio", "keep");
    expect(issues(jg).join(" | ")).toContain("has an audio track, and audio cannot be produced yet; the approved plan does not say to drop it (source_audio is keep)");
    // a plan whose edit plan keeps the sound is blocked while planning, and the coverage says why
    const p = planFor(KEEP, settings(640, 360, 8, "16:9"));
    expect(p.record.state).toBe("planning");
    expect(p.plan).toBeNull();
    expect(p.record.blockers.join(" ")).toContain("does not say to drop it");
    expect(p.record.blockers.join(" ")).toContain("the plan includes audio but the output settings choose no audio codec");
    const cov = coverageOf(KEEP, p);
    expect(cov.complete).toBe(false);
    expect(cov.scenes[1]!.missing.join(" ")).toContain("has an audio track, audio cannot be produced yet, and the plan does not say to drop it");
    // and the plan that does say so records it and produces no audio
    const rec = await renderOnce("clips-g", G, G_SETTINGS);
    expect(rec.notes.join(" ")).toContain("sound of asset_aa000004 is left out because the approved edit plan says so");
    expect(rec.output!.audio_tracks).toBe(0);
  });

  it("builds FFmpeg input arguments from validated numbers and an absolute path, never from text", () => {
    const p = planScenes(jobF(), { outputRoot });
    expect(p.ok).toBe(true);
    if (p.ok) {
      const args = buildInputs(p.scenes, 30);
      expect(args).toEqual(["-ss", "3.000000", "-t", "6.000000", "-i", path("street"), "-ss", "2.000000", "-t", "5.000000", "-i", path("harbour")]);
    }
  });

  it("a clip changed after approval is refused by the handoff check, before the renderer is asked anything", () => {
    const run = F;
    const bad = structuredClone(run.output);
    const p = planFor(run, { ...F_SETTINGS }, "preview", { editor_output: bad });
    expect(p.record.state).toBe("executable"); // control: the unchanged plan is fine
    const asFile = join(media, "street.mp4"), keep = readFileSync(asFile);
    try {
      writeFileSync(asFile, keep.subarray(0, Math.floor(keep.length / 3))); // truncated after approval
      // the handoff check refuses it first: the file is no longer the one that was approved
      const q = planRender({ editor_output: run.output, handoff: run.handoff, settings: F_SETTINGS, purpose: "preview" }, { recipes: run.recipes, adapters: registry(), outputRoot });
      expect(q.ok).toBe(false);
      if (!q.ok) { expect(q.stage).toBe("handoff"); expect(q.reasons.join(" ")).toContain("changed on disk"); }
    } finally { writeFileSync(asFile, keep); }
  });
});

describe.skipIf(skipReal(!!font))("unsupported footage requirements are blocked before rendering, scene by scene", () => {
  it("a camera move on supplied footage is not silently dropped", async () => {
    const r = await directed("clips-move", "16:9", [4, 4], [scene({ id: "S01", dur: 4, text: "Opening." }), scene({ id: "S02", dur: 4, clip: "street", in: 0, motion: "slow_push_in" })], [use(1, "S01", "text-card-fade"), use(2, "S02", "clip-play")], [await supplied("street")]);
    const p = planFor(r, settings(640, 360, 8, "16:9"));
    expect(p.record.state).toBe("planning"); // the operations could run, but not the approved shot, so the planner itself refuses
    expect(p.plan).toBeNull();
    expect(p.record.blockers.join(" ")).toContain("S02: the approved shot calls for camera motion (slow push in)");
    const cov = coverageOf(r, p);
    expect(cov.complete).toBe(false); // ...but that is not the approved shot
    expect(cov.scenes[1]!.missing.join(" ")).toContain("the approved shot calls for camera motion (slow push in)");
    expect(cov.scenes[0]!.represented).toBe(true);
  });

  it("a camera-move or hold recipe on footage has no template, so nothing stands in for it", async () => {
    const r = await directed("clips-hold", "16:9", [4, 4], [scene({ id: "S01", dur: 4, text: "Opening." }), scene({ id: "S02", dur: 4, clip: "street", in: 0, motion: "slow_push_in" })], [use(1, "S01", "text-card-fade"), use(2, "S02", "slow-push-in")], [await supplied("street")]);
    const p = planFor(r, settings(640, 360, 8, "16:9"));
    expect(p.record.state).toBe("planning");
    expect(p.record.blockers.join(" ")).toContain("no template is registered for remotion/slow-push-in");
    const hold = await directed("clips-hold2", "16:9", [4, 4], [scene({ id: "S01", dur: 4, text: "Opening." }), scene({ id: "S02", dur: 4, clip: "street", in: 0 })], [use(1, "S01", "text-card-fade"), use(2, "S02", "static-hold")], [await supplied("street")]);
    const q = planFor(hold, settings(640, 360, 8, "16:9"));
    expect(q.record.state).toBe("planning");
    expect(q.record.blockers.join(" ")).toContain("no template is registered for ffmpeg/trim-hold");
    expect(coverageOf(hold, q).complete).toBe(false);
  });

  it("a transition that cannot be rendered after a clip is named, and voiceover blocks the Editor result", async () => {
    const r = await directed("clips-dip", "16:9", [4, 4], [scene({ id: "S01", dur: 4, clip: "street", in: 0, transition: "dip_to_black" }), scene({ id: "S02", dur: 4, text: "Next." })], [use(1, "S01", "clip-play"), use(2, "S01", "dip-to-black"), use(3, "S02", "text-card-fade")], [await supplied("street")]);
    const p = planFor(r, settings(640, 360, 8, "16:9"));
    expect(p.record.state).toBe("planning");
    expect(p.record.blockers.join(" ")).toContain("no template is registered for ffmpeg/xfade-fadeblack");
    expect(coverageOf(r, p).scenes[0]!.missing.join(" ")).toContain("dip to black transition");
    const v = await directed("clips-vo", "16:9", [4, 4], [scene({ id: "S01", dur: 4, clip: "street", in: 0, voiceover: "Words someone would say." }), scene({ id: "S02", dur: 4, text: "Next." })], [use(1, "S01", "clip-play"), use(2, "S02", "text-card-fade")], [await supplied("street")]);
    expect(v.output.status).toBe("blocked");
    const x = planRender({ editor_output: v.output, handoff: v.handoff, settings: settings(640, 360, 8, "16:9"), purpose: "preview" }, { recipes: v.recipes, adapters: registry(), outputRoot });
    expect(x.ok).toBe(false);
  });

  it("a scene whose footage the plan never plays is refused, and an image scene cannot stand in for a video", async () => {
    const p = planFor(F, F_SETTINGS);
    // film F's handoff, but the clip operations are removed from the render: the footage is then not played by anything
    const noClips = { ...p.record, operations: p.record.operations.map((o) => (o.implementation_ref === "ffmpeg/clip-play" ? { ...o, renderer: null } : o)) };
    const cov = previewCoverage(F.handoff, F.output, noClips, FFMPEG_CAPABILITIES);
    expect(cov.complete).toBe(false);
    expect(cov.scenes[1]!.missing.join(" ")).toContain("has no renderer that can run it");
    expect(cov.scenes[1]!.missing.join(" ")).toContain("supplied video (asset_aa000001), which this renderer cannot show yet");
    // the image template refuses a video asset
    const j = jobG(); j.templates["E01"] = "ffmpeg/image-scene"; op(j, "E01").operation_type = "render_graphics_scene";
    expect(issues(j).join(" | ")).toContain("only images are shown (no video clips yet)");
  });
});

describe.skipIf(skipReal(!!font))("failures, timeouts, stale approvals and readiness with footage", () => {
  it("a failed render with clips leaves no output and no temporary files", async () => {
    const bad = join(tmp, "broken.ttf"); writeFileSync(bad, "this is not a font");
    const p = planFor(F, F_SETTINGS, "preview", { adapters: new AdapterRegistry([createFfmpegAdapter({ fontFile: bad, outputRoot, workRoot })]) }).plan!;
    const rec = await executeRender(p);
    expect(rec).toMatchObject({ state: "failed", output: null });
    expect(rec.errors[0]).toMatchObject({ stage: "adapter" });
    expect(existsSync(p.job.output_path)).toBe(false);
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it("a timeout stops FFmpeg and removes the partial file", async () => {
    const p = planFor(G, G_SETTINGS).plan!;
    const rec = await executeRender(p, { timeoutMs: 1 });
    expect(rec).toMatchObject({ state: "failed", output: null });
    expect(rec.errors[0]!.stage).toBe("timeout");
    for (let i = 0; i < 80 && (existsSync(p.job.output_path) || readdirSync(workRoot).length); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(p.job.output_path)).toBe(false);
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it("a clip replaced after approval is refused before FFmpeg runs, whether the bytes or only the length changed", async () => {
    const p = planFor(F, F_SETTINGS).plan!;
    const file = path("street"), keep = readFileSync(file);
    try {
      writeFileSync(file, Buffer.concat([keep, Buffer.from([0])]));
      const rec = await executeRender(p);
      expect(rec.state).toBe("failed");
      expect(rec.errors[0]).toMatchObject({ stage: "precheck" });
      expect(existsSync(p.job.output_path)).toBe(false);
    } finally { writeFileSync(file, keep); }
  });

  it("a handoff or Editor result changed after approval is rejected before any clip is read", () => {
    const edited = { ...F.handoff, constraints: { ...F.handoff.constraints, platform: "Elsewhere" } } as DirectorHandoff;
    const r1 = planRender({ editor_output: F.output, handoff: edited, settings: F_SETTINGS, purpose: "preview" }, { recipes: F.recipes, adapters: registry(), outputRoot });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.stage).toBe("handoff");
    const ops = structuredClone(F.output.operations);
    ops.find((o) => o.operation_id === "E03")!.caption = { text: "Different words", start_s: 4, end_s: 10 };
    const r2 = planRender({ editor_output: { ...F.output, operations: ops }, handoff: F.handoff, settings: F_SETTINGS, purpose: "preview" }, { recipes: F.recipes, adapters: registry(), outputRoot });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reasons.join(" ")).toContain("caption text is not the approved overlay text");
    // a start point other than the approved one is a different edit: the Editor result must carry the approved parameters
    const moved = structuredClone(F.output.operations); moved.find((o) => o.operation_id === "E03")!.parameters = { ...moved.find((o) => o.operation_id === "E03")!.parameters, fit: "cover" };
    const r3 = planRender({ editor_output: { ...F.output, operations: moved }, handoff: F.handoff, settings: F_SETTINGS, purpose: "preview" }, { recipes: F.recipes, adapters: registry(), outputRoot });
    expect(r3.ok).toBe(false);
  });

  it("production stays blocked for both films, and every recipe is still a draft", () => {
    for (const [r, s] of [[F, F_SETTINGS], [G, G_SETTINGS]] as const) {
      const p = planFor(r, s, "production");
      expect(p.record.state).toBe("planning");
      expect(p.plan).toBeNull();
      expect(p.record.blockers.join(" ")).toMatch(/is draft: no review evidence/);
      expect(p.record.operations.every((o) => !o.production_executable)).toBe(true);
    }
    const recipes = loadRecipes(root("recipes"));
    expect(recipes).toHaveLength(recipeFileCount(root("recipes"))); // every recipe file loads, whatever their number
    expect(new Set(recipes.map((x) => x.recipe_id)).size).toBe(recipes.length);
    expect(recipes.every((x) => x.status === "draft" && x.review === null)).toBe(true);
  });

  it("settings that do not match the approved plan are blockers with footage too", () => {
    expect(planFor(F, { ...F_SETTINGS, duration_s: 20 }).record.blockers.join(" ")).toContain("but the approved storyboard lasts 18s");
    expect(planFor(G, { ...G_SETTINGS, audio_codec: "aac" }).record.blockers.join(" ")).toContain("the plan has no audio; none is added silently");
    expect(planFor(F, undefined).record.blockers.join(" ")).toContain("no output settings were supplied");
  });
});
