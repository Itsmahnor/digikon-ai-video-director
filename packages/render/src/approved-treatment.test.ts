import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Project } from "@digikon/contracts";
import { ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, runEditor, type DirectorStateType } from "@digikon/director";
import { cfg, deps, knowledge, root } from "../../director/src/fixtures.js";
import { AdapterRegistry, createFfmpegAdapter, createHyperframesAdapter, createRemotionAdapter, findChrome, findRemotionBrowser, loadCapabilityRegistry, planAssembly, renderAssembly, type AssembleDeps } from "./index.js";
import { realPrerequisites, skipReal } from "./test-env.js";

vi.setConfig({ testTimeout: 600_000 });

/**
 * The failing run, end to end: a four-scene 9:16 film whose approved copy for S03 and S04 has a line break. S01 and S02 are the flat-colour text
 * cards the approved edit plan asked for (FFmpeg), S03 is text-slide-remotion, S04 is end-card-cta, with hard cuts between them. Every scene must
 * be rendered by the engine its recipe names, the film must be complete, and the text of every scene must really be in its frames.
 */
const FONTS = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];
const font = FONTS.find((f) => existsSync(f));
const chrome = findChrome(), browser = findRemotionBrowser();
const can = !!font && !!chrome && !!browser;
realPrerequisites({ font: !!font, "a Chrome for HyperFrames": !!chrome, "a 64-bit Edge or Chrome for Remotion": !!browser });
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "treatment-"));
const outputRoot = join(tmp, "out"), workRoot = join(tmp, "work");
mkdirSync(outputRoot); mkdirSync(workRoot);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const proofDir = process.env["RENDER_PROOF_DIR"];

const ready = { status: "ready", questions: [] };
const gfx = [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }];
const TEXTS = ["Class too fast?", "Too slow?", "Learn at your pace.\nFast day? Slow day? Your call.", "Learn at your pace.\nFind out more."];
const DURS = [3, 3, 5, 4];
const scenes = TEXTS.map((text, i) => ({ scene_id: `S0${i + 1}`, purpose: "p", duration_seconds: DURS[i]!, asset_ids: [], required_assets: gfx, transition_out: "cut", shot: { shot_size: "wide", camera_motion: "static", visual_action: "Huge text on a flat colour" }, overlay: { text, safe_area: "platform_safe" } }));
const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, number | string> = {}) => ({ use_id: `U${String(n).padStart(2, "0")}`, scene_id, recipe_id, params, rationale: "fits the beat" });
const uses = [
  use(1, "S01", "text-card-fade", { fade_in_s: 0.3, background: "navy" }), use(2, "S01", "hard-cut"),
  use(3, "S02", "text-card-fade", { fade_in_s: 0.3, background: "charcoal" }), use(4, "S02", "hard-cut"),
  use(5, "S03", "text-slide-remotion", { fade_in_s: 0.5, background: "forest", accent: "teal" }), use(6, "S03", "hard-cut"),
  use(7, "S04", "end-card-cta", { hold_s: 3.5, background: "dark" }),
];
const settingsFor = (aspect: "16:9" | "9:16", w: number, h: number) => ({ aspect_ratio: aspect, width: w, height: h, fps: 30, duration_s: 15, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test fixture values, not a platform specification" } });
const SETTINGS = settingsFor("16:9", 1280, 720);

type Run = { handoff: ReturnType<typeof buildHandoff>; output: Awaited<ReturnType<typeof runEditor>> extends infer R ? (R extends { ok: true; output: infer O } ? O : never) : never; recipes: ReturnType<typeof deps>["recipes"] };
async function direct(id: string, aspect: "16:9" | "9:16"): Promise<Run> {
  const d = deps(new ScriptedClient([ready, { logline: "Learn at your pace", hook: "Class too fast?", tone: "friendly", beats: DURS.map((s, i) => ({ beat: `Beat ${i + 1}`, purpose: "p", approx_seconds: s })), cta: "Find out more", claims: [] }, { scenes }, { uses }]));
  const graph = buildDirectorGraph(d);
  const project = Project.parse({ project_id: id, owner_id: "u1", brief: "A 15 second explainer: flat colour backgrounds with large text, no audio.", objective: "Inform", audience: "Students", platform: aspect === "16:9" ? "YouTube" : "Instagram Reels", aspect_ratio: aspect, target_duration: 15 });
  const g1 = await graph.invoke({ project, assets: [], facts: [] }, cfg(id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(id))) as DirectorStateType;
  const handoff = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: id, model: "scripted" });
  const ed = await runEditor(handoff, { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever });
  if (!ed.ok) throw new Error(`editor rejected: ${ed.reasons.join("; ")}`);
  return { handoff, output: ed.output as never, recipes: d.recipes };
}
let run: Run, portrait: Run;
beforeAll(async () => { run = await direct("treat1", "16:9"); portrait = await direct("treat2", "9:16"); }, 180_000);

