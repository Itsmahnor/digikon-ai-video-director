import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Transcript } from "@digikon/contracts";
import { DemoClient, RunStore, SkillLibrary, type GenerateRequest } from "@digikon/director";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import type { SpeechEngine } from "@digikon/speech";
import { createApp, type AppContext } from "./app.js";
import { renderDirs } from "./render-service.js";
import { realPrerequisites, recipeFileCount, skipReal } from "../../../packages/render/src/test-env.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const recipes = loadRecipes(join(repo, "recipes"));
const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
realPrerequisites({ font: !!font });
vi.setConfig({ testTimeout: 60_000 }); // these tests run real ffmpeg, which is slower while the whole suite runs in parallel
let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "console-render-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const speech: SpeechEngine = { model: "stub", transcribe: async () => Transcript.parse({ text: "x", language: "en", language_confidence: 1, model: "stub", duration_s: 1, words: [], segments: [] }) };

// A scripted stand-in for the model (the demo client with a fixed storyboard and edit plan). It is test scaffolding, not evidence of any live Claude run.
const scene = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  scene_id: id, purpose: "p", duration_seconds: 4, asset_ids: [], required_assets: [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }], transition_out: "cut",
  shot: { shot_size: "wide", camera_motion: "static", visual_action: "Text on a plain background" }, overlay: { text, safe_area: "platform_safe" }, ...extra,
});
const use = (n: number, scene_id: string, params: Record<string, unknown> = {}) => ({ use_id: `U0${n}`, scene_id, recipe_id: "text-card-fade", params, rationale: "plain text card" });
class CardsClient extends DemoClient {
  constructor(private readonly sb: unknown = { scenes: [scene("S01", "Learn at your pace."), scene("S02", "One place for it all."), scene("S03", "Start today.")] }, private readonly edit?: unknown) { super(); }
  override async generate<T>(req: GenerateRequest<T>): Promise<T> {
    if (req.name === "storyboard") return req.schema.parse(this.sb);
    if (req.name === "edit_plan" && this.edit) return req.schema.parse(this.edit);
    if (req.name === "edit_plan") return req.schema.parse({ uses: [use(1, "S01"), use(2, "S02", { background: "charcoal" }), use(3, "S03", { fade_in_s: 1 })] });
    return super.generate(req);
  }
}

const build = (over: Partial<AppContext> = {}, client: DemoClient = new CardsClient()) => createApp({
  llm: client, demo: true, speech, whisper: () => ({ state: "ready" }), skills: new SkillLibrary(join(repo, "skills")), editorSkills: new SkillLibrary(join(repo, "skills/editor")),
  retriever: new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge"))]),
  recipes: new RecipeLibrary(recipes, "draft"), ffmpegOk: true, renderFont: font, storageDir: dir, publicDir: join(repo, "apps/console/public"), ...over,
});
type App = ReturnType<typeof build>;
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const body = async (r: Response) => (await r.json()) as any;
const newSession = async (app: App) => (await body(await app.request("/api/sessions", { method: "POST" }))).id as string;

// Test values only. They are not a platform specification and the console never fills them in on its own.
const SETTINGS = { aspect_ratio: "16:9", width: 640, height: 360, fps: 30, duration_s: 12, container: "mp4", video_codec: "h264", audio_codec: null };

async function sse(res: Response) {
  const events: { event: string; data: any }[] = [];
  for (const block of (await res.text()).split("\n\n")) {
    const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
  }
  return events;
}
/** Starts a run for a plain 12 second YouTube explainer and stops at the storyboard gate. */
async function atGate1(app: App) {
  const id = await newSession(app);
  await app.request(`/api/sessions/${id}/route`, json({ text: "A 12 second YouTube explainer for my online course." }));
  const state = (await sse(await app.request(`/api/sessions/${id}/direct`, json({})))).find((e) => e.event === "state")!.data;
  return { id, runId: state.run_id as string, state };
}
const approve = (app: App, id: string, stage: "storyboard" | "edit_plan") =>
  app.request(`/api/sessions/${id}/approve`, json({ stage, plan_version: 1, decision: "approved", ...(stage === "edit_plan" ? { storyboard_version: 1 } : {}) }));
