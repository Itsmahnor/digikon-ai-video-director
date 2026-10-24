import {
  ApprovalRecord, DirectorHandoff, EditorOutput, HANDOFF_SCHEMA_VERSION, assetFeasibility, auditClaims, canonicalJson, handoffContentHash, verifyHandoffIntegrity,
  type ApprovalStage, type Asset, type AssetFeasibility, type BrandFact, type ClaimAuditEntry, type EditPlan, type ProvenanceEntry, type Project, type Readiness, type RequiredOperation,
} from "@digikon/contracts";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { AGENT_SCOPES, type Doc } from "@digikon/rag";
import { recipeReadiness, resolveParams, validateEditPlan, type RecipeLibrary } from "@digikon/recipes";
import { checkRenderable, type ApprovalState } from "./approvals.js";
import { editIssues, planIssues } from "./nodes.js";
import type { SkillLibrary } from "./skills.js";

/** The Director state a handoff is built from. Everything else in the graph state stays inside the Director. */
export interface HandoffState extends ApprovalState {
  status: string;
  skillsUsed?: string[];
  referencesUsed?: string[];
  citations?: string[];
}

export interface HandoffContext {
  recipes: RecipeLibrary;
  skills: SkillLibrary;
  run_id: string;
  model: string;
  /** The knowledge notes the retriever was built from, to resolve retrieved ids to their sources. */
  knowledge?: readonly Doc[];
  /** How asset files are checked at handoff time. Defaults to the local disk. */
  files?: AssetFiles;
  /** When set, every asset file must sit inside this folder (the session's storage folder in the console). */
  storageRoot?: string;
  /** Refuse assets without a content hash recorded at upload. The console sets this: all its uploads are hashed. */
  requireContentHash?: boolean;
  now?: () => Date;
}

/** Reads a file's size and content hash. Both return null when the file does not exist or is not a regular file. */
export interface AssetFiles {
  size(uri: string): number | null;
  /** SHA-256 of the file's bytes, hex. Optional: without it, a recorded content hash cannot be checked and is reported. */
  sha256?(uri: string): string | null;
}

export const localFiles: AssetFiles = {
  size(uri) {
    try { const st = statSync(uri); return st.isFile() ? st.size : null; } catch { return null; }
  },
  /** Streams the file in 1 MB chunks, so a large video is never held in memory. Synchronous: it blocks while it reads. */
  sha256(uri) {
    let fd: number | null = null;
    try {
      fd = openSync(uri, "r");
      const hash = createHash("sha256");
      const buf = Buffer.allocUnsafe(1 << 20);
      for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n));
      return hash.digest("hex");
    } catch { return null; } finally { if (fd !== null) closeSync(fd); }
  },
};

/**
 * Every asset the plan uses must still be on disk, inside the allowed folder, with the byte size the probe recorded when it
 * was analysed. A size match is a cheap identity check, not a content hash; the full metadata is covered by the evidence hash.
 */
export function assetFileProblems(assets: readonly Asset[], files: AssetFiles = localFiles, storageRoot?: string, requireContentHash = false): string[] {
  const out: string[] = [];
  const hashed = new Map<string, string | null>(); // each file is read at most once per check
  for (const a of assets) {
    if (storageRoot) {
      const rel = relative(resolve(storageRoot), resolve(a.uri));
      if (rel.startsWith("..") || isAbsolute(rel)) { out.push(`asset ${a.asset_id} is outside the project's storage folder (${a.uri})`); continue; }
    }
    const recorded = a.metadata["bytes"];
    const size = files.size(a.uri);
    if (size === null) out.push(`asset ${a.asset_id} is missing at handoff time (${a.uri})`);
    else if (typeof recorded !== "number") out.push(`asset ${a.asset_id} has no recorded file size, so its file cannot be verified`);
    else if (size !== recorded) out.push(`asset ${a.asset_id} changed on disk: it is ${size} bytes, but ${recorded} bytes were analysed`);
    else {
      // Size matches; the content hash recorded at upload (covered by the approvals' evidence hash) settles identity.
      const want = a.metadata["sha256"];
      if (typeof want !== "string") { if (requireContentHash) out.push(`asset ${a.asset_id} has no recorded content hash, so its file cannot be verified`); continue; }
      if (!files.sha256) { out.push(`asset ${a.asset_id} has a content hash, but this check cannot read file contents`); continue; }
      if (!hashed.has(a.uri)) hashed.set(a.uri, files.sha256(a.uri));
      const got = hashed.get(a.uri);
      if (got === null) out.push(`asset ${a.asset_id} could not be read to check its content`);
      else if (got !== want) out.push(`asset ${a.asset_id} content changed: its SHA-256 is not the one recorded at upload`);
    }
  }
  return out;
}

