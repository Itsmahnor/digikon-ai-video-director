import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Asset, DirectorHandoff, EditorOutput, handoffContentHash, type EditorOperation, type Recipe,
} from "@digikon/contracts";
import { AGENT_SCOPES, KeywordRetriever, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, resolveParams } from "@digikon/recipes";
import {
  EDITOR_SKILLS, NO_RENDERERS, RunStore, ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, checkEditorOutput, planEditorWork,
  runEditor, type DirectorStateType, type EditorDeps, type RendererRegistry,
} from "./index.js";
import { cfg, deps, knowledge, learnEdit, learnInput, learnStoryboard, learnTreatment, recipes as allRecipes, root } from "./fixtures.js";

const ready = { status: "ready", questions: [] };
const editorSkills = new SkillLibrary(root("skills/editor"));
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** Runs the Director to both approvals on the learning explainer and returns the frozen handoff. */
async function approved(id: string, opts: { storyboard?: ReturnType<typeof learnStoryboard>; library?: RecipeLibrary; store?: RunStore } = {}) {
  const base = deps(new ScriptedClient([ready, learnTreatment(), opts.storyboard ?? learnStoryboard(), learnEdit]));
  const d = {
    ...base,
    ...(opts.library ? { recipes: opts.library, retriever: new KeywordRetriever([...recipeDocs([...allRecipes].map((r) => opts.library!.get(r.recipe_id)!)), ...knowledge]) } : {}),
    ...(opts.store ? { approvalLog: opts.store.approvalLog(id) } : {}),
  };
  const graph = buildDirectorGraph(d);
  const g1 = await graph.invoke(learnInput, cfg(id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(id))) as DirectorStateType;
  const handoff = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: id, model: "scripted" });
  const editor: EditorDeps = { recipes: d.recipes, skills: editorSkills, retriever: d.retriever };
  return { d, done, handoff, editor };
}
const rehash = (x: DirectorHandoff): DirectorHandoff => { const c = handoffContentHash(x); return { ...x, content_hash: c, handoff_id: `ho_${c.slice(0, 16)}` }; };
const must = async (raw: unknown, editor: EditorDeps) => {
  const r = await runEditor(raw, editor);
  if (!r.ok) throw new Error(`rejected: ${r.reasons.join("; ")}`);
  return r;
};
/** Every implementation_ref registered with a renderer the recipe supports: an explicit test fixture, not a real renderer. */
const fakeRegistry = (lib: RecipeLibrary): RendererRegistry => ({
  template: (ref) => {
    const r = allRecipes.map((x) => lib.get(x.recipe_id)!).find((x) => x.implementation_ref === ref);
    return r ? { renderer: r.compatibility.renderers[0]! } : null;
  },
});
const deepFreeze = <T,>(o: T): T => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

