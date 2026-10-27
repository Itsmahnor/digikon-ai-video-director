import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RenderRecord, handoffContentHash, type DirectorHandoff, type EditorOperation, type EditorOutput } from "@digikon/contracts";
import {
  NO_RENDERERS, ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, runEditor, type DirectorStateType, type EditorDeps,
} from "@digikon/director";
import { cfg, deps, knowledge, learnEdit, learnInput, learnStoryboard, learnTreatment, root } from "../../director/src/fixtures.js";
import { AdapterRegistry, NO_ADAPTERS, executeRender, loadRenderRecord, planRender, saveRenderRecord, validateOutput, type RenderAdapter, type RenderDeps, type RenderJob } from "./index.js";

vi.setConfig({ testTimeout: 60_000 }); // several tests run real ffmpeg, which is slower while the whole suite runs in parallel
const ready = { status: "ready", questions: [] };
const tmp = mkdtempSync(join(tmpdir(), "render-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const settings = { aspect_ratio: "16:9", width: 640, height: 360, fps: 30, duration_s: 30, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test fixture, not a platform specification" } };

/** A real file from ffmpeg. The tests need a file on disk to prove that success depends on one. */
function makeVideo(path: string, o: { size?: string; d?: number; r?: number; audio?: boolean } = {}) {
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=blue:s=${o.size ?? "640x360"}:d=${o.d ?? 30}:r=${o.r ?? 30}`];
  if (o.audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:d=${o.d ?? 30}`, "-c:a", "aac", "-shortest");
  execFileSync("ffmpeg", [...args, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path], { stdio: "ignore" });
}
type OperationType = EditorOperation["operation_type"];
const REMOTION: Record<string, readonly OperationType[]> = { "remotion/text-fade-up": ["overlay_text"], "remotion/text-word-stagger": ["overlay_text"], "remotion/end-card-cta": ["render_graphics_scene"] };
const FFMPEG: Record<string, readonly OperationType[]> = { "ffmpeg/xfade-fade": ["concat"], "ffmpeg/loudnorm": ["mix_audio"] };
/** An explicit test double, not a renderer: it writes whatever the test asks for. */
const adapter = (renderer: "remotion" | "ffmpeg", write: (job: RenderJob) => Promise<void> | void): RenderAdapter => ({ renderer, templates: renderer === "remotion" ? REMOTION : FFMPEG, render: async (job) => { await write(job); } });
const good = adapter("remotion", (job) => makeVideo(job.output_path));

// ---- an approved run whose plan needs one renderer only (remotion), and the original six-operation plan that needs two ----
// text-fade-up delays its text by default; an approved delay is a caption timing no renderer carries out, so the fully covered fixture asks for none.
const useOf = (n: number, scene_id: string, recipe_id: string) => ({ use_id: `U0${n}`, scene_id, recipe_id, params: recipe_id === "text-fade-up" ? { delay_s: 0 } : {}, rationale: "fits the beat" });
// Every approved scene gets an operation and none asks for anything the test renderer cannot show, so the plan is fully covered.
const remotionOnly = { uses: [useOf(1, "S01", "text-fade-up"), useOf(2, "S02", "text-word-stagger"), useOf(3, "S03", "text-fade-up"), useOf(4, "S04", "text-fade-up"), useOf(5, "S05", "text-fade-up"), useOf(6, "S06", "end-card-cta")] };
const plainScene = (t: string) => ({ overlay: { text: t, safe_area: "platform_safe" }, transition_out: "cut", claim_ids: [] as string[], required_assets: [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }], unresolved: [] as unknown[] });

async function approvedRun(id: string, edit: unknown, storyboard: ReturnType<typeof learnStoryboard> = learnStoryboard()) {
  const d = deps(new ScriptedClient([ready, learnTreatment(), storyboard, edit]));
  const graph = buildDirectorGraph(d);
  const g1 = await graph.invoke(learnInput, cfg(id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(id))) as DirectorStateType;
  const handoff = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: id, model: "scripted" });
  const editor: EditorDeps = { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever };
  const run = await runEditor(handoff, editor);
  if (!run.ok) throw new Error(`editor rejected: ${run.reasons.join("; ")}`);
  return { handoff, output: run.output, recipes: d.recipes };
}

