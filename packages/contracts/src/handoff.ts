import { z } from "zod";
import { ApprovalRecord, canonicalJson, editPlanHash, evidenceHash, hashCanonical, storyboardHash } from "./approval.js";
import { AssetFeasibility, ClaimAuditEntry, assetFeasibility, auditClaims } from "./audit.js";
import { AssetNotes, BrandFact, Claim, EditPlan, Treatment } from "./director.js";
import { Renderer } from "./recipe.js";
import { Asset, OperationType, Project, ScenePlan } from "./schemas.js";

/**
 * Version of the handoff shape. A consumer refuses any other value instead of guessing. Bump the major part when a field
 * is removed or changes meaning, the minor part when an optional field is added.
 */
export const HANDOFF_SCHEMA_VERSION = "1.2.0" as const;
// 1.1.0: approval records carry evidence_hash, and it is checked.
// 1.2.0: scenes carry voiceover, production method and required assets; adds claims_audit, asset_feasibility,
//        required_operations and readiness; the project no longer carries owner_id. Older handoffs are refused, not converted.

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 hex digest");
const PlanRef = z.object({ version: z.number().int().positive(), hash: Sha256 });

/** One retrieved document, recipe or fact the Director was shown, with where it came from. `source` is null when the id could not be resolved, which is itself worth seeing. */
export const ProvenanceEntry = z.object({
  id: z.string().min(1),
  kind: z.enum(["knowledge", "recipe", "brand_fact", "unknown"]),
  source: z.string().nullable(),
  /** Knowledge grade A/B/C, or the recipe's status. Null when the source has neither. */
  quality: z.string().nullable(),
});
export type ProvenanceEntry = z.infer<typeof ProvenanceEntry>;

/** A claim that a scene states, together with the approved fact that supports it. Unsupported claims never reach the handoff. */
export const GroundedClaim = z.object({ claim: Claim, fact: BrandFact, scene_ids: z.array(z.string()).min(1) });
export type GroundedClaim = z.infer<typeof GroundedClaim>;

/** One recipe use the Editor must carry out, with what is known about the recipe behind it. */
export const RequiredOperation = z.object({
  use_id: z.string(),
  scene_id: z.string(),
  recipe_id: z.string(),
  recipe_version: z.string(),
  recipe_status: z.enum(["draft", "reviewed"]),
  operation_type: OperationType,
  implementation_ref: z.string(),
  renderers: z.array(Renderer),
  /** "review_record" only when the recipe carries a review record. Nothing else counts as evidence. */
  evidence: z.enum(["none", "review_record"]),
});
export type RequiredOperation = z.infer<typeof RequiredOperation>;