describe("the Editor on a valid approved handoff", () => {
  it("produces structured output: one operation per approved use, typed by its recipe, timed inside its scene", async () => {
    const t = await approved("e-ok");
    const r = await must(t.handoff, t.editor);
    const o = r.output;
    expect(EditorOutput.safeParse(o).success).toBe(true); // 1. valid structured output
    expect(o).toMatchObject({ status: "ready", handoff_id: t.handoff.handoff_id, handoff_content_hash: t.handoff.content_hash, approved: t.handoff.approved, conflicts: [], revision_requests: [] });
    expect(o.operations.map((x) => [x.operation_id, x.source_use_id, x.recipe_id, x.operation_type, x.target_scene_id])).toEqual([
      ["E01", "U01", "text-fade-up", "overlay_text", "S01"], ["E02", "U02", "text-word-stagger", "overlay_text", "S02"],
      ["E03", "U03", "crossfade", "concat", "S03"], ["E04", "U04", "crossfade", "concat", "S05"],
      ["E05", "U05", "end-card-cta", "render_graphics_scene", "S06"], ["E06", "U06", "loudness-normalise", "mix_audio", "S06"],
    ]);
    expect(o.validation).toEqual({ ok: true, issues: [] }); // 2. passes contract validation
    expect(o.operations.every((x) => x.validation_status === "valid")).toBe(true);
    expect(checkEditorOutput(o, t.handoff, t.editor)).toEqual({ ok: true, issues: [], requires_reapproval: false });
    expect(r.check).toEqual({ ok: true, issues: [], requires_reapproval: false });
  });

  it("keeps the approved plan: parameters, scene timing, wording and assets come from it unchanged", async () => {
    const t = await approved("e-keep");
    const frozen = deepFreeze(structuredClone(t.handoff)); // any attempt to edit the handoff would throw
    const { output: o } = await must(frozen, t.editor);
    expect(JSON.stringify(frozen)).toBe(JSON.stringify(t.handoff));
    for (const op of o.operations) {
      const use = t.handoff.edit_plan.uses.find((u) => u.use_id === op.source_use_id)!;
      const scene = t.handoff.storyboard.scenes.find((s) => s.scene_id === use.scene_id)!;
      expect(op.parameters).toEqual(resolveParams(t.editor.recipes.get(use.recipe_id)!, use.params));
      expect(op.timing.start_s).toBeGreaterThanOrEqual(scene.start_time);
      expect(op.timing.start_s + op.timing.duration_s).toBeLessThanOrEqual(scene.start_time + scene.duration_seconds + 1e-9);
      if (op.caption) expect(op.caption.text).toBe(scene.overlay!.text); // the approved wording, exactly
    }
    const at = (id: string) => o.operations.find((x) => x.operation_id === id)!;
    expect(at("E01").timing).toEqual({ start_s: 0, duration_s: 4 });
    expect(at("E01").caption).toEqual({ text: "Too many tabs.", start_s: 0.2, end_s: 4 }); // text-fade-up's own delay_s
    expect(at("E03").timing.duration_s).toBeCloseTo(0.6, 9); // a crossfade sits at the tail of the outgoing scene
    expect(at("E03").timing.start_s).toBeCloseTo(12.4, 9);
    expect(at("E05").caption?.text).toBe("Start learning - link below.");
    expect(at("E06").caption).toBeNull();
  });

  it("records the skills, recipes and Editor-scoped retrievals it relied on", async () => {
    const t = await approved("e-prov");
    const { output: o } = await must(t.handoff, t.editor);
    expect(o.provenance.skills).toEqual(expect.arrayContaining(["core-contract@0.1.0", "final-video-qa@0.1.0", "transitions-scene-assembly@0.1.0", "captions-typography@0.1.0"]));
    expect(o.provenance.skills.every((s) => EDITOR_SKILLS.includes(s.split("@")[0] as never))).toBe(true);
    expect(o.provenance.recipes).toEqual(["crossfade@0.1.0", "end-card-cta@0.1.0", "loudness-normalise@0.1.0", "text-fade-up@0.1.0", "text-word-stagger@0.1.0"]);
    expect(o.provenance.retrievals.length).toBeGreaterThan(0);
    for (const rec of o.provenance.retrievals) {
      expect(rec.agent).toBe("editor");
      expect(AGENT_SCOPES.editor.collections).toContain(rec.collection);
      expect(["ad_playbooks", "brand_product_facts"]).not.toContain(rec.collection); // the Director's knowledge, never the Editor's
    }
    expect(o.provenance.retrievals.flatMap((x) => x.returned_ids)).toEqual(expect.arrayContaining(["j-and-l-cuts"]));
  });
});

