import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Asset, Project, type DirectorHandoff, type EditorOperation } from "@digikon/contracts";
import { ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, runEditor, type DirectorStateType } from "@digikon/director";
import { probeFile } from "@digikon/media";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import { cfg, deps, knowledge, root } from "../../director/src/fixtures.js";
import {
  AdapterRegistry, FFMPEG_CAPABILITIES, buildFilterGraph, buildRenderEvidence, createFfmpegAdapter, executeRender, planRender, planScenes, previewCoverage, runRenderQa,
  saveRenderEvidence, sceneTextFiles, validateOutput, type RenderJob,
} from "./index.js";
import { realPrerequisites, recipeFileCount, skipReal } from "./test-env.js";

vi.setConfig({ testTimeout: 120_000 });
const FONTS = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];
const font = FONTS.find((f) => existsSync(f));
realPrerequisites({ font: !!font });
const tmp = mkdtempSync(join(tmpdir(), "scene-render-test-"));
const outputRoot = join(tmp, "out"), workRoot = join(tmp, "work");
mkdirSync(outputRoot); mkdirSync(workRoot);
/** Set RENDER_PROOF_DIR to keep the rendered examples, contact sheets and evidence (for example storage/test-renders). */
const proofDir = process.env["RENDER_PROOF_DIR"];
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ready = { status: "ready", questions: [] };
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "ignore" });
const recipeLib = () => new RecipeLibrary(loadRecipes(root("recipes")), "draft");

// ---- scene and plan builders ----
interface SceneIn { id: string; dur: number; text?: string; assets?: string[]; required?: unknown[]; unresolved?: unknown[]; transition?: string }
const gfx = [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }];
const scene = (s: SceneIn) => ({
  scene_id: s.id, purpose: "p", duration_seconds: s.dur, asset_ids: s.assets ?? [], required_assets: s.required ?? gfx, transition_out: s.transition ?? "cut", ...(s.unresolved ? { unresolved: s.unresolved } : {}),
  shot: { shot_size: "wide", camera_motion: "static", visual_action: "Text and shapes on a plain background" },
  ...(s.text ? { overlay: { text: s.text, safe_area: "platform_safe" } } : {}),
});
const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, number | string> = {}) => ({ use_id: `U${String(n).padStart(2, "0")}`, scene_id, recipe_id, params, rationale: "fits the beat" });
const treatment = (beats: number[], cta: string) => ({ logline: "A short, clear film", hook: "The opening line", tone: "friendly", beats: beats.map((s, i) => ({ beat: `Beat ${i + 1}`, purpose: "p", approx_seconds: s })), cta, claims: [] });
const project = (id: string, brief: string, aspect: "16:9" | "9:16", seconds: number, platform: string) => Project.parse({ project_id: id, owner_id: "u1", brief, objective: "Inform the audience", audience: "General", platform, aspect_ratio: aspect, target_duration: seconds });

async function directed(id: string, p: ReturnType<typeof project>, beats: number[], scenes: unknown[], uses: unknown[], assets: Asset[] = []) {
  const d = deps(new ScriptedClient([ready, treatment(beats, "Learn more"), { scenes }, { uses }]));
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
/** Each film is rendered once and shared by the tests that inspect it: encoding is the slow part, and the suite runs in parallel with others. */
const rendered = new Map<string, Promise<Awaited<ReturnType<typeof executeRender>>>>();
const renderOnce = (key: string, r: Run, s: unknown) => { if (!rendered.has(key)) rendered.set(key, executeRender(planFor(r, s).plan!)); return rendered.get(key)!; };

const settings = (o: { w: number; h: number; fps?: number; duration: number; aspect: "16:9" | "9:16" }) => ({
  aspect_ratio: o.aspect, width: o.w, height: o.h, fps: o.fps ?? 30, duration_s: o.duration, container: "mp4", video_codec: "h264", audio_codec: null,
  source: { kind: "user_approved", reference: "test fixture values, not a platform specification" },
});
const registry = () => new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot })]);
const planFor = (r: Run, s: unknown, purpose: "preview" | "production" = "preview", over: { editor_output?: unknown; handoff?: unknown; adapters?: AdapterRegistry } = {}) => {
  const x = planRender({ editor_output: r.output, handoff: r.handoff, settings: s, purpose, ...over }, { recipes: r.recipes, adapters: over.adapters ?? registry(), outputRoot });
  if (!x.ok) throw new Error(`rejected: ${x.reasons.join("; ")}`);
  return x;
};
const coverageOf = (r: Run, x: ReturnType<typeof planFor>) => previewCoverage(r.handoff, r.output, x.record, FFMPEG_CAPABILITIES);
const frame = (video: string, t: number, name: string) => {
  const png = join(proofDir ?? tmp, name);
  mkdirSync(proofDir ?? tmp, { recursive: true });
  ff("-ss", String(t), "-i", video, "-frames:v", "1", png);
  return readFileSync(png);
};
const sheet = (video: string, name: string, every: number, cols: number, rows: number, w: number) => {
  mkdirSync(proofDir ?? tmp, { recursive: true });
  ff("-i", video, "-vf", `fps=1/${every},scale=${w}:-1,tile=${cols}x${rows}:padding=4:margin=4:color=gray`, "-frames:v", "1", join(proofDir ?? tmp, name));
};

