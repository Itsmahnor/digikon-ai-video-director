import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Transcript } from "@digikon/contracts";
import { DemoClient, SkillLibrary, type GenerateRequest } from "@digikon/director";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import type { SpeechEngine } from "@digikon/speech";
import { createApp } from "./app.js";
import { realPrerequisites, skipReal } from "../../../packages/render/src/test-env.js";

// The console with a capability store: a gap in the approved plan is learned with a real render, kept, and found again by a later session.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const recipes = loadRecipes(join(repo, "recipes"));
const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
realPrerequisites({ font: !!font });
vi.setConfig({ testTimeout: 120_000 });
import { seedCapabilities, withdrawCapabilities } from "./test-capabilities.js";
let dir: string, store: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "console-capabilities-")); store = join(dir, "capabilities"); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const speech: SpeechEngine = { model: "stub", transcribe: async () => Transcript.parse({ text: "x", language: "en", language_confidence: 1, model: "stub", duration_s: 1, words: [], segments: [] }) };
const scene = (id: string, text: string, transition = "cut") => ({
  scene_id: id, purpose: "p", duration_seconds: 4, asset_ids: [], required_assets: [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }], transition_out: transition,
  shot: { shot_size: "wide", camera_motion: "static", visual_action: "Text on a plain background" }, overlay: { text, safe_area: "platform_safe" },
});
const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, unknown> = {}) => ({ use_id: `U0${n}`, scene_id, recipe_id, params, rationale: "plain text scene" });
// A scripted stand-in for the model. Test scaffolding, not evidence of any live Claude run.
class Client extends DemoClient {
  override async generate<T>(req: GenerateRequest<T>): Promise<T> {
    if (req.name === "storyboard") return req.schema.parse({ scenes: [scene("S01", "Learn at your pace.", "dip_to_black"), scene("S02", "One place for it all."), scene("S03", "Start today.")] });
    if (req.name === "edit_plan") return req.schema.parse({ uses: [use(1, "S01", "text-card-fade"), use(2, "S01", "dip-to-black", { duration_s: 0.6 }), use(3, "S02", "text-card-fade", { background: "charcoal" }), use(4, "S03", "text-card-fade", { background: "forest" })] });
    return super.generate(req);
  }
}
const DIP = ["ffmpeg__xfade-fadeblack"];
const build = (capabilitiesDir: string | null = store) => createApp({
  llm: new Client(), demo: true, speech, whisper: () => ({ state: "ready" }), skills: new SkillLibrary(join(repo, "skills")), editorSkills: new SkillLibrary(join(repo, "skills/editor")),
  retriever: new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge"))]),
  recipes: new RecipeLibrary(recipes, "draft"), ffmpegOk: true, renderFont: font, storageDir: dir, publicDir: join(repo, "apps/console/public"), capabilitiesDir,
});
type App = ReturnType<typeof build>;
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const body = async (r: Response) => (await r.json()) as any;
const SETTINGS = { aspect_ratio: "16:9", width: 640, height: 360, fps: 30, duration_s: 12, container: "mp4", video_codec: "h264", audio_codec: null };

async function sse(res: Response) {
  const events: { event: string; data: any }[] = [];
  for (const block of (await res.text()).split("\n\n")) {
    const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
  }
  return events;
}
const approve = (app: App, id: string, stage: "storyboard" | "edit_plan") => app.request(`/api/sessions/${id}/approve`, json({ stage, plan_version: 1, decision: "approved", ...(stage === "edit_plan" ? { storyboard_version: 1 } : {}) }));
async function approvedRun(app: App) {
  const id = (await body(await app.request("/api/sessions", { method: "POST" }))).id as string;
  await app.request(`/api/sessions/${id}/route`, json({ text: "A 12 second YouTube explainer for my online course." }));
  await sse(await app.request(`/api/sessions/${id}/direct`, json({})));
  expect((await approve(app, id, "storyboard")).status).toBe(200);
  expect((await approve(app, id, "edit_plan")).status).toBe(200);
  expect((await app.request(`/api/sessions/${id}/editor`, { method: "POST" })).status).toBe(200);
  return id;
}

