import {
  NOT_RUN_PREFLIGHT, PRODUCTION_PLAN_VERSION, PreflightResult, ProductionDecisionPlan, productionSelectionHash, editPlanRef, assetFeasibility, productionPlanHash, relevantCapabilitiesHash,
  type Asset, type Capability, type EditPlan, type FeasibilityReason, type FeasibilityVerdict, type ProductionDecision, type RecipeUse, type Renderer, type Scene, type ScenePlan, type Substitute,
  type UnresolvedRequirement, type AlternativeConsidered,
} from "@digikon/contracts";
import { incompatibilities, queryCapabilities, validateParameters, validateSlotBindings, type CapabilityQuery, type CapabilitySnapshot, type RejectionCode } from "@digikon/contracts";

/**
 * Generation and validation of the ProductionDecisionPlan. Everything here is a deterministic function of the Director's plans, the assets and the registry
 * snapshot: no model is asked whether anything exists or fits, and the same inputs give the same plan and the same hash. Nothing is substituted silently: a
 * different capability is only ever offered as a suggestion, and a plan that needs one is not clear.
 */

type AspectRatio = NonNullable<Capability["aspect_ratios"]>[number];
type OperationType = Capability["operations"][number];
type Media = "video" | "image" | "audio" | "none";

export interface PlanningInput {
  scenePlan: ScenePlan;
  /** Version and hash of the storyboard the Director plan was built on (the Director computes the hash). */
  storyboard: { version: number; hash: string };
  editPlan: EditPlan;
  assets: readonly Asset[];
  aspect_ratio: AspectRatio;
  /** Engines whose adapters exist now. A capability on another engine cannot be selected. */
  available_engines: readonly Renderer[];
  /**
   * What the real adapter would refuse for this use, found without rendering. Optional here; the Editor stage supplies it. Each string becomes ADAPTER_REFUSES.
   * It is also applied to a substitute before one is offered.
   */
  preflight?: (use: RecipeUse, scene: Scene, capability: Capability) => string[];
  now?: () => Date;
}

const REASON_OF: Record<RejectionCode, FeasibilityReason> = {
  DEPRECATED: "CAPABILITY_NOT_EXECUTABLE", BELOW_READINESS: "BELOW_READINESS", ENGINE_UNAVAILABLE: "ENGINE_UNAVAILABLE", OPERATION_NOT_SUPPORTED: "OPERATION_NOT_SUPPORTED",
  MEDIA_NOT_ACCEPTED: "MEDIA_NOT_ACCEPTED", SLOT_INCOMPATIBLE: "SLOT_INCOMPATIBLE", ASPECT_UNSUPPORTED: "ASPECT_UNSUPPORTED", DURATION_OUT_OF_RANGE: "DURATION_OUT_OF_RANGE",
  SCENE_TYPE_UNSUPPORTED: "NO_CAPABILITY", PURPOSE_MISMATCH: "NO_CAPABILITY",
};
const COMPOSITION_RECIPE = "scene-composition";
/**
 * Which operations produce a scene's picture, by what the renderers actually do (checked against the adapters and planners):
 * - render_graphics_scene: draws a whole scene (a text card, an image scene, an end card, a logo reveal, a scene composition). Always a picture.
 * - trim_clip: shows the scene's supplied picture or clip (a camera move on an image, a clip played). A picture when it is executable; it needs the asset, which its slot requires.
 * - overlay_text: puts text on a scene. Alone it draws the text on a plain card, which is a picture only when the scene carries no supplied picture; when the scene carries one,
 *   something else has to show it (the adapters refuse a supplied asset that an operation lists but nothing shows; an asset no operation lists is caught by the render-time
 *   coverage check instead), so the text alone is not the scene's picture.
 * - concat: joins scenes (the assembler). Never a picture.
 * - mix_audio: audio, which is not built. Never a picture.
 * This is a necessary condition, not a sufficient one: the renderer's pre-flight can still refuse a scene this rule counts as a picture.
 */
export const PICTURE_OPERATIONS: Readonly<Record<OperationType, "scene" | "shows_asset" | "text_only" | "none">> = {
  render_graphics_scene: "scene", trim_clip: "shows_asset", overlay_text: "text_only", concat: "none", mix_audio: "none",
};
const carriesPicture = (scene: Pick<Scene, "asset_ids">, assets: readonly Asset[]): boolean => scene.asset_ids.some((id) => { const a = assets.find((x) => x.asset_id === id); return !!a && a.media_type !== "audio"; });

