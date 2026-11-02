import { z } from "zod";
import { hashCanonical } from "./approval.js";
import { AspectRatio, OperationType } from "./schemas.js";
import { Energy, RecipeParam, Renderer } from "./recipe.js";

/**
 * The capability contract: one record per thing the system could use to carry out a creative operation, derived from the recipe, the learned
 * records, the visual block records and the implementations that exist now. A record is metadata until an implementation resolves for it.
 * A field that no source establishes is `null` (unknown); it is never filled with a guess.
 */

export const CAPABILITY_CONTRACT_VERSION = "1.0.0";

/**
 * The readiness ladder. Each rung needs the one before it plus its own evidence, and none is assigned by a render succeeding:
 * - registered: metadata exists (a recipe, a record or a block).
 * - executable: a LIVE adapter registration resolves the implementation reference for the capability's operation (`implementation_state: runtime_resolved`).
 *   A reference that only a code table declares, or that an adapter failed to register, is not executable.
 * - validated: executable, and a learned or visual record is intact (hash), current (same recipe version, same implementation fingerprint) and records real
 *   renders made when it was validated. That establishes record integrity, freshness and what was rendered at validation time (see `CapabilityEvidence`).
 *   It does NOT prove that this capability renders successfully now, works at aspect ratios beyond those it recorded, or produces good output.
 * - reviewed: validated, and the recipe carries a human review record.
 * - production: reviewed with every criterion in PRODUCTION_CRITERIA and no open error.
 * `deprecated` is outside the ladder: never selectable.
 */
export const ReadinessStatus = z.enum(["registered", "executable", "validated", "reviewed", "production", "deprecated"]);
export type ReadinessStatus = z.infer<typeof ReadinessStatus>;

const RANK: Record<ReadinessStatus, number> = { deprecated: -1, registered: 0, executable: 1, validated: 2, reviewed: 3, production: 4 };
export const readinessRank = (s: ReadinessStatus): number => RANK[s];
/** True when `have` is at least `need` on the ladder. A deprecated capability meets nothing. */
export const meetsReadiness = (have: ReadinessStatus, need: ReadinessStatus): boolean => have !== "deprecated" && RANK[have] >= RANK[need];

/** What `production` requires. Stated in the data so a report can show it. */
export const PRODUCTION_CRITERIA = ["an implementation that resolves now", "current, hash-valid validation evidence", "a recipe review record", "no open error diagnostic"] as const;

export const DiagnosticCode = z.enum([
  "MISSING_IMPLEMENTATION",
  "DUPLICATE_CAPABILITY_ID",
  "INVALID_ENGINE",
  "UNSUPPORTED_OPERATION",
  "STALE_EVIDENCE",
  "EVIDENCE_FAILED",
  "ASPECT_INCONSISTENT",
  "MISSING_REQUIRED_PARAMETER",
  "INVALID_PROMOTION",
  "DEPRECATED_OR_ABSENT_IMPLEMENTATION",
  "RECIPE_ABSENT",
  "INVALID_RECORD",
  "ORPHAN_IMPLEMENTATION",
  /** An implementation is declared by a code table but no live adapter registered it (the adapter is unavailable here). */
  "ADAPTER_UNAVAILABLE",
  /** A recipe parameter has no valid default, so a scene that omits it cannot be run. */
  "INVALID_PARAMETER_DEFAULT",
  /** The learned record does not list a parameter the recipe declares. An evidence-coverage gap, not an execution blocker. */
  "PARAMETER_NOT_VALIDATED",
  "VARIANT_PARENT_ABSENT",
  "VARIANT_OPERATION_MISMATCH",
]);
export type DiagnosticCode = z.infer<typeof DiagnosticCode>;

export const CapabilityDiagnostic = z.object({
  code: DiagnosticCode,
  /** `error` keeps a capability from being executable or promoted; `warning` is reported and blocks nothing. */
  severity: z.enum(["error", "warning"]),
  /** The capability this is about, or null for a file or implementation that belongs to none. */
  capability_id: z.string().nullable(),
  message: z.string().min(1),
});
export type CapabilityDiagnostic = z.infer<typeof CapabilityDiagnostic>;

export const AssetSlot = z.object({
  slot_id: z.string().min(1),
  /** What the asset is for in the scene. Taken from the recipe's media types; the recipe names no finer role. */
  semantic_role: z.string().min(1),
  media_types: z.array(z.enum(["video", "image", "audio"])).min(1),
  aspect_hints: z.array(AspectRatio),
  mandatory: z.boolean(),
  /** Not recorded by any source. */
  min_resolution: z.null(),
  /** Where this slot came from, so nobody reads it as more than it is. */
  basis: z.string().min(1),
});
export type AssetSlot = z.infer<typeof AssetSlot>;

export const IMPLEMENTATION_STATES = ["runtime_resolved", "declared_only", "absent"] as const;

