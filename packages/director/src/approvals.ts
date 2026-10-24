import {
  ApprovalRecord, assetFeasibility, editPlanHash, evidenceHash, storyboardHash,
  type ApprovalStage, type Asset, type AssetNotes, type BrandFact, type EditPlan, type Project, type ScenePlan, type Treatment,
} from "@digikon/contracts";
import type { RecipeLibrary } from "@digikon/recipes";
import { editIssues, planIssues } from "./nodes.js";

/** The part of the Director state that approvals and the render guard look at. */
export interface ApprovalState {
  project: Project;
  assets: Asset[];
  facts?: BrandFact[];
  notes?: AssetNotes[];
  treatmentDoc?: Treatment | null;
  scenePlan?: ScenePlan | null;
  editPlan?: EditPlan | null;
  /** Everything ever decided, oldest first. Read as untrusted: each entry is re-validated. */
  approvals?: readonly unknown[];
  gate?: ApprovalStage | null;
}

/** A decision arrived for a plan version, stage or storyboard that is no longer the one waiting for review. */
export class StaleApprovalError extends Error {
  constructor(message: string) { super(message); this.name = "StaleApprovalError"; }
}

/** The plan a reviewer is looking at right now, with the version and hash a decision must name. */
export function currentStoryboard(s: ApprovalState): { version: number; hash: string } | null {
  return s.treatmentDoc && s.scenePlan ? { version: s.scenePlan.version, hash: storyboardHash(s.treatmentDoc, s.scenePlan) } : null;
}
export function currentEditPlan(s: ApprovalState): { version: number; hash: string } | null {
  const sb = currentStoryboard(s);
  return sb && s.editPlan ? { version: s.editPlan.version, hash: editPlanHash(sb, s.editPlan) } : null;
}
/** Hash of the assets, notes and facts the current storyboard rests on, or null before there is a storyboard. */
export function currentEvidenceHash(s: ApprovalState): string | null {
  return s.treatmentDoc && s.scenePlan ? evidenceHash({ treatment: s.treatmentDoc, scenePlan: s.scenePlan, assets: s.assets, facts: s.facts ?? [], notes: s.notes ?? [] }) : null;
}
export function pendingGate(s: ApprovalState): { stage: ApprovalStage; plan_version: number; plan_hash: string } | null {
  if (!s.gate) return null;
  const cur = s.gate === "storyboard" ? currentStoryboard(s) : currentEditPlan(s);
  return cur ? { stage: s.gate, plan_version: cur.version, plan_hash: cur.hash } : null;
}

/** Valid records only, in order. Anything malformed is reported separately and never counted as an approval. */
function parseRecords(raw: readonly unknown[] = []): { records: ApprovalRecord[]; problems: string[] } {
  const records: ApprovalRecord[] = [];
  const problems: string[] = [];
  raw.forEach((r, i) => {
    const p = ApprovalRecord.safeParse(r);
    if (p.success) records.push(p.data);
    else problems.push(`approval record ${i + 1} is malformed (${p.error.issues.map((x) => `${x.path.join(".") || "record"}: ${x.message}`).join("; ")})`);
  });
  return { records, problems };
}
const latestFor = (records: ApprovalRecord[], stage: ApprovalStage) => [...records].reverse().find((r) => r.stage === stage) ?? null;

export type RenderCheck =
  | { ok: true; storyboard: { version: number; hash: string }; edit_plan: { version: number; hash: string } }
  | { ok: false; reasons: string[] };

/**
 * The one question every future render must pass: do both human approvals still describe the exact plans that exist now,
 * and are those plans still valid? Nothing here renders anything.
 */
