import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Asset, Project } from "@digikon/contracts";
import { ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, runEditor, type DirectorStateType } from "@digikon/director";
import { probeFile } from "@digikon/media";
import { cfg, deps, knowledge, root } from "../../director/src/fixtures.js";
import { AdapterRegistry, createFfmpegAdapter, loadCapabilityRegistry, planAssembly, renderAssembly, type AssembleDeps } from "./index.js";
import { realPrerequisites, skipReal } from "./test-env.js";

vi.setConfig({ testTimeout: 300_000 });
const FONTS = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];
const font = FONTS.find((f) => existsSync(f));
const can = !!font;
realPrerequisites({ font: !!font });
const tmp = mkdtempSync(join(tmpdir(), "matchcut-"));
const outputRoot = join(tmp, "out"), workRoot = join(tmp, "work");
mkdirSync(outputRoot); mkdirSync(workRoot);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "ignore" });

const ready = { status: "ready", questions: [] };
const sc = (id: string, text: string, transition: string, asset: string) => ({
  scene_id: id, purpose: "p", duration_seconds: 3, asset_ids: [asset], required_assets: [{ need: "A supplied picture", kind: "image", availability: "supplied", asset_id: asset }], transition_out: transition,
  shot: { shot_size: "wide", camera_motion: "static", visual_action: "A picture with a caption" }, overlay: { text, safe_area: "platform_safe" },
});
const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, number | string> = {}) => ({ use_id: `U${String(n).padStart(2, "0")}`, scene_id, recipe_id, params, rationale: "fits the beat" });
const SETTINGS = { aspect_ratio: "16:9", width: 640, height: 360, fps: 30, duration_s: 6, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test fixture values, not a platform specification" } };

async function directed(id: string, assets: Asset[], second: string) {
  const scenes = [sc("S01", "Before", "match_cut", assets[0]!.asset_id), sc("S02", "After", "cut", second)];
  const uses = [use(1, "S01", "image-scene"), use(2, "S01", "match-cut"), use(3, "S02", "image-scene")];
  const d = deps(new ScriptedClient([ready, { logline: "Two pictures", hook: "A picture", tone: "calm", beats: [{ beat: "One", purpose: "p", approx_seconds: 3 }, { beat: "Two", purpose: "p", approx_seconds: 3 }], cta: "More", claims: [] }, { scenes }, { uses }]));
  const graph = buildDirectorGraph(d);
  const project = Project.parse({ project_id: id, owner_id: "u1", brief: "Two pictures.", objective: "Inform", audience: "General", platform: "YouTube", aspect_ratio: "16:9", target_duration: 6 });
  const g1 = await graph.invoke({ project, assets, facts: [] }, cfg(id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(id))) as DirectorStateType;
  const handoff = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: id, model: "scripted" });
  const run = await runEditor(handoff, { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever });
  if (!run.ok) throw new Error(`editor rejected: ${run.reasons.join("; ")}`);
  return { handoff, output: run.output, recipes: d.recipes };
}
type Run = Awaited<ReturnType<typeof directed>>;
let same: Run, different: Run;
beforeAll(async () => {
  const mk = async (name: string, src: string[], id: string) => { const p = join(tmp, name); ff(...src, "-frames:v", "1", p); const a = await probeFile(p, { assetId: id }); if (!a.ok) throw new Error("test image rejected"); return a.asset; };
  const a1 = await mk("a.png", ["-f", "lavfi", "-i", "testsrc2=s=1280x720:d=1:r=1"], "asset_00000001");
  const a2 = await mk("b.png", ["-f", "lavfi", "-i", "color=c=0xf4efe6:s=1280x720:d=1:r=1"], "asset_00000002");
  same = await directed("mc-same", [a1], "asset_00000001");
  different = await directed("mc-different", [a1, a2], "asset_00000002");
}, 240_000);

const depsFor = (r: Run): AssembleDeps => {
  const reg = loadCapabilityRegistry(join(tmp, "no-caps"), { recipes: r.recipes });
  return { recipes: r.recipes, adapters: new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot })]), capabilities: reg, outputRoot, fontFile: font!, workRoot };
};
const input = (r: Run) => ({ editor_output: r.output, handoff: r.handoff, settings: SETTINGS, purpose: "preview" as const });

describe.skipIf(skipReal(can))("a match cut is applied only when the two pictures really match", () => {
  it("is planned as an assembler join that is checked on the finished clips, and is registered (not 'unavailable')", () => {
    const p = planAssembly(input(same), depsFor(same));
    if (!p.ok) throw new Error(p.reasons.join("; "));
    expect(p.plan.transitions.map((t) => [t.after_scene, t.template, t.kind, t.applied, t.frames])).toEqual([["S01", "ffmpeg/match-cut", "match", true, 0]]);
    const op = p.plan.scenes[0]!.operations.find((o) => o.template === "ffmpeg/match-cut")!;
    expect(op.readiness).toMatchObject({ registered: true, missing: null, validated_in_final: null });
    expect(p.plan.scenes[0]!.unmet).toEqual([]);
  });

  it("is not claimed for a scene that fades in from nothing, even when it shows the same picture: there is no first picture to match", async () => {
    const p = planAssembly(input(same), depsFor(same));
    if (!p.ok) throw new Error(p.reasons.join("; "));
    const r = await renderAssembly(p.plan, depsFor(same));
    if (r.kind === "failed") throw new Error(r.errors.join("; "));
    expect(r.report.transitions).toMatchObject([{ after_scene: "S01", template: "ffmpeg/match-cut", status: "omitted" }]);
    expect(r.report.transitions[0]!.check).toMatch(/first picture of the next scene is empty/);
    expect(r.report.scenes[0]!.unmet.join(" ")).toMatch(/its transition \(E02\) is not applied/);
    expect(r.report.output).toMatchObject({ frames: 180, duration_s: 6, width: 640, height: 360, fps: 30 }); // scene lengths and total duration are exactly as approved
    expect(r.report.decision!.complete).toBe(false);
  });
  it("is reported as missing, and the preview as incomplete, when the pictures do not match", async () => {
    const p = planAssembly(input(different), depsFor(different));
    if (!p.ok) throw new Error(p.reasons.join("; "));
    expect(p.plan.transitions[0]!.applied).toBe(true); // provisional: it cannot be known before the clips exist
    const r = await renderAssembly(p.plan, depsFor(different));
    if (r.kind === "failed") throw new Error(r.errors.join("; "));
    expect(r.kind).toBe("partial");
    expect(r.report.transitions).toMatchObject([{ after_scene: "S01", status: "omitted" }]);
    expect(r.report.transitions[0]!.reason).toMatch(/do not match, so this join is not a match cut/);
    expect(r.report.omitted_operations.map((o) => o.recipe_id)).toEqual(["ffmpeg/match-cut"]);
    expect(r.report.decision).toMatchObject({ status: "incomplete_preview", complete: false, final: false, file_valid: true });
    expect(r.report.decision!.blockers.join(" ")).toMatch(/match-cut transition after S01 was not applied/);
    expect(r.report.states.final_delivery_ready).toBe(false);
    // the video still exists and has the approved length: a hard join stands in, and is labelled as such
    expect(r.report.output).toMatchObject({ frames: 180, duration_s: 6 });
  });
});