let single: Awaited<ReturnType<typeof approvedRun>>, mixed: Awaited<ReturnType<typeof approvedRun>>;
// The single-renderer plan has no crossfade, so it needs no ffmpeg recipe.
beforeAll(async () => { single = await approvedRun("r-single", remotionOnly, learnStoryboard({ S03: plainScene("One place."), S04: plainScene("Everything together."), S05: plainScene("Pick up where you left off.") })); mixed = await approvedRun("r-mixed", learnEdit); }, 60_000);

const rdeps = (t: typeof single, adapters: AdapterRegistry, over: Partial<RenderDeps> = {}): RenderDeps => ({ recipes: t.recipes, adapters, outputRoot: tmp, ...over });
const plan = (t: typeof single, adapters: AdapterRegistry, over: { settings?: unknown; purpose?: "production" | "preview"; editor_output?: unknown; handoff?: unknown } = {}, d: Partial<RenderDeps> = {}) =>
  planRender({ editor_output: t.output, handoff: t.handoff, settings, purpose: "preview", ...over }, rdeps(t, adapters, d));
const planned = (r: ReturnType<typeof planRender>) => { if (!r.ok) throw new Error(`rejected: ${r.reasons.join("; ")}`); return r; };
const rehash = (x: DirectorHandoff): DirectorHandoff => { const c = handoffContentHash(x); return { ...x, content_hash: c, handoff_id: `ho_${c.slice(0, 16)}` }; };