export function checkRenderable(s: ApprovalState, ctx: { recipes: RecipeLibrary }): RenderCheck {
  const reasons: string[] = [];
  const { records, problems } = parseRecords(s.approvals);
  reasons.push(...problems);

  const sb = currentStoryboard(s);
  if (!sb) reasons.push("there is no storyboard yet");
  const ep = currentEditPlan(s);
  if (sb && !ep) reasons.push("there is no edit plan yet");

  // Gate 1: the storyboard.
  const sbRec = latestFor(records, "storyboard");
  if (!sbRec) reasons.push("the storyboard has not been approved");
  else if (sbRec.decision !== "approved") reasons.push("the latest storyboard decision is a request for changes, not an approval");
  else if (sb) {
    if (sbRec.plan_version !== sb.version) reasons.push(`the approval is for storyboard version ${sbRec.plan_version}, but the current storyboard is version ${sb.version}`);
    else if (sbRec.plan_hash !== sb.hash) reasons.push("the storyboard changed after it was approved (hash mismatch)");
  }

  // Gate 2: the edit plan, bound to the storyboard it was built on.
  const epRec = latestFor(records, "edit_plan");
  if (!epRec) reasons.push("the edit plan has not been approved");
  else if (epRec.decision !== "approved") reasons.push("the latest edit-plan decision is a request for changes, not an approval");
  else if (ep && sb) {
    if (epRec.plan_version !== ep.version) reasons.push(`the approval is for edit plan version ${epRec.plan_version}, but the current edit plan is version ${ep.version}`);
    else if (epRec.storyboard_version !== sb.version) reasons.push(`the edit plan was approved on storyboard version ${epRec.storyboard_version}, but the current storyboard is version ${sb.version}`);
    else if (epRec.plan_hash !== ep.hash) reasons.push("the edit plan, or the storyboard it was built on, changed after approval (hash mismatch)");
  }

  if (sbRec && epRec && records.lastIndexOf(epRec) < records.lastIndexOf(sbRec)) reasons.push("the edit plan was approved before the storyboard");

  // The evidence both approvals rest on: the assets and their analysis, and the facts behind the claims shown.
  const ev = currentEvidenceHash(s);
  for (const [label, rec] of [["storyboard", sbRec], ["edit plan", epRec]] as const) {
    if (!rec || rec.decision !== "approved" || !ev) continue;
    if (!rec.evidence_hash) reasons.push(`the ${label} approval carries no evidence hash, so its assets and facts cannot be verified`);
    else if (rec.evidence_hash !== ev) reasons.push(`the assets or approved facts changed after the ${label} was approved (evidence hash mismatch)`);
  }

  // Current validity, using the same validators that built the plans.
  if (s.treatmentDoc && s.scenePlan) {
    for (const i of planIssues(s.scenePlan, s.assets, s.project, s.notes ?? [], s.treatmentDoc, s.facts ?? [])) reasons.push(`storyboard is not valid: ${i}`);
    if (s.editPlan) for (const i of editIssues(s.editPlan, s.scenePlan, ctx, s.project, s.assets)) reasons.push(`edit plan is not valid: ${i}`);
    // Material the plan needs but nobody has supplied blocks production, however well the plans were approved.
    for (const b of assetFeasibility(s.scenePlan, s.assets).blockers) reasons.push(`production is blocked: ${b}`);
  }

  return reasons.length || !sb || !ep ? { ok: false, reasons } : { ok: true, storyboard: sb, edit_plan: ep };
}

export class RenderRefusedError extends Error {
  constructor(readonly reasons: string[]) {
    super(`Rendering is not authorised: ${reasons.join("; ")}`);
    this.name = "RenderRefusedError";
  }
}

/** Throws RenderRefusedError listing every reason, or returns the exact plan versions and hashes that were authorised. */
export function assertRenderable(s: ApprovalState, ctx: { recipes: RecipeLibrary }): Extract<RenderCheck, { ok: true }> {
  const r = checkRenderable(s, ctx);
  if (!r.ok) throw new RenderRefusedError(r.reasons);
  return r;
}

/** Guards the edit-plan step itself: it may only run on a storyboard whose current version and hash have been approved. */
export function requireStoryboardApproval(s: ApprovalState): void {
  const sb = currentStoryboard(s);
  const rec = latestFor(parseRecords(s.approvals).records, "storyboard");
  if (!sb || !rec || rec.decision !== "approved" || rec.plan_version !== sb.version || rec.plan_hash !== sb.hash) {
    throw new StaleApprovalError("The edit plan cannot be made before the current storyboard version is approved.");
  }
}
