import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
import { createApp, type AppContext } from "./app.js";
import { realPrerequisites, skipReal } from "../../../packages/render/src/test-env.js";
import { renderDirs } from "./render-service.js";

// The console with three renderers: FFmpeg, Remotion and HyperFrames. These tests run the real renderers, so they need a font and a browser.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const recipes = loadRecipes(join(repo, "recipes"));
const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
const can = !!font && !!findChrome() && !!findRemotionBrowser();
realPrerequisites({ font: !!font, "a Chrome for HyperFrames": !!findChrome(), "a 64-bit Edge or Chrome for Remotion": !!findRemotionBrowser() });
vi.setConfig({ testTimeout: 240_000 });
let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "console-web-render-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const proofDir = process.env["RENDER_PROOF_DIR"];

const speech: SpeechEngine = { model: "stub", transcribe: async () => Transcript.parse({ text: "x", language: "en", language_confidence: 1, model: "stub", duration_s: 1, words: [], segments: [] }) };
const scene = (id: string, text: string) => ({
  scene_id: id, purpose: "p", duration_seconds: 4, asset_ids: [], required_assets: [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }], transition_out: "cut",
  shot: { shot_size: "wide", camera_motion: "static", visual_action: "Text on a plain background" }, overlay: { text, safe_area: "platform_safe" },
});
const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, unknown> = {}) => ({ use_id: `U0${n}`, scene_id, recipe_id, params, rationale: "plain text scene" });
// A scripted stand-in for the model: a fixed storyboard and edit plan. Test scaffolding, not evidence of any live Claude run.
class Client extends DemoClient {
  constructor(private readonly edit: unknown) { super(); }
  override async generate<T>(req: GenerateRequest<T>): Promise<T> {
    if (req.name === "storyboard") return req.schema.parse({ scenes: [scene("S01", "Learn at your pace."), scene("S02", "One place for it all."), scene("S03", "Start today.")] });
    if (req.name === "edit_plan") return req.schema.parse(this.edit);
    return super.generate(req);
  }
}
const build = (edit: unknown) => createApp({
  llm: new Client(edit), demo: true, speech, whisper: () => ({ state: "ready" }), skills: new SkillLibrary(join(repo, "skills")), editorSkills: new SkillLibrary(join(repo, "skills/editor")),
  retriever: new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge"))]),
  recipes: new RecipeLibrary(recipes, "draft"), ffmpegOk: true, renderFont: font, storageDir: dir, publicDir: join(repo, "apps/console/public"),
});
type App = ReturnType<typeof build>;
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const body = async (r: Response) => (await r.json()) as any;
// Test values only; the console never fills these in on its own.
const SETTINGS = { aspect_ratio: "16:9", width: 640, height: 360, fps: 30, duration_s: 12, container: "mp4", video_codec: "h264", audio_codec: null };

async function sse(res: Response) {
  const events: { event: string; data: any }[] = [];
  for (const block of (await res.text()).split("\n\n")) {
    const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
  }
  return events;
}
const approve = (app: App, id: string, stage: "storyboard" | "edit_plan") =>
  app.request(`/api/sessions/${id}/approve`, json({ stage, plan_version: 1, decision: "approved", ...(stage === "edit_plan" ? { storyboard_version: 1 } : {}) }));
async function approvedRun(app: App) {
  const id = (await body(await app.request("/api/sessions", { method: "POST" }))).id as string;
  await app.request(`/api/sessions/${id}/route`, json({ text: "A 12 second YouTube explainer for my online course." }));
  const state = (await sse(await app.request(`/api/sessions/${id}/direct`, json({})))).find((e) => e.event === "state")!.data;
  expect((await approve(app, id, "storyboard")).status).toBe(200);
  expect((await approve(app, id, "edit_plan")).status).toBe(200);
  expect((await app.request(`/api/sessions/${id}/editor`, { method: "POST" })).status).toBe(200);
  return { id, runId: state.run_id as string };
}
const outFiles = (id: string, runId: string) => { const o = renderDirs(join(dir, "sessions", id), runId).out; return existsSync(o) ? readdirSync(o) : []; };

const FILMS = {
  remotion: [use(1, "S01", "text-slide-remotion"), use(2, "S02", "text-slide-remotion", { background: "charcoal", accent: "teal" }), use(3, "S03", "text-slide-remotion", { background: "forest", fade_in_s: 1 })],
  hyperframes: [use(1, "S01", "text-fade-hyperframes"), use(2, "S02", "text-fade-hyperframes", { background: "charcoal", accent: "teal" }), use(3, "S03", "text-fade-hyperframes", { background: "forest", fade_in_s: 1 })],
} as const;

