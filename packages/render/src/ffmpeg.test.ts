import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DirectorHandoff, EditorOperation } from "@digikon/contracts";
import { ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, runEditor, type DirectorStateType } from "@digikon/director";
import { cfg, deps, knowledge, learnInput, learnStoryboard, learnStoryboardWithAudio, learnTreatment, root } from "../../director/src/fixtures.js";
import {
  AdapterRegistry, TEXT_CARD_TEMPLATE, buildFilterGraph, buildRenderEvidence, createFfmpegAdapter, executeRender, planRender, planTextCards, runRenderQa,
  saveRenderEvidence, validateOutput, type ExecutablePlan, type RenderDeps, type RenderJob,
} from "./index.js";
import { realPrerequisites, skipReal } from "./test-env.js";

const FONTS = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];
const font = FONTS.find((f) => existsSync(f));
realPrerequisites({ font: !!font });
const tmp = mkdtempSync(join(tmpdir(), "ffmpeg-render-"));
const outputRoot = join(tmp, "out");
mkdirSync(outputRoot);
/** Where evidence from the real test render is kept. Set RENDER_PROOF_DIR to keep it (for example storage/test-renders). */
const proofDir = process.env["RENDER_PROOF_DIR"];
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Test values only. They are not a platform specification and nothing in the project uses them as a default.
const settings = { aspect_ratio: "16:9", width: 640, height: 360, fps: 30, duration_s: 30, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test fixture values, not a platform specification" } };

const ready = { status: "ready", questions: [] };
const useOf = (n: number, scene_id: string, params: Record<string, number | string> = {}) => ({ use_id: `U0${n}`, scene_id, recipe_id: "text-card-fade", params, rationale: "fits the beat" });
// Plain graphics only, so the approved plan asks for nothing the text-card renderer cannot show.
const card = (t: string) => ({ overlay: { text: t, safe_area: "platform_safe" }, transition_out: "cut", claim_ids: [] as string[], required_assets: [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }], unresolved: [] as unknown[] });
const storyboard = learnStoryboard({ S01: card("Too many tabs."), S02: card("Where was I?"), S03: card("One place."), S04: card("Everything together."), S05: card("Pick up where you left off."), S06: card("Start learning.") });
const cardsEdit = { uses: [useOf(1, "S01"), useOf(2, "S02", { background: "charcoal" }), useOf(3, "S03", { fade_in_s: 1 }), useOf(4, "S04"), useOf(5, "S05", { background: "forest" }), useOf(6, "S06")] };

let d: ReturnType<typeof deps>, handoff: DirectorHandoff, output: unknown;
beforeAll(async () => {
  d = deps(new ScriptedClient([ready, learnTreatment(), storyboard, cardsEdit]));
  const graph = buildDirectorGraph(d);
  const g1 = await graph.invoke(learnInput, cfg("cards"));
  const g2 = await graph.invoke(approveCurrent(g1), cfg("cards"));
  const done = (await graph.invoke(approveCurrent(g2), cfg("cards"))) as DirectorStateType;
  handoff = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: "cards", model: "scripted" });
  const run = await runEditor(handoff, { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever });
  if (!run.ok) throw new Error(`editor rejected: ${run.reasons.join("; ")}`);
  output = run.output;
}, 60_000);

const registry = () => new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot })]);
const rdeps = (r = registry(), over: Partial<RenderDeps> = {}): RenderDeps => ({ recipes: d.recipes, adapters: r, outputRoot, ...over });
const plan = (over: { purpose?: "production" | "preview"; settings?: unknown; handoff?: unknown; editor_output?: unknown } = {}, r = registry()) => {
  const x = planRender({ editor_output: output, handoff, settings, purpose: "preview", ...over }, rdeps(r));
  if (!x.ok) throw new Error(`rejected: ${x.reasons.join("; ")}`);
  return x;
};
const jobOf = (): Omit<RenderJob, "signal"> => structuredClone(plan().plan!.job);
const issuesOf = (job: Omit<RenderJob, "signal">) => { const p = planTextCards(job, { outputRoot }); return p.ok ? [] : p.issues; };
const mutateOp = (job: Omit<RenderJob, "signal">, f: (op: EditorOperation) => void, i = 0) => { f(job.operations[i]!); return job; };

