import {
  CAPABILITY_CONTRACT_VERSION, capabilityHash, meetsReadiness, parameterValueIssue, queryCapabilities, snapshotHash, type CapabilityQuery, type CapabilityQueryResult,
  type AssetSlot, type Capability, type CapabilityDiagnostic, type CapabilityEvidence, type CapabilitySnapshot, type DiagnosticCode, type ReadinessStatus, type Recipe, type Renderer,
} from "@digikon/contracts";
import { AdapterRegistry } from "./adapter.js";
import { FFMPEG_ASSET_TEMPLATE, HYPERFRAMES_ASSET_TEMPLATE } from "./asset-stage.js";
import { ENGINES, type CapabilityRecord, type LoadedRegistry } from "./capabilities.js";
import { COMPOSITION_TEMPLATE } from "./composition.js";
import { FFMPEG_TEMPLATES } from "./ffmpeg.js";
import { HYPERFRAMES_TEMPLATES } from "./hyperframes.js";
import { REMOTION_TEMPLATES } from "./remotion.js";
import type { VisualCapabilityState } from "./visual-capabilities.js";

/**
 * The capability registry: one reconciled view of every source that says what the system can do. It is built from the sources it is given,
 * on every call, and it only reads. Nothing is cached, written, migrated or promoted here.
 *
 * Two kinds of implementation evidence are kept apart. `implementations` is what LIVE adapters registered (`implementationsOf(adapterRegistry)`, built by
 * `buildAdapterRegistry`, the same construction the console uses): only this makes a capability executable. `declared` is what the adapters' code tables say
 * they implement; it never makes anything executable, because an adapter that cannot be built here (no browser, no font) registers nothing.
 */

type OperationType = Capability["operations"][number];
/** Implementation reference to the operation types it implements. */
export type ImplementationList = Readonly<Record<string, readonly OperationType[]>>;

export interface RegistrySources {
  recipes: readonly Recipe[];
  /** The loaded learned records. Only `records`, `usable` and `problems` are read. */
  learned: Pick<LoadedRegistry, "records" | "usable" | "problems">;
  visual: readonly VisualCapabilityState[];
  /** What live adapters registered now. Build it with `implementationsOf`. This alone resolves an implementation. */
  implementations: ImplementationList;
  /** What the code tables declare (`declaredImplementations`). Reported as `declared_only` when no live adapter registered it; never executable. */
  declared?: ImplementationList;
  /** Why an engine's adapter could not be built (`buildAdapterRegistry(...).failures`). Used to explain `declared_only` entries. */
  adapter_failures?: readonly { engine: Renderer; reason: string }[];
  /** Capability ids or implementation references that must not be selected. Nothing is deprecated unless named here. */
  deprecated?: ReadonlySet<string>;
}

/** The implementations a set of live adapters registers: the authoritative runtime resolution. */
export function implementationsOf(adapters: AdapterRegistry): ImplementationList {
  const out: Record<string, readonly OperationType[]> = {};
  for (const ref of adapters.templateRefs().sort()) out[ref] = adapters.adapterFor(ref)?.templates[ref] ?? [];
  return out;
}

/**
 * What the adapters' code tables say they implement, plus the templates of the usable learned records. This is a DECLARATION, not runtime availability: it needs no
 * ffmpeg, font or browser, so it is true on a machine where the adapters cannot run. Pass it as `declared`, never as `implementations`.
 */
export function declaredImplementations(usable: readonly CapabilityRecord[] = []): ImplementationList {
  const out: Record<string, readonly OperationType[]> = {};
  for (const [ref, t] of Object.entries(FFMPEG_TEMPLATES)) out[ref] = [t.type];
  for (const [ref, t] of Object.entries(REMOTION_TEMPLATES)) out[ref] = [t.type];
  for (const [ref, t] of Object.entries(HYPERFRAMES_TEMPLATES)) out[ref] = [t.type];
  out[COMPOSITION_TEMPLATE] = ["render_graphics_scene"];
  // The asset-stage templates are added by the FFmpeg and HyperFrames adapter wrappers, not by their code tables.
  out[FFMPEG_ASSET_TEMPLATE] = ["render_graphics_scene"];
  out[HYPERFRAMES_ASSET_TEMPLATE] = ["render_graphics_scene"];
  for (const r of usable) out[r.template] = [r.inputs.operation_type as OperationType];
  return out;
}

