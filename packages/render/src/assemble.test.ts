import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Asset, Project } from "@digikon/contracts";
import { ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, runEditor, type DirectorStateType } from "@digikon/director";
import { probeFile } from "@digikon/media";
import { cfg, deps, knowledge, root } from "../../director/src/fixtures.js";
import {
  AdapterRegistry, DeliveryReport, createFfmpegAdapter, createHyperframesAdapter, createRemotionAdapter, findChrome, findRemotionBrowser, loadCapabilityRegistry, planAssembly, rawFrame, registryDir, renderAssembly,
  runRenderQa, saveDeliveryReport, loadDeliveryReport, type AssembleDeps, type LoadedRegistry, type RenderAdapter,
} from "./index.js";
import { realPrerequisites, skipReal } from "./test-env.js";

vi.setConfig({ testTimeout: 600_000 });
const FONTS = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];
const font = FONTS.find((f) => existsSync(f));
const chrome = findChrome(), browser = findRemotionBrowser();
const can = !!font && !!chrome && !!browser;
realPrerequisites({ font: !!font, "a Chrome for HyperFrames": !!chrome, "a 64-bit Edge or Chrome for Remotion": !!browser });
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "assemble-"));
const outputRoot = join(tmp, "out"), workRoot = join(tmp, "work");
mkdirSync(outputRoot); mkdirSync(workRoot);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const proofDir = process.env["RENDER_PROOF_DIR"];
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "ignore" });
const library = deps(new ScriptedClient([])).recipes;

// ---- a four-scene film that needs all three engines: FFmpeg, Remotion (a camera move with an animated caption) and HyperFrames ----
const ready = { status: "ready", questions: [] };
const sc = (id: string, text: string, transition: string, over: { motion?: string; assets?: string[]; required?: unknown[] } = {}) => ({
  scene_id: id, purpose: "p", duration_seconds: 3, asset_ids: over.assets ?? [], required_assets: over.required ?? [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }], transition_out: transition,
  shot: { shot_size: "wide", camera_motion: over.motion ?? "static", visual_action: "Text and pictures" }, overlay: { text, safe_area: "platform_safe" },
});
const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, number | string> = {}) => ({ use_id: `U${String(n).padStart(2, "0")}`, scene_id, recipe_id, params, rationale: "fits the beat" });
const SETTINGS = { aspect_ratio: "16:9", width: 640, height: 360, fps: 30, duration_s: 12, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test fixture values, not a platform specification" } };

async function directed(id: string, scenes: unknown[], uses: unknown[], assets: Asset[]) {
  const d = deps(new ScriptedClient([ready, { logline: "A short, clear film", hook: "The opening line", tone: "friendly", beats: (scenes as unknown[]).map((_, i) => ({ beat: `Beat ${i + 1}`, purpose: "p", approx_seconds: 3 })), cta: "Learn more", claims: [] }, { scenes }, { uses }]));
  const graph = buildDirectorGraph(d);
  const project = Project.parse({ project_id: id, owner_id: "u1", brief: "A short test film.", objective: "Inform the audience", audience: "General", platform: "YouTube", aspect_ratio: "16:9", target_duration: 12 });
  const g1 = await graph.invoke({ project, assets, facts: [] }, cfg(id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(id))) as DirectorStateType;
  const handoff = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: id, model: "scripted" });
  const run = await runEditor(handoff, { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever });
  if (!run.ok) throw new Error(`editor rejected: ${run.reasons.join("; ")}`);
  return { handoff, output: run.output, recipes: d.recipes };
}
type Run = Awaited<ReturnType<typeof directed>>;
let mixed: Run, withAudio: Run;
beforeAll(async () => {
  const p = join(tmp, "pic.png"); ff("-f", "lavfi", "-i", "testsrc2=s=1280x720:d=1:r=1", "-frames:v", "1", p);
  const a = await probeFile(p, { assetId: "asset_00000001" });
  if (!a.ok) throw new Error("test image rejected");
  const pic = [{ need: "A supplied picture", kind: "image", availability: "supplied", asset_id: "asset_00000001" }];
  const scenes = (audioInLast: boolean) => [
    sc("S01", "Welcome", "dip_to_black"), sc("S02", "Your clients, in one place.", "crossfade", { motion: "slow_push_in", assets: ["asset_00000001"], required: pic }), sc("S03", "Third scene", "wipe"),
    // loudness-normalise is only plannable when the storyboard asks for audio, so the audio variant carries an approved cue
    { ...sc("S04", audioInLast ? "Thanks for watching" : "Thanks", "cut"), ...(audioInLast ? { audio_cues: ["Soft closing chime"] } : {}) },
  ];
  const uses = (audioInLast: boolean) => [
    use(1, "S01", "text-card-fade"), use(2, "S01", "dip-to-black", { duration_s: 0.6 }),
    use(3, "S02", "slow-push-in", { scale_end: 1.15 }), use(4, "S02", "text-fade-up", { delay_s: 0.6, duration_s: 0.6, distance_px: 24 }), use(5, "S02", "crossfade", { duration_s: 0.5 }),
    use(6, "S03", "text-fade-hyperframes"), use(7, "S03", "directional-wipe", { direction: "left", duration_s: 0.5 }),
    use(8, "S04", "text-card-fade", { background: "forest" }), ...(audioInLast ? [use(9, "S04", "loudness-normalise")] : []),
  ];
  mixed = await directed("asm-mixed", scenes(false), uses(false), [a.asset]);
  withAudio = await directed("asm-audio", scenes(true), uses(true), [a.asset]);
}, 240_000);

