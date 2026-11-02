import { meetsReadiness, readinessRank, type Capability, type ReadinessStatus } from "./capability.js";
import type { Renderer } from "./recipe.js";

type AspectRatio = NonNullable<Capability["aspect_ratios"]>[number];

/**
 * Deterministic capability queries and compatibility checks. Eligibility is decided here by rules over the registry's entries; no model is
 * asked whether an implementation exists. A field the registry marks unknown (`null`) never excludes a capability on that field, and the
 * candidate says so in `unknowns`, so "not recorded" is never read as "supported".
 */

type OperationType = Capability["operations"][number];
type MediaType = "video" | "image" | "audio" | "none";

export interface CapabilityQuery {
  scene_type?: string;
  /** Words the capability's creative purpose must contain (every word, case-insensitive). */
  creative_purpose?: string;
  /** Every one must be an operation the capability implements. */
  required_operations?: readonly OperationType[];
  /** The media the scene carries; each must be accepted by the capability. */
  media_types?: readonly MediaType[];
  /** The assets that would fill slots. Each needs a slot that takes its media type (and role, when given). */
  asset_slots?: readonly { media_type: "video" | "image" | "audio"; role?: string }[];
  aspect_ratio?: AspectRatio;
  duration_s?: number;
  /** Engines that are usable here. A capability on another engine is excluded. */
  available_engines?: readonly Renderer[];
  /** Defaults to `executable`: a capability whose implementation does not resolve is never offered unless the caller lowers this on purpose. */
  min_readiness?: ReadinessStatus;
}

export type RejectionCode =
  | "DEPRECATED"
  | "BELOW_READINESS"
  | "ENGINE_UNAVAILABLE"
  | "OPERATION_NOT_SUPPORTED"
  | "MEDIA_NOT_ACCEPTED"
  | "SLOT_INCOMPATIBLE"
  | "ASPECT_UNSUPPORTED"
  | "DURATION_OUT_OF_RANGE"
  | "SCENE_TYPE_UNSUPPORTED"
  | "PURPOSE_MISMATCH";

export interface Rejection { code: RejectionCode; detail: string }

export interface CapabilityCandidate {
  capability: Capability;
  verdict: "compatible";
  /** Query fields the capability could not be checked on because no source records them. */
  unknowns: string[];
  /** Only evidence that is current and intact now. */
  supporting_evidence: Capability["evidence"];
}
export interface CapabilityRejected { capability_id: string; rejections: Rejection[] }
export interface CapabilityQueryResult { snapshot_hash: string; candidates: CapabilityCandidate[]; rejected: CapabilityRejected[] }