/** True when this decision, by itself, produces the scene's picture: executable (not blocked, not dependent on a substitute) and with an operation that draws. */
export function producesScenePicture(d: Pick<ProductionDecision, "verdict" | "operations">, scene: Pick<Scene, "asset_ids">, assets: readonly Asset[]): boolean {
  if (d.verdict !== "executable") return false;
  return d.operations.some((o) => {
    const kind = PICTURE_OPERATIONS[o];
    return kind === "scene" || kind === "shows_asset" || (kind === "text_only" && !carriesPicture(scene, assets));
  });
}

export const sceneMedia = (scene: Pick<Scene, "asset_ids">, assets: readonly Asset[]): Media[] => {
  const by = new Map(assets.map((a) => [a.asset_id, a.media_type]));
  const m = [...new Set(scene.asset_ids.map((id) => by.get(id)).filter((x): x is "video" | "image" | "audio" => !!x))].sort();
  return m.length ? m : ["none"];
};

/** The query that says whether a capability fits a scene for an operation. One definition, used for the selected capability, its alternatives and candidates offered to the model. */
export function sceneQuery(scene: Pick<Scene, "asset_ids" | "duration_seconds">, assets: readonly Asset[], i: Pick<PlanningInput, "aspect_ratio" | "available_engines">, operation: OperationType, min: CapabilityQuery["min_readiness"] = "executable"): CapabilityQuery {
  return { required_operations: [operation], media_types: sceneMedia(scene, assets), aspect_ratio: i.aspect_ratio, duration_s: scene.duration_seconds, available_engines: i.available_engines, min_readiness: min };
}

type Snapshot = CapabilitySnapshot;
const byRecipe = (snap: Snapshot, recipe_id: string): Capability[] => snap.capabilities.filter((c) => c.recipe_id === recipe_id && c.variant_of === null);

/** Recipes the model may be offered for a scene and operation: only those whose capability is live-resolved and compatible. Everything else is not a candidate. */
export function candidateRecipeIds(snapshot: CapabilitySnapshot, scene: Pick<Scene, "asset_ids" | "duration_seconds">, operation: OperationType, i: Pick<PlanningInput, "assets" | "aspect_ratio" | "available_engines">): string[] {
  const ids = queryCapabilities(snapshot, sceneQuery(scene, i.assets, i, operation)).candidates.map((c) => c.capability).filter((c) => c.variant_of === null && c.recipe_id && !c.capability_id.includes("#") && byRecipe(snapshot, c.recipe_id).length === 1).map((c) => c.recipe_id!);
  return [...new Set(ids)].sort();
}

function bindingsFor(c: Capability, scene: Scene, assets: readonly Asset[]) {
  const by = new Map(assets.map((a) => [a.asset_id, a]));
  const used = new Set<string>();
  const out: { slot_id: string; asset_id: string; media_type: "video" | "image" | "audio" }[] = [];
  for (const s of c.asset_slots) {
    const hit = scene.asset_ids.find((id) => !used.has(id) && by.has(id) && s.media_types.includes(by.get(id)!.media_type));
    if (hit) { used.add(hit); out.push({ slot_id: s.slot_id, asset_id: hit, media_type: by.get(hit)!.media_type }); }
  }
  return out;
}

const resolvedParams = (c: Capability, supplied: Record<string, number | string | boolean>) => {
  const out: Record<string, number | string | boolean> = {};
  for (const p of c.parameters) out[p.name] = p.name in supplied ? supplied[p.name]! : p.default;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
};