export const CapabilityEvidence = z.object({
  kind: z.enum(["learned_record", "visual_record", "recipe_review", "adapter_registration"]),
  ref: z.string().min(1),
  /** The record's own hash, when the source carries one. */
  record_hash: z.string().nullable(),
  at: z.string().nullable(),
  summary: z.string().min(1),
  /** Whether this evidence is current and intact now. Failed or stale evidence is listed so it is visible, but never counts. */
  valid: z.boolean(),
  /** What this evidence establishes, and what it does not, so a reader never takes it for more. */
  proves: z.array(z.string()),
  does_not_prove: z.array(z.string()),
  /** Aspect ratios of the real renders the evidence records; null when the source records none. */
  validated_aspect_ratios: z.array(AspectRatio).nullable(),
});
export type CapabilityEvidence = z.infer<typeof CapabilityEvidence>;

/**
 * Four separate questions, answered from different sources and never merged:
 * - adapter_available: an adapter for this capability's engine registered at least one implementation in this snapshot (false: it could not be built here, or the engine is unknown).
 * - implementation_resolved: that adapter registered THIS implementation for THIS operation (for a variant, its parent too).
 * - historical_evidence: current = an intact, current validation record exists; stale = a record exists but does not count (out of date, failed or unusable); none = no record.
 *   It is about what was recorded in the past and says nothing about now.
 * - current_execution: always not_performed. Building the registry reads records and adapter registrations; it never runs a render, so no capability is
 *   verified by execution now. A different value would need a real render, which this contract does not model.
 */
export const CapabilityVerification = z.object({
  adapter_available: z.boolean(),
  implementation_resolved: z.boolean(),
  historical_evidence: z.enum(["none", "stale", "current"]),
  current_execution: z.literal("not_performed"),
});
export type CapabilityVerification = z.infer<typeof CapabilityVerification>;

export const Capability = z.object({
  /** `<engine>:<recipe_id>`, or `remotion:scene-composition:<block>` for a drawn block. */
  capability_id: z.string().min(1),
  version: z.string().min(1),
  /** Family of the learned record when there is one; null otherwise. */
  family: z.string().nullable(),
  /** What the capability does, for finding a like-for-like substitute: the learned record's family and motion or transition. Null when no record states it. */
  intent_key: z.string().nullable(),
  /** The capability this one is a variant of (a drawn block of the composition template). */
  variant_of: z.string().nullable(),
  creative_purpose: z.string().min(1),
  /** No source records the scene types a capability suits. */
  scene_types: z.array(z.string()).nullable(),
  /** `null` when no source states the media a capability takes. */
  media_types: z.array(z.enum(["video", "image", "audio", "none"])).nullable(),
  aspect_ratios: z.array(AspectRatio).nullable(),
  duration: z.object({ min_s: z.number().nonnegative(), max_s: z.number().positive() }).nullable(),
  asset_slots: z.array(AssetSlot),
  parameters: z.array(RecipeParam),
  constraints: z.object({ max_uses_per_film: z.number().int().positive().nullable(), energy: Energy }).nullable(),
  engine: Renderer.nullable(),
  /** The reviewed template this capability runs. `null` only for an entry whose engine could not be established. */
  implementation_ref: z.string().nullable(),
  /** runtime_resolved: a live adapter registered it. declared_only: a code table lists it but no live adapter did. absent: nothing lists it. */
  implementation_state: z.enum(IMPLEMENTATION_STATES),
  operations: z.array(OperationType),
  status: ReadinessStatus,
  verification: CapabilityVerification,
  evidence: z.array(CapabilityEvidence),
  recipe_id: z.string().nullable(),
  recipe_version: z.string().nullable(),
  /** Why the entry has this status, one line per rung it did not reach. */
  status_reasons: z.array(z.string()),
  /** Hash of everything above except itself. */
  record_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Capability = z.infer<typeof Capability>;

/** The hash a capability entry carries. It covers every other field. */
export const capabilityHash = (c: Omit<Capability, "record_hash">): string => hashCanonical(c);

export const CapabilitySnapshot = z.object({
  contract_version: z.literal(CAPABILITY_CONTRACT_VERSION),
  capabilities: z.array(Capability),
  diagnostics: z.array(CapabilityDiagnostic),
  /** Every implementation reference that resolved when the snapshot was built, with the operation types it implements. */
  implementations: z.array(z.object({ ref: z.string(), operations: z.array(OperationType) })),
  /** References a code table declares that no live adapter registered, and why each engine's adapter was unavailable. */
  declared_only: z.array(z.string()),
  adapter_failures: z.array(z.object({ engine: Renderer, reason: z.string() })),
  /** Hash over every entry, every diagnostic and the implementation list. It carries no time and does not depend on source order. */
  snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CapabilitySnapshot = z.infer<typeof CapabilitySnapshot>;

export const snapshotHash = (s: Omit<CapabilitySnapshot, "snapshot_hash">): string => hashCanonical(s);