describe("states that must not be conflated", () => {
  it("is contract-valid but not executable, and never rendered, while no renderer is registered", async () => {
    const t = await approved("e-states");
    const { output: o } = await must(t.handoff, t.editor);
    expect(o.status).toBe("ready");
    expect(o.validation.ok).toBe(true);
    expect(o.execution).toMatchObject({ rendered: false, executable: false, production_executable: false });
    expect(o.execution.operations.every((x) => !x.executable && x.renderer === null)).toBe(true);
    expect(o.execution.operations[0]!.blockers).toEqual(["no template is registered for remotion/text-fade-up, and no remotion renderer is available"]);
    expect(o.execution.missing_inputs).toEqual([
      "no verified platform specification for YouTube (16:9) in the knowledge base",
      "target resolution and frame rate: the handoff carries only the aspect ratio",
    ]);
    expect(o.execution.notes).toContain("the plan uses draft recipes: this output is for planning and tests, not production");
    expect(NO_RENDERERS.template("remotion/anything")).toBeNull();
  });

  it("reports an unsupported renderer: a template for the wrong renderer does not count", async () => {
    const t = await approved("e-wrong");
    const wrongRenderer: RendererRegistry = { template: (ref) => (ref.startsWith("remotion/") ? { renderer: "ffmpeg" } : { renderer: "ffmpeg" }) };
    const { output: o } = await must(t.handoff, { ...t.editor, renderers: wrongRenderer });
    const first = o.execution.operations[0]!;
    expect(first.executable).toBe(false);
    expect(first.blockers[0]).toBe("remotion/text-fade-up is registered for ffmpeg, which recipe text-fade-up does not support");
    expect(o.execution.operations.find((x) => x.operation_id === "E03")!.executable).toBe(true); // crossfade is ffmpeg/xfade-fade, which ffmpeg supports
  });

  it("makes draft recipes executable at most for planning, never production-executable", async () => {
    const t = await approved("e-draft");
    const { output: o } = await must(t.handoff, { ...t.editor, renderers: fakeRegistry(t.editor.recipes) });
    expect(o.execution.executable).toBe(true); // 3. a registered template exists for every operation
    expect(o.execution.production_executable).toBe(false);
    expect(o.execution.rendered).toBe(false); // 4. and still nothing was rendered
    for (const x of o.execution.operations) {
      expect(x.executable).toBe(true);
      expect(x.production_executable).toBe(false);
      expect(x.blockers).toEqual([expect.stringMatching(/is draft: no review evidence; it may be used for planning and tests, not production$/)]);
    }
  });

  it("allows production-executable only for recipes that carry a review record (a labelled test fixture)", async () => {
    const reviewed: Recipe[] = allRecipes.map((r) => ({ ...r, status: "reviewed", review: { reviewed_by: "TEST FIXTURE ONLY", reviewed_at: "2026-10-24T00:00:00.000Z", evidence: "fixture: not a real review" } }));
    const library = new RecipeLibrary(reviewed, "reviewed");
    const t = await approved("e-reviewed", { library });
    expect(t.handoff.required_operations.every((o) => o.evidence === "review_record")).toBe(true);
    const { output: o } = await must(t.handoff, { ...t.editor, renderers: fakeRegistry(library) });
    expect(o.execution).toMatchObject({ rendered: false, executable: true, production_executable: true });
    expect(o.execution.operations.every((x) => x.production_executable && x.blockers.length === 0)).toBe(true);
    expect(o.provenance.recipes.every((x) => x.endsWith("@0.1.0"))).toBe(true);
  });

  it("refuses an execution report that overstates what can run", () => {
    const base = { rendered: false, executable: true, production_executable: false, operations: [{ operation_id: "E01", renderer: null, executable: false, production_executable: false, blockers: ["x"] }], missing_inputs: [], notes: [] };
    const out = (execution: unknown) => EditorOutput.safeParse({ schema_version: "1.1.0", handoff_schema_version: "1.3.0", handoff_id: "ho_0123456789abcdef", handoff_content_hash: "a".repeat(64), approved: { storyboard: { version: 1, hash: "a".repeat(64) }, edit_plan: { version: 1, hash: "b".repeat(64) } }, status: "ready", operations: [], validation: { ok: true, issues: [] }, conflicts: [], revision_requests: [], provenance: { skills: [], recipes: [], retrievals: [] }, execution });
    expect(out({ ...base, rendered: true }).success).toBe(false); // the Editor never renders
    expect(out({ ...base, operations: [] }).success).toBe(true); // nothing to report, nothing claimed beyond that
    expect(out(base).success).toBe(false); // executable while an operation is not (and the operation list does not match)
    expect(out({ ...base, executable: false, production_executable: true }).success).toBe(false);
  });
});

