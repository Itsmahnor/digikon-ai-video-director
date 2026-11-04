import { describe, expect, it } from "vitest";
import {
  ApprovalRecord, DirectorHandoff, EDITOR_SCHEMA_VERSION, EditorInput, EditorOutput, editPlanHash, handoffContentHash, storyboardHash, verifyHandoffIntegrity,
  type EditorOperation,
} from "@digikon/contracts";
import { resolveParams } from "@digikon/recipes";
import {
  HandoffRefusedError, ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, checkEditorOutput, checkHandoff, currentEvidenceHash,
  gateDecision, type DirectorStateType,
} from "./index.js";
import { cfg, deps, goodEdit, goodStoryboard, input, knowledge, noExecution, root, treatment } from "./fixtures.js";

const ready = { status: "ready", questions: [] };
const skills = new SkillLibrary(root("skills"));
/** Stands in for the disk: the fixture files exist with the sizes their probe recorded. */
const disk = (over: Record<string, number | null> = {}) => {
  const sizes: Record<string, number | null> = { "beans.mp4": 4_000_000, "logo.png": 50_000, ...over };
  return { size: (uri: string) => (uri in sizes ? sizes[uri]! : null) };
};

async function approvedRun(id: string) {
  const d = deps(new ScriptedClient([ready, treatment, goodStoryboard, goodEdit]));
  const graph = buildDirectorGraph(d);
  const g1 = await graph.invoke(input, cfg(id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(id))) as DirectorStateType;
  const ctx = { recipes: d.recipes, skills, knowledge, run_id: id, model: "scripted", files: disk(), now: () => new Date("2026-10-24T00:00:00Z") };
  return { d, graph, g1, g2, done, ctx };
}
const refusal = (fn: () => unknown): string[] => {
  try { fn(); } catch (e) { if (e instanceof HandoffRefusedError) return e.reasons; throw e; }
  throw new Error("expected the handoff to be refused");
};
/** Recomputes both approvals so their hashes match whatever the state holds now. */
const forge = (s: DirectorStateType): ApprovalRecord[] => {
  const sb = { version: s.scenePlan!.version, hash: storyboardHash(s.treatmentDoc!, s.scenePlan!) };
  const at = "2026-10-24T00:00:00.000Z";
  const evidence_hash = currentEvidenceHash(s)!;
  return [
    ApprovalRecord.parse({ stage: "storyboard", plan_version: sb.version, storyboard_version: sb.version, plan_hash: sb.hash, evidence_hash, decision: "approved", notes: "", decided_at: at }),
    ApprovalRecord.parse({ stage: "edit_plan", plan_version: s.editPlan!.version, storyboard_version: sb.version, plan_hash: editPlanHash(sb, s.editPlan!), evidence_hash, decision: "approved", notes: "", decided_at: at }),
  ];
};

