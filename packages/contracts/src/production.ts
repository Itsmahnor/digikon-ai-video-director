import { z } from "zod";
import { hashCanonical, editPlanHash, ProductionBinding, productionBindingHash } from "./approval.js";
import { ReadinessStatus, CapabilityVerification } from "./capability.js";
import type { Capability } from "./capability.js";
import type { EditPlan } from "./director.js";
import { Renderer } from "./recipe.js";
import { EditorOperation, RevisionRequest } from "./editor.js";
import { OperationType } from "./schemas.js";

/**
 * Production planning contracts.
 *
 * Two different questions are kept apart on purpose:
 * - `AdvisoryReport` (before Gate 1): can the storyboard's production REQUIREMENTS plausibly be met by capabilities that are live-resolved now? It names no
 *   recipe and no engine, and it authorizes nothing.
 * - `ProductionDecisionPlan` (after Gate 1): for the Director's chosen recipe uses, which capability, variant, engine and implementation carries each one out,
 *   with the parameters resolved and checked. It is what Gate 2 will approve (a later stage) and what render time re-derives.
 */

export const PRODUCTION_PLAN_VERSION = "1.0.0" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const FeasibilityVerdict = z.enum(["executable", "executable_with_substitute", "blocked"]);
export type FeasibilityVerdict = z.infer<typeof FeasibilityVerdict>;

/** Why a verdict is what it is. Every verdict carries at least one. */
export const FeasibilityReason = z.enum([
  "OK",
  "RECIPE_UNKNOWN",
  "NO_CAPABILITY",
  "CAPABILITY_NOT_EXECUTABLE",
  "BELOW_READINESS",
  "ENGINE_UNAVAILABLE",
  "OPERATION_NOT_SUPPORTED",
  "MEDIA_NOT_ACCEPTED",
  "SLOT_INCOMPATIBLE",
  "MANDATORY_ASSET_MISSING",
  "ASPECT_UNSUPPORTED",
  "DURATION_OUT_OF_RANGE",
  "PARAMETER_INVALID",
  "ADAPTER_REFUSES",
  "SUBSTITUTE_NEEDS_APPROVAL",
  "VISUAL_BLOCK_NOT_EXECUTABLE",
  "TRANSITION_NOT_EXECUTABLE",
  "EXTERNAL_ASSET_MISSING",
  "AMBIGUOUS_CAPABILITY",
]);
export type FeasibilityReason = z.infer<typeof FeasibilityReason>;

export const ParameterIssueRecord = z.object({ code: z.string(), parameter: z.string(), detail: z.string() });

export const SlotBinding = z.object({ slot_id: z.string(), asset_id: z.string(), media_type: z.enum(["video", "image", "audio"]) });

export const Substitute = z.object({
  capability_id: z.string(),
  recipe_id: z.string().nullable(),
  engine: Renderer.nullable(),
  /** Why this is offered. A substitute is only ever a suggestion: it is a different capability from the one planned. */
  basis: z.string(),
});
export type Substitute = z.infer<typeof Substitute>;

/** Another capability that was looked at for the same job, and why it was or was not usable. Informational: never part of the approval hash. */
export const AlternativeConsidered = z.object({ capability_id: z.string(), compatible: z.boolean(), reasons: z.array(z.string()) });
export type AlternativeConsidered = z.infer<typeof AlternativeConsidered>;

const ParamValues = z.record(z.union([z.number(), z.string(), z.boolean()]));

export const ProductionDecision = z.object({
  use_id: z.string(),
  scene_id: z.string(),
  recipe_id: z.string(),
  recipe_version: z.string().nullable(),
  /** Null when the recipe maps to no capability at all. */
  capability_id: z.string().nullable(),
  capability_version: z.string().nullable(),
  capability_record_hash: Sha256.nullable(),
  engine: Renderer.nullable(),
  implementation_ref: z.string().nullable(),
  operations: z.array(OperationType),
  readiness: ReadinessStatus.nullable(),
  verification: CapabilityVerification.nullable(),
  /** The drawn visual block this use draws with (a variant of the composition capability), when it has one. */
  variant: z.object({ capability_id: z.string(), capability_record_hash: Sha256 }).nullable(),
  slot_bindings: z.array(SlotBinding),
  parameters: z.object({
    supplied: ParamValues,
    /** Supplied values over the capability's own defaults. What the Editor will compile. */
    resolved: ParamValues,
    issues: z.array(ParameterIssueRecord),
  }),
  verdict: FeasibilityVerdict,
  reasons: z.array(FeasibilityReason).min(1),
  details: z.array(z.string()),
  substitute: Substitute.nullable(),
  /** Informational notes about OTHER capabilities. Stripped before hashing, so a change to an unrelated capability never changes the plan's hash. */
  alternatives_considered: z.array(AlternativeConsidered),
  limitations: z.array(z.string()),
});
export type ProductionDecision = z.infer<typeof ProductionDecision>;