describe("what is rejected before any render record exists", () => {
  it("the fixtures are a valid, ready Editor result (the baseline these tests break)", () => {
    expect(single.output.status).toBe("ready");
    expect(single.output.execution.executable).toBe(false); // the Editor ran with no renderer
    expect(single.output.operations.map((o) => o.recipe_id)).toEqual(["text-fade-up", "text-word-stagger", "text-fade-up", "text-fade-up", "text-fade-up", "end-card-cta"]);
  });

  it("rejects Editor output that does not parse", () => {
    for (const bad of [null, {}, "ready", { ...single.output, schema_version: "0.9.0" }, { ...single.output, operations: "none" }]) {
      const r = plan(single, new AdapterRegistry([good]), { editor_output: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.stage).toBe("editor_output");
    }
  });

  it("rejects Editor output that departs from the approved plan (the Director's check still runs)", () => {
    const ops = structuredClone(single.output.operations);
    ops[0]!.caption = { text: "Buy now!!!", start_s: 0, end_s: 2 };
    const r = plan(single, new AdapterRegistry([good]), { editor_output: { ...single.output, operations: ops } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toContain("caption text is not the approved overlay text");

    const moved = structuredClone(single.output.operations);
    moved[0]!.timing = { start_s: 50, duration_s: 4 };
    expect(plan(single, new AdapterRegistry([good]), { editor_output: { ...single.output, operations: moved } }).ok).toBe(false);
  });

  it("rejects Editor output made from a different handoff", () => {
    const r = plan(single, new AdapterRegistry([good]), { editor_output: { ...single.output, handoff_content_hash: "0".repeat(64) } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toContain("different handoff");
  });

  it("rejects an Editor result that is not ready, even when it parses", () => {
    const blocked: EditorOutput = { ...single.output, status: "blocked", conflicts: [{ conflict_id: "K1", kind: "missing_information", scene_id: null, use_id: null, description: "something is missing", evidence: [] }], execution: { ...single.output.execution, executable: false } };
    const r = plan(single, new AdapterRegistry([good]), { editor_output: blocked });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toMatch(/not ready|open conflicts/);
  });

  it("rejects a handoff that was altered after approval, or whose approvals do not match", () => {
    const edited = rehash({ ...single.handoff, storyboard: { ...single.handoff.storyboard, scenes: single.handoff.storyboard.scenes.map((s, i) => (i === 0 ? { ...s, overlay: { text: "Changed after approval", safe_area: "platform_safe" as const } } : s)) } });
    const r = plan(single, new AdapterRegistry([good]), { handoff: edited, editor_output: single.output });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.stage).toBe("handoff"); expect(r.reasons.join(" ")).toMatch(/hash mismatch|does not match its approval/); }
    const stale = plan(single, new AdapterRegistry([good]), { handoff: { ...single.handoff, content_hash: "f".repeat(64) } });
    expect(stale.ok).toBe(false);
  });

  it("rejects a handoff that cannot be parsed", () => {
    const r = plan(single, new AdapterRegistry([good]), { handoff: { nothing: true } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("input");
  });
});

describe("planning: missing templates, renderers, settings", () => {
  it("is planning, with every blocker, when no adapter exists", () => {
    const { record, plan: p } = planned(plan(single, NO_ADAPTERS));
    expect(record.state).toBe("planning");
    expect(p).toBeNull();
    expect(record.output).toBeNull();
    expect(record.blockers).toEqual(expect.arrayContaining(["E01: no template is registered for remotion/text-fade-up, and no remotion renderer is available"]));
    expect(record.operations.every((o) => o.renderer === null)).toBe(true);
  });

  it("does not trust an Editor report that said an operation was executable", () => {
    const lie: EditorOutput = { ...single.output, execution: { ...single.output.execution, executable: true, production_executable: true, operations: single.output.execution.operations.map((o) => ({ ...o, renderer: "remotion" as const, executable: true, production_executable: true, blockers: [] })) } };
    const r = planned(plan(single, NO_ADAPTERS, { editor_output: lie }));
    expect(r.record.state).toBe("planning");
  });

  it("refuses an operation whose template does not implement that operation type", () => {
    const wrongType: RenderAdapter = { renderer: "remotion", templates: { ...REMOTION, "remotion/text-fade-up": ["concat"] }, render: async () => undefined };
    const r = planned(plan(single, new AdapterRegistry([wrongType])));
    expect(r.record.state).toBe("planning");
    expect(r.record.blockers.join(" ")).toContain("E01: template remotion/text-fade-up does not implement overlay_text operations");
  });

  it("refuses a template registered for a renderer the recipe does not support", () => {
    const wrongRenderer: AdapterRegistry = Object.assign(new AdapterRegistry([good]), { template: () => ({ renderer: "ffmpeg" as const }) });
    const r = planned(plan(single, wrongRenderer));
    expect(r.record.blockers.join(" ")).toContain("which recipe text-fade-up does not support");
  });

  it("refuses an adapter that registers a template of another renderer", () => {
    expect(() => new AdapterRegistry([{ renderer: "ffmpeg", templates: { "remotion/x": ["overlay_text"] }, render: async () => undefined }])).toThrow(/does not belong/);
  });

  it("refuses a plan that needs two renderers, instead of rendering half of it", () => {
    const both = new AdapterRegistry([adapter("remotion", () => undefined), adapter("ffmpeg", () => undefined)]);
    const r = planned(plan(mixed, both, { settings: { ...settings, audio_codec: "aac" } }));
    expect(r.record.state).toBe("planning");
    expect(r.record.blockers.join(" ")).toContain("more than one renderer (remotion, ffmpeg)");
  });

  it("stays in planning with no settings at all, and assumes none", () => {
    const r = planned(plan(single, new AdapterRegistry([good]), { settings: undefined }));
    expect(r.record.state).toBe("planning");
    expect(r.record.settings).toBeNull();
    expect(r.record.blockers.join(" ")).toContain("no output settings were supplied");
    expect(r.plan).toBeNull();
  });

  it.each([
    ["a missing field", { ...settings, fps: undefined }, "output settings fps"],
    ["a size that is not the aspect ratio", { ...settings, width: 640, height: 480 }, "is not 16:9"],
    ["a codec the container cannot carry", { ...settings, container: "webm" }, "cannot carry h264"],
    ["settings with no stated source", { ...settings, source: undefined }, "output settings source"],
    ["the wrong aspect ratio for the approved project", { ...settings, aspect_ratio: "9:16", width: 360, height: 640 }, "but the approved project is 16:9"],
    ["a duration that is not the storyboard's", { ...settings, duration_s: 20 }, "but the approved storyboard lasts 30s"],
  ])("blocks on %s", (_n, bad, text) => {
    const r = planned(plan(single, new AdapterRegistry([good]), { settings: bad }));
    expect(r.record.state).toBe("planning");
    expect(r.record.blockers.join(" ")).toContain(text);
  });

  it("does not add a silent audio track, and does not drop planned audio", () => {
    expect(planned(plan(single, new AdapterRegistry([good]), { settings: { ...settings, audio_codec: "aac" } })).record.blockers.join(" ")).toContain("the plan has no audio; none is added silently");
    const both = new AdapterRegistry([adapter("remotion", () => undefined), adapter("ffmpeg", () => undefined)]);
    expect(mixed.output.operations.some((o) => o.operation_type === "mix_audio")).toBe(true);
    expect(planned(plan(mixed, both, { settings })).record.blockers.join(" ")).toContain("the plan includes audio but the output settings choose no audio codec");
  });
});

describe("draft recipes are never production-executable", () => {
  it("a production render of draft recipes stays in planning, even with an adapter and settings", () => {
    const r = planned(plan(single, new AdapterRegistry([good]), { purpose: "production" }));
    expect(r.record.state).toBe("planning");
    expect(r.record.operations.every((o) => !o.production_executable)).toBe(true);
    expect(r.record.blockers.join(" ")).toContain("text-fade-up is draft: no review evidence");
    expect(r.record.blockers.join(" ")).toContain("handoff is not production-ready");
    expect(r.plan).toBeNull();
  });

  it("production is the default purpose", () => {
    const r = planned(planRender({ editor_output: single.output, handoff: single.handoff, settings }, rdeps(single, new AdapterRegistry([good]))));
    expect(r.record.purpose).toBe("production");
    expect(r.record.state).toBe("planning");
  });

  it("a preview of draft recipes can run, is labelled a preview, and does not mark any recipe reviewed", () => {
    const r = planned(plan(single, new AdapterRegistry([good]), { purpose: "preview" }));
    expect(r.record.state).toBe("executable");
    expect(r.record.purpose).toBe("preview");
    expect(r.record.notes.join(" ")).toContain("not a production video");
    expect(r.record.operations.every((o) => !o.production_executable)).toBe(true);
    expect(single.recipes.get("text-fade-up")!.status).toBe("draft");
  });
});

describe("rendering: success needs a real, validated file", () => {
  it("is rendered only after the file is probed against the settings, and the record then round-trips", async () => {
    const p = planned(plan(single, new AdapterRegistry([good]))).plan!;
    const seen: string[] = [];
    const rec = await executeRender(p, { onUpdate: (r) => seen.push(r.state) });
    expect(seen).toEqual(["rendering"]);
    expect(rec.state).toBe("rendered");
    expect(rec.errors).toEqual([]);
    expect(rec.output).toMatchObject({ path: p.job.output_path, container: "mp4", width: 640, height: 360, video_codec: "h264", audio_codec: null, audio_tracks: 0 });
    expect(rec.output!.checks.join(" ")).toMatch(/duration=30/);
    expect(existsSync(rec.output!.path)).toBe(true);
    expect(RenderRecord.safeParse(rec).success).toBe(true);
    const dir = join(tmp, "records");
    saveRenderRecord(dir, rec);
    expect(loadRenderRecord(dir, rec.render_id)).toEqual({ record: rec, problems: [] });
  });

  it("is failed, with no output, when the adapter throws", async () => {
    const boom = adapter("remotion", () => { throw new Error("template crashed"); });
    const rec = await executeRender(planned(plan(single, new AdapterRegistry([boom]))).plan!);
    expect(rec).toMatchObject({ state: "failed", output: null, errors: [{ stage: "adapter", message: "template crashed" }] });
  });

  it("is failed when the adapter reports success but wrote nothing", async () => {
    const nothing = adapter("remotion", () => undefined);
    const rec = await executeRender(planned(plan(single, new AdapterRegistry([nothing]))).plan!);
    expect(rec.state).toBe("failed");
    expect(rec.output).toBeNull();
    expect(rec.errors[0]).toMatchObject({ stage: "missing_output" });
  });

  it("is failed for an empty file, and for a file that is not media", async () => {
    for (const [name, content] of [["empty", ""], ["text", "this is not a video"]] as const) {
      const bad = adapter("remotion", (job) => writeFileSync(job.output_path, content));
      const rec = await executeRender(planned(plan(single, new AdapterRegistry([bad]))).plan!);
      expect(rec.state, name).toBe("failed");
      expect(rec.output, name).toBeNull();
      expect(rec.errors[0]!.stage, name).toBe("output_validation");
    }
  });

  it("is failed when the file is real but is not what the settings describe", async () => {
    const cases: [string, Parameters<typeof makeVideo>[1], string][] = [
      ["wrong size", { size: "320x180" }, "the frame is 320x180, not 640x360"],
      ["wrong frame rate", { r: 24 }, "the frame rate is 24, not 30"],
      ["wrong duration", { d: 12 }, "the video lasts 12s, not 30s"],
      ["audio nobody asked for", { audio: true }, "the settings choose no audio, but the output has an audio track"],
    ];
    for (const [name, spec, message] of cases) {
      const wrong = adapter("remotion", (job) => makeVideo(job.output_path, spec));
      const rec = await executeRender(planned(plan(single, new AdapterRegistry([wrong]))).plan!);
      expect(rec.state, name).toBe("failed");
      expect(rec.output, name).toBeNull();
      expect(rec.errors.map((e) => e.message).join(" "), name).toContain(message);
    }
  });

  it("does not accept a file without the audio track the settings promise, and accepts one with it", async () => {
    const silent = join(tmp, "silent.mp4"), voiced = join(tmp, "voiced.mp4");
    makeVideo(silent); makeVideo(voiced, { audio: true });
    const withAudio = { ...settings, audio_codec: "aac" } as never;
    const missing = await validateOutput(silent, withAudio, true);
    expect(missing).toMatchObject({ ok: false, issues: ["the settings ask for audio but the output has no audio track"] });
    const present = await validateOutput(voiced, withAudio, true);
    expect(present.ok && present.output).toMatchObject({ audio_codec: "aac", audio_tracks: 1 });
    expect(await validateOutput(voiced, settings as never, true)).toMatchObject({ ok: false });
  });

  it("is failed when the adapter does not finish in time, and the adapter is told to stop", async () => {
    let aborted = false;
    const hang = adapter("remotion", (job) => new Promise<void>(() => { job.signal.addEventListener("abort", () => { aborted = true; }); }));
    const rec = await executeRender(planned(plan(single, new AdapterRegistry([hang]))).plan!, { timeoutMs: 50 });
    expect(rec.state).toBe("failed");
    expect(rec.errors[0]!.stage).toBe("timeout");
    expect(aborted).toBe(true);
  });

  it("refuses to treat a file that was already there as this render's output", async () => {
    const p = planned(plan(single, new AdapterRegistry([adapter("remotion", () => undefined)]))).plan!;
    makeVideo(p.job.output_path);
    const rec = await executeRender(p);
    expect(rec.state).toBe("failed");
    expect(rec.errors[0]!.message).toContain("already exists");
  });

  it("does not execute a record that is not executable", async () => {
    const stuck = planned(plan(single, NO_ADAPTERS));
    expect(stuck.plan).toBeNull();
    const p = planned(plan(single, new AdapterRegistry([good]))).plan!;
    await expect(executeRender({ ...p, record: { ...p.record, state: "planning", blockers: ["x"] } })).rejects.toThrow(/cannot be executed/);
  });
});

describe("stored records", () => {
  it("are re-checked on load: a stored 'rendered' record without output is not trusted", () => {
    const dir = join(tmp, "tampered");
    const p = planned(plan(single, NO_ADAPTERS)).record;
    saveRenderRecord(dir, p);
    const file = join(dir, `${p.render_id}.json`);
    writeFileSync(file, JSON.stringify({ ...p, state: "rendered", blockers: [], finished_at: p.created_at }));
    const { record, problems } = loadRenderRecord(dir, p.render_id);
    expect(record).toBeNull();
    expect(problems.join(" ")).toContain("rendered needs a validated output file");
  });
  it("cannot save an invalid record", () => {
    const p = planned(plan(single, NO_ADAPTERS)).record;
    expect(() => saveRenderRecord(join(tmp, "bad"), { ...p, state: "rendered" } as RenderRecord)).toThrow();
  });
});

describe("the Editor still gets the same answer", () => {
  it("an AdapterRegistry works as the Editor's RendererRegistry, and NO_RENDERERS still blocks everything", async () => {
    expect(new AdapterRegistry([good]).template("remotion/text-fade-up")).toEqual({ renderer: "remotion" });
    expect(new AdapterRegistry([good]).template("remotion/unknown")).toBeNull();
    expect(NO_ADAPTERS.template("remotion/text-fade-up")).toBeNull();
    expect(NO_RENDERERS.template("remotion/text-fade-up")).toBeNull();
    const d = deps(new ScriptedClient([]));
    const again = await runEditor(single.handoff, { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever, renderers: new AdapterRegistry([good]) });
    expect(again.ok && again.output.execution).toMatchObject({ executable: true, production_executable: false, rendered: false });
  });
});
