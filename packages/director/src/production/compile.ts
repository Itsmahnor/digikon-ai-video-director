import {
  COMPILED_PLAN_VERSION, CompiledEditPlan, canonicalJson, compiledPlanHash, productionSelectionHash,
  type Asset, type CapabilitySnapshot, type CompileDiagnostic, type EditPlan, type EditorOperation, type ProductionDecisionPlan, type CompositionMotionPlan, type Renderer, type RevisionRequest, type ScenePlan, type SceneVisual, type Treatment,
} from "@digikon/contracts";
import type { RecipeLibrary } from "@digikon/recipes";
import type { Retriever } from "@digikon/rag";
import { operationIssues } from "../handoff.js";
import { planEditorWork, type EditorSource } from "../editor-agent.js";
import { PreflightRefusedError, attachPreflight, generateProductionPlan, type PlanningInput } from "./plan.js";

/**
 * The seam between the Director's production decisions and the infrastructure that knows what exists and what the renderer will accept. The Director never imports the
 * render package: it is handed this port, and the console implements it from the live capability registry and the adapters. Only data crosses it.
 */
export interface ProductionPort {
  /** The registry as it is now, built fresh on each call (no list is kept between calls), and the engines whose adapters exist now. */
  capabilities(): { snapshot: CapabilitySnapshot; available_engines: Renderer[] };
  /**
   * The trusted pre-flight: runs the renderer's own planners over the compiled operations, without rendering, and returns a sealed `PreflightResult`. Implemented
   * by the render package. Anything the Director passes back as a result is re-checked by \`attachPreflight\`.
   */
  preflight(request: PreflightRequest): unknown;
  /**
   * What the machine's audio stage cannot make for this plan, as ordinary sentences. Requested sound that cannot be produced stops Gate 2 rather than being dropped.
   * Absent: this system has no audio stage, and audio stays an open, reported requirement.
   */
  /** Problems with a composed scene (bounds, legibility, timing), judged by the renderer's own validator, so they go back to the Director before Gate 1. */
  composition?(request: { visual: Extract<SceneVisual, { block: "composition" }>; duration_seconds: number; art_direction: Treatment["art_direction"] | null; aspect_ratio: "16:9" | "9:16" | "1:1" }): string[];
  audio?(request: { scenePlan: ScenePlan; assets: readonly Asset[]; feel: NonNullable<Treatment["art_direction"]>["motion_language"]["feel"] | null }): string[];
}

export interface PreflightRequest {
  scenePlan: ScenePlan;
  assets: readonly Asset[];
  art_direction: Treatment["art_direction"] | null;
  /** The compiled operations, exactly as the Editor would hand them to the renderer. */
  operations: readonly EditorOperation[];
  /** operation_id to the implementation reference the production plan selected for it. */
  templates: Readonly<Record<string, string>>;
  aspect_ratio: "16:9" | "9:16" | "1:1";
  /** The Editor's motion changes for composed scenes, laid over the storyboard's compositions when the scene jobs are planned. */
  composition_motion?: readonly CompositionMotionPlan[];
  /** What the result must be bound to: the selection and the compiled plan these operations come from. */
  selection_hash: string;
  compiled_hash: string;
}

export interface CompileDeps { recipes: RecipeLibrary; retriever: Retriever; now?: () => Date; audio_production?: boolean }

const isAudioOnly = (c: { kind: string; description: string }) => c.kind === "missing_information" && /lists audio cues/.test(c.description);

/**
 * Compiles the Director's edit plan into executable operations, deterministically, from the narrow Editor source and the production plan. It changes nothing that was
 * approved: scenes, assets, copy and timing come from the storyboard, parameters from the recipe (resolved defaults), and an operation must match its production decision.
 * Anything that would need a creative change comes back as a revision request, never as a silent edit. The model plays no part in this.
 */