export const UnresolvedRequirement = z.object({
  scene_id: z.string(),
  kind: z.enum(["audio", "external_asset", "scene_picture"]),
  reason: z.union([FeasibilityReason, z.literal("AUDIO_NOT_PRODUCED")]),
  detail: z.string(),
});
export type UnresolvedRequirement = z.infer<typeof UnresolvedRequirement>;

/**
 * The result of running the renderer's own planners over the scenes of a plan, without rendering. `not_run` is the state of every newly generated plan and is
 * never a success. `passed` is only meaningful when it carries per-scene records showing a planner actually ran on a job with a fingerprint, bound to the exact
 * selection it ran against, and a result hash that verifies; a caller cannot assert it by setting a field. It is a statement about the frame size it ran at:
 * layout refusals depend on size, and render time repeats the check with the real settings.
 */
export const PreflightStatus = z.enum(["not_run", "passed", "failed"]);
export type PreflightStatus = z.infer<typeof PreflightStatus>;

export const PreflightSceneResult = z.object({
  scene_id: z.string(),
  /** `not_applicable`: the scene has no picture-producing operation to plan (a join or audio only). It is never counted as a pass of a picture. */
  status: z.enum(["passed", "failed", "not_applicable"]),
  /** Why a scene failed before or at the adapter: nothing produces its picture, an operation has no renderer, operations need two engines, no adapter, or the adapter refused it. */
  kind: z.enum(["ok", "no_operation", "unsupported", "cross_engine", "no_adapter", "refused"]),
  engine: Renderer.nullable(),
  /** The adapter's own planner that judged the job (`adapter.check`). Null when none ran. */
  planner: z.string().nullable(),
  template_refs: z.array(z.string()),
  /** Hash of the job the planner saw (operations, templates, settings, assets, visuals). Null when no job was built. */
  job_fingerprint: Sha256.nullable(),
  diagnostics: z.array(z.string()),
});
export type PreflightSceneResult = z.infer<typeof PreflightSceneResult>;

const PreflightBody = z.object({
  status: PreflightStatus,
  frame: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive() }).nullable(),
  /** The selection (`productionSelectionHash`) the planners ran against. */
  bound_selection_hash: Sha256.nullable(),
  /** The compiled plan (`compiledPlanHash`) whose operations the planners ran over. Part of the result hash; the compiled plan never reads the pre-flight, so there is no cycle. */
  bound_compiled_hash: Sha256.nullable().optional(),
  scenes: z.array(PreflightSceneResult),
});
export const preflightResultHash = (r: z.infer<typeof PreflightBody>): string => hashCanonical({ stage: "preflight_result", ...r, bound_compiled_hash: r.bound_compiled_hash ?? null });

export const PreflightResult = PreflightBody.extend({ result_hash: Sha256.nullable() }).superRefine((r, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: "custom", message });
  if (r.status === "not_run") {
    if (r.scenes.length || r.result_hash || r.bound_selection_hash || r.bound_compiled_hash || r.frame) bad("a pre-flight that was not run carries no results");
    return;
  }
  if (!r.result_hash || !r.bound_selection_hash || !r.bound_compiled_hash || !r.frame) bad("a pre-flight result needs a frame size, the selection and the compiled plan it ran against, and a result hash");
  else if (preflightResultHash({ status: r.status, frame: r.frame, bound_selection_hash: r.bound_selection_hash, bound_compiled_hash: r.bound_compiled_hash, scenes: r.scenes }) !== r.result_hash) bad("the pre-flight result does not match its hash");
  if (r.status === "passed") {
    if (!r.scenes.some((s) => s.status === "passed")) bad("a pre-flight cannot pass without at least one planned scene");
    for (const s of r.scenes) {
      if (s.status === "failed") bad(`scene ${s.scene_id} failed, so the pre-flight did not pass`);
      if (s.status === "passed" && (s.kind !== "ok" || !s.planner || !s.job_fingerprint || s.diagnostics.length)) bad(`scene ${s.scene_id} is marked passed without a planner run on a job`);
      if (s.status === "not_applicable" && s.kind !== "no_operation") bad(`scene ${s.scene_id}: not_applicable needs the no_operation kind`);
    }
  }
  if (r.status === "failed" && !r.scenes.some((s) => s.status === "failed")) bad("a failed pre-flight names the scene that failed");
});
export type PreflightResult = z.infer<typeof PreflightResult>;