describe("handoffs the Editor refuses", () => {
  const llm = () => new ScriptedClient([]); // any model call would throw: a rejected handoff must never reach the model

  it("rejects stale, missing or tampered approvals and produces no output at all", async () => {
    const t = await approved("e-rej");
    const model = llm();
    const run = (h: unknown) => runEditor(h, { ...t.editor, llm: model });
    const wrongHash = structuredClone(t.handoff); wrongHash.approvals.edit_plan.plan_hash = "0".repeat(64);
    const a = await run(rehash(wrongHash));
    expect(a).toMatchObject({ ok: false, stage: "verification" });
    expect("output" in a).toBe(false);
    if (!a.ok) expect(a.reasons).toContain("the edit plan does not match its approval (hash mismatch)");
    const edited = structuredClone(t.handoff); edited.edit_plan.uses[0]!.rationale = "changed after approval";
    const b = await run(rehash(edited));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reasons).toContain("the edit plan does not match its approval (hash mismatch)");
    const stale = structuredClone(t.handoff); stale.approved.storyboard.version = 7;
    const c = await run(rehash(stale));
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reasons).toContain("the storyboard approval is not for storyboard version 1"); // the handoff claims version 7; the plan and its approval are version 1
    const tampered = await run({ ...t.handoff, content_hash: "f".repeat(64) });
    expect(tampered.ok).toBe(false);
    expect(model.calls).toHaveLength(0);
  });

  it("rejects input that is not a handoff, and handoffs of another schema version", async () => {
    const t = await approved("e-input");
    for (const raw of [null, "approved", {}, { ...t.handoff, schema_version: "1.2.0" }]) {
      const r = await runEditor(raw, t.editor);
      expect(r).toMatchObject({ ok: false, stage: "input" });
      expect("output" in r).toBe(false);
    }
  });

  it("checks the stored approvals when a store is given, so a handoff cannot vouch for itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "editor-test-")); dirs.push(dir);
    const store = new RunStore(dir);
    const t = await approved("e-store", { store });
    expect((await runEditor(t.handoff, { ...t.editor, store })).ok).toBe(true);
    const empty = new RunStore(mkdtempSync(join(tmpdir(), "editor-empty-"))); dirs.push(empty.sessionDir);
    const r = await runEditor(t.handoff, { ...t.editor, store: empty });
    expect(r).toMatchObject({ ok: false, stage: "verification", reasons: ["there is no stored storyboard approval for run e-store", "there is no stored edit-plan approval for run e-store"].concat(r.ok ? [] : r.reasons.slice(2)) });
  });

  it("rejects a recipe mismatch: a recipe removed or changed since approval", async () => {
    const t = await approved("e-recipe");
    const without = new RecipeLibrary(allRecipes.filter((r) => r.recipe_id !== "crossfade"), "draft");
    const gone = await runEditor(t.handoff, { ...t.editor, recipes: without });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.reasons.join(" ")).toContain("recipe crossfade no longer exists");
    const bumped = new RecipeLibrary(allRecipes.map((r) => (r.recipe_id === "crossfade" ? { ...r, version: "0.2.0" } : r)), "draft");
    const drift = await runEditor(t.handoff, { ...t.editor, recipes: bumped });
    expect(drift.ok).toBe(false);
    if (!drift.ok) expect(drift.reasons).toContain("recipe crossfade is now version 0.2.0, but the plan was approved with 0.1.0");
    const promoted = new RecipeLibrary(allRecipes.map((r) => (r.recipe_id === "crossfade" ? { ...r, status: "reviewed" as const, review: { reviewed_by: "x", reviewed_at: "2026-10-24T00:00:00.000Z", evidence: "y" } } : r)), "draft");
    const status = await runEditor(t.handoff, { ...t.editor, recipes: promoted });
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reasons.join(" ")).toContain("required_operations do not match the recipe library");
  });

  it("reports a missing asset by refusing the handoff", async () => {
    const hashed = Asset.parse({ asset_id: "asset_clip", uri: "clip.mp4", media_type: "video", duration: 30, width: 1920, height: 1080, metadata: { bytes: 1000, sha256: "a".repeat(64) } });
    const sb = learnStoryboard({ S02: { asset_ids: ["asset_clip"], required_assets: [{ need: "Demo clip", kind: "footage", availability: "supplied", asset_id: "asset_clip" }] } });
    const base = deps(new ScriptedClient([ready, learnTreatment(), sb, learnEdit]));
    const graph = buildDirectorGraph(base);
    const g1 = await graph.invoke({ ...learnInput, assets: [hashed] }, cfg("e-asset"));
    const done = (await graph.invoke(approveCurrent(await graph.invoke(approveCurrent(g1), cfg("e-asset"))), cfg("e-asset"))) as DirectorStateType;
    const present = { size: () => 1000, sha256: () => "a".repeat(64) };
    const handoff = buildHandoff(done, { recipes: base.recipes, skills: new SkillLibrary(root("skills")), run_id: "e-asset", model: "scripted", files: present });
    const editor: EditorDeps = { recipes: base.recipes, skills: editorSkills, retriever: base.retriever };
    expect((await runEditor(handoff, { ...editor, files: present })).ok).toBe(true);
    const gone = await runEditor(handoff, { ...editor, files: { size: () => null } });
    expect(gone).toMatchObject({ ok: false, stage: "verification", reasons: ["asset asset_clip is missing at handoff time (clip.mp4)"] });
    const changed = await runEditor(handoff, { ...editor, files: { size: () => 1000, sha256: () => "b".repeat(64) } });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.reasons).toEqual(["asset asset_clip content changed: its SHA-256 is not the one recorded at upload"]);
  });
});