describe.skipIf(skipReal(!!font))("the FFmpeg text-card path, end to end", () => {
  let first: Awaited<ReturnType<typeof executeRender>>;
  let firstPlan: ExecutablePlan;

  it("the approved plan really uses the new template, and the Director's recipe is still a draft", () => {
    expect((output as { status: string }).status).toBe("ready");
    const r = plan();
    expect(r.record.state).toBe("executable");
    expect(r.record.operations.map((o) => [o.recipe_id, o.implementation_ref, o.renderer, o.production_executable])).toEqual(Array(6).fill(["text-card-fade", "ffmpeg/text-card", "ffmpeg", false]));
    const recipe = d.recipes.get("text-card-fade")!;
    expect(recipe.status).toBe("draft");
    expect(recipe.review).toBeNull();
  });

  it("renders a real video, and the record becomes rendered only after probing it", async () => {
    const p = plan(); firstPlan = p.plan!;
    const states: string[] = [];
    first = await executeRender(firstPlan, { onUpdate: (r) => states.push(r.state) });
    expect(states).toEqual(["rendering"]);
    expect(first.state).toBe("rendered");
    expect(first.purpose).toBe("preview");
    expect(first.output).toMatchObject({ container: "mp4", width: 640, height: 360, fps: 30, duration_s: 30, video_codec: "h264", audio_codec: null, audio_tracks: 0 });
    expect(first.output!.bytes).toBeGreaterThan(1000);
    expect(existsSync(first.output!.path)).toBe(true);
    // measured again, independently of the record
    const again = await validateOutput(first.output!.path, first.settings!, false);
    expect(again.ok && again.output.sha256).toBe(first.output!.sha256);
    console.log("RENDER METADATA", JSON.stringify(first.output));
  }, 120_000);

  it("passes the QA package's technical checks on the real file, and records evidence without reviewing the recipe", async () => {
    const qa = await runRenderQa(first, handoff);
    expect(qa.findings, JSON.stringify(qa.findings)).toEqual([]);
    expect(qa.passed.map((x) => x.check)).toEqual(expect.arrayContaining(["duration", "resolution", "frame_rate", "black_frames", "frozen_frames"]));
    const recipe = d.recipes.get("text-card-fade")!;
    const ev = buildRenderEvidence(first, recipe, qa);
    expect(ev).toMatchObject({ recipe_id: "text-card-fade", recipe_status: "draft", purpose: "preview", implementation_ref: "ffmpeg/text-card" });
    expect(ev.note).toContain("does not review the recipe");
    const file = saveRenderEvidence(proofDir ?? join(tmp, "evidence"), ev);
    expect(JSON.parse(readFileSync(file, "utf8")).output.sha256).toBe(first.output!.sha256);
    expect(recipe.status).toBe("draft");
    expect(JSON.parse(readFileSync(root("recipes/animation/text-card-fade.json"), "utf8"))).toMatchObject({ status: "draft" });
    console.log("QA", JSON.stringify({ passed: qa.passed, measurements: qa.measurements }), "EVIDENCE", file);
  }, 120_000);

  it("really draws the text: the picture is plain at 0s and different once the text has faded in", () => {
    const frame = (t: number, name: string) => {
      const png = join(proofDir ?? tmp, name);
      mkdirSync(proofDir ?? tmp, { recursive: true });
      execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", first.output!.path, "-frames:v", "1", png], { stdio: "ignore" });
      return { png, bytes: readFileSync(png) };
    };
    const start = frame(0, "frame-0s.png"), later = frame(2, "frame-2s.png");
    expect(Buffer.compare(start.bytes, later.bytes)).not.toBe(0);
    expect(later.bytes.length).toBeGreaterThan(start.bytes.length); // text adds detail to a flat picture
  });

  it("is deterministic: the same plan renders to byte-identical files", async () => {
    const second = await executeRender(plan().plan!);
    expect(second.state).toBe("rendered");
    expect(second.render_id).not.toBe(first.render_id);
    expect(second.output!.sha256).toBe(first.output!.sha256);
  }, 120_000);

  it("does not become production-ready: a production render of the same plan stays in planning", () => {
    const r = plan({ purpose: "production" });
    expect(r.record.state).toBe("planning");
    expect(r.plan).toBeNull();
    expect(r.record.blockers.join(" ")).toContain("text-card-fade is draft: no review evidence");
  });

  it("shows any text literally and never lets it reach the FFmpeg arguments", async () => {
    const nasty = ["It's 50% off: a, b; c [v0] \\ \"q\"", "%{pts} %{localtime} %{n}", "'; drawtext=text=pwned", "Zażółć gęślą — 日本語", "$(calc) `calc` & | > nul"];
    for (const text of nasty) {
      const job = jobOf();
      job.operations = [{ ...job.operations[0]!, caption: { text, start_s: 0, end_s: 1 }, timing: { start_s: 0, duration_s: 1 } }];
      job.settings = { ...job.settings, duration_s: 1 };
      const out = join(outputRoot, "rn_aaaaaaaaaaaaaaaa.mp4");
      const adapter = createFfmpegAdapter({ fontFile: font!, outputRoot });
      await adapter.render({ ...job, output_path: out, signal: new AbortController().signal });
      const checked = await validateOutput(out, job.settings, false);
      expect(checked.ok, text).toBe(true);
      expect(buildFilterGraph(planOf(job), 640, 360, 30), text).not.toContain(text.slice(0, 6));
      rmSync(out);
    }
  }, 120_000);
});