export const NOT_RUN_PREFLIGHT: PreflightResult = { status: "not_run", frame: null, bound_selection_hash: null, bound_compiled_hash: null, scenes: [], result_hash: null };

export const ProductionDecisionPlan = z.object({
  plan_version: z.literal(PRODUCTION_PLAN_VERSION),
  project_id: z.string().min(1),
  /** The approved storyboard and Director edit plan this was derived from. */
  storyboard: z.object({ version: z.number().int().positive(), hash: Sha256 }),
  edit_plan: z.object({ version: z.number().int().positive(), hash: Sha256 }),
  decisions: z.array(ProductionDecision),
  scenes: z.array(z.object({ scene_id: z.string(), verdict: FeasibilityVerdict, use_ids: z.array(z.string()) })),
  /** Requirements that nothing here can meet, stated rather than silently substituted. Audio is listed (not produced); it does not change a scene verdict. */
  unresolved: z.array(UnresolvedRequirement),
  summary: z.object({ executable: z.number().int(), executable_with_substitute: z.number().int(), blocked: z.number().int(), clear: z.boolean() }),
  /** Starts as not_run. `summary.clear` requires it to have passed. */
  preflight: PreflightResult,
  registry: z.object({
    /** The whole registry at generation time. Audit metadata only: it is NOT in the plan hash, because an unrelated capability changing must not invalidate an approval. */
    snapshot_hash: Sha256,
    /** Hash over only the capabilities this plan uses (and their variant parents). This one IS in the plan hash. */
    relevant_capabilities_hash: Sha256,
    relevant_capability_ids: z.array(z.string()),
  }),
  created_at: z.string().datetime(),
  /** Covers everything above except itself, `created_at`, `registry.snapshot_hash` and each decision's `alternatives_considered`. It includes the pre-flight result. */
  plan_hash: Sha256,
});
export type ProductionDecisionPlan = z.infer<typeof ProductionDecisionPlan>;

/** The hash of the capabilities a plan relies on: identity, version, implementation and each entry's own record hash. Unrelated entries cannot change it. */
export function relevantCapabilitiesHash(entries: readonly Pick<Capability, "capability_id" | "version" | "record_hash" | "implementation_ref" | "implementation_state">[]): string {
  return hashCanonical({
    stage: "relevant_capabilities",
    capabilities: [...entries].sort((a, b) => (a.capability_id < b.capability_id ? -1 : a.capability_id > b.capability_id ? 1 : 0))
      .map((c) => ({ capability_id: c.capability_id, version: c.version, record_hash: c.record_hash, implementation_ref: c.implementation_ref, implementation_state: c.implementation_state })),
  });
}

/**
 * The plan's approval hash. Excludes itself (no circularity), the creation time, the whole-registry snapshot hash (audit only) and the alternatives that were
 * considered (notes about other capabilities). It includes the relevant-capabilities hash, every decision's selected capability, record hash, engine,
 * implementation, resolved parameters and verdict, and the storyboard and edit-plan references.
 */
export function productionPlanHash(plan: Omit<ProductionDecisionPlan, "plan_hash"> | ProductionDecisionPlan): string {
  const { plan_hash: _h, created_at: _c, registry, decisions, ...rest } = plan as ProductionDecisionPlan;
  const { snapshot_hash: _s, ...registryBound } = registry;
  return hashCanonical({ stage: "production_decision_plan", ...rest, registry: registryBound, decisions: decisions.map(({ alternatives_considered: _a, ...d }) => d) });
}

/** The reference to a Director edit plan that a decision plan carries: its version and the same hash Gate 2 uses today. */
export const editPlanRef = (storyboard: { version: number; hash: string }, editPlan: EditPlan) => ({ version: editPlan.version, hash: editPlanHash(storyboard, editPlan) });

// ---------- advisory feasibility (Gate 1) ----------

export const RequirementKind = z.enum(["visual_block", "scene_picture", "on_screen_text", "graphics_scene", "transition", "audio", "external_asset"]);
export type RequirementKind = z.infer<typeof RequirementKind>;

/**
 * `producible`: at least one capability that a live adapter has registered could carry the requirement out, judged on everything the registry records.
 * `uncertain`: the requirement cannot be fully judged from what the registry records.
 * `not_producible`: nothing live-resolved can carry it out. None of these is an authorization: no recipe, engine or capability has been selected.
 */