export class HandoffRefusedError extends Error {
  constructor(readonly reasons: string[]) {
    super(`The handoff to the Editor is refused: ${reasons.join("; ")}`);
    this.name = "HandoffRefusedError";
  }
}

const latestApproved = (raw: readonly unknown[] = [], stage: ApprovalStage) =>
  [...raw].reverse().map((r) => ApprovalRecord.safeParse(r)).find((p) => p.success && p.data.stage === stage)?.data ?? null;

/**
 * Freezes an approved Director run into the handoff the Editor consumes. It runs the same check as `assertRenderable`, so a
 * missing approval, a hash or version mismatch or a plan that no longer validates blocks the handoff with every reason listed.
 */
export function buildHandoff(s: HandoffState, ctx: HandoffContext): DirectorHandoff {
  const reasons: string[] = [];
  if (s.status !== "approved") reasons.push(`the Director run is "${s.status}", not approved`);
  const check = checkRenderable(s, ctx);
  if (!check.ok) reasons.push(...check.reasons);
  const used = new Set((s.scenePlan?.scenes ?? []).flatMap((sc) => sc.asset_ids));
  const assets = s.assets.filter((a) => used.has(a.asset_id));
  reasons.push(...assetFileProblems(assets, ctx.files, ctx.storageRoot, ctx.requireContentHash));
  const sbRec = latestApproved(s.approvals, "storyboard");
  const epRec = latestApproved(s.approvals, "edit_plan");
  if (reasons.length || !check.ok || !sbRec || !epRec) throw new HandoffRefusedError(reasons.length ? reasons : ["approval records are missing"]);

  const treatment = s.treatmentDoc!, storyboard = s.scenePlan!, editPlan = s.editPlan!, facts = s.facts ?? [];
  const claims_audit = auditClaims(treatment.claims, storyboard.scenes, facts);
  // Only supported claims that a scene shows are grounded claims; illustrative and unsupported ones stay visible in claims_audit.
  const claims = claims_audit.flatMap((e) => (e.status === "supported" && e.scene_ids.length ? [{ claim: treatment.claims.find((c) => c.claim_id === e.claim_id)!, fact: e.fact!, scene_ids: e.scene_ids }] : []));
  const asset_feasibility = assetFeasibility(storyboard, assets);
  const required_operations = requiredOperations(editPlan, ctx.recipes);
  const readiness = readinessOf({ operations: required_operations, feasibility: asset_feasibility, audit: claims_audit, recipe_library_mode: ctx.recipes.minStatus });
  const { owner_id: _owner, ...project } = s.project;

  const knowledge = new Map((ctx.knowledge ?? []).map((d) => [d.id, d]));
  const retrieved: ProvenanceEntry[] = (s.citations ?? []).map((id) => {
    const fact = facts.find((f) => f.fact_id === id);
    if (fact) return { id, kind: "brand_fact", source: fact.source, quality: null };
    const recipe = ctx.recipes.get(id);
    if (recipe) return { id, kind: "recipe", source: `recipe ${recipe.recipe_id}@${recipe.version}`, quality: recipe.status };
    const doc = knowledge.get(id);
    if (doc) return { id, kind: "knowledge", source: doc.source, quality: doc.metadata.grade ?? null };
    return { id, kind: "unknown", source: null, quality: null };
  });

  const content = {
    schema_version: HANDOFF_SCHEMA_VERSION,
    run: { run_id: ctx.run_id, model: ctx.model, recipe_library_mode: ctx.recipes.minStatus },
    project, treatment, storyboard, edit_plan: editPlan,
    approvals: { storyboard: sbRec, edit_plan: epRec },
    approved: { storyboard: check.storyboard, edit_plan: check.edit_plan },
    assets, asset_notes: (s.notes ?? []).filter((n) => used.has(n.asset_id)),
    claims, claims_audit, asset_feasibility, required_operations, readiness,
    constraints: {
      platform: s.project.platform, aspect_ratio: s.project.aspect_ratio, target_duration_s: s.project.target_duration, brand_id: s.project.brand_id,
      platform_spec_ids: retrieved.filter((r) => knowledge.get(r.id)?.collection === "platform_specs").map((r) => r.id),
    },
    qa: {
      target_duration_s: s.project.target_duration, duration_tolerance_s: 0.5, aspect_ratio: s.project.aspect_ratio,
      scene_spans: storyboard.scenes.map((sc) => ({ scene_id: sc.scene_id, start: sc.start_time, end: sc.start_time + sc.duration_seconds })),
      expect_audio: assets.some((a) => a.audio_tracks > 0), loudness_target_lufs: null, grounded_claim_ids: claims.map((c) => c.claim.claim_id),
    },
    provenance: {
      skills: (s.skillsUsed ?? []).map((n) => `${n}@${ctx.skills.get(n).version}`),
      references: s.referencesUsed ?? [],
      recipes: [...new Set(editPlan.uses.map((u) => u.recipe_id))].sort().map((id) => { const r = ctx.recipes.get(id)!; return { recipe_id: id, version: r.version, status: r.status }; }),
      retrieved,
    },
  };
  // Parse first, hash second: the hash covers exactly what the schema keeps (defaults filled, unknown keys dropped), so it always verifies.
  const parsed = DirectorHandoff.omit({ content_hash: true, handoff_id: true, created_at: true }).parse(content);
  const content_hash = handoffContentHash(parsed);
  const handoff = DirectorHandoff.parse({ ...parsed, content_hash, handoff_id: `ho_${content_hash.slice(0, 16)}`, created_at: (ctx.now?.() ?? new Date()).toISOString() });
  const problems = [...verifyHandoffIntegrity(handoff), ...secretFindings(JSON.stringify(handoff))];
  if (problems.length) throw new HandoffRefusedError(problems);
  return handoff;
}