export async function compileProduction(source: EditorSource, plan: ProductionDecisionPlan, deps: CompileDeps): Promise<CompiledEditPlan> {
  const f = await planEditorWork(source, deps);
  const diagnostics: CompileDiagnostic[] = [];
  const diag = (severity: CompileDiagnostic["severity"], code: string, message: string, scene_id: string | null = null, use_id: string | null = null) => diagnostics.push({ severity, code, scene_id, use_id, message });

  for (const c of f.conflicts) diag(isAudioOnly(c) ? "warning" : "error", `EDITOR_${c.kind.toUpperCase()}`, c.description, c.scene_id, c.use_id);
  for (const r of f.revision_requests) diag("error", "REVISION_REQUIRED", r.reason, r.scene_ids[0] ?? null);
  for (const m of f.missing_inputs) diag("warning", "MISSING_INPUT", m);

  // Each operation must be the one its production decision selected: same recipe, an operation type the capability implements, the parameters the plan resolved.
  const byUse = new Map(plan.decisions.map((d) => [d.use_id, d]));
  for (const op of f.operations) {
    const d = byUse.get(op.source_use_id);
    if (!d) { diag("error", "NO_DECISION", `operation ${op.operation_id} has no production decision for ${op.source_use_id}`, op.target_scene_id, op.source_use_id); continue; }
    if (d.verdict !== "executable") diag("error", "DECISION_NOT_EXECUTABLE", `${op.source_use_id} (${d.recipe_id}) is ${d.verdict} in the production plan, so it cannot be compiled`, op.target_scene_id, op.source_use_id);
    if (d.recipe_id !== op.recipe_id) diag("error", "RECIPE_MISMATCH", `operation ${op.operation_id} is ${op.recipe_id} but the production plan decided ${d.recipe_id}`, op.target_scene_id, op.source_use_id);
    if (!d.operations.includes(op.operation_type)) diag("error", "OPERATION_MISMATCH", `operation ${op.operation_id} is ${op.operation_type}; the selected capability implements ${d.operations.join(", ") || "nothing"}`, op.target_scene_id, op.source_use_id);
    if (canonicalJson(op.parameters) !== canonicalJson(d.parameters.resolved)) diag("error", "PARAMETER_MISMATCH", `operation ${op.operation_id}: the compiled parameters differ from those the production plan resolved and validated`, op.target_scene_id, op.source_use_id);
  }
  for (const d of plan.decisions) if (!f.operations.some((o) => o.source_use_id === d.use_id) && !f.conflicts.some((c) => c.use_id === d.use_id)) diag("error", "NOT_COMPILED", `${d.use_id} (${d.recipe_id}) produced no operation`, d.scene_id, d.use_id);

  // The same per-operation rules the post-approval check applies (trace to the approved plan, assets, times, recipe rules).
  const revised = new Set(f.revision_requests.flatMap((r) => r.scene_ids));
  const reported = new Set(f.conflicts.map((c) => c.use_id).filter((x): x is string => !!x));
  const ops = operationIssues(f.operations, source, deps, { revisedScenes: revised, reportedUseIds: reported });
  for (const i of ops.issues) diag("error", "OPERATION_INVALID", i);
  if (ops.drift && !revised.size) diag("error", "PARAMETER_DRIFT", "compiled parameters differ from the approved ones without a revision request");

  const revision_requests: RevisionRequest[] = f.revision_requests;
  const hasError = diagnostics.some((d) => d.severity === "error");
  const status = revision_requests.length ? "needs_director_revision" : hasError ? "blocked" : "ready";
  const body = {
    compiled_version: COMPILED_PLAN_VERSION, project_id: source.edit_plan.project_id,
    storyboard: plan.storyboard, edit_plan: plan.edit_plan, production_selection_hash: productionSelectionHash(plan),
    operations: f.operations.map((o) => ({ ...o, validation_status: status === "ready" ? ("valid" as const) : ("invalid" as const) })),
    status: status as CompiledEditPlan["status"], diagnostics, revision_requests, notes: f.notes, created_at: (deps.now?.() ?? new Date()).toISOString(),
  };
  return CompiledEditPlan.parse({ ...body, compiled_hash: compiledPlanHash(body as never) });
}

