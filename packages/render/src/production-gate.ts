import {
  CompiledEditPlan, ProductionDecisionPlan, canonicalJson, productionSelectionHash,
  type ApprovalRecord, type Asset, type CapabilitySnapshot, type EditPlan, type EditorOperation, type RenderSettings, type Renderer, type ScenePlan, type Treatment,
} from "@digikon/contracts";
import { validateProductionPlan, verifyProductionBinding, verifyProductionIntegrity, type PlanRefs, type PreflightRequest } from "@digikon/director";
import type { AdapterRegistry } from "./adapter.js";
import type { AssemblyPlan } from "./assemble.js";
import type { AssetFileResolver } from "./asset-layers.js";
import { runAdapterPreflight } from "./preflight.js";
import { approvedSelectionOf, type ApprovedSelection } from "./selection-integrity.js";

/**
 * Render-time enforcement of what Gate 2 approved (Stage 3.4). Everything here reuses the checks that already exist: the Director's integrity and binding verifiers, its
 * live-registry validation, the pre-flight planners (now at the real settings), selection integrity and the assembly plan. Nothing is rendered and nothing is substituted:
 * a mismatch is a reason not to render. The reasons are internal; the console says one ordinary sentence and logs these.
 */

export type ProductionGate =
  | { bound: false }
  | { bound: true; ok: boolean; reasons: string[]; approved_selection: ApprovedSelection[] };

export interface GateInput {
  /** The approvals stored for the run: the trusted reference, not the run state's copy. */
  records: readonly ApprovalRecord[];
  productionPlan: unknown;
  compiledPlan: unknown;
  /** The storyboard and edit plan as they are now. */
  refs: PlanRefs | null;
  scenePlan: ScenePlan | null;
  editPlan: EditPlan | null;
  assets: readonly Asset[];
  aspect_ratio: "16:9" | "9:16" | "1:1";
  /** What the Editor handed on after Gate 2. */
  editorOperations: readonly EditorOperation[];
  /** The registry as it is now. Null when it cannot be read, which fails closed. */
  live: { snapshot: CapabilitySnapshot; available_engines: Renderer[] } | null;
}

const latest = (records: readonly ApprovalRecord[], stage: ApprovalRecord["stage"]) => [...records].reverse().find((r) => r.stage === stage && r.decision === "approved") ?? null;
const operationKey = (o: EditorOperation) => canonicalJson({ ...o, validation_status: undefined });

/**
 * Whether the run was approved with production planning (its storyboard approval says so, or its edit-plan approval carries a binding) and, if so, whether what is about to
 * be rendered is exactly that. A run approved without production planning is `bound: false` and is treated as before.
 */
export function verifyProductionForRender(g: GateInput): ProductionGate {
  const sb = latest(g.records, "storyboard"), ep = latest(g.records, "edit_plan");
  const required = !!sb?.production_required;
  if (!required && !ep?.production_binding) return { bound: false };

  const reasons: string[] = [];
  const plan = ProductionDecisionPlan.safeParse(g.productionPlan), compiled = CompiledEditPlan.safeParse(g.compiledPlan);
  const approved_selection = plan.success && compiled.success ? approvedSelectionOf(plan.data, compiled.data) : [];
  if (!g.productionPlan || !g.compiledPlan) { reasons.push("the production plans are missing"); return { bound: true, ok: false, reasons, approved_selection }; }
  if (!ep) reasons.push("the edit plan has no approval");
  if (!g.refs) reasons.push("the current storyboard or edit plan cannot be determined");
  else {
    reasons.push(...verifyProductionIntegrity(g.productionPlan, g.compiledPlan, g.refs));
    if (ep) reasons.push(...verifyProductionBinding(ep, g.productionPlan, g.compiledPlan));
    if (ep && ep.plan_hash !== g.refs.edit_plan.hash) reasons.push("the approval is for a different edit plan than the current one");
  }
  // The registry as it is now: a capability the plan relies on that changed or disappeared means the approved implementation is no longer what would run.
  if (!g.live) reasons.push("the capability registry could not be read");
  else if (plan.success && g.refs && g.scenePlan && g.editPlan) {
    reasons.push(...validateProductionPlan(g.live.snapshot, { scenePlan: g.scenePlan, storyboard: g.refs.storyboard, editPlan: g.editPlan, assets: g.assets, aspect_ratio: g.aspect_ratio, available_engines: g.live.available_engines }, plan.data).issues);
  }
  // The Editor must have handed on exactly the operations that were compiled and approved.
  if (compiled.success) {
    const want = new Map(compiled.data.operations.map((o) => [o.operation_id, operationKey(o)])), have = new Map(g.editorOperations.map((o) => [o.operation_id, operationKey(o)]));
    for (const [id, key] of want) if (!have.has(id)) reasons.push(`operation ${id} was approved but the Editor did not hand it on`); else if (have.get(id) !== key) reasons.push(`operation ${id} was changed after approval`);
    for (const id of have.keys()) if (!want.has(id)) reasons.push(`operation ${id} was not part of the approved plan`);
  }
  return { bound: true, ok: reasons.length === 0, reasons, approved_selection };
}

