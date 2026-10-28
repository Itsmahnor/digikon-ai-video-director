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
import { findChrome, findRemotionBrowser } from "@digikon/render";
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
let dir: string, store: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "console-assembly-")); store = join(dir, "capabilities"); });
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
  it("a film needing FFmpeg and HyperFrames is learned for, assembled, reported and served as a complete preview that is not production-ready", async () => {
    const app = build();
    const id = await approvedRun(app, MIXED);
    const plan = await body(await app.request(`/api/sessions/${id}/render/plan`, json({ settings: SETTINGS })));
    expect(plan.eligible).toBe(false); // the single-renderer planner refuses a film that needs two renderers
    expect(plan.assembly).toMatchObject({ ok: true, complete: false }); // the dip to black is not learned yet
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
    // the generation-first step learned the missing dip to black once, and kept it
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

  it("a scene nothing can draw gives a labelled incomplete preview that names the missing operation and is never final", async () => {
    const app = build();
    const id = await approvedRun(app, WITH_GAP);
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS }));
    const out = await body(res);
    expect(res.status, JSON.stringify(out.errors ?? out.reasons ?? out.message)).toBe(200);
    expect(out.kind).toBe("partial");
    expect(out.record).toBeNull(); // an incomplete film has no "rendered" record
    expect(out.delivery).toMatchObject({ kind: "partial", status: "incomplete_preview", states: { scenes_total: 3, scenes_rendered: 2, final_video_validated: true, final_delivery_ready: false } });
    expect(out.delivery.label).toContain("INCOMPLETE PREVIEW");
    expect(out.delivery.scenes.map((s: any) => [s.scene_id, s.status])).toEqual([["S01", "rendered_unverified"], ["S02", "placeholder"], ["S03", "rendered_unverified"]]);
    expect(out.delivery.omitted_operations.map((o: any) => o.recipe_id)).toContain("text-fade-hyperframes");
    expect(out.delivery.scenes[1].omitted_reason).toBeTruthy();
    expect(out.delivery.final_delivery_blockers.join(" ")).toContain("incomplete");
    expect((await app.request(out.delivery.output.video_url)).headers.get("x-digikon-preview")).toBe("incomplete");
  });

  it("when nothing can be drawn at all, no video is made and every reason is given", async () => {
    const app = build();
    const id = await approvedRun(app, { scenes: [scene("S01", "Presented by us."), scene("S02", "Presented again."), scene("S03", "Presented last.")], uses: [use(1, "S01", "text-card-fade"), use(4, "S01", "text-fade-hyperframes"), use(2, "S02", "text-card-fade"), use(5, "S02", "text-fade-hyperframes"), use(3, "S03", "text-card-fade"), use(6, "S03", "text-fade-hyperframes")] });
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS }));
    expect(res.status).toBe(409);
    const out = await body(res);
    expect(out.error).toBe("not_renderable");
    expect(out.assembly.scenes[0]).toMatchObject({ renderable: false });
    expect(out.can_render).toBe(false);
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

  it("an empty registry: the render learns what is missing with real renders, keeps it, renders every scene, and labels the film incomplete because of the one thing nothing can do", async () => {
    capDir = join(dir, "e2e-capabilities");
    const app = buildWith(capDir);
    const id = await approvedRun(app, PLAN);
    const plan = await body(await app.request(`/api/sessions/${id}/render/plan`, json({ settings: SETTINGS_E2E })));
    expect(plan.eligible).toBe(false);
    expect(plan.capability.map((o: any) => [o.recipe_id, o.status]).filter((x: any) => ["dip-to-black", "text-fade-up"].includes(x[0]))).toEqual([["dip-to-black", "learning_required"], ["text-fade-up", "learning_required"]]);
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS_E2E }));
    const out = await body(res);
    expect(res.status, JSON.stringify(out.errors ?? out.reasons ?? out.message)).toBe(200);
    // detected, tried, learned
    expect(out.learning.attempted.map((a: any) => [a.template, a.status]).sort()).toEqual([["ffmpeg/xfade-fadeblack", "learned"], ["remotion/text-fade-up", "learned"]]);
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
  it("a capability nothing can implement is recorded, not retried forever, and does not stop the rest: the audio operation stays unresolved and final delivery stays blocked", async () => {
    const app = buildWith(capDir);
    const withAudio: Film = { scenes: PLAN.scenes, uses: [...PLAN.uses, use(6, "S03", "loudness-normalise")] };
    const id = await approvedRun(app, withAudio);
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS_E2E }));
    const out = await body(res);
    expect(res.status, JSON.stringify(out.errors ?? out.message)).toBe(200);
    expect(out.kind).toBe("partial");
    expect(out.delivery.omitted_operations.map((o: any) => o.recipe_id)).toContain("loudness-normalise");
    expect(out.delivery.final_delivery_blockers.join(" ")).toMatch(/audio|incomplete/);
    expect(out.delivery.states.final_delivery_ready).toBe(false);
    expect(out.learning.not_learnable.map((g: any) => g.template)).toContain("ffmpeg/loudnorm");
  });
});