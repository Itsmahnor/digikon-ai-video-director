import { describe, expect, it } from "vitest";
import { EDITOR_SCHEMA_VERSION, Project, handoffContentHash, storyboardHash, type DirectorHandoff, type EditorOperation } from "@digikon/contracts";
import { resolveParams } from "@digikon/recipes";
import {
  HandoffRefusedError, ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, checkEditorOutput, checkHandoff, checkRenderable,
  gateDecision, readinessOf, requiredOperations, secretFindings, type DirectorStateType,
} from "./index.js";
import { cfg, deps, knowledge, noExecution, root } from "./fixtures.js";

// The latest real run: a 30-second, 16:9 online-learning explainer with six scenes and no supplied files.
const project = Project.parse({
  project_id: "learn1", owner_id: "console-user", brief: "30 second SaaS explainer for an online learning platform.", objective: "Explain the platform",
  audience: "Students", platform: "YouTube", aspect_ratio: "16:9", target_duration: 30,
});
const input = { project, assets: [], facts: [] };
const ready = { status: "ready", questions: [] };
const skills = new SkillLibrary(root("skills"));

const concept = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ claim_id: id, text, brand_fact_id: null, kind: "illustrative", safe_alternative: "Show it on screen without wording.", ...extra });
const treatment = (claims: unknown[]) => ({
  logline: "One calm place to learn", hook: "Too many tabs", tone: "modern",
  beats: [4, 5, 4, 6, 6, 5].map((s, i) => ({ beat: `Beat ${i + 1}`, purpose: "p", approx_seconds: s })), cta: "Start learning", claims,
});
const gfx = (need: string, over: Record<string, unknown> = {}) => ({ need, kind: "graphics", availability: "generate_graphics", ...over });
const placeholder = (need: string, kind: string) => gfx(need, { kind, placeholder: true });
const scene = (id: string, dur: number, extra: Record<string, unknown> = {}) => ({
  scene_id: id, purpose: "p", duration_seconds: dur, asset_ids: [], required_assets: [gfx("Animated graphics")], transition_out: "cut",
  shot: { shot_size: "wide", camera_motion: "static", visual_action: "Animated desktop view" }, ...extra,
});
const storyboard = (over: Record<string, Record<string, unknown>> = {}) => ({
  scenes: [
    scene("S01", 4, { overlay: { text: "Too many tabs.", safe_area: "platform_safe" }, ...over["S01"] }),
    scene("S02", 5, { overlay: { text: "Where was I?", safe_area: "platform_safe" }, ...over["S02"] }),
    scene("S03", 4, { transition_out: "crossfade", claim_ids: ["C03"], required_assets: [placeholder("Brand logo card", "logo")], unresolved: [{ kind: "placeholder", note: "No logo supplied: a generic wordmark card is shown." }], ...over["S03"] }),
    scene("S04", 6, { claim_ids: ["C01"], required_assets: [placeholder("Learning dashboard (graphics only)", "ui_screenshot")], unresolved: [{ kind: "placeholder", note: "No product screens supplied: an illustrative dashboard is shown." }], voiceover: "Learning that adapts to you.", ...over["S04"] }),
    scene("S05", 6, { transition_out: "crossfade", claim_ids: ["C02"], ...over["S05"] }),
    scene("S06", 5, { transition_out: "dip_to_black", overlay: { text: "Start learning - link below.", safe_area: "platform_safe" }, ...over["S06"] }),
  ],
});
const use = (n: number, scene_id: string, recipe_id: string) => ({ use_id: `U0${n}`, scene_id, recipe_id, params: {}, rationale: "fits the beat" });
const edit = { uses: [use(1, "S01", "text-fade-up"), use(2, "S02", "text-word-stagger"), use(3, "S03", "crossfade"), use(4, "S05", "crossfade"), use(5, "S06", "end-card-cta"), use(6, "S06", "loudness-normalise")] };
const claims = [concept("C01", "The platform offers personalized learning"), concept("C02", "The platform offers progress tracking"), concept("C03", "The platform brings resources together")];