// ================= two materially different graphics-led films =================
// A: a 30 second 16:9 software explainer (titles, a statistic, a list, text cards, two crossfades).
// B: an 18 second 9:16 event announcement built around one supplied image (title, image with slow zoom, schedule list, closing card).
let A: Run, B: Run, C: Run, venuePath: string, dashPath: string;
const A_SETTINGS = settings({ w: 640, h: 360, duration: 30, aspect: "16:9" });
const B_SETTINGS = settings({ w: 720, h: 1280, duration: 18, aspect: "9:16" });
const C_SETTINGS = settings({ w: 640, h: 360, duration: 10, aspect: "16:9" });

beforeAll(async () => {
  A = await directed("ex-a", project("exa", "30 second explainer for a study planner app.", "16:9", 30, "YouTube"), [4, 5, 4, 6, 6, 5], [
    scene({ id: "S01", dur: 4, text: "Meet Lumen | Plan your study week", transition: "crossfade" }),
    scene({ id: "S02", dur: 5, text: "3 steps | to a calmer week | Pick, plan, review" }),
    scene({ id: "S03", dur: 4, text: "Everything in one place." }),
    scene({ id: "S04", dur: 6, text: "What you get | Weekly planner | Deadline reminders | Progress at a glance", transition: "crossfade" }),
    scene({ id: "S05", dur: 6, text: "Made for busy weeks | Plan it, then do it" }),
    scene({ id: "S06", dur: 5, text: "Start planning today." }),
  ], [
    use(1, "S01", "title-subtitle"), use(2, "S01", "crossfade", { duration_s: 0.6 }), use(3, "S02", "stat-callout"), use(4, "S03", "text-card-fade", { background: "charcoal" }),
    use(5, "S04", "bullet-list", { stagger_s: 0.5 }), use(6, "S04", "crossfade", { duration_s: 0.8 }), use(7, "S05", "title-subtitle", { background: "forest", accent: "teal" }), use(8, "S06", "text-card-fade"),
  ]);

  // A supplied image: ffmpeg's test pattern stands in for a photo the user uploaded. It is a test asset, not a real venue.
  venuePath = join(tmp, "venue.png");
  ff("-f", "lavfi", "-i", "testsrc2=s=1280x720:d=1:r=1", "-frames:v", "1", venuePath);
  const venue = await probeFile(venuePath, { assetId: "asset_0a1b2c3d" });
  if (!venue.ok) throw new Error("test image rejected");
  B = await directed("ex-b", project("exb", "18 second Instagram announcement for a riverside jazz night.", "9:16", 18, "Instagram"), [4, 5, 5, 4], [
    scene({ id: "S01", dur: 4, text: "Riverside Jazz Night | Saturday on the terrace", transition: "crossfade" }),
    scene({ id: "S02", dur: 5, text: "Live on the riverside terrace", assets: ["asset_0a1b2c3d"], required: [{ need: "Venue photo", kind: "image", availability: "supplied", asset_id: "asset_0a1b2c3d" }], transition: "crossfade" }),
    scene({ id: "S03", dur: 5, text: "Saturday | Doors at seven | Live trio at eight | Kitchen open late" }),
    scene({ id: "S04", dur: 4, text: "Book your table." }),
  ], [
    use(1, "S01", "title-subtitle", { accent: "coral" }), use(2, "S01", "crossfade", { duration_s: 0.6 }),
    use(3, "S02", "image-scene", { fit: "cover", motion: "slow_zoom", fade_in_s: 0.8 }), use(4, "S02", "crossfade", { duration_s: 0.5 }),
    use(5, "S03", "bullet-list", { stagger_s: 0.6, background: "navy", accent: "coral" }), use(6, "S04", "text-card-fade", { background: "forest" }),
  ], [venue.asset]);

  // A product screen the user declared illustrative: it must be shown labelled as a concept.
  dashPath = join(tmp, "dashboard.png");
  ff("-f", "lavfi", "-i", "testsrc=s=1280x720:d=1:r=1", "-frames:v", "1", dashPath);
  const dash = await probeFile(dashPath, { assetId: "asset_1a2b3c4d" });
  if (!dash.ok) throw new Error("test image rejected");
  C = await directed("ex-c", project("exc", "10 second preview of an app dashboard concept.", "16:9", 10, "YouTube"), [4, 6], [
    scene({ id: "S01", dur: 4, text: "Dashboard preview | Concept only" }),
    scene({ id: "S02", dur: 6, text: "An illustration of the idea", assets: ["asset_1a2b3c4d"], required: [{ need: "Dashboard screen", kind: "ui_screenshot", availability: "supplied", asset_id: "asset_1a2b3c4d" }] }),
  ], [use(1, "S01", "title-subtitle"), use(2, "S02", "image-scene")], [Asset.parse({ ...dash.asset, genuine_product_ui: false })]);
}, 120_000);