/** Whether the plan could go to production today, and exactly what stops it. Recomputed by checkHandoff, never trusted. */
export const Readiness = z.object({
  production_ready: z.boolean(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type Readiness = z.infer<typeof Readiness>;

/** What output QA will check the finished video against. Only what the approved plan actually fixes; anything not yet decided is null. */
export const HandoffQa = z.object({
  target_duration_s: z.number().positive(),
  /** Same tolerance the storyboard validator uses. */
  duration_tolerance_s: z.number().nonnegative(),
  aspect_ratio: Project.shape.aspect_ratio,
  scene_spans: z.array(z.object({ scene_id: z.string(), start: z.number().nonnegative(), end: z.number().positive() })).min(1),
  /** True when a source the plan uses carries audio. */
  expect_audio: z.boolean(),
  /** Null until a verified platform spec gives a target. QA then only reports loudness. */
  loudness_target_lufs: z.number().nullable(),
  /** Claims that must appear exactly as approved. */
  grounded_claim_ids: z.array(z.string()),
});

/**
 * Everything the Editor needs, frozen at the moment both human approvals were valid. It carries copies, not references into
 * the Director's state, so the Editor never reads graph internals. `content_hash` covers every field except itself and
 * `created_at`, so the same approved plans always give the same hash.
 *
 * Mandatory: everything below. Arrays may be empty where the plan has nothing of that kind (for example no claims).
 * Not duplicated on purpose: timing and audio cues live in `storyboard.scenes` (start, duration, audio_cues, transition_out);
 * recipe parameters live in `edit_plan.uses`; the brief lives in `project`.
 */
export const DirectorHandoff = z.object({
  schema_version: z.literal(HANDOFF_SCHEMA_VERSION),
  /** `ho_` plus the first 16 hex characters of content_hash. */
  handoff_id: z.string().regex(/^ho_[a-f0-9]{16}$/),
  content_hash: Sha256,
  created_at: z.string().datetime(),
  run: z.object({
    run_id: z.string().min(1),
    /** The model id the run was configured with. "demo" or "scripted" for offline runs, never a claim about live quality. */
    model: z.string().min(1),
    recipe_library_mode: z.enum(["draft", "reviewed"]),
  }),
  /** Brief, objective, audience, platform, aspect ratio, duration and brand id, as the user gave them. The owner id stays out. */
  project: Project.omit({ owner_id: true }),
  treatment: Treatment,
  storyboard: ScenePlan,
  edit_plan: EditPlan,
  /** The two decisions that authorise this handoff. Both must be approvals of exactly the plans above. */
  approvals: z.object({ storyboard: ApprovalRecord, edit_plan: ApprovalRecord }),
  approved: z.object({ storyboard: PlanRef, edit_plan: PlanRef }),
  /** Only the assets the storyboard uses, with their measured metadata and notes. */
  assets: z.array(Asset),
  asset_notes: z.array(AssetNotes),
  claims: z.array(GroundedClaim),
  /** Every claim in the treatment, classified: supported, illustrative concept, or unsupported factual claim. Nothing is dropped. */
  claims_audit: z.array(ClaimAuditEntry),
  /** What each scene needs and whether it is supplied, buildable as graphics, external or missing. */
  asset_feasibility: AssetFeasibility,
  /** Every recipe use as an operation, with its type, renderer candidates and evidence status. */
  required_operations: z.array(RequiredOperation),
  readiness: Readiness,
  constraints: z.object({
    platform: z.string().min(1),
    aspect_ratio: Project.shape.aspect_ratio,
    target_duration_s: z.number().positive(),
    brand_id: z.string().nullable(),
    /** Ids of verified platform specs the Director retrieved. Empty when none exists. */
    platform_spec_ids: z.array(z.string()),
  }),
  qa: HandoffQa,
  provenance: z.object({
    /** As name@version. */
    skills: z.array(z.string()),
    /** Skill reference files shown to the model, as skill/file. */
    references: z.array(z.string()),
    /** Recipes the edit plan uses, with the exact version and status. */
    recipes: z.array(z.object({ recipe_id: z.string(), version: z.string(), status: z.enum(["draft", "reviewed"]) })),
    retrieved: z.array(ProvenanceEntry),
  }),
});
export type DirectorHandoff = z.infer<typeof DirectorHandoff>;

/** The hash of a handoff's content. Excludes the hash itself, the id derived from it, and the creation time. */
export function handoffContentHash(h: Partial<DirectorHandoff>): string {
  const { content_hash: _h, handoff_id: _i, created_at: _c, ...content } = h;
  return hashCanonical(content);
}

/**
 * Checks that a handoff is internally consistent without any Director state: the schema, the content hash, and that both
 * approvals are approvals of exactly the storyboard and edit plan it carries. Plan validity against recipes is checked
 * separately, by code that has the recipe library. Returns [] when consistent.
 */
export function verifyHandoffIntegrity(raw: unknown): string[] {
  const parsed = DirectorHandoff.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => `handoff ${i.path.join(".") || "root"}: ${i.message}`);
  const h = parsed.data;
  const problems: string[] = [];
  const hash = handoffContentHash(h);
  if (hash !== h.content_hash) problems.push("the handoff content changed after it was made (content hash mismatch)");
  if (h.handoff_id !== `ho_${h.content_hash.slice(0, 16)}`) problems.push("the handoff id does not match its content hash");

  const sb = { version: h.storyboard.version, hash: storyboardHash(h.treatment, h.storyboard) };
  const ep = { version: h.edit_plan.version, hash: editPlanHash(sb, h.edit_plan) };
  const { storyboard: sbRec, edit_plan: epRec } = h.approvals;
  if (sbRec.stage !== "storyboard" || sbRec.decision !== "approved") problems.push("the storyboard record is not a storyboard approval");
  if (epRec.stage !== "edit_plan" || epRec.decision !== "approved") problems.push("the edit-plan record is not an edit-plan approval");
  if (sbRec.plan_version !== sb.version || h.approved.storyboard.version !== sb.version) problems.push(`the storyboard approval is not for storyboard version ${sb.version}`);
  if (sbRec.plan_hash !== sb.hash || h.approved.storyboard.hash !== sb.hash) problems.push("the storyboard does not match its approval (hash mismatch)");
  if (epRec.plan_version !== ep.version || h.approved.edit_plan.version !== ep.version) problems.push(`the edit-plan approval is not for edit plan version ${ep.version}`);
  if (epRec.storyboard_version !== sb.version) problems.push(`the edit plan was approved on storyboard version ${epRec.storyboard_version}, not ${sb.version}`);
  if (epRec.plan_hash !== ep.hash || h.approved.edit_plan.hash !== ep.hash) problems.push("the edit plan does not match its approval (hash mismatch)");
  if (h.storyboard.project_id !== h.project.project_id || h.edit_plan.project_id !== h.project.project_id) problems.push("the plans belong to a different project");

  // The assets, notes and facts the handoff carries must be exactly the evidence both approvals were given. Re-hashing the
  // handoff cannot change this, because the evidence hash lives in the approval records.
  const factsById = new Map<string, z.infer<typeof BrandFact>>();
  for (const f of [...h.claims.map((c) => c.fact), ...h.claims_audit.flatMap((e) => (e.fact ? [e.fact] : []))]) factsById.set(f.fact_id, f);
  const facts = [...factsById.values()];
  const ev = evidenceHash({ treatment: h.treatment, scenePlan: h.storyboard, assets: h.assets, facts, notes: h.asset_notes });
  // The audit and the feasibility report are functions of the approved plans and facts: recompute them and compare.
  if (canonicalJson(auditClaims(h.treatment.claims, h.storyboard.scenes, facts)) !== canonicalJson(h.claims_audit)) problems.push("claims_audit does not match the treatment, storyboard and approved facts");
  if (canonicalJson(assetFeasibility(h.storyboard, h.assets)) !== canonicalJson(h.asset_feasibility)) problems.push("asset_feasibility does not match the storyboard and its assets");
  const missing = ([["storyboard", sbRec], ["edit plan", epRec]] as const).filter(([, r]) => !r.evidence_hash);
  for (const [label] of missing) problems.push(`the ${label} approval carries no evidence hash, so its assets and facts cannot be verified`);
  if ([sbRec, epRec].some((r) => r.evidence_hash && r.evidence_hash !== ev)) problems.push("the assets or facts in the handoff are not the ones that were approved (evidence hash mismatch)");
  return problems;
}
