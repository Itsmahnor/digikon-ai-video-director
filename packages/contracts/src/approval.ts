import { createHash } from "node:crypto";
import { z } from "zod";
import type { AssetNotes, BrandFact, EditPlan, Treatment } from "./director.js";
import type { Asset, ScenePlan } from "./schemas.js";

/** The two human checkpoints, in order. */
export const ApprovalStage = z.enum(["storyboard", "edit_plan"]);
export type ApprovalStage = z.infer<typeof ApprovalStage>;

export const ReviewDecision = z.enum(["approved", "revision_requested"]);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

/** How many times a reviewer may ask for changes at one gate. The request after that escalates instead of looping. */
export const MAX_REVISIONS_PER_GATE = 2;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 hex digest");
const Notes = z.string().max(2000).default("");

/**
 * What the reviewer sends. The stage and version say which plan they were looking at, so a decision made on an older
 * screen can be refused instead of applied to a newer plan.
 */
export const ApprovalSubmission = z
  .object({
    stage: ApprovalStage,
    plan_version: z.number().int().positive(),
    /** At the edit-plan gate: the storyboard version the reviewer believes is approved. Checked when present. */
    storyboard_version: z.number().int().positive().optional(),
    decision: ReviewDecision,
    notes: Notes,
  })
  .refine((s) => s.decision !== "revision_requested" || s.notes.trim().length > 0, { message: "a revision request needs notes saying what to change", path: ["notes"] });
export type ApprovalSubmission = z.infer<typeof ApprovalSubmission>;

/** One recorded decision. Approval of this record authorises exactly the plan whose hash it carries, and nothing else. */
export const ApprovalRecord = z
  .object({
    stage: ApprovalStage,
    plan_version: z.number().int().positive(),
    /** The storyboard version this decision sits on. Equal to plan_version at the storyboard gate. */
    storyboard_version: z.number().int().positive(),
    plan_hash: Sha256,
    /**
     * Hash of the evidence the plan rests on: the assets the storyboard uses (identity and measured metadata, including file
     * size), their analysis notes, and the approved facts behind the claims it shows. Optional so older records still parse,
     * but a record without it cannot authorise a render or a handoff.
     */
    evidence_hash: Sha256.optional(),
    decision: ReviewDecision,
    notes: Notes,
    decided_at: z.string().datetime(),
  })
  .refine((r) => r.stage !== "storyboard" || r.storyboard_version === r.plan_version, { message: "a storyboard record must carry its own version", path: ["storyboard_version"] })
  .refine((r) => r.decision !== "revision_requested" || r.notes.trim().length > 0, { message: "a revision request needs notes", path: ["notes"] });
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;

// ---------- canonical serialisation and hashes ----------

/**
 * Deterministic JSON: object keys sorted, no whitespace, undefined properties dropped, arrays keep their order.
 * The same plan always serialises to the same string, whatever order its keys were built in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("cannot canonicalise a non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new Error(`cannot canonicalise a ${typeof value}`);
  }
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const hashCanonical = (value: unknown): string => sha256Hex(canonicalJson(value));

/**
 * Version rules. A plan starts at version 1. Every revision produces the next integer, and a new version has no approval.
 * The storyboard gate covers the treatment (it holds the claims register) and the scene plan together.
 */
export const storyboardHash = (treatment: Treatment, scenePlan: ScenePlan): string =>
  hashCanonical({ stage: "storyboard", treatment, scene_plan: scenePlan });

export interface EvidenceInput {
  treatment: Treatment;
  scenePlan: ScenePlan;
  assets: readonly Asset[];
  facts: readonly BrandFact[];
  notes: readonly AssetNotes[];
}

/**
 * The evidence an approval covers, in a fixed order: every asset a scene uses (the whole Asset record: id, uri, media type,
 * duration, size in pixels, audio tracks, transcript ref and probe metadata such as bytes), the analysis notes for those assets,
 * and every fact behind a claim a scene shows (id, text and source). Assets, notes or facts the plan does not use are left
 * out, so unrelated uploads do not invalidate an approval. A fact a scene's claim points to but which is missing is listed by id
 * with null text, so its absence changes the hash too.
 */
export function approvedEvidence(e: EvidenceInput) {
  const used = new Set(e.scenePlan.scenes.flatMap((s) => s.asset_ids));
  const claimIds = new Set(e.scenePlan.scenes.flatMap((s) => s.claim_ids));
  const factIds = new Set(e.treatment.claims.filter((c) => claimIds.has(c.claim_id) && c.brand_fact_id).map((c) => c.brand_fact_id!));
  const byId = <T,>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return {
    assets: e.assets.filter((a) => used.has(a.asset_id)).sort(byId((a) => a.asset_id)),
    notes: e.notes.filter((n) => used.has(n.asset_id)).sort(byId((n) => n.asset_id)),
    facts: [...factIds].sort().map((id) => e.facts.find((f) => f.fact_id === id) ?? { fact_id: id, text: null, source: null }),
  };
}
export const evidenceHash = (e: EvidenceInput): string => hashCanonical({ stage: "evidence", ...approvedEvidence(e) });

/** The edit plan is hashed together with the storyboard it was built on, so approving it binds it to that exact storyboard. */
export const editPlanHash = (storyboard: { version: number; hash: string }, editPlan: EditPlan): string =>
  hashCanonical({ stage: "edit_plan", storyboard_version: storyboard.version, storyboard_hash: storyboard.hash, edit_plan: editPlan });
