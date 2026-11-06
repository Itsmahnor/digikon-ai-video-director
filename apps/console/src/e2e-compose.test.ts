import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Transcript } from "@digikon/contracts";
import { DemoClient, SkillLibrary } from "@digikon/director";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import { findChrome, findRemotionBrowser } from "@digikon/render";
import type { SpeechEngine } from "@digikon/speech";
import { createApp } from "./app.js";
import { realPrerequisites, skipReal } from "../../../packages/render/src/test-env.js";

// Two different briefs, the stub model composing each scene (no fixed block is chosen), then a REAL render of each film. The pictures must differ: different layouts, not the same
// template with other words. The model is the stub (no Claude); the layouts it composes are checked, planned and drawn by the real pipeline.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const recipes = loadRecipes(join(repo, "recipes"));
const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
const chrome = findChrome(), browser = findRemotionBrowser();
const can = !!font && !!chrome && !!browser;
realPrerequisites({ font: !!font, "a Chrome for HyperFrames": !!chrome, "a 64-bit Edge or Chrome for Remotion": !!browser });
vi.setConfig({ testTimeout: 600_000 });
const dir = mkdtempSync(join(tmpdir(), "console-compose-"));
const caps = join(dir, "capabilities");
if (can) cpSync(join(repo, "capabilities"), caps, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const speech: SpeechEngine = { model: "stub", transcribe: async () => Transcript.parse({ text: "x", language: "en", language_confidence: 1, model: "stub", duration_s: 1, words: [], segments: [] }) };
const json = (b: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const body = async (r: Response) => (await r.json()) as any;
const SETTINGS = { aspect_ratio: "16:9", width: 1280, height: 720, fps: 30, duration_s: 12, container: "mp4", video_codec: "h264", audio_codec: null };

async function film(app: ReturnType<typeof createApp>, brief: string, name: string) {
  const id = (await body(await app.request("/api/sessions", { method: "POST" }))).id as string;
  await app.request(`/api/sessions/${id}/route`, json({ text: brief }));
  const sse = await (await app.request(`/api/sessions/${id}/direct`, json({ facts: ["Made in small batches.", "New this week."] }))).text();
  const state = JSON.parse(sse.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).filter((l) => l.includes('"scenePlan"')).at(-1)!);
  expect(state.status, JSON.stringify(state.escalation)).toBe("awaiting_approval");
  expect(state.aspectRatio, "both briefs are drawn at the same size, so their pictures can be compared").toBe("16:9");
  expect((await app.request(`/api/sessions/${id}/approve`, json({ stage: "storyboard", plan_version: 1, decision: "approved" }))).status).toBe(200);
  const g2 = await app.request(`/api/sessions/${id}/approve`, json({ stage: "edit_plan", plan_version: 1, decision: "approved", storyboard_version: 1 }));
  expect(g2.status).toBe(200);
  // the Editor's share: the approved edit plan carries motion changes for the composed scenes
  expect(((await body(g2)).state.editPlan.composition_motion ?? []).length, "the Editor changed how the composed scenes move").toBeGreaterThan(0);
  expect((await app.request(`/api/sessions/${id}/editor`, { method: "POST" })).status).toBe(200);
  const res = await app.request(`/api/sessions/${id}/render`, json({ settings: SETTINGS }));
  const r = await body(res);
  expect(res.status, JSON.stringify({ errors: r.errors, blockers: r.record?.blockers, message: r.message, ops: r.plan?.operations?.filter((o: any) => !o.supported).slice(0, 3) }).slice(0, 1800)).toBe(200);
  // all scenes are drawn by one engine, so this is the single-renderer path (a record); a mixed film would be assembled and answer with a delivery report
  const rendered = r.record?.state === "rendered" || r.kind === "complete";
  expect(rendered, JSON.stringify(Object.keys(r))).toBe(true);
  const out = await app.request(r.delivery?.output?.video_url ?? `/api/sessions/${id}/renders/${r.record.render_id}/video`);
  expect(out.status).toBe(200);
  const file = join(dir, `${name}.mp4`);
  writeFileSync(file, Buffer.from(await out.arrayBuffer()));
  return { file, scenes: state.scenePlan.scenes as { scene_id: string; visual: { block: string; elements: { id: string }[] } }[] };
}
const frame = (file: string, t: number) => execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=160:90,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 });
const difference = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!); return s / a.length / 255; };

describe.skipIf(skipReal(can))("what the Director composes is what is rendered, and two briefs do not look alike", () => {
  it("renders two different briefs, composed scene by scene, as visibly different films", async () => {
    const app = createApp({
      llm: new DemoClient({ creative: true, compose: true }), demo: true, speech, whisper: () => ({ state: "ready" }), skills: new SkillLibrary(join(repo, "skills")), editorSkills: new SkillLibrary(join(repo, "skills/editor")),
      retriever: new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge"))]),
      recipes: new RecipeLibrary(recipes, "draft"), ffmpegOk: true, renderFont: font, storageDir: dir, publicDir: join(repo, "apps/console/public"), capabilitiesDir: caps,
    });
    const a = await film(app, "A 12 second YouTube explainer for my scheduling software, so teams stop going back and forth over calendar invites.", "saas");
    const b = await film(app, "A 12 second YouTube ad for my small coffee roaster, beans roasted weekly.", "coffee");
    for (const f of [a, b]) expect(f.scenes.every((s) => s.visual.block === "composition")).toBe(true);
    // the layouts the Director composed differ ...
    const layout = (f: typeof a) => f.scenes.map((s) => s.visual.elements.map((e) => e.id).join(","));
    expect(layout(a)).not.toEqual(layout(b));
    // ... and so do the rendered pictures, in the opening, the middle and the close
    const diffs = [1.5, 5, 10.5].map((t) => difference(frame(a.file, t), frame(b.file, t)));
    const proof = process.env["COMPOSE_PROOF_DIR"];
    if (proof) for (const [name, f] of [["saas", a.file], ["coffee", b.file]] as const) for (const at of [1.5, 5, 10.5]) writeFileSync(join(proof, `${name}-${at}s.png`), execFileSync("ffmpeg", ["-v", "error", "-ss", String(at), "-i", f, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], { maxBuffer: 1 << 24 }));
    console.log("frame differences (0 = identical, 1 = opposite):", diffs.map((d) => d.toFixed(3)).join(", "));
    expect(diffs.filter((d) => d > 0.02).length).toBeGreaterThanOrEqual(2);
  });
});