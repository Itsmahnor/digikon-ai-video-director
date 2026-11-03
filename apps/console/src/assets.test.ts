import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "@digikon/contracts";
import { DemoClient, SkillLibrary, type GenerateRequest } from "@digikon/director";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import type { SpeechEngine } from "@digikon/speech";
import { createApp } from "./app.js";
import { findRemotionBrowser } from "@digikon/render";
import { realPrerequisites, skipReal } from "../../../packages/render/src/test-env.js";

// Uploaded pictures are discoverable, measured, reviewable and available for scene matching. Real files and the real FFmpeg; the Director is a scripted stand-in.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const recipes = loadRecipes(join(repo, "recipes"));
const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
let ffmpegOk = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { ffmpegOk = false; }
realPrerequisites({ ffmpeg: ffmpegOk });
vi.setConfig({ testTimeout: 120_000 });
let dir: string, picsDir: string;
const pics: string[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "console-assets-")); }); // each test has its own storage, so a stored review in one never reaches another
afterEach(() => rmSync(dir, { recursive: true, force: true }));
beforeAll(() => {
  picsDir = mkdtempSync(join(tmpdir(), "console-assets-pics-"));
  const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "ignore" });
  // three screen-capture-like pictures with different content, so they are different files
  for (const [i, box] of ["drawbox=x=40:y=40:w=300:h=60:color=0x4f46e5:t=fill", "drawbox=x=40:y=140:w=720:h=200:color=0xdddddd:t=fill", "drawbox=x=400:y=40:w=300:h=300:color=0x22aa66:t=fill"].entries()) {
    const p = join(picsDir, `shot${i + 1}.png`); ff("-f", "lavfi", "-i", "color=c=white:s=800x450:d=1", "-vf", box, "-frames:v", "1", p); pics.push(p);
  }
});
afterAll(() => rmSync(picsDir, { recursive: true, force: true }));