describe.skipIf(skipReal(can))("the console renders through the renderer the approved plan names", () => {
  it("reports every renderer that can run on this machine", async () => {
    const app = build({ uses: FILMS.remotion });
    const health = await body(await app.request("/api/health"));
    expect(health.render.available).toBe(true);
    expect(health.render.renderers.sort()).toEqual(["ffmpeg", "hyperframes", "remotion"]);
    expect(health.render.templates).toEqual(expect.arrayContaining(["ffmpeg/text-card", "remotion/text-slide", "hyperframes/text-fade"]));
  });

  describe.each(["remotion", "hyperframes"] as const)("%s", (r) => {
    let app: App, id: string, runId: string;
    beforeAll(async () => { app = build({ uses: FILMS[r] }); ({ id, runId } = await approvedRun(app)); }, 120_000);

    it("selects it from the plan, shows the renderer and every scene as fully shown, and renders nothing while planning", async () => {
      const view = await body(await app.request(`/api/sessions/${id}/render/plan`, json({ settings: SETTINGS })));
      expect(view.renderer).toMatchObject({ selected: r, needed: [r], composition_required: false });
      expect(view.renderer.registered.sort()).toEqual(["ffmpeg", "hyperframes", "remotion"]);
      expect(view.plan.operations.every((o: any) => o.supported && o.renderer === r)).toBe(true);
      expect(view).toMatchObject({ eligible: true, coverage: { complete: true }, plan: { state: "executable", purpose: "preview" } });
      expect(view.production.ready).toBe(false);
      expect(view.production.blockers.join(" ")).toContain("is draft");
      expect(outFiles(id, runId)).toEqual([]);
    });

    it("renders a real preview, records it, passes QA, and plays only the verified file", async () => {
      const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS }));
      const out = await body(res);
      expect(res.status, JSON.stringify(out.record?.errors ?? out)).toBe(200);
      expect(out.record).toMatchObject({ state: "rendered", purpose: "preview" });
      expect(out.record.operations.every((o: any) => o.renderer === r)).toBe(true);
      expect(out.record.output).toMatchObject({ container: "mp4", width: 640, height: 360, fps: 30, duration_s: 12, video_codec: "h264", audio_codec: null, audio_tracks: 0 });
      expect(out.qa.findings).toEqual([]);
      expect(out.record.output.path).not.toMatch(/^[A-Za-z]:|^\//); // no absolute paths reach the browser
      console.log(`CONSOLE ${r.toUpperCase()} RECORD`, JSON.stringify({ state: out.record.state, renderer: r, output: { ...out.record.output, path: "<run>/out/…" } }));
      const video = await app.request(out.record.output.video_url);
      expect(video.status).toBe(200);
      expect(video.headers.get("content-type")).toBe("video/mp4");
      const bytes = Buffer.from(await video.arrayBuffer());
      expect(bytes.length).toBe(out.record.output.bytes);
      const evidenceDir = renderDirs(join(dir, "sessions", id), runId).evidence;
      const ev = readdirSync(evidenceDir).filter((f) => f.startsWith(r === "remotion" ? "text-slide-remotion" : "text-fade-hyperframes"));
      expect(ev.length).toBe(1);
      expect(JSON.parse(readFileSync(join(evidenceDir, ev[0]!), "utf8"))).toMatchObject({ recipe_status: "draft", purpose: "preview" });
      if (proofDir) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(renderDirs(join(dir, "sessions", id), runId).out, `${out.record.render_id}.mp4`), "-vf", "fps=1/2,scale=240:-1,tile=6x1", "-frames:v", "1", join(proofDir, `console-${r}.png`)]);
      const list = await body(await app.request(`/api/sessions/${id}/renders`));
      expect(list.records.map((x: any) => x.state)).toEqual(["rendered"]);
    });
  });

  it("a plan that mixes renderers is not a single-renderer render: it is assembled scene by scene, each by the renderer the approved plan names, and nothing is substituted", async () => {
    const app = build({ uses: [use(1, "S01", "text-card-fade"), use(2, "S02", "text-slide-remotion"), use(3, "S03", "text-fade-hyperframes")] });
    const { id, runId } = await approvedRun(app);
    const view = await body(await app.request(`/api/sessions/${id}/render/plan`, json({ settings: SETTINGS })));
    expect(view.renderer).toMatchObject({ selected: null, composition_required: true });
    expect(view.renderer.needed.sort()).toEqual(["ffmpeg", "hyperframes", "remotion"]);
    expect(view.eligible).toBe(false);
    // mixed engines are how the film is made, so they are not reported as a reason it cannot be: the view speaks for the assembly
    expect(view.renderer.execution).toBe("scene_assembly");
    expect(view.blockers.join(" ")).not.toContain("the operations need more than one renderer");
    expect(view.assembly.scenes.map((s: { engine: string }) => s.engine)).toEqual(["ffmpeg", "remotion", "hyperframes"]);
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS }));
    const out = await body(res);
    expect(res.status, JSON.stringify(out.errors ?? out.message)).toBe(200);
    expect(out.kind).toBe("complete");
    expect(out.delivery.scenes.map((s: any) => [s.scene_id, s.engine])).toEqual([["S01", "ffmpeg"], ["S02", "remotion"], ["S03", "hyperframes"]]); // exactly the renderers in the approved plan
    expect(out.delivery.states).toMatchObject({ scenes_rendered: 3, final_video_validated: true, final_delivery_ready: false }); // a preview of draft recipes, never final
    expect(outFiles(id, runId)).toEqual([`${out.record.render_id}.mp4`]);
  });

  it("an FFmpeg plan still renders through FFmpeg, unchanged", async () => {
    const app = build({ uses: [use(1, "S01", "text-card-fade"), use(2, "S02", "text-card-fade", { background: "charcoal" }), use(3, "S03", "text-card-fade", { fade_in_s: 1 })] });
    const { id } = await approvedRun(app);
    const view = await body(await app.request(`/api/sessions/${id}/render/plan`, json({ settings: SETTINGS })));
    expect(view.renderer).toMatchObject({ selected: "ffmpeg", needed: ["ffmpeg"] });
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS }));
    const out = await body(res);
    expect(res.status).toBe(200);
    expect(out.record).toMatchObject({ state: "rendered" });
    expect(out.record.operations.every((o: any) => o.renderer === "ffmpeg")).toBe(true);
  });
});