async function approved(app: App) {
  const run = await atGate1(app);
  expect((await approve(app, run.id, "storyboard")).status).toBe(200);
  expect((await approve(app, run.id, "edit_plan")).status).toBe(200);
  return run;
}
const editor = (app: App, id: string) => app.request(`/api/sessions/${id}/editor`, { method: "POST" });
const renderNow = (app: App, id: string, settings: unknown = SETTINGS) => app.request(`/api/sessions/${id}/render`, json({ settings }));
const planNow = (app: App, id: string, settings: unknown = SETTINGS) => app.request(`/api/sessions/${id}/render/plan`, json({ settings }));
const sessionDir = (id: string) => join(dir, "sessions", id);
const outFiles = (id: string, runId: string) => { const o = renderDirs(sessionDir(id), runId).out; return existsSync(o) ? readdirSync(o) : []; };

describe("gates: nothing runs before the human approvals", () => {
  it("refuses the Editor and the render before the storyboard is approved, and again before the edit plan is", async () => {
    const app = build();
    const { id } = await atGate1(app);
    for (const res of [await editor(app, id), await app.request(`/api/sessions/${id}/render`), await planNow(app, id), await renderNow(app, id)]) {
      expect(res.status).toBe(409);
      expect((await body(res)).error).toBe("handoff_refused");
    }
    await approve(app, id, "storyboard"); // gate 1 only
    expect((await editor(app, id)).status).toBe(409);
    expect((await renderNow(app, id)).status).toBe(409);
  });

  it("does not advance a gate by itself: the edit plan does not exist until the storyboard is approved, and no render or Editor result exists until asked", async () => {
    const app = build();
    const { id, runId, state } = await atGate1(app);
    expect(state).toMatchObject({ status: "awaiting_approval", gate: "storyboard", editPlan: null });
    expect(existsSync(renderDirs(sessionDir(id), runId).root)).toBe(false);
    await approve(app, id, "storyboard");
    await approve(app, id, "edit_plan");
    expect(existsSync(renderDirs(sessionDir(id), runId).editor)).toBe(false); // approving does not run the Editor
    expect((await app.request(`/api/sessions/${id}/render`)).status).toBe(409);
    expect((await body(await app.request(`/api/sessions/${id}/render`))).error).toBe("no_editor_output");
  });

  it("refuses a render without a stored Editor result, and the Editor without its skills", async () => {
    const app = build({ editorSkills: undefined });
    const { id } = await approved(app);
    expect((await editor(app, id)).status).toBe(503);
  });
});