const speech: SpeechEngine = { model: "stub", transcribe: async () => Transcript.parse({ text: "x", language: "en", language_confidence: 1, model: "stub", duration_s: 1, words: [], segments: [] }) };
const scene = (id: string, over: Record<string, unknown> = {}) => ({
  scene_id: id, purpose: "p", duration_seconds: 4, asset_ids: [], required_assets: [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }], transition_out: "cut",
  shot: { shot_size: "wide", camera_motion: "static", visual_action: "Text on a plain background" }, overlay: { text: "Hello there.", safe_area: "platform_safe" }, ...over,
});
const use = (n: number, scene_id: string, recipe_id: string) => ({ use_id: `U0${n}`, scene_id, recipe_id, params: {}, rationale: "plain text scene" });
const prompts: string[] = [];
let replanned: { scenes: unknown[]; uses: unknown[] } | null = null; // set to make the scripted Director plan again with what the review found
class Client extends DemoClient {
  override async generate<T>(req: GenerateRequest<T>): Promise<T> {
    if (replanned && req.name === "storyboard") return req.schema.parse({ scenes: replanned.scenes });
    if (replanned && req.name === "edit_plan") return req.schema.parse({ uses: replanned.uses });
    if (req.name === "storyboard") {
      prompts.push(req.user);
      return req.schema.parse({ scenes: [
        scene("S01"),
        scene("S02", { required_assets: [{ need: "A product screen", kind: "ui_screenshot", availability: "generate_graphics", placeholder: true }], unresolved: [{ kind: "placeholder", note: "No product screen is assigned: a concept graphic is shown until one is reviewed." }] }),
        scene("S03", { required_assets: [{ need: "Supplied team or people image, if one matches. Content is unknown until a vision pass.", kind: "image", availability: "needs_external", fallback: "Use generic avatar circles drawn as graphics and no photographic people." }] }),
      ] });
    }
    if (req.name === "edit_plan") return req.schema.parse({ uses: [use(1, "S01", "text-card-fade"), use(2, "S02", "text-card-fade"), use(3, "S03", "text-card-fade")] });
    return super.generate(req);
  }
}
const build = () => createApp({
  llm: new Client(), demo: true, speech, whisper: () => ({ state: "ready" }), skills: new SkillLibrary(join(repo, "skills")), editorSkills: new SkillLibrary(join(repo, "skills/editor")),
  retriever: new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge"))]),
  recipes: new RecipeLibrary(recipes, "draft"), ffmpegOk, renderFont: font, storageDir: dir, publicDir: join(repo, "apps/console/public"), capabilitiesDir: join(dir, "capabilities"),
});
type App = ReturnType<typeof build>;
const json = (b: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const body = async (r: Response) => (await r.json()) as any;
const REVIEW = (over: Record<string, unknown> = {}) => ({ summary: "A dashboard screen of an operations product", subjects: ["dashboard", "invoices"], has_people: false, shows_product_ui: true, reviewed_by: "assistant", method: "viewed by an assistant in a development session, not an automated vision model", ...over });

async function projectWithPictures(app: App) {
  const id = (await body(await app.request("/api/sessions", { method: "POST" }))).id as string;
  const fd = new FormData();
  for (const p of pics) fd.append("files", new File([readFileSync(p)], p.split(/[\\/]/).at(-1)!));
  const up = await body(await app.request(`/api/sessions/${id}/assets`, { method: "POST", body: fd }));
  return { id, up };
}
async function direct(app: App, id: string) {
  await app.request(`/api/sessions/${id}/route`, json({ text: "A 12 second YouTube explainer for my product." }));
  await (await app.request(`/api/sessions/${id}/direct`, json({}))).text();
}

describe.skipIf(skipReal(ffmpegOk))("uploaded pictures are discoverable, measured, reviewable and available for scene matching", () => {
  it("all three uploads are registered for the project, stored on disk, and measured as screen captures: not 'unknown' and not assumed to show people", async () => {
    const app = build();
    const { id, up } = await projectWithPictures(app);
    expect(up.rejected).toEqual([]);
    expect(up.added).toHaveLength(3);
    const s = await body(await app.request(`/api/sessions/${id}`));
    expect(s.assets.map((a: any) => [a.media_type, a.width, a.height])).toEqual([["image", 800, 450], ["image", 800, 450], ["image", 800, 450]]);
    for (const a of s.assets) expect(existsSync(join(dir, "sessions", id, "uploads", `${a.asset_id}.png`))).toBe(true);
    await direct(app, id); // the Director waits for the measurements
    const after = await body(await app.request(`/api/sessions/${id}`));
    expect(after.analysis.map((x: any) => [x.status, x.image_kind, x.reviewed])).toEqual([["done", "screen_capture_or_graphic", false], ["done", "screen_capture_or_graphic", false], ["done", "screen_capture_or_graphic", false]]);
  });

  it("the Director is told what is known: the measured kind and that nobody has reviewed the content, not the old empty summary", async () => {
    prompts.length = 0;
    const app = build();
    const { id } = await projectWithPictures(app);
    await direct(app, id);
    expect(prompts.join("\n")).toContain("Measured, not interpreted");
    expect(prompts.join("\n")).toContain("Nobody has reviewed what this picture shows");
    expect(prompts.join("\n")).not.toContain("Content has not been looked at by a vision pass");
  });

  it("matching is honest: with no review the people need is 'needs_review' and no picture is assigned; reviewing changes the answer", async () => {
    const app = build();
    const { id, up } = await projectWithPictures(app);
    await direct(app, id);
    const first = await body(await app.request(`/api/sessions/${id}/asset-matches`));
    expect(first.assets).toHaveLength(3);
    expect(first.assets.every((a: any) => a.on_disk && a.size_matches && a.kind === "screen_capture_or_graphic" && !a.reviewed)).toBe(true);
    expect(JSON.stringify(first)).not.toContain(dir.replaceAll("\\", "\\\\")); // no absolute path reaches the browser
    const people = first.matches.find((m: any) => m.scene_id === "S03");
    expect(people).toMatchObject({ wants: "people", decision: "needs_review", candidates: [] });
    expect(first.matches.find((m: any) => m.scene_id === "S02")).toMatchObject({ wants: "product_ui", decision: "needs_review" });

    // review every picture: none shows people; the first shows the product
    for (const [i, a] of up.added.entries()) {
      const r = await app.request(`/api/sessions/${id}/assets/${a.asset_id}/review`, json(REVIEW({ shows_product_ui: i === 0 })));
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    }
    const second = await body(await app.request(`/api/sessions/${id}/asset-matches`));
    expect(second.matches.find((m: any) => m.scene_id === "S03")).toMatchObject({ decision: "none_suitable", candidates: [], fallback: expect.stringContaining("generic avatar") });
    const ui = second.matches.find((m: any) => m.scene_id === "S02");
    expect(ui).toMatchObject({ decision: "use" });
    expect(ui.candidates.map((c: any) => [c.asset_id, c.basis])).toEqual([[up.added[0].asset_id, "reviewed"]]);

    // a reviewed picture that does show people is matched to the people need
    await app.request(`/api/sessions/${id}/assets/${up.added[2].asset_id}/review`, json(REVIEW({ summary: "Four colleagues at a table", has_people: true, shows_product_ui: false })));
    const third = await body(await app.request(`/api/sessions/${id}/asset-matches`));
    expect(third.matches.find((m: any) => m.scene_id === "S03")).toMatchObject({ decision: "use", candidates: [{ asset_id: up.added[2].asset_id, basis: "reviewed" }] });
  });

  it("a review is validated and stored, and refuses what is not a picture of this project", async () => {
    const app = build();
    const { id, up } = await projectWithPictures(app);
    const a = up.added[0].asset_id;
    expect((await app.request(`/api/sessions/${id}/assets/asset_deadbeef/review`, json(REVIEW()))).status).toBe(404);
    expect((await app.request(`/api/sessions/${id}/assets/${a}/review`, json({ summary: "", has_people: false, shows_product_ui: false, reviewed_by: "assistant", method: "x" }))).status).toBeGreaterThanOrEqual(400);
    expect((await app.request(`/api/sessions/${id}/assets/${a}/review`, json(REVIEW({ reviewed_by: "nobody" })))).status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(dir, "sessions", id, "reviews", `${a}.json`))).toBe(false); // nothing is stored for a refused review
    const ok = await app.request(`/api/sessions/${id}/assets/${a}/review`, json(REVIEW()));
    expect(ok.status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, "sessions", id, "reviews", `${a}.json`), "utf8"))).toMatchObject({ reviewed_by: "assistant", has_people: false, shows_product_ui: true });
    expect((await body(await app.request(`/api/sessions/${id}`))).analysis.find((x: any) => x.asset_id === a)).toMatchObject({ reviewed: true });
    expect(readdirSync(join(dir, "sessions", id, "reviews"))).toEqual([`${a}.json`]);
    // the same bytes uploaded to another project are found already reviewed; different bytes are not
    const other = await projectWithPictures(app);
    let o = await body(await app.request(`/api/sessions/${other.id}`));
    for (let i = 0; i < 50 && o.analysis.some((x: any) => x.status !== "done"); i++) { await new Promise((r) => setTimeout(r, 100)); o = await body(await app.request(`/api/sessions/${other.id}`)); } // the measuring runs in the background
    expect(o.analysis.map((x: any) => x.reviewed)).toEqual([true, false, false]);
  });

  it("a review survives a restart: the restored run still has the measured kind and the review, and an unreviewed picture stays unreviewed", async () => {
    const app = build();
    const { id, up } = await projectWithPictures(app);
    await direct(app, id);
    await app.request(`/api/sessions/${id}/assets/${up.added[0].asset_id}/review`, json(REVIEW()));
    const runs = readdirSync(join(dir, "sessions", id, "runs"));
    expect(runs).toHaveLength(1);
    const app2 = build(); // a new application with no memory of the first
    const resumed = await app2.request(`/api/sessions/${id}/runs/${runs[0]}/resume`, { method: "POST" });
    expect(resumed.status, JSON.stringify(await resumed.clone().json())).toBe(200);
    const m = await body(await app2.request(`/api/sessions/${id}/asset-matches`));
    expect(m.assets.map((a: any) => [a.reviewed, a.kind])).toEqual([[true, "screen_capture_or_graphic"], [false, "screen_capture_or_graphic"], [false, "screen_capture_or_graphic"]]);
  });
});