describe.skipIf(skipReal(!!font))("two different graphics-led films render, validate and pass QA", () => {
  it.each([
    ["A: 16:9 software explainer", () => A, A_SETTINGS, { w: 640, h: 360, d: 30 }, 6, "ex-a"],
    ["B: 9:16 event announcement with a supplied image", () => B, B_SETTINGS, { w: 720, h: 1280, d: 18 }, 4, "ex-b"],
  ] as const)("%s", async (_name, get, s, expected, scenes, tag) => {
    const r = get();
    const p = planFor(r, s);
    expect(p.record.state, p.record.blockers.join("; ")).toBe("executable");
    expect(p.record.purpose).toBe("preview");
    expect(p.record.operations.every((o) => o.renderer === "ffmpeg" && !o.production_executable)).toBe(true);
    const cov = coverageOf(r, p);
    expect(cov.complete, JSON.stringify(cov.scenes.filter((x) => !x.represented))).toBe(true);
    expect(cov.scenes).toHaveLength(scenes);

    const rec = await renderOnce(tag, r, s);
    expect(rec.state, JSON.stringify(rec.errors)).toBe("rendered");
    expect(rec.output).toMatchObject({ container: "mp4", width: expected.w, height: expected.h, fps: 30, duration_s: expected.d, video_codec: "h264", audio_codec: null, audio_tracks: 0 });
    const again = await validateOutput(rec.output!.path, rec.settings!, false);
    expect(again.ok && again.output.sha256).toBe(rec.output!.sha256); // measured again, independently of the record
    const qa = await runRenderQa(rec, r.handoff);
    expect(qa.findings, JSON.stringify(qa.findings)).toEqual([]);
    expect(qa.passed.map((x) => x.check)).toEqual(expect.arrayContaining(["duration", "resolution", "frame_rate", "black_frames", "frozen_frames"]));
    for (const id of new Set(rec.operations.map((o) => o.recipe_id))) {
      const ev = buildRenderEvidence(rec, r.recipes.get(id)!, qa);
      expect(ev.recipe_status).toBe("draft");
      saveRenderEvidence(proofDir ?? join(tmp, "evidence"), ev);
    }
    sheet(rec.output!.path, `sheet-${tag}.png`, expected.d / 12, 4, 3, 320);
    console.log(`RENDER ${tag}`, JSON.stringify({ output: { ...rec.output, path: undefined, checks: undefined }, qa: qa.passed.map((x) => x.check), measurements: qa.measurements }));
  });

  it("really shows what the plan says: titles, a staggered list, a statistic, the image, and the crossfade", async () => {
    const rec = await renderOnce("ex-a", A, A_SETTINGS);
    const v = rec.output!.path;
    const at = (t: number) => frame(v, t, `a-${t}.png`);
    const flat = at(0.0).length; // a plain colour: nothing has faded in yet
    expect(at(2).length).toBeGreaterThan(flat * 2); // S01: title and subtitle
    expect(at(6.5).length).toBeGreaterThan(flat * 2); // S02: figure, label and context
    // S04 (13s to 19s): the list reveals item by item
    const early = at(13.6).length, late = at(17).length;
    expect(late).toBeGreaterThan(early);
    // the crossfade at the end of S01 (3.4s to 4s) differs from the frames on both sides of it
    const before = at(3.2), mid = at(3.7), after = at(4.5);
    expect(Buffer.compare(mid, before)).not.toBe(0);
    expect(Buffer.compare(mid, after)).not.toBe(0);
    // B: the supplied image is on screen during S02 (4s to 9s) and the scene is richer than a plain card
    const b = await renderOnce("ex-b", B, B_SETTINGS);
    expect(frame(b.output!.path, 6.5, "b-image.png").length).toBeGreaterThan(frame(b.output!.path, 0, "b-0.png").length * 4);
    // slow zoom: the picture changes over the scene
    expect(Buffer.compare(frame(b.output!.path, 5.5, "b-z1.png"), frame(b.output!.path, 8.2, "b-z2.png"))).not.toBe(0);
  });

  it("is deterministic for both films, so the same plan renders to the same bytes", async () => {
    for (const [r, s] of [[A, A_SETTINGS], [B, B_SETTINGS]] as const) {
      const one = await renderOnce(r === A ? "ex-a" : "ex-b", r, s), two = await executeRender(planFor(r, s).plan!);
      expect(one.output!.sha256).toBe(two.output!.sha256);
    }
  });

  it("scene order and timing come from the approved plan, not from the order operations are listed", async () => {
    const p = planFor(A, A_SETTINGS);
    const job = structuredClone(p.plan!.job);
    job.operations.reverse();
    const a = planScenes(job, { outputRoot }), b = planScenes(p.plan!.job, { outputRoot });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.scenes.map((s) => s.operation_id)).toEqual(b.scenes.map((s) => s.operation_id));
      expect(a.scenes.map((s) => s.frames)).toEqual([120, 150, 120, 180, 180, 150]);
      expect(a.scenes.map((s) => s.crossfade_frames)).toEqual([18, 0, 0, 24, 0, 0]);
      expect(a.total_frames).toBe(900);
      expect(buildFilterGraph(a.scenes, 640, 360, 30)).toBe(buildFilterGraph(b.scenes, 640, 360, 30));
    }
  });

  it("an undeclared uploaded screenshot is a normal asset: nothing blocks it, and it is labelled as a concept, never presented as the real product", async () => {
    const shot = await probeFile(dashPath, { assetId: "asset_5a6b7c8d" });
    if (!shot.ok) throw new Error("test image rejected");
    expect(shot.asset.genuine_product_ui).toBeNull(); // never declared
    const U = await directed("ex-undeclared", project("exu", "10 second preview of an app dashboard.", "16:9", 10, "YouTube"), [4, 6], [
      scene({ id: "S01", dur: 4, text: "Dashboard preview | Concept only" }),
      scene({ id: "S02", dur: 6, text: "Your clients in one place", assets: ["asset_5a6b7c8d"], required: [{ need: "Dashboard screen", kind: "ui_screenshot", availability: "supplied", asset_id: "asset_5a6b7c8d" }] }),
    ], [use(1, "S01", "title-subtitle"), use(2, "S02", "image-scene")], [shot.asset]);
    expect(U.output.status).toBe("ready"); // the Editor raises no missing_information conflict for the undeclared screenshot
    expect(U.output.conflicts).toEqual([]);
    const p = planFor(U, C_SETTINGS);
    expect(p.record.state, p.record.blockers.join("; ")).toBe("executable");
    expect(p.plan!.job.concept_asset_ids).toEqual(["asset_5a6b7c8d"]); // shown with the "Concept illustration" label
    expect(coverageOf(U, p).scenes[1]!.labelled.join(" ")).toContain("shown as a concept, not as the real product");
  });
  it("a concept-labelled product screen renders with its label, and the coverage says it is labelled", async () => {
    const p = planFor(C, C_SETTINGS);
    expect(p.record.state, p.record.blockers.join("; ")).toBe("executable");
    expect(p.plan!.job.concept_asset_ids).toEqual(["asset_1a2b3c4d"]);
    const cov = coverageOf(C, p);
    expect(cov.complete).toBe(true);
    expect(cov.scenes[1]!.labelled.join(" ")).toContain("shown as a concept, not as the real product");
    const rec = await executeRender(p.plan!);
    expect(rec.state).toBe("rendered");
    const labelled = frame(rec.output!.path, 6, "c-label.png");
    // the same job without the label is a different picture
    const job = structuredClone(p.plan!.job); job.concept_asset_ids = [];
    const plain = join(outputRoot, "rn_bbbbbbbbbbbbbbbb.mp4");
    await createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot }).render({ ...job, output_path: plain, signal: new AbortController().signal });
    expect(Buffer.compare(labelled, frame(plain, 6, "c-plain.png"))).not.toBe(0);
    rmSync(plain);
    expect(sceneTextFiles(planOf(p.plan!.job).scenes).some((f) => f.name === "badge.txt" && f.content === "Concept illustration")).toBe(true);
  });
});