/** Does this capability fit this use? Reasons are empty when it does. The same checks apply to the planned capability and to any alternative. */
function fitProblems(c: Capability, use: RecipeUse, scene: Scene, i: PlanningInput): { reasons: FeasibilityReason[]; details: string[]; issues: { code: string; parameter: string; detail: string }[] } {
  const reasons: FeasibilityReason[] = [], details: string[] = [];
  const op = c.operations[0];
  if (!op) { reasons.push("OPERATION_NOT_SUPPORTED"); details.push(`${c.capability_id} implements no operation`); }
  else for (const r of incompatibilities(c, sceneQuery(scene, i.assets, i, op)).rejections) {
    reasons.push(r.code === "BELOW_READINESS" && c.status === "registered" ? "CAPABILITY_NOT_EXECUTABLE" : REASON_OF[r.code]);
    details.push(r.detail);
  }
  const issues = validateParameters(c, use.params).map((p) => ({ code: p.code, parameter: p.parameter, detail: p.detail }));
  for (const p of issues) { reasons.push("PARAMETER_INVALID"); details.push(`${use.use_id}: ${p.detail}`); }
  for (const s of validateSlotBindings(c, bindingsFor(c, scene, i.assets))) if (s.code === "SLOT_MANDATORY_EMPTY") { reasons.push("MANDATORY_ASSET_MISSING"); details.push(`${scene.scene_id}: ${s.detail}`); }
  if (!reasons.length) for (const m of i.preflight?.(use, scene, c) ?? []) { reasons.push("ADAPTER_REFUSES"); details.push(m); }
  return { reasons, details, issues };
}

function decide(snap: Snapshot, use: RecipeUse, scene: Scene, i: PlanningInput): ProductionDecision {
  const base = { use_id: use.use_id, scene_id: use.scene_id, recipe_id: use.recipe_id, supplied: use.params };
  const empty = (reasons: FeasibilityReason[], details: string[], recipe_version: string | null = null): ProductionDecision => ({
    use_id: base.use_id, scene_id: base.scene_id, recipe_id: base.recipe_id, recipe_version, capability_id: null, capability_version: null, capability_record_hash: null, engine: null, implementation_ref: null, operations: [],
    readiness: null, verification: null, variant: null, slot_bindings: [], parameters: { supplied: use.params, resolved: {}, issues: [] }, verdict: "blocked", reasons, details, substitute: null, alternatives_considered: [], limitations: [],
  });
  const found = byRecipe(snap, use.recipe_id);
  if (!found.length) return empty(["RECIPE_UNKNOWN"], [`no capability is registered for recipe ${use.recipe_id}`]);
  if (found.length > 1) return empty(["AMBIGUOUS_CAPABILITY"], [`recipe ${use.recipe_id} maps to ${found.length} capabilities (${found.map((c) => c.capability_id).join(", ")}); the registry cannot say which one is meant`], found[0]!.recipe_version);
  const cap = found[0]!;
  const fit = fitProblems(cap, use, scene, i);
  const reasons = [...fit.reasons], details = [...fit.details];

  // A drawn visual is a variant of the composition capability: it must be live-resolved in its own right, and nothing is taken from its parent.
  let variant: ProductionDecision["variant"] = null;
  if (use.recipe_id === COMPOSITION_RECIPE && scene.visual && scene.visual.block !== "asset_stage") {
    const v = snap.capabilities.find((c) => c.capability_id === `remotion:scene-composition:${scene.visual!.block}`);
    if (!v) { reasons.push("VISUAL_BLOCK_NOT_EXECUTABLE"); details.push(`no capability is registered for the ${scene.visual.block} visual block`); }
    else {
      variant = { capability_id: v.capability_id, capability_record_hash: v.record_hash };
      if (v.status === "registered" || v.status === "deprecated" || !v.engine || !i.available_engines.includes(v.engine)) { reasons.push("VISUAL_BLOCK_NOT_EXECUTABLE"); details.push(`${v.capability_id} is ${v.status}${v.engine && !i.available_engines.includes(v.engine) ? `; ${v.engine} is not available here` : ""}`); }
    }
  }

  // Alternatives with the same intent and operation: looked at, recorded, and offered only as a suggestion when the planned capability cannot be used.
  const op = cap.operations[0];
  const same = cap.intent_key && op ? snap.capabilities.filter((c) => c.capability_id !== cap.capability_id && c.variant_of === null && c.intent_key === cap.intent_key && c.operations.includes(op)) : [];
  const considered: AlternativeConsidered[] = same.map((alt) => { const f = fitProblems(alt, use, scene, i); return { capability_id: alt.capability_id, compatible: f.reasons.length === 0, reasons: f.reasons.length ? [...new Set(f.reasons)] : ["OK"] }; });
  const usable = same.filter((_, n) => considered[n]!.compatible);

  let verdict: FeasibilityVerdict = reasons.length ? "blocked" : "executable";
  let substitute: Substitute | null = null;
  if (verdict === "blocked" && usable.length === 1) {
    const alt = usable[0]!;
    substitute = { capability_id: alt.capability_id, recipe_id: alt.recipe_id, engine: alt.engine, basis: `same intent (${alt.intent_key}) and operation ${op}; executable and compatible with ${scene.scene_id}. The plan names ${cap.recipe_id}, so using it needs a revised and re-approved plan` };
    verdict = "executable_with_substitute";
    reasons.push("SUBSTITUTE_NEEDS_APPROVAL");
  } else if (verdict === "blocked" && usable.length > 1) {
    reasons.push("AMBIGUOUS_CAPABILITY");
    details.push(`${usable.length} equally eligible alternatives exist (${usable.map((c) => c.capability_id).join(", ")}); none is chosen on the plan's behalf`);
  }
  const limitations: string[] = [];
  if (verdict === "executable") {
    limitations.push(`readiness ${cap.status}${cap.status === "executable" || cap.status === "validated" ? ": not reviewed" : ""}; historical evidence ${cap.verification.historical_evidence}; no current execution has been verified`);
    if (cap.verification.historical_evidence === "stale") limitations.push("its validation record is stale");
  }
  return {
    use_id: use.use_id, scene_id: use.scene_id, recipe_id: use.recipe_id, recipe_version: cap.recipe_version, capability_id: cap.capability_id, capability_version: cap.version, capability_record_hash: cap.record_hash,
    engine: cap.engine, implementation_ref: cap.implementation_ref, operations: [...cap.operations], readiness: cap.status, verification: cap.verification, variant, slot_bindings: bindingsFor(cap, scene, i.assets),
    parameters: { supplied: use.params, resolved: resolvedParams(cap, use.params), issues: fit.issues }, verdict, reasons: reasons.length ? [...new Set(reasons)] : ["OK"], details, substitute, alternatives_considered: considered, limitations,
  };
}

