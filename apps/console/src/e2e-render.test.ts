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
import { detectAudio, findChrome, findRemotionBrowser } from "@digikon/render";
import type { SpeechEngine } from "@digikon/speech";
import { createApp } from "./app.js";
import { realPrerequisites, skipReal } from "../../../packages/render/src/test-env.js";

// The whole path with the stub model and the real engines: brief -> Gate 1 -> Gate 2 -> Editor -> a real render with narration and a sound effect. The model is the stub
// (no Claude is called); everything after it is real: Remotion, FFmpeg, the speech synthesiser, the checks. The film is a COMPLETE PREVIEW, never final delivery, while recipes are drafts.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const recipes = loadRecipes(join(repo, "recipes"));
const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
const chrome = findChrome(), browser = findRemotionBrowser();
const audio = detectAudio();
const can = !!font && !!chrome && !!browser && !!audio.tts;
realPrerequisites({ font: !!font, "a Chrome for HyperFrames": !!chrome, "a 64-bit Edge or Chrome for Remotion": !!browser, "a speech synthesiser": !!audio.tts });
vi.setConfig({ testTimeout: 400_000 });
const dir = mkdtempSync(join(tmpdir(), "console-e2e-"));
const caps = join(dir, "capabilities");
if (can) cpSync(join(repo, "capabilities"), caps, { recursive: true }); // a copy: a render may record what it learned
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const speech: SpeechEngine = { model: "stub", transcribe: async () => Transcript.parse({ text: "x", language: "en", language_confidence: 1, model: "stub", duration_s: 1, words: [], segments: [] }) };
const json = (b: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const body = async (r: Response) => (await r.json()) as any;

describe.skipIf(skipReal(can))("a whole video through the console with the stub model and real engines", () => {
  it("renders a complete preview with a picture, narration and a chime, after both approvals", async () => {
    const app = createApp({
      llm: new DemoClient({ creative: true }), demo: true, speech, whisper: () => ({ state: "ready" }), skills: new SkillLibrary(join(repo, "skills")), editorSkills: new SkillLibrary(join(repo, "skills/editor")),
      retriever: new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge"))]),
      recipes: new RecipeLibrary(recipes, "draft"), ffmpegOk: true, renderFont: font, storageDir: dir, publicDir: join(repo, "apps/console/public"), capabilitiesDir: caps, audio,
    });
    const id = (await body(await app.request("/api/sessions", { method: "POST" }))).id as string;
    await app.request(`/api/sessions/${id}/route`, json({ text: "A 12 second YouTube explainer for my online course, with a voiceover and a soft chime." }));
    await (await app.request(`/api/sessions/${id}/direct`, json({ facts: ["Courses are self-paced.", "New lessons every week."] }))).text();

    const early = await app.request(`/api/sessions/${id}/render`, json({ settings: { aspect_ratio: "16:9", width: 1280, height: 720, fps: 30, duration_s: 12, container: "mp4", video_codec: "h264", audio_codec: "aac" } }));
    expect(early.status, "the render is refused before the approvals").toBe(409);

    const g1 = await app.request(`/api/sessions/${id}/approve`, json({ stage: "storyboard", plan_version: 1, decision: "approved" }));
    expect((await body(g1)).state.gate).toBe("edit_plan");
    const g2 = await app.request(`/api/sessions/${id}/approve`, json({ stage: "edit_plan", plan_version: 1, decision: "approved", storyboard_version: 1 }));
    expect((await body(g2)).state.status).toBe("approved");
    expect((await app.request(`/api/sessions/${id}/editor`, { method: "POST" })).status).toBe(200);
    const settings = { aspect_ratio: "16:9", width: 1280, height: 720, fps: 30, duration_s: 12, container: "mp4", video_codec: "h264", audio_codec: "aac" };
    const res = await app.request(`/api/sessions/${id}/render`, json({ settings }));
    const r = await body(res);
    expect(res.status, JSON.stringify(r).slice(0, 600)).toBe(200);
    expect(r.kind).toBe("complete");
    expect(r.delivery.states).toMatchObject({ scenes_total: 3, scenes_rendered: 3, scenes_content_validated: 3, final_video_validated: true, final_delivery_ready: false });
    expect(r.delivery.decision).toMatchObject({ status: "complete_preview", final: false, complete: true, file_valid: true });
    expect(r.delivery.label).toContain("not final delivery");
    // the file itself: h264 picture, aac sound, the approved size and length
    const out = (await app.request(r.delivery.output.video_url)); expect(out.status).toBe(200);
    const file = join(dir, "e2e-out.mp4"); writeFileSync(file, Buffer.from(await out.arrayBuffer()));
    const streams = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", file]).toString()).streams as { codec_type: string; codec_name: string; width?: number }[];
    expect(streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort()).toEqual(["audio:aac", "video:h264"]);
    expect(streams.find((s) => s.codec_type === "video")!.width).toBe(1280);
    // generated sound is labelled as generated
    expect(JSON.stringify(r.delivery)).toMatch(/speech synthesiser|synthesised on this computer/);
  });
});