describe("what the Editor reports instead of inventing", () => {
  it("reports voiceover as unsupported and blocks, while still listing the operations it could derive", async () => {
    const t = await approved("e-vo", { storyboard: learnStoryboard({ S04: { voiceover: "Learning that adapts to you." } }) });
    const { output: o, check } = await must(t.handoff, t.editor);
    expect(o.status).toBe("blocked");
    expect(o.conflicts).toEqual([expect.objectContaining({ conflict_id: "K-S04-voiceover", kind: "unsupported_operation", scene_id: "S04" })]);
    expect(o.operations).toHaveLength(6);
    expect(o.execution).toMatchObject({ executable: false, production_executable: false });
    expect(check.ok).toBe(true); // the operations are consistent; the plan simply asks for more than the contract can do
  });

  it("reports audio cues that nothing can produce", async () => {
    const t = await approved("e-audio", { storyboard: learnStoryboard({ S01: { audio_cues: ["Tense music bed starts", "Soft UI click"] } }) });
    const { output: o } = await must(t.handoff, t.editor);
    expect(o.status).toBe("blocked");
    expect(o.conflicts).toHaveLength(1);
    expect(o.conflicts[0]).toMatchObject({ conflict_id: "K-S01-audio", kind: "missing_information", scene_id: "S01" });
    expect(o.conflicts[0]!.description).toContain("the approved plan has no sound recipe for the scene and no audio asset was supplied");
  });

  it("asks the Director for a revision, rather than adding a text operation, when approved text has no recipe to show it", async () => {
    const t = await approved("e-text", { storyboard: learnStoryboard({ S04: { overlay: { text: "Learning that adapts", safe_area: "platform_safe" } } }) });
    const { output: o, check } = await must(t.handoff, t.editor);
    expect(o.status).toBe("needs_director_revision");
    expect(o.revision_requests).toEqual([expect.objectContaining({ target: "edit_plan", scene_ids: ["S04"], requires_reapproval: true })]);
    expect(o.operations).toHaveLength(6); // no seventh, invented operation
    expect(check.requires_reapproval).toBe(true);
    expect(o.execution.executable).toBe(false);
  });

  it("reports missing knowledge instead of assuming it, using only the Editor scope", async () => {
    const t = await approved("e-know");
    const empty = new KeywordRetriever([]);
    const f = await planEditorWork(t.handoff, { recipes: t.editor.recipes, retriever: empty });
    expect(f.conflicts.map((c) => [c.conflict_id, c.kind])).toEqual([
      ["K-knowledge-overlay_text", "knowledge_missing"], ["K-knowledge-concat", "knowledge_missing"],
      ["K-knowledge-render_graphics_scene", "knowledge_missing"], ["K-knowledge-mix_audio", "knowledge_missing"],
    ]);
    expect(f.conflicts[0]!.description).toContain("No editing guidance is available for overlay_text operations, so none is assumed.");
    expect(f.retrievals.every((x) => x.agent === "editor")).toBe(true);
    // The same plan with the shipped knowledge finds guidance for all four, and says nothing.
    expect((await planEditorWork(t.handoff, t.editor)).conflicts).toEqual([]);
  });

  it("reports unrecorded audio licences and unmet asset blockers, and notes (but does not block on) an undeclared product screen", async () => {
    const t = await approved("e-meta");
    const h = structuredClone(t.handoff) as DirectorHandoff;
    h.assets.push(Asset.parse({ asset_id: "asset_music", uri: "music.mp3", media_type: "audio", duration: 30, width: null, height: null }));
    h.assets.push(Asset.parse({ asset_id: "asset_ui", uri: "ui.png", media_type: "image", duration: null, width: 800, height: 600 }));
    h.assets.push(Asset.parse({ asset_id: "asset_ui2", uri: "ui2.png", media_type: "image", duration: null, width: 800, height: 600, genuine_product_ui: false }));
    h.storyboard.scenes[3]!.required_assets = [
      { need: "Dashboard capture", kind: "ui_screenshot", availability: "supplied", asset_id: "asset_ui", placeholder: false, fallback: null },
      { need: "Illustrative dashboard", kind: "ui_screenshot", availability: "supplied", asset_id: "asset_ui2", placeholder: false, fallback: null },
    ];
    h.asset_feasibility = { ...h.asset_feasibility, blockers: ["S05 needs footage \"x\" that is not supplied."] };
    const f = await planEditorWork(h, t.editor);
    expect(f.conflicts.map((c) => c.conflict_id)).toEqual(["K-license-asset_music", "K-asset-1"]); // no conflict for the undeclared screenshot
    expect(f.notes.join(" ")).toContain("S04 uses the uploaded screenshot asset_ui; it was not declared a genuine capture of the product, so it is shown as an uploaded image, not as confirmed product interface");
    expect(f.notes.join(" ")).not.toContain("asset_ui2"); // declared not genuine: nothing to note
    expect(f.conflicts[0]!.description).toContain("no recorded right-to-use declaration (licence not recorded)");
    const licensed = Asset.parse({ asset_id: "asset_music", uri: "music.mp3", media_type: "audio", duration: 30, width: null, height: null, license: { status: "licensed", note: "stock licence 123" } });
    h.assets = h.assets.map((a) => (a.asset_id === "asset_music" ? licensed : a));
    expect((await planEditorWork(h, t.editor)).conflicts.map((c) => c.conflict_id)).not.toContain("K-license-asset_music");
  });

  it("regression: an undeclared uploaded screenshot proceeds through Editor validation when everything else is satisfied", async () => {
    const t = await approved("e-undeclared");
    const h = structuredClone(t.handoff) as DirectorHandoff;
    // genuine_product_ui is left at its default (null = never declared), in every scene that shows it
    h.assets.push(Asset.parse({ asset_id: "asset_shot", uri: "shot.png", media_type: "image", duration: null, width: 1680, height: 919 }));
    expect(h.assets.at(-1)!.genuine_product_ui).toBeNull();
    for (const i of [0, 3]) h.storyboard.scenes[i]!.required_assets = [{ need: "Product screen", kind: "ui_screenshot", availability: "supplied", asset_id: "asset_shot", placeholder: false, fallback: null }];
    const f = await planEditorWork(h, t.editor);
    expect(f.conflicts).toEqual([]);
    expect(f.revision_requests).toEqual([]);
    expect(f.notes.filter((n) => n.includes("asset_shot")).length).toBe(2); // one note per scene that uses it, never a claim of authenticity
    for (const n of f.notes.filter((x) => x.includes("asset_shot"))) expect(n).toMatch(/not declared a genuine capture/);
  });

  it("an explicit declaration is still respected: genuine true or false adds no note either way", async () => {
    const t = await approved("e-declared");
    for (const declared of [true, false]) {
      const h = structuredClone(t.handoff) as DirectorHandoff;
      h.assets.push(Asset.parse({ asset_id: "asset_shot", uri: "shot.png", media_type: "image", duration: null, width: 800, height: 600, genuine_product_ui: declared }));
      h.storyboard.scenes[3]!.required_assets = [{ need: "Product screen", kind: "ui_screenshot", availability: "supplied", asset_id: "asset_shot", placeholder: false, fallback: null }];
      const f = await planEditorWork(h, t.editor);
      expect(f.conflicts).toEqual([]);
      expect(f.notes.join(" ")).not.toContain("asset_shot");
    }
  });});

