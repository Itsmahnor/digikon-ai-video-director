import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Project, type ArtDirection } from "@digikon/contracts";
import { ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, runEditor, type DirectorStateType } from "@digikon/director";
import { cfg, deps, knowledge, root } from "../../director/src/fixtures.js";
import { AdapterRegistry, EXAMPLE_ART_DIRECTION, assemblyBlockers, createFfmpegAdapter, createRemotionAdapter, findRemotionBrowser, loadCapabilityRegistry, planAssembly, planRender, renderAssembly, type AssembleDeps } from "./index.js";
import { realPrerequisites, skipReal } from "./test-env.js";

vi.setConfig({ testTimeout: 600_000 });

/**
 * The GoHighLevel run. Its stored plan: four scenes, each `scene-composition`, with a crossfade after S01 and S02 and a dip to black after S03. The report said S01 to S03 each had two
 * composition operations, that Remotion and FFmpeg could not be combined, and that both transitions would become hard cuts, while assembly was making the film correctly. Those lines came
 * from asking one adapter about the whole film. They are true of that question and false of the film, so the report must speak for the film.
 */
const FONTS = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];
const font = FONTS.find((f) => existsSync(f));
const browser = findRemotionBrowser();
const can = !!font && !!browser;
realPrerequisites({ font: !!font, "a 64-bit Edge or Chrome for Remotion": !!browser });
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "ghl-"));
const outputRoot = join(tmp, "out"), workRoot = join(tmp, "work");
mkdirSync(outputRoot); mkdirSync(workRoot);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ART: ArtDirection = { ...EXAMPLE_ART_DIRECTION, palette: { background: "#fff0f6", surface: "#ffffff", text: "#3a0d2a", muted: "#7a4a66", accent: "#c2185b", accent_2: "#7b1fa2" } };
const gfx = [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }];
const base = (id: string, seconds: number, transition_out: string, visual: unknown, overlay: string | null, visual_purpose: string, extra: Record<string, unknown> = {}) => ({ scene_id: id, purpose: "p", duration_seconds: seconds, asset_ids: [], required_assets: gfx, transition_out, shot: { shot_size: "wide", camera_motion: "static", visual_action: "Drawn scene" }, overlay: overlay ? { text: overlay, safe_area: "platform_safe" } : null, visual, visual_purpose, ...extra });
const common = { camera: "static", reveal: "none", backdrop: "flat" };
const scenes = (extra: Record<string, unknown> = {}) => [
  base("S01", 3, "crossfade", { block: "message_thread", mode: "pile_up", messages: [{ from: "them", text: "Any update on my quote?" }, { from: "you", text: "Sorry, which tab was that?" }, { from: "them", text: "Hello?" }], ...common }, "Too many tabs. Too many follow-ups?", "The problem as a thread piling up", extra),
  base("S02", 3, "crossfade", { block: "ui_demo", window_title: "Workspace", sidebar: ["Inbox", "Pipeline"], rows: [{ label: "New enquiry", tag: "Open", state: "open" }, { label: "Booked call", tag: "Next", state: "selected" }], cursor_target: 1, confirm_text: null, ...common }, "Meet GoHighLevel", "One tidy workspace, as a concept"),
  base("S03", 3, "dip_to_black", { block: "kinetic_type", style: "word_pop", emphasis_word: 1, ...common }, "Imagine less juggling and more growing.", "The sentence is the idea"),
  base("S04", 3, "cut", { block: "end_card", wordmark: "GoHighLevel", button: "Take a look", subline: null, ...common }, "Ready to take a look?", "One action, held still"),
];
const use = (n: number, scene_id: string, recipe_id: string) => ({ use_id: `U${String(n).padStart(2, "0")}`, scene_id, recipe_id, params: {}, rationale: "fits the beat" });
const USES = [use(1, "S01", "scene-composition"), use(2, "S01", "crossfade"), use(3, "S02", "scene-composition"), use(4, "S02", "crossfade"), use(5, "S03", "scene-composition"), use(6, "S03", "dip-to-black"), use(7, "S04", "scene-composition")];
const SETTINGS = { aspect_ratio: "9:16", width: 540, height: 960, fps: 30, duration_s: 12, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test fixture values, not a platform specification" } };

async function direct(id: string, sc: unknown[], editorDeps: { audio_production?: boolean } = {}) {
  const d = deps(new ScriptedClient([{ status: "ready", questions: [] }, { logline: "One calm place", hook: "Too many tabs", tone: "friendly", beats: [3, 3, 3, 3].map((s, i) => ({ beat: `Beat ${i + 1}`, purpose: "p", approx_seconds: s })), cta: "Take a look", claims: [], art_direction: ART }, { scenes: sc }, { uses: USES }]));
  const graph = buildDirectorGraph(d);
  const project = Project.parse({ project_id: id, owner_id: "u1", brief: "A video on the benefits of GoHighLevel in a pink theme for Instagram.", objective: "Inform", audience: "Small business owners", platform: "Instagram", aspect_ratio: "9:16", target_duration: 12 });
  const g1 = await graph.invoke({ project, assets: [], facts: [] }, cfg(id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(id))) as DirectorStateType;
  if (!done.editPlan) throw new Error(`the plan did not reach approval: ${JSON.stringify(done.escalation)}`);
  const handoff = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: id, model: "scripted" });
  const ed = await runEditor(handoff, { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever, ...editorDeps });
  if (!ed.ok) throw new Error(`editor rejected: ${ed.reasons.join("; ")}`);
  return { handoff, output: ed.output, recipes: d.recipes };
}
const kit = (recipes: Parameters<typeof loadCapabilityRegistry>[1] extends infer O ? (O extends { recipes?: infer R } ? R : never) : never) => {
  const reg = loadCapabilityRegistry(join(repoRoot, "capabilities"), { recipes });
  const adapters = new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.transitions("ffmpeg") }), createRemotionAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.composed("remotion") })]);
  return { reg, adapters };
};