export const AdvisoryVerdict = z.enum(["producible", "uncertain", "not_producible"]);
export type AdvisoryVerdict = z.infer<typeof AdvisoryVerdict>;

export const AdvisoryRequirement = z.object({
  kind: RequirementKind,
  description: z.string(),
  verdict: AdvisoryVerdict,
  /** How many live-resolved capabilities could carry it out. A count, not a selection. */
  candidate_count: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
  details: z.array(z.string()),
});
export type AdvisoryRequirement = z.infer<typeof AdvisoryRequirement>;

export const AdvisoryReport = z.object({
  mode: z.literal("advisory"),
  /** Audit metadata. The report authorizes nothing. */
  snapshot_hash: Sha256,
  scenes: z.array(z.object({ scene_id: z.string(), verdict: AdvisoryVerdict, requirements: z.array(AdvisoryRequirement) })),
  summary: z.object({ producible: z.number().int(), uncertain: z.number().int(), not_producible: z.number().int() }),
  warnings: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type AdvisoryReport = z.infer<typeof AdvisoryReport>;

/**
 * What the pre-flight is bound to: the selection itself (Director references, every decision's selected capability, resolved parameters and verdict, the
 * relevant-capabilities hash and the unresolved requirements), and nothing that the pre-flight or the summary derives from it, so there is no circularity.
 */
export function productionSelectionHash(plan: Pick<ProductionDecisionPlan, "project_id" | "storyboard" | "edit_plan" | "decisions" | "unresolved" | "registry">): string {
  return hashCanonical({
    stage: "production_selection", project_id: plan.project_id, storyboard: plan.storyboard, edit_plan: plan.edit_plan,
    decisions: plan.decisions.map(({ alternatives_considered: _a, ...d }) => d), unresolved: plan.unresolved,
    relevant_capabilities_hash: plan.registry.relevant_capabilities_hash,
  });
}

// ---------- the compiled (executable) edit plan ----------

export const COMPILED_PLAN_VERSION = "1.0.0" as const;

export const CompileDiagnostic = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
  scene_id: z.string().nullable(),
  use_id: z.string().nullable(),
  message: z.string(),
});
export type CompileDiagnostic = z.infer<typeof CompileDiagnostic>;

/**
 * The Director\'s edit plan compiled into executable operations, deterministically, before Gate 2. \`status\` is \`ready\` only when no error diagnostic, conflict or
 * revision request remains. The operations are exactly what the Editor will hand the renderer; nothing after approval may regenerate them.
 */
export const CompiledEditPlan = z.object({
  compiled_version: z.literal(COMPILED_PLAN_VERSION),
  project_id: z.string().min(1),
  storyboard: z.object({ version: z.number().int().positive(), hash: Sha256 }),
  edit_plan: z.object({ version: z.number().int().positive(), hash: Sha256 }),
  /** The \`productionSelectionHash\` of the decision plan these operations carry out. */
  production_selection_hash: Sha256,
  operations: z.array(EditorOperation),
  status: z.enum(["ready", "blocked", "needs_director_revision"]),
  diagnostics: z.array(CompileDiagnostic),
  revision_requests: z.array(RevisionRequest),
  notes: z.array(z.string()),
  created_at: z.string().datetime(),
  /** Covers everything except itself and \`created_at\`. */
  compiled_hash: Sha256,
});
export type CompiledEditPlan = z.infer<typeof CompiledEditPlan>;

export function compiledPlanHash(plan: Omit<CompiledEditPlan, "compiled_hash"> | CompiledEditPlan): string {
  const { compiled_hash: _h, created_at: _c, ...rest } = plan as CompiledEditPlan;
  return hashCanonical({ stage: "compiled_edit_plan", ...rest });
}

/**
 * The hash of the production implementation a Gate 2 approval covers, worked out from the plans themselves. Nothing here is read from a stored hash except the plan's own
 * recorded ones, which `verifyProductionBinding` recomputes. Snapshot metadata and creation times are not part of it.
 */
export function productionBindingOf(plan: ProductionDecisionPlan, compiled: CompiledEditPlan): ProductionBinding {
  const body = {
    binding_version: 1 as const, edit_plan_hash: plan.edit_plan.hash, production_selection_hash: productionSelectionHash(plan), production_plan_hash: productionPlanHash(plan),
    compiled_hash: compiledPlanHash(compiled), preflight_result_hash: plan.preflight.result_hash ?? "", relevant_capabilities_hash: plan.registry.relevant_capabilities_hash,
  };
  return ProductionBinding.parse({ ...body, binding_hash: productionBindingHash(body) });
}
