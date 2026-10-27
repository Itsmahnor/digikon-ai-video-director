import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Asset, Project, type DirectorHandoff, type EditorOperation, type Renderer } from "@digikon/contracts";
import { ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, runEditor, type DirectorStateType } from "@digikon/director";
import { probeFile } from "@digikon/media";
import { cfg, deps, knowledge, root } from "../../director/src/fixtures.js";
import {
  AdapterRegistry, HYPERFRAMES_TEMPLATES, REMOTION_TEMPLATES, buildComposition, buildRenderEvidence, createFfmpegAdapter, createHyperframesAdapter, createRemotionAdapter,
  executeRender, findChrome, findRemotionBrowser, planRender, planWebScenes, previewCoverage, runRenderQa, saveRenderEvidence, selectRenderer, validateOutput, verifySceneContent, type RenderJob,
} from "./index.js";
import { realPrerequisites, skipReal } from "./test-env.js";

vi.setConfig({ testTimeout: 300_000 });
const FONTS = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];
const font = FONTS.find((f) => existsSync(f));
const chrome = findChrome();
const tmp = mkdtempSync(join(tmpdir(), "web-render-test-"));
const outputRoot = join(tmp, "out"), workRoot = join(tmp, "work");
mkdirSync(outputRoot); mkdirSync(workRoot);
/** Set RENDER_PROOF_DIR to keep the rendered frames, contact sheets and evidence (for example storage/test-renders). */
const proofDir = process.env["RENDER_PROOF_DIR"];
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const remotionBrowser = findRemotionBrowser();
const can = !!font && !!chrome && !!remotionBrowser;
realPrerequisites({ font: !!font, "a Chrome for HyperFrames": !!chrome, "a 64-bit Edge or Chrome for Remotion": !!remotionBrowser });

const ready = { status: "ready", questions: [] };
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "ignore" });

// ---- scene and plan builders (the same approved-plan path the FFmpeg tests use: Director, both approvals, Editor) ----
interface SceneIn { id: string; dur: number; text?: string; assets?: string[]; required?: unknown[]; transition?: string; camera?: string }
const gfx = [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }];
const scene = (s: SceneIn) => ({
  scene_id: s.id, purpose: "p", duration_seconds: s.dur, asset_ids: s.assets ?? [], required_assets: s.required ?? gfx, transition_out: s.transition ?? "cut",
  shot: { shot_size: "wide", camera_motion: s.camera ?? "static", visual_action: "Text and shapes on a plain background" },
  ...(s.text ? { overlay: { text: s.text, safe_area: "platform_safe" } } : {}),
});
const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, number | string> = {}) => ({ use_id: `U${String(n).padStart(2, "0")}`, scene_id, recipe_id, params, rationale: "fits the beat" });
const treatment = (beats: number[]) => ({ logline: "A short, clear film", hook: "The opening line", tone: "friendly", beats: beats.map((s, i) => ({ beat: `Beat ${i + 1}`, purpose: "p", approx_seconds: s })), cta: "Learn more", claims: [] });
const project = (id: string, aspect: "16:9" | "9:16", seconds: number) => Project.parse({ project_id: id, owner_id: "u1", brief: "A short test film.", objective: "Inform the audience", audience: "General", platform: aspect === "16:9" ? "YouTube" : "Instagram", aspect_ratio: aspect, target_duration: seconds });

async function directed(id: string, p: ReturnType<typeof project>, beats: number[], scenes: unknown[], uses: unknown[], assets: Asset[] = []) {
  const d = deps(new ScriptedClient([ready, treatment(beats), { scenes }, { uses }]));
  const graph = buildDirectorGraph(d);
  const input = { project: p, assets, facts: [] };
  const g1 = await graph.invoke(input, cfg(id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(id))) as DirectorStateType;
  const handoff = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: id, model: "scripted" });
  const run = await runEditor(handoff, { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever });
  if (!run.ok) throw new Error(`editor rejected: ${run.reasons.join("; ")}`);
  return { handoff, output: run.output, recipes: d.recipes };
}
type Run = Awaited<ReturnType<typeof directed>>;

const settings = (o: { w: number; h: number; duration: number; aspect: "16:9" | "9:16" }) => ({
  aspect_ratio: o.aspect, width: o.w, height: o.h, fps: 30, duration_s: o.duration, container: "mp4", video_codec: "h264", audio_codec: null,
  source: { kind: "user_approved", reference: "test fixture values, not a platform specification" },
});
const T_SETTINGS = settings({ w: 640, h: 360, duration: 9, aspect: "16:9" });
const I_SETTINGS = settings({ w: 360, h: 640, duration: 10, aspect: "9:16" });

