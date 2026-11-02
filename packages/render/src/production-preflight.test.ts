import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  Asset, EditPlan, PreflightResult, Scene, ScenePlan, assetFeasibility, deriveProductionMethod, preflightResultHash, productionPlanHash, productionSelectionHash,
  type PreflightSceneResult, type Renderer,
} from "@digikon/contracts";
import {
  PICTURE_OPERATIONS, PreflightRefusedError, attachPreflight, compileProduction, generateProductionPlan, producesScenePicture, produceProduction,
  type PreflightRequest, type ProductionPort,
} from "@digikon/director";
import { KeywordRetriever, recipeDocs } from "@digikon/rag";
import { RecipeLibrary } from "@digikon/recipes";
import {
  sealPreflightResult, AdapterRegistry, CAPABILITY_CATALOG, CapabilityRegistry, EXAMPLE_ART_DIRECTION, EXAMPLE_VISUALS, createFfmpegAdapter, createRemotionAdapter, declaredImplementations, findRemotionBrowser,
  implementationsOf, loadCapabilityRegistry, loadVisualCapabilities, runAdapterPreflight, stubAdapters, liveImplementations,
} from "./index.js";
import { goodStoryboard, knowledge, learnProject, project, recipes, root, use } from "../../director/src/fixtures.js";

// ---------- shared setup ----------
const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
const hasReal = !!font && !!findRemotionBrowser();
const CH = "f".repeat(64); // stands in for the compiled plan hash the result was produced over
const attach = (p: Parameters<typeof attachPreflight>[0], r: unknown) => attachPreflight(p, r, CH);
const tmp = mkdtempSync(join(tmpdir(), "production-preflight-"));
const out = join(tmp, "out");
mkdirSync(out);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const pic = join(tmp, "pic.png"), vid = join(tmp, "clip.mp4");
writeFileSync(pic, PNG);
writeFileSync(vid, "not a real video; the planners only look at the media type and the path");
const IMG = Asset.parse({ asset_id: "asset_pic1", uri: pic, media_type: "image", duration: null, width: 800, height: 600 });
const VID = Asset.parse({ asset_id: "asset_vid1", uri: vid, media_type: "video", duration: 10, width: 1280, height: 720 });
const resolvedFile = (id: string) => ({ asset_id: id, path: pic, variant: "original" as const, sha256: "a".repeat(64), width: 800, height: 600, transparent: false, background: null, colours: [] });

const capDir = join(root(""), "capabilities");
const learned = loadCapabilityRegistry(capDir, { dependency: () => null, recipes: { get: (id) => recipes.find((r) => r.recipe_id === id) } });
const visual = loadVisualCapabilities(capDir);
const DECL = declaredImplementations(learned.usable);
const library = new RecipeLibrary(recipes, "draft");
const retriever = new KeywordRetriever([...recipeDocs(recipes), ...knowledge]);
const deps = { recipes: library, retriever, now: () => new Date("2026-10-31T12:00:00.000Z") };
const SB = { version: 1, hash: "b".repeat(64) };

const raw = (id: string, extra: Record<string, unknown> = {}) => ({ scene_id: id, purpose: "p", duration_seconds: 4, shot: { shot_size: "wide", camera_motion: "static", visual_action: "x" }, transition_out: "cut", ...extra });
const scenePlan = (scenes: Record<string, unknown>[], project_id = "learn1"): ScenePlan => {
  let t = 0;
  return ScenePlan.parse({ project_id, version: 1, scenes: scenes.map((s) => { const start = t; t += s.duration_seconds as number; const b = Scene.parse({ ...s, start_time: start, end_time: t, production_method: null }); return { ...b, production_method: deriveProductionMethod(b) }; }) });
};
const text = (t: string) => ({ text: t, safe_area: "platform_safe" });
const editPlan = (uses: unknown[]) => EditPlan.parse({ project_id: "learn1", version: 1, uses });
const sourceOf = (sp: ScenePlan, ep: EditPlan, assets: Asset[]) => ({
  project: (({ owner_id: _o, ...p }) => p)(learnProject), storyboard: sp, edit_plan: ep, assets,
  asset_feasibility: { blockers: assetFeasibility(sp, assets).blockers }, constraints: { platform: learnProject.platform, aspect_ratio: learnProject.aspect_ratio },
});