/** Builds the plan for the Director's uses. Always returns a plan (blocked decisions are part of it); `summary.clear` says whether anything stops it from being approved. */
export function generateProductionPlan(snap: CapabilitySnapshot, i: PlanningInput): ProductionDecisionPlan {
  const scenes = new Map(i.scenePlan.scenes.map((s) => [s.scene_id, s]));
  const decisions: ProductionDecision[] = i.editPlan.uses.map((u) => {
    const scene = scenes.get(u.scene_id);
    if (!scene) return { use_id: u.use_id, scene_id: u.scene_id, recipe_id: u.recipe_id, recipe_version: null, capability_id: null, capability_version: null, capability_record_hash: null, engine: null, implementation_ref: null, operations: [], readiness: null, verification: null, variant: null, slot_bindings: [], parameters: { supplied: u.params, resolved: {}, issues: [] }, verdict: "blocked" as const, reasons: ["NO_CAPABILITY" as const], details: [`scene ${u.scene_id} is not in the storyboard`], substitute: null, alternatives_considered: [], limitations: [] };
    return decide(snap, u, scene, i);
  });

  const unresolved: UnresolvedRequirement[] = [];
  const externalByScene = new Map<string, string[]>();
  for (const it of assetFeasibility(i.scenePlan, i.assets).items) if (it.severity === "blocker") externalByScene.set(it.scene_id, [...(externalByScene.get(it.scene_id) ?? []), it.message]);
  const sceneRows = i.scenePlan.scenes.map((s) => {
    const mine = decisions.filter((d) => d.scene_id === s.scene_id);
    let verdict: FeasibilityVerdict = mine.some((d) => d.verdict === "blocked") ? "blocked" : mine.some((d) => d.verdict === "executable_with_substitute") ? "executable_with_substitute" : "executable";
    for (const msg of externalByScene.get(s.scene_id) ?? []) { unresolved.push({ scene_id: s.scene_id, kind: "external_asset", reason: "EXTERNAL_ASSET_MISSING", detail: msg }); verdict = "blocked"; }
    if (!mine.some((d) => producesScenePicture(d, s, i.assets))) { unresolved.push({ scene_id: s.scene_id, kind: "scene_picture", reason: "NO_CAPABILITY", detail: `no executable use in the plan produces ${s.scene_id}'s picture (a join, audio, a blocked or substitute-dependent use, or text over a supplied picture that nothing shows, does not)` }); verdict = "blocked"; }
    if (s.voiceover || s.audio_cues.length || s.asset_ids.some((id) => i.assets.find((a) => a.asset_id === id)?.media_type === "audio")) unresolved.push({ scene_id: s.scene_id, kind: "audio", reason: "AUDIO_NOT_PRODUCED", detail: "audio (voiceover, music or effects) is not produced by this system yet" });
    return { scene_id: s.scene_id, verdict, use_ids: mine.map((d) => d.use_id) };
  });

  const used = new Set<string>();
  for (const d of decisions) { if (d.capability_id) used.add(d.capability_id); if (d.variant) { used.add(d.variant.capability_id); const parent = snap.capabilities.find((c) => c.capability_id === d.variant!.capability_id)?.variant_of; if (parent) used.add(parent); } }
  const relevant = snap.capabilities.filter((c) => used.has(c.capability_id));
  const count = (v: FeasibilityVerdict) => decisions.filter((d) => d.verdict === v).length;
  const summary = { executable: count("executable"), executable_with_substitute: count("executable_with_substitute"), blocked: count("blocked"), clear: false }; // clear needs a passed pre-flight, which a new plan never has
  const body = {
    plan_version: PRODUCTION_PLAN_VERSION, project_id: i.editPlan.project_id, storyboard: i.storyboard,
    edit_plan: { version: i.editPlan.version, hash: editPlanHashOf(i) },
    decisions, scenes: sceneRows, unresolved, summary, preflight: NOT_RUN_PREFLIGHT,
    registry: { snapshot_hash: snap.snapshot_hash, relevant_capabilities_hash: relevantCapabilitiesHash(relevant), relevant_capability_ids: relevant.map((c) => c.capability_id).sort() },
    created_at: (i.now?.() ?? new Date()).toISOString(),
  };
  return ProductionDecisionPlan.parse({ ...body, plan_hash: productionPlanHash(body as never) });
}