const adapterOf = (r: Renderer) => r === "remotion" ? createRemotionAdapter({ fontFile: font!, outputRoot, workRoot }) : createHyperframesAdapter({ fontFile: font!, outputRoot, workRoot });
const registryOf = (...r: Renderer[]) => new AdapterRegistry(r.map(adapterOf));
const planFor = (r: Run, s: unknown, renderers: Renderer[], purpose: "preview" | "production" = "preview", over: { editor_output?: unknown; handoff?: unknown } = {}) => {
  const x = planRender({ editor_output: r.output, handoff: r.handoff, settings: s, purpose, ...over }, { recipes: r.recipes, adapters: registryOf(...renderers), outputRoot });
  if (!x.ok) throw new Error(`rejected: ${x.reasons.join("; ")}`);
  return x;
};

// ---- measuring the real file ----
const pixelAt = (video: string, n: number, x: number, y: number): [number, number, number] => {
  const b = execFileSync("ffmpeg", ["-v", "error", "-i", video, "-vf", `select=eq(n\\,${n}),format=rgb24,crop=1:1:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 20 });
  return [b[0]!, b[1]!, b[2]!];
};
const whitePixels = (video: string, n: number, x: number, y: number, w: number, h: number) => {
  const b = execFileSync("ffmpeg", ["-v", "error", "-i", video, "-vf", `select=eq(n\\,${n}),crop=${w}:${h}:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 24 });
  let c = 0;
  for (let i = 0; i + 2 < b.length; i += 3) if (b[i]! > 215 && b[i + 1]! > 215 && b[i + 2]! > 215) c++;
  return c;
};
const near = (a: readonly number[], hex: string, tol = 14) => [1, 3, 5].every((o, i) => Math.abs(a[i]! - parseInt(hex.slice(o, o + 2), 16)) <= tol);
const frameImage = (video: string, n: number, name: string) => {
  mkdirSync(proofDir ?? tmp, { recursive: true });
  const png = join(proofDir ?? tmp, name);
  ff("-i", video, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-fps_mode", "passthrough", png);
  return png;
};
const sheet = (video: string, name: string, every: number, cols: number, rows: number, w: number) => {
  mkdirSync(proofDir ?? tmp, { recursive: true });
  ff("-i", video, "-vf", `fps=1/${every},scale=${w}:-1,tile=${cols}x${rows}:padding=4:margin=4:color=gray`, "-frames:v", "1", join(proofDir ?? tmp, name));
};

const BG = { navy: "#16213e", charcoal: "#2b2d31", forest: "#1e3d2f" };
const RECIPES: Record<"remotion" | "hyperframes", { text: string; image: string }> = {
  remotion: { text: "text-slide-remotion", image: "image-caption-remotion" },
  hyperframes: { text: "text-fade-hyperframes", image: "image-caption-hyperframes" },
};
const BLUE = "#3366cc";
let photoPath: string, screenPath: string;
const T = {} as Record<"remotion" | "hyperframes", Run>, I = {} as Record<"remotion" | "hyperframes", Run>;

beforeAll(async () => {
  photoPath = join(tmp, "photo.png"); screenPath = join(tmp, "screen.png");
  ff("-f", "lavfi", "-i", `color=c=0x3366cc:s=1280x720:d=1:r=1`, "-frames:v", "1", photoPath);
  ff("-f", "lavfi", "-i", `color=c=0x3366cc:s=1280x720:d=1:r=1`, "-frames:v", "1", screenPath);
  const photo = await probeFile(photoPath, { assetId: "asset_0a1b2c3d" });
  const screen = await probeFile(screenPath, { assetId: "asset_1a2b3c4d" });
  if (!photo.ok || !screen.ok) throw new Error("test image rejected");
  for (const r of ["remotion", "hyperframes"] as const) {
    const rc = RECIPES[r];
    T[r] = await directed(`t-${r}`, project(`t${r}`, "16:9", 9), [3, 3, 3], [
      scene({ id: "S01", dur: 3, text: "Meet Lumen" }), scene({ id: "S02", dur: 3, text: "Plan your week in one place" }), scene({ id: "S03", dur: 3, text: "Start today" }),
    ], [use(1, "S01", rc.text), use(2, "S02", rc.text, { background: "charcoal", accent: "teal", fade_in_s: 1 }), use(3, "S03", rc.text, { background: "forest", accent: "coral" })]);
    I[r] = await directed(`i-${r}`, project(`i${r}`, "9:16", 10), [3, 4, 3], [
      scene({ id: "S01", dur: 3, text: "Riverside jazz" }),
      scene({ id: "S02", dur: 4, text: "Live on the terrace", assets: ["asset_0a1b2c3d"], required: [{ need: "Venue photo", kind: "image", availability: "supplied", asset_id: "asset_0a1b2c3d" }] }),
      scene({ id: "S03", dur: 3, text: "An illustration of the idea", assets: ["asset_1a2b3c4d"], required: [{ need: "Dashboard screen", kind: "ui_screenshot", availability: "supplied", asset_id: "asset_1a2b3c4d" }] }),
    ], [use(1, "S01", rc.text), use(2, "S02", rc.image, { fit: "cover", motion: "slow_zoom", fade_in_s: 0.6 }), use(3, "S03", rc.image)], [photo.asset, Asset.parse({ ...screen.asset, genuine_product_ui: false })]);
  }
}, 180_000);

const rendered = new Map<string, Promise<Awaited<ReturnType<typeof executeRender>>>>();
const renderOnce = (key: string, r: Run, s: unknown, which: Renderer) => {
  if (!rendered.has(key)) rendered.set(key, executeRender(planFor(r, s, [which]).plan!).then((rec) => {
    if (proofDir && rec.output) { mkdirSync(proofDir, { recursive: true }); copyFileSync(rec.output.path, join(proofDir, `${key}.mp4`)); } // keep the real file as evidence
    return rec;
  }));
  return rendered.get(key)!;
};

describe.skipIf(skipReal(can))("the recipes behind the two new renderers stay drafts, and a production render stays blocked", () => {
  it.each(["remotion", "hyperframes"] as const)("%s: executable as a preview, refused as production", (r) => {
    const p = planFor(T[r], T_SETTINGS, [r]);
    expect(p.record.state).toBe("executable");
    expect(p.record.operations.every((o) => o.renderer === r && !o.production_executable)).toBe(true);
    for (const id of new Set(p.record.operations.map((o) => o.recipe_id))) {
      expect(T[r].recipes.get(id)!.status).toBe("draft");
      expect(T[r].recipes.get(id)!.review).toBeNull();
    }
    const prod = planFor(T[r], T_SETTINGS, [r], "production");
    expect(prod.record.state).toBe("planning");
    expect(prod.plan).toBeNull();
    expect(prod.record.blockers.join(" ")).toContain("is draft: no review evidence");
  });
});

describe.skipIf(skipReal(can))("real renders: Remotion and HyperFrames each produce a multi-scene video that matches the approved plan", () => {
  it.each(["remotion", "hyperframes"] as const)("%s text film: metadata, scene order, timing, colours and text", async (r) => {
    const rec = await renderOnce(`T-${r}`, T[r], T_SETTINGS, r);
    expect(rec.errors).toEqual([]);
    expect(rec.state).toBe("rendered");
    expect(rec.output).toMatchObject({ container: "mp4", width: 640, height: 360, fps: 30, duration_s: 9, video_codec: "h264", audio_codec: null, audio_tracks: 0 });
    const v = rec.output!.path;
    console.log(`${r.toUpperCase()} TEXT FILM METADATA`, JSON.stringify(rec.output));
    for (const n of [0, 45, 100, 150, 200, 250]) frameImage(v, n, `${r}-text-f${n}.png`);
    sheet(v, `${r}-text-sheet.png`, 1, 3, 3, 320);
    // an independent measurement of the file, not the record's
    const again = await validateOutput(v, rec.settings!, false);
    expect(again.ok && again.output.sha256).toBe(rec.output!.sha256);

    // scenes in the approved order and at the approved times: S01 navy 0-89, S02 charcoal 90-179, S03 forest 180-269 (30 fps)
    const bg = [BG.navy, BG.charcoal, BG.forest];
    const starts = [0, 90, 180];
    starts.forEach((s, i) => {
      expect(near(pixelAt(v, s, 4, 4), bg[i]!), `first frame of scene ${i + 1}`).toBe(true);
      expect(near(pixelAt(v, s + 89, 4, 4), bg[i]!), `last frame of scene ${i + 1}`).toBe(true);
      // the text fades in: nothing on the first frame, plenty of white once it has faded in
      expect(whitePixels(v, s, 64, 140, 512, 80), `scene ${i + 1} first frame`).toBe(0);
      expect(whitePixels(v, s + 70, 64, 140, 512, 80), `scene ${i + 1} text`).toBeGreaterThan(80);
    });
    // mid-fade: partly visible (scene 2 fades over a full second)
    expect(whitePixels(v, 90 + 15, 64, 140, 512, 80)).toBeLessThan(whitePixels(v, 90 + 70, 64, 140, 512, 80));
  });

  it.each(["remotion", "hyperframes"] as const)("%s image film: a supplied image is shown, a concept screen is labelled, 9:16 geometry holds", async (r) => {
    const rec = await renderOnce(`I-${r}`, I[r], I_SETTINGS, r);
    expect(rec.errors).toEqual([]);
    expect(rec.state).toBe("rendered");
    expect(rec.output).toMatchObject({ container: "mp4", width: 360, height: 640, fps: 30, duration_s: 10, video_codec: "h264", audio_codec: null, audio_tracks: 0 });
    console.log(`${r.toUpperCase()} IMAGE FILM METADATA`, JSON.stringify(rec.output));
    const v = rec.output!.path;
    for (const n of [0, 100, 170, 280]) frameImage(v, n, `${r}-image-f${n}.png`);
    sheet(v, `${r}-image-sheet.png`, 1, 4, 3, 180);
    // scene order: S01 text 0-89 (navy), S02 photo 90-209 (charcoal), S03 screen 210-299 (charcoal)
    expect(near(pixelAt(v, 0, 4, 4), BG.navy)).toBe(true);
    expect(near(pixelAt(v, 90, 4, 4), BG.charcoal)).toBe(true);
    // the image box centre: background on the first frame (the image fades in), the supplied colour once it has
    const cx = 180, cy = Math.round(640 * 0.38);
    expect(near(pixelAt(v, 90, cx, cy), BG.charcoal), "photo not yet visible").toBe(true);
    expect(near(pixelAt(v, 170, cx, cy), BLUE, 24), "supplied photo shown").toBe(true);
    expect(near(pixelAt(v, 280, cx, cy), BLUE, 24), "supplied screen shown").toBe(true);
    // the approved caption is drawn under the image in both
    expect(whitePixels(v, 170, 36, Math.round(640 * 0.86) - 30, 288, 60)).toBeGreaterThan(60);
    expect(whitePixels(v, 280, 36, Math.round(640 * 0.86) - 30, 288, 60)).toBeGreaterThan(60);
    // only the product screen that was not declared a genuine capture carries the concept label
    const bx = Math.round((360 - Math.round(360 * 0.84 / 2) * 2) / 2) + 12, by = Math.round(640 * 0.07) + 12;
    expect(whitePixels(v, 170, bx, by, 160, 24), "photo has no label").toBe(0);
    expect(whitePixels(v, 280, bx, by, 160, 24), "concept label").toBeGreaterThan(40);
    // slow zoom changes nothing visible on a flat colour, so check the scene boundary instead: S03 starts exactly at frame 210
    expect(near(pixelAt(v, 209, 4, 4), BG.charcoal)).toBe(true);
  });

  it.each(["remotion", "hyperframes"] as const)("%s: passes the QA package's technical checks, and records evidence without reviewing anything", async (r) => {
    const rec = await renderOnce(`T-${r}`, T[r], T_SETTINGS, r);
    const qa = await runRenderQa(rec, T[r].handoff);
    expect(qa.findings, JSON.stringify(qa.findings)).toEqual([]);
    expect(qa.passed.map((x) => x.check)).toEqual(expect.arrayContaining(["duration", "resolution", "frame_rate", "black_frames", "frozen_frames"]));
    const recipe = T[r].recipes.get(RECIPES[r].text)!;
    const ev = buildRenderEvidence(rec, recipe, qa);
    expect(ev).toMatchObject({ recipe_id: RECIPES[r].text, recipe_status: "draft", purpose: "preview" });
    const file = saveRenderEvidence(proofDir ?? join(tmp, "evidence"), ev);
    expect(JSON.parse(readFileSync(file, "utf8")).output.sha256).toBe(rec.output!.sha256);
    expect(recipe.status).toBe("draft");
    console.log(`${r.toUpperCase()} QA`, JSON.stringify({ passed: qa.passed.map((x) => x.check), measurements: qa.measurements }));
  });

  it.each(["remotion", "hyperframes"] as const)("%s: the temporary work folder is removed after a render", async (r) => {
    await renderOnce(`T-${r}`, T[r], T_SETTINGS, r);
    expect(readdirSync(workRoot)).toEqual([]);
  });
});

describe.skipIf(skipReal(can))("failures: a stopped or timed-out render leaves no file and no temporary folder", () => {
  it.each(["remotion", "hyperframes"] as const)("%s: a timeout fails the record and removes the partial output", async (r) => {
    const p = planFor(T[r], T_SETTINGS, [r]).plan!;
    const rec = await executeRender(p, { timeoutMs: 1500 });
    expect(rec.state).toBe("failed");
    expect(rec.output).toBeNull();
    expect(rec.errors[0]!.stage).toBe("timeout");
    await new Promise((res) => setTimeout(res, 4000)); // the adapter cleans up after the stop
    expect(existsSync(p.job.output_path)).toBe(false);
  });

  it("a video that is the right size and length but blank is caught, scene by scene, by the content check", async () => {
    const blank = join(tmp, "blank.mp4");
    ff("-f", "lavfi", "-i", "color=c=0x16213e:s=640x360:d=3:r=30", "-pix_fmt", "yuv420p", blank);
    const p = planWebScenes(structuredClone(planFor(T["remotion"], T_SETTINGS, ["remotion"]).plan!.job), { renderer: "remotion", templates: REMOTION_TEMPLATES, outputRoot });
    if (!p.ok) throw new Error(p.issues.join("; "));
    const onlyFirst = await verifySceneContent(blank, p.scenes.slice(0, 1), 640, 360);
    expect(onlyFirst.join(" ")).toContain("E01: the scene shows only its background");
    const all = await verifySceneContent(blank, p.scenes, 640, 360);
    expect(all.length).toBe(3);
    expect(all.join(" ")).toMatch(/E02: .*(missing|could not be read|background)/);
  });

  it("only uses a browser that is already installed, and never downloads one", () => {
    expect(findChrome(join(tmp, "nope", "chrome.exe"))).not.toBe(join(tmp, "nope", "chrome.exe"));
    expect(findRemotionBrowser(join(tmp, "nope", "browser.exe"))).not.toBe(join(tmp, "nope", "browser.exe"));
    expect(findRemotionBrowser(process.execPath)).toBe(process.execPath); // an explicit existing file is honoured
  });
});

// ================= what the adapters refuse, without starting a browser =================
type Job = Omit<RenderJob, "signal">;
const jobOf = (r: "remotion" | "hyperframes", kind: "T" | "I" = "T"): Job => structuredClone(planFor(kind === "T" ? T[r] : I[r], kind === "T" ? T_SETTINGS : I_SETTINGS, [r]).plan!.job);
const op = (j: Job, id: string) => j.operations.find((o) => o.operation_id === id)!;
const issues = (r: "remotion" | "hyperframes", j: Job) => { const p = planWebScenes(j, { renderer: r, templates: r === "remotion" ? REMOTION_TEMPLATES : HYPERFRAMES_TEMPLATES, outputRoot }); return p.ok ? [] : p.issues; };

describe.skipIf(skipReal(can))("explicit capability checks: an unsupported operation is reported before rendering, with its operation", () => {
  it.each(["remotion", "hyperframes"] as const)("%s: the approved jobs have no issues", (r) => {
    expect(issues(r, jobOf(r))).toEqual([]);
    expect(issues(r, jobOf(r, "I"))).toEqual([]);
  });

  const cases: [string, (j: Job) => void, string, "T" | "I"][] = [
    ["a different operation type", (j) => { op(j, "E01").operation_type = "trim_clip"; }, "trim_clip is not supported", "T"],
    ["a transition operation", (j) => { op(j, "E01").operation_type = "concat"; }, "concat is not supported", "T"],
    ["an audio cue", (j) => { op(j, "E01").audio_cues = ["whoosh"]; }, "audio cues cannot be produced", "T"],
    ["an unknown parameter", (j) => { op(j, "E01").parameters["glow"] = 1; }, "unknown parameter glow", "T"],
    ["a fade out of range", (j) => { op(j, "E01").parameters["fade_in_s"] = 9; }, "fade_in_s must be a number from 0.2 to 2", "T"],
    ["a fade longer than the scene", (j) => { op(j, "E01").parameters["fade_in_s"] = 2; op(j, "E01").timing.duration_s = 1; }, "fade_in_s is longer than the scene", "T"],
    ["a background outside the list", (j) => { op(j, "E01").parameters["background"] = "pink"; }, "background must be one of", "T"],
    ["an accent outside the list", (j) => { op(j, "E01").parameters["accent"] = "purple"; }, "accent must be one of", "T"],
    ["a template another renderer owns", (j) => { j.templates["E01"] = "ffmpeg/text-card"; }, "is not supported by the", "T"],
    ["no template", (j) => { delete j.templates["E01"]; }, "template (none) is not supported", "T"],
    ["missing text", (j) => { op(j, "E01").caption = null; }, "no text to show", "T"],
    ["text with a control character", (j) => { op(j, "E01").caption = { text: "bad\u0007text", start_s: 0, end_s: 1 }; }, "control characters", "T"],
    ["text that is too long", (j) => { op(j, "E01").caption = { text: "x".repeat(121), start_s: 0, end_s: 1 }; }, "longer than 120 characters", "T"],
    ["text that does not fit", (j) => { op(j, "E01").caption = { text: "word ".repeat(23).trim(), start_s: 0, end_s: 1 }; }, "does not fit in 6 lines", "I"],
    ["an asset on a text scene", (j) => { op(j, "E01").asset_ids = ["asset_0a1b2c3d"]; }, "this template uses no assets", "T"],
    ["a gap in the timeline", (j) => { op(j, "E02").timing.start_s += 0.5; }, "gaps and overlaps are not rendered", "T"],
    ["a scene that is not whole frames", (j) => { op(j, "E01").timing.duration_s = 3.01; }, "not a whole number of frames", "T"],
    ["a timeline that ends early", (j) => { j.settings.duration_s = 12; }, "the settings say 12s", "T"],
    ["another container", (j) => { j.settings.container = "mov"; }, "writes mp4 with h264", "T"],
    ["another codec", (j) => { j.settings.video_codec = "h265"; }, "writes mp4 with h264", "T"],
    ["an audio track", (j) => { j.settings.audio_codec = "aac"; }, "writes no audio", "T"],
    ["an output path outside the output folder", (j) => { j.output_path = join(tmp, "rn_aaaaaaaaaaaaaaaa.mp4"); }, "not a render file inside the output folder", "T"],
    ["an output file with another name", (j) => { j.output_path = join(outputRoot, "video.mp4"); }, "not a render file inside the output folder", "T"],
    ["no operations", (j) => { j.operations = []; }, "no operations to render", "T"],
    ["an image scene with no image", (j) => { op(j, "E02").asset_ids = []; }, "exactly one supplied image", "I"],
    ["an image scene with two images", (j) => { op(j, "E02").asset_ids = ["asset_0a1b2c3d", "asset_1a2b3c4d"]; }, "exactly one supplied image", "I"],
    ["an image the renderer was not given", (j) => { j.assets = j.assets.filter((a) => a.asset_id !== "asset_0a1b2c3d"); }, "was not supplied to the renderer", "I"],
    ["a video instead of an image", (j) => { j.assets[0]!.media_type = "video"; }, "only images are shown; nothing is substituted", "I"],
    ["an unsupported image type", (j) => { j.assets[0]!.uri = j.assets[0]!.uri.replace(/\.png$/, ".gif"); }, "must be an absolute path to a .png", "I"],
    ["a relative image path", (j) => { j.assets[0]!.uri = "photo.png"; }, "must be an absolute path", "I"],
    ["an image file that is missing", (j) => { j.assets[0]!.uri = join(tmp, "gone.png"); }, "missing or empty", "I"],
    ["an image file that is empty", (j) => { const f = join(tmp, "empty.png"); writeFileSync(f, ""); j.assets[0]!.uri = f; }, "missing or empty", "I"],
    ["a fit outside the list", (j) => { op(j, "E02").parameters["fit"] = "stretch"; }, "fit must be one of", "I"],
    ["a motion outside the list", (j) => { op(j, "E02").parameters["motion"] = "spin"; }, "motion must be one of", "I"],
    ["an unused asset", (j) => { j.assets.push({ asset_id: "asset_extra", media_type: "image", uri: photoPath }); }, "asset asset_extra is not shown by any operation", "I"],
  ];
  describe.each(["remotion", "hyperframes"] as const)("%s", (r) => {
    it.each(cases)("refuses %s", (_name, mutate, expected, kind) => {
      const j = jobOf(r, kind);
      mutate(j);
      const found = issues(r, j);
      expect(found.join(" | "), _name).toContain(expected);
    });
    it("names the operation in each issue it can attribute to one", () => {
      const j = jobOf(r);
      op(j, "E02").parameters["fade_in_s"] = 9;
      expect(issues(r, j).some((x) => x.startsWith("operation E02:"))).toBe(true);
    });
  });
});

describe.skipIf(skipReal(can))("the planner and the adapters agree, and the plan reaches the renderer unchanged", () => {
  it.each(["remotion", "hyperframes"] as const)("%s: the adapter's check is the planner's, so blockers appear while planning", (r) => {
    const p = planFor(T[r], T_SETTINGS, [r]);
    expect(p.record.blockers).toEqual([]);
    // text that cannot be drawn exactly is a planning blocker, not a render-time failure or a silent shrink
    const edited = structuredClone(T[r].output) as { operations: EditorOperation[] };
    expect(edited.operations.length).toBeGreaterThan(0);
    const adapter = adapterOf(r);
    const job = jobOf(r, "I"); // 9:16 at 360 wide: eight characters to a line
    op(job, "E01").caption = { text: "word ".repeat(23).trim(), start_s: 0, end_s: 1 };
    expect(adapter.check!(job).join(" ")).toContain("does not fit");
  });

  it("the generated HyperFrames composition carries every approved scene in order, escaped, with exact timing", () => {
    const j = jobOf("hyperframes");
    op(j, "E01").caption = { text: `A <b>&</b> "q" 'x'`, start_s: 0, end_s: 1 };
    const p = planWebScenes(j, { renderer: "hyperframes", templates: HYPERFRAMES_TEMPLATES, outputRoot });
    if (!p.ok) throw new Error(p.issues.join("; "));
    const html = buildComposition(p.scenes, 640, 360, 30, p.total_frames);
    expect(html).toContain("A &lt;b&gt;&amp;&lt;/b&gt; &quot;q&quot; &#39;x&#39;");
    expect(html).not.toContain("<b>");
    expect([...html.matchAll(/data-start="([\d.]+)" data-duration="([\d.]+)"/g)].slice(1).map((m) => [m[1], m[2]])).toEqual([["0", "3"], ["3", "3"], ["6", "3"]]);
    expect(html).toContain('data-duration="9"');
    expect(html).not.toMatch(/https?:\/\//); // no CDN, no remote asset
  });
});

describe.skipIf(skipReal(can))("renderer selection from the approved plan", () => {
  it.each(["remotion", "hyperframes"] as const)("%s: a plan built from its recipes selects it, and the capabilities are its own", (r) => {
    const p = planFor(T[r], T_SETTINGS, [r]);
    const sel = selectRenderer(p.record);
    expect(sel).toMatchObject({ selected: r, needed: [r], composition_required: false, unsupported: [] });
    expect(sel.capabilities.image_templates).toEqual([`${r}/image-caption`]);
    expect(sel.capabilities.transition_templates).toEqual({});
    expect(previewCoverage(T[r].handoff, T[r].output, p.record, sel.capabilities).complete).toBe(true);
    const pi = planFor(I[r], I_SETTINGS, [r]);
    expect(previewCoverage(I[r].handoff, I[r].output, pi.record, selectRenderer(pi.record).capabilities)).toMatchObject({ complete: true });
  });

  it("a plan whose recipes name a renderer that is not registered is blocked at the exact operation, and nothing else is substituted", () => {
    // all three renderers' adapters exist except Remotion's
    const x = planFor(T["remotion"], T_SETTINGS, ["hyperframes"]);
    expect(x.record.state).toBe("planning");
    expect(x.record.blockers.join(" ")).toContain("E01: no template is registered for remotion/text-slide, and no remotion renderer is available");
    const sel = selectRenderer(x.record);
    expect(sel.selected).toBeNull();
    expect(sel.unsupported.map((u) => u.operation_id)).toEqual(["E01", "E02", "E03"]);
    expect(sel.unsupported[0]!.reasons.join(" ")).toContain("no template is registered for remotion/text-slide");
    expect(previewCoverage(T["remotion"].handoff, T["remotion"].output, x.record, sel.capabilities).complete).toBe(false);
  });

  it("a plan that would need two renderers is reported as such and is not rendered", () => {
    const p = planFor(T["remotion"], T_SETTINGS, ["remotion", "hyperframes"]);
    expect(selectRenderer(p.record).selected).toBe("remotion"); // one renderer needed: fine with both registered
    const mixed = structuredClone(p.record);
    mixed.operations[1] = { ...mixed.operations[1]!, renderer: "hyperframes", implementation_ref: "hyperframes/text-fade" };
    const sel = selectRenderer(mixed);
    expect(sel).toMatchObject({ selected: null, needed: ["remotion", "hyperframes"], composition_required: true });
  });

  it("an FFmpeg-only registry still plans an FFmpeg plan, and cannot run a Remotion one", () => {
    const ffmpegOnly = new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot })]);
    const x = planRender({ editor_output: T["remotion"].output, handoff: T["remotion"].handoff, settings: T_SETTINGS, purpose: "preview" }, { recipes: T["remotion"].recipes, adapters: ffmpegOnly, outputRoot });
    expect(x.ok && x.record.state).toBe("planning");
    expect(ffmpegOnly.template("remotion/text-slide")).toBeNull();
    expect(registryOf("remotion", "hyperframes").template("hyperframes/text-fade")).toEqual({ renderer: "hyperframes" });
    expect(registryOf("remotion").template("hyperframes/text-fade")).toBeNull();
  });

  it("does not silently simplify: a requested crossfade the renderer cannot make leaves the scene unrepresented", async () => {
    const r = "remotion" as const;
    const withFade = await directed("fade-r", project("fader", "16:9", 6), [3, 3], [scene({ id: "S01", dur: 3, text: "One", transition: "crossfade" }), scene({ id: "S02", dur: 3, text: "Two" })], [use(1, "S01", RECIPES[r].text), use(2, "S01", "crossfade", { duration_s: 0.5 }), use(3, "S02", RECIPES[r].text)]);
    const x = planFor(withFade, settings({ w: 640, h: 360, duration: 6, aspect: "16:9" }), [r]);
    expect(x.record.state).toBe("planning"); // the crossfade operation has no remotion template, and a second renderer would be needed
    expect(selectRenderer(x.record).selected).toBeNull();
    const cov = previewCoverage(withFade.handoff, withFade.output, x.record, selectRenderer(x.record).capabilities);
    expect(cov.complete).toBe(false);
    expect(cov.scenes[0]!.missing.join(" ")).toMatch(/crossfade/);
  });

  it("camera motion on supplied media is not carried out, so it is reported", async () => {
    const r = "hyperframes" as const;
    const moving = await directed("move-h", project("moveh", "16:9", 5), [5], [scene({ id: "S01", dur: 5, text: "A photo", assets: ["asset_0a1b2c3d"], camera: "slow_push_in", required: [{ need: "Venue photo", kind: "image", availability: "supplied", asset_id: "asset_0a1b2c3d" }] })], [use(1, "S01", RECIPES[r].image)], I[r].handoff.assets.slice(0, 1));
    const x = planFor(moving, settings({ w: 640, h: 360, duration: 5, aspect: "16:9" }), [r]);
    const cov = previewCoverage(moving.handoff, moving.output, x.record, selectRenderer(x.record).capabilities);
    expect(cov.complete).toBe(false);
    expect(cov.scenes[0]!.missing.join(" ")).toContain("camera motion");
  });
});