describe.skipIf(skipReal(!!font))("the console learns a capability once and every later session reuses it", () => {
  it("project one: the approved dip to black has validated evidence, the plan is executable, and it renders", async () => {
    const app = build();
    seedCapabilities(store, DIP); // the production gate refuses to approve a plan whose capability has no validated evidence
    expect((await body(await app.request("/api/health"))).render.learned).toEqual(["ffmpeg:dip-to-black"]);
    const id = await approvedRun(app);
    const view = await body(await app.request(`/api/sessions/${id}/render/plan`, json({ settings: SETTINGS })));
    expect(view).toMatchObject({ eligible: true, plan: { state: "executable" }, renderer: { selected: "ffmpeg" } });
    expect(view.capability.find((o: any) => o.recipe_id === "dip-to-black")).toMatchObject({ status: "validated_available", selected_engine: "ffmpeg", selected_template: "ffmpeg/xfade-fadeblack" });
    expect(readdirSync(join(store, "registry", "ffmpeg"))).toEqual(["ffmpeg__xfade-fadeblack.json"]);

    const rendered = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS }));
    const r = await body(rendered);
    expect(rendered.status, JSON.stringify(r.record?.errors ?? r)).toBe(200);
    expect(r.record).toMatchObject({ state: "rendered", purpose: "preview", output: { width: 640, height: 360, fps: 30, duration_s: 12 } });
    expect(r.record.operations.map((o: any) => o.implementation_ref)).toContain("ffmpeg/xfade-fadeblack");
    expect(r.qa.findings).toEqual([]);
  });

  it("evidence lost after approval: the plan is blocked, learning on request makes a real render and keeps it, and the plan must be approved again because it was bound to the old evidence", async () => {
    const own = join(dir, "capabilities-lost");
    const app = build(own);
    seedCapabilities(own, DIP);
    const id = await approvedRun(app);
    withdrawCapabilities(own, DIP);
    const before = await body(await app.request(`/api/sessions/${id}/render/plan`, json({ settings: SETTINGS })));
    expect(before).toMatchObject({ eligible: false });
    expect(before.blockers.join(" ")).toContain("no template is registered for ffmpeg/xfade-fadeblack");
    expect(before.capability.find((o: any) => o.recipe_id === "dip-to-black")).toMatchObject({ status: "learning_required", selected_engine: null });

    const res = await app.request(`/api/sessions/${id}/render/learn`, json({ settings: SETTINGS }));
    const out = await body(res);
    expect(res.status, JSON.stringify(out)).toBe(200);
    expect(out.gaps).toEqual([expect.objectContaining({ recipe_id: "dip-to-black", template: "ffmpeg/xfade-fadeblack", learnable: true })]);
    expect(out.results).toEqual([expect.objectContaining({ template: "ffmpeg/xfade-fadeblack", status: "learned" })]);
    expect(JSON.stringify(out)).not.toContain(dir.replaceAll("\\", "\\\\")); // no absolute paths reach the browser
    expect(readdirSync(join(own, "registry", "ffmpeg"))).toEqual(["ffmpeg__xfade-fadeblack.json"]);
    // the new evidence is a new record, so the approved production plan no longer matches it: nothing is rendered until the person approves again
    expect(out.view.capability.find((o: any) => o.recipe_id === "dip-to-black")).toMatchObject({ status: "validated_available" });
    expect(out.view.eligible).toBe(false);
    expect(out.view.blockers.join(" ")).toContain("no longer matches what you approved");
  });

  it("project two, a new session of a new app with no memory of project one, finds the capability in the store with no learning step", async () => {
    const app = build();
    expect((await body(await app.request("/api/health"))).render.learned).toEqual(["ffmpeg:dip-to-black"]);
    const id = await approvedRun(app);
    const view = await body(await app.request(`/api/sessions/${id}/render/plan`, json({ settings: SETTINGS })));
    expect(view).toMatchObject({ eligible: true, plan: { state: "executable" } });
    const rendered = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS }));
    expect(rendered.status).toBe(200);
    expect((await body(rendered)).record.state).toBe("rendered");
  });

  it("a console with no capability store refuses to learn and says so, and the plan stays blocked", async () => {
    const app = build(null);
    const id = await approvedRun(app);
    const res = await app.request(`/api/sessions/${id}/render/learn`, json({ settings: SETTINGS }));
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe("no_capability_store");
    const view = await body(await app.request(`/api/sessions/${id}/render/plan`, json({ settings: SETTINGS })));
    expect(view.eligible).toBe(false);
  });

  it("learning needs the Editor result and the approvals first, like every other render step", async () => {
    const app = build();
    const id = (await body(await app.request("/api/sessions", { method: "POST" }))).id as string;
    const res = await app.request(`/api/sessions/${id}/render/learn`, json({ settings: SETTINGS }));
    expect(res.status).toBe(409);
  });
});