const editPlanHashOf = (i: PlanningInput): string => editPlanRef(i.storyboard, i.editPlan).hash;

export interface PlanValidation { ok: boolean; issues: string[]; notes: string[] }

/**
 * Re-derives the plan from the same Director plans and the registry as it is now, and compares. `ok` only when the plan is intact, still describes the
 * Director plan, and every capability it relies on is unchanged. A change to an unrelated capability changes the snapshot hash but is not an issue.
 */
export function validateProductionPlan(snap: CapabilitySnapshot, i: PlanningInput, raw: unknown): PlanValidation {
  const parsed = ProductionDecisionPlan.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((x) => `production plan ${x.path.join(".") || "root"}: ${x.message}`), notes: [] };
  const plan = parsed.data;
  const issues: string[] = [], notes: string[] = [];
  if (productionPlanHash(plan) !== plan.plan_hash) issues.push("the production plan changed after it was made (hash mismatch)");
  if (plan.storyboard.version !== i.storyboard.version || plan.storyboard.hash !== i.storyboard.hash) issues.push("the production plan was made for a different storyboard");
  if (plan.edit_plan.version !== i.editPlan.version || plan.edit_plan.hash !== editPlanHashOf(i)) issues.push("the production plan was made for a different Director edit plan");
  const now = generateProductionPlan(snap, { ...i, now: () => new Date(plan.created_at) });
  if (now.registry.relevant_capabilities_hash !== plan.registry.relevant_capabilities_hash) issues.push("a capability this plan relies on has changed (relevant-capabilities hash mismatch)");
  for (const d of plan.decisions) {
    const cur = now.decisions.find((x) => x.use_id === d.use_id);
    if (!cur) { issues.push(`use ${d.use_id} is no longer in the Director plan`); continue; }
    if (cur.capability_id !== d.capability_id || cur.engine !== d.engine || cur.implementation_ref !== d.implementation_ref) issues.push(`use ${d.use_id}: the capability, engine or implementation would now be ${cur.capability_id ?? "none"} / ${cur.engine ?? "none"} / ${cur.implementation_ref ?? "none"}`);
    if (cur.verdict !== d.verdict) issues.push(`use ${d.use_id}: it was ${d.verdict} and would now be ${cur.verdict}`);
  }
  if (now.decisions.length !== plan.decisions.length) issues.push("the Director plan has a different number of uses than the production plan");
  if (!issues.length && productionSelectionHash(now) !== productionSelectionHash(plan)) issues.push("the production plan no longer matches what the registry and the Director plan produce now");
  if (plan.preflight.status !== "not_run") {
    if (plan.preflight.bound_selection_hash !== productionSelectionHash(plan)) issues.push("the pre-flight result belongs to a different selection than this plan");
    issues.push(...preflightCoverageProblems(plan, plan.preflight));
    notes.push("the pre-flight result is kept as recorded; this check does not re-run the renderer's planners (render time does)");
  }
  issues.push(...derivedFieldProblems(plan, now));
  if (now.registry.snapshot_hash !== plan.registry.snapshot_hash && !issues.length) notes.push("the registry changed elsewhere since the plan was made; nothing this plan relies on changed, so it still stands");
  return { ok: issues.length === 0, issues, notes };
}