// ---------- operations, readiness, secrets ----------

/** Every recipe use as an operation, with what is known about its recipe. Recomputed by checkHandoff. */
export function requiredOperations(editPlan: EditPlan, recipes: RecipeLibrary): RequiredOperation[] {
  return editPlan.uses.map((u) => {
    const r = recipes.get(u.recipe_id)!;
    return {
      use_id: u.use_id, scene_id: u.scene_id, recipe_id: r.recipe_id, recipe_version: r.version, recipe_status: r.status,
      operation_type: r.operation_type, implementation_ref: r.implementation_ref, renderers: r.compatibility.renderers, evidence: recipeReadiness(r).evidence,
    };
  });
}

/**
 * Whether the plan could go to production today. A recipe without review evidence blocks it, as does any material that is
 * needed but not supplied. Placeholders, illustrative claims and a draft library are warnings the user should see.
 */
export function readinessOf(i: { operations: readonly RequiredOperation[]; feasibility: AssetFeasibility; audit: readonly ClaimAuditEntry[]; recipe_library_mode: "draft" | "reviewed" }): Readiness {
  const blockers = [...i.feasibility.blockers];
  const untested = new Map<string, string>();
  for (const o of i.operations) if (o.evidence === "none") untested.set(o.recipe_id, o.recipe_status);
  for (const [id, status] of [...untested].sort(([a], [b]) => a.localeCompare(b))) blockers.push(`recipe ${id} is ${status}: no review evidence`);
  const warnings = [...i.feasibility.warnings];
  for (const e of i.audit) {
    if (e.status === "illustrative" && e.scene_ids.length) warnings.push(`${e.scene_ids.join(", ")} show claim ${e.claim_id} ("${e.text}") as an illustrative concept, not a verified product fact`);
    if (e.status === "unsupported") warnings.push(`claim ${e.claim_id} is an unsupported factual claim${e.scene_ids.length ? ` shown in ${e.scene_ids.join(", ")}` : " and is not used in any scene"}. Safe alternative: ${e.safe_alternative}`);
  }
  if (i.recipe_library_mode === "draft") warnings.push("the recipe library is in draft mode (development only)");
  return { production_ready: blockers.length === 0, blockers, warnings };
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/, "an Anthropic API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bANTHROPIC_API_KEY\s*[=:]/, "an API key setting"],
  [/\b(?:api[_-]?key|secret|password|token)["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/i, "a credential assignment"],
];

/** Reasons a text must not leave the Director, without ever repeating the secret itself. */
export function secretFindings(text: string): string[] {
  const out: string[] = [];
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) out.push(`the handoff contains what looks like ${what} (not shown); remove it from the brief, facts or file names`);
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key && key.length >= 8 && text.includes(key)) out.push("the handoff contains the configured API key (not shown)");
  return out;
}