const planOf = (job: Omit<RenderJob, "signal">) => { const p = planScenes(job, { outputRoot }); if (!p.ok) throw new Error(p.issues.join("; ")); return p; };
const jobA = (): Omit<RenderJob, "signal"> => structuredClone(planFor(A, A_SETTINGS).plan!.job);
const jobB = (): Omit<RenderJob, "signal"> => structuredClone(planFor(B, B_SETTINGS).plan!.job);
const op = (j: Omit<RenderJob, "signal">, id: string) => j.operations.find((o) => o.operation_id === id)!;
const issues = (j: Omit<RenderJob, "signal">) => { const p = planScenes(j, { outputRoot }); return p.ok ? [] : p.issues; };
const setText = (j: Omit<RenderJob, "signal">, id: string, text: string) => { const o = op(j, id); o.caption = { text, start_s: o.timing.start_s, end_s: o.timing.start_s + o.timing.duration_s }; };
const setParam = (j: Omit<RenderJob, "signal">, id: string, k: string, v: unknown) => { op(j, id).parameters = { ...op(j, id).parameters, [k]: v }; };

describe.skipIf(skipReal(!!font))("valid and invalid parameters, text and assets", () => {
  it("accepts both planned jobs as they are", () => { expect(issues(jobA())).toEqual([]); expect(issues(jobB())).toEqual([]); });

  // operation ids of film A: E01 title, E02 crossfade, E03 stat, E04 text card, E05 list, E06 crossfade, E07 title, E08 text card
  it.each<[string, (j: Omit<RenderJob, "signal">) => void, string]>([
    ["a list stagger below the range", (j) => setParam(j, "E05", "stagger_s", 0.05), "stagger_s must be a number from 0.2 to 1"],
    ["a list stagger that is not a number", (j) => setParam(j, "E05", "stagger_s", "0.4:x=1"), "stagger_s must be a number"],
    ["an accent outside the list", (j) => setParam(j, "E01", "accent", "red;drawtext=text=x"), "accent must be one of amber, teal, coral"],
    ["a parameter this template does not have", (j) => setParam(j, "E04", "accent", "amber"), "unknown parameter accent"],
    ["a crossfade shorter than allowed", (j) => setParam(j, "E02", "duration_s", 0.05), "duration_s must be a number from 0.2 to 1.5"],
    ["a crossfade that is not whole frames", (j) => { setParam(j, "E02", "duration_s", 0.61); op(j, "E02").timing = { start_s: 3.39, duration_s: 0.61 }; }, "not a whole number of frames"],
    ["a crossfade longer than half the scene", (j) => { op(j, "E01").timing = { start_s: 0, duration_s: 2.8 }; setParam(j, "E02", "duration_s", 1.5); op(j, "E02").timing = { start_s: 1.3, duration_s: 1.5 }; }, "longer than half"],
    ["a crossfade that is not at the end of its scene", (j) => { op(j, "E02").timing = { start_s: 1, duration_s: 0.6 }; }, "not placed at the end of S01"],
    ["a transition that carries text", (j) => setText(j, "E02", "x"), "a transition carries no text"],
    ["a second transition on one scene", (j) => { const c = structuredClone(op(j, "E02")); c.operation_id = "E09"; j.operations.push(c); j.templates["E09"] = "ffmpeg/xfade-fade"; }, "already has a transition"],
    ["a transition on a scene that is not rendered", (j) => { op(j, "E02").target_scene_id = "S99"; }, "S99 is not rendered"],
    ["a title with more than a subtitle", (j) => setText(j, "E01", "One | Two | Three"), "at most one subtitle"],
    ["an empty section", (j) => setText(j, "E01", "Title | "), "an empty section between | marks"],
    ["a statistic with no label", (j) => setText(j, "E03", "42"), "takes a figure, a label"],
    ["a statistic figure that does not fit", (j) => setText(j, "E03", "1,234,567,890,123 | things"), 'the figure "1,234,567,890,123" does not fit in one line'],
    ["a list with no items", (j) => setText(j, "E05", "Only a heading"), "a heading and two to five items"],
    ["a list with too many items", (j) => setText(j, "E05", "H | 1 | 2 | 3 | 4 | 5 | 6"), "a heading and two to five items"],
    ["a list item that does not fit on one line", (j) => setText(j, "E05", "Heading | a very long list item that cannot possibly fit on a single line of this small frame"), "does not fit in one line"],
    ["a list whose last item would not be fully visible", (j) => { setParam(j, "E05", "stagger_s", 1); setParam(j, "E05", "fade_in_s", 2); op(j, "E05").timing = { ...op(j, "E05").timing }; setText(j, "E05", "H | a | b | c | d | e"); }, "would not be fully visible"],
    ["a title that needs more than two lines", (j) => setText(j, "E01", "word ".repeat(22).trim()), "does not fit in 2 lines"],
    ["a fade longer than the scene", (j) => { setParam(j, "E04", "fade_in_s", 2); op(j, "E04").timing = { ...op(j, "E04").timing, duration_s: 1.5 }; }, "fade_in_s is longer than the scene"],
    ["control characters in a section", (j) => setText(j, "E03", "4\u0007 | things"), "control characters"],
    ["a section on a text card is not split", (j) => { setText(j, "E04", "a | b"); }, ""],
    ["an asset on a template that shows none", (j) => { op(j, "E01").asset_ids = ["asset_x"]; }, "this template uses no assets"],
    ["a title card without text", (j) => { op(j, "E01").caption = null; }, "no text to show"],
  ])("refuses %s before FFmpeg runs", (_n, change, text) => {
    const j = jobA(); change(j);
    const found = issues(j).join(" | ");
    if (text) expect(found).toContain(text); else expect(found).toBe("");
  });

  // film B: E01 title, E02 crossfade, E03 image scene, E04 crossfade, E05 list, E06 text card
  it.each<[string, (j: Omit<RenderJob, "signal">) => void, string]>([
    ["an image fit outside the list", (j) => setParam(j, "E03", "fit", "stretch"), "fit must be one of contain, cover"],
    ["an image motion outside the list", (j) => setParam(j, "E03", "motion", "spin"), "motion must be one of none, slow_zoom"],
    ["an image scene with no image", (j) => { op(j, "E03").asset_ids = []; }, "exactly one supplied image"],
    ["an image scene with two images", (j) => { op(j, "E03").asset_ids = ["asset_0a1b2c3d", "asset_0a1b2c3d"]; }, "exactly one supplied image"],
    ["an image the renderer was not given", (j) => { j.assets = []; }, "was not supplied to the renderer"],
    ["a video instead of an image", (j) => { j.assets[0]!.media_type = "video"; }, "only images are shown"],
    ["an image of an unsupported type", (j) => { j.assets[0]!.uri = j.assets[0]!.uri.replace(/\.png$/, ".gif"); }, "not a .png, .jpg, .jpeg or .webp file"],
    ["an image file that is missing", (j) => { j.assets[0]!.uri = join(tmp, "gone.png"); }, "missing or empty"],
    ["an image file that is empty", (j) => { const f = join(tmp, "empty.png"); writeFileSync(f, ""); j.assets[0]!.uri = f; }, "missing or empty"],
    ["a caption that is missing on the image", (j) => { op(j, "E03").caption = null; }, "no text to show"],
    ["an audio cue on a scene", (j) => { op(j, "E03").audio_cues = ["swoosh"]; }, "audio cues cannot be produced"],
    ["an unused asset", (j) => { j.assets.push({ asset_id: "asset_extra", media_type: "image", uri: venuePath }); }, "asset asset_extra is not shown by any operation"],
    ["another operation type", (j) => { op(j, "E06").operation_type = "mix_audio"; }, "mix_audio is not supported"],
    ["a template implementing another operation type", (j) => { j.templates["E03"] = "ffmpeg/xfade-fade"; }, "implements concat operations, not render_graphics_scene"],
    ["a gap between scenes", (j) => { op(j, "E05").timing = { start_s: 10.5, duration_s: 4.5 }; }, "gaps and overlaps are not rendered"],
  ])("refuses %s before FFmpeg runs", (_n, change, text) => {
    const j = jobB(); change(j);
    expect(issues(j).join(" | ")).toContain(text);
  });

  it("an adapter refusal is a planning blocker, so no preview is offered", async () => {
    // a list item too long for the frame: the Editor and Director accept it, the renderer cannot show it
    const r = await directed("ex-long", project("exl", "10 second list.", "16:9", 10, "YouTube"), [5, 5], [scene({ id: "S01", dur: 5, text: "Heading | an item far too long to fit on one line of this small frame at all" }), scene({ id: "S02", dur: 5, text: "Done." })], [use(1, "S01", "bullet-list"), use(2, "S02", "text-card-fade")]);
    const p = planFor(r, settings({ w: 640, h: 360, duration: 10, aspect: "16:9" }));
    expect(p.record.state).toBe("planning");
    expect(p.plan).toBeNull();
    expect(p.record.blockers.join(" ")).toContain("operation E01: the item 1");
    expect(p.record.blockers.join(" ")).toContain("does not fit in one line");
  });

  it("shows any text literally in every layout, and nothing from it reaches an FFmpeg argument", async () => {
    const nasty = "It's 50% off: a, b; c [v0] \\ \"q\" %{pts}";
    const cases: [string, string, string, Record<string, unknown>][] = [
      ["E01", "title-subtitle", `${nasty} | '; drawtext=text=pwned`, {}],
      ["E03", "stat-callout", `5% | ${nasty} | $(calc) \`calc\` & | > nul`.replace(" | > nul", ""), {}],
      ["E05", "bullet-list", `${nasty} | Zażółć gęślą — 日本語 | %{localtime}`, { stagger_s: 0.3 }],
    ];
    for (const [id, name, text] of cases) {
      const j = jobA();
      const keep = op(j, id);
      keep.timing = { start_s: 0, duration_s: 6 };
      keep.caption = { text, start_s: 0, end_s: 6 };
      j.operations = [keep];
      j.settings = { ...j.settings, duration_s: 6 };
      const planned = planScenes(j, { outputRoot });
      expect(planned.ok, `${name}: ${(planned as { issues?: string[] }).issues?.join("; ")}`).toBe(true);
      const out = join(outputRoot, "rn_aaaaaaaaaaaaaaaa.mp4");
      await createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot }).render({ ...j, output_path: out, signal: new AbortController().signal });
      expect((await validateOutput(out, j.settings, false)).ok, name).toBe(true);
      if (planned.ok) expect(buildFilterGraph(planned.scenes, 640, 360, 30), name).not.toMatch(/pwned|calc|localtime|Zażółć/);
      rmSync(out);
    }
    expect(readdirSync(workRoot)).toEqual([]); // the temporary files are gone
  });
});