const planOf = (job: Omit<RenderJob, "signal">) => { const p = planTextCards(job, { outputRoot }); if (!p.ok) throw new Error(p.issues.join("; ")); return p.scenes; };

describe.skipIf(skipReal(!!font))("what the adapter supports and refuses", () => {
  it("supports exactly the listed templates, each for its one operation type, and the registry says so", () => {
    const a = createFfmpegAdapter({ fontFile: font!, outputRoot });
    expect(a.renderer).toBe("ffmpeg");
    expect(a.templates).toEqual({
      [TEXT_CARD_TEMPLATE]: ["render_graphics_scene"], "ffmpeg/title-subtitle": ["render_graphics_scene"], "ffmpeg/bullet-list": ["render_graphics_scene"],
      "ffmpeg/stat-callout": ["render_graphics_scene"], "ffmpeg/image-scene": ["render_graphics_scene"], "ffmpeg/xfade-fade": ["concat"], "ffmpeg/concat-cut": ["concat"], "ffmpeg/match-cut": ["concat"], "ffmpeg/clip-play": ["trim_clip"], "ffmpeg/asset-stage": ["render_graphics_scene"],
    });
    const r = new AdapterRegistry([a]);
    expect(r.template("ffmpeg/text-card")).toEqual({ renderer: "ffmpeg" });
    expect(r.supports("ffmpeg/text-card", "render_graphics_scene")).toBe(true);
    expect(r.supports("ffmpeg/xfade-fade", "concat")).toBe(true);
    for (const type of ["overlay_text", "concat", "mix_audio", "trim_clip"] as const) expect(r.supports("ffmpeg/text-card", type)).toBe(false);
    for (const type of ["render_graphics_scene", "mix_audio", "trim_clip", "overlay_text"] as const) expect(r.supports("ffmpeg/xfade-fade", type)).toBe(false);
    for (const ref of ["ffmpeg/loudnorm", "ffmpeg/xfade-wipe", "ffmpeg/xfade-fadeblack", "ffmpeg/sidechain-duck", "ffmpeg/trim-hold", "remotion/end-card-cta"]) expect(r.template(ref), ref).toBeNull();
  });

  it("the planner refuses plans that need recipes this adapter does not implement", async () => {
    // The six-operation example plan mixes remotion and ffmpeg recipes; none but text-card has a template.
    const mixed = deps(new ScriptedClient([ready, learnTreatment(), learnStoryboardWithAudio(), { uses: [{ ...useOf(1, "S01"), recipe_id: "text-fade-up" }, { ...useOf(2, "S02"), recipe_id: "text-word-stagger" }, { ...useOf(3, "S03"), recipe_id: "crossfade" }, { ...useOf(4, "S05"), recipe_id: "crossfade" }, { ...useOf(5, "S06"), recipe_id: "end-card-cta" }, { ...useOf(6, "S06"), recipe_id: "loudness-normalise" }] }]));
    const graph = buildDirectorGraph(mixed);
    const g1 = await graph.invoke(learnInput, cfg("other"));
    const g2 = await graph.invoke(approveCurrent(g1), cfg("other"));
    const done = (await graph.invoke(approveCurrent(g2), cfg("other"))) as DirectorStateType;
    const h = buildHandoff(done, { recipes: mixed.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: "other", model: "scripted" });
    const run = await runEditor(h, { recipes: mixed.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: mixed.retriever });
    if (!run.ok) throw new Error(run.reasons.join("; "));
    const r = planRender({ editor_output: run.output, handoff: h, settings: { ...settings, audio_codec: "aac" }, purpose: "preview" }, { recipes: mixed.recipes, adapters: registry(), outputRoot });
    expect(r.ok && r.record.state).toBe("planning");
    expect(r.ok && r.record.blockers.join(" ")).toContain("no template is registered for remotion/text-fade-up");
    expect(r.ok && r.record.blockers.join(" ")).not.toContain("ffmpeg/xfade-fade"); // the crossfade now has a template
    expect(r.ok && r.record.blockers.join(" ")).toContain("no template is registered for ffmpeg/loudnorm");
  }, 60_000);

  it("accepts the planned job as it is", () => expect(issuesOf(jobOf())).toEqual([]));

  it.each<[string, (j: Omit<RenderJob, "signal">) => void, string]>([
    ["another operation type", (j) => mutateOp(j, (o) => { o.operation_type = "mix_audio"; }), "mix_audio is not supported"],
    ["another template", (j) => { j.templates["E01"] = "ffmpeg/loudnorm"; }, "is not supported by this renderer"],
    ["a missing template", (j) => { delete j.templates["E01"]; }, "(none)"],
    ["assets", (j) => mutateOp(j, (o) => { o.asset_ids = ["asset_x"]; }), "uses no assets"],
    ["job assets", (j) => { j.assets = [{ asset_id: "a", media_type: "video", uri: "x.mp4" }]; }, "is not shown by any operation"],
    ["audio cues, which are never dropped silently", (j) => mutateOp(j, (o) => { o.audio_cues = ["swoosh"]; }), "audio cues cannot be produced"],
    ["an unknown parameter", (j) => mutateOp(j, (o) => { o.parameters = { ...o.parameters, drawtext: "x" }; }), "unknown parameter drawtext"],
    ["a fade below the range", (j) => mutateOp(j, (o) => { o.parameters = { ...o.parameters, fade_in_s: 0.01 }; }), "fade_in_s must be a number from 0.2 to 2"],
    ["a fade above the range", (j) => mutateOp(j, (o) => { o.parameters = { ...o.parameters, fade_in_s: 99 }; }), "fade_in_s must be a number"],
    ["a fade that is not a number", (j) => mutateOp(j, (o) => { o.parameters = { ...o.parameters, fade_in_s: "0.5:alpha=1" }; }), "fade_in_s must be a number"],
    ["a fade of NaN", (j) => mutateOp(j, (o) => { o.parameters = { ...o.parameters, fade_in_s: Number.NaN }; }), "fade_in_s must be a number"],
    ["a background outside the list", (j) => mutateOp(j, (o) => { o.parameters = { ...o.parameters, background: "red;drawtext=text=x" }; }), "background must be one of navy, charcoal, forest"],
    ["a prototype-chain background", (j) => mutateOp(j, (o) => { o.parameters = { ...o.parameters, background: "toString" }; }), "background must be one of"],
    ["no text", (j) => mutateOp(j, (o) => { o.caption = null; }), "no text to show"],
    ["blank text", (j) => mutateOp(j, (o) => { o.caption = { text: "   ", start_s: 0, end_s: 1 }; }), "no text to show"],
    ["text with a tab", (j) => mutateOp(j, (o) => { o.caption = { text: "a\tb", start_s: 0, end_s: 1 }; }), "control characters"],
    ["text with a NUL", (j) => mutateOp(j, (o) => { o.caption = { text: "a\u0000b", start_s: 0, end_s: 1 }; }), "control characters"],
    ["text that is too long", (j) => mutateOp(j, (o) => { o.caption = { text: "x".repeat(121), start_s: 0, end_s: 1 }; }), "longer than 120"],
    ["a gap in the timeline", (j) => mutateOp(j, (o) => { o.timing = { start_s: o.timing.start_s + 1, duration_s: o.timing.duration_s }; }, 1), "gaps and overlaps are not rendered"],
    ["an overlap", (j) => mutateOp(j, (o) => { o.timing = { start_s: o.timing.start_s - 1, duration_s: o.timing.duration_s }; }, 2), "gaps and overlaps are not rendered"],
    ["a scene that is not whole frames", (j) => mutateOp(j, (o) => { o.timing = { start_s: o.timing.start_s, duration_s: 4.01 }; }), "whole number of frames"],
    ["a timeline shorter than the settings", (j) => { j.operations.pop(); }, "but the settings say 30s"],
    ["no operations", (j) => { j.operations = []; }, "no operations to render"],
    ["another container", (j) => { j.settings = { ...j.settings, container: "mov" }; }, "mp4 with h264, not mov"],
    ["another codec", (j) => { j.settings = { ...j.settings, container: "webm", video_codec: "vp9", audio_codec: null }; }, "mp4 with h264"],
    ["an audio track", (j) => { j.settings = { ...j.settings, audio_codec: "aac" }; }, "writes no audio"],
    ["an output outside the output folder", (j) => { j.output_path = join(tmp, "elsewhere", "rn_0123456789abcdef.mp4"); }, "not a render file inside the output folder"],
    ["an output that walks out of the folder", (j) => { j.output_path = join(outputRoot, "..", "rn_0123456789abcdef.mp4"); }, "not a render file inside the output folder"],
    ["an output with another name or extension", (j) => { j.output_path = join(outputRoot, "video.mkv"); }, "not a render file"],
  ])("refuses %s before FFmpeg runs", (_n, change, text) => {
    const j = jobOf(); change(j);
    expect(issuesOf(j).join(" | ")).toContain(text);
  });

  it("rejects a job without starting FFmpeg: the adapter throws, nothing is written", async () => {
    const j = jobOf(); mutateOp(j, (o) => { o.parameters = { ...o.parameters, background: "nope" }; });
    const a = createFfmpegAdapter({ fontFile: font!, outputRoot, ffmpegPath: join(tmp, "must-not-run.exe") });
    await expect(a.render({ ...j, signal: new AbortController().signal })).rejects.toThrow(/rejected before ffmpeg ran/);
    expect(existsSync(j.output_path)).toBe(false);
  });

  it("refuses a font that is missing or not a font file", () => {
    expect(() => createFfmpegAdapter({ fontFile: join(tmp, "missing.ttf"), outputRoot })).toThrow(/not found/);
    expect(() => createFfmpegAdapter({ fontFile: font!.replace(/\.\w+$/, ".txt"), outputRoot })).toThrow(/\.ttf or \.otf/);
  });

  it("wraps long text instead of running off the frame", () => {
    const j = jobOf(); mutateOp(j, (o) => { o.caption = { text: "A long approved sentence that has to be wrapped onto more than one line.", start_s: 0, end_s: 1 }; });
    const p = planTextCards(j, { outputRoot });
    expect(p.ok && p.scenes[0]!.lines.length).toBeGreaterThan(1);
    expect(p.ok && p.scenes[0]!.lines.join(" ")).toBe("A long approved sentence that has to be wrapped onto more than one line.");
  });
});