describe.skipIf(skipReal(can))("the approved visual treatment is rendered, scene by scene, by the engines the edit plan named", () => {
  it("renders a complete preview: every scene by its own engine, with its real text in its real frames", async () => {
    const reg = loadCapabilityRegistry(join(repoRoot, "capabilities"), { recipes: run.recipes });
    const adapters = new AdapterRegistry([
      createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.transitions("ffmpeg") }),
      createRemotionAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.composed("remotion") }),
      createHyperframesAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.composed("hyperframes") }),
    ]);
    const assembleDeps: AssembleDeps = { recipes: run.recipes, adapters, capabilities: reg, outputRoot, fontFile: font!, workRoot };
    const p = planAssembly({ editor_output: run.output, handoff: run.handoff, settings: SETTINGS, purpose: "preview" }, assembleDeps);
    if (!p.ok) throw new Error(p.reasons.join("; "));
    expect(p.plan.scenes.map((s) => [s.scene_id, s.engine, s.renderable, s.reason ?? s.unmet.join("; ")]), "plan").toEqual([["S01", "ffmpeg", true, ""], ["S02", "ffmpeg", true, ""], ["S03", "remotion", true, ""], ["S04", "remotion", true, ""]]);
    expect(p.plan.complete).toBe(true);

    const result = await renderAssembly(p.plan, assembleDeps);
    if (result.kind === "failed") throw new Error(result.errors.join("; "));
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    const report = result.report;
    expect(report.kind).toBe("complete");
    expect(report.states).toMatchObject({ scenes_total: 4, scenes_rendered: 4, scenes_content_validated: 4, final_video_validated: true, final_delivery_ready: false }); // never final while recipes are drafts
    expect(report.omitted_operations).toEqual([]);
    expect(report.final_delivery_blockers.join(" ")).toContain("draft");
    expect(report.scenes.map((s) => s.engine)).toEqual(["ffmpeg", "ffmpeg", "remotion", "remotion"]);

    const video = report.output!.path;
    if (proofDir) { mkdirSync(proofDir, { recursive: true }); copyFileSync(video, join(proofDir, "approved-treatment.mp4")); }
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,width,height,r_frame_rate,codec_name,duration", "-of", "json", video], { encoding: "utf8" })).streams[0];
    expect(probe).toMatchObject({ width: 1280, height: 720, r_frame_rate: "30/1", codec_name: "h264", nb_read_frames: "450" });
    expect(Number(probe.duration)).toBeCloseTo(15, 1);
    expect(report.output).toMatchObject({ width: 1280, height: 720, fps: 30, frames: 450 });

    // text really present in the frames: bands of bright text rows near the middle of each scene
    const bands = (n: number) => {
      const b = execFileSync("ffmpeg", ["-v", "error", "-i", video, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 27 });
      const out: [number, number][] = [];
      for (let y = 0; y < 720; y++) {
        let hit = false;
        for (let x = 0; x < 1280 && !hit; x++) { const i = (y * 1280 + x) * 3; if (b[i]! > 215 && b[i + 1]! > 215 && b[i + 2]! > 215) hit = true; }
        if (hit) { const last = out[out.length - 1]; if (last && y - last[1] <= 4) last[1] = y; else out.push([y, y]); }
      }
      return out;
    };
    const mid = (from: number, dur: number) => Math.round((from + dur * 0.7) * 30);
    expect(bands(mid(0, 3)).length, "S01 text").toBeGreaterThanOrEqual(1);
    expect(bands(mid(3, 3)).length, "S02 text").toBeGreaterThanOrEqual(1);
    expect(bands(mid(6, 5)).length, "S03 text: two approved lines").toBeGreaterThanOrEqual(2);
    expect(bands(mid(11, 4)).length, "S04 text: two approved lines").toBeGreaterThanOrEqual(2);
  });

  it("the same copy at 9:16 is refused for what it is (it does not fit), never as a control character, and the film is labelled incomplete", () => {
    const reg = loadCapabilityRegistry(join(repoRoot, "capabilities"), { recipes: portrait.recipes });
    const adapters = new AdapterRegistry([
      createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.transitions("ffmpeg") }),
      createRemotionAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.composed("remotion") }),
    ]);
    const p = planAssembly({ editor_output: portrait.output, handoff: portrait.handoff, settings: settingsFor("9:16", 360, 640), purpose: "preview" }, { recipes: portrait.recipes, adapters, capabilities: reg, outputRoot, fontFile: font!, workRoot });
    if (!p.ok) throw new Error(p.reasons.join("; "));
    const why = p.plan.scenes.filter((s) => !s.renderable).map((s) => `${s.scene_id}: ${s.reason ?? s.unmet.join("; ")}`).join(" | ");
    expect(why).not.toContain("control characters");
    expect(why).toContain("does not fit");
    expect(p.plan.complete).toBe(false);
    expect(p.plan.scenes.filter((s) => s.renderable).map((s) => s.scene_id)).toEqual(["S01", "S02"]);
  });
});