function run(answers: unknown[], id: string) {
  const d = deps(new ScriptedClient(answers));
  const graph = buildDirectorGraph(d);
  return { d, graph, run: (c: Parameters<typeof graph.invoke>[0]) => graph.invoke(c, cfg(id)), ctx: { recipes: d.recipes, skills, knowledge, run_id: id, model: "scripted" } };
}
async function approved(id: string, sb = storyboard(), tr = treatment(claims)) {
  const t = run([ready, tr, sb, edit], id);
  const g1 = await t.run(input);
  const g2 = await t.run(approveCurrent(g1));
  const done = (await t.run(approveCurrent(g2))) as DirectorStateType;
  return { ...t, g1, g2, done };
}
const refusal = (fn: () => unknown): string[] => {
  try { fn(); } catch (e) { if (e instanceof HandoffRefusedError) return e.reasons; throw e; }
  throw new Error("expected the handoff to be refused");
};
const rehash = (x: DirectorHandoff): DirectorHandoff => { const c = handoffContentHash(x); return { ...x, content_hash: c, handoff_id: `ho_${c.slice(0, 16)}` }; };

describe("the six-scene, 30-second storyboard through the Director", () => {
  it("is fully timed, with end times and production methods assigned by code", async () => {
    const t = await approved("p-time");
    const scenes = t.done.scenePlan!.scenes;
    expect(scenes).toHaveLength(6);
    expect(scenes.map((s) => [s.start_time, s.end_time, s.duration_seconds])).toEqual([[0, 4, 4], [4, 9, 5], [9, 13, 4], [13, 19, 6], [19, 25, 6], [25, 30, 5]]);
    expect(scenes.reduce((a, s) => a + s.duration_seconds, 0)).toBe(30);
    expect(scenes.every((s) => s.production_method === "graphics")).toBe(true); // nothing is supplied, so every scene is built as graphics
    expect(scenes[3]!.voiceover).toBe("Learning that adapts to you.");
    expect(scenes[3]!.unresolved[0]).toMatchObject({ kind: "placeholder" });
  });

  it("escalates instead of accepting a runtime that is not 30 seconds", async () => {
    const short = storyboard({ S06: { duration_seconds: 4 } });
    const t = run([ready, treatment(claims), short, short], "p-short");
    const out = await t.run(input);
    expect(out.status).toBe("escalated");
    expect(out.escalation!.evidence.join(" ")).toContain("under_duration");
  });

  it("identifies an unsupported factual claim and refuses to show it", async () => {
    const factual = [concept("C01", "Personalized learning", { kind: "factual" }), claims[1], claims[2]]; // asserted as fact, no evidence
    const t = run([ready, treatment(factual), storyboard(), storyboard()], "p-factual");
    const out = await t.run(input);
    expect(out.status).toBe("escalated");
    expect(out.escalation!.evidence.join(" ")).toMatch(/S04: unsupported_claim - claim C01 is an unsupported factual claim/);
  });
});