const rank = (c: CapabilityDiagnostic): string => `${c.code}|${c.capability_id ?? ""}|${c.message}`;
type Aspect = NonNullable<Capability["aspect_ratios"]>[number];
const aspectOf = (w: number, h: number): Aspect | null => {
  const r = w / h;
  return Math.abs(r - 16 / 9) < 0.02 ? "16:9" : Math.abs(r - 9 / 16) < 0.02 ? "9:16" : Math.abs(r - 1) < 0.02 ? "1:1" : null;
};
const aspectsOf = (sizes: readonly { width: number; height: number }[]): Aspect[] => [...new Set(sizes.map((s) => aspectOf(s.width, s.height)).filter((a): a is Aspect => !!a))].sort();

export class CapabilityRegistry {
  private constructor(readonly snapshot: CapabilitySnapshot) {}

  static from(src: RegistrySources): CapabilityRegistry { return new CapabilityRegistry(reconcile(src)); }

  get(id: string): Capability | undefined { return this.snapshot.capabilities.find((c) => c.capability_id === id); }
  /** Entries at or above a rung of the ladder. */
  atLeast(need: ReadinessStatus): Capability[] { return this.snapshot.capabilities.filter((c) => meetsReadiness(c.status, need)); }
  diagnosticsFor(id: string): CapabilityDiagnostic[] { return this.snapshot.diagnostics.filter((d) => d.capability_id === id); }

  /** Deterministic eligibility: compatible candidates with their evidence, and every excluded entry with reason codes. */
  query(q: CapabilityQuery): CapabilityQueryResult { return queryCapabilities(this.snapshot, q); }

  /** Counts computed from the entries, never assumed. `blocked` is the number of entries with an open error. */
  counts(): { registered: number; executable: number; validated: number; reviewed: number; production: number; deprecated: number; blocked: number; unattached_diagnostics: number } {
    const s = this.snapshot.capabilities, has = (c: Capability) => this.snapshot.diagnostics.some((d) => d.capability_id === c.capability_id && d.severity === "error");
    return {
      registered: s.length, executable: s.filter((c) => meetsReadiness(c.status, "executable")).length, validated: s.filter((c) => meetsReadiness(c.status, "validated")).length,
      reviewed: s.filter((c) => meetsReadiness(c.status, "reviewed")).length, production: s.filter((c) => c.status === "production").length, deprecated: s.filter((c) => c.status === "deprecated").length,
      blocked: s.filter(has).length, unattached_diagnostics: this.snapshot.diagnostics.filter((d) => d.capability_id === null).length,
    };
  }
}

function slotsOf(r: Recipe): AssetSlot[] {
  const media = r.compatibility.media_types.filter((m): m is "video" | "image" | "audio" => m !== "none");
  if (!media.length) return [];
  const needsAsset = !r.compatibility.media_types.includes("none") || r.validation_rules.some((x) => x.kind === "requires_asset");
  return [{ slot_id: "primary_media", semantic_role: "scene_media", media_types: media, aspect_hints: [...r.compatibility.aspect_ratios], mandatory: needsAsset, min_resolution: null, basis: "derived from the recipe's compatibility.media_types; the recipe names no finer role" }];
}

// What each kind of evidence establishes, stated once so no reader takes a record for more than it is.
const ADAPTER_PROVES = ["a live adapter registered this implementation reference for this operation when the registry was built"];
const ADAPTER_NOT = ["that the scene's assets, parameters or text will render successfully", "that the output is correct or good"];
const RECORD_PROVES = ["the record is intact (its hash matches)", "it is current (same recipe version, same implementation fingerprint, dependencies present)", "real renders were made when it was validated, at the aspect ratios listed"];
const RECORD_NOT = ["that this capability renders successfully now", "compatibility at aspect ratios other than those listed", "compatibility with other parameters, assets or scene content than were tested", "output quality"];
const REVIEW_PROVES = ["a named person recorded a review of the recipe on the stated date"];
const REVIEW_NOT = ["that the implementation is executable or validated now"];