describe.skipIf(skipReal(!!font))("unsupported content is refused for the complete preview, scene by scene", () => {
  it("refuses a transition the renderer cannot do, naming the scene", async () => {
    const r = await directed("ex-dip", project("exd", "10 second film.", "16:9", 10, "YouTube"), [5, 5], [
      scene({ id: "S01", dur: 5, text: "First.", transition: "dip_to_black" }), scene({ id: "S02", dur: 5, text: "Second." }),
    ], [use(1, "S01", "text-card-fade"), use(2, "S01", "dip-to-black"), use(3, "S02", "text-card-fade")]);
    const p = planFor(r, settings({ w: 640, h: 360, duration: 10, aspect: "16:9" }));
    expect(p.record.state).toBe("planning");
    expect(p.record.blockers.join(" ")).toContain("no template is registered for ffmpeg/xfade-fadeblack");
    const cov = coverageOf(r, p);
    expect(cov.complete).toBe(false);
    expect(cov.scenes[0]!.missing.join(" ")).toContain("dip to black transition");
    expect(cov.scenes[1]!.represented).toBe(true);
  });

  it("refuses a placeholder logo, and says exactly what that scene lacks", async () => {
    const r = await directed("ex-gap", project("exg", "12 second film.", "16:9", 12, "YouTube"), [4, 4, 4], [
      scene({ id: "S01", dur: 4, text: "Opening." }),
      scene({ id: "S02", dur: 4, text: "Your brand.", required: [{ need: "Brand logo", kind: "logo", availability: "generate_graphics", placeholder: true }], unresolved: [{ kind: "placeholder", note: "No logo supplied: a generic wordmark card is shown." }] }),
      scene({ id: "S03", dur: 4, text: "Closing." }),
    ], [use(1, "S01", "text-card-fade"), use(2, "S02", "text-card-fade"), use(3, "S03", "text-card-fade")]);
    const p = planFor(r, settings({ w: 640, h: 360, duration: 12, aspect: "16:9" }));
    expect(p.record.state).toBe("planning"); // every operation could run, but that would not be the approved video, so the planner itself refuses
    expect(p.plan).toBeNull();
    expect(p.record.blockers.join(" ")).toContain('S02: it needs a logo ("Brand logo", currently a placeholder)');
    const cov = coverageOf(r, p);
    expect(cov.complete).toBe(false);
    expect(cov.scenes.map((s) => s.represented)).toEqual([true, false, true]);
    expect(cov.scenes[1]!.missing.join(" ")).toContain('a logo ("Brand logo", currently a placeholder)');
  });

  it("refuses supplied video, and scene voiceover stops the Editor result from being rendered at all", async () => {
    // a supplied video is not shown: the same handoff with the venue photo declared a video
    const asVideo = { ...B.handoff, assets: B.handoff.assets.map((a) => ({ ...a, media_type: "video" as const })) } as DirectorHandoff;
    const cov = previewCoverage(asVideo, B.output, planFor(B, B_SETTINGS).record, FFMPEG_CAPABILITIES);
    expect(cov.complete).toBe(false);
    expect(cov.scenes[1]!.missing.join(" ")).toContain("supplied video (asset_0a1b2c3d), which this renderer cannot show yet");
    // voiceover: the Editor reports it as unsupported, so the result is blocked and no render plan exists
    const v = await directed("ex-vo", project("exv", "10 second film.", "16:9", 10, "YouTube"), [5, 5], [
      scene({ id: "S01", dur: 5, text: "Opening." }), { ...scene({ id: "S02", dur: 5, text: "Spoken." }), voiceover: "Words that someone would say." },
    ], [use(1, "S01", "text-card-fade"), use(2, "S02", "text-card-fade")]);
    expect(v.output.status).toBe("blocked");
    const r = planRender({ editor_output: v.output, handoff: v.handoff, settings: settings({ w: 640, h: 360, duration: 10, aspect: "16:9" }), purpose: "preview" }, { recipes: v.recipes, adapters: registry(), outputRoot });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.stage).toBe("editor_output"); expect(r.reasons.join(" ")).toMatch(/not ready|open conflicts/); }
  });
  it("a supplied image is not shown by a plain text card, so that scene is refused", async () => {
    const r = await directed("ex-img-text", project("exi", "10 second film.", "16:9", 10, "YouTube"), [5, 5], [
      scene({ id: "S01", dur: 5, text: "A photo.", assets: ["asset_0a1b2c3d"], required: [{ need: "Photo", kind: "image", availability: "supplied", asset_id: "asset_0a1b2c3d" }] }), scene({ id: "S02", dur: 5, text: "Thanks." }),
    ], [use(1, "S01", "image-scene"), use(2, "S02", "text-card-fade")], [B.handoff.assets[0]!]);
    const base = planFor(r, settings({ w: 640, h: 360, duration: 10, aspect: "16:9" }));
    expect(coverageOf(r, base).complete).toBe(true); // an image scene shows the image
    const none = planFor(r, settings({ w: 640, h: 360, duration: 10, aspect: "16:9" }), "preview", { adapters: new AdapterRegistry() });
    const cov = previewCoverage(r.handoff, r.output, none.record, FFMPEG_CAPABILITIES);
    expect(cov.complete).toBe(false);
    expect(cov.scenes[0]!.missing.join(" ")).toContain("has no renderer that can run it");
    expect(cov.scenes[0]!.missing.join(" ")).toContain("its supplied image (asset_0a1b2c3d) is not shown by any operation");
  });
});