describe("the production handoff", () => {
  it("carries the claims audit, asset feasibility, required operations and readiness", async () => {
    const t = await approved("p-handoff");
    const h = buildHandoff(t.done, t.ctx);
    expect(h.schema_version).toBe("1.3.0");
    expect(h.claims_audit.map((e) => [e.claim_id, e.status, e.scene_ids])).toEqual([["C01", "illustrative", ["S04"]], ["C02", "illustrative", ["S05"]], ["C03", "illustrative", ["S03"]]]);
    expect(h.claims).toEqual([]); // nothing is grounded in a supplied fact
    expect(h.asset_feasibility.counts).toEqual({ supplied: 0, generate_graphics: 6, needs_external: 0, missing_blocking: 0 });
    expect(h.asset_feasibility.blockers).toEqual([]); // graphics-led scenes are not blocked by missing footage
    expect(h.asset_feasibility.warnings).toHaveLength(4); // two placeholders and their two unresolved notes
    expect(h.required_operations.map((o) => [o.use_id, o.recipe_id, o.operation_type, o.recipe_status, o.evidence])).toEqual([
      ["U01", "text-fade-up", "overlay_text", "draft", "none"], ["U02", "text-word-stagger", "overlay_text", "draft", "none"],
      ["U03", "crossfade", "concat", "draft", "none"], ["U04", "crossfade", "concat", "draft", "none"],
      ["U05", "end-card-cta", "render_graphics_scene", "draft", "none"], ["U06", "loudness-normalise", "mix_audio", "draft", "none"],
    ]);
    expect(h.required_operations[0]).toMatchObject({ implementation_ref: "remotion/text-fade-up", renderers: ["remotion"] });
    expect(h.qa).toMatchObject({ target_duration_s: 30, aspect_ratio: "16:9" });
    expect("owner_id" in h.project).toBe(false);
    expect(checkHandoff(h, t.ctx)).toEqual([]);
  });

  it("never calls draft recipes production-ready", async () => {
    const t = await approved("p-draft");
    const h = buildHandoff(t.done, t.ctx);
    expect(h.readiness.production_ready).toBe(false);
    expect(h.readiness.blockers).toEqual([
      "recipe crossfade is draft: no review evidence", "recipe end-card-cta is draft: no review evidence", "recipe loudness-normalise is draft: no review evidence",
      "recipe text-fade-up is draft: no review evidence", "recipe text-word-stagger is draft: no review evidence",
    ]);
    expect(h.readiness.warnings).toEqual(expect.arrayContaining([
      'S04 show claim C01 ("The platform offers personalized learning") as an illustrative concept, not a verified product fact',
      "the recipe library is in draft mode (development only)",
    ]));
    // Only recorded review evidence changes that: with every operation evidenced and no blockers elsewhere, the plan is ready.
    const evidenced = h.required_operations.map((o) => ({ ...o, recipe_status: "reviewed" as const, evidence: "review_record" as const }));
    expect(readinessOf({ operations: evidenced, feasibility: h.asset_feasibility, audit: h.claims_audit, recipe_library_mode: "reviewed" }).production_ready).toBe(true);
  });

  it("catches readiness, audit, feasibility or operations rewritten and re-hashed", async () => {
    const t = await approved("p-forged");
    const h = buildHandoff(t.done, t.ctx);
    const ready = structuredClone(h); ready.readiness = { production_ready: true, blockers: [], warnings: [] };
    expect(checkHandoff(rehash(ready), t.ctx)).toEqual(["readiness does not match what the plans, assets, claims and recipes show"]);
    const reviewed = structuredClone(h); reviewed.required_operations[0] = { ...reviewed.required_operations[0]!, recipe_status: "reviewed", evidence: "review_record" };
    expect(checkHandoff(rehash(reviewed), t.ctx)).toEqual(expect.arrayContaining(["required_operations do not match the recipe library (a recipe's status, operation type or implementation changed)"]));
    const audit = structuredClone(h); audit.claims_audit[0] = { ...audit.claims_audit[0]!, status: "unsupported", usable_in_scenes: false };
    expect(checkHandoff(rehash(audit), t.ctx)).toContain("claims_audit does not match the treatment, storyboard and approved facts");
    const feas = structuredClone(h); feas.asset_feasibility = { ...feas.asset_feasibility, warnings: [] };
    expect(checkHandoff(rehash(feas), t.ctx)).toContain("asset_feasibility does not match the storyboard and its assets");
  });

  it("is refused while the plan needs material nobody supplied", async () => {
    const needs = { S04: { required_assets: [{ need: "A student closing a laptop", kind: "footage", availability: "needs_external", fallback: "End on the logo card alone" }], unresolved: [] } };
    const t = await approved("p-external", storyboard(needs));
    expect(t.done.status).toBe("approved"); // the humans approved what they saw, blocker included
    expect(checkRenderable(t.done, t.ctx).ok).toBe(false);
    expect(refusal(() => buildHandoff(t.done, t.ctx))).toEqual([
      'production is blocked: S04 needs footage "A student closing a laptop" that is not supplied (alternative: End on the logo card alone).',
    ]);
  });

  it("is refused for stale or missing approval evidence, and a changed storyboard invalidates the edit-plan approval", async () => {
    const t = await approved("p-stale");
    expect(refusal(() => buildHandoff({ ...t.done, approvals: [] }, t.ctx))).toEqual(["the storyboard has not been approved", "the edit plan has not been approved"]);
    expect(refusal(() => buildHandoff({ ...t.done, approvals: [t.done.approvals[0]!] }, t.ctx))).toEqual(["the edit plan has not been approved"]);
    const changed = structuredClone(t.done);
    changed.scenePlan!.scenes[1]!.purpose = "something the reviewer never saw";
    expect(refusal(() => buildHandoff(changed, t.ctx))).toEqual([
      "the storyboard changed after it was approved (hash mismatch)",
      "the edit plan, or the storyboard it was built on, changed after approval (hash mismatch)",
    ]);
    const bumped = structuredClone(t.done); bumped.scenePlan = { ...bumped.scenePlan!, version: 2 };
    expect(refusal(() => buildHandoff(bumped, t.ctx)).join(" ")).toContain("the approval is for storyboard version 1, but the current storyboard is version 2");
  });

  it("drops the edit plan and its approval when the storyboard is revised, so no handoff exists until both are approved again", async () => {
    const t = run([ready, treatment(claims), storyboard(), storyboard(), edit], "p-revise");
    const g1 = await t.run(input);
    const again = (await t.run(gateDecision("storyboard", 1, "revision_requested", "Shorter opening"))) as DirectorStateType;
    expect(again.scenePlan!.version).toBe(2);
    expect(again.editPlan).toBeNull();
    expect(refusal(() => buildHandoff(again, t.ctx)).join(" ")).toContain("the latest storyboard decision is a request for changes, not an approval");
    const g2 = await t.run(approveCurrent(again));
    const done = (await t.run(approveCurrent(g2))) as DirectorStateType;
    const h = buildHandoff(done, t.ctx);
    expect(h.approved.storyboard.version).toBe(2);
    expect(g1.scenePlan!.version).toBe(1);
    expect(h.approved.storyboard.hash).toBe(storyboardHash(done.treatmentDoc!, done.scenePlan!));
    expect(h.approved.storyboard.hash).not.toBe(storyboardHash(g1.treatmentDoc!, g1.scenePlan!)); // version 1 had its own hash and its approval never existed
  });
});

