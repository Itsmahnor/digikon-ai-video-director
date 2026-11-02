import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  Asset, EditPlan, Scene, ScenePlan, deriveProductionMethod, productionPlanHash, productionSelectionHash,
  type EditorOperation, type PreflightSceneResult, type ProductionDecisionPlan,
} from "@digikon/contracts";
import { PreflightRefusedError, attachPreflight, editPlanNode, generateProductionPlan, validateProductionPlan, ScriptedClient, approveCurrent, buildDirectorGraph, type PlanningInput, type ProductionPort } from "@digikon/director";
import {
  sealPreflightResult, AdapterRegistry, CapabilityRegistry, RENDER_TIME_VALIDATIONS, approvedSelectionOf, conceptAssetIdsOf, declaredImplementations, implementationsOf, loadCapabilityRegistry, loadVisualCapabilities,
  planSceneJob, preflightSettings, runAdapterPreflight, selectionProblems, stubAdapters,
} from "./index.js";
import { cfg, deps, learnEdit, learnInput, learnProject, learnStoryboard, learnTreatment, recipes, root, use } from "../../director/src/fixtures.js";

const CH = "f".repeat(64); // stands in for the compiled plan hash the result was produced over
const attach = (p: Parameters<typeof attachPreflight>[0], r: unknown) => attachPreflight(p, r, CH);
const tmp = mkdtempSync(join(tmpdir(), "stage32-corrections-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const capDir = join(root(""), "capabilities");
const learned = loadCapabilityRegistry(capDir, { dependency: () => null, recipes: { get: (id) => recipes.find((r) => r.recipe_id === id) } });
const visual = loadVisualCapabilities(capDir);
const DECL = declaredImplementations(learned.usable);
const reg = CapabilityRegistry.from({ recipes, learned, visual, implementations: implementationsOf(stubAdapters(DECL)), declared: DECL });
const SB = { version: 1, hash: "b".repeat(64) };
const NOW = () => new Date("2026-10-31T12:00:00.000Z");

const raw = (id: string, extra: Record<string, unknown> = {}) => ({ scene_id: id, purpose: "p", duration_seconds: 4, shot: { shot_size: "wide", camera_motion: "static", visual_action: "x" }, transition_out: "cut", ...extra });
const text = (t: string) => ({ text: t, safe_area: "platform_safe" });
const scenePlan = (scenes: Record<string, unknown>[]): ScenePlan => {
  let t = 0;
  return ScenePlan.parse({ project_id: "learn1", version: 1, scenes: scenes.map((s) => { const start = t; t += s.duration_seconds as number; const b = Scene.parse({ ...s, start_time: start, end_time: t, production_method: null }); return { ...b, production_method: deriveProductionMethod(b) }; }) });
};
const editPlan = (uses: unknown[]) => EditPlan.parse({ project_id: "learn1", version: 1, uses });
const input = (sp: ScenePlan, ep: EditPlan, assets: Asset[] = []): PlanningInput => ({ scenePlan: sp, storyboard: SB, editPlan: ep, assets, aspect_ratio: "16:9", available_engines: ["ffmpeg", "remotion", "hyperframes"], now: NOW });

// ---------- Fix 1 (T-1) and Fix 5 (H-2): the pre-flight must cover every picture scene, and the derived fields must be what the decisions imply ----------
describe("attachPreflight: every picture-producing scene needs a planner's verdict", () => {
  const sp = scenePlan([raw("S01", { overlay: text("Hello there") }), raw("S02", { overlay: text("Again") })]);
  const ep = editPlan([use(1, "S01", "text-fade-up"), use(2, "S02", "text-fade-up")]);
  const inp = input(sp, ep);
  const plan = generateProductionPlan(reg.snapshot, inp);
  const ok = (scene_id: string, over: Partial<PreflightSceneResult> = {}): PreflightSceneResult => ({ scene_id, status: "passed", kind: "ok", engine: "remotion", planner: "remotion adapter.check", template_refs: ["remotion/text-fade-up"], job_fingerprint: "c".repeat(64), diagnostics: [], ...over });
  const notApplicable = (scene_id: string): PreflightSceneResult => ({ scene_id, status: "not_applicable", kind: "no_operation", engine: null, planner: null, template_refs: [], job_fingerprint: null, diagnostics: ["no operation produces this scene's picture"] });
  const seal = (scenes: PreflightSceneResult[], status: "passed" | "failed" = "passed") => sealPreflightResult({ bound_compiled_hash: CH, status, frame: { width: 960, height: 540, fps: 30 }, bound_selection_hash: productionSelectionHash(plan), scenes });

  it("baseline: both scenes passed makes the plan clear and it validates", () => {
    const p = attach(plan, seal([ok("S01"), ok("S02")]));
    expect(p.summary.clear).toBe(true);
    expect(validateProductionPlan(reg.snapshot, inp, p)).toMatchObject({ ok: true, issues: [] });
  });
  it("a missing scene result is refused", () => {
    expect(() => attach(plan, seal([ok("S01")]))).toThrow(/S02 has executable uses but no pre-flight record/);
  });
  it("a not_applicable result for a scene with an executable picture use is refused, even when another scene passed", () => {
    expect(() => attach(plan, seal([ok("S01"), notApplicable("S02")]))).toThrow(/S02.*not_applicable/);
    expect(() => attach(plan, seal([ok("S01"), notApplicable("S02")]))).toThrow(PreflightRefusedError);
  });
  it("a failed result is recorded as what it is: the plan is not clear, the scene is blocked, the diagnostics stay", () => {
    const p = attach(plan, seal([ok("S01"), ok("S02", { status: "failed", kind: "refused", diagnostics: ["text does not fit"] })], "failed"));
    expect(p.summary.clear).toBe(false);
    expect(p.scenes.find((s) => s.scene_id === "S02")!.verdict).toBe("blocked");
    expect(p.preflight.scenes.find((s) => s.scene_id === "S02")!.diagnostics).toEqual(["text does not fit"]);
    expect(validateProductionPlan(reg.snapshot, inp, p).ok).toBe(true); // an honest failed plan is consistent; it is simply not clear
  });
  it("the planner must have run on the engine the decisions selected", () => {
    expect(() => attach(plan, seal([ok("S01"), ok("S02", { engine: "ffmpeg" })]))).toThrow(/ran on ffmpeg.*selected remotion/);
  });
  it("a join-only scene may be not_applicable (it has no picture to draw)", () => {
    const sp2 = scenePlan([raw("S01", { overlay: text("Hello there") }), raw("S02", { overlay: text("Again") })]);
    const ep2 = editPlan([use(1, "S01", "text-fade-up"), use(2, "S02", "text-fade-up"), use(3, "S02", "crossfade", { duration_s: 0.6 })]);
    const inp2 = input(sp2, ep2);
    const pl = generateProductionPlan(reg.snapshot, inp2);
    const joinOnly = pl.decisions.filter((d) => d.scene_id === "S02" && d.operations.every((o) => o === "concat"));
    expect(joinOnly.length).toBe(1);
  });
});

describe("validateProductionPlan: derived fields are recomputed, not trusted", () => {
  const sp = scenePlan([raw("S01", { overlay: text("Hello there") })]);
  const ep = editPlan([use(1, "S01", "text-fade-up")]);
  const inp = input(sp, ep);
  const plan = generateProductionPlan(reg.snapshot, inp);
  const rehash = (p: Omit<ProductionDecisionPlan, "plan_hash">): ProductionDecisionPlan => ({ ...p, plan_hash: productionPlanHash(p as never) }) as ProductionDecisionPlan;

  it("an untouched plan validates", () => {
    expect(validateProductionPlan(reg.snapshot, inp, plan)).toMatchObject({ ok: true, issues: [] });
  });
  it("rejects summary.clear set to true by hand, even with the plan hash recomputed", () => {
    expect(plan.summary.clear).toBe(false);
    const forged = rehash({ ...plan, summary: { ...plan.summary, clear: true } });
    expect(productionPlanHash(forged)).toBe(forged.plan_hash); // the hash alone cannot catch it
    const v = validateProductionPlan(reg.snapshot, inp, forged);
    expect(v.ok).toBe(false);
    expect(v.issues.join(" ")).toMatch(/clear=true.*imply clear=false/);
  });
  it("rejects altered summary counts and scene rows", () => {
    const counts = rehash({ ...plan, summary: { ...plan.summary, blocked: 3 } });
    expect(validateProductionPlan(reg.snapshot, inp, counts).issues.join(" ")).toMatch(/summary counts/);
    const rows = rehash({ ...plan, scenes: plan.scenes.map((r) => ({ ...r, verdict: "blocked" as const })) });
    expect(validateProductionPlan(reg.snapshot, inp, rows).issues.join(" ")).toMatch(/scene rows/);
    const uses = rehash({ ...plan, scenes: plan.scenes.map((r) => ({ ...r, use_ids: [] })) });
    expect(validateProductionPlan(reg.snapshot, inp, uses).ok).toBe(false);
  });
  it("rejects a sealed pre-flight that waves a picture scene through as not_applicable, even with every hash recomputed", () => {
    const sp2 = scenePlan([raw("S01", { overlay: text("Hello there") }), raw("S02", { overlay: text("Again") })]);
    const inp2 = input(sp2, editPlan([use(1, "S01", "text-fade-up"), use(2, "S02", "text-fade-up")]));
    const plan2 = generateProductionPlan(reg.snapshot, inp2);
    const passedS01 = { scene_id: "S01", status: "passed" as const, kind: "ok" as const, engine: "remotion" as const, planner: "remotion adapter.check", template_refs: ["remotion/text-fade-up"], job_fingerprint: "c".repeat(64), diagnostics: [] };
    const sealed = sealPreflightResult({ bound_compiled_hash: CH, status: "passed", frame: { width: 960, height: 540, fps: 30 }, bound_selection_hash: productionSelectionHash(plan2), scenes: [
      passedS01, { scene_id: "S02", status: "not_applicable", kind: "no_operation", engine: null, planner: null, template_refs: [], job_fingerprint: null, diagnostics: ["nothing"] },
    ] });
    const forged = rehash({ ...plan2, preflight: sealed, summary: { ...plan2.summary, clear: true } });
    const v = validateProductionPlan(reg.snapshot, inp2, forged);
    expect(v.ok).toBe(false);
    expect(v.issues.join(" ")).toMatch(/S02.*not_applicable/);
  });
  it("a pre-flight bound to a different selection fails validation (real result, plan selection changed afterwards)", () => {
    const other = generateProductionPlan(reg.snapshot, input(sp, editPlan([use(1, "S01", "text-word-stagger")])));
    const boundToOther = sealPreflightResult({ bound_compiled_hash: CH, status: "passed", frame: { width: 960, height: 540, fps: 30 }, bound_selection_hash: productionSelectionHash(other), scenes: [
      { scene_id: "S01", status: "passed", kind: "ok", engine: "remotion", planner: "remotion adapter.check", template_refs: ["remotion/text-fade-up"], job_fingerprint: "c".repeat(64), diagnostics: [] },
    ] });
    const v = validateProductionPlan(reg.snapshot, inp, rehash({ ...plan, preflight: boundToOther }));
    expect(v.issues.join(" ")).toMatch(/different selection/);
  });
});

// ---------- Fix 5 (G-4): fail closed when a port is configured but the treatment is missing ----------
describe("a configured ProductionPort fails closed without the approved treatment", () => {
  const ready = { status: "ready", questions: [] };
  const text2 = (t: string) => ({ text: t, safe_area: "platform_safe" });
  const withText = learnStoryboard({ S03: { overlay: text2("Everything in one place.") }, S04: { overlay: text2("Your progress, at a glance.") }, S05: { overlay: text2("Learn at your own pace.") } });
  const GOOD_EDIT = { uses: [
    use(1, "S01", "text-fade-up"), use(2, "S02", "text-word-stagger"), use(3, "S03", "text-fade-up"), use(4, "S03", "crossfade", { duration_s: 0.6 }), use(5, "S04", "text-fade-up"),
    use(6, "S05", "text-word-stagger"), use(7, "S05", "crossfade", { duration_s: 0.6 }), use(8, "S06", "text-fade-up"),
  ] };
  const port = (): ProductionPort => ({
    capabilities: () => ({ snapshot: reg.snapshot, available_engines: ["ffmpeg", "remotion", "hyperframes"] }),
    preflight: () => { throw new Error("stub port: no planner is available"); },
  });
  it("with a port and no treatment the edit plan comes back with a production blocker and no production plan", async () => {
    const llm = new ScriptedClient([ready, learnTreatment(), withText, GOOD_EDIT, GOOD_EDIT, GOOD_EDIT]);
    const d = { ...deps(llm), production: port() };
    const g = buildDirectorGraph(d);
    const gate1 = await g.invoke(learnInput, cfg("s32-g4"));
    const sbPlan = gate1.scenePlan!;
    const r = (await editPlanNode(d, learnProject, [], sbPlan, 1, undefined, undefined)) as unknown as { production: unknown; issues: string[] };
    expect(r.production).toBeNull();
    expect(r.issues.join(" ")).toMatch(/production - the approved treatment is missing/);
  });
  it("without a port, the same call keeps the previous behaviour (no production issue)", async () => {
    const llm = new ScriptedClient([ready, learnTreatment(), withText, GOOD_EDIT, GOOD_EDIT]);
    const g = buildDirectorGraph({ ...deps(llm), production: port() });
    const gate1 = await g.invoke(learnInput, cfg("s32-g4b"));
    const r = (await editPlanNode(deps(new ScriptedClient([GOOD_EDIT])), learnProject, [], gate1.scenePlan!, 1, undefined, undefined)) as unknown as { production: unknown; issues: string[] };
    expect(r.production).toBeNull();
    expect(r.issues.join(" ")).not.toMatch(/production/);
    void approveCurrent;
  });
});

// ---------- Fix 2 (E-1): one concept_asset_ids definition ----------
describe("concept_asset_ids come from one function in the pre-flight, assembly and the render plan", () => {
  const SHOT = Asset.parse({ asset_id: "asset_ui01", uri: join(tmp, "ui.png"), media_type: "image", duration: null, width: 800, height: 600 });
  const GENUINE = Asset.parse({ ...SHOT, genuine_product_ui: true });
  const sceneWithUi = (extra: Record<string, unknown> = {}) => scenePlan([raw("S01", { asset_ids: ["asset_ui01"], required_assets: [{ need: "product screen", kind: "ui_screenshot", availability: "supplied", asset_id: "asset_ui01" }], ...extra })]);
  const op = (template: string): EditorOperation => ({
    operation_id: "E01", target_scene_id: "S01", operation_type: "trim_clip", parameters: {}, preconditions: [], expected_result: "x", validation_status: "valid", source_use_id: "U01", recipe_id: "r", recipe_version: "1.0.0",
    asset_ids: ["asset_ui01"], timing: { start_s: 0, duration_s: 4 }, caption: null, audio_cues: [],
  });
  const adapters = new AdapterRegistry([{ renderer: "ffmpeg", templates: { "ffmpeg/x": ["trim_clip"] } as never, render: async () => undefined }]);
  const frame = { width: 960, height: 540, fps: 30 };
  const run = (sp: ScenePlan, assets: Asset[]) => {
    const preflightReq = { scenePlan: sp, assets, art_direction: null, operations: [op("ffmpeg/x")], templates: { E01: "ffmpeg/x" }, aspect_ratio: "16:9" as const, selection_hash: "a".repeat(64), compiled_hash: CH };
    const pre = runAdapterPreflight(preflightReq, { adapters, outputRoot: tmp, frame });
    // what assembly does: the same builder, fed from a handoff-shaped object, with no concept list of its own
    const asm = planSceneJob({
      scene: sp.scenes[0]!, visual: [op("ffmpeg/x")], info: () => ({ template: "ffmpeg/x", renderer: "ffmpeg", unsupported: "" }), adapters,
      settings: preflightSettings(preflightReq, frame), handoff: { storyboard: sp, treatment: { art_direction: null }, assets }, outputRoot: tmp,
    });
    return { pre: pre.scenes[0]!, asm };
  };

  it("lists a supplied UI screenshot that is not declared genuine, and omits one that is", () => {
    expect(conceptAssetIdsOf({ storyboard: sceneWithUi(), assets: [SHOT] })).toEqual(["asset_ui01"]);
    expect(conceptAssetIdsOf({ storyboard: sceneWithUi(), assets: [GENUINE] })).toEqual([]);
    expect(conceptAssetIdsOf({ storyboard: scenePlan([raw("S01")]), assets: [] })).toEqual([]);
  });
  it("pre-flight and assembly build the same job (same fingerprint) when a concept asset is present", () => {
    const { pre, asm } = run(sceneWithUi(), [SHOT]);
    expect(asm.ok || asm.job).toBeTruthy();
    const job = asm.ok ? asm.job : asm.job!;
    expect(job.concept_asset_ids).toEqual(["asset_ui01"]);
    expect(pre.job_fingerprint).toBe(asm.ok ? asm.fingerprint : asm.fingerprint);
  });
  it("and when it is absent (declared genuine)", () => {
    const { pre, asm } = run(sceneWithUi(), [GENUINE]);
    const job = asm.ok ? asm.job : asm.job!;
    expect(job.concept_asset_ids).toEqual([]);
    expect(pre.job_fingerprint).toBe(asm.ok ? asm.fingerprint : asm.fingerprint);
  });
  it("the concept list changes the job, so a pre-flight that left it out would have judged a different job", () => {
    const withConcept = run(sceneWithUi(), [SHOT]).pre.job_fingerprint, without = run(sceneWithUi(), [GENUINE]).pre.job_fingerprint;
    expect(withConcept).not.toBe(without);
  });
});

// ---------- Fix 3 (E-2): the renderer's selection must equal the approved one ----------
describe("selectionProblems: the approved implementation and engine cannot silently change", () => {
  const approved = [
    { operation_id: "E01", implementation_ref: "remotion/text-fade-up", engine: "remotion" as const },
    { operation_id: "E02", implementation_ref: "ffmpeg/concat-cut", engine: null },
  ];
  const actual = (over: Record<string, Partial<{ implementation_ref: string; renderer: string | null }>> = {}) => [
    { operation_id: "E01", operation_type: "overlay_text", implementation_ref: "remotion/text-fade-up", renderer: "remotion", ...over["E01"] },
    { operation_id: "E02", operation_type: "concat", implementation_ref: "ffmpeg/concat-cut", renderer: null, ...over["E02"] },
  ];
  it("agreement gives no problems (an assembler join is FFmpeg's whether or not a scene adapter lists it)", () => {
    expect(selectionProblems(approved, actual())).toEqual([]);
    expect(selectionProblems(approved, actual({ E02: { renderer: "ffmpeg" } }))).toEqual([]);
  });
  it("refuses a different implementation, naming the approved and the chosen one", () => {
    const p = selectionProblems(approved, actual({ E01: { implementation_ref: "hyperframes/text-fade-up-hyperframes", renderer: "remotion" } }));
    expect(p.join(" ")).toMatch(/E01 was approved to run remotion\/text-fade-up but the renderer chose hyperframes\/text-fade-up-hyperframes/);
    expect(p.join(" ")).toMatch(/revised production plan and a new approval/);
  });
  it("refuses a different engine for the same implementation", () => {
    const p = selectionProblems(approved, actual({ E01: { renderer: "ffmpeg" } }));
    expect(p.join(" ")).toMatch(/E01 was approved on remotion but the renderer chose ffmpeg/);
  });
  it("refuses an engine-less choice, an extra operation and a dropped one", () => {
    expect(selectionProblems(approved, actual({ E01: { renderer: null } })).length).toBe(1);
    expect(selectionProblems(approved, [...actual(), { operation_id: "E09", operation_type: "trim_clip", implementation_ref: "ffmpeg/x", renderer: "ffmpeg" }]).join(" ")).toMatch(/E09 was not part of the approved selection/);
    expect(selectionProblems(approved, actual().slice(0, 1)).join(" ")).toMatch(/E02 was approved but the renderer was not given it/);
  });
  it("approvedSelectionOf reads the implementation and engine from the plan's decisions, per compiled operation", () => {
    const sp = scenePlan([raw("S01", { overlay: text("Hello there") })]);
    const plan = generateProductionPlan(reg.snapshot, input(sp, editPlan([use(1, "S01", "text-fade-up")])));
    const sel = approvedSelectionOf(plan, { operations: [{ operation_id: "E01", source_use_id: "U01" }] as never });
    expect(sel).toEqual([{ operation_id: "E01", implementation_ref: plan.decisions[0]!.implementation_ref, engine: plan.decisions[0]!.engine }]);
    expect(sel[0]!.implementation_ref).toBe("remotion/text-fade-up");
  });
});

// ---------- Fix 4 (E-3): what the pre-flight does not guarantee is stated, not implied ----------
describe("pre-flight coverage boundaries are explicit", () => {
  it("lists the validations that belong to render time", () => {
    const all = RENDER_TIME_VALIDATIONS.join("\n");
    for (const needle of ["previewCoverage", "transition application", "match-cut", "caption timing", "real fps", "real width, height", "approved production plan", "compiled plan"]) expect(all).toContain(needle);
  });
});