describe.skipIf(skipReal(can))("approvals and stale plans are still enforced before either new renderer is asked to do anything", () => {
  it.each(["remotion", "hyperframes"] as const)("%s: a changed handoff, a changed Editor result or a changed text is rejected, with no record", (r) => {
    const base = { editor_output: T[r].output, handoff: T[r].handoff, settings: T_SETTINGS, purpose: "preview" as const };
    const run = (over: object) => planRender({ ...base, ...over }, { recipes: T[r].recipes, adapters: registryOf(r), outputRoot });
    const tamperedHandoff = structuredClone(T[r].handoff) as DirectorHandoff;
    tamperedHandoff.storyboard.scenes[0]!.overlay!.text = "Changed after approval";
    const h = run({ handoff: tamperedHandoff });
    expect(h.ok).toBe(false);
    expect(!h.ok && h.stage).toBe("handoff");
    const tamperedOut = structuredClone(T[r].output) as { operations: EditorOperation[]; handoff_content_hash: string };
    tamperedOut.handoff_content_hash = "0".repeat(64);
    const o = run({ editor_output: tamperedOut });
    expect(o.ok).toBe(false);
    expect(!o.ok && o.stage).toBe("editor_output");
    const reworded = structuredClone(T[r].output) as { operations: EditorOperation[] };
    reworded.operations[0]!.caption = { text: "Something the user never approved", start_s: 0, end_s: 3 };
    const w = run({ editor_output: reworded });
    expect(w.ok).toBe(false);
    expect(!w.ok && w.stage).toBe("editor_output");
  });
});
