import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Transcript } from "@digikon/contracts";
import { DemoClient, SkillLibrary, type GenerateRequest } from "@digikon/director";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import { RenderSettings } from "@digikon/contracts";
import { findChrome, findRemotionBrowser, validateOutput } from "@digikon/render";
import type { SpeechEngine } from "@digikon/speech";
import { createApp } from "./app.js";
import { realPrerequisites, skipReal } from "../../../packages/render/src/test-env.js";

// The console renders through the multi-engine assembler: FFmpeg and HyperFrames scenes in one film, a labelled incomplete preview
// when a scene cannot be drawn, and delivery reports served with the actual file. Real renders; the Director is a scripted stand-in.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const recipes = loadRecipes(join(repo, "recipes"));
const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
const chrome = findChrome();
const can = !!font && !!chrome;
realPrerequisites({ font: !!font, "a Chrome for HyperFrames": !!chrome });
vi.setConfig({ testTimeout: 240_000 });
import { seedCapabilities } from "./test-capabilities.js";
let dir: string, store: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "console-assembly-")); store = join(dir, "capabilities"); seedCapabilities(store, ["ffmpeg__xfade-fadeblack"]); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const speech: SpeechEngine = { model: "stub", transcribe: async () => Transcript.parse({ text: "x", language: "en", language_confidence: 1, model: "stub", duration_s: 1, words: [], segments: [] }) };
const scene = (id: string, text: string, transition = "cut") => ({
  scene_id: id, purpose: "p", duration_seconds: 4, asset_ids: [], required_assets: [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }], transition_out: transition,
  shot: { shot_size: "wide", camera_motion: "static", visual_action: "Text on a plain background" }, overlay: { text, safe_area: "platform_safe" },
});
const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, unknown> = {}) => ({ use_id: `U0${n}`, scene_id, recipe_id, params, rationale: "plain text scene" });
type Film = { scenes: ReturnType<typeof scene>[]; uses: ReturnType<typeof use>[] };
let film: Film;
class Client extends DemoClient {
  override async generate<T>(req: GenerateRequest<T>): Promise<T> {
    if (req.name === "storyboard") return req.schema.parse({ scenes: film.scenes });
    if (req.name === "edit_plan") return req.schema.parse({ uses: film.uses });
    return super.generate(req);
  }
}
const build = () => createApp({
  llm: new Client(), demo: true, speech, whisper: () => ({ state: "ready" }), skills: new SkillLibrary(join(repo, "skills")), editorSkills: new SkillLibrary(join(repo, "skills/editor")),
  retriever: new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge"))]),
  recipes: new RecipeLibrary(recipes, "draft"), ffmpegOk: true, renderFont: font, storageDir: dir, publicDir: join(repo, "apps/console/public"), capabilitiesDir: store,
});
type App = ReturnType<typeof build>;
const json = (b: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const body = async (r: Response) => (await r.json()) as any;
const SETTINGS = { aspect_ratio: "16:9", width: 640, height: 360, fps: 30, duration_s: 12, container: "mp4", video_codec: "h264", audio_codec: null };
async function sse(res: Response) { const t = await res.text(); if (process.env.DEBUG_SSE) console.log(t.slice(-1500)); }
const approve = (app: App, id: string, stage: "storyboard" | "edit_plan") => app.request(`/api/sessions/${id}/approve`, json({ stage, plan_version: 1, decision: "approved", ...(stage === "edit_plan" ? { storyboard_version: 1 } : {}) }));
/** A film the production gate refuses: the storyboard is approved, but no edit plan ever waits for a decision, so nothing downstream can run. */
async function gatedRun(app: App, f: Film) {
  film = f;
  const id = (await body(await app.request("/api/sessions", { method: "POST" }))).id as string;
  await app.request(`/api/sessions/${id}/route`, json({ text: "A 12 second YouTube explainer for my online course." }));
  await sse(await app.request(`/api/sessions/${id}/direct`, json({})));
  const a1 = await approve(app, id, "storyboard"); expect(a1.status).toBe(200);
  const state = ((await a1.json()) as { state: { escalation: { what_failed: string } | null; editPlan: unknown } }).state;
  expect(state.editPlan).toBeNull();
  expect(state.escalation?.what_failed).toContain("edit plan still failed validation");
  expect((await approve(app, id, "edit_plan")).status, "no edit plan is waiting for a decision").toBe(409);
  expect((await app.request(`/api/sessions/${id}/editor`, { method: "POST" })).status, "the Editor has nothing approved to run on").toBe(409);
  return id;
}
async function approvedRun(app: App, f: Film, editorReady = true) {
  film = f;
  const id = (await body(await app.request("/api/sessions", { method: "POST" }))).id as string;
  await app.request(`/api/sessions/${id}/route`, json({ text: "A 12 second YouTube explainer for my online course." }));
  await sse(await app.request(`/api/sessions/${id}/direct`, json({})));
  const a1 = await approve(app, id, "storyboard"); const j1 = await a1.clone().json(); expect(a1.status).toBe(200); if (process.env.DEBUG_SSE) console.log("ESC", Object.keys(j1).join(","), JSON.stringify({ e: j1.state.escalation, g: j1.state.gate, ep: j1.state.editPlan ? "plan" : null, v: j1.state.editPlanValidation ?? j1.state.problems }));
  const ap = await approve(app, id, "edit_plan"); expect(ap.status, JSON.stringify(await ap.clone().json())).toBe(200);
  expect((await app.request(`/api/sessions/${id}/editor`, { method: "POST" })).status, "the Editor runs").toBe(200);
  void editorReady;
  return id;
}

const MIXED: Film = {
  scenes: [scene("S01", "Learn at your pace.", "dip_to_black"), scene("S02", "One place for it all.", "crossfade"), scene("S03", "Start today.")],
  uses: [use(1, "S01", "text-card-fade"), use(2, "S01", "dip-to-black", { duration_s: 0.6 }), use(3, "S02", "text-fade-hyperframes"), use(4, "S02", "crossfade", { duration_s: 0.5 }), use(5, "S03", "text-card-fade", { background: "forest" })],
};
const WITH_GAP: Film = {
  scenes: [scene("S01", "Learn at your pace."), scene("S02", "Presented by us."), scene("S03", "Start today.")],
  uses: [use(1, "S01", "text-card-fade"), use(2, "S02", "text-card-fade"), use(4, "S02", "text-fade-hyperframes"), use(3, "S03", "text-card-fade", { background: "forest" })],
};

describe.skipIf(skipReal(can))("the console renders through the multi-engine assembler", () => {
  it("a film needing FFmpeg and HyperFrames is assembled, reported and served as a complete preview that is not production-ready", async () => {
    const app = build();
    const id = await approvedRun(app, MIXED);
    const plan = await body(await app.request(`/api/sessions/${id}/render/plan`, json({ settings: SETTINGS })));
    expect(plan.eligible).toBe(false); // the single-renderer planner refuses a film that needs two renderers
    expect(plan.assembly).toMatchObject({ ok: true, complete: true }); // the dip to black has validated evidence (seeded), so every scene can be drawn
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS }));
    const out = await body(res);
    expect(res.status, JSON.stringify(out.errors ?? out.reasons ?? out.message)).toBe(200);
    expect(out.kind).toBe("complete");
    expect(out.delivery).toMatchObject({ kind: "complete", status: "complete_preview", states: { scenes_total: 3, scenes_rendered: 3, final_video_validated: true, final_delivery_ready: false } });
    expect(out.delivery.final_delivery_blockers.join(" ")).toContain("every recipe used is still a draft");
    expect(out.delivery.engines_used.sort()).toEqual(["ffmpeg", "hyperframes"]);
    expect(out.record).toMatchObject({ state: "rendered", purpose: "preview" });
    expect(JSON.stringify(out)).not.toContain(dir.replaceAll("\\", "\\\\")); // no absolute path reaches the browser
    expect(out.delivery.output.path).not.toMatch(/^([a-zA-Z]:|\/)/);
    // the dip to black was validated before the plan was approved, and is still the one record in the store
    expect(existsSync(join(store, "registry", "ffmpeg", "ffmpeg__xfade-fadeblack.json"))).toBe(true);
    // the listed delivery is the one just made, and the video served is the very file the report names
    const list = await body(await app.request(`/api/sessions/${id}/deliveries`));
    expect(list.deliveries.map((d: any) => d.delivery_id)).toEqual([out.delivery.delivery_id]);
    const video = await app.request(out.delivery.output.video_url);
    expect(video.status).toBe(200);
    expect(video.headers.get("x-digikon-preview")).toBe("complete");
    expect((await video.arrayBuffer()).byteLength).toBe(out.delivery.output.bytes);
    expect((await app.request(`/api/sessions/${id}/deliveries/dl_0000000000000000`)).status).toBe(404);
    expect((await app.request(`/api/sessions/${id}/deliveries/..%2f..%2fx/video`)).status).toBe(404);
  });

  it("a scene nothing can draw is stopped at planning, before any approval, and nothing is rendered", async () => {
    const app = build();
    const id = await gatedRun(app, WITH_GAP); // text-card-fade and text-fade-hyperframes in one scene need two engines, which the renderer does not support
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS }));
    expect(res.status).toBe(409);
    expect((await body(res)).kind ?? null).not.toBe("partial");
  });

  it("when nothing can be drawn at all, planning stops and no video is made", async () => {
    const app = build();
    const id = await gatedRun(app, { scenes: [scene("S01", "Presented by us."), scene("S02", "Presented again."), scene("S03", "Presented last.")], uses: [use(1, "S01", "text-card-fade"), use(4, "S01", "text-fade-hyperframes"), use(2, "S02", "text-card-fade"), use(5, "S02", "text-fade-hyperframes"), use(3, "S03", "text-card-fade"), use(6, "S03", "text-fade-hyperframes")] });
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS }));
    expect(res.status).toBe(409);
  });
  it("approval gates stay in force: no render without both approvals and the Editor result", async () => {
    const app = build();
    film = MIXED;
    const id = (await body(await app.request("/api/sessions", { method: "POST" }))).id as string;
    expect((await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS }))).status).toBe(409);
  });
});