/** A registry and port built from real adapters (the real planners run in `adapter.check`). Needs a font and a Remotion browser; nothing is rendered and no FFmpeg binary is used. */
function realKit() {
  const composed = CAPABILITY_CATALOG.filter((c) => c.engine === "remotion" && c.family !== "xfade_transition").map((c) => ({ template: c.template, family: c.family as never, type: c.operation_type as never, motion: c.motion ?? "" }));
  const transitions = CAPABILITY_CATALOG.filter((c) => c.engine === "ffmpeg").map((c) => ({ template: c.template, storyboard_transition: c.storyboard_transition, xfade: c.xfade, direction_map: c.direction_map }));
  const adapters = new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot: out, learned: transitions }), createRemotionAdapter({ fontFile: font!, outputRoot: out, learned: composed })]);
  const registry = CapabilityRegistry.from({ recipes, learned, visual, implementations: implementationsOf(adapters), declared: DECL });
  const port: ProductionPort = {
    capabilities: () => ({ snapshot: registry.snapshot, available_engines: adapters.renderers() as Renderer[] }),
    preflight: (req) => runAdapterPreflight(req as PreflightRequest, { adapters, outputRoot: out, assetFiles: (id) => resolvedFile(id) }),
  };
  return { adapters, registry, port };
}
const produce = (port: ProductionPort, scenes: Record<string, unknown>[], uses: unknown[], assets: Asset[] = [IMG]) => {
  const sp = scenePlan(scenes), ep = editPlan(uses);
  return produceProduction({ source: sourceOf(sp, ep, assets), scenePlan: sp, storyboard: SB, editPlan: ep, assets, art_direction: EXAMPLE_ART_DIRECTION }, port, deps);
};