describe("secrets and private data", () => {
  it("refuses a handoff that contains something that looks like an API key, without repeating it", async () => {
    const key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv";
    const bad = storyboard({ S01: { overlay: { text: `Use ${key}`, safe_area: "full" } } });
    const t = await approved("p-secret", bad);
    const reasons = refusal(() => buildHandoff(t.done, t.ctx));
    expect(reasons).toEqual(["the handoff contains what looks like an Anthropic API key (not shown); remove it from the brief, facts or file names"]);
    expect(JSON.stringify(reasons)).not.toContain(key);
  });

  it("finds credentials and the configured key, and ignores ordinary text", () => {
    expect(secretFindings("Start learning today. Password reset is easy.")).toEqual([]);
    expect(secretFindings("api_key: abcdefghijklmnop1234")).toHaveLength(1);
    expect(secretFindings("-----BEGIN RSA PRIVATE KEY-----")).toEqual(["the handoff contains what looks like a private key (not shown); remove it from the brief, facts or file names"]);
    const old = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "configured-key-value-123";
    try { expect(secretFindings("the text includes configured-key-value-123 here")).toEqual(["the handoff contains the configured API key (not shown)"]); }
    finally { if (old === undefined) delete process.env["ANTHROPIC_API_KEY"]; else process.env["ANTHROPIC_API_KEY"] = old; }
  });
});

describe("Editor operations and the recipe's operation type", () => {
  const opsFor = (h: DirectorHandoff, t: Awaited<ReturnType<typeof approved>>): EditorOperation[] =>
    h.edit_plan.uses.map((u, i) => {
      const scene = h.storyboard.scenes.find((s) => s.scene_id === u.scene_id)!;
      const r = t.d.recipes.get(u.recipe_id)!;
      return {
        operation_id: `E0${i + 1}`, target_scene_id: u.scene_id, operation_type: r.operation_type, parameters: resolveParams(r, u.params), preconditions: [], expected_result: u.rationale,
        validation_status: "valid", source_use_id: u.use_id, recipe_id: u.recipe_id, recipe_version: r.version, asset_ids: scene.asset_ids,
        timing: { start_s: scene.start_time, duration_s: scene.duration_seconds }, caption: null, audio_cues: scene.audio_cues,
      };
    });
  const output = (h: DirectorHandoff, operations: EditorOperation[]) => ({
    schema_version: EDITOR_SCHEMA_VERSION, handoff_schema_version: h.schema_version, handoff_id: h.handoff_id, handoff_content_hash: h.content_hash, approved: h.approved,
    status: "ready", operations, validation: { ok: true, issues: [] }, conflicts: [], revision_requests: [],
    provenance: { skills: [], recipes: h.required_operations.map((o) => `${o.recipe_id}@${o.recipe_version}`), retrievals: [] },
    execution: noExecution(operations),
  });

  it("accepts operations whose type is the one their recipe declares, and rejects any other", async () => {
    const t = await approved("p-ops");
    const h = buildHandoff(t.done, t.ctx);
    const ops = opsFor(h, t);
    expect(requiredOperations(h.edit_plan, t.d.recipes).map((o) => o.operation_type)).toEqual(ops.map((o) => o.operation_type));
    expect(checkEditorOutput(output(h, ops), h, t.ctx)).toEqual({ ok: true, issues: [], requires_reapproval: false });
    const wrong = structuredClone(ops); wrong[0]!.operation_type = "mix_audio";
    const r = checkEditorOutput(output(h, wrong), h, t.ctx);
    expect(r.ok).toBe(false);
    expect(r.issues).toContain("operation E01: operation_type mix_audio does not match recipe text-fade-up, which becomes a overlay_text operation");
  });
});