/** Why a capability does not fit a query, in a fixed order; an empty list means it fits. */
export function incompatibilities(c: Capability, q: CapabilityQuery): { rejections: Rejection[]; unknowns: string[] } {
  const rejections: Rejection[] = [], unknowns: string[] = [];
  const reject = (code: RejectionCode, detail: string) => rejections.push({ code, detail });
  const need = q.min_readiness ?? "executable";
  if (c.status === "deprecated") reject("DEPRECATED", `${c.capability_id} is deprecated`);
  else if (!meetsReadiness(c.status, need)) reject("BELOW_READINESS", `${c.capability_id} is ${c.status}, below the required ${need}${c.status_reasons.length ? ` (${c.status_reasons.join("; ")})` : ""}`);
  if (q.available_engines && (!c.engine || !q.available_engines.includes(c.engine))) reject("ENGINE_UNAVAILABLE", `${c.engine ?? "no engine"} is not among the available engines (${q.available_engines.join(", ") || "none"})`);
  for (const op of q.required_operations ?? []) if (!c.operations.includes(op)) reject("OPERATION_NOT_SUPPORTED", `${c.capability_id} does not implement ${op} (it implements ${c.operations.join(", ") || "nothing"})`);
  if (q.media_types?.length) {
    if (!c.media_types) unknowns.push("media_types");
    else for (const m of q.media_types) if (!c.media_types.includes(m)) reject("MEDIA_NOT_ACCEPTED", `${c.capability_id} does not accept ${m} media (accepts ${c.media_types.join(", ")})`);
  }
  for (const a of q.asset_slots ?? []) {
    if (!c.media_types) { if (!unknowns.includes("media_types")) unknowns.push("media_types"); continue; }
    const fits = c.asset_slots.some((s) => s.media_types.includes(a.media_type) && (!a.role || s.semantic_role === a.role));
    if (!fits) reject("SLOT_INCOMPATIBLE", `${c.capability_id} has no slot for a ${a.media_type} asset${a.role ? ` with role ${a.role}` : ""}`);
  }
  if (q.aspect_ratio) {
    if (!c.aspect_ratios) unknowns.push("aspect_ratios");
    else if (!c.aspect_ratios.includes(q.aspect_ratio)) reject("ASPECT_UNSUPPORTED", `${c.capability_id} supports ${c.aspect_ratios.join(", ")}, not ${q.aspect_ratio}`);
  }
  if (q.duration_s !== undefined) {
    if (!c.duration) unknowns.push("duration");
    else if (q.duration_s < c.duration.min_s || q.duration_s > c.duration.max_s) reject("DURATION_OUT_OF_RANGE", `${q.duration_s}s is outside ${c.duration.min_s}-${c.duration.max_s}s`);
  }
  if (q.scene_type) {
    if (!c.scene_types) unknowns.push("scene_types");
    else if (!c.scene_types.includes(q.scene_type)) reject("SCENE_TYPE_UNSUPPORTED", `${c.capability_id} does not list scene type ${q.scene_type}`);
  }
  if (q.creative_purpose) {
    const hay = c.creative_purpose.toLowerCase();
    const missing = q.creative_purpose.toLowerCase().split(/\s+/).filter(Boolean).filter((w) => !hay.includes(w));
    if (missing.length) reject("PURPOSE_MISMATCH", `the purpose does not mention ${missing.join(", ")}`);
  }
  return { rejections, unknowns };
}

/** Runs a query over entries. Candidates are ordered by readiness (highest first) then id; rejections by id, so the result is reproducible. */
export function queryCapabilities(snapshot: { capabilities: readonly Capability[]; snapshot_hash: string }, q: CapabilityQuery): CapabilityQueryResult {
  const candidates: CapabilityCandidate[] = [], rejected: CapabilityRejected[] = [];
  for (const c of snapshot.capabilities) {
    const r = incompatibilities(c, q);
    if (r.rejections.length) rejected.push({ capability_id: c.capability_id, rejections: r.rejections });
    else candidates.push({ capability: c, verdict: "compatible", unknowns: r.unknowns, supporting_evidence: c.evidence.filter((e) => e.valid) });
  }
  candidates.sort((a, b) => readinessRank(b.capability.status) - readinessRank(a.capability.status) || (a.capability.capability_id < b.capability.capability_id ? -1 : 1));
  rejected.sort((a, b) => (a.capability_id < b.capability_id ? -1 : 1));
  return { snapshot_hash: snapshot.snapshot_hash, candidates, rejected };
}

export type ParameterIssueCode = "PARAM_UNKNOWN" | "PARAM_TYPE" | "PARAM_OUT_OF_RANGE" | "PARAM_NOT_IN_OPTIONS" | "PARAM_TOO_LONG" | "PARAM_DEFAULT_INVALID";
export interface ParameterIssue { code: ParameterIssueCode; parameter: string; detail: string }

type ParameterDefinition = Capability["parameters"][number];

/**
 * Whether one value is acceptable for one parameter definition, or the issue if not. A parameter definition (the capability's `parameters`, taken from the
 * recipe, which is the authoritative schema) says what is allowed; this applies it to a value. Used for supplied values and for defaults.
 */