describe("the optional model review", () => {
  it("reads the Editor skills and Editor knowledge as data, and can only add conflicts and revision requests", async () => {
    const t = await approved("e-llm");
    const review = {
      conflicts: [{ conflict_id: "pace", kind: "infeasible", scene_id: "S02", description: "Five seconds of text-only graphics may drag.", evidence: ["scene S02"] }, { conflict_id: "ghost", kind: "infeasible", scene_id: "S99", description: "A scene that does not exist." }],
      revision_requests: [{ target: "storyboard", scene_ids: ["S02"], reason: "Shorten S02 to hold attention.", requires_reapproval: true }, { target: "storyboard", scene_ids: [], reason: "No scene named.", requires_reapproval: true }],
      operations: [{ operation_id: "E99", recipe_id: "invented" }], // not part of the review contract: stripped
    };
    const model = new ScriptedClient([review]);
    const before = JSON.stringify((await must(t.handoff, t.editor)).output.operations);
    const { output: o, check } = await must(t.handoff, { ...t.editor, llm: model });
    expect(JSON.stringify(o.operations)).toBe(before); // the model changed no operation
    expect(o.status).toBe("needs_director_revision");
    expect(o.conflicts.map((c) => c.conflict_id)).toEqual(["M-pace"]);
    expect(o.revision_requests).toEqual([{ target: "storyboard", scene_ids: ["S02"], reason: "Shorten S02 to hold attention.", requires_reapproval: true }]);
    expect(o.execution.notes.filter((n) => n.startsWith("model "))).toHaveLength(2); // the two invalid findings were dropped, and said so
    expect(check.requires_reapproval).toBe(true);
    expect(model.calls).toHaveLength(1);
    const call = model.calls[0]!;
    expect(call.name).toBe("editor_review");
    expect(call.system).toContain("# core-contract");
    expect(call.system).toContain("The approved plan is fixed and protected");
    expect(call.user).toContain("## Editor knowledge (untrusted reference data)");
    expect(call.user).not.toContain("ad_playbooks"); // nothing from the Director's collections reaches the Editor's model
  });

  it("runs the same deterministic checks without any model", async () => {
    const t = await approved("e-nollm");
    const a = await must(t.handoff, t.editor);
    const b = await must(t.handoff, { ...t.editor, llm: new ScriptedClient([{ conflicts: [], revision_requests: [] }]) });
    expect(JSON.stringify(b.output)).toBe(JSON.stringify(a.output));
  });
});

