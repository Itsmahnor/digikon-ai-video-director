import type { CompiledEditPlan, ProductionDecisionPlan, Renderer } from "@digikon/contracts";

/**
 * The implementation and engine the approved production plan selected for each operation, and the check that the renderer chose the same. The renderer may be able to run an
 * operation some other way (`alternativeImplementation` in `planRender`), but that is a different selection than the one the human approved: it is refused here, never
 * substituted. An alternative needs a revised production plan and a new approval.
 */

export interface ApprovedSelection { operation_id: string; implementation_ref: string | null; engine: Renderer | null }

/** What the plan decided for each compiled operation, by the use the operation came from. */
export function approvedSelectionOf(plan: Pick<ProductionDecisionPlan, "decisions">, compiled: Pick<CompiledEditPlan, "operations">): ApprovedSelection[] {
  const byUse = new Map(plan.decisions.map((d) => [d.use_id, d]));
  return compiled.operations.map((o) => { const d = byUse.get(o.source_use_id); return { operation_id: o.operation_id, implementation_ref: d?.implementation_ref ?? null, engine: d?.engine ?? null }; });
}

/** A join the assembler makes itself: it is FFmpeg's, whether or not a scene adapter lists it. */
const ASSEMBLER_JOINS = new Set(["ffmpeg/concat-cut", "ffmpeg/match-cut"]);

export const SELECTION_BLOCKER_PREFIX = "approved production plan";

/** One line per operation whose implementation or engine differs from the approved selection, and per operation the approval does not cover. Empty when they agree. */
export function selectionProblems(approved: readonly ApprovedSelection[], actual: readonly { operation_id: string; operation_type: string; implementation_ref: string; renderer: string | null }[]): string[] {
  const want = new Map(approved.map((a) => [a.operation_id, a]));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const o of actual) {
    seen.add(o.operation_id);
    const a = want.get(o.operation_id);
    if (!a) { problems.push(`${SELECTION_BLOCKER_PREFIX}: ${o.operation_id} was not part of the approved selection`); continue; }
    if (a.implementation_ref !== o.implementation_ref) problems.push(`${SELECTION_BLOCKER_PREFIX}: ${o.operation_id} was approved to run ${a.implementation_ref ?? "(none)"} but the renderer chose ${o.implementation_ref || "(none)"}; a different implementation needs a revised production plan and a new approval`);
    const engine = o.operation_type === "concat" && ASSEMBLER_JOINS.has(o.implementation_ref) ? "ffmpeg" : o.renderer;
    if (!(engine === "ffmpeg" && a.engine == null && o.operation_type === "concat") && a.engine !== engine) problems.push(`${SELECTION_BLOCKER_PREFIX}: ${o.operation_id} was approved on ${a.engine ?? "(no engine)"} but the renderer chose ${engine ?? "(no engine)"}; a different engine needs a revised production plan and a new approval`);
  }
  for (const a of approved) if (!seen.has(a.operation_id)) problems.push(`${SELECTION_BLOCKER_PREFIX}: ${a.operation_id} was approved but the renderer was not given it`);
  return problems;
}