const repoCaps = () => join(repoRoot, "capabilities");
const adaptersFor = (reg: LoadedRegistry) => new AdapterRegistry([
  createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.transitions("ffmpeg") }),
  createRemotionAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.composed("remotion") }),
  createHyperframesAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.composed("hyperframes") }),
]);
const depsFor = (r: Run, reg: LoadedRegistry, adapters: AdapterRegistry = adaptersFor(reg)): AssembleDeps => ({ recipes: r.recipes, adapters, capabilities: reg, outputRoot, fontFile: font!, workRoot });
const inputFor = (r: Run, over: Record<string, unknown> = {}) => ({ editor_output: r.output, handoff: r.handoff, settings: SETTINGS, purpose: "preview" as const, ...over });
const frame = (video: string, n: number) => rawFrame(video, n, 640, 360, "ffmpeg");
const near = (a: Buffer, c: number[], tol = 14) => [0, 1, 2].every((i) => Math.abs(a[i]! - c[i]!) <= tol);

describe.skipIf(skipReal(can))("a film that needs FFmpeg, Remotion and HyperFrames is rendered scene by scene and assembled", () => {
  let reg: LoadedRegistry;
  beforeAll(() => { reg = loadCapabilityRegistry(repoCaps(), { recipes: library }); });

  it("plans one engine per scene, applies all three approved transitions, and finds nothing missing", () => {
    const p = planAssembly(inputFor(mixed), depsFor(mixed, reg));
    if (!p.ok) throw new Error(p.reasons.join("; "));
    expect(p.plan.scenes.map((s) => [s.scene_id, s.engine, s.renderable, s.unmet])).toEqual([["S01", "ffmpeg", true, []], ["S02", "remotion", true, []], ["S03", "hyperframes", true, []], ["S04", "ffmpeg", true, []]]);
    expect(p.plan.transitions.map((t) => [t.after_scene, t.template, t.applied])).toEqual([["S01", "ffmpeg/xfade-fadeblack", true], ["S02", "ffmpeg/xfade-fade", true], ["S03", "ffmpeg/xfade-wipe", true]]);
    expect(p.plan.omitted).toEqual([]);
    expect(p.plan.complete).toBe(true);
    // the ordinary single-engine planner would have refused this plan
    expect(p.plan.base.record.blockers.join(" ")).toContain("the operations need more than one renderer");
  });

  let result: Awaited<ReturnType<typeof renderAssembly>>;
  it("renders every scene through its own engine and assembles a film that FFprobe confirms", async () => {
    const p = planAssembly(inputFor(mixed), depsFor(mixed, reg));
    if (!p.ok) throw new Error(p.reasons.join("; "));
    result = await renderAssembly(p.plan, depsFor(mixed, reg));
    if (result.kind === "failed") throw new Error(result.errors.join("; "));
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.record).toMatchObject({ state: "rendered", purpose: "preview", output: { container: "mp4", width: 640, height: 360, fps: 30, duration_s: 12, video_codec: "h264", audio_codec: null, audio_tracks: 0 } });
    expect(result.report.output).toMatchObject({ frames: 360, width: 640, height: 360, fps: 30 });
    const ffprobe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,width,height,r_frame_rate,codec_name,pix_fmt", "-of", "json", result.report.output!.path], { encoding: "utf8" })).streams[0];
    expect(ffprobe).toMatchObject({ codec_name: "h264", width: 640, height: 360, r_frame_rate: "30/1", nb_read_frames: "360", pix_fmt: "yuv420p" });
    console.log("MIXED-ENGINE FILM", JSON.stringify({ ...result.report.output, path: "<tmp>" }));
    if (proofDir) { mkdirSync(proofDir, { recursive: true }); copyFileSync(result.report.output!.path, join(proofDir, "mixed-engine-film.mp4")); }
  });

  it("the report keeps every stage apart: rendered, content validated, final video validated, and final delivery NOT ready while recipes are drafts", () => {
    if (result.kind !== "complete") throw new Error("no complete result");
    const r = result.report;
    expect(DeliveryReport.parse(r)).toBeTruthy();
    expect(r.kind).toBe("complete");
    expect(r.states).toMatchObject({ plan_created: true, plan_approved: true, scenes_total: 4, scenes_rendered: 4, scenes_content_validated: 2, final_video_validated: true, final_delivery_ready: false }); // the two FFmpeg scenes are checked for being non-blank only
    expect(r.final_delivery_blockers.join(" ")).toContain("every recipe used is still a draft");
    expect(r.label).toContain("COMPLETE PREVIEW");
    expect(r.label).toContain("not final delivery");
    expect(r.engines_used.sort()).toEqual(["ffmpeg", "hyperframes", "remotion"]);
    expect(r.scenes.map((s) => [s.scene_id, s.engine, s.status])).toEqual([["S01", "ffmpeg", "rendered_unverified"], ["S02", "remotion", "rendered_and_verified"], ["S03", "hyperframes", "rendered_and_verified"], ["S04", "ffmpeg", "rendered_unverified"]]);
    expect(r.scenes.every((s) => s.content.end_to_end_checked && s.content.checks.length >= 3)).toBe(true);
    expect(r.scenes[0]!.content.limitations.join(" ")).toContain("FFmpeg scenes are checked for being non-blank");
    expect(r.transitions.every((t) => t.status === "applied")).toBe(true);
    expect(r.assembly.known_differences.join(" ")).toContain("HyperFrames draws backgrounds up to 3 levels darker");
    expect(r.scenes.map((s) => s.operations.map((o) => o.status))).toEqual([["validated_available", "validated_available"], ["validated_available", "validated_available", "validated_available"], ["validated_available", "validated_available"], ["validated_available"]]);
    const file = saveDeliveryReport(join(tmp, "reports"), r);
    expect(loadDeliveryReport(file)).toEqual(r);
  });
  it("has one authoritative decision, and every other status field is a copy of it", () => {
    if (result.kind !== "complete") throw new Error("no complete result");
    const r = result.report, d = r.decision!;
    expect(d).toMatchObject({ status: "complete_preview", final: false, complete: true, file_valid: true });
    expect(r.kind).toBe("complete");
    expect(r.states.final_delivery_ready).toBe(d.final);
    expect(r.label).toBe(d.label);
    expect(r.final_delivery_blockers).toEqual(d.blockers);
    // a technically valid MP4 is reported, and it does not make the film final, validated or approved
    expect(r.states.final_video_validated).toBe(true);
    expect(d.criteria.map((c) => [c.id, c.ok])).toEqual([["scene_render", true], ["required_operations", true], ["content_validation", false], ["visual_validation", null], ["plan_compliance", true], ["recipe_review", false]]);
    expect(d.blockers.join(" ")).toMatch(/visual validation has not been run/);
  });

  it("checks the frames of every transition and reports what they showed", () => {
    if (result.kind !== "complete") throw new Error("no complete result");
    const t = result.report.transitions;
    expect(t.map((x) => [x.after_scene, x.template, x.status])).toEqual([["S01", "ffmpeg/xfade-fadeblack", "applied"], ["S02", "ffmpeg/xfade-fade", "applied"], ["S03", "ffmpeg/xfade-wipe", "applied"]]);
    expect(t[0]!.check).toMatch(/darkest of 7 sampled frames/);
    expect(t[1]!.check).toMatch(/average of the two pictures/);
    expect(t[2]!.check).toMatch(/still show the first picture/);
  });

  it("keeps the readiness levels apart: registry status is not proof that a scene renders", () => {
    if (result.kind !== "complete") throw new Error("no complete result");
    const ops = result.report.scenes.flatMap((s) => s.operations);
    for (const o of ops) expect(o.readiness, o.operation_id).toBeTruthy();
    const drawn = ops.filter((o) => o.operation_type !== "concat");
    expect(drawn.every((o) => o.readiness!.registered && o.readiness!.compatible_with_scene === true && o.readiness!.rendered_with_scene_inputs === true && o.readiness!.validated_in_final === true && o.readiness!.missing === null)).toBe(true);
    // a built-in template is registered but has not been validated on its own: that is said, not implied by "validated_available"
    expect(drawn.some((o) => o.status === "validated_available" && o.readiness!.validated_in_isolation === false && o.readiness!.validation_basis === "built_in")).toBe(true);
    const transitions = ops.filter((o) => o.operation_type === "concat");
    expect(transitions.every((o) => o.readiness!.registered && o.readiness!.validated_in_final === true)).toBe(true);
  });

  it("the final video really shows each scene: order, exact boundaries, durations, colours, text, camera motion and the three transitions", async () => {
    if (result.kind !== "complete") throw new Error("no complete result");
    const v = result.report.output!.path;
    const NAVY = [22, 33, 62], FOREST = [30, 61, 47];
    // scene boundaries are at frames 90, 180 and 270, and the film keeps its length
    expect(near(await frame(v, 30), NAVY)).toBe(true);        // S01: text-card navy
    expect(near(await frame(v, 270 + 30), FOREST)).toBe(true); // S04: forest
    // S01 ends in a dip to black (0.6 s = 18 frames, 72 to 89): xfade fadeblack is fully black around the first third of the window (measured: frames 75 to 79), not at its exact middle
    const dark = await frame(v, 77), s1 = await frame(v, 30);
    expect((dark[0]! + dark[1]! + dark[2]!) / 3).toBeLessThan((s1[0]! + s1[1]! + s1[2]!) / 3 * 0.5);
    // S02 is a moving picture: the first and last clean frames differ, and its caption is not there before 0.6 s
    const a = await frame(v, 90 + 2), b = await frame(v, 90 + 70);
    let d = 0; for (let i = 0; i < a.length; i += 12) d += Math.abs(a[i]! - b[i]!);
    expect(d / (a.length / 12)).toBeGreaterThan(4);
    // S03 is HyperFrames: its background is the approved navy within the documented tolerance
    expect(near(await frame(v, 180 + 40), [22, 33, 62], 6)).toBe(true);
  });

  it("QA accepts the assembled film (the approved black of the dip is expected)", async () => {
    if (result.kind !== "complete") throw new Error("no complete result");
    const qa = await runRenderQa(result.record, mixed.handoff);
    expect(qa.findings.filter((f) => f.severity !== "info"), JSON.stringify(qa.findings)).toEqual([]);
  });

  it("approvals still gate everything: a changed handoff stops the assembly before any engine runs", () => {
    const tampered = structuredClone(mixed.handoff); tampered.storyboard.scenes[0]!.overlay!.text = "Changed after approval";
    const p = planAssembly(inputFor(mixed, { handoff: tampered }), depsFor(mixed, reg));
    expect(p).toMatchObject({ ok: false, stage: "handoff" });
    expect(planAssembly(inputFor(mixed, { settings: undefined }), depsFor(mixed, reg))).toMatchObject({ ok: false, stage: "settings" });
    expect(planAssembly(inputFor(mixed, { settings: { ...SETTINGS, width: 641 } }), depsFor(mixed, reg)).ok).toBe(false);
  });
});