/** The Director's project record restored for the validators. A handoff does not carry the owner id. */
const projectOf = (p: DirectorHandoff["project"]): Project => ({ ...p, owner_id: "handoff" });

/** Every approved fact the handoff carries: the facts behind grounded claims and behind supported claims in the audit. */
function factsOf(h: DirectorHandoff): BrandFact[] {
  const byId = new Map<string, BrandFact>();
  for (const f of [...h.claims.map((c) => c.fact), ...h.claims_audit.flatMap((e) => (e.fact ? [e.fact] : []))]) byId.set(f.fact_id, f);
  return [...byId.values()];
}

/**
 * The approvals bind only the treatment, storyboard and edit plan. The sections copied around them (qa, constraints, claims,
 * assets) are derived from those plans, so they are recomputed here and must match. A handoff that was edited and re-hashed
 * still fails. (Fact text and asset metadata are not covered by any approval; the content hash detects change, not forgery.)
 */
function derivedSectionProblems(h: DirectorHandoff): string[] {
  const out: string[] = [];
  const scenes = h.storyboard.scenes;
  const spans = scenes.map((s) => ({ scene_id: s.scene_id, start: s.start_time, end: s.start_time + s.duration_seconds }));
  if (canonicalJson(spans) !== canonicalJson(h.qa.scene_spans)) out.push("qa.scene_spans does not match the approved storyboard");
  if (h.qa.target_duration_s !== h.project.target_duration || h.qa.aspect_ratio !== h.project.aspect_ratio) out.push("qa does not match the project");
  const c = h.constraints;
  if (c.platform !== h.project.platform || c.aspect_ratio !== h.project.aspect_ratio || c.target_duration_s !== h.project.target_duration || c.brand_id !== h.project.brand_id) out.push("constraints do not match the project");

  const used = new Set(scenes.flatMap((s) => s.asset_ids));
  if (canonicalJson([...used].sort()) !== canonicalJson(h.assets.map((a) => a.asset_id).sort())) out.push("assets are not exactly the assets the approved storyboard uses");
  if (h.asset_notes.some((n) => !used.has(n.asset_id))) out.push("asset notes include an asset the storyboard does not use");

  // Grounded claims are the supported claims some scene shows; illustrative and unsupported ones are only in claims_audit.
  const expected = auditClaims(h.treatment.claims, scenes, factsOf(h))
    .filter((e) => e.status === "supported" && e.scene_ids.length)
    .map((e) => ({ claim: h.treatment.claims.find((c) => c.claim_id === e.claim_id)!, fact: e.fact, scene_ids: e.scene_ids }));
  const actual = h.claims.map((g) => ({ claim: g.claim, fact: g.fact, scene_ids: g.scene_ids }));
  const factsMatch = h.claims.every((g) => g.fact.fact_id === g.claim.brand_fact_id);
  if (!factsMatch || canonicalJson(expected) !== canonicalJson(actual)) out.push("claims do not match the claims the approved storyboard uses");
  if (canonicalJson(h.qa.grounded_claim_ids) !== canonicalJson(h.claims.map((g) => g.claim.claim_id))) out.push("qa.grounded_claim_ids does not match the claims");
  return out;
}

/**
 * The check the Editor side runs before it does anything: the handoff is intact, its approvals match its plans, the plans still
 * validate against today's recipe library, and no recipe it relies on has changed version since. Returns [] when it may proceed.
 */