export interface ProductionInput {
  source: EditorSource;
  scenePlan: ScenePlan;
  storyboard: { version: number; hash: string };
  editPlan: EditPlan;
  assets: readonly Asset[];
  art_direction: Treatment["art_direction"] | null;
}

export interface ProductionOutcome {
  plan: ProductionDecisionPlan;
  compiled: CompiledEditPlan;
  /** One line per problem that keeps the plan from Gate 2, ready to show or to send back for repair. */
  blockers: string[];
  /** True only when every decision is executable, the compile is clean and the renderer's pre-flight has passed. */
  ready: boolean;
}

/**
 * Production planning for a Director edit plan: decide (registry), compile (Editor), then ask the renderer's planners (pre-flight). Each step runs only when the one before
 * it left nothing blocked, so the pre-flight is never run on a selection that cannot be carried out, and a plan whose pre-flight did not run is never clear.
 */
export async function produceProduction(input: ProductionInput, port: ProductionPort, deps: CompileDeps): Promise<ProductionOutcome> {
  const { snapshot, available_engines } = port.capabilities();
  const planning: PlanningInput = { scenePlan: input.scenePlan, storyboard: input.storyboard, editPlan: input.editPlan, assets: input.assets, aspect_ratio: input.source.constraints.aspect_ratio, available_engines, ...(deps.now ? { now: deps.now } : {}) };
  let plan = generateProductionPlan(snapshot, planning);
  const compiled = await compileProduction(input.source, plan, { ...deps, audio_production: !!port.audio });
  const blockers: string[] = [];
  blockers.push(...(port.audio?.({ scenePlan: input.scenePlan, assets: input.assets, feel: input.art_direction?.motion_language.feel ?? null }) ?? []));

  for (const d of plan.decisions.filter((x) => x.verdict !== "executable")) blockers.push(`${d.scene_id} (${d.use_id}): ${d.recipe_id} is ${d.verdict === "blocked" ? "blocked" : "only possible with a substitute"} [${d.reasons.join(", ")}]: ${d.details.join("; ")}${d.substitute ? `. Suggested substitute: ${d.substitute.capability_id}` : ""}`);
  for (const u of plan.unresolved.filter((x) => x.kind !== "audio")) blockers.push(`${u.scene_id}: ${u.detail} [${u.reason}]`);
  for (const d of compiled.diagnostics.filter((x) => x.severity === "error")) blockers.push(`${d.scene_id ?? "plan"}${d.use_id ? ` (${d.use_id})` : ""}: ${d.message} [${d.code}]`);

  if (!blockers.length) {
    const templates: Record<string, string> = {};
    for (const op of compiled.operations) { const d = plan.decisions.find((x) => x.use_id === op.source_use_id); if (d?.implementation_ref) templates[op.operation_id] = d.implementation_ref; }
    try {
      plan = attachPreflight(plan, port.preflight({
        scenePlan: input.scenePlan, assets: input.assets, art_direction: input.art_direction, operations: compiled.operations, templates,
        aspect_ratio: input.source.constraints.aspect_ratio, ...(input.editPlan.composition_motion?.length ? { composition_motion: input.editPlan.composition_motion } : {}), selection_hash: productionSelectionHash(plan), compiled_hash: compiledPlanHash(compiled),
      } as PreflightRequest), compiledPlanHash(compiled));
      for (const s of plan.preflight.scenes.filter((x) => x.status === "failed")) blockers.push(`${s.scene_id}: the renderer's planner refuses this scene [${s.kind}]: ${s.diagnostics.join("; ")}`);
    } catch (e) {
      // Fail closed: a pre-flight that refused, crashed or could not be recorded leaves the plan not_run, which is never clear.
      blockers.push(e instanceof PreflightRefusedError ? `pre-flight could not be recorded: ${e.reasons.join("; ")}` : `pre-flight could not run: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    blockers.push("the renderer's pre-flight was not run because an earlier step is blocked");
  }
  return { plan, compiled, blockers, ready: plan.summary.clear && compiled.status === "ready" && !blockers.length };
}