const remotionBrowser = findRemotionBrowser();
describe.skipIf(skipReal(can && !!remotionBrowser))("automatic capability learning, end to end: analyse, detect, learn, render, validate, save, reuse, retry, deliver honestly", () => {
  // the 12 second, three-scene plan: a hard cut, a dip to black, a Remotion text animation, and an approved slow push-in on a plain text card that nothing can carry out
  const PLAN: Film = {
    scenes: [scene("S01", "Learn at your pace."), { ...scene("S02", "One place for everything.", "dip_to_black"), shot: { shot_size: "wide", camera_motion: "slow_push_in", visual_action: "Text on a plain background" } }, scene("S03", "Start today.")],
    uses: [use(1, "S01", "text-card-fade"), use(2, "S01", "hard-cut"), use(3, "S02", "text-card-fade", {}), use(4, "S02", "dip-to-black", { duration_s: 0.6 }), use(5, "S03", "text-fade-up")],
  };
  const SETTINGS_E2E = { aspect_ratio: "16:9", width: 640, height: 360, fps: 30, duration_s: 12, container: "mp4", video_codec: "h264", audio_codec: null };
  let capDir: string, outPath: string, firstDeliveryId: string;
  const attemptsOf = (engine: string, file: string) => JSON.parse(readFileSync(join(capDir, "registry", engine, file), "utf8")).attempts.length as number;
  const buildWith = (store: string) => createApp({
    llm: new Client(), demo: true, speech, whisper: () => ({ state: "ready" }), skills: new SkillLibrary(join(repo, "skills")), editorSkills: new SkillLibrary(join(repo, "skills/editor")),
    retriever: new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge"))]),
    recipes: new RecipeLibrary(recipes, "draft"), ffmpegOk: true, renderFont: font, storageDir: dir, publicDir: join(repo, "apps/console/public"), capabilitiesDir: store,
  });

  it("a registry holding the validated evidence the plan needs: the render uses it, renders every scene, and labels the film incomplete because of the one thing nothing can do", async () => {
    capDir = join(dir, "e2e-capabilities");
    seedCapabilities(capDir, ["ffmpeg__xfade-fadeblack", "remotion__text-fade-up"]);
    const app = buildWith(capDir);
    const id = await approvedRun(app, PLAN);
    const plan = await body(await app.request(`/api/sessions/${id}/render/plan`, json({ settings: SETTINGS_E2E })));
    expect(plan.eligible).toBe(false);
    expect(plan.capability.map((o: any) => [o.recipe_id, o.status]).filter((x: any) => ["dip-to-black", "text-fade-up"].includes(x[0]))).toEqual([["dip-to-black", "validated_available"], ["text-fade-up", "validated_available"]]);
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS_E2E }));
    const out = await body(res);
    expect(res.status, JSON.stringify(out.errors ?? out.reasons ?? out.message)).toBe(200);
    // nothing needed learning: the plan could only be approved because both capabilities already had validated evidence
    expect(out.learning?.attempted ?? []).toEqual([]);
    expect(existsSync(join(capDir, "registry", "ffmpeg", "ffmpeg__xfade-fadeblack.json"))).toBe(true);
    expect(existsSync(join(capDir, "registry", "remotion", "remotion__text-fade-up.json"))).toBe(true);
    // the original plan was retried and rendered: every scene, one engine each; the push-in nobody can carry out is named, and the film is labelled incomplete
    expect(out.kind).toBe("partial");
    expect(out.delivery.scenes.map((s: any) => [s.scene_id, s.engine, s.status])).toEqual([["S01", "ffmpeg", "rendered_unverified"], ["S02", "ffmpeg", "rendered_unverified"], ["S03", "remotion", "rendered_and_verified"]]);
    expect(out.delivery.scenes[1].unmet.join(" ")).toContain("camera motion (slow push in)");
    expect(out.delivery.label).toContain("INCOMPLETE PREVIEW");
    expect(out.delivery.states).toMatchObject({ scenes_rendered: 3, final_video_validated: true, final_delivery_ready: false });
    expect(out.delivery.transitions.map((t: any) => [t.template, t.status])).toEqual([["ffmpeg/concat-cut", "applied"], ["ffmpeg/xfade-fadeblack", "applied"]]);
    // the MP4, by FFprobe and by its frames
    const video = await app.request(out.delivery.output.video_url);
    expect(video.status).toBe(200);
    outPath = join(dir, "e2e-final.mp4"); writeFileSync(outPath, Buffer.from(await video.arrayBuffer()));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,pix_fmt,width,height,r_frame_rate,nb_read_frames,duration", "-of", "json", outPath], { encoding: "utf8" })).streams[0];
    expect(probe).toMatchObject({ codec_name: "h264", pix_fmt: "yuv420p", width: 640, height: 360, r_frame_rate: "30/1", nb_read_frames: "360" });
    const px = (n: number) => { const f = join(dir, `f${n}.raw`); execFileSync("ffmpeg", ["-v", "error", "-y", "-i", outPath, "-vf", `select=eq(n\\,${n}),scale=1:1`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", f]); return [...readFileSync(f)]; };
    expect(px(60).every((v, i) => Math.abs(v - [22, 33, 62][i]!) < 16)).toBe(true);        // S01: the approved navy card
    expect(Math.max(...px(120 + 120 - 18 + 5))).toBeLessThan(20);                              // inside the approved dip to black at the end of S02 (frames 222 to 239)
    expect(Math.max(...px(300))).toBeGreaterThan(30);                                        // S03 is on screen after the dip, not black
    if (process.env["RENDER_PROOF_DIR"]) { mkdirSync(process.env["RENDER_PROOF_DIR"], { recursive: true }); copyFileSync(outPath, join(process.env["RENDER_PROOF_DIR"], "auto-learning-e2e.mp4")); }
    firstDeliveryId = out.delivery.delivery_id;
  });

  it("after a restart, and in a second independent project, the learned capabilities are found and reused: no relearning, no new attempts", async () => {
    const before = [attemptsOf("ffmpeg", "ffmpeg__xfade-fadeblack.json"), attemptsOf("remotion", "remotion__text-fade-up.json")];
    const app = buildWith(capDir); // a new application with no memory of the first
    const health = await body(await app.request("/api/health"));
    expect(health.render.learned).toEqual(expect.arrayContaining(["ffmpeg:dip-to-black", "remotion:text-fade-up"]));
    const id = await approvedRun(app, PLAN); // an independent project
    const plan = await body(await app.request(`/api/sessions/${id}/render/plan`, json({ settings: SETTINGS_E2E })));
    expect(plan.capability.filter((o: any) => ["dip-to-black", "text-fade-up"].includes(o.recipe_id)).map((o: any) => o.status)).toEqual(["validated_available", "validated_available"]);
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS_E2E }));
    const out = await body(res);
    expect(res.status, JSON.stringify(out.errors ?? out.message)).toBe(200);
    expect(out.learning?.attempted ?? []).toEqual([]);
    expect(out.kind).toBe("partial");
    expect(out.delivery.delivery_id).not.toBe(firstDeliveryId);
    expect([attemptsOf("ffmpeg", "ffmpeg__xfade-fadeblack.json"), attemptsOf("remotion", "remotion__text-fade-up.json")]).toEqual(before);
  });

  it("approved audio cues with no sound recipe make the Editor 'blocked', but that no longer refuses the whole project: a labelled incomplete preview is rendered and the audio is listed as unresolved", async () => {
    const app = buildWith(capDir);
    const cued: Film = { scenes: PLAN.scenes.map((s, i) => ({ ...s, audio_cues: i === 0 ? ["Soft, calm music starts"] : [] })), uses: PLAN.uses };
    const id = await approvedRun(app, cued, false);
    const ed = await body(await app.request(`/api/sessions/${id}/render/plan`, json({ settings: SETTINGS_E2E })));
    expect(ed.editor.status).toBe("blocked");
    expect(ed.editor.conflicts.map((x: any) => x.kind)).toEqual(["missing_information"]);
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS_E2E }));
    const out = await body(res);
    expect(res.status, JSON.stringify(out.errors ?? out.message ?? out.reasons)).toBe(200);
    expect(out.kind).toBe("partial");
    expect(out.delivery.label).toContain("INCOMPLETE PREVIEW");
    expect(out.delivery.scenes[0].unmet.join(" ")).toContain("audio cues");
    expect(out.delivery.states.final_delivery_ready).toBe(false);
    expect(out.delivery.final_delivery_blockers.join(" ")).toMatch(/requires audio|incomplete/);
    // any other open conflict still refuses
  });
  it("a capability nothing can implement is stopped at planning, before any approval: the film is never rendered with it", async () => {
    const app = buildWith(capDir);
    const withAudio: Film = { scenes: PLAN.scenes, uses: [...PLAN.uses, use(6, "S03", "loudness-normalise")] };
    const id = await gatedRun(app, withAudio); // loudness-normalise has no validated capability and none can be learned
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS_E2E }));
    expect(res.status).toBe(409);
  });
});

