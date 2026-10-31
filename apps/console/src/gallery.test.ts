import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "@digikon/contracts";
import { DemoClient, SkillLibrary } from "@digikon/director";
import { ALL_PROMPTS, type VisionModel } from "@digikon/media";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import type { SpeechEngine } from "@digikon/speech";
import { createApp } from "./app.js";

// The gallery, corrections, restart and project isolation, through the real API with real files. The vision model is a stand-in; the real one is tested in packages/media.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const recipes = loadRecipes(join(repo, "recipes"));
vi.setConfig({ testTimeout: 60_000 });
const speech: SpeechEngine = { model: "stub", transcribe: async () => Transcript.parse({ text: "x", language: "en", language_confidence: 1, model: "stub", duration_s: 1, words: [], segments: [] }) };
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "console-gallery-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const vision = (favour: string, calls = { n: 0 }): VisionModel => ({ classifier: "stand-in", describer: "stand-in", classify: async () => { calls.n++; return ALL_PROMPTS.map((label) => ({ label, score: label.includes(favour) ? 0.6 : 0.01 })); }, describe: async () => ({ text: "A white background with a green logo.", objects: [] }) });
const build = (v: VisionModel | null) => createApp({
  llm: new DemoClient({ creative: true }), demo: true, speech, whisper: () => ({ state: "ready" }), skills: new SkillLibrary(join(repo, "skills")), retriever: new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge"))]),
  recipes: new RecipeLibrary(recipes, "draft"), ffmpegOk: true, renderFont: null, storageDir: dir, publicDir: join(repo, "apps/console/public"), capabilitiesDir: null, vision: v, ocr: [],
});
type App = ReturnType<typeof build>;
const json = (b: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const body = async (r: Response) => (await r.json()) as any;
const picture = (colour: string) => sharp({ create: { width: 320, height: 200, channels: 4, background: colour } }).png().toBuffer();
const newSession = async (app: App) => (await body(await app.request("/api/sessions", { method: "POST" }))).id as string;
async function upload(app: App, sid: string, bytes: Buffer, name: string) {
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(bytes)]), name);
  const r = await body(await app.request(`/api/sessions/${sid}/assets`, { method: "POST", body: form }));
  await waitDone(app, sid);
  return r;
}
async function waitDone(app: App, sid: string) {
  for (let i = 0; i < 100; i++) {
    const g = await body(await app.request(`/api/sessions/${sid}/gallery`));
    if (g.items.every((x: { status: string }) => x.status !== "running" && x.status !== "pending")) return g;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("analysis did not finish");
}

describe("the asset gallery", () => {
  it("shows what was found about each picture, with a real thumbnail, and the upload as it was", async () => {
    const app = build(vision("a company logo"));
    const sid = await newSession(app);
    const { added } = await upload(app, sid, await picture("#81d870"), "digikon-logo.png");
    const g = await waitDone(app, sid);
    expect(g.items).toHaveLength(1);
    const i = g.items[0];
    expect(i).toMatchObject({ asset_id: added[0].asset_id, session_id: sid, original_filename: "digikon-logo.png", status: "partial", width: 320, height: 200, transparent: false, description: "A white background with a green logo.", storyboard_usage: [], availability: "available" });
    expect(i.categories[0]).toMatchObject({ category: "brand_logo", label: "Brand logo", source: "vision" });
    expect(i.stages).toEqual(["uploaded", "analyzed", "classified", "available_to_director"]);
    const thumb = await app.request(i.thumbnail_url);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/png");
    expect((await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()).width).toBeGreaterThan(0);
    expect(existsSync(added[0].uri)).toBe(true);
  });

  it("never claims analysis that did not happen, and asks the user", async () => {
    const app = build(null);
    const sid = await newSession(app);
    await upload(app, sid, await picture("#123456"), "mystery.png");
    const i = (await waitDone(app, sid)).items[0];
    expect(i.status).toBe("failed");
    expect(i.description).toBeNull();
    expect(i.categories).toEqual([]);
    expect(i.error).toMatch(/No vision model/);
    expect(i.retryable).toBe(true);
    expect(i.width).toBe(320); // what was measured is still there
    expect(i.stages).toEqual(["uploaded", "available_to_director"]);
  });

  it("lets the user correct a picture, and the correction wins and reaches the Director's notes", async () => {
    const app = build(vision("a drawn illustration"));
    const sid = await newSession(app);
    const { added } = await upload(app, sid, await picture("#222222"), "a.png");
    const id = added[0].asset_id;
    const r = await app.request(`/api/sessions/${sid}/assets/${id}/correction`, json({ category: "dashboard_ui", description: "This is the actual dashboard that must appear.", usage: "must_use", genuine_product_ui: true }));
    expect(r.status).toBe(200);
    const i = (await waitDone(app, sid)).items[0];
    expect(i.categories).toEqual([{ category: "dashboard_ui", confidence: 1, source: "user", label: "Dashboard or software UI" }]);
    expect(i.description).toBe("This is the actual dashboard that must appear.");
    expect(i.user.usage).toBe("must_use");
    expect(i.genuine_product_ui).toBe(true);
  });

  it("refuses a nonsense correction", async () => {
    const app = build(vision("a simple icon"));
    const sid = await newSession(app);
    const { added } = await upload(app, sid, await picture("#333333"), "a.png");
    expect((await app.request(`/api/sessions/${sid}/assets/${added[0].asset_id}/correction`, json({ category: "not_a_kind" }))).status).toBe(400);
    expect((await app.request(`/api/sessions/${sid}/assets/${added[0].asset_id}/correction`, json({ anything: 1 }))).status).toBe(400);
  });

  it("is all still there after a restart", async () => {
    const first = build(vision("a drawn illustration"));
    const sid = await newSession(first);
    const { added } = await upload(first, sid, await picture("#445566"), "a.png");
    await first.request(`/api/sessions/${sid}/assets/${added[0].asset_id}/correction`, json({ usage: "optional" }));
    const calls = { n: 0 };
    const second = build(vision("a drawn illustration", calls)); // a new process over the same storage
    const g = await body(await second.request(`/api/sessions/${sid}/gallery`));
    expect(g.items[0]).toMatchObject({ asset_id: added[0].asset_id, original_filename: "a.png", user: { usage: "optional" } });
    expect(g.items[0].categories[0].category).toBe("illustration");
    expect(calls.n).toBe(0); // read back, not analysed again
    expect((await second.request(g.items[0].thumbnail_url)).status).toBe(200);
  });

  it("keeps projects apart: one cannot reach, correct or read another's picture, though the analysis is reused", async () => {
    const calls = { n: 0 };
    const app = build(vision("a drawn illustration", calls));
    const a = await newSession(app), b = await newSession(app);
    const bytes = await picture("#556677");
    const { added } = await upload(app, a, bytes, "shared.png");
    const id = added[0].asset_id;
    expect((await app.request(`/api/sessions/${b}/assets/${id}/thumbnail`)).status).toBe(404);
    expect((await app.request(`/api/sessions/${b}/assets/${id}/correction`, json({ usage: "do_not_use" }))).status).toBe(404);
    expect((await app.request(`/api/sessions/${b}/files/${id}`)).status).toBe(404);

    await upload(app, b, bytes, "same-bytes.png");
    expect(calls.n).toBe(1); // the same picture is analysed once
    const gb = await waitDone(app, b);
    expect(gb.items[0].original_filename).toBe("same-bytes.png");
    expect(gb.items[0].asset_id).not.toBe(id);
    expect(gb.items[0].used_in_projects).toBe(2);
  });

  it("does not add the same file twice to one project, and says why", async () => {
    const app = build(vision("a simple icon"));
    const sid = await newSession(app);
    const bytes = await picture("#667788");
    await upload(app, sid, bytes, "one.png");
    const again = await upload(app, sid, bytes, "two.png");
    expect(again.added).toEqual([]);
    expect(again.rejected[0].issues[0]).toMatchObject({ code: "duplicate" });
    expect(again.rejected[0].issues[0].message).toContain("one.png");
    expect((await waitDone(app, sid)).items).toHaveLength(1);
  });

  it("analyses again on request after a failure", async () => {
    const dead: VisionModel = { classifier: "x", describer: null, classify: async () => { throw new Error("offline"); }, describe: async () => null };
    const app = build(dead);
    const sid = await newSession(app);
    const { added } = await upload(app, sid, await picture("#778899"), "a.png");
    expect((await waitDone(app, sid)).items[0].status).toBe("failed");
    Object.assign(dead, vision("a simple icon"));
    const r = await body(await app.request(`/api/sessions/${sid}/assets/${added[0].asset_id}/reanalyse`, { method: "POST" }));
    expect(["analyzed", "partial"]).toContain(r.status);
    expect((await waitDone(app, sid)).items[0].categories[0].category).toBe("icon_symbol");
  });
});