/**
 * Problems with the fields a plan derives from its own content: the scene rows and the summary must be what the decisions, the unresolved requirements and the
 * pre-flight imply. With a freshly generated plan (`fresh`) the scenes and their uses must also be those of the Director plan. Needs no registry.
 */
export function derivedFieldProblems(plan: ProductionDecisionPlan, fresh?: Pick<ProductionDecisionPlan, "scenes">): string[] {
  const issues: string[] = [];
  const want = deriveRowsAndSummary(plan);
  if (want.scenes.length !== plan.scenes.length || want.scenes.some((r, n) => { const g = plan.scenes[n]!; return g.scene_id !== r.scene_id || g.verdict !== r.verdict || g.use_ids.join(" ") !== r.use_ids.join(" "); })) issues.push("the plan's scene rows do not match its decisions and pre-flight");
  if (fresh && (fresh.scenes.length !== plan.scenes.length || fresh.scenes.some((r, n) => plan.scenes[n]?.scene_id !== r.scene_id || plan.scenes[n]!.use_ids.join(" ") !== r.use_ids.join(" ")))) issues.push("the plan's scenes or their uses differ from the Director plan");
  const have = plan.summary;
  if (have.executable !== want.summary.executable || have.executable_with_substitute !== want.summary.executable_with_substitute || have.blocked !== want.summary.blocked) issues.push("the plan's summary counts do not match its decisions");
  if (have.clear !== want.summary.clear) issues.push(`the plan says clear=${have.clear}, but its decisions, unresolved requirements and pre-flight imply clear=${want.summary.clear}`);
  return issues;
}

export class PreflightRefusedError extends Error {
  constructor(readonly reasons: string[]) { super(`pre-flight result refused: ${reasons.join("; ")}`); this.name = "PreflightRefusedError"; }
}

type PlanBody = Omit<ProductionDecisionPlan, "plan_hash">;

/** Executable decisions of a scene that put something on its picture (everything but a join or audio). The pre-flight must judge each such scene. */
const visualDecisions = (plan: Pick<PlanBody, "decisions">, scene_id: string) => plan.decisions.filter((d) => d.scene_id === scene_id && d.verdict === "executable" && d.operations.some((o) => PICTURE_OPERATIONS[o] !== "none"));

/**
 * What the plan implies about its scene rows and summary, from the decisions, the unresolved requirements and the pre-flight alone. `generateProductionPlan` and `finalize`
 * write these fields and `validateProductionPlan` recomputes them, so a plan whose summary or rows were edited does not validate. `clear` needs a passed pre-flight that
 * covers every picture scene, and nothing blocked.
 */
function deriveRowsAndSummary(plan: PlanBody): { scenes: ProductionDecisionPlan["scenes"]; summary: ProductionDecisionPlan["summary"] } {
  const failed = new Set(plan.preflight.scenes.filter((x) => x.status === "failed").map((x) => x.scene_id));
  const stopped = new Set(plan.unresolved.filter((u) => u.kind === "external_asset" || u.kind === "scene_picture").map((u) => u.scene_id));
  const scenes = plan.scenes.map((r) => {
    const mine = plan.decisions.filter((d) => d.scene_id === r.scene_id);
    const verdict: FeasibilityVerdict = failed.has(r.scene_id) || stopped.has(r.scene_id) || mine.some((d) => d.verdict === "blocked") ? "blocked" : mine.some((d) => d.verdict === "executable_with_substitute") ? "executable_with_substitute" : "executable";
    return { scene_id: r.scene_id, verdict, use_ids: mine.map((d) => d.use_id) };
  });
  const count = (v: FeasibilityVerdict) => plan.decisions.filter((d) => d.verdict === v).length;
  const executable = count("executable"), executable_with_substitute = count("executable_with_substitute"), blocked = count("blocked");
  const clear = blocked === 0 && executable_with_substitute === 0 && scenes.every((r) => r.verdict === "executable") && plan.preflight.status === "passed" && preflightCoverageProblems(plan, plan.preflight).length === 0;
  return { scenes, summary: { executable, executable_with_substitute, blocked, clear } };
}