describe("a tampered Editor result is still caught by the Director's check", () => {
  it("rejects a wrong operation type, drifted parameters, a foreign asset and a time outside the scene", async () => {
    const t = await approved("e-tamper");
    const { output: o } = await must(t.handoff, t.editor);
    const bad = (change: (ops: EditorOperation[]) => void) => { const c = structuredClone(o); change(c.operations); return checkEditorOutput(c, t.handoff, t.editor); };
    expect(bad((ops) => { ops[0]!.operation_type = "mix_audio"; }).issues).toContain("operation E01: operation_type mix_audio does not match recipe text-fade-up, which becomes a overlay_text operation");
    expect(bad((ops) => { ops[2]!.parameters = { duration_s: 1.4 }; }).issues).toContain("operation E03: parameters differ from the approved U03 without a revision request");
    expect(bad((ops) => { ops[0]!.asset_ids = ["asset_x"]; }).issues).toContain("operation E01: asset asset_x is not approved for S01");
    expect(bad((ops) => { ops[1]!.timing = { start_s: 3, duration_s: 9 }; }).issues.some((i) => i.includes("runs outside S02"))).toBe(true);
    expect(bad((ops) => { ops[0]!.caption = { text: "Too many tabs!", start_s: 0, end_s: 4 }; }).issues).toContain("operation E01: caption text is not the approved overlay text for S01");
  });
});