type Run = Awaited<ReturnType<typeof direct>>;
let run: Run;
beforeAll(async () => { run = await direct("ghl1", scenes()); }, 180_000);

describe.skipIf(skipReal(can))("the GoHighLevel plan is one film made by two engines, and is reported as that", () => {
  it("the operations are what the plan needs: one composition per scene, and transitions that are joins", () => {
    const ops = run.output.operations;
    for (const s of ["S01", "S02", "S03"]) {
      expect(ops.filter((o) => o.target_scene_id === s && o.operation_type === "render_graphics_scene")).toHaveLength(1);
      expect(ops.filter((o) => o.target_scene_id === s && o.operation_type === "concat")).toHaveLength(1);
    }
  });

  it("what one adapter could not do alone is kept apart from what stops the film", () => {
    const { reg, adapters } = kit(run.recipes);
    const single = planRender({ editor_output: run.output, handoff: run.handoff, settings: SETTINGS, purpose: "preview" }, { recipes: run.recipes, adapters, capabilities: reg, outputRoot });
    if (!single.ok) throw new Error(single.reasons.join("; "));
    const text = single.single_run_blockers.join(" | ");
    expect(text).toContain("more than one renderer");
    expect(text).toContain("composition operations");
    expect(text).toContain("cannot be combined");
    expect(text).toContain("crossfade transition is not rendered");
  });

  it("assembly plans every scene and every transition, with nothing left to report", () => {
    const { reg, adapters } = kit(run.recipes);
    const p = planAssembly({ editor_output: run.output, handoff: run.handoff, settings: SETTINGS, purpose: "preview" }, { recipes: run.recipes, adapters, capabilities: reg, outputRoot, fontFile: font!, workRoot });
    if (!p.ok) throw new Error(p.reasons.join("; "));
    expect(p.plan.scenes.map((s) => [s.scene_id, s.engine, s.renderable])).toEqual([["S01", "remotion", true], ["S02", "remotion", true], ["S03", "remotion", true], ["S04", "remotion", true]]);
    expect(p.plan.transitions.map((t) => [t.after_scene, t.template, t.applied])).toEqual([["S01", "ffmpeg/xfade-fade", true], ["S02", "ffmpeg/xfade-fade", true], ["S03", "ffmpeg/xfade-fadeblack", true]]);
    expect(assemblyBlockers(p.plan)).toEqual([]);
    expect(p.plan.coverage.complete).toBe(true); // what the console shows as S01 to S04 fully shown
    expect(p.plan.complete).toBe(true);
  });

  it("the real film carries both transitions, and the preview represents the whole approved plan", async () => {
    const { reg, adapters } = kit(run.recipes);
    const d: AssembleDeps = { recipes: run.recipes, adapters, capabilities: reg, outputRoot, fontFile: font!, workRoot };
    const p = planAssembly({ editor_output: run.output, handoff: run.handoff, settings: SETTINGS, purpose: "preview" }, d);
    if (!p.ok) throw new Error(p.reasons.join("; "));
    const r = await renderAssembly(p.plan, d);
    if (r.kind === "failed") throw new Error(r.errors.join("; "));
    expect(r.report.transitions.map((t) => [t.status, t.duration_s! > 0])).toEqual([["applied", true], ["applied", true], ["applied", true]]);
    expect(r.report.omitted_operations).toEqual([]);
    expect(r.report.decision?.status).toBe("complete_preview"); // drafts keep it from final delivery, and it says so
    expect(r.report.final_delivery_blockers.join(" ")).toContain("draft");
  });

  it("with an approved music cue and an audio stage, the film has a real sound track", async () => {
    const withSound = await direct("ghl2", scenes({ audio_cues: ["upbeat music bed under the film"] }), { audio_production: true });
    const { reg, adapters } = kit(withSound.recipes);
    const d: AssembleDeps = { recipes: withSound.recipes, adapters, capabilities: reg, outputRoot, fontFile: font!, workRoot, audio: { tts: null } };
    const settings = { ...SETTINGS, audio_codec: "aac" };
    const p = planAssembly({ editor_output: withSound.output, handoff: withSound.handoff, settings, purpose: "preview" }, d);
    if (!p.ok) throw new Error(p.reasons.join("; "));
    expect(p.plan.audio?.unresolved).toEqual([]);
    expect(p.plan.complete).toBe(true);
    const r = await renderAssembly(p.plan, d);
    if (r.kind === "failed") throw new Error(r.errors.join("; "));
    expect(r.report.output?.audio_tracks).toBe(1);
    expect(r.report.audio?.labels.join(" ")).toContain("generated on this computer");
    expect(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", r.report.output!.path], { encoding: "utf8" }).trim()).toBe("aac");
  });
});
