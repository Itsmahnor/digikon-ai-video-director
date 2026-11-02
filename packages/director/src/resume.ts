import { z } from "zod";
import {
  AdvisoryReport, ApprovalRecord, ApprovalStage, Asset, AssetNotes, BrandFact, CompiledEditPlan, EditPlan, Escalation, ProductionDecisionPlan, Project, ScenePlan, Treatment, canonicalJson,
} from "@digikon/contracts";
import type { RecipeLibrary } from "@digikon/recipes";
import { PRODUCTION_REASON, checkRenderable, currentEditPlan, currentEvidenceHash, currentStoryboard } from "./approvals.js";
import { verifyProductionIntegrity } from "./production/integrity.js";
import { DIRECTOR_GRAPH_VERSION, type DirectorStateType, type buildDirectorGraph } from "./graph.js";
import { assetFileProblems, type AssetFiles } from "./handoff.js";
import { IntakeOut, editIssues, planIssues } from "./nodes.js";
import type { RunStore } from "./store.js";

export const CHECKPOINT_FORMAT = "digikon.checkpoint";

/**
 * The part of the Director state needed to resume a run where it stopped. Only states that are safe to stop in are saved:
 * waiting at a gate, approved, or escalated. A run in the middle of a model step is never checkpointed.
 */
export const PersistedDirectorState = z
  .object({
    project: Project,
    assets: z.array(Asset),
    facts: z.array(BrandFact),
    notes: z.array(AssetNotes),
    intakeResult: IntakeOut.nullable(),
    treatmentDoc: Treatment.nullable(),
    scenePlan: ScenePlan.nullable(),
    editPlan: EditPlan.nullable(),
    /** Added with production planning. Absent in checkpoints written before it existed, which stay readable. */
    advisory: AdvisoryReport.nullable().optional(),
    productionPlan: ProductionDecisionPlan.nullable().optional(),
    compiledPlan: CompiledEditPlan.nullable().optional(),
    escalation: Escalation.nullable(),
    status: z.enum(["awaiting_approval", "approved", "escalated"]),
    gate: ApprovalStage.nullable(),
    approvals: z.array(ApprovalRecord),
    revisions: z.object({ storyboard: z.number().int().nonnegative(), edit_plan: z.number().int().nonnegative() }),
    skillsUsed: z.array(z.string()),
    referencesUsed: z.array(z.string()),
    citations: z.array(z.string()),
    trace: z.array(z.string()),
  })
  .superRefine((s, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message, path: ["gate"] });
    if (s.status === "awaiting_approval" && !s.gate) bad("a waiting run must name its gate");
    if (s.status !== "awaiting_approval" && s.gate) bad("only a waiting run has a gate");
    if (s.gate && (!s.treatmentDoc || !s.scenePlan)) bad("a gate needs a treatment and a storyboard");
    if (s.gate === "storyboard" && s.editPlan) bad("at the storyboard gate there is no edit plan yet");
    if (s.gate === "edit_plan" && !s.editPlan) bad("the edit-plan gate needs an edit plan");
    if (s.status === "approved" && (!s.scenePlan || !s.editPlan)) bad("an approved run needs both plans");
  });
export type PersistedDirectorState = z.infer<typeof PersistedDirectorState>;

export const DirectorCheckpoint = z.object({
  format: z.literal(CHECKPOINT_FORMAT),
  format_version: z.literal(1),
  graph_version: z.string(),
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  saved_at: z.string().datetime(),
  /** The plan waiting at the gate, as the reviewer will see it. Null when nothing is waiting. */
  waiting: z.object({ stage: ApprovalStage, plan_version: z.number().int().positive(), plan_hash: z.string().regex(/^[a-f0-9]{64}$/) }).nullable(),
  state: PersistedDirectorState,
});
export type DirectorCheckpoint = z.infer<typeof DirectorCheckpoint>;