function reconcile(src: RegistrySources): CapabilitySnapshot {
  const diagnostics: CapabilityDiagnostic[] = [];
  const diag = (code: DiagnosticCode, severity: "error" | "warning", capability_id: string | null, message: string) => diagnostics.push({ code, severity, capability_id, message });
  const deprecated = src.deprecated ?? new Set<string>();
  const impls = src.implementations, declared = src.declared ?? {};
  const failureOf = (engine: string) => src.adapter_failures?.find((f) => f.engine === engine)?.reason;
  const learnedById = new Map<string, CapabilityRecord>();
  const usable = new Set(src.learned.usable.map((r) => r.capability_id));
  for (const r of src.learned.records) {
    if (learnedById.has(r.capability_id)) diag("DUPLICATE_CAPABILITY_ID", "error", r.capability_id, `two learned records claim ${r.capability_id}; the first is used`);
    else learnedById.set(r.capability_id, r);
  }
  for (const p of src.learned.problems) diag("INVALID_RECORD", "warning", null, `a learned record file was refused: ${p}`);

  const claimed = new Set<string>();
  const used = new Set<string>();
  const entries: Capability[] = [];
  const add = (id: string): string => { // keeps a duplicate visible instead of dropping it
    if (!used.has(id)) { used.add(id); return id; }
    let n = 2;
    while (used.has(`${id}#duplicate${n}`)) n++;
    diag("DUPLICATE_CAPABILITY_ID", "error", id, `capability id ${id} is claimed twice; the later claim is kept as ${id}#duplicate${n} and is not executable`);
    used.add(`${id}#duplicate${n}`);
    return `${id}#duplicate${n}`;
  };

  /** Resolves a reference against the live adapters. A declaration without a live registration is `declared_only` and says why. */
  const resolve = (id: string, ref: string, operation: OperationType): { state: Capability["implementation_state"]; supported: boolean } => {
    const live = impls[ref];
    if (live) {
      if (!live.includes(operation)) { diag("UNSUPPORTED_OPERATION", "error", id, `${ref} implements ${live.join(", ") || "nothing"}, not ${operation}`); return { state: "runtime_resolved", supported: false }; }
      return { state: "runtime_resolved", supported: true };
    }
    const decl = declared[ref];
    if (decl) {
      const why = failureOf(ref.split("/")[0] ?? "");
      diag("ADAPTER_UNAVAILABLE", "error", id, `${ref} is declared by the code tables but no live adapter registered it${why ? ` (${why})` : ""}`);
      return { state: "declared_only", supported: false };
    }
    diag("MISSING_IMPLEMENTATION", "error", id, `no adapter registers ${ref}`);
    return { state: "absent", supported: false };
  };

  const liveEngines = new Set(Object.keys(impls).map((ref) => ref.split("/")[0]));
  const finish = (c: Omit<Capability, "record_hash" | "status" | "status_reasons" | "verification">, flags: { executable: boolean; validated: boolean; reviewed: boolean; deprecated: boolean }, reasons: string[]) => {
    const own = diagnostics.filter((d) => d.capability_id === c.capability_id || d.capability_id === c.capability_id.split("#")[0]);
    const openError = own.some((d) => d.severity === "error");
    let status: ReadinessStatus = "registered";
    if (flags.deprecated) status = "deprecated";
    else if (flags.executable) {
      status = "executable";
      if (flags.validated) { status = "validated"; if (flags.reviewed) { status = "reviewed"; if (!openError) status = "production"; } }
    }
    if (status === "registered") reasons.push(c.implementation_state === "declared_only" ? "the implementation is declared but no live adapter registered it" : "no implementation resolves for this capability's operation now");
    if (status === "executable") reasons.push("no current validation evidence");
    if (status === "validated") reasons.push("no recipe review record");
    if (status === "reviewed") reasons.push("an open error diagnostic blocks production");
    const records = c.evidence.filter((e) => e.kind === "learned_record" || e.kind === "visual_record");
    const verification: Capability["verification"] = {
      adapter_available: !!c.engine && liveEngines.has(c.engine),
      implementation_resolved: flags.executable,
      historical_evidence: records.some((e) => e.valid) ? "current" : records.length ? "stale" : "none",
      current_execution: "not_performed",
    };
    const body = { ...c, status, verification, status_reasons: [...new Set(reasons)] };
    entries.push({ ...body, record_hash: capabilityHash(body) });
  };

  // ---- Recipes (with their learned record, when one exists) ----
  for (const r of [...src.recipes].sort((a, b) => a.recipe_id.localeCompare(b.recipe_id))) {
    const engineName = r.implementation_ref.split("/")[0] ?? "";
    const validEngine = (ENGINES as readonly string[]).includes(engineName);
    const baseId = validEngine ? `${engineName}:${r.recipe_id}` : `invalid:${r.recipe_id}`;
    const id = add(baseId), isDup = id !== baseId;
    claimed.add(r.implementation_ref);
    const reasons: string[] = [];
    const evidence: CapabilityEvidence[] = [];
    if (!validEngine) diag("INVALID_ENGINE", "error", id, `${r.implementation_ref} names engine "${engineName}", which is not one of ${ENGINES.join(", ")}`);
    else if (!(r.compatibility.renderers as string[]).includes(engineName)) diag("INVALID_ENGINE", "error", id, `the recipe does not list ${engineName} in compatibility.renderers`);
    if (deprecated.has(id) || deprecated.has(r.implementation_ref)) diag("DEPRECATED_OR_ABSENT_IMPLEMENTATION", "error", id, `${deprecated.has(id) ? id : r.implementation_ref} is marked deprecated`);
    const res = resolve(id, r.implementation_ref, r.operation_type);
    const implOk = res.supported && validEngine && (r.compatibility.renderers as string[]).includes(engineName) && !isDup;
    if (res.supported) evidence.push({ kind: "adapter_registration", ref: r.implementation_ref, record_hash: null, at: null, summary: `a live adapter registers ${r.implementation_ref} for ${impls[r.implementation_ref]!.join(", ")}`, valid: true, proves: ADAPTER_PROVES, does_not_prove: ADAPTER_NOT, validated_aspect_ratios: null });
    // Parameter schema comes from the recipe (authoritative). A default that is not itself valid would make an omitted value invalid, so it is an error.
    for (const p of r.parameters) {
      const bad = parameterValueIssue(p, p.default);
      if (bad) diag("INVALID_PARAMETER_DEFAULT", "error", id, `parameter ${p.name} has no valid default: ${bad.detail}`);
    }
    let validated = false;
    const rec = validEngine ? learnedById.get(`${engineName}:${r.recipe_id}`) : undefined;
    if (rec) {
      const ok = usable.has(rec.capability_id) && rec.recipe_version === r.version;
      if (rec.template !== r.implementation_ref) diag("DEPRECATED_OR_ABSENT_IMPLEMENTATION", "error", id, `the learned record runs ${rec.template}, but the recipe's implementation_ref is ${r.implementation_ref}`);
      if (rec.status !== "validated") diag("EVIDENCE_FAILED", "warning", id, `the learned record's status is ${rec.status}`);
      else if (!ok) diag("STALE_EVIDENCE", "error", id, rec.recipe_version !== r.version ? `the record was validated for recipe version ${rec.recipe_version}, the recipe is ${r.version}` : "the record is validated but is not usable now (its dependencies or implementation changed)");
      const aspects = aspectsOf(rec.validated?.renders ?? []);
      evidence.push({ kind: "learned_record", ref: rec.capability_id, record_hash: rec.record_hash, at: rec.validated?.at ?? null, summary: `learned record ${rec.status}, capability version ${rec.capability_version}${rec.validated ? `, ${rec.validated.renders.length} real render(s) recorded at validation` : ""}`, valid: ok && rec.status === "validated", proves: RECORD_PROVES, does_not_prove: RECORD_NOT, validated_aspect_ratios: rec.validated ? aspects : null });
      validated = ok && rec.status === "validated" && rec.template === r.implementation_ref;
      // The record's parameter list is not the schema (the recipe is). A parameter missing from it is an evidence-coverage gap: the validation render did not exercise it.
      const missing = r.parameters.map((p) => p.name).filter((n) => !rec.inputs.parameters.includes(n));
      if (missing.length) diag("PARAMETER_NOT_VALIDATED", "warning", id, `the learned record lists no parameter ${missing.join(", ")}; the recipe defines them and ranges are checked per scene, but the validation did not cover them`);
      for (const rn of rec.validated?.renders ?? []) {
        const a = aspectOf(rn.width, rn.height);
        if (!a || !(r.compatibility.aspect_ratios as string[]).includes(a)) { diag("ASPECT_INCONSISTENT", "error", id, `evidence was rendered at ${rn.width}x${rn.height}, which is not an aspect ratio the recipe declares (${r.compatibility.aspect_ratios.join(", ")})`); break; }
      }
    }
    if (r.review) evidence.push({ kind: "recipe_review", ref: r.recipe_id, record_hash: null, at: r.review.reviewed_at, summary: `reviewed by ${r.review.reviewed_by}: ${r.review.evidence}`, valid: true, proves: REVIEW_PROVES, does_not_prove: REVIEW_NOT, validated_aspect_ratios: null });
    const reviewed = r.status === "reviewed" && !!r.review;
    if (r.status === "reviewed" && !(implOk && validated)) diag("INVALID_PROMOTION", "error", id, "the recipe says reviewed, but the capability has no live-resolved implementation with current validation evidence");
    if (!rec) reasons.push("no learned validation record exists for this recipe");
    finish({
      capability_id: id, version: rec?.capability_version ?? r.version, family: rec?.family ?? null, intent_key: rec ? `${rec.family}:${rec.spec.motion ?? rec.storyboard_transition}` : null, variant_of: null, creative_purpose: r.purpose, scene_types: null,
      media_types: [...r.compatibility.media_types], aspect_ratios: [...r.compatibility.aspect_ratios], duration: { min_s: r.constraints.min_duration_s, max_s: r.constraints.max_duration_s },
      asset_slots: slotsOf(r), parameters: r.parameters, constraints: { max_uses_per_film: r.constraints.max_uses_per_film, energy: r.constraints.energy },
      engine: validEngine ? (engineName as Renderer) : null, implementation_ref: r.implementation_ref, implementation_state: res.state, operations: [r.operation_type], evidence, recipe_id: r.recipe_id, recipe_version: r.version,
    }, { executable: implOk, validated: implOk && validated, reviewed: implOk && validated && reviewed, deprecated: deprecated.has(id) || deprecated.has(r.implementation_ref) }, reasons);
  }

  // ---- Learned records no recipe claims ----
  const recipeIds = new Set(src.recipes.map((r) => r.recipe_id));
  for (const rec of [...learnedById.values()].sort((a, b) => a.capability_id.localeCompare(b.capability_id))) {
    if (recipeIds.has(rec.recipe_id) && used.has(rec.capability_id)) continue;
    const id = add(rec.capability_id);
    claimed.add(rec.template);
    diag("RECIPE_ABSENT", "error", id, `the learned record is for recipe ${rec.recipe_id}, which the library does not have`);
    const state: Capability["implementation_state"] = impls[rec.template] ? "runtime_resolved" : declared[rec.template] ? "declared_only" : "absent";
    finish({
      capability_id: id, version: rec.capability_version, family: rec.family, intent_key: `${rec.family}:${rec.spec.motion ?? rec.storyboard_transition}`, variant_of: null, creative_purpose: `(no recipe) ${rec.family}`, scene_types: null, media_types: null, aspect_ratios: null, duration: null, asset_slots: [],
      parameters: [], constraints: null, engine: rec.engine, implementation_ref: rec.template, implementation_state: state, operations: [rec.inputs.operation_type as OperationType],
      evidence: [{ kind: "learned_record", ref: rec.capability_id, record_hash: rec.record_hash, at: rec.validated?.at ?? null, summary: `learned record ${rec.status}`, valid: false, proves: [], does_not_prove: RECORD_NOT, validated_aspect_ratios: null }], recipe_id: rec.recipe_id, recipe_version: rec.recipe_version,
    }, { executable: false, validated: false, reviewed: false, deprecated: false }, []);
  }

  // ---- Visual blocks: variants of the scene-composition capability ----
  // A block is a variant: it names its parent, may claim only operations the parent implements through the same template, and takes nothing else from it. Its
  // readiness comes from its own record; the parent's validation is never inherited, and a block is executable only while the parent is.
  const compRecipe = src.recipes.find((r) => r.implementation_ref === COMPOSITION_TEMPLATE);
  const parentId = compRecipe ? `remotion:${compRecipe.recipe_id}` : null;
  const parent = parentId ? entries.find((e) => e.capability_id === parentId) : undefined;
  const BLOCK_OPS: OperationType[] = ["render_graphics_scene"];
  for (const v of [...src.visual].sort((a, b) => a.block.localeCompare(b.block))) {
    const id = add(v.record?.capability_id ?? `remotion:scene-composition:${v.block}`);
    claimed.add(COMPOSITION_TEMPLATE);
    const evidence: CapabilityEvidence[] = [];
    const res = resolve(id, COMPOSITION_TEMPLATE, BLOCK_OPS[0]!);
    if (!compRecipe) diag("RECIPE_ABSENT", "warning", id, "no recipe uses the scene-composition template");
    if (parentId && !parent) diag("VARIANT_PARENT_ABSENT", "error", id, `variant_of ${parentId} does not exist in the registry`);
    const ops = BLOCK_OPS.filter((o) => parent?.operations.includes(o));
    if (parent && ops.length !== BLOCK_OPS.length) diag("VARIANT_OPERATION_MISMATCH", "error", id, `the block claims ${BLOCK_OPS.join(", ")}, but its parent ${parentId} implements ${parent.operations.join(", ") || "nothing"}`);
    if (parent && parent.implementation_ref !== COMPOSITION_TEMPLATE) diag("VARIANT_OPERATION_MISMATCH", "error", id, `the block runs ${COMPOSITION_TEMPLATE}, but its parent runs ${parent.implementation_ref}`);
    const parentLive = !!parent && parent.implementation_state === "runtime_resolved" && parent.implementation_ref === COMPOSITION_TEMPLATE;
    if (parent && !parentLive) diag("ADAPTER_UNAVAILABLE", "error", id, `the parent ${parentId} is not live-resolved (${parent.implementation_state}), so its variant is not executable`);
    const implOk = res.supported && parentLive && ops.length === BLOCK_OPS.length;
    if (res.supported) evidence.push({ kind: "adapter_registration", ref: COMPOSITION_TEMPLATE, record_hash: null, at: null, summary: "a live adapter registers the scene-composition template", valid: true, proves: ADAPTER_PROVES, does_not_prove: ADAPTER_NOT, validated_aspect_ratios: null });
    if (v.record) {
      if (!v.usable) diag(v.record.status === "validated" ? "STALE_EVIDENCE" : "EVIDENCE_FAILED", v.record.status === "validated" ? "error" : "warning", id, v.reason);
      const aspects = aspectsOf(v.record.validated?.inputs ?? []);
      evidence.push({ kind: "visual_record", ref: v.record.capability_id, record_hash: v.record.record_hash, at: v.record.validated?.at ?? null, summary: `visual record ${v.record.status}: ${v.reason}`, valid: v.usable, proves: RECORD_PROVES, does_not_prove: [...RECORD_NOT, ...v.record.not_validated], validated_aspect_ratios: v.record.validated ? aspects : null });
      if ((v.record.not_validated ?? []).some((x) => x.includes("1:1")) && compRecipe?.compatibility.aspect_ratios.includes("1:1")) diag("ASPECT_INCONSISTENT", "warning", id, "the recipe declares 1:1 but the block's record says 1:1 frames were not validated");
    } else diag("EVIDENCE_FAILED", "warning", id, v.reason);
    finish({
      capability_id: id, version: v.record?.capability_version ?? "unknown", family: "scene_composition", intent_key: null, variant_of: parentId,
      creative_purpose: v.record?.creative_use ?? `drawn block ${v.block} (no record)`, scene_types: null, media_types: null, aspect_ratios: null, duration: null, asset_slots: [], parameters: [], constraints: null,
      engine: "remotion", implementation_ref: COMPOSITION_TEMPLATE, implementation_state: res.state, operations: ops, evidence, recipe_id: compRecipe?.recipe_id ?? null, recipe_version: compRecipe?.version ?? null,
    }, { executable: implOk, validated: implOk && v.usable, reviewed: false, deprecated: deprecated.has(id) || deprecated.has(COMPOSITION_TEMPLATE) }, v.record ? [] : ["no validation record exists for this block"]);
  }

  // ---- Any other variant must name an entry that exists ----
  for (const e of entries) if (e.variant_of && !entries.some((p) => p.capability_id === e.variant_of) && !diagnostics.some((d) => d.code === "VARIANT_PARENT_ABSENT" && d.capability_id === e.capability_id)) diag("VARIANT_PARENT_ABSENT", "error", e.capability_id, `variant_of ${e.variant_of} does not exist in the registry`);

  // ---- Implementations nothing claims ----
  for (const ref of Object.keys(impls).sort()) if (!claimed.has(ref)) diag("ORPHAN_IMPLEMENTATION", "warning", null, `${ref} is registered by an adapter but no recipe or record uses it`);

  entries.sort((a, b) => (a.capability_id < b.capability_id ? -1 : a.capability_id > b.capability_id ? 1 : 0));
  diagnostics.sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
  const implementations = Object.keys(impls).sort().map((ref) => ({ ref, operations: [...impls[ref]!].sort() }));
  const declared_only = Object.keys(declared).filter((ref) => !impls[ref]).sort();
  const adapter_failures = [...(src.adapter_failures ?? [])].sort((a, b) => (a.engine < b.engine ? -1 : 1));
  const body = { contract_version: CAPABILITY_CONTRACT_VERSION, capabilities: entries, diagnostics, implementations, declared_only, adapter_failures } as const;
  return { ...body, snapshot_hash: snapshotHash(body) };
}