describe("Director handoff", () => {
  it("is built from the currently approved plans, carries what the Editor needs, and validates", async () => {
    const t = await approvedRun("h-ok");
    const h = buildHandoff(t.done, t.ctx);
    expect(DirectorHandoff.safeParse(h).success).toBe(true);
    expect(verifyHandoffIntegrity(h)).toEqual([]);
    expect(checkHandoff(h, t.ctx)).toEqual([]);
    expect(h.approved.storyboard).toEqual({ version: 1, hash: storyboardHash(t.done.treatmentDoc!, t.done.scenePlan!) });
    expect(h.approvals.storyboard).toMatchObject({ stage: "storyboard", decision: "approved", plan_version: 1 });
    expect(h.approvals.edit_plan).toMatchObject({ stage: "edit_plan", decision: "approved", plan_version: 1, storyboard_version: 1 });
    expect(h.assets.map((a) => a.asset_id).sort()).toEqual(["asset_beans", "asset_logo"]);
    // Only the grounded claim that a scene uses; the unsupported ones never reach the Editor.
    expect(h.claims).toEqual([{ claim: { claim_id: "C01", text: "Roasted weekly in small batches", brand_fact_id: "F01", kind: "factual", safe_alternative: null }, fact: input.facts[0], scene_ids: ["S02"] }]);
    expect(h.qa).toMatchObject({ target_duration_s: 12, aspect_ratio: "9:16", grounded_claim_ids: ["C01"], loudness_target_lufs: null });
    expect(h.qa.scene_spans).toEqual([{ scene_id: "S01", start: 0, end: 4 }, { scene_id: "S02", start: 4, end: 9 }, { scene_id: "S03", start: 9, end: 12 }]);
    expect(h.provenance.recipes.map((r) => r.recipe_id)).toEqual(["crossfade", "end-card-cta", "loudness-normalise", "pan-reframe", "slow-push-in"]);
    // A skill the library holds carries its real version; any other name (a skills-collection id such as a video-type playbook) is recorded as unknown, never with an invented version.
    for (const s of h.provenance.skills) {
      const [name, version] = s.split("@") as [string, string];
      let known = true; try { t.ctx.skills.get(name); } catch { known = false; }
      expect(known ? /^\d+\.\d+\.\d+$/.test(version) : version === "unknown", s).toBe(true);
    }
    expect(h.run).toEqual({ run_id: "h-ok", model: "scripted", recipe_library_mode: "draft" });
  });

  it("keeps every retrieved id with its source, so the run can be reproduced", async () => {
    const t = await approvedRun("h-prov");
    const h = buildHandoff(t.done, t.ctx);
    expect(h.provenance.retrieved.map((r) => r.id)).toEqual(t.done.citations);
    expect(h.provenance.retrieved.find((r) => r.id === "claims-discipline")).toEqual({ id: "claims-discipline", kind: "knowledge", source: "Digikon policy", quality: "A" });
    expect(h.provenance.retrieved.find((r) => r.id === "F01")).toMatchObject({ kind: "brand_fact", source: "brand sheet" });
    expect(h.provenance.retrieved.find((r) => r.id === "crossfade")).toMatchObject({ kind: "recipe", quality: "draft" });
    expect(h.provenance.retrieved.every((r) => r.kind !== "unknown")).toBe(true);
  });

  it("has a content hash that does not depend on when it was made or on key order", async () => {
    const t = await approvedRun("h-hash");
    const a = buildHandoff(t.done, t.ctx);
    const b = buildHandoff(t.done, { ...t.ctx, now: () => new Date("2027-01-01T00:00:00Z") });
    expect(b.content_hash).toBe(a.content_hash);
    expect(b.created_at).not.toBe(a.created_at);
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(handoffContentHash(reordered)).toBe(a.content_hash);
  });

  it("is refused while a gate is still open or an approval is missing", async () => {
    const t = await approvedRun("h-missing");
    expect(refusal(() => buildHandoff(t.g1 as DirectorStateType, t.ctx))).toEqual(expect.arrayContaining(['the Director run is "awaiting_approval", not approved', "the storyboard has not been approved"]));
    expect(refusal(() => buildHandoff(t.g2 as DirectorStateType, t.ctx))).toContain("the edit plan has not been approved");
    expect(refusal(() => buildHandoff({ ...t.done, approvals: [] }, t.ctx))).toEqual(["the storyboard has not been approved", "the edit plan has not been approved"]);
    expect(refusal(() => buildHandoff({ ...t.done, approvals: [t.done.approvals[0]!, { ...t.done.approvals[1]!, decision: "revision_requested", notes: "no" }] }, t.ctx)))
      .toContain("the latest edit-plan decision is a request for changes, not an approval");
    expect(refusal(() => buildHandoff({ ...t.done, approvals: [{ ...t.done.approvals[0]!, plan_hash: "bad" }, t.done.approvals[1]!] }, t.ctx)).some((r) => r.includes("malformed"))).toBe(true);
  });

  it("is refused when a plan changed after approval (hash) or its version moved on", async () => {
    const t = await approvedRun("h-stale");
    const edited = structuredClone(t.done);
    edited.editPlan!.uses[0]!.rationale = "edited after approval";
    expect(refusal(() => buildHandoff(edited, t.ctx))).toEqual(["the edit plan, or the storyboard it was built on, changed after approval (hash mismatch)"]);
    const bumped = structuredClone(t.done);
    bumped.scenePlan = { ...bumped.scenePlan!, version: 2 };
    expect(refusal(() => buildHandoff(bumped, t.ctx))).toContain("the approval is for storyboard version 1, but the current storyboard is version 2");
  });

  it("is refused for an invalid plan even when its approvals were forged to match", async () => {
    const t = await approvedRun("h-invalid");
    const bad = structuredClone(t.done);
    bad.editPlan!.uses[0]!.recipe_id = "invented-effect";
    bad.approvals = forge(bad);
    expect(refusal(() => buildHandoff(bad, t.ctx)).some((r) => r.startsWith("edit plan is not valid") && r.includes("unknown_recipe"))).toBe(true);
    const claim = structuredClone(t.done);
    claim.scenePlan!.scenes[1]!.claim_ids = ["C02"]; // no approved fact
    claim.approvals = forge(claim);
    expect(refusal(() => buildHandoff(claim, t.ctx)).some((r) => r.includes("unsupported_claim"))).toBe(true);
  });

  it("is refused on the Editor side when it was tampered with, or a recipe changed version since approval", async () => {
    const t = await approvedRun("h-tamper");
    const h = buildHandoff(t.done, t.ctx);
    const plan = structuredClone(h); plan.edit_plan.uses[0]!.params = { scale_end: 1.2 };
    expect(checkHandoff(plan, t.ctx)).toContain("the handoff content changed after it was made (content hash mismatch)");
    // Rehashing the tampered content is not enough: the plan no longer matches its approval.
    const rehashed = { ...plan, content_hash: handoffContentHash(plan) }; rehashed.handoff_id = `ho_${rehashed.content_hash.slice(0, 16)}`;
    expect(checkHandoff(rehashed, t.ctx)).toEqual(["the edit plan does not match its approval (hash mismatch)"]);
    expect(checkHandoff({ ...h, schema_version: "2.0.0" }, t.ctx)[0]).toMatch(/schema_version/);
    const drift = structuredClone(h); drift.provenance.recipes[0]!.version = "0.0.1";
    const redo = { ...drift, content_hash: handoffContentHash(drift) }; redo.handoff_id = `ho_${redo.content_hash.slice(0, 16)}`;
    expect(checkHandoff(redo, t.ctx)).toEqual([`recipe crossfade is now version ${t.d.recipes.get("crossfade")!.version}, but the plan was approved with 0.0.1`]);
  });

  it("refuses a re-hashed handoff whose derived sections no longer match the approved plans", async () => {
    const t = await approvedRun("h-derived");
    const h = buildHandoff(t.done, t.ctx);
    const rehash = (x: DirectorHandoff): DirectorHandoff => { const c = handoffContentHash(x); return { ...x, content_hash: c, handoff_id: `ho_${c.slice(0, 16)}` }; };
    const spans = structuredClone(h); spans.qa.scene_spans[0]!.end = 9;
    expect(checkHandoff(rehash(spans), t.ctx)).toContain("qa.scene_spans does not match the approved storyboard");
    const duration = structuredClone(h); duration.constraints.target_duration_s = 60;
    expect(checkHandoff(rehash(duration), t.ctx)).toContain("constraints do not match the project");
    const claims = structuredClone(h); claims.claims = []; claims.qa.grounded_claim_ids = [];
    // The audit still carries the fact, so the evidence matches; the grounded-claims list no longer matches the storyboard.
    expect(checkHandoff(rehash(claims), t.ctx)).toEqual(["claims do not match the claims the approved storyboard uses"]);
    const relinked = structuredClone(h); relinked.claims[0]!.scene_ids = ["S01"];
    expect(checkHandoff(rehash(relinked), t.ctx)).toContain("claims do not match the claims the approved storyboard uses");
    const assets = structuredClone(h); assets.assets = assets.assets.slice(1);
    expect(checkHandoff(rehash(assets), t.ctx).length).toBeGreaterThan(0);
    expect(checkHandoff(h, t.ctx)).toEqual([]);
  });

  it("records the approved assets and facts as an evidence hash in both approvals", async () => {
    const t = await approvedRun("h-ev");
    const [sb, ep] = t.done.approvals;
    expect(sb!.evidence_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(ep!.evidence_hash).toBe(sb!.evidence_hash);
    expect(sb!.evidence_hash).toBe(currentEvidenceHash(t.done));
    const h = buildHandoff(t.done, t.ctx);
    expect(checkHandoff(h, t.ctx)).toEqual([]); // the unchanged handoff still passes
  });

  it("is refused when a referenced asset is missing at handoff time", async () => {
    const t = await approvedRun("h-file-missing");
    expect(refusal(() => buildHandoff(t.done, { ...t.ctx, files: disk({ "beans.mp4": null }) }))).toEqual(["asset asset_beans is missing at handoff time (beans.mp4)"]);
    const h = buildHandoff(t.done, t.ctx);
    expect(checkHandoff(h, { ...t.ctx, files: disk({ "logo.png": null }) })).toEqual(["asset asset_logo is missing at handoff time (logo.png)"]);
  });

  it("is refused when an asset file or its metadata changed after analysis or approval", async () => {
    const t = await approvedRun("h-file-changed");
    expect(refusal(() => buildHandoff(t.done, { ...t.ctx, files: disk({ "beans.mp4": 3_999_999 }) })))
      .toEqual(["asset asset_beans changed on disk: it is 3999999 bytes, but 4000000 bytes were analysed"]);
    const meta = structuredClone(t.done); meta.assets[0]!.duration = 30;
    expect(refusal(() => buildHandoff(meta, t.ctx))).toContain("the assets or approved facts changed after the storyboard was approved (evidence hash mismatch)");
    const notes = structuredClone(t.done); notes.notes[0]!.usable_segments = [{ start: 0, end: 20 }, { start: 0, end: 1 }];
    expect(refusal(() => buildHandoff(notes, t.ctx))).toContain("the assets or approved facts changed after the storyboard was approved (evidence hash mismatch)");
    const unsized = structuredClone(t.done); unsized.assets[1]!.metadata = {};
    expect(refusal(() => buildHandoff(unsized, t.ctx))).toContain("asset asset_logo has no recorded file size, so its file cannot be verified");
  });

  it("refuses an asset outside the project's storage folder", async () => {
    const t = await approvedRun("h-root");
    expect(refusal(() => buildHandoff(t.done, { ...t.ctx, storageRoot: root("storage/sessions/abc") }))).toEqual(expect.arrayContaining([expect.stringMatching(/asset asset_beans is outside the project's storage folder/)]));
  });

  it("is refused when an approved fact's text changed after approval", async () => {
    const t = await approvedRun("h-fact");
    const changed = structuredClone(t.done); changed.facts[0]!.text = "Beans are roasted daily";
    expect(refusal(() => buildHandoff(changed, t.ctx))).toEqual([
      "the assets or approved facts changed after the storyboard was approved (evidence hash mismatch)",
      "the assets or approved facts changed after the edit plan was approved (evidence hash mismatch)",
    ]);
    const source = structuredClone(t.done); source.facts[0]!.source = "a blog";
    expect(refusal(() => buildHandoff(source, t.ctx)).length).toBe(2);
  });

  it("cannot legitimise changed facts or asset data by re-hashing the handoff", async () => {
    const t = await approvedRun("h-rehash-ev");
    const h = buildHandoff(t.done, t.ctx);
    const rehash = (x: DirectorHandoff): DirectorHandoff => { const c = handoffContentHash(x); return { ...x, content_hash: c, handoff_id: `ho_${c.slice(0, 16)}` }; };
    const fact = structuredClone(h); fact.claims[0]!.fact.text = "Roasted by award-winning experts";
    expect(checkHandoff(rehash(fact), t.ctx)).toEqual(["claims do not match the claims the approved storyboard uses"]); // differs from the fact in the audit
    const auditFact = structuredClone(h); auditFact.claims_audit[0] = { ...auditFact.claims_audit[0]!, fact: { ...auditFact.claims_audit[0]!.fact!, text: "Roasted by award-winning experts" } };
    expect(checkHandoff(rehash(auditFact), t.ctx)).toEqual(expect.arrayContaining(["the assets or facts in the handoff are not the ones that were approved (evidence hash mismatch)"]));
    const asset = structuredClone(h); asset.assets[0]!.duration = 60;
    expect(checkHandoff(rehash(asset), t.ctx)).toContain("the assets or facts in the handoff are not the ones that were approved (evidence hash mismatch)");
    const uri = structuredClone(h); uri.assets[0]!.uri = "other.mp4";
    expect(checkHandoff(rehash(uri), { ...t.ctx, files: disk({ "other.mp4": 4_000_000 }) })).toContain("the assets or facts in the handoff are not the ones that were approved (evidence hash mismatch)");
    const notes = structuredClone(h); notes.asset_notes[0]!.uncertain = [];
    expect(checkHandoff(rehash(notes), t.ctx)).toContain("the assets or facts in the handoff are not the ones that were approved (evidence hash mismatch)");
    // A record without an evidence hash is unverified, not trusted.
    const legacy = structuredClone(h); delete (legacy.approvals.storyboard as { evidence_hash?: string }).evidence_hash;
    expect(checkHandoff(rehash(legacy), t.ctx)).toContain("the storyboard approval carries no evidence hash, so its assets and facts cannot be verified");
    // Editing the evidence hash inside the handoff as well is caught when the Director's own records are supplied.
    const both = structuredClone(auditFact); both.claims[0]!.fact.text = "Roasted by award-winning experts"; // the claim, the audit and the evidence hash all agree on the forged fact
    const forged = currentEvidenceHash({ ...t.done, facts: [{ ...t.done.facts[0]!, text: "Roasted by award-winning experts" }] })!;
    both.approvals.storyboard.evidence_hash = forged; both.approvals.edit_plan.evidence_hash = forged;
    expect(checkHandoff(rehash(both), t.ctx)).toEqual([]); // internally consistent: a hash is not a signature
    expect(checkHandoff(rehash(both), { ...t.ctx, approvals: t.done.approvals })).toEqual(["the approval records in the handoff are not the Director's recorded approvals"]);
  });

  it("leaves the Director's approval, claim and plan checks as they were", async () => {
    // A change request after the handoff point makes a new version that has no approval, so no handoff can be built from it.
    const d = deps(new ScriptedClient([ready, treatment, goodStoryboard, goodEdit, goodEdit]));
    const graph = buildDirectorGraph(d);
    await graph.invoke(approveCurrent(await graph.invoke(input, cfg("h-rev"))), cfg("h-rev"));
    const rev = (await graph.invoke(gateDecision("edit_plan", 1, "revision_requested", "softer"), cfg("h-rev"))) as DirectorStateType;
    expect(rev.editPlan!.version).toBe(2);
    expect(refusal(() => buildHandoff(rev, { recipes: d.recipes, skills, run_id: "x", model: "scripted" }))).toContain("the latest edit-plan decision is a request for changes, not an approval");
  });
});

// ---------- Editor boundary ----------

function operationsFor(h: DirectorHandoff, recipes: ReturnType<typeof deps>["recipes"]): EditorOperation[] {
  return h.edit_plan.uses.map((u, i) => {
    const scene = h.storyboard.scenes.find((s) => s.scene_id === u.scene_id)!;
    const recipe = recipes.get(u.recipe_id)!;
    return {
      operation_id: `E${String(i + 1).padStart(2, "0")}`, target_scene_id: u.scene_id, operation_type: recipe.operation_type,
      parameters: resolveParams(recipe, u.params), preconditions: [], expected_result: u.rationale, validation_status: "valid",
      source_use_id: u.use_id, recipe_id: u.recipe_id, recipe_version: recipe.version, asset_ids: scene.asset_ids,
      timing: { start_s: scene.start_time, duration_s: scene.duration_seconds }, caption: null, audio_cues: scene.audio_cues,
    };
  });
}
function outputFor(h: DirectorHandoff, ops: EditorOperation[], over: Record<string, unknown> = {}) {
  return {
    schema_version: EDITOR_SCHEMA_VERSION, handoff_schema_version: h.schema_version, handoff_id: h.handoff_id, handoff_content_hash: h.content_hash, approved: h.approved,
    status: "ready", operations: ops, validation: { ok: true, issues: [] }, conflicts: [], revision_requests: [],
    provenance: { skills: ["editing-director@0.1.0"], recipes: h.provenance.recipes.map((r) => `${r.recipe_id}@${r.version}`), retrievals: [] },
    execution: noExecution(ops),
    ...over,
  };
}

describe("Editor input and output contracts", () => {
  it("accepts a well-formed input and output, and rejects a ready result that hides conflicts or revisions", async () => {
    const t = await approvedRun("e-schema");
    const h = buildHandoff(t.done, t.ctx);
    expect(EditorInput.safeParse({ schema_version: EDITOR_SCHEMA_VERSION, handoff: h, skills: ["editing-director@0.1.0"], retrieval_scope: "editor" }).success).toBe(true);
    expect(EditorInput.safeParse({ schema_version: EDITOR_SCHEMA_VERSION, handoff: h, skills: [], retrieval_scope: "director" }).success).toBe(false);
    const ops = operationsFor(h, t.d.recipes);
    expect(EditorOutput.safeParse(outputFor(h, ops)).success).toBe(true);
    const conflict = { conflict_id: "K1", kind: "knowledge_missing", description: "no verified loudness target", evidence: [] };
    expect(EditorOutput.safeParse(outputFor(h, ops, { conflicts: [conflict] })).success).toBe(false); // ready with a conflict
    expect(EditorOutput.safeParse(outputFor(h, ops, { status: "blocked", conflicts: [conflict] })).success).toBe(true);
    const req = { target: "storyboard", scene_ids: ["S01"], reason: "the clip is too short", requires_reapproval: true };
    expect(EditorOutput.safeParse(outputFor(h, ops, { revision_requests: [req] })).success).toBe(false); // ready with a revision
    expect(EditorOutput.safeParse(outputFor(h, ops, { status: "needs_director_revision", revision_requests: [{ ...req, requires_reapproval: false }] })).success).toBe(false);
    expect(EditorOutput.safeParse(outputFor(h, ops, { status: "needs_director_revision", revision_requests: [req] })).success).toBe(true);
  });

  it("accepts a result that implements exactly the approved plan", async () => {
    const t = await approvedRun("e-ok");
    const h = buildHandoff(t.done, t.ctx);
    expect(checkEditorOutput(outputFor(h, operationsFor(h, t.d.recipes)), h, t.ctx)).toEqual({ ok: true, issues: [], requires_reapproval: false });
  });

  it("refuses silent changes to the approved plan and results bound to another handoff", async () => {
    const t = await approvedRun("e-drift");
    const h = buildHandoff(t.done, t.ctx);
    const ops = operationsFor(h, t.d.recipes);
    const changed = structuredClone(ops); changed[0]!.parameters = { ...changed[0]!.parameters, scale_end: 1.15 };
    const r1 = checkEditorOutput(outputFor(h, changed), h, t.ctx);
    expect(r1.ok).toBe(false);
    expect(r1.requires_reapproval).toBe(true);
    expect(r1.issues).toContain("operation E01: parameters differ from the approved U01 without a revision request");

    const dropped = checkEditorOutput(outputFor(h, ops.slice(1)), h, t.ctx);
    expect(dropped.issues).toContain("approved recipe use U01 has no operation and no reported conflict");

    const foreign = structuredClone(ops); foreign[0]!.asset_ids = ["asset_logo"];
    expect(checkEditorOutput(outputFor(h, foreign), h, t.ctx).issues).toContain("operation E01: asset asset_logo is not approved for S01");
    const late = structuredClone(ops); late[0]!.timing = { start_s: 3, duration_s: 4 };
    expect(checkEditorOutput(outputFor(h, late), h, t.ctx).issues.some((i) => i.includes("runs outside S01"))).toBe(true);
    const invented = structuredClone(ops); invented[0]!.recipe_id = "spin-3d";
    expect(checkEditorOutput(outputFor(h, invented), h, t.ctx).ok).toBe(false);
    expect(checkEditorOutput(outputFor(h, ops, { handoff_content_hash: "0".repeat(64) }), h, t.ctx).issues).toContain("the result was made from a different handoff");
  });

  it("refuses duplicate operations and retrievals made outside the Editor's scope", async () => {
    const t = await approvedRun("e-dup");
    const h = buildHandoff(t.done, t.ctx);
    const ops = operationsFor(h, t.d.recipes);
    const dupId = structuredClone(ops); dupId[1]!.operation_id = dupId[0]!.operation_id;
    expect(checkEditorOutput(outputFor(h, dupId), h, t.ctx).issues).toContain("operation E01: operation_id is used more than once");
    const twice = [...ops, { ...ops[0]!, operation_id: "E99" }];
    expect(checkEditorOutput(outputFor(h, twice), h, t.ctx).issues).toContain("approved recipe use U01 is implemented by more than one operation");
    const bad = { agent: "director", collection: "ad_playbooks", query: "claims", filter: {}, returned_ids: ["claims-discipline"] };
    const r = checkEditorOutput(outputFor(h, ops, { provenance: { skills: [], recipes: [], retrievals: [bad] } }), h, t.ctx);
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual(expect.arrayContaining(["retrieval 1 was made as director, not the editor", "retrieval 1 read ad_playbooks, which is outside the Editor's scope"]));
  });

  it("routes an explicit change to the Director for reapproval, and lets unsupported work be reported instead of invented", async () => {
    const t = await approvedRun("e-rev");
    const h = buildHandoff(t.done, t.ctx);
    const ops = operationsFor(h, t.d.recipes);
    const changed = structuredClone(ops); changed[0]!.parameters = { ...changed[0]!.parameters, scale_end: 1.15 };
    const req = { target: "edit_plan", scene_ids: ["S01"], reason: "a stronger push reads better at this size", requires_reapproval: true };
    const r = checkEditorOutput(outputFor(h, changed, { status: "needs_director_revision", revision_requests: [req] }), h, t.ctx);
    expect(r).toEqual({ ok: true, issues: [], requires_reapproval: true });

    // An operation the Editor cannot do is a reported conflict, not a dropped or improvised step.
    const conflict = { conflict_id: "K1", kind: "unsupported_operation", use_id: "U05", scene_id: "S03", description: "no renderer implements loudness-normalise yet", evidence: ["recipe implementation_ref has no template"] };
    const blocked = checkEditorOutput(outputFor(h, ops.filter((o) => o.source_use_id !== "U05"), { status: "blocked", conflicts: [conflict] }), h, t.ctx);
    expect(blocked).toEqual({ ok: true, issues: [], requires_reapproval: false });
  });
});