export function checkHandoff(
  raw: unknown,
  ctx: {
    recipes: RecipeLibrary;
    files?: AssetFiles;
    storageRoot?: string;
    requireContentHash?: boolean;
    /**
     * The Director's own approval records for this run. A hash is not a signature: someone who can edit the handoff can also
     * edit the evidence hash inside it. Supplying the authoritative records closes that gap.
     */
    approvals?: readonly unknown[];
  },
): string[] {
  const integrity = verifyHandoffIntegrity(raw);
  if (integrity.length) return integrity;
  const h = raw as DirectorHandoff;
  const facts = factsOf(h);
  const project = projectOf(h.project);
  const reasons: string[] = [...secretFindings(JSON.stringify(h)), ...derivedSectionProblems(h), ...assetFileProblems(h.assets, ctx.files, ctx.storageRoot, ctx.requireContentHash)];
  // What the plan needs from the recipe library and what stops it going to production are recomputed, never trusted.
  if (h.edit_plan.uses.every((u) => ctx.recipes.get(u.recipe_id))) {
    const ops = requiredOperations(h.edit_plan, ctx.recipes);
    if (canonicalJson(ops) !== canonicalJson(h.required_operations)) reasons.push("required_operations do not match the recipe library (a recipe's status, operation type or implementation changed)");
    const ready = readinessOf({ operations: ops, feasibility: assetFeasibility(h.storyboard, h.assets), audit: h.claims_audit, recipe_library_mode: h.run.recipe_library_mode });
    if (canonicalJson(ready) !== canonicalJson(h.readiness)) reasons.push("readiness does not match what the plans, assets, claims and recipes show");
  }
  if (ctx.approvals) {
    const sb = latestApproved(ctx.approvals, "storyboard"), ep = latestApproved(ctx.approvals, "edit_plan");
    if (!sb || !ep || canonicalJson(sb) !== canonicalJson(h.approvals.storyboard) || canonicalJson(ep) !== canonicalJson(h.approvals.edit_plan)) {
      reasons.push("the approval records in the handoff are not the Director's recorded approvals");
    }
  }
  reasons.push(
    ...planIssues(h.storyboard, h.assets, project, h.asset_notes, h.treatment, facts).map((i) => `storyboard is not valid: ${i}`),
    ...editIssues(h.edit_plan, h.storyboard, ctx, project, h.assets).map((i) => `edit plan is not valid: ${i}`),
  );
  for (const r of h.provenance.recipes) {
    const now = ctx.recipes.get(r.recipe_id);
    if (!now) reasons.push(`recipe ${r.recipe_id} no longer exists`);
    else if (now.version !== r.version) reasons.push(`recipe ${r.recipe_id} is now version ${now.version}, but the plan was approved with ${r.version}`);
  }
  return reasons;
}

export interface EditorResultCheck {
  ok: boolean;
  issues: string[];
  /** True when the result asks for, or would amount to, a change to an approved plan. Such a result goes back to the Director and the human gates. */
  requires_reapproval: boolean;
}

const EPS = 1e-6;

/**
 * The Director's check on what the Editor returns. The Editor may make the approved plan concrete; it may not change it.
 * Every approved recipe use must be implemented or reported as a conflict, every operation must trace to an approved use with
 * the same scene, recipe, version, assets and parameters, and stay inside its scene. Anything else is an issue, and changes
 * the Editor asks for explicitly are revision requests that need a new human approval.
 */
