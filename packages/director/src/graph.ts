import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from "@langchain/langgraph";
import type {
  Asset, AssetNotes, BrandFact, EditPlan, Escalation, Project, ScenePlan, Treatment,
} from "@digikon/contracts";
import {
  analyseAssets, editPlanNode, escalationFor, intakeNode, storyboardNode, treatmentNode,
  type Deps, type IntakeOut,
} from "./nodes.js";

export type DirectorStatus =
  | "running" | "needs_clarification" | "awaiting_approval" | "approved" | "rejected" | "escalated";

export interface ApprovalDecision { approved: boolean; notes?: string }

const concat = <T,>(a: T[], b: T[]) => [...a, ...b];
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

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
  decision: Annotation<ApprovalDecision | null>(),
  status: Annotation<DirectorStatus>(),
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

/**
 * Plan-level Director: brief in, validated scene plan and edit plan out, paused for human approval.
 * Rendering, QA and revision attach after the approval node in later milestones.
 */
export function buildDirectorGraph(deps: Deps, checkpointer = new MemorySaver()) {
  const g = new StateGraph(DirectorState)
    .addNode("intake", async (s: DirectorStateType) => {
      const { out, skills, references, citations } = await intakeNode(deps, s.project, s.assets);
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
      const { treatment, skills, references, citations } = await treatmentNode(deps, s.project, s.facts ?? []);
      const unsupported = treatment.claims.filter((c) => c.brand_fact_id === null).length;
      return { treatmentDoc: treatment, skillsUsed: skills, referencesUsed: references, citations, trace: [`treatment: ${treatment.beats.length} beats, ${treatment.claims.length} claims (${unsupported} unsupported)`] };
    })
    .addNode("storyboard", async (s: DirectorStateType) => {
      const r = await storyboardNode(deps, s.project, s.assets, s.notes, s.treatmentDoc!, s.facts ?? []);
      if (r.issues.length) {
        return {
          escalation: escalationFor("storyboard", r.issues, [`generated and repaired the storyboard (${r.attempts} attempts)`]),
          status: "escalated" as const, skillsUsed: r.skills, referencesUsed: r.references, citations: r.citations, trace: [`storyboard: escalated with ${r.issues.length} issue(s)`],
        };
      }
      return { scenePlan: r.value, skillsUsed: r.skills, referencesUsed: r.references, citations: r.citations, trace: [`storyboard: ${r.value.scenes.length} scenes in ${r.attempts} attempt(s)`] };
    })
    .addNode("edit_plan", async (s: DirectorStateType) => {
      const r = await editPlanNode(deps, s.project, s.assets, s.scenePlan!);
      if ("escalation" in r && r.escalation) {
        return { escalation: r.escalation, status: "escalated" as const, skillsUsed: r.skills, referencesUsed: r.references, trace: ["edit_plan: escalated (no recipes available)"] };
      }
      const ok = r as Extract<typeof r, { value: EditPlan }>;
      if (ok.issues.length) {
        return {
          escalation: escalationFor("edit plan", ok.issues, [`generated and repaired the edit plan (${ok.attempts} attempts)`]),
          status: "escalated" as const, skillsUsed: ok.skills, referencesUsed: ok.references, citations: ok.citations, trace: [`edit_plan: escalated with ${ok.issues.length} issue(s)`],
        };
      }
      return { editPlan: ok.value, skillsUsed: ok.skills, referencesUsed: ok.references, citations: ok.citations, status: "awaiting_approval" as const, trace: [`edit_plan: ${ok.value.uses.length} recipe uses in ${ok.attempts} attempt(s)`] };
    })
    .addNode("approve", async (s: DirectorStateType) => {
      // Pauses the run and saves state. Resume with new Command({ resume: { approved, notes } }).
      const decision = interrupt({
        kind: "plan_approval",
        treatment: s.treatmentDoc, scenePlan: s.scenePlan, editPlan: s.editPlan,
        question: "Approve this plan for rendering?",
      }) as ApprovalDecision;
      return { decision, status: decision.approved ? ("approved" as const) : ("rejected" as const), trace: [`approve: ${decision.approved ? "approved" : "rejected"}`] };
    })
    .addEdge(START, "intake")
    .addConditionalEdges("intake", (s: DirectorStateType) => (s.status === "needs_clarification" ? END : "analyse_assets"), ["analyse_assets", END])
    .addEdge("analyse_assets", "treatment")
    .addEdge("treatment", "storyboard")
    .addConditionalEdges("storyboard", (s: DirectorStateType) => (s.status === "escalated" ? END : "edit_plan"), ["edit_plan", END])
    .addConditionalEdges("edit_plan", (s: DirectorStateType) => (s.status === "escalated" ? END : "approve"), ["approve", END])
    .addEdge("approve", END);
  return g.compile({ checkpointer });
}

export { Command };