/** The plan with scene rows and the summary worked out from its decisions, unresolved requirements and pre-flight. `clear` needs a passed pre-flight and nothing blocked. */
function finalize(plan: PlanBody): ProductionDecisionPlan {
  const body = { ...plan, ...deriveRowsAndSummary(plan) };
  return ProductionDecisionPlan.parse({ ...body, plan_hash: productionPlanHash(body as never) });
}

/**
 * Whether a pre-flight result covers the plan the way it must. Every scene with executable picture-producing uses has a record, and the record is a planner's verdict
 * (`passed` or `failed`), never `not_applicable`: such a scene cannot be waved through as having nothing to draw. A passed record names the engine and the templates the
 * decisions selected. A `failed` record is accepted as what it is: a refusal that blocks the plan.
 */
function preflightCoverageProblems(plan: Pick<PlanBody, "decisions" | "scenes">, r: PreflightResult): string[] {
  const reasons: string[] = [];
  const known = new Set(plan.scenes.map((x) => x.scene_id));
  for (const sc of r.scenes) if (!known.has(sc.scene_id)) reasons.push(`the result names scene ${sc.scene_id}, which is not in the plan`);
  const byScene = new Map(r.scenes.map((x) => [x.scene_id, x]));
  for (const row of plan.scenes) {
    const mine = plan.decisions.filter((d) => d.scene_id === row.scene_id && d.verdict === "executable");
    const picture = visualDecisions(plan, row.scene_id);
    const rec = byScene.get(row.scene_id);
    if (mine.length && !rec) { reasons.push(`scene ${row.scene_id} has executable uses but no pre-flight record`); continue; }
    if (!rec) continue;
    if (picture.length && rec.status === "not_applicable") reasons.push(`scene ${row.scene_id} has executable picture-producing uses (${picture.map((d) => d.use_id).join(", ")}) but its pre-flight record is not_applicable; a planner must have passed or refused it`);
    if (rec.status === "passed") {
      const planned = [...new Set(picture.map((d) => d.implementation_ref!))].sort();
      if (JSON.stringify([...rec.template_refs].sort()) !== JSON.stringify(planned)) reasons.push(`scene ${row.scene_id}: the planner ran with different templates (${rec.template_refs.join(", ") || "none"}) than the plan selected (${planned.join(", ") || "none"})`);
      const engines = [...new Set(picture.map((d) => d.engine ?? "none"))];
      if (picture.length && (engines.length !== 1 || rec.engine !== engines[0])) reasons.push(`scene ${row.scene_id}: the planner ran on ${rec.engine ?? "no engine"}, but the plan selected ${engines.join(", ")}`);
    }
  }
  return reasons;
}

/**
 * Records the renderer's pre-flight on a plan. Refused unless the result is internally sound (hash, a planner run for every passed scene), is bound to this plan's
 * exact selection and to the compiled plan it ran over (`compiledHash`, recomputed by the caller), covers every scene the plan draws, and used the templates the decisions selected. `not_run` is not attachable: it is the absence of a result.
 */
export function attachPreflight(plan: ProductionDecisionPlan, raw: unknown, compiledHash: string): ProductionDecisionPlan {
  const parsed = PreflightResult.safeParse(raw);
  if (!parsed.success) throw new PreflightRefusedError(parsed.error.issues.map((x) => x.message));
  const r = parsed.data, reasons: string[] = [];
  if (r.status === "not_run") throw new PreflightRefusedError(["a pre-flight that was not run cannot be recorded as a result"]);
  if (r.bound_selection_hash !== productionSelectionHash(plan)) reasons.push("the result was produced for a different selection than this plan");
  if (r.bound_compiled_hash !== compiledHash) reasons.push("the result was produced over different compiled operations than this plan's compiled plan");
  reasons.push(...preflightCoverageProblems(plan, r));
  if (reasons.length) throw new PreflightRefusedError(reasons);
  return finalize({ ...plan, preflight: r });
}
