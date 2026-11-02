import {
  CompiledEditPlan, ProductionDecisionPlan, compiledPlanHash, productionBindingOf, productionPlanHash, productionSelectionHash,
  type ApprovalRecord, type ProductionBinding,
} from "@digikon/contracts";
import { derivedFieldProblems } from "./plan.js";

/**
 * Integrity of the production plan and the compiled plan as a pair, and of the approval binding over them. Everything is recomputed from content: a stored hash is
 * only ever compared with what the content now hashes to. No registry is needed, so this runs on restore and before a render as well as at the gate. It says nothing
 * about whether the capabilities still exist (that is `validateProductionPlan` against the live registry) and nothing about rendering (Stage 3.4).
 */

export interface PlanRefs { storyboard: { version: number; hash: string }; edit_plan: { version: number; hash: string } }

/** Reasons the pair cannot stand, empty when it is intact, consistent with the Director plans it names, and clear. */
export function verifyProductionIntegrity(rawPlan: unknown, rawCompiled: unknown, refs: PlanRefs): string[] {
  const p = ProductionDecisionPlan.safeParse(rawPlan), c = CompiledEditPlan.safeParse(rawCompiled);
  const issues: string[] = [];
  if (!p.success) issues.push(...p.error.issues.map((x) => `production plan ${x.path.join(".") || "root"}: ${x.message}`));
  if (!c.success) issues.push(...c.error.issues.map((x) => `compiled plan ${x.path.join(".") || "root"}: ${x.message}`));
  if (!p.success || !c.success) return issues;
  const plan = p.data, compiled = c.data;
  if (productionPlanHash(plan) !== plan.plan_hash) issues.push("the production plan changed after it was made (hash mismatch)");
  if (compiledPlanHash(compiled) !== compiled.compiled_hash) issues.push("the compiled plan changed after it was made (hash mismatch)");
  const selection = productionSelectionHash(plan);
  if (compiled.production_selection_hash !== selection) issues.push("the compiled plan was made for a different production selection");
  for (const [label, ref] of [["production plan", plan], ["compiled plan", compiled]] as const) {
    if (ref.storyboard.version !== refs.storyboard.version || ref.storyboard.hash !== refs.storyboard.hash) issues.push(`the ${label} was made for a different storyboard`);
    if (ref.edit_plan.version !== refs.edit_plan.version || ref.edit_plan.hash !== refs.edit_plan.hash) issues.push(`the ${label} was made for a different edit plan`);
  }
  if (plan.preflight.status !== "passed") issues.push("the renderer's pre-flight has not passed");
  else {
    if (plan.preflight.bound_selection_hash !== selection) issues.push("the pre-flight result belongs to a different selection than this plan");
    if (plan.preflight.bound_compiled_hash !== compiled.compiled_hash) issues.push("the pre-flight result was produced over different compiled operations than this compiled plan");
  }
  issues.push(...derivedFieldProblems(plan));
  if (!plan.summary.clear) issues.push("the production plan is not clear");
  if (compiled.status !== "ready" || compiled.diagnostics.some((d) => d.severity === "error")) issues.push("the compiled plan is not ready");
  const decisions = new Map(plan.decisions.map((d) => [d.use_id, d]));
  for (const op of compiled.operations) {
    const d = decisions.get(op.source_use_id);
    if (!d) issues.push(`operation ${op.operation_id} has no production decision for ${op.source_use_id}`);
    else if (d.verdict !== "executable" || d.recipe_id !== op.recipe_id) issues.push(`operation ${op.operation_id} does not match its production decision`);
  }
  return issues;
}

/** The binding a Gate 2 approval must carry for these plans. Throws if they have no passed pre-flight to bind. */
export const bindingFor = (plan: ProductionDecisionPlan, compiled: CompiledEditPlan): ProductionBinding => productionBindingOf(plan, compiled);

/** Whether the binding stored in an approval is exactly what these plans hash to now, and names the approved Director edit plan. */
export function verifyProductionBinding(record: Pick<ApprovalRecord, "plan_hash" | "production_binding">, rawPlan: unknown, rawCompiled: unknown): string[] {
  const b = record.production_binding;
  if (!b) return ["the approval carries no production binding"];
  const p = ProductionDecisionPlan.safeParse(rawPlan), c = CompiledEditPlan.safeParse(rawCompiled);
  if (!p.success || !c.success) return ["the production plan or compiled plan is missing or malformed, so the approval cannot be verified"];
  let now: ProductionBinding;
  try { now = productionBindingOf(p.data, c.data); } catch { return ["the production plans have no passed pre-flight to bind"]; }
  const issues: string[] = [];
  if (b.edit_plan_hash !== record.plan_hash) issues.push("the production binding names a different edit plan than the approval");
  const names: [string, string, string][] = [
    ["production decisions", b.production_selection_hash, now.production_selection_hash], ["production plan", b.production_plan_hash, now.production_plan_hash],
    ["compiled operations", b.compiled_hash, now.compiled_hash], ["pre-flight evidence", b.preflight_result_hash, now.preflight_result_hash],
    ["capabilities relied on", b.relevant_capabilities_hash, now.relevant_capabilities_hash], ["edit plan", b.edit_plan_hash, now.edit_plan_hash],
  ];
  for (const [what, was, is] of names) if (was !== is) issues.push(`the ${what} changed after approval`);
  return issues;
}