// ---------- the real S06 evidence, as the reference ----------
describe("the S06 evidence this regression is modelled on", () => {
  const evidence = JSON.parse(readFileSync(join(root(""), "docs/assets/evidence/third-pass-s06-refused-delivery.json"), "utf8"));
  const qa = readFileSync(join(root(""), "capabilities/visual/qa-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.session === "fb604e5138b0");
  const s06 = evidence.scenes.find((x: { scene_id: string }) => x.scene_id === "S06");
  it("is the real delivery record: S06 was drawn by scene-composition, refused by the Remotion adapter, and shown as a placeholder slate", () => {
    expect(evidence.render_id).toBe("rn_477841b65b624cbf");
    expect(s06).toMatchObject({ status: "placeholder", engine: null });
    expect(s06.operations[0]).toMatchObject({ recipe_id: "scene-composition", template: "remotion/scene-composition", status: "validated_available" }); // registered and "validated", and still refused
    expect(s06.omitted_reason).toContain("would cover the scene's text; move it, make it smaller or give the scene to asset_stage");
    expect(evidence.decision.final).toBe(false);
  });
  it("is logged as a critical visual finding for session fb604e5138b0", () => {
    expect(qa.findings[0]).toMatchObject({ finding_id: "VQ01", scene_id: "S06", severity: "critical" });
  });
  it.skipIf(!hasReal)("the pre-flight reproduces that refusal (with a synthetic fixture, not the original run) before approval", async () => {
    const ex = EXAMPLE_VISUALS.kinetic_type;
    const o = await produce(realKit().port, [raw("S01", { asset_ids: ["asset_pic1"], visual: ex.visual, visual_purpose: "synthetic S06-style fixture", overlay: text(ex.overlay_text ?? "Words"), asset_refs: [{ asset_id: "asset_pic1", role: "logo", placement: "top_right", scale: 0.2, fit: "contain", crop: null, layer: 1, animation: "none", frame: "none", mandatory: true, reason: "synthetic S06-style fixture" }] })], [use(1, "S01", "scene-composition")]);
    const tail = s06.omitted_reason.slice(s06.omitted_reason.indexOf("would cover"));
    expect(o.plan.preflight.scenes[0]!.diagnostics.join(" ")).toContain(tail);
    expect(["validated", "executable"]).toContain(o.plan.decisions[0]!.readiness); // the registry alone sees nothing wrong, as in the original run
    expect(o.ready).toBe(false);
  });
});

// ---------- the scene picture rule ----------
describe("which operations produce a scene's picture", () => {
  const bare = { asset_ids: [] as string[] }, withImage = { asset_ids: ["asset_pic1"] };
  const d = (verdict: "executable" | "blocked" | "executable_with_substitute", ...operations: ("trim_clip" | "render_graphics_scene" | "overlay_text" | "concat" | "mix_audio")[]) => ({ verdict, operations });
  it("classifies every operation type by what the renderers do", () => {
    expect(PICTURE_OPERATIONS).toEqual({ render_graphics_scene: "scene", trim_clip: "shows_asset", overlay_text: "text_only", concat: "none", mix_audio: "none" });
  });
  it("valid visual-producing operations count", () => {
    expect(producesScenePicture(d("executable", "render_graphics_scene"), bare, [])).toBe(true);
    expect(producesScenePicture(d("executable", "trim_clip"), withImage, [IMG])).toBe(true);
    expect(producesScenePicture(d("executable", "overlay_text"), bare, [])).toBe(true); // text on a plain card
  });
  it("text over a supplied picture is not the scene's picture: something else has to show the picture", () => {
    expect(producesScenePicture(d("executable", "overlay_text"), withImage, [IMG])).toBe(false);
    expect(producesScenePicture(d("executable", "overlay_text"), withImage, [Asset.parse({ ...IMG, asset_id: "asset_pic1", media_type: "audio", uri: "a.mp3", duration: 3, width: null, height: null })])).toBe(true); // audio is not a picture
  });
  it("transitions and audio never count", () => {
    expect(producesScenePicture(d("executable", "concat"), bare, [])).toBe(false);
    expect(producesScenePicture(d("executable", "mix_audio"), bare, [])).toBe(false);
  });
  it("a blocked decision never counts", () => {
    expect(producesScenePicture(d("blocked", "render_graphics_scene"), bare, [])).toBe(false);
    expect(producesScenePicture(d("blocked", "trim_clip"), withImage, [IMG])).toBe(false);
  });
  it("a decision that depends on a substitute never counts", () => {
    expect(producesScenePicture(d("executable_with_substitute", "render_graphics_scene"), bare, [])).toBe(false);
  });
  it("a scene whose only candidate picture is a transition, audio or a blocked use is reported as having no picture", () => {
    const stub = stubAdapters(DECL);
    const reg = CapabilityRegistry.from({ recipes, learned, visual, implementations: implementationsOf(stub), declared: DECL });
    const sp = scenePlan([raw("S01", { overlay: text("Hello there") }), raw("S02", { overlay: text("Again") })]);
    const p = generateProductionPlan(reg.snapshot, { scenePlan: sp, storyboard: SB, editPlan: editPlan([use(1, "S01", "crossfade", { duration_s: 0.6 }), use(2, "S02", "static-hold"), use(3, "S02", "loudness-normalise")]), assets: [], aspect_ratio: "16:9", available_engines: ["ffmpeg", "remotion", "hyperframes"] });
    expect(p.unresolved.filter((u) => u.kind === "scene_picture").map((u) => u.scene_id)).toEqual(["S01", "S02"]);
    expect(p.scenes.every((s) => s.verdict === "blocked")).toBe(true);
  });
});

// ---------- the pre-flight state and what may set it ----------
describe("the pre-flight state on a plan", () => {
  const stub = stubAdapters(DECL);
  const reg = CapabilityRegistry.from({ recipes, learned, visual, implementations: implementationsOf(stub), declared: DECL });
  const sp = scenePlan([raw("S01", { overlay: text("Hello there") })]);
  const ep = editPlan([use(1, "S01", "text-fade-up")]);
  const plan = generateProductionPlan(reg.snapshot, { scenePlan: sp, storyboard: SB, editPlan: ep, assets: [], aspect_ratio: "16:9", available_engines: ["ffmpeg", "remotion", "hyperframes"], now: () => new Date("2026-10-31T12:00:00.000Z") });
  const ok = (over: Partial<PreflightSceneResult> = {}): PreflightSceneResult => ({ scene_id: "S01", status: "passed", kind: "ok", engine: "remotion", planner: "remotion adapter.check", template_refs: ["remotion/text-fade-up"], job_fingerprint: "c".repeat(64), diagnostics: [], ...over });
  const seal = (scenes: PreflightSceneResult[], status: "passed" | "failed" = "passed", bound = productionSelectionHash(plan)) => sealPreflightResult({ bound_compiled_hash: CH, status, frame: { width: 960, height: 540, fps: 30 }, bound_selection_hash: bound, scenes });

  it("every new plan starts not_run and is not clear, even when every decision is executable", () => {
    expect(plan.preflight).toEqual({ status: "not_run", frame: null, bound_selection_hash: null, bound_compiled_hash: null, scenes: [], result_hash: null });
    expect(plan.decisions.every((d) => d.verdict === "executable")).toBe(true);
    expect(plan.summary.clear).toBe(false);
  });
  it("a real passed result makes the plan clear and is part of the plan hash", () => {
    const passed = attach(plan, seal([ok()]));
    expect(passed.preflight.status).toBe("passed");
    expect(passed.summary.clear).toBe(true);
    expect(passed.plan_hash).not.toBe(plan.plan_hash);
    expect(productionPlanHash(passed)).toBe(passed.plan_hash);
    expect(productionSelectionHash(passed)).toBe(productionSelectionHash(plan)); // attaching changes no selection
  });
  it("the diagnostics are in the hash: the same pass with a different frame size or planner note is a different plan", () => {
    const a = attach(plan, seal([ok()]));
    const b = attach(plan, sealPreflightResult({ bound_compiled_hash: CH, status: "passed", frame: { width: 540, height: 960, fps: 30 }, bound_selection_hash: productionSelectionHash(plan), scenes: [ok()] }));
    expect(a.plan_hash).not.toBe(b.plan_hash);
  });
  it("a failed result keeps the plan unclear and blocks the scene", () => {
    const failed = attach(plan, seal([ok({ status: "failed", kind: "refused", diagnostics: ["picture would cover the scene's text"] })], "failed"));
    expect(failed.summary.clear).toBe(false);
    expect(failed.scenes[0]!.verdict).toBe("blocked");
    expect(failed.preflight.scenes[0]!.diagnostics.join(" ")).toContain("would cover the scene's text");
  });
  it("cannot be asserted: a pass with no planner, no job, or diagnostics is rejected by the contract", () => {
    for (const bad of [ok({ planner: null }), ok({ job_fingerprint: null }), ok({ diagnostics: ["x"] }), ok({ kind: "refused" })]) expect(() => seal([bad])).toThrow();
    expect(() => seal([ok({ status: "not_applicable", kind: "no_operation", planner: null, job_fingerprint: null, template_refs: [] })])).toThrow(); // nothing planned is not a pass
  });
  it("cannot be forged by editing a field: the result hash must match", () => {
    const good = seal([ok()]);
    expect(() => attach(plan, { ...good, scenes: [ok({ job_fingerprint: "d".repeat(64) })] })).toThrow(PreflightRefusedError);
    expect(() => attach(plan, { ...good, status: "failed" })).toThrow(PreflightRefusedError);
    expect(PreflightResult.safeParse({ status: "passed", frame: null, bound_selection_hash: null, scenes: [ok()], result_hash: null }).success).toBe(false);
  });
  it("must be bound to this plan's selection, name only its scenes, and use the templates it selected", () => {
    expect(() => attach(plan, seal([ok()], "passed", "e".repeat(64)))).toThrow(/different selection/);
    expect(() => attach(plan, seal([ok(), ok({ scene_id: "S09" })]))).toThrow(/S09/);
    expect(() => attach(plan, seal([ok({ template_refs: ["remotion/other"] })]))).toThrow(/different templates/);
    expect(() => attach(plan, seal([]) )).toThrow();
  });
  it("not_run cannot be recorded as a result", () => {
    expect(() => attach(plan, { status: "not_run", frame: null, bound_selection_hash: null, scenes: [], result_hash: null })).toThrow(/not run/);
  });
  it("the result hash function is deterministic", () => {
    const body = { status: "passed" as const, frame: { width: 960, height: 540, fps: 30 }, bound_selection_hash: "a".repeat(64), scenes: [ok()] };
    expect(preflightResultHash(body)).toBe(preflightResultHash(structuredClone(body)));
  });
});

// ---------- the trusted pre-flight, through the real adapters' own planners ----------
describe.skipIf(!hasReal)("the trusted pre-flight runs the real adapter planners (no render, no FFmpeg binary)", () => {
  const kit = hasReal ? realKit() : null!;
  it("a clean supported scene passes, and the plan is clear", async () => {
    const o = await produce(kit.port, [raw("S01", { asset_ids: ["asset_pic1"] })], [use(1, "S01", "slow-push-in")]);
    expect(o.blockers).toEqual([]);
    expect(o.plan.preflight.status).toBe("passed");
    expect(o.plan.preflight.scenes[0]).toMatchObject({ status: "passed", kind: "ok", engine: "remotion", planner: "remotion adapter.check", template_refs: ["remotion/slow-push-in"] });
    expect(o.plan.preflight.scenes[0]!.job_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(o.plan.summary.clear).toBe(true);
    expect(o.compiled.status).toBe("ready");
    expect(o.ready).toBe(true);
  });
  it("text on a graphics-only scene passes", async () => {
    const o = await produce(kit.port, [raw("S01", { overlay: text("One calm place to learn.") })], [use(1, "S01", "text-fade-up")], []);
    expect(o.ready, o.blockers.join("\n")).toBe(true);
  });
  it("is deterministic: the same inputs give the same plan hash and the same job fingerprint", async () => {
    const run = () => produce(kit.port, [raw("S01", { asset_ids: ["asset_pic1"] })], [use(1, "S01", "slow-push-in")]);
    const a = await run(), b = await run();
    expect(b.plan.plan_hash).toBe(a.plan.plan_hash);
    expect(b.plan.preflight.scenes[0]!.job_fingerprint).toBe(a.plan.preflight.scenes[0]!.job_fingerprint);
    expect(b.compiled.compiled_hash).toBe(a.compiled.compiled_hash);
  });
  it("an unused supplied picture is refused although the registry sees nothing wrong", async () => {
    const o = await produce(kit.port, [raw("S01", { asset_ids: ["asset_pic1"], overlay: text("Order your first bag") })], [use(1, "S01", "end-card-cta")]);
    expect(o.plan.decisions.every((d) => d.verdict === "executable")).toBe(true); // registry compatibility alone says yes
    expect(o.plan.preflight.status).toBe("failed");
    expect(o.plan.preflight.scenes[0]).toMatchObject({ status: "failed", kind: "refused" });
    expect(o.plan.preflight.scenes[0]!.diagnostics.join(" ")).toContain("is not shown by any operation");
    expect(o.plan.summary.clear).toBe(false);
    expect(o.ready).toBe(false);
    expect(o.blockers.join(" ")).toContain("planner refuses");
  });
  it("a video under a composed camera move is refused", async () => {
    const o = await produce(kit.port, [raw("S01", { asset_ids: ["asset_vid1"] })], [use(1, "S01", "slow-push-in")], [VID]);
    expect(o.plan.preflight.status).toBe("failed");
    expect(o.plan.preflight.scenes[0]!.diagnostics.join(" ")).toMatch(/only an image can be/);
  });
  it("an invalid combination in one scene is refused", async () => {
    const o = await produce(kit.port, [raw("S01", { asset_ids: ["asset_pic1"], overlay: text("Hello there") })], [use(1, "S01", "slow-push-in"), use(2, "S01", "end-card-cta")]);
    expect(o.plan.preflight.status).toBe("failed");
    expect(o.plan.preflight.scenes[0]!.diagnostics.join(" ")).toMatch(/not a validated combination/);
  });
  it("operations that need two engines in one scene are refused", async () => {
    const o = await produce(kit.port, [raw("S01", { asset_ids: ["asset_pic1"], overlay: text("Hello there") })], [use(1, "S01", "image-scene"), use(2, "S01", "text-fade-up")]);
    expect(o.plan.preflight.scenes[0]).toMatchObject({ status: "failed", kind: "cross_engine" });
    expect(o.plan.preflight.scenes[0]!.diagnostics.join(" ")).toContain("more than one engine");
  });
  it("is not run on a selection that is already blocked, and a plan whose pre-flight did not run is never clear", async () => {
    const o = await produce(kit.port, [raw("S01", { overlay: text("Hello there") })], [use(1, "S01", "loudness-normalise")], []);
    expect(o.plan.preflight.status).toBe("not_run");
    expect(o.plan.summary.clear).toBe(false);
    expect(o.blockers.join(" ")).toContain("pre-flight was not run");
  });
  it("detects the S06-style composition refusal before approval, and a clean composition passes", async () => {
    const mk = (block: "kinetic_type" | "message_thread") => {
      const ex = EXAMPLE_VISUALS[block];
      return raw("S01", { asset_ids: ["asset_pic1"], visual: ex.visual, visual_purpose: "test", overlay: text(ex.overlay_text ?? "Words"), asset_refs: [{ asset_id: "asset_pic1", role: "logo", placement: "top_right", scale: 0.2, fit: "contain", crop: null, layer: 1, animation: "none", frame: "none", mandatory: true, reason: "synthetic S06-style fixture" }], shot: { shot_size: "wide", camera_motion: "static", visual_action: "x" } });
    };
    const bad = await produce(kit.port, [mk("kinetic_type")], [use(1, "S01", "scene-composition")]);
    expect(bad.plan.decisions[0]).toMatchObject({ verdict: "executable", variant: expect.objectContaining({ capability_id: "remotion:scene-composition:kinetic_type" }) });
    expect(bad.plan.preflight.status).toBe("failed");
    expect(bad.plan.preflight.scenes[0]!.diagnostics.join(" ")).toContain("would cover the scene's text; move it, make it smaller or give the scene to asset_stage");
    expect(bad.ready).toBe(false);
    const good = await produce(kit.port, [mk("message_thread")], [use(1, "S01", "scene-composition")]);
    expect(good.blockers).toEqual([]);
    expect(good.plan.preflight.status).toBe("passed");
    expect(good.ready).toBe(true);
  });
  it("a changed selected capability invalidates the plan; an unrelated change does not invalidate the relevant-capability hash", async () => {
    const o = await produce(kit.port, [raw("S01", { asset_ids: ["asset_pic1"] })], [use(1, "S01", "slow-push-in")]);
    const sp = scenePlan([raw("S01", { asset_ids: ["asset_pic1"] })]);
    const input = { scenePlan: sp, storyboard: SB, editPlan: editPlan([use(1, "S01", "slow-push-in")]), assets: [IMG], aspect_ratio: "16:9" as const, available_engines: ["ffmpeg", "remotion"] as Renderer[], now: () => new Date("2026-10-31T12:00:00.000Z") };
    const other = CapabilityRegistry.from({ recipes: recipes.map((r) => (r.recipe_id === "title-subtitle" ? { ...r, purpose: r.purpose + " (edited)" } : r)), learned, visual, implementations: implementationsOf(kit.adapters), declared: DECL });
    expect(generateProductionPlan(other.snapshot, input).registry.relevant_capabilities_hash).toBe(o.plan.registry.relevant_capabilities_hash);
    const changed = CapabilityRegistry.from({ recipes: recipes.map((r) => (r.recipe_id === "slow-push-in" ? { ...r, purpose: r.purpose + " (edited)" } : r)), learned, visual, implementations: implementationsOf(kit.adapters), declared: DECL });
    expect(generateProductionPlan(changed.snapshot, input).registry.relevant_capabilities_hash).not.toBe(o.plan.registry.relevant_capabilities_hash);
  });
});

// ---------- missing adapters ----------
describe("missing adapters cannot produce a clear plan", () => {
  const none = new AdapterRegistry();
  const reg = CapabilityRegistry.from({ recipes, learned, visual, implementations: implementationsOf(none), declared: DECL, adapter_failures: (["ffmpeg", "remotion", "hyperframes"] as const).map((engine) => ({ engine, reason: "not available here" })) });
  const port: ProductionPort = {
    capabilities: () => ({ snapshot: reg.snapshot, available_engines: [] }),
    preflight: () => { throw new Error("the pre-flight must not be asked to vouch for a plan nothing can run"); },
  };
  it("nothing is executable, the pre-flight is never run, and the outcome is not ready", async () => {
    const o = await produce(port, [raw("S01", { overlay: text("Hello there") })], [use(1, "S01", "text-fade-up")], []);
    expect(o.plan.decisions[0]!.verdict).toBe("blocked");
    expect(o.plan.preflight.status).toBe("not_run");
    expect(o.plan.summary.clear).toBe(false);
    expect(o.ready).toBe(false);
  });
  it("a pre-flight that crashes fails closed: the plan stays not_run and is not clear", async () => {
    const live = CapabilityRegistry.from({ recipes, learned, visual, implementations: implementationsOf(stubAdapters(DECL)), declared: DECL });
    const crashing: ProductionPort = { capabilities: () => ({ snapshot: live.snapshot, available_engines: ["ffmpeg", "remotion", "hyperframes"] }), preflight: () => { throw new Error("the planner crashed"); } };
    const o = await produce(crashing, [raw("S01", { overlay: text("Hello there") })], [use(1, "S01", "text-fade-up")], []);
    expect(o.plan.preflight.status).toBe("not_run");
    expect(o.plan.summary.clear).toBe(false);
    expect(o.ready).toBe(false);
    expect(o.blockers.join(" ")).toContain("pre-flight could not run: the planner crashed");
  });
  it("an adapter that offers no check cannot pass a scene", () => {
    const adapters = new AdapterRegistry([{ renderer: "remotion", templates: { "remotion/text-slide": ["render_graphics_scene"] }, render: async () => undefined }]);
    const sp = scenePlan([raw("S01", { overlay: text("Hello there") })]);
    const ep = editPlan([use(1, "S01", "text-slide-remotion")]);
    const registry = CapabilityRegistry.from({ recipes, learned, visual, implementations: implementationsOf(adapters), declared: DECL });
    const plan = generateProductionPlan(registry.snapshot, { scenePlan: sp, storyboard: SB, editPlan: ep, assets: [], aspect_ratio: "16:9", available_engines: ["remotion"] });
    return compileProduction(sourceOf(sp, ep, []), plan, deps).then((compiled) => {
      const r = runAdapterPreflight({ scenePlan: sp, assets: [], art_direction: EXAMPLE_ART_DIRECTION, operations: compiled.operations, templates: { E01: "remotion/text-slide" }, aspect_ratio: "16:9", selection_hash: productionSelectionHash(plan), compiled_hash: compiled.compiled_hash }, { adapters, outputRoot: out });
      expect(r.status).toBe("failed");
      expect(r.scenes[0]!.diagnostics.join(" ")).toContain("offers no pre-flight check");
    });
  });
});

// ---------- compilation ----------
describe("compileProduction", () => {
  const stub = stubAdapters(DECL);
  const reg = CapabilityRegistry.from({ recipes, learned, visual, implementations: implementationsOf(stub), declared: DECL });
  const sp = scenePlan([raw("S01", { overlay: text("Hello there"), transition_out: "crossfade" }), raw("S02", { overlay: text("Again") })]);
  const gen = (ep: EditPlan) => generateProductionPlan(reg.snapshot, { scenePlan: sp, storyboard: SB, editPlan: ep, assets: [], aspect_ratio: "16:9", available_engines: ["ffmpeg", "remotion", "hyperframes"], now: deps.now });
  const GOOD = [use(1, "S01", "text-fade-up"), use(2, "S01", "crossfade", { duration_s: 0.6 }), use(3, "S02", "text-fade-up")];

  it("compiles every use into an operation with resolved parameters, keeping scenes, assets, copy and timing as approved", async () => {
    const ep = editPlan(GOOD);
    const c = await compileProduction(sourceOf(sp, ep, []), gen(ep), deps);
    expect(c.status).toBe("ready");
    expect(c.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(c.operations.map((o) => [o.operation_id, o.source_use_id, o.recipe_id, o.target_scene_id])).toEqual([["E01", "U01", "text-fade-up", "S01"], ["E02", "U02", "crossfade", "S01"], ["E03", "U03", "text-fade-up", "S02"]]);
    expect(c.operations[0]!.caption?.text).toBe("Hello there");
    expect(c.operations[0]!.parameters).toMatchObject({ delay_s: 0.2, duration_s: 0.5, distance_px: 24 }); // the recipe's defaults, resolved
    expect(c.operations.every((o) => o.timing.start_s >= 0)).toBe(true);
    expect(c.operations.every((o) => o.validation_status === "valid")).toBe(true);
  });
  it("is deterministic and bound to the production selection", async () => {
    const ep = editPlan(GOOD), plan = gen(ep);
    const a = await compileProduction(sourceOf(sp, ep, []), plan, deps), b = await compileProduction(sourceOf(sp, ep, []), plan, deps);
    expect(b.compiled_hash).toBe(a.compiled_hash);
    expect(a.production_selection_hash).toBe(productionSelectionHash(plan));
  });
  it("reports an out-of-range parameter instead of fixing it", async () => {
    const ep = editPlan([use(1, "S01", "text-fade-up", { distance_px: 9999 }), GOOD[1]!, GOOD[2]!]);
    const c = await compileProduction(sourceOf(sp, ep, []), gen(ep), deps);
    expect(c.status).toBe("blocked");
    expect(c.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["DECISION_NOT_EXECUTABLE"]));
  });
  it("refuses to compile a use the production plan found not executable", async () => {
    const ep = editPlan([...GOOD, use(4, "S02", "loudness-normalise")]);
    const c = await compileProduction(sourceOf(sp, ep, []), gen(ep), deps);
    expect(c.status).toBe("blocked");
    expect(c.diagnostics.some((d) => d.use_id === "U04" && d.severity === "error")).toBe(true);
  });
  it("asks for a revision when approved overlay text would not be shown, and does not invent an operation", async () => {
    const ep = editPlan([use(1, "S01", "crossfade", { duration_s: 0.6 }), use(2, "S02", "text-fade-up")]);
    const c = await compileProduction(sourceOf(sp, ep, []), gen(ep), deps);
    expect(c.status).toBe("needs_director_revision");
    expect(c.revision_requests[0]).toMatchObject({ target: "edit_plan", scene_ids: ["S01"], requires_reapproval: true });
    expect(c.operations).toHaveLength(2);
  });
  it("a compiled operation that differs from its decision is an error", async () => {
    const ep = editPlan(GOOD), plan = gen(ep);
    const tampered = structuredClone(plan);
    tampered.decisions[0]!.parameters.resolved["distance_px"] = 40;
    const c = await compileProduction(sourceOf(sp, ep, []), tampered, deps);
    expect(c.diagnostics.map((d) => d.code)).toContain("PARAMETER_MISMATCH");
    expect(c.status).toBe("blocked");
  });
  it("does not change the approved storyboard or Director plan", async () => {
    const ep = editPlan(GOOD);
    const before = JSON.stringify([sp, ep]);
    await compileProduction(sourceOf(sp, ep, []), gen(ep), deps);
    expect(JSON.stringify([sp, ep])).toBe(before);
  });
});

void goodStoryboard; void project; void liveImplementations;