describe.skipIf(skipReal(can))("a preview of one scene through the console", () => {
  it("is refused before both approvals, renders one scene after them, serves it, and serves the same scene from the cache the second time", async () => {
    const app = build();
    film = MIXED;
    const early = (await body(await app.request("/api/sessions", { method: "POST" }))).id as string;
    await app.request(`/api/sessions/${early}/route`, json({ text: "A 12 second YouTube explainer for my online course." }));
    await sse(await app.request(`/api/sessions/${early}/direct`, json({})));
    expect((await app.request(`/api/sessions/${early}/scenes/S01/preview`, json({ settings: SETTINGS }))).status, "nothing is rendered before the approvals").toBe(409);

    const id = await approvedRun(app, MIXED);
    const first = await app.request(`/api/sessions/${id}/scenes/S01/preview`, json({ settings: SETTINGS }));
    const a = await body(first);
    expect(first.status, JSON.stringify(a)).toBe(200);
    expect(a).toMatchObject({ scene_id: "S01", cached: false, engine: "ffmpeg", sound: false });
    const video = await app.request(a.video);
    expect(video.status).toBe(200);
    expect(video.headers.get("content-type")).toContain("video/mp4");
    expect((await video.arrayBuffer()).byteLength).toBe(a.bytes);
    const second = await body(await app.request(`/api/sessions/${id}/scenes/S01/preview`, json({ settings: SETTINGS })));
    expect(second).toMatchObject({ cached: true, key: a.key, video: a.video });
    // another scene is a different clip; a scene that is not in the plan is refused
    const other = await body(await app.request(`/api/sessions/${id}/scenes/S02/preview`, json({ settings: SETTINGS })));
    expect(other.key).not.toBe(a.key);
    expect((await app.request(`/api/sessions/${id}/scenes/S99/preview`, json({ settings: SETTINGS }))).status).toBe(409);
    expect((await app.request(`/api/sessions/${id}/scenes/S01/preview/${"0".repeat(32)}.mp4`)).status).toBe(404);
  });
});

