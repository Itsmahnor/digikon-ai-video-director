import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from "@langchain/langgraph";
import {
  ApprovalRecord, ApprovalSubmission, MAX_REVISIONS_PER_GATE,
  type ApprovalStage, type Asset, type AssetNotes, type BrandFact, type EditPlan, type Escalation, type Project, type ReviewDecision, type ScenePlan, type Treatment,
} from "@digikon/contracts";
import { currentEditPlan, currentEvidenceHash, currentStoryboard, requireStoryboardApproval } from "./approvals.js";
import {
  analyseAssets, editPlanNode, escalationFor, intakeNode, storyboardNode, treatmentNode,
  type Deps, type IntakeOut,
} from "./nodes.js";

/** `awaiting_approval` covers both human gates; `gate` in the state says which one. `approved` means both gates passed, not that rendering is allowed: only `assertRenderable` decides that. */
export type DirectorStatus =
  | "running" | "needs_clarification" | "awaiting_approval" | "approved" | "escalated";

/** Identifies the graph's shape (nodes, gates, state). A saved checkpoint from any other version is refused, never adapted. */
export const DIRECTOR_GRAPH_VERSION = "director-graph/4"; // 3: scenes carry production fields, claims a kind. 4: assets carry licence and genuine-product-UI declarations

/** How many change requests one gate accepts. The next one escalates. */
export const MAX_REVISIONS = MAX_REVISIONS_PER_GATE;

const concat = <T,>(a: T[], b: T[]) => [...a, ...b];
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
type Counts = Record<ApprovalStage, number>;

export const DirectorState = Annotation.Root({
  project: Annotation<Project>(),
  assets: Annotation<Asset[]>(),
  facts: Annotation<BrandFact[]>(),
  notes: Annotation<AssetNotes[]>(),
  intakeResult: Annotation<IntakeOut | null>(),
  treatmentDoc: Annotation<Treatment | null>(),
  scenePlan: Annotation<ScenePlan | null>(),
  editPlan: Annotation<EditPlan | null>(),
  escalation: Annotation<Escalation | null>(),
  status: Annotation<DirectorStatus>(),
  /** The gate waiting for a human decision, or null. */
  gate: Annotation<ApprovalStage | null>(),
  /** Every decision made so far, oldest first. Approvals are never edited or removed. */
  approvals: Annotation<ApprovalRecord[]>({ reducer: concat, default: () => [] }),
  /** A change request on its way back to the step that must act on it. */
  pendingRevision: Annotation<{ stage: ApprovalStage; notes: string } | null>(),
  /** Change requests used so far at each gate. */
  revisions: Annotation<Counts>({ reducer: (_old, next) => next, default: () => ({ storyboard: 0, edit_plan: 0 }) }),
  /** Skills actually loaded per step, for the audit record. */
  skillsUsed: Annotation<string[]>({ reducer: union, default: () => [] }),
  /** Skill reference files shown to the model, as skill/file. */
  referencesUsed: Annotation<string[]>({ reducer: union, default: () => [] }),
  /** Ids of every retrieved document or recipe the model was shown. */
  citations: Annotation<string[]>({ reducer: union, default: () => [] }),
  trace: Annotation<string[]>({ reducer: concat, default: () => [] }),
});
export type DirectorStateType = typeof DirectorState.State;

export interface DirectorInput {
  project: Project;
  assets: Asset[];
  facts?: BrandFact[];
  /** Pre-made asset notes (for example from a vision pass). Missing assets get metadata-only notes. */
  notes?: AssetNotes[];
}

const STAGE_LABEL: Record<ApprovalStage, string> = { storyboard: "storyboard", edit_plan: "edit plan" };

/** The decision that resumes a paused graph. Name the stage and plan version being decided. */
export function gateDecision(stage: ApprovalStage, plan_version: number, decision: ReviewDecision, notes = "", storyboard_version?: number) {
  return new Command<unknown, typeof DirectorState.Update, never>({ resume: ApprovalSubmission.parse({ stage, plan_version, decision, notes, ...(storyboard_version ? { storyboard_version } : {}) }) });
}

/** Approves whatever the graph is waiting on, naming its exact version. For the CLI's --yes, the eval harness and tests. */
export function approveCurrent(state: DirectorStateType) {
  if (!state.gate) throw new Error("the Director is not waiting for a decision");
  const version = state.gate === "storyboard" ? state.scenePlan!.version : state.editPlan!.version;
  return gateDecision(state.gate, version, "approved", "", state.scenePlan!.version);
}

function revisionEscalation(stage: ApprovalStage, history: string[]): Escalation {
  return {
    what_failed: `The ${STAGE_LABEL[stage]} was still not accepted after ${MAX_REVISIONS} revisions.`,
    evidence: history.slice(-5),
    what_was_tried: history.map((n, i) => `revision ${i + 1}: ${n}`),
    options_left: ["change the brief or the supplied files and start a new run", "edit the plan by hand and approve that version", "accept the latest version as it is"],
    decision_needed: `The ${STAGE_LABEL[stage]} keeps missing the reviewer's expectations. What should change before another attempt?`,
  };
}