export interface ReplanInput {
  plan: unknown;
  compiled: unknown;
  storyboard: ScenePlan;
  assets: readonly Asset[];
  art_direction: Treatment["art_direction"] | null;
  aspect_ratio: "16:9" | "9:16" | "1:1";
  /** The real output settings. */
  settings: RenderSettings;
  adapters: AdapterRegistry;
  outputRoot: string;
  assetFiles?: AssetFileResolver;
}

/**
 * Asks the adapters' own planners again, at the real frame size, fps and duration, about the approved compiled operations. The Stage 3.2 pre-flight judged a reference
 * frame; layout refusals depend on the real one. Returns the reasons it cannot be produced as approved, empty when every scene still passes.
 */
export function replanAtActualSettings(r: ReplanInput): string[] {
  const plan = ProductionDecisionPlan.safeParse(r.plan), compiled = CompiledEditPlan.safeParse(r.compiled);
  if (!plan.success || !compiled.success) return ["the production plans are missing or malformed"];
  const templates: Record<string, string> = {};
  for (const op of compiled.data.operations) { const d = plan.data.decisions.find((x) => x.use_id === op.source_use_id); if (d?.implementation_ref) templates[op.operation_id] = d.implementation_ref; }
  try {
    const res = runAdapterPreflight({
      scenePlan: r.storyboard, assets: r.assets, art_direction: r.art_direction, operations: compiled.data.operations, templates, aspect_ratio: r.aspect_ratio,
      selection_hash: productionSelectionHash(plan.data), compiled_hash: compiled.data.compiled_hash,
    } as PreflightRequest, { adapters: r.adapters, outputRoot: r.outputRoot, settings: r.settings, assetFiles: r.assetFiles });
    return res.scenes.filter((s) => s.status === "failed").map((s) => `${s.scene_id}: the planner refuses this scene at ${r.settings.width}x${r.settings.height} ${r.settings.fps} fps [${s.kind}]: ${s.diagnostics.join("; ")}`);
  } catch (e) {
    return [`the planners could not be run at the real settings: ${e instanceof Error ? e.message : String(e)}`];
  }
}

/**
 * What final assembly found at the real settings that an approved, bound plan cannot live with: a scene nothing can render (it would become a placeholder) or a join that
 * cannot be applied. Audio and other unmet items are not listed here: they leave the film incomplete, they do not change what was approved to be drawn.
 */
export function renderTimeProblems(a: AssemblyPlan): string[] {
  return [
    ...a.scenes.filter((s) => !s.renderable).map((s) => `${s.scene_id} cannot be rendered at the real settings: ${s.reason ?? "no reason given"}`),
    ...a.transitions.filter((t) => !t.applied).map((t) => `the join after ${t.after_scene} cannot be applied: ${t.reason}`),
  ];
}