export function parameterValueIssue(p: ParameterDefinition, v: unknown): Omit<ParameterIssue, "parameter"> | null {
  if (p.kind === "number") {
    if (typeof v !== "number" || !Number.isFinite(v)) return { code: "PARAM_TYPE", detail: `${p.name} must be a number` };
    if (v < p.min || v > p.max) return { code: "PARAM_OUT_OF_RANGE", detail: `${p.name} ${v} is outside ${p.min} to ${p.max} ${p.unit}` };
  } else if (p.kind === "enum") {
    if (typeof v !== "string") return { code: "PARAM_TYPE", detail: `${p.name} must be one of ${p.options.join(", ")}` };
    if (!p.options.includes(v)) return { code: "PARAM_NOT_IN_OPTIONS", detail: `${p.name} "${v}" is not one of ${p.options.join(", ")}` };
  } else if (p.kind === "string") {
    if (typeof v !== "string") return { code: "PARAM_TYPE", detail: `${p.name} must be text` };
    if (v.length > p.max_length) return { code: "PARAM_TOO_LONG", detail: `${p.name} is ${v.length} characters, the limit is ${p.max_length}` };
  } else if (typeof v !== "boolean") return { code: "PARAM_TYPE", detail: `${p.name} must be true or false` };
  return null;
}

/**
 * Invocation-level validation: the values one scene supplies, checked against the capability's parameter definitions. A parameter the scene leaves out takes its default,
 * and a default that is itself not valid blocks the scene (PARAM_DEFAULT_INVALID), so a missing value never silently becomes an invalid one.
 */
export function validateParameters(c: Capability, values: Readonly<Record<string, unknown>>): ParameterIssue[] {
  const issues: ParameterIssue[] = [];
  const defs = new Map(c.parameters.map((p) => [p.name, p]));
  for (const [name, v] of Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const p = defs.get(name);
    if (!p) { issues.push({ code: "PARAM_UNKNOWN", parameter: name, detail: `${c.capability_id} has no parameter ${name}` }); continue; }
    const i = parameterValueIssue(p, v);
    if (i) issues.push({ ...i, parameter: name });
  }
  for (const p of c.parameters) {
    if (p.name in values) continue;
    const i = parameterValueIssue(p, p.default);
    if (i) issues.push({ code: "PARAM_DEFAULT_INVALID", parameter: p.name, detail: `${p.name} was left out and its default is not valid: ${i.detail}` });
  }
  return issues;
}

export type SlotIssueCode = "SLOT_UNKNOWN" | "SLOT_MEDIA_MISMATCH" | "SLOT_MANDATORY_EMPTY" | "SLOT_ASPECT_MISMATCH" | "SLOT_DOUBLE_BOUND";
export interface SlotIssue { code: SlotIssueCode; slot_id: string; detail: string }

/** Checks an assignment of assets to slots: known slots, accepted media, every mandatory slot filled, aspect hints respected when the asset's ratio is known. */
export function validateSlotBindings(c: Capability, bindings: readonly { slot_id: string; asset_id: string; media_type: "video" | "image" | "audio"; aspect_ratio?: AspectRatio | null }[]): SlotIssue[] {
  const issues: SlotIssue[] = [];
  const slots = new Map(c.asset_slots.map((s) => [s.slot_id, s]));
  const filled = new Set<string>();
  for (const b of bindings) {
    const s = slots.get(b.slot_id);
    if (!s) { issues.push({ code: "SLOT_UNKNOWN", slot_id: b.slot_id, detail: `${c.capability_id} has no slot ${b.slot_id}` }); continue; }
    if (filled.has(b.slot_id)) issues.push({ code: "SLOT_DOUBLE_BOUND", slot_id: b.slot_id, detail: `slot ${b.slot_id} is bound to more than one asset` });
    filled.add(b.slot_id);
    if (!s.media_types.includes(b.media_type)) issues.push({ code: "SLOT_MEDIA_MISMATCH", slot_id: b.slot_id, detail: `slot ${b.slot_id} takes ${s.media_types.join(", ")}, not ${b.media_type} (${b.asset_id})` });
    if (b.aspect_ratio && s.aspect_hints.length && !s.aspect_hints.includes(b.aspect_ratio)) issues.push({ code: "SLOT_ASPECT_MISMATCH", slot_id: b.slot_id, detail: `asset ${b.asset_id} is ${b.aspect_ratio}; slot ${b.slot_id} hints ${s.aspect_hints.join(", ")}` });
  }
  for (const s of c.asset_slots) if (s.mandatory && !filled.has(s.slot_id)) issues.push({ code: "SLOT_MANDATORY_EMPTY", slot_id: s.slot_id, detail: `mandatory slot ${s.slot_id} has no asset` });
  return issues;
}