/**
 * Plan-level Director with two human gates:
 * brief -> treatment -> storyboard -> GATE 1 -> edit plan -> GATE 2 -> approved.
 * A change request at a gate goes back to the step that made the plan, which produces the next version and returns to the same gate.
 * Rendering, QA and export attach after gate 2 in later milestones, behind `assertRenderable`.
 */
export function buildDirectorGraph(deps: Deps, checkpointer = new MemorySaver()) {
  const gateNode = (stage: ApprovalStage) => async (s: DirectorStateType) => {
    const cur = stage === "storyboard" ? currentStoryboard(s) : currentEditPlan(s);
    if (!cur) throw new Error(`no ${STAGE_LABEL[stage]} to review`);
    const earlier = s.approvals.filter((a) => a.stage === stage && a.decision === "revision_requested").map((a) => ({ plan_version: a.plan_version, notes: a.notes }));
    /** Why a decision does not apply to the plan waiting right now, or null when it does. */
    const staleReason = (d: ApprovalSubmission): string | null =>
      d.stage !== stage ? `This decision is for the ${STAGE_LABEL[d.stage]}, but the ${STAGE_LABEL[stage]} is waiting.`
      : d.plan_version !== cur.version ? `This decision is for ${STAGE_LABEL[stage]} version ${d.plan_version}, but version ${cur.version} is waiting.`
      : d.storyboard_version !== undefined && d.storyboard_version !== s.scenePlan!.version ? `This decision assumes storyboard version ${d.storyboard_version}, but the storyboard is version ${s.scenePlan!.version}.`
      : null;

    // Pauses the run and saves state. Resume with gateDecision(...). A decision that does not match this exact stage and version
    // is never applied: the gate pauses again, saying why, and nothing is recorded. (The console also answers such a decision with 409 before it gets here.)
    let refused: string | null = null;
    let sub: ApprovalSubmission;
    for (;;) {
      const raw = interrupt({
        kind: `${stage}_approval`, stage, plan_version: cur.version, plan_hash: cur.hash,
        treatment: s.treatmentDoc, scenePlan: s.scenePlan, editPlan: stage === "edit_plan" ? s.editPlan : null,
        revisions_used: s.revisions[stage], max_revisions: MAX_REVISIONS, earlier_requests: earlier, refused_previous: refused,
        question: stage === "storyboard" ? "Approve this storyboard so the edit plan can be made?" : "Approve this edit plan?",
      });
      const parsed = ApprovalSubmission.safeParse(raw);
      refused = !parsed.success ? "The decision was malformed and was ignored." : staleReason(parsed.data);
      if (parsed.success && !refused) { sub = parsed.data; break; }
    }
    const record = ApprovalRecord.parse({
      stage, plan_version: cur.version, storyboard_version: s.scenePlan!.version, plan_hash: cur.hash, evidence_hash: currentEvidenceHash(s)!,
      decision: sub.decision, notes: sub.notes.trim(), decided_at: new Date().toISOString(),
    });
    // Written before the decision takes effect. If the write fails this node throws, the graph stays paused at the gate,
    // and nothing is recorded in state either.
    deps.approvalLog?.append(record);
    if (sub.decision === "approved") {
      return { approvals: [record], gate: null, pendingRevision: null, status: stage === "edit_plan" ? ("approved" as const) : ("running" as const), trace: [`${stage}_gate: approved version ${cur.version}`] };
    }
    const used = s.revisions[stage];
    if (used >= MAX_REVISIONS) {
      const history = [...earlier.map((e) => e.notes), record.notes];
      return { approvals: [record], gate: null, pendingRevision: null, escalation: revisionEscalation(stage, history), status: "escalated" as const, trace: [`${stage}_gate: revision limit (${MAX_REVISIONS}) reached, escalated`] };
    }
    return {
      approvals: [record], gate: null, pendingRevision: { stage, notes: record.notes }, revisions: { ...s.revisions, [stage]: used + 1 },
      status: "running" as const, trace: [`${stage}_gate: changes requested on version ${cur.version} (revision ${used + 1} of ${MAX_REVISIONS})`],
    };
  };

  const g = new StateGraph(DirectorState)
    .addNode("intake", async (s: DirectorStateType) => {
      const { out, skills, references, citations } = await intakeNode(deps, s.project, s.assets, s.notes ?? []);
      return {
        intakeResult: out, skillsUsed: skills, referencesUsed: references, citations,
        status: out.status === "ready" ? ("running" as const) : ("needs_clarification" as const),
        trace: [`intake: ${out.status}`],
      };
    })
    .addNode("analyse_assets", async (s: DirectorStateType) => {
      const notes = analyseAssets(s.assets, s.notes ?? []);
      return { notes, skillsUsed: ["cinematography"], trace: [`analyse_assets: ${notes.length} asset(s), ${notes.filter((n) => n.uncertain.length).length} with uncertainty`] };
    })
    .addNode("treatment", async (s: DirectorStateType) => {
      const { treatment, skills, references, citations } = await treatmentNode(deps, s.project, s.facts ?? [], s.notes ?? []);
      const unsupported = treatment.claims.filter((c) => c.brand_fact_id === null).length;
      return { treatmentDoc: treatment, skillsUsed: skills, referencesUsed: references, citations, trace: [`treatment: ${treatment.beats.length} beats, ${treatment.claims.length} claims (${unsupported} unsupported)`] };
    })
    // Makes the first storyboard, or the next version of it when the reviewer asked for changes. Always ends at gate 1.
    .addNode("storyboard", async (s: DirectorStateType) => {
      const rev = s.pendingRevision?.stage === "storyboard" ? s.pendingRevision : null;
      const previous = s.scenePlan;
      const version = rev && previous ? previous.version + 1 : 1;
      const r = await storyboardNode(deps, s.project, s.assets, s.notes, s.treatmentDoc!, s.facts ?? [], version, rev && previous ? { notes: rev.notes, previous } : undefined);
      if (r.issues.length) {
        return {
          escalation: escalationFor("storyboard", r.issues, [`generated and repaired the storyboard (${r.attempts} attempts)`]),
          pendingRevision: null, gate: null, status: "escalated" as const, skillsUsed: r.skills, referencesUsed: r.references, citations: r.citations, trace: [`storyboard: escalated with ${r.issues.length} issue(s)`],
        };
      }
      return {
        scenePlan: r.value, editPlan: null, pendingRevision: null, gate: "storyboard" as const, status: "awaiting_approval" as const,
        skillsUsed: r.skills, referencesUsed: r.references, citations: r.citations,
        trace: [`storyboard: version ${version}, ${r.value.scenes.length} scenes in ${r.attempts} attempt(s)`],
      };
    })
    .addNode("storyboard_gate", gateNode("storyboard"))
    // Makes the first edit plan, or the next version of it. Cannot run until the current storyboard is approved.
    .addNode("edit_plan", async (s: DirectorStateType) => {
      requireStoryboardApproval(s);
      const rev = s.pendingRevision?.stage === "edit_plan" ? s.pendingRevision : null;
      const previous = s.editPlan;
      const version = rev && previous ? previous.version + 1 : 1;
      const r = await editPlanNode(deps, s.project, s.assets, s.scenePlan!, version, rev && previous ? { notes: rev.notes, previous } : undefined);
      if ("escalation" in r && r.escalation) {
        return { escalation: r.escalation, pendingRevision: null, gate: null, status: "escalated" as const, skillsUsed: r.skills, referencesUsed: r.references, trace: ["edit_plan: escalated (no recipes available)"] };
      }
      const ok = r as Extract<typeof r, { value: EditPlan }>;
      if (ok.issues.length) {
        return {
          escalation: escalationFor("edit plan", ok.issues, [`generated and repaired the edit plan (${ok.attempts} attempts)`]),
          pendingRevision: null, gate: null, status: "escalated" as const, skillsUsed: ok.skills, referencesUsed: ok.references, citations: ok.citations, trace: [`edit_plan: escalated with ${ok.issues.length} issue(s)`],
        };
      }
      return {
        editPlan: ok.value, pendingRevision: null, gate: "edit_plan" as const, status: "awaiting_approval" as const,
        skillsUsed: ok.skills, referencesUsed: ok.references, citations: ok.citations,
        trace: [`edit_plan: version ${version}, ${ok.value.uses.length} recipe uses in ${ok.attempts} attempt(s)`],
      };
    })
    .addNode("edit_plan_gate", gateNode("edit_plan"))
    .addEdge(START, "intake")
    .addConditionalEdges("intake", (s: DirectorStateType) => (s.status === "needs_clarification" ? END : "analyse_assets"), ["analyse_assets", END])
    .addEdge("analyse_assets", "treatment")
    .addEdge("treatment", "storyboard")
    .addConditionalEdges("storyboard", (s: DirectorStateType) => (s.status === "escalated" ? END : "storyboard_gate"), ["storyboard_gate", END])
    .addConditionalEdges("storyboard_gate", (s: DirectorStateType) => (s.status === "escalated" ? END : s.pendingRevision?.stage === "storyboard" ? "storyboard" : "edit_plan"), ["storyboard", "edit_plan", END])
    .addConditionalEdges("edit_plan", (s: DirectorStateType) => (s.status === "escalated" ? END : "edit_plan_gate"), ["edit_plan_gate", END])
    .addConditionalEdges("edit_plan_gate", (s: DirectorStateType) => (s.status === "escalated" ? END : s.pendingRevision?.stage === "edit_plan" ? "edit_plan" : END), ["edit_plan", END]);
  return g.compile({ checkpointer });
}

export { Command };