describe.skipIf(skipReal(can))("one unsupported operation does not stop the other scenes: a clearly labelled partial preview", () => {
  // the registry without the validated text-fade-up, so scene S02 cannot be rendered
  const partialRegistry = () => {
    const dir = join(tmp, "partial-caps"); mkdirSync(join(registryDir(dir), "ffmpeg"), { recursive: true }); mkdirSync(join(registryDir(dir), "remotion"), { recursive: true });
    for (const e of ["ffmpeg", "remotion"]) for (const f of readdirSync(join(registryDir(repoCaps()), e))) if (f !== "remotion__text-fade-up.json") copyFileSync(join(registryDir(repoCaps()), e, f), join(registryDir(dir), e, f));
    return loadCapabilityRegistry(dir, { recipes: library });
  };
  let partial: Awaited<ReturnType<typeof renderAssembly>>;

  it("plans S02 as not renderable with its exact operation and reason, and everything else as renderable", () => {
    const reg = partialRegistry();
    const p = planAssembly(inputFor(mixed), depsFor(mixed, reg));
    if (!p.ok) throw new Error(p.reasons.join("; "));
    expect(p.plan.scenes.map((s) => [s.scene_id, s.renderable])).toEqual([["S01", true], ["S02", false], ["S03", true], ["S04", true]]);
    const s2 = p.plan.scenes[1]!;
    expect(s2.reason).toContain("E04 (text-fade-up) is learning_required");
    expect(s2.operations.find((o) => o.recipe_id === "text-fade-up")).toMatchObject({ status: "learning_required", engine: null });
    expect(p.plan.complete).toBe(false);
    expect(p.plan.omitted.map((o) => o.recipe_id)).toEqual(expect.arrayContaining(["slow-push-in", "text-fade-up"]));
  });

  it("renders the supported scenes, puts a visible placeholder where S02 belongs, and never calls the result complete", async () => {
    const reg = partialRegistry();
    const p = planAssembly(inputFor(mixed), depsFor(mixed, reg));
    if (!p.ok) throw new Error(p.reasons.join("; "));
    partial = await renderAssembly(p.plan, depsFor(mixed, reg));
    if (partial.kind === "failed") throw new Error(partial.errors.join("; "));
    expect(partial.kind).toBe("partial");
    if (partial.kind !== "partial") return;
    const r = partial.report;
    expect(r.kind).toBe("partial");
    expect(r.label).toMatch(/^INCOMPLETE PREVIEW: 1 scene\(s\) were not rendered/);
    expect(r.states).toMatchObject({ scenes_total: 4, scenes_rendered: 3, final_video_validated: true, final_delivery_ready: false });
    expect(r.final_delivery_blockers.join(" ")).toMatch(/S\d\d was not rendered/);
    expect(r.scenes.map((s) => [s.scene_id, s.status])).toEqual([["S01", "rendered_unverified"], ["S02", "placeholder"], ["S03", "rendered_and_verified"], ["S04", "rendered_unverified"]]);
    expect(r.scenes[1]).toMatchObject({ engine: null, omitted_reason: expect.stringContaining("text-fade-up") });
    expect(r.omitted_operations.map((o) => o.operation_id)).toEqual(expect.arrayContaining(["E03", "E04"]));
    expect(r.omitted_operations.every((o) => o.reason.length > 10 && o.scene_id)).toBe(true);
    expect(r.transitions.find((t) => t.after_scene === "S01")).toMatchObject({ status: "omitted" }); // a hard cut into a missing scene, reported
    // the output is a valid film of the approved length, with the placeholder in S02's slot and the supported scenes around it
    expect(r.output).toMatchObject({ frames: 360, duration_s: 12, width: 640, height: 360, fps: 30 });
    const v = r.output!.path;
    expect(near(await frame(v, 90 + 30), [90, 30, 30], 12)).toBe(true); // the placeholder's colour in S02
    expect(near(await frame(v, 30), [22, 33, 62])).toBe(true);        // S01 rendered
    expect(near(await frame(v, 270 + 30), [30, 61, 47])).toBe(true);  // S04 rendered
    console.log("PARTIAL PREVIEW", r.label, JSON.stringify(r.omitted_operations.map((o) => `${o.scene_id}:${o.recipe_id}`)));
    if (proofDir) { mkdirSync(proofDir, { recursive: true }); copyFileSync(v, join(proofDir, "partial-preview.mp4")); }
  });

  it("the partial preview is not a render record, so nothing downstream can treat it as the rendered video", () => {
    if (partial.kind !== "partial") throw new Error("no partial result");
    expect("record" in partial).toBe(false);
  });
});