/** Builds the checkpoint for a state that has stopped. Throws for a state that is not safe to resume from. */
export function checkpointOf(s: DirectorStateType, ids: { session_id: string; run_id: string }, now = new Date()): DirectorCheckpoint {
  const state = PersistedDirectorState.parse({
    project: s.project, assets: s.assets, facts: s.facts ?? [], notes: s.notes ?? [], intakeResult: s.intakeResult ?? null,
    treatmentDoc: s.treatmentDoc ?? null, scenePlan: s.scenePlan ?? null, editPlan: s.editPlan ?? null, advisory: s.advisory ?? null, productionPlan: s.productionPlan ?? null, compiledPlan: s.compiledPlan ?? null, escalation: s.escalation ?? null,
    status: s.status, gate: s.gate ?? null, approvals: s.approvals ?? [], revisions: s.revisions,
    skillsUsed: s.skillsUsed ?? [], referencesUsed: s.referencesUsed ?? [], citations: s.citations ?? [], trace: s.trace ?? [],
  });
  return DirectorCheckpoint.parse({
    format: CHECKPOINT_FORMAT, format_version: 1, graph_version: DIRECTOR_GRAPH_VERSION, ...ids, saved_at: now.toISOString(),
    waiting: waitingPlan(state), state,
  });
}

function waitingPlan(s: PersistedDirectorState): DirectorCheckpoint["waiting"] {
  if (!s.gate) return null;
  const cur = s.gate === "storyboard" ? currentStoryboard(s) : currentEditPlan(s);
  return cur ? { stage: s.gate, plan_version: cur.version, plan_hash: cur.hash } : null;
}

const latest = (records: ApprovalRecord[], stage: ApprovalStage) => [...records].reverse().find((r) => r.stage === stage) ?? null;

export interface ResumeContext { recipes: RecipeLibrary; files?: AssetFiles; storageRoot?: string; requireContentHash?: boolean }

/**
 * Whether a saved state may be resumed, using the same checks as the rest of the Director. The stored approval files are the
 * reference: the checkpoint's own approval history must equal them exactly, so a checkpoint older or newer than the stored
 * decisions, or edited, is refused. Then the waiting plan, the approvals it rests on, its evidence and its files are checked.
 */