const remotion = findRemotionBrowser();
describe.skipIf(skipReal(ffmpegOk && !!font && !!remotion))("the reviewed pictures reach a real render, through renewed approvals", () => {
  const approve = (app: App, id: string, stage: "storyboard" | "edit_plan") => app.request(`/api/sessions/${id}/approve`, json({ stage, plan_version: 1, decision: "approved", ...(stage === "edit_plan" ? { storyboard_version: 1 } : {}) }));
  const SETTINGS = { aspect_ratio: "16:9", width: 640, height: 360, fps: 30, duration_s: 12, container: "mp4", video_codec: "h264", audio_codec: null };

  it("the first plan, with an unfilled team-image need, cannot be handed to the Editor; after the review a new plan uses the reviewed picture, is approved again, and renders", async () => {
    replanned = null;
    const app = build();
    const { id, up } = await projectWithPictures(app);
    await direct(app, id);
    // the first plan's S03 need is "needs_external": its approval is not enough for the Editor, because the material is not supplied
    const first = await approve(app, id, "storyboard");
    expect(first.status).toBe(200);
    // the production gate now stops it before the second approval: the edit plan escalates (its missing picture is named only in the hidden production detail), so nothing waits for a decision and the Editor has nothing approved to run on
    const gated = (await first.json()) as { state: { escalation: { what_failed: string } | null; editPlan: unknown } };
    expect(gated.state.editPlan).toBeNull();
    expect(gated.state.escalation?.what_failed).toContain("edit plan still failed validation");
    expect((await approve(app, id, "edit_plan")).status).toBe(409);
    const blocked = await app.request(`/api/sessions/${id}/editor`, { method: "POST" });
    expect(blocked.status).toBe(409);

    // review every picture; the matches name the picture for the product-screen need, and say none shows people
    for (const a of up.added) await app.request(`/api/sessions/${id}/assets/${a.asset_id}/review`, json(REVIEW({ shows_product_ui: a.asset_id === up.added[0].asset_id })));
    const matches = (await body(await app.request(`/api/sessions/${id}/asset-matches`))).matches;
    const screen = matches.find((m: any) => m.scene_id === "S02");
    expect(screen.decision).toBe("use");
    const chosen = screen.candidates[0].asset_id as string;
    expect(chosen).toBe(up.added[0].asset_id);
    expect(matches.find((m: any) => m.scene_id === "S03").decision).toBe("none_suitable");

    // the Director plans again with that knowledge: the screen is supplied, and the people need is the approved generic graphic
    replanned = {
      scenes: [
        scene("S01"),
        scene("S02", { asset_ids: [chosen], required_assets: [{ need: "A product screen", kind: "ui_screenshot", availability: "supplied", asset_id: chosen }], overlay: { text: "See every invoice.", safe_area: "platform_safe" } }),
        scene("S03", { required_assets: [{ need: "Generic avatar circles, drawn as graphics", kind: "graphics", availability: "generate_graphics" }] }),
      ],
      uses: [use(1, "S01", "text-card-fade"), use(2, "S02", "image-caption-remotion"), use(3, "S03", "text-card-fade")],
    };
    const again = await body(await app.request("/api/sessions", { method: "POST" }));
    const id2 = again.id as string;
    // the same files in a new project of the same storage: upload again (the files are the same bytes) and review them again
    const fd = new FormData(); for (const p of pics) fd.append("files", new File([readFileSync(p)], p.split(/[\\/]/).at(-1)!));
    const up2 = await body(await app.request(`/api/sessions/${id2}/assets`, { method: "POST", body: fd }));
    for (const a of up2.added) await app.request(`/api/sessions/${id2}/assets/${a.asset_id}/review`, json(REVIEW()));
    const chosen2 = up2.added[0].asset_id as string;
    replanned.scenes[1] = scene("S02", { asset_ids: [chosen2], required_assets: [{ need: "A product screen", kind: "ui_screenshot", availability: "supplied", asset_id: chosen2 }], overlay: { text: "See every invoice.", safe_area: "platform_safe" } });
    await direct(app, id2);
    // renewed approval is needed: nothing of the first run's approvals applies to this plan
    expect((await app.request(`/api/sessions/${id2}/editor`, { method: "POST" })).status).toBe(409);
    expect((await approve(app, id2, "storyboard")).status).toBe(200);
    expect((await approve(app, id2, "edit_plan")).status).toBe(200);
    const ed = await app.request(`/api/sessions/${id2}/editor`, { method: "POST" });
    expect(ed.status, JSON.stringify(await ed.clone().json())).toBe(200);
    const res = await app.request(`/api/sessions/${id2}/render`, json({ settings: SETTINGS }));
    const out = await body(res);
    expect(res.status, JSON.stringify(out.errors ?? out.reasons ?? out.message)).toBe(200);
    expect(out.kind).toBe("complete");
    expect(out.delivery.scenes.find((s: any) => s.scene_id === "S02")).toMatchObject({ engine: "remotion", status: "rendered_and_verified" });
    expect(out.delivery.scenes.find((s: any) => s.scene_id === "S02").operations.some((o: any) => o.recipe_id === "image-caption-remotion")).toBe(true);
    const video = await app.request(out.delivery.output.video_url);
    expect(video.status).toBe(200);
    expect((await video.arrayBuffer()).byteLength).toBe(out.delivery.output.bytes);
    expect(existsSync(join(dir, "sessions", id2, "renders"))).toBe(true);
  });
});