describe.skipIf(skipReal(!!font))("failures, timeouts and cleanup", () => {
  it("a failed render leaves no output and no temporary files, for an image film too", async () => {
    const bad = join(tmp, "broken.ttf");
    writeFileSync(bad, "this is not a font");
    const a = new AdapterRegistry([createFfmpegAdapter({ fontFile: bad, outputRoot, workRoot })]);
    const p = planFor(B, B_SETTINGS, "preview", { adapters: a }).plan!;
    const rec = await executeRender(p);
    expect(rec).toMatchObject({ state: "failed", output: null });
    expect(rec.errors[0]).toMatchObject({ stage: "adapter" });
    expect(existsSync(p.job.output_path)).toBe(false);
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it("a timeout stops FFmpeg, and the partial file and work folder are removed", async () => {
    const p = planFor(B, B_SETTINGS).plan!;
    const rec = await executeRender(p, { timeoutMs: 1 });
    expect(rec).toMatchObject({ state: "failed", output: null });
    expect(rec.errors[0]!.stage).toBe("timeout");
    for (let i = 0; i < 60 && (existsSync(p.job.output_path) || readdirSync(workRoot).length); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(p.job.output_path)).toBe(false);
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it("a render whose image changed after approval is refused before FFmpeg runs", async () => {
    const p = planFor(B, B_SETTINGS).plan!;
    const original = readFileSync(venuePath);
    try {
      writeFileSync(venuePath, Buffer.concat([original, Buffer.from([0])]));
      const rec = await executeRender(p, { storageRoot: undefined });
      expect(rec.state).toBe("failed");
      expect(rec.errors[0]).toMatchObject({ stage: "precheck" });
      expect(rec.errors[0]!.message).toContain("changed on disk");
      expect(existsSync(p.job.output_path)).toBe(false);
    } finally { writeFileSync(venuePath, original); }
  });
});

describe.skipIf(skipReal(!!font))("approvals, preview and production stay separate", () => {
  it("a production render of either film stays in planning: every recipe used is still a draft", () => {
    for (const [r, s] of [[A, A_SETTINGS], [B, B_SETTINGS]] as const) {
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

  it("a handoff changed after approval, or Editor text changed after approval, is rejected before any layout is planned", () => {
    const edited = { ...A.handoff, constraints: { ...A.handoff.constraints, platform: "Elsewhere" } } as DirectorHandoff;
    const r1 = planRender({ editor_output: A.output, handoff: edited, settings: A_SETTINGS, purpose: "preview" }, { recipes: A.recipes, adapters: registry(), outputRoot });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.stage).toBe("handoff");
    const ops = structuredClone(A.output.operations) as EditorOperation[];
    ops[0]!.caption = { text: "Different words | entirely", start_s: 0, end_s: 4 };
    const r2 = planRender({ editor_output: { ...A.output, operations: ops }, handoff: A.handoff, settings: A_SETTINGS, purpose: "preview" }, { recipes: A.recipes, adapters: registry(), outputRoot });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reasons.join(" ")).toContain("caption text is not the approved overlay text");
    // the approved wording is exactly what is rendered: the job carries the Editor's captions unchanged
    const j = planFor(A, A_SETTINGS).plan!.job;
    expect(j.operations.filter((o) => o.caption).map((o) => o.caption!.text)).toEqual(A.handoff.storyboard.scenes.map((s) => s.overlay!.text));
  });

  it("settings that do not match the approved plan are blockers: wrong aspect ratio, wrong duration, a size that is not the ratio", () => {
    expect(planFor(A, { ...A_SETTINGS, aspect_ratio: "9:16", width: 360, height: 640 }).record.blockers.join(" ")).toContain("but the approved project is 16:9");
    expect(planFor(B, { ...B_SETTINGS, duration_s: 20 }).record.blockers.join(" ")).toContain("but the approved storyboard lasts 18s");
    expect(planFor(A, { ...A_SETTINGS, width: 641, height: 360 }).record.state).toBe("planning");
    expect(planFor(A, undefined).record.blockers.join(" ")).toContain("no output settings were supplied");
  });
});