export function checkEditorOutput(raw: unknown, handoff: DirectorHandoff, ctx: { recipes: RecipeLibrary }): EditorResultCheck {
  const parsed = EditorOutput.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => `editor output ${i.path.join(".") || "root"}: ${i.message}`), requires_reapproval: false };
  const o = parsed.data;
  const issues: string[] = [];
  if (o.handoff_id !== handoff.handoff_id || o.handoff_content_hash !== handoff.content_hash) issues.push("the result was made from a different handoff");
  if (canonicalJson(o.approved) !== canonicalJson(handoff.approved)) issues.push("the result names different approved plan versions or hashes than the handoff");

  const scenes = new Map(handoff.storyboard.scenes.map((s) => [s.scene_id, s]));
  const uses = new Map(handoff.edit_plan.uses.map((u) => [u.use_id, u]));
  const revisedScenes = new Set(o.revision_requests.flatMap((r) => r.scene_ids));
  let drift = false;

  const opIds = new Set<string>(), perUse = new Map<string, number>();
  for (const op of o.operations) {
    if (opIds.has(op.operation_id)) issues.push(`operation ${op.operation_id}: operation_id is used more than once`);
    opIds.add(op.operation_id);
    perUse.set(op.source_use_id, (perUse.get(op.source_use_id) ?? 0) + 1);
  }
  for (const [id, n] of perUse) if (n > 1) issues.push(`approved recipe use ${id} is implemented by more than one operation`);
  o.provenance.retrievals.forEach((r, i) => {
    if (r.agent !== "editor") issues.push(`retrieval ${i + 1} was made as ${r.agent}, not the editor`);
    if (!AGENT_SCOPES.editor.collections.includes(r.collection as never)) issues.push(`retrieval ${i + 1} read ${r.collection}, which is outside the Editor's scope`);
  });

  for (const op of o.operations) {
    const at = `operation ${op.operation_id}`;
    const scene = scenes.get(op.target_scene_id);
    const use = uses.get(op.source_use_id);
    if (!scene) { issues.push(`${at}: scene ${op.target_scene_id} is not in the approved storyboard`); continue; }
    if (!use) { issues.push(`${at}: recipe use ${op.source_use_id} is not in the approved edit plan`); continue; }
    if (use.scene_id !== scene.scene_id || use.recipe_id !== op.recipe_id) issues.push(`${at}: ${op.source_use_id} was approved as ${use.recipe_id} on ${use.scene_id}, not ${op.recipe_id} on ${scene.scene_id}`);
    const recipe = ctx.recipes.get(op.recipe_id);
    if (!recipe) issues.push(`${at}: recipe ${op.recipe_id} does not exist`);
    else {
      if (op.operation_type !== recipe.operation_type) issues.push(`${at}: operation_type ${op.operation_type} does not match recipe ${recipe.recipe_id}, which becomes a ${recipe.operation_type} operation`);
      if (recipe.version !== op.recipe_version) issues.push(`${at}: recipe ${op.recipe_id} is version ${recipe.version}, not ${op.recipe_version}`);
      if (canonicalJson(op.parameters) !== canonicalJson(resolveParams(recipe, use.params))) {
        drift = true;
        if (!revisedScenes.has(scene.scene_id)) issues.push(`${at}: parameters differ from the approved ${op.source_use_id} without a revision request`);
      }
    }
    for (const a of op.asset_ids) if (!scene.asset_ids.includes(a)) issues.push(`${at}: asset ${a} is not approved for ${scene.scene_id}`);
    const end = scene.start_time + scene.duration_seconds;
    if (op.timing.start_s < scene.start_time - EPS || op.timing.start_s + op.timing.duration_s > end + EPS) issues.push(`${at}: runs outside ${scene.scene_id} (${scene.start_time}s-${end}s)`);
    if (op.caption && op.caption.text !== scene.overlay?.text) issues.push(`${at}: caption text is not the approved overlay text for ${scene.scene_id}`);
  }

  const reported = new Set(o.conflicts.map((c) => c.use_id).filter((x): x is string => !!x));
  const implemented = new Set(o.operations.map((op) => op.source_use_id));
  for (const id of uses.keys()) if (!implemented.has(id) && !reported.has(id)) issues.push(`approved recipe use ${id} has no operation and no reported conflict`);

  // Parameter ranges and recipe rules still hold, checked with the same validator the Director used.
  const asPlan = { ...handoff.edit_plan, uses: o.operations.map((op) => ({ use_id: op.operation_id, scene_id: op.target_scene_id, recipe_id: op.recipe_id, params: op.parameters as Record<string, number | string | boolean>, rationale: op.expected_result })) };
  for (const i of validateEditPlan(asPlan, handoff.storyboard, ctx.recipes, projectOf(handoff.project), handoff.assets)) {
    if (i.code !== "max_uses" && i.code !== "duplicate_use") issues.push(`operation ${i.use_id}: ${i.code} - ${i.message}`);
  }
  if (o.validation.ok && issues.length) issues.push("the result says it is valid, but these checks failed");
  return { ok: issues.length === 0, issues, requires_reapproval: o.revision_requests.length > 0 || drift };
}