export function resumeProblems(cp: DirectorCheckpoint, store: RunStore, ctx: ResumeContext): string[] {
  const { records, problems } = store.loadApprovals(cp.run_id);
  if (problems.length) return problems.map((p) => `stored approvals cannot be trusted: ${p}`);
  const s = cp.state;
  if (canonicalJson(s.approvals) !== canonicalJson(records)) {
    return [`the checkpoint's approval history does not match the stored approvals${s.approvals.length !== records.length ? ` (${s.approvals.length} in the checkpoint, ${records.length} stored)` : ""}`];
  }

  const reasons: string[] = [];
  if (canonicalJson(waitingPlan(s)) !== canonicalJson(cp.waiting)) reasons.push("the checkpoint's waiting plan does not match its recorded version and hash");

  if (s.status === "approved") {
    const r = checkRenderable(s, ctx);
    if (!r.ok) reasons.push(...r.reasons);
  } else if (s.gate) {
    const sb = currentStoryboard(s)!;
    const ev = currentEvidenceHash(s);
    const sbRec = latest(records, "storyboard");
    if (s.gate === "storyboard") {
      if (sbRec?.decision === "approved" && sbRec.plan_version === sb.version) reasons.push(`storyboard version ${sb.version} was already approved, so this checkpoint is out of date`);
    } else {
      // Waiting at gate 2 is only legitimate on top of a valid gate-1 approval of exactly this storyboard and its evidence.
      if (!sbRec || sbRec.decision !== "approved") reasons.push("the storyboard has not been approved");
      else {
        if (sbRec.plan_version !== sb.version) reasons.push(`the approval is for storyboard version ${sbRec.plan_version}, but the current storyboard is version ${sb.version}`);
        else if (sbRec.plan_hash !== sb.hash) reasons.push("the storyboard changed after it was approved (hash mismatch)");
        if (!sbRec.evidence_hash) reasons.push("the storyboard approval carries no evidence hash, so its assets and facts cannot be verified");
        else if (sbRec.evidence_hash !== ev) reasons.push("the assets or approved facts changed after the storyboard was approved (evidence hash mismatch)");
      }
      const ep = currentEditPlan(s)!;
      // Waiting at gate 2 with production planning: the plans shown must be intact and be those of this storyboard and edit plan. A run made without it (no flag on its
      // storyboard approval) has none, as before; plans that are present are verified either way.
      const production = sbRec?.decision === "approved" && !!sbRec.production_required;
      if (production && (!s.productionPlan || !s.compiledPlan)) reasons.push(`${PRODUCTION_REASON}: the production plans are missing`);
      else if (s.productionPlan || s.compiledPlan) reasons.push(...verifyProductionIntegrity(s.productionPlan, s.compiledPlan, { storyboard: sb, edit_plan: ep }).map((r) => `${PRODUCTION_REASON}: ${r}`));
      const epRec = latest(records, "edit_plan");
      if (epRec?.decision === "approved" && epRec.plan_version === ep.version) reasons.push(`edit plan version ${ep.version} was already approved, so this checkpoint is out of date`);
    }
    for (const i of planIssues(s.scenePlan!, s.assets, s.project, s.notes, s.treatmentDoc!, s.facts)) reasons.push(`storyboard is not valid: ${i}`);
    if (s.editPlan) for (const i of editIssues(s.editPlan, s.scenePlan!, ctx, s.project, s.assets)) reasons.push(`edit plan is not valid: ${i}`);
  }

  if (s.scenePlan) {
    const used = new Set(s.scenePlan.scenes.flatMap((sc) => sc.asset_ids));
    reasons.push(...assetFileProblems(s.assets.filter((a) => used.has(a.asset_id)), ctx.files, ctx.storageRoot, ctx.requireContentHash));
  }
  return reasons;
}

export type RestoreResult =
  | { ok: true; state: DirectorStateType; checkpoint: DirectorCheckpoint }
  | { ok: false; missing: boolean; reasons: string[] };

/**
 * Restores a stopped run into a fresh graph, after every check passes. A waiting run is put back just before its gate and run
 * into it, so it pauses for a human decision exactly as before. Nothing is approved and nothing starts over: any failure
 * returns the reasons and leaves the graph untouched. The session and run ids only locate the files; they authorise nothing.
 */
export async function restoreRun(opts: {
  store: RunStore;
  graph: ReturnType<typeof buildDirectorGraph>;
  session_id: string;
  run_id: string;
  ctx: ResumeContext;
}): Promise<RestoreResult> {
  const { checkpoint, problems } = opts.store.loadCheckpoint(opts.run_id);
  if (problems.length) return { ok: false, missing: false, reasons: problems };
  if (!checkpoint) return { ok: false, missing: true, reasons: [`there is no saved checkpoint for run ${opts.run_id}`] };
  if (checkpoint.session_id !== opts.session_id) return { ok: false, missing: false, reasons: [`checkpoint.json belongs to session ${checkpoint.session_id}, not ${opts.session_id}`] };
  const reasons = resumeProblems(checkpoint, opts.store, opts.ctx);
  if (reasons.length) return { ok: false, missing: false, reasons };

  const config = { configurable: { thread_id: opts.run_id } };
  const s = checkpoint.state;
  // As if the step that made the waiting plan had just finished, so the graph's own edges lead into the gate.
  const asNode = s.gate === "storyboard" ? "storyboard" : s.gate === "edit_plan" ? "edit_plan" : "edit_plan_gate";
  await opts.graph.updateState(config, { ...s, pendingRevision: null }, asNode);
  if (s.gate) await opts.graph.invoke(null, config); // runs into the gate's pause; it does not decide anything
  const state = (await opts.graph.getState(config)).values as DirectorStateType;
  return { ok: true, state, checkpoint };
}