describe.skipIf(skipReal(!!font))("Editor and preview render, end to end through the console", () => {
  let app: App, id: string, runId: string, planView: any, result: any, editorBody: any;
  beforeAll(async () => {
    app = build();
    ({ id, runId } = await approved(app));
    editorBody = await body(await editor(app, id));
  }, 60_000);

  it("runs the Editor on the verified handoff and stores its structured output", () => {
    expect(editorBody.output).toMatchObject({ status: "ready", validation: { ok: true }, conflicts: [], revision_requests: [] });
    expect(editorBody.output.execution).toMatchObject({ rendered: false });
    expect(editorBody.output.operations.map((o: any) => o.recipe_id)).toEqual(["text-card-fade", "text-card-fade", "text-card-fade"]);
    expect(editorBody.check).toEqual({ ok: true, issues: [], requires_reapproval: false });
    expect(existsSync(renderDirs(sessionDir(id), runId).editor)).toBe(true);
  });

  it("shows supported operations, blockers and the missing output settings before anything is rendered", async () => {
    const view = await body(await app.request(`/api/sessions/${id}/render`));
    expect(view.plan).toMatchObject({ state: "planning", supported: 3, unsupported: 0 });
    expect(view.eligible).toBe(false);
    expect(view.blockers.join(" ")).toContain("no output settings were supplied");
    expect(view.needs).toMatchObject({ aspect_ratio: "16:9", duration_s: 12, you_provide: ["width", "height", "fps"] });
    expect(view.plan.operations.every((o: any) => o.supported && o.renderer === "ffmpeg" && o.template === "ffmpeg/text-card")).toBe(true);
    expect(view.coverage.complete).toBe(true);
    expect(view.label).toContain("No preview");
    expect(outFiles(id, runId)).toEqual([]);
  });

  it("is eligible only with valid settings, and says it is a preview that is not production-ready", async () => {
    planView = await body(await planNow(app, id));
    expect(planView).toMatchObject({ eligible: true, plan: { state: "executable", purpose: "preview" } });
    expect(planView.label).toContain("not production-ready");
    expect(planView.production.ready).toBe(false);
    expect(planView.production.blockers.join(" ")).toContain("text-card-fade is draft");
    expect(outFiles(id, runId)).toEqual([]); // planning renders nothing
    for (const bad of [{ ...SETTINGS, width: 641 }, { ...SETTINGS, fps: undefined }, { ...SETTINGS, duration_s: 99 }, { ...SETTINGS, container: "webm" }, { ...SETTINGS, audio_codec: "aac" }, { ...SETTINGS, aspect_ratio: "9:16" }]) {
      const v = await body(await planNow(app, id, bad));
      expect(v.eligible, JSON.stringify(bad)).toBe(false);
      expect(v.blockers.length).toBeGreaterThan(0);
    }
  });

  it("renders the preview and reports the measured output, QA and a playable address", async () => {
    const res = await renderNow(app, id);
    result = await body(res);
    expect(res.status).toBe(200);
    expect(result.record).toMatchObject({ state: "rendered", purpose: "preview", errors: [], blockers: [] });
    expect(result.record.output).toMatchObject({ container: "mp4", width: 640, height: 360, fps: 30, duration_s: 12, video_codec: "h264", audio_codec: null, audio_tracks: 0 });
    expect(result.record.output.bytes).toBeGreaterThan(1000);
    expect(result.record.output.path).toMatch(/^out\/rn_[a-f0-9]{16}\.mp4$/); // relative, never an absolute path
    expect(JSON.stringify(result)).not.toContain(dir.replaceAll("\\", "\\\\"));
    expect(result.qa.findings).toEqual([]);
    expect(result.qa.passed.map((x: any) => x.check)).toEqual(expect.arrayContaining(["duration", "resolution", "frame_rate"]));
    expect(result.record.output.video_url).toBe(`/api/sessions/${id}/renders/${result.record.render_id}/video`);
    expect(outFiles(id, runId)).toEqual([`${result.record.render_id}.mp4`]);
  }, 120_000);

  it("stores the render record on disk and lists it, with the QA result and recipe evidence next to it", async () => {
    const dirs = renderDirs(sessionDir(id), runId);
    const onDisk = JSON.parse(readFileSync(join(dirs.records, `${result.record.render_id}.json`), "utf8"));
    expect(onDisk).toMatchObject({ state: "rendered", output: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(existsSync(join(dirs.records, `${result.record.render_id}.qa.json`))).toBe(true);
    expect(readdirSync(dirs.evidence)).toEqual([`text-card-fade@0.1.0.${result.record.render_id}.json`]);
    const list = await body(await app.request(`/api/sessions/${id}/renders`));
    expect(list.records.map((r: any) => [r.render_id, r.state])).toEqual([[result.record.render_id, "rendered"]]);
  });

  it("serves the validated video, with range requests, and only for that record", async () => {
    const url = result.record.output.video_url;
    const full = await app.request(url);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(Number(full.headers.get("content-length"))).toBe(result.record.output.bytes);
    expect((await full.arrayBuffer()).byteLength).toBe(result.record.output.bytes);
    const part = await app.request(url, { headers: { range: "bytes=0-99" } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    expect((await app.request(url, { headers: { range: "bytes=999999999-" } })).status).toBe(416);
    for (const bad of ["rn_0000000000000000", "..%2f..%2fetc", "nope", "rn_ZZZZZZZZZZZZZZZZ"]) expect((await app.request(`/api/sessions/${id}/renders/${bad}/video`)).status, bad).toBe(404);
  });

  it("stops serving a video that no longer matches its record, and a record whose output points outside the render folder", async () => {
    const dirs = renderDirs(sessionDir(id), runId);
    const recFile = join(dirs.records, `${result.record.render_id}.json`);
    const original = readFileSync(recFile, "utf8");
    const rec = JSON.parse(original);
    const outside = join(dir, "elsewhere.mp4");
    writeFileSync(outside, readFileSync(rec.output.path));
    writeFileSync(recFile, JSON.stringify({ ...rec, output: { ...rec.output, path: outside } }));
    expect((await app.request(result.record.output.video_url)).status).toBe(404);
    writeFileSync(recFile, original);
    const mp4 = rec.output.path as string;
    const good = readFileSync(mp4);
    writeFileSync(mp4, Buffer.concat([good, Buffer.from([0])]));
    expect((await app.request(result.record.output.video_url)).status).toBe(409);
    writeFileSync(mp4, Buffer.concat([good.subarray(0, good.length - 1), Buffer.from([(good[good.length - 1]! + 1) & 255])])); // same size, different bytes
    expect((await app.request(result.record.output.video_url)).status).toBe(409);
    writeFileSync(mp4, good);
    expect((await app.request(result.record.output.video_url)).status).toBe(200);
  });

  it("keeps every recipe in its current review state", async () => {
    const files = loadRecipes(join(repo, "recipes"));
    expect(files).toHaveLength(recipeFileCount(join(repo, "recipes"))); // every recipe file loads, whatever their number
    expect(files.every((r) => r.status === "draft" && r.review === null)).toBe(true);
    const health = await body(await app.request("/api/health"));
    expect(health).toMatchObject({ recipes: { available: recipes.length, mode: "draft" }, render: { available: true } });
  });
});

describe.skipIf(skipReal(!!font))("unsupported content never becomes a misleading render", () => {
  it("refuses a plan that needs a logo, and names the scene and the missing logo, rendering nothing", async () => {
    const sb = { scenes: [scene("S01", "Learn at your pace."), scene("S02", "Your brand here.", { required_assets: [{ need: "Brand logo", kind: "logo", availability: "generate_graphics", placeholder: true }], unresolved: [{ kind: "placeholder", note: "No logo supplied: a generic wordmark card is shown." }] }), scene("S03", "Start today.")] };
    const app = build({}, new CardsClient(sb));
    const { id, runId } = await approved(app);
    expect((await editor(app, id)).status).toBe(200);
    const view = await body(await planNow(app, id));
    expect(view.eligible).toBe(false);
    expect(view.plan.state).toBe("planning"); // every operation could run, but that would not be the approved video, so the planner itself refuses
    expect(view.coverage.complete).toBe(false);
    expect(view.coverage.scenes.find((s: any) => s.scene_id === "S02").missing.join(" ")).toContain("a logo");
    expect(view.blockers.join(" ")).toContain("S02: it needs a logo");
    // nothing is shown as the approved video: the other scenes are rendered and S02, which cannot be shown, is a labelled placeholder in an INCOMPLETE preview
    const res = await renderNow(app, id);
    const out = await body(res);
    expect(res.status, JSON.stringify(out.errors ?? out.message)).toBe(200);
    expect(out.kind).toBe("partial");
    expect(out.record).toBeNull(); // not a "rendered" record
    expect(out.delivery).toMatchObject({ kind: "partial", status: "incomplete_preview", states: { final_delivery_ready: false } });
    expect(out.delivery.label).toContain("INCOMPLETE PREVIEW");
    expect(out.delivery.scenes.map((s: any) => [s.scene_id, s.status])).toEqual([["S01", "rendered_unverified"], ["S02", "placeholder"], ["S03", "rendered_unverified"]]);
    expect(out.delivery.scenes[1].omitted_reason).toContain("a logo");
    expect(outFiles(id, runId)).toEqual([`${out.delivery.output.path.split("/").at(-1)}`]);
    expect(existsSync(renderDirs(sessionDir(id), runId).records)).toBe(true); // only the delivery report: no render record
    expect(readdirSync(renderDirs(sessionDir(id), runId).records).filter((f) => f.startsWith("rn_"))).toEqual([]);
  });

  it("refuses the Director's ordinary demo plan (footage, transitions; no audio), listing every blocker", async () => {
    const app = build({}, new DemoClient());
    const { id, runId } = await approved(app);
    const ed = await editor(app, id);
    expect(ed.status).toBe(200);
    const res = await renderNow(app, id);
    expect(res.status).toBe(409);
    const v = await body(res);
    expect(v).toMatchObject({ error: "not_renderable", eligible: false, plan: { state: "planning", supported: 0, unsupported: 2 } });
    expect(v.blockers.join(" ")).toContain("no template is registered for remotion/text-fade-up");
    expect(v.blockers.join(" ")).not.toContain("ffmpeg/loudnorm"); // a no-audio brief gets no audio operation
    expect(outFiles(id, runId)).toEqual([]);
  });

  it("refuses when no renderer is available, and says so", async () => {
    const app = build({ renderFont: null });
    const { id, runId } = await approved(app);
    await editor(app, id);
    const view = await body(await planNow(app, id));
    expect(view).toMatchObject({ renderer_available: false, eligible: false });
    expect(view.blockers.join(" ")).toContain("no template is registered for ffmpeg/text-card");
    expect((await renderNow(app, id)).status).toBe(409);
    expect(outFiles(id, runId)).toEqual([]);
    expect((await body(await app.request("/api/health"))).render.available).toBe(false);
  });
});

describe.skipIf(skipReal(!!font))("stale approvals and stale Editor results", () => {
  it("refuses to render when the stored approvals no longer match", async () => {
    const app = build();
    const { id, runId } = await approved(app);
    await editor(app, id);
    expect((await renderNow(app, id)).status).toBe(200);
    const approvals = join(sessionDir(id), "runs", runId, "approvals");
    expect(existsSync(approvals)).toBe(true);
    rmSync(approvals, { recursive: true, force: true }); // the stored approvals are the reference; without them nothing is trusted
    for (const res of [await renderNow(app, id), await editor(app, id), await app.request(`/api/sessions/${id}/render`)]) {
      expect(res.status).toBe(409);
      expect((await body(res)).error).toBe("handoff_refused");
    }
  });

  it("refuses an Editor result made from an earlier handoff, or from another run, or one that was damaged", async () => {
    const app = build();
    const { id, runId } = await approved(app);
    await editor(app, id);
    const f = renderDirs(sessionDir(id), runId).editor;
    const env = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...env, output: { ...env.output, handoff_content_hash: "0".repeat(64) } }));
    let res = await renderNow(app, id);
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("stale_editor_output");
    writeFileSync(f, JSON.stringify({ ...env, run_id: "someone-else" }));
    expect((await body(await renderNow(app, id))).error).toBe("editor_output_unreadable");
    writeFileSync(f, "{ not json");
    expect((await body(await renderNow(app, id))).error).toBe("editor_output_unreadable");
    writeFileSync(f, JSON.stringify(env));
    res = await renderNow(app, id);
    expect(res.status).toBe(200);
  }, 60_000);

  it("a new Director run has no Editor result and no render eligibility from the earlier one", async () => {
    const app = build();
    const first = await approved(app);
    await editor(app, first.id);
    expect((await renderNow(app, first.id)).status).toBe(200);
    // start another run in the same session: a new run id, so nothing from the first run applies
    const again = await sse(await app.request(`/api/sessions/${first.id}/direct`, json({})));
    const second = again.find((e) => e.event === "state")!.data.run_id as string;
    expect(second).not.toBe(first.runId);
    const res = await app.request(`/api/sessions/${first.id}/render`);
    expect(res.status).toBe(409);
    expect(existsSync(renderDirs(sessionDir(first.id), second).editor)).toBe(false);
    expect(new RunStore(sessionDir(first.id)).loadApprovals(second).records).toHaveLength(0);
  }, 90_000);

  it("a requested change to the storyboard leaves the old approval superseded, so no handoff, Editor or render exists for it", async () => {
    const app = build();
    const { id } = await atGate1(app);
    const r = await app.request(`/api/sessions/${id}/approve`, json({ stage: "storyboard", plan_version: 1, decision: "revision_requested", notes: "Make scene one shorter." }));
    expect(r.status).toBe(200);
    expect((await editor(app, id)).status).toBe(409);
    expect((await renderNow(app, id)).status).toBe(409);
    expect((await approve(app, id, "storyboard")).status).toBe(409); // version 1 is stale
  });
});

describe.skipIf(skipReal(!!font))("failed renders", () => {
  it("is reported as failed, with no video, no leaked paths and no leftover file, and is recorded", async () => {
    const bad = join(dir, "broken.ttf");
    writeFileSync(bad, "this is not a font");
    const app = build({ renderFont: bad });
    const { id, runId } = await approved(app);
    await editor(app, id);
    const res = await renderNow(app, id);
    const v = await body(res);
    expect(res.status).toBe(502);
    expect(v.record).toMatchObject({ state: "failed", output: null });
    expect(v.record.errors[0]).toMatchObject({ stage: "adapter" });
    const text = JSON.stringify(v);
    for (const secret of [dir, dir.replaceAll("\\", "\\\\"), tmpdir(), tmpdir().replaceAll("\\", "\\\\"), bad.replaceAll("\\", "\\\\")]) expect(text, secret).not.toContain(secret);
    expect(outFiles(id, runId)).toEqual([]);
    const list = await body(await app.request(`/api/sessions/${id}/renders`));
    expect(list.records.map((r: any) => r.state)).toEqual(["failed"]);
    expect((await app.request(`/api/sessions/${id}/renders/${v.record.render_id}/video`)).status).toBe(404);
  }, 60_000);

  it("refuses two renders at once for the same session", async () => {
    const app = build();
    const { id } = await approved(app);
    await editor(app, id);
    const [a, b] = await Promise.all([renderNow(app, id), renderNow(app, id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  }, 90_000);
});

describe.skipIf(skipReal(!!font))("several scene templates and a crossfade, through the console", () => {
  const edit = { uses: [
    { use_id: "U01", scene_id: "S01", recipe_id: "title-subtitle", params: {}, rationale: "opening title" },
    { use_id: "U02", scene_id: "S01", recipe_id: "crossfade", params: { duration_s: 0.6 }, rationale: "soft change" },
    { use_id: "U03", scene_id: "S02", recipe_id: "stat-callout", params: {}, rationale: "one key figure" },
    { use_id: "U04", scene_id: "S03", recipe_id: "text-card-fade", params: {}, rationale: "closing line" },
  ] };
  const sb = { scenes: [scene("S01", "Meet Lumen | Plan your study week", { transition_out: "crossfade" }), scene("S02", "3 steps | to a calmer week | Pick, plan, review"), scene("S03", "Start planning today.")] };

  it("shows every template as supported, renders the film, and reports the measured result", async () => {
    const app = build({}, new CardsClient(sb, edit));
    const { id, runId } = await approved(app);
    expect((await editor(app, id)).status).toBe(200);
    const view = await body(await planNow(app, id));
    expect(view).toMatchObject({ eligible: true, plan: { state: "executable", supported: 4, unsupported: 0 } });
    expect(view.plan.operations.map((o: any) => o.template)).toEqual(["ffmpeg/title-subtitle", "ffmpeg/xfade-fade", "ffmpeg/stat-callout", "ffmpeg/text-card"]);
    expect(view.coverage.complete).toBe(true);
    const res = await renderNow(app, id);
    const r = await body(res);
    expect(res.status).toBe(200);
    expect(r.record).toMatchObject({ state: "rendered", purpose: "preview" });
    expect(r.record.output).toMatchObject({ width: 640, height: 360, fps: 30, duration_s: 12, video_codec: "h264" });
    expect(r.qa.findings).toEqual([]);
    expect(outFiles(id, runId)).toEqual([`${r.record.render_id}.mp4`]);
    expect((await app.request(r.record.output.video_url)).status).toBe(200);
    expect(readdirSync(renderDirs(sessionDir(id), runId).evidence).sort()).toEqual(["crossfade", "stat-callout", "text-card-fade", "title-subtitle"].map((n) => `${n}@0.1.0.${r.record.render_id}.json`));
  }, 120_000);

  it("refuses a list item that cannot fit on one line, with the scene's own reason, and renders nothing", async () => {
    const list = { scenes: [scene("S01", "Heading | an item far too long to fit on one line of this small frame at all", {}), scene("S02", "Thanks."), scene("S03", "Bye.")] };
    const e2 = { uses: [{ use_id: "U01", scene_id: "S01", recipe_id: "bullet-list", params: {}, rationale: "list" }, { use_id: "U02", scene_id: "S02", recipe_id: "text-card-fade", params: {}, rationale: "x" }, { use_id: "U03", scene_id: "S03", recipe_id: "text-card-fade", params: {}, rationale: "y" }] };
    const app = build({}, new CardsClient(list, e2));
    const { id, runId } = await approved(app);
    await editor(app, id);
    const v = await body(await planNow(app, id));
    expect(v).toMatchObject({ eligible: false, plan: { state: "planning" } });
    expect(v.blockers.join(" ")).toContain("operation E01: the item 1");
    // the scene that cannot be drawn keeps its own reason in an INCOMPLETE preview; nothing is drawn differently from what was approved
    const res = await renderNow(app, id);
    const out = await body(res);
    expect(res.status, JSON.stringify(out.errors ?? out.message)).toBe(200);
    expect(out.kind).toBe("partial");
    expect(out.delivery.scenes.map((s: any) => [s.scene_id, s.status])).toEqual([["S01", "placeholder"], ["S02", "rendered_unverified"], ["S03", "rendered_unverified"]]);
    expect(out.delivery.scenes[0].omitted_reason).toContain("the item 1");
    expect(out.delivery.final_delivery_blockers.join(" ")).toContain("incomplete");
    expect(outFiles(id, runId)).toEqual([`${out.delivery.output.path.split("/").at(-1)}`]);
  });
});
describe.skipIf(skipReal(!!font))("supplied footage, through the console", () => {
  const clip = join(tmpdir(), `console-clip-${process.pid}.mp4`);
  beforeAll(() => { execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=12:r=30", "-pix_fmt", "yuv420p", clip], { stdio: "ignore" }); });
  afterAll(() => rmSync(clip, { force: true }));

  /** The storyboard names the uploaded file by the id the console gave it, read from the prompt the Director sends. */
  class FootageClient extends DemoClient {
    override async generate<T>(req: GenerateRequest<T>): Promise<T> {
      const id = /"asset_id":\s*"(asset_[a-f0-9]{8})"/.exec(req.user)?.[1];
      if (req.name === "storyboard" && id) return req.schema.parse({ scenes: [scene("S01", "Our footage", { duration_seconds: 6, asset_ids: [id], source_in_seconds: 2, required_assets: [{ need: "Supplied footage", kind: "footage", availability: "supplied", asset_id: id }] }), scene("S02", "Thanks for watching.", { duration_seconds: 6 })] });
      if (req.name === "edit_plan") return req.schema.parse({ uses: [{ use_id: "U01", scene_id: "S01", recipe_id: "clip-play-caption", params: {}, rationale: "show the footage" }, { use_id: "U02", scene_id: "S02", recipe_id: "text-card-fade", params: {}, rationale: "closing line" }] });
      return super.generate(req);
    }
  }

  it("renders an uploaded clip from the approved start point, with the measured result and a playable address", async () => {
    const app = build({}, new FootageClient());
    const id = await newSession(app);
    const fd = new FormData(); fd.append("files", new File([readFileSync(clip)], "mine.mp4"));
    expect((await app.request(`/api/sessions/${id}/assets`, { method: "POST", body: fd })).status).toBe(200);
    await app.request(`/api/sessions/${id}/route`, json({ text: "A 12 second YouTube video from my footage." }));
    const state = (await sse(await app.request(`/api/sessions/${id}/direct`, json({})))).find((e) => e.event === "state")!.data;
    expect(state).toMatchObject({ status: "awaiting_approval", gate: "storyboard" });
    expect((await approve(app, id, "storyboard")).status).toBe(200);
    expect((await approve(app, id, "edit_plan")).status).toBe(200);
    expect((await editor(app, id)).status).toBe(200);
    const view = await body(await planNow(app, id));
    expect(view).toMatchObject({ eligible: true, plan: { state: "executable", supported: 2, unsupported: 0 }, coverage: { complete: true } });
    expect(view.plan.operations.map((o: any) => o.template)).toEqual(["ffmpeg/clip-play", "ffmpeg/text-card"]);
    const res = await renderNow(app, id);
    const r = await body(res);
    expect(res.status, JSON.stringify(r.record?.errors ?? r)).toBe(200);
    expect(r.record).toMatchObject({ state: "rendered", purpose: "preview" });
    expect(r.record.output).toMatchObject({ width: 640, height: 360, fps: 30, duration_s: 12, video_codec: "h264", audio_tracks: 0 });
    expect(r.qa.findings).toEqual([]);
    expect((await app.request(r.record.output.video_url)).status).toBe(200);
    expect(readFileSync(clip).length).toBeGreaterThan(0); // the upload is untouched
  }, 120_000);

  it("refuses to render when the uploaded clip is replaced after approval", async () => {
    const app = build({}, new FootageClient());
    const id = await newSession(app);
    const fd = new FormData(); fd.append("files", new File([readFileSync(clip)], "mine.mp4"));
    const up = await body(await app.request(`/api/sessions/${id}/assets`, { method: "POST", body: fd }));
    await app.request(`/api/sessions/${id}/route`, json({ text: "A 12 second YouTube video from my footage." }));
    await sse(await app.request(`/api/sessions/${id}/direct`, json({})));
    await approve(app, id, "storyboard"); await approve(app, id, "edit_plan");
    await editor(app, id);
    const uploaded = up.added[0].uri as string;
    const keep = readFileSync(uploaded);
    try {
      writeFileSync(uploaded, Buffer.concat([keep, Buffer.from([0])]));
      const res = await renderNow(app, id);
      expect(res.status).toBe(409);
      expect(["handoff_refused", "not_renderable"]).toContain((await body(res)).error);
      expect((await app.request(`/api/sessions/${id}/render`)).status).toBe(409);
    } finally { writeFileSync(uploaded, keep); }
  }, 120_000);
});