describe.skipIf(skipReal(!!font))("failures are never successes", () => {
  it("is failed when FFmpeg cannot run at all", async () => {
    const a = new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot, ffmpegPath: join(tmp, "no-such-ffmpeg.exe") })]);
    const rec = await executeRender(plan({}, a).plan!);
    expect(rec).toMatchObject({ state: "failed", output: null });
    expect(rec.errors[0]).toMatchObject({ stage: "adapter" });
    expect(rec.errors[0]!.message).toContain("ffmpeg failed");
  });

  it("is failed, with no file left behind, when FFmpeg itself fails (an unreadable font)", async () => {
    const bad = join(tmp, "bad.ttf");
    writeFileSync(bad, "this is not a font");
    const a = new AdapterRegistry([createFfmpegAdapter({ fontFile: bad, outputRoot })]);
    const p = plan({}, a).plan!;
    const rec = await executeRender(p);
    expect(rec).toMatchObject({ state: "failed", output: null });
    expect(rec.errors[0]!.stage).toBe("adapter");
    expect(existsSync(p.job.output_path)).toBe(false);
  }, 60_000);

  it("is failed on timeout, FFmpeg is stopped, and no partial file remains", async () => {
    const p = plan().plan!;
    const rec = await executeRender(p, { timeoutMs: 1 });
    expect(rec).toMatchObject({ state: "failed", output: null });
    expect(rec.errors[0]!.stage).toBe("timeout");
    for (let i = 0; i < 40 && existsSync(p.job.output_path); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(p.job.output_path)).toBe(false);
  }, 60_000);

  it("is failed when a file at the output path was not written by this render", async () => {
    const p = plan().plan!;
    writeFileSync(p.job.output_path, "someone else's file");
    const rec = await executeRender(p);
    expect(rec).toMatchObject({ state: "failed", output: null });
    expect(rec.errors[0]!.message).toContain("already exists");
    expect(readFileSync(p.job.output_path, "utf8")).toBe("someone else's file");
  });
});

describe.skipIf(skipReal(!!font))("the Director's and Editor's checks still run in front of the adapter", () => {
  it("rejects a handoff changed after approval, and Editor text changed after approval", () => {
    const edited = { ...handoff, constraints: { ...handoff.constraints, platform: "Somewhere else" } };
    const r1 = planRender({ editor_output: output, handoff: edited, settings, purpose: "preview" }, rdeps());
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.stage).toBe("handoff");
    const ops = structuredClone((output as { operations: EditorOperation[] }).operations);
    ops[0]!.caption = { text: "Totally different words", start_s: 0, end_s: 4 };
    const r2 = planRender({ editor_output: { ...(output as object), operations: ops }, handoff, settings, purpose: "preview" }, rdeps());
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reasons.join(" ")).toContain("caption text is not the approved overlay text");
  });

  it("stays in planning without settings, with the adapter registered", () => {
    const r = plan({ settings: undefined });
    expect(r.record.state).toBe("planning");
    expect(r.record.blockers.join(" ")).toContain("no output settings were supplied");
  });
});