describe.skipIf(skipReal(can))("requirements this phase cannot produce are reported, never marked complete", () => {
  it("an approved audio operation keeps the film from being complete, and is listed as omitted with its scene", async () => {
    const reg = loadCapabilityRegistry(repoCaps(), { recipes: library });
    const p = planAssembly(inputFor(withAudio), depsFor(withAudio, reg));
    if (!p.ok) throw new Error(p.reasons.join("; "));
    expect(p.plan.complete).toBe(false);
    expect(p.plan.omitted.filter((o) => o.recipe_id === "loudness-normalise")).toEqual([expect.objectContaining({ scene_id: "S04", status: "blocked_with_reason", reason: expect.stringContaining("audio is not part of this phase") })]);
    expect(p.plan.scenes[3]!.unmet.join(" ")).toContain("audio: loudness-normalise");
    const r = await renderAssembly(p.plan, depsFor(withAudio, reg));
    if (r.kind === "failed") throw new Error(r.errors.join("; "));
    expect(r.kind).toBe("partial");
    if (r.kind !== "partial") return;
    expect(r.report.states.final_delivery_ready).toBe(false);
    expect(r.report.final_delivery_blockers.join(" ")).toMatch(/requires audio|incomplete/);
  });

  it("a film that exports but shows nothing in a scene is a validation failure, not a success", async () => {
    const reg = loadCapabilityRegistry(repoCaps(), { recipes: library });
    // a stand-in FFmpeg-engine adapter that produces a valid file of the right size and length that is one flat colour
    const real = createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.transitions("ffmpeg") });
    const flat: RenderAdapter = { ...real, render: async (job) => { ff("-f", "lavfi", "-i", `color=c=0x336699:s=${job.settings.width}x${job.settings.height}:r=${job.settings.fps}:d=${job.settings.duration_s}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", job.output_path); } };
    const adapters = new AdapterRegistry([flat, createRemotionAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.composed("remotion") }), createHyperframesAdapter({ fontFile: font!, outputRoot, workRoot })]);
    const p = planAssembly(inputFor(mixed), depsFor(mixed, reg, adapters));
    if (!p.ok) throw new Error(p.reasons.join("; "));
    const r = await renderAssembly(p.plan, depsFor(mixed, reg, adapters));
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.errors.join(" ")).toMatch(/scene S01: its last frame is blank/);
    expect(existsSync(join(outputRoot, `${p.plan.render_id}.mp4`))).toBe(false); // no file is left behind
  });

  it("an engine that fails to render a scene fails the whole result with that scene named, and leaves no output", async () => {
    const reg = loadCapabilityRegistry(repoCaps(), { recipes: library });
    const real = createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.transitions("ffmpeg") });
    const boom: RenderAdapter = { ...real, render: async () => { throw new Error("template crashed"); } };
    const adapters = new AdapterRegistry([boom, createRemotionAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.composed("remotion") }), createHyperframesAdapter({ fontFile: font!, outputRoot, workRoot })]);
    const p = planAssembly(inputFor(mixed), depsFor(mixed, reg, adapters));
    if (!p.ok) throw new Error(p.reasons.join("; "));
    const r = await renderAssembly(p.plan, depsFor(mixed, reg, adapters));
    expect(r).toMatchObject({ kind: "failed" });
    expect(r.kind === "failed" && r.errors.join(" ")).toContain("scene S01 (ffmpeg): template crashed");
    expect(existsSync(join(outputRoot, `${p.plan.render_id}.mp4`))).toBe(false);
    void writeFileSync;
  });
});

describe.skipIf(skipReal(can))("every engine can move a picture or animate text, and the assembled film has no accidental black, frozen or missing frames", () => {
  let run: Run, res: Awaited<ReturnType<typeof renderAssembly>>;
  beforeAll(async () => {
    const pic = [{ need: "A supplied picture", kind: "image", availability: "supplied", asset_id: "asset_00000001" }];
    const p = join(tmp, "pic.png");
    const a = await probeFile(p, { assetId: "asset_00000001" });
    if (!a.ok) throw new Error("test image rejected");
    run = await directed("asm-allengines", [
      sc("S01", "Welcome", "dip_to_black"),
      sc("S02", "Your clients, in one place.", "crossfade", { motion: "slow_push_in", assets: ["asset_00000001"], required: pic }),
      sc("S03", "See every conversation", "wipe", { motion: "pan_right", assets: ["asset_00000001"], required: pic }),
      sc("S04", "Book a demo today", "cut"),
    ], [
      use(1, "S01", "text-card-fade"), use(2, "S01", "dip-to-black", { duration_s: 0.6 }),
      use(3, "S02", "slow-push-in-hyperframes", { scale_end: 1.15 }), use(4, "S02", "text-fade-up-hyperframes", { delay_s: 0.6, duration_s: 0.6, distance_px: 24 }), use(5, "S02", "crossfade", { duration_s: 0.5 }),
      use(6, "S03", "pan-reframe", { direction: "right", distance_pct: 8 }), use(7, "S03", "text-word-stagger"), use(8, "S03", "directional-wipe", { direction: "left", duration_s: 0.5 }),
      use(9, "S04", "end-card-cta-hyperframes", { hold_s: 2, background: "brand" }),
    ], [a.asset]);
  }, 240_000);

  it("plans FFmpeg, HyperFrames (camera move and animated caption), Remotion (pan and word stagger) and a HyperFrames end card with nothing missing, then renders and assembles them", async () => {
    const reg = loadCapabilityRegistry(repoCaps(), { recipes: library });
    const plan = planAssembly(inputFor(run), depsFor(run, reg));
    if (!plan.ok) throw new Error(plan.reasons.join("; "));
    expect(plan.plan.scenes.map((s) => [s.scene_id, s.engine, s.renderable, s.unmet])).toEqual([["S01", "ffmpeg", true, []], ["S02", "hyperframes", true, []], ["S03", "remotion", true, []], ["S04", "hyperframes", true, []]]);
    expect(plan.plan.omitted).toEqual([]);
    expect(plan.plan.complete).toBe(true);
    res = await renderAssembly(plan.plan, depsFor(run, reg));
    if (res.kind === "failed") throw new Error(res.errors.join("; "));
    expect(res.kind).toBe("complete");
    if (res.kind !== "complete") return;
    expect(res.report.engines_used.sort()).toEqual(["ffmpeg", "hyperframes", "remotion"]);
    expect(res.report.states).toMatchObject({ scenes_total: 4, scenes_rendered: 4, scenes_content_validated: res.report.scenes.filter((s) => s.engine !== "ffmpeg").length, final_video_validated: true, final_delivery_ready: false });
    expect(res.report.output).toMatchObject({ frames: 360, width: 640, height: 360, fps: 30 });
    if (proofDir) { mkdirSync(proofDir, { recursive: true }); copyFileSync(res.report.output!.path, join(proofDir, "all-engines-film.mp4")); }
  });

  it("FFprobe: one h264 stream, yuv420p, limited colour range, 30 fps, 360 frames, no audio", () => {
    if (res.kind !== "complete") throw new Error("no complete result");
    const s = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,pix_fmt,color_range,r_frame_rate,nb_read_frames,width,height", "-of", "json", res.report.output!.path], { encoding: "utf8" })).streams;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", r_frame_rate: "30/1", nb_read_frames: "360", width: 640, height: 360 });
    expect(s[0].color_range ?? "tv").not.toBe("pc");
  });

  const intervals = (filter: string, file: string, key: string) => {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vf", filter, "-an", "-f", "null", "-"], { encoding: "utf8" });
    const text = `${r.stderr}${r.stdout}`;
    const starts = [...text.matchAll(new RegExp(`${key}_start:\\s*([0-9.]+)`, "g"))].map((m) => Number(m[1]));
    const ends = [...text.matchAll(new RegExp(`${key}_end:\\s*([0-9.]+)`, "g"))].map((m) => Number(m[1]));
    return starts.map((s, i) => [s, ends[i] ?? 12] as const);
  };

  it("no accidental black frames: the only black is inside the approved dip to black (2.4 s to 3.0 s)", () => {
    if (res.kind !== "complete") throw new Error("no complete result");
    const black = intervals("blackdetect=d=0.03:pic_th=0.98", res.report.output!.path, "black");
    for (const [s, e] of black) expect(s >= 2.4 - 0.05 && e <= 3.0 + 0.05, `black from ${s}s to ${e}s is outside the approved dip`).toBe(true);
    expect(black.length).toBeGreaterThan(0); // and the dip really is black
  });

  it("no frozen frames inside the moving scenes: S02 and S03 keep changing between their transitions", () => {
    if (res.kind !== "complete") throw new Error("no complete result");
    const frozen = intervals("freezedetect=n=-55dB:d=0.25", res.report.output!.path, "freeze");
    expect(frozen.length, "the detector must see the still start of the ease-in push-in, or it is not working").toBeGreaterThan(0);
    // the push-in is ease-in-out, so its first moments change by less than the detector can see (measured: up to 0.3 s); nothing else may be still
    for (const [s, e] of frozen) {
      expect(e <= 3.5 || s >= 5.4, `frozen from ${s}s to ${e}s inside S02`).toBe(true);
      expect(e <= 6.2 || s >= 8.4, `frozen from ${s}s to ${e}s inside S03`).toBe(true);
    }
  });

  it("each scene is where it should be: order, boundaries, the HyperFrames end card's approved navy, the Remotion pan moving", async () => {
    if (res.kind !== "complete") throw new Error("no complete result");
    const v = res.report.output!.path;
    expect(near(await frame(v, 30), [22, 33, 62])).toBe(true);
    const mad = (x: Buffer, y: Buffer) => { let d = 0, n = 0; for (let i = 0; i < x.length; i += 12) { d += Math.abs(x[i]! - y[i]!); n++; } return d / n; };
    expect(mad(await frame(v, 90 + 2), await frame(v, 90 + 60))).toBeGreaterThan(4);   // HyperFrames push-in
    expect(mad(await frame(v, 180 + 2), await frame(v, 180 + 60))).toBeGreaterThan(4); // Remotion pan
    expect(near(await frame(v, 270 + 80), [22, 33, 62], 6)).toBe(true);                // HyperFrames end card, approved navy
  });
});

describe.skipIf(skipReal(can))("an approved hard cut is the assembler's default join, not a missing capability", () => {
  it("a film with hard cuts between scenes is complete, and the cut is exactly on the scene boundary", async () => {
    const run = await directed("asm-hardcut", [sc("S01", "First", "cut"), sc("S02", "Second", "cut"), sc("S03", "Third", "cut"), sc("S04", "Fourth", "cut")], [
      use(1, "S01", "text-card-fade"), use(2, "S01", "hard-cut"), use(3, "S02", "text-card-fade", { background: "forest" }), use(4, "S02", "hard-cut"), use(5, "S03", "text-card-fade", { background: "charcoal" }), use(6, "S03", "hard-cut"), use(7, "S04", "text-card-fade"),
    ], []);
    const reg = loadCapabilityRegistry(repoCaps(), { recipes: library });
    const plan = planAssembly(inputFor(run), depsFor(run, reg));
    if (!plan.ok) throw new Error(plan.reasons.join("; "));
    expect(plan.plan.omitted, JSON.stringify(plan.plan.omitted)).toEqual([]);
    expect(plan.plan.transitions.map((t) => [t.template, t.applied, t.frames])).toEqual([["ffmpeg/concat-cut", true, 0], ["ffmpeg/concat-cut", true, 0], ["ffmpeg/concat-cut", true, 0]]);
    expect(plan.plan.scenes.every((s) => s.renderable && s.unmet.length === 0)).toBe(true);
    const r = await renderAssembly(plan.plan, depsFor(run, reg));
    if (r.kind === "failed") throw new Error(r.errors.join("; "));
    expect(r.kind).toBe("complete");
    if (r.kind !== "complete") return;
    expect(r.report.output).toMatchObject({ frames: 360 });
    expect(r.report.transitions.every((t) => t.status === "applied")).toBe(true);
    expect(near(await frame(r.report.output!.path, 89), [22, 33, 62], 14)).toBe(true);  // last frame of S01
    expect(near(await frame(r.report.output!.path, 90), [30, 61, 47], 14)).toBe(true);  // first frame of S02: a cut, nothing in between
  });
});