describe.skipIf(skipReal(can))("a DRAFT preview of one scene before Gate 2 (Digikon's decision, 2026-11-05) leaves the production gate exactly as strict", () => {
  /** Directed and approved at Gate 1; the edit plan is waiting at Gate 2. */
  async function atGate2(app: App) {
    film = MIXED;
    const id = (await body(await app.request("/api/sessions", { method: "POST" }))).id as string;
    await app.request(`/api/sessions/${id}/route`, json({ text: "A 12 second YouTube explainer for my online course." }));
    await sse(await app.request(`/api/sessions/${id}/direct`, json({})));
    const a1 = await approve(app, id, "storyboard");
    expect(a1.status).toBe(200);
    return id;
  }
  const storyboardOf = async (app: App, id: string) => (await body(await app.request(`/api/sessions/${id}/change-request`, json({ text: "Make the title bigger" })))).approved_storyboard;
  const rawPixel = (file: string, x: number, y: number) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y},format=rgb24`, "-f", "rawvideo", "-"], { maxBuffer: 1024 });

  it("makes a labelled draft before Gate 2, in its own folder, without touching any approval, render record or report", async () => {
    const app = build();
    const id = await atGate2(app);
    const before = await storyboardOf(app, id);
    const first = await app.request(`/api/sessions/${id}/scenes/S01/draft-preview`, json({}));
    const a = await body(first);
    expect(first.status, JSON.stringify(a)).toBe(200);
    expect(a).toMatchObject({ draft: true, final: false, scene_id: "S01", cached: false, engine: "ffmpeg" });
    expect(a.label).toContain("DRAFT");
    expect(a.video).toMatch(/\/draft-preview\/draft-[a-f0-9]{32}\.mp4$/);
    const video = await app.request(a.video);
    expect(video.status).toBe(200);
    expect(video.headers.get("content-type")).toContain("video/mp4");
    expect(video.headers.get("x-draft-preview")).toBe("true");
    const bytes = Buffer.from(await video.arrayBuffer());
    expect(bytes.byteLength).toBe(a.bytes);
    // the label is burned into the picture: red box top-left of the first frame (the white text sits below this row)
    const file = join(dir, a.video.split("/").pop() as string);
    writeFileSync(file, bytes);
    const px = rawPixel(file, 12, 8); // inside the box padding, above the text
    expect(px[0]! > 150 && px[1]! < 100, `a red label box, got ${[...px]}`).toBe(true);
    // a second request is served from the cache
    expect(await body(await app.request(`/api/sessions/${id}/scenes/S01/draft-preview`, json({})))).toMatchObject({ cached: true, key: a.key, video: a.video });
    // nothing was recorded as a render, a delivery or an approval
    expect((await body(await app.request(`/api/sessions/${id}/renders`))).renders ?? []).toEqual([]);
    expect((await body(await app.request(`/api/sessions/${id}/deliveries`))).deliveries).toEqual([]);
    expect(await storyboardOf(app, id)).toEqual(before);
    expect((await app.request(`/api/sessions/${id}/scenes/S99/draft-preview`, json({}))).status).toBe(409);
    expect((await app.request(`/api/sessions/${id}/scenes/S01/draft-preview/draft-${"0".repeat(32)}.mp4`)).status).toBe(404);
    expect((await app.request(`/api/sessions/${id}/scenes/S01/draft-preview/..%2F..%2Fsecret.mp4`)).status).toBe(404);
  });

  it("the production render still refuses without Gate 2, with or without a draft having been made", async () => {
    const app = build();
    const id = await atGate2(app);
    const refuse = async (what: string) => {
      const r = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS }));
      expect(r.status, what).toBe(409);
      return body(r);
    };
    await refuse("before any draft");
    expect((await app.request(`/api/sessions/${id}/scenes/S01/draft-preview`, json({}))).status).toBe(200);
    const after = await refuse("after a draft");
    expect(JSON.stringify(after)).not.toMatch(/draft-[a-f0-9]{32}/);
    expect((await app.request(`/api/sessions/${id}/scenes/S01/preview`, json({ settings: SETTINGS }))).status, "the approved-plan scene preview needs both approvals too").toBe(409);
    expect((await app.request(`/api/sessions/${id}/editor`, { method: "POST" })).status).toBe(409);
    expect((await app.request(`/api/sessions/${id}/handoff`)).status).toBe(409);
    // only the real second approval opens the gate, and the draft changed nothing about it
    expect((await approve(app, id, "edit_plan")).status).toBe(200);
    expect((await app.request(`/api/sessions/${id}/editor`, { method: "POST" })).status).toBe(200);
    // once both approvals are in, a draft is no longer offered: the approved plan has its own preview
    expect((await app.request(`/api/sessions/${id}/scenes/S01/draft-preview`, json({}))).status).toBe(409);
  });

  it("a draft file cannot be passed as final: the output validator refuses its name, and the render video route never serves it", async () => {
    const app = build();
    const id = await atGate2(app);
    const a = await body(await app.request(`/api/sessions/${id}/scenes/S01/draft-preview`, json({})));
    const file = join(dir, a.video.split("/").pop() as string);
    writeFileSync(file, Buffer.from(await (await app.request(a.video)).arrayBuffer()));
    const verdict = await validateOutput(file, RenderSettings.parse({ ...SETTINGS, duration_s: 4, width: 1280, height: 720, source: { kind: "user_approved", reference: "test" } }), false);
    expect(verdict).toMatchObject({ ok: false });
    expect(JSON.stringify(verdict)).toContain("DRAFT");
    expect((await app.request(`/api/sessions/${id}/renders/${(a.video as string).split("/").pop()!.replace(".mp4", "")}/video`)).status).toBe(404);
  });

  it("a look change never alters the approved storyboard hash, whether or not drafts were made", async () => {
    const app = build();
    const id = await atGate2(app);
    const before = await storyboardOf(app, id);
    expect(before).toMatchObject({ version: 1 });
    await app.request(`/api/sessions/${id}/scenes/S01/draft-preview`, json({}));
    const look = await body(await app.request(`/api/sessions/${id}/change-request`, json({ text: "Use a warmer colour palette and a bigger title" })));
    expect(look).toMatchObject({ route: "editor", reopens: "edit_plan" });
    expect(look.approved_storyboard).toEqual(before);
    expect(await storyboardOf(app, id)).toEqual(before);
  });
});