describe("the Editor's clip operations: fade_in_s belongs to the caption recipe only", () => {
  /** The explainer handoff with S01 and S02 both carrying a supplied clip and approved overlay text, and a clip recipe used on each. */
  async function clipHandoff(recipeS01: string, recipeS02: string) {
    const t = await approved("e-clip");
    const h = structuredClone(t.handoff);
    h.assets.push(Asset.parse({ asset_id: "asset_clip", uri: "clip.mp4", media_type: "video", duration: 20, width: 1280, height: 720 }));
    for (const id of ["S01", "S02"]) h.storyboard.scenes.find((s) => s.scene_id === id)!.asset_ids = ["asset_clip"];
    h.edit_plan.uses = [
      { use_id: "U01", scene_id: "S01", recipe_id: recipeS01, params: {}, rationale: "footage" },
      { use_id: "U02", scene_id: "S02", recipe_id: recipeS02, params: {}, rationale: "footage" },
    ];
    const f = await planEditorWork(h, t.editor);
    return { h, f, op: (id: string) => f.operations.find((o) => o.target_scene_id === id)! };
  }

  it("a plain clip gets no caption and no fade_in_s, even on a scene that has overlay text", async () => {
    const { op, h } = await clipHandoff("clip-play", "clip-play-caption");
    expect(h.storyboard.scenes.find((s) => s.scene_id === "S01")!.overlay).not.toBeNull();
    expect(op("S01").recipe_id).toBe("clip-play");
    expect(op("S01").caption).toBeNull();
    expect(Object.keys(op("S01").parameters).sort()).toEqual(["background", "fit", "source_audio"]);
  });
  it("a captioned clip gets the approved text and a resolved fade_in_s (the recipe default when the plan omits it)", async () => {
    const { op, h } = await clipHandoff("clip-play", "clip-play-caption");
    expect(op("S02").caption).toMatchObject({ text: h.storyboard.scenes.find((s) => s.scene_id === "S02")!.overlay!.text });
    expect(op("S02").parameters["fade_in_s"]).toBe(0.5);
    expect(Object.keys(op("S02").parameters).sort()).toEqual(["background", "fade_in_s", "fit", "source_audio"]);
  });
  it("the caption and fade_in_s travel together: no operation has one without the other", async () => {
    const { f } = await clipHandoff("clip-play-caption", "clip-play");
    for (const o of f.operations) expect(o.caption !== null).toBe("fade_in_s" in o.parameters);
  });
  it("overlay text on a scene whose clip recipe shows none is reported, not silently dropped", async () => {
    const { f } = await clipHandoff("clip-play", "clip-play");
    expect(f.revision_requests.map((r) => r.scene_ids).flat()).toEqual(expect.arrayContaining(["S01", "S02"]));
  });
});
