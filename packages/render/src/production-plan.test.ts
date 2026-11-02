import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EditPlan, ProductionDecisionPlan, Scene, ScenePlan, deriveProductionMethod, productionPlanHash, storyboardHash, type Recipe, type Renderer } from "@digikon/contracts";
import {
  CapabilityRegistry, EXAMPLE_VISUALS, declaredImplementations, liveImplementations, loadCapabilityRegistry, loadVisualCapabilities,
  type RegistrySources,
} from "./index.js";
import { candidateRecipeIds as candidates, generateProductionPlan as generate, validateProductionPlan as validate, type PlanningInput } from "@digikon/director";
import { assets, goodStoryboard, learnProject, learnStoryboard, project, recipes, root, treatment, use } from "../../director/src/fixtures.js";

const capDir = join(root(""), "capabilities");
const learned = loadCapabilityRegistry(capDir, { dependency: () => null, recipes: { get: (id) => recipes.find((r) => r.recipe_id === id) } });
const visual = loadVisualCapabilities(capDir);
const DECL = declaredImplementations(learned.usable);
const build = (over: Partial<RegistrySources> = {}) => CapabilityRegistry.from({ recipes, learned, visual, implementations: liveImplementations(DECL), declared: DECL, ...over });
const reg = build();
const ALL: Renderer[] = ["ffmpeg", "remotion", "hyperframes"];
const FIXED = () => new Date("2026-10-31T12:00:00.000Z");
// The decision logic now lives in the Director and takes a snapshot; these tests build a real registry (render) and hand it over as data.
const generateProductionPlan = (r: CapabilityRegistry, i: PlanningInput) => generate(r.snapshot, i);
const validateProductionPlan = (r: CapabilityRegistry, i: PlanningInput, plan: unknown) => validate(r.snapshot, i, plan);
const candidateRecipeIds = (r: CapabilityRegistry, scene: Parameters<typeof candidates>[1], op: Parameters<typeof candidates>[2], ctx: Parameters<typeof candidates>[3]) => candidates(r.snapshot, scene, op, ctx);

const plan = (raw: { scenes: Record<string, unknown>[] }, project_id: string): ScenePlan => {
  let t = 0;
  return ScenePlan.parse({ project_id, version: 1, scenes: raw.scenes.map((s) => {
    const start = t; t += s.duration_seconds as number;
    const base = Scene.parse({ ...s, start_time: start, end_time: t, production_method: null });
    return { ...base, production_method: deriveProductionMethod(base) };
  }) });
};
const coffee = plan(goodStoryboard, "coffee1");
const sbRef = { version: 1, hash: "b".repeat(64) };
const edit = (uses: unknown[], project_id = "coffee1") => EditPlan.parse({ project_id, version: 1, uses });
const GOOD = [use(1, "S01", "slow-push-in", { scale_end: 1.1 }), use(2, "S01", "crossfade", { duration_s: 0.6 }), use(3, "S03", "end-card-cta", { hold_s: 2.5 }), use(4, "S02", "pan-reframe")];
const input = (over: Partial<PlanningInput> = {}): PlanningInput => ({ scenePlan: coffee, storyboard: sbRef, editPlan: edit(GOOD), assets, aspect_ratio: project.aspect_ratio, available_engines: ALL, now: FIXED, ...over });
const gen = (r: CapabilityRegistry = reg, over: Partial<PlanningInput> = {}) => generateProductionPlan(r, input(over));
const dec = (p: ReturnType<typeof gen>, use_id: string) => p.decisions.find((d) => d.use_id === use_id)!;
const withRecipe = (id: string, patch: (r: Recipe) => void): Recipe[] => recipes.map((r) => { if (r.recipe_id !== id) return r; const c = structuredClone(r); patch(c); return c; });

describe("a valid plan", () => {
  const p = gen();
  it("records the capability, version, record hash, engine, implementation and readiness for every use", () => {
    expect(p.summary).toMatchObject({ executable: 4, blocked: 0, executable_with_substitute: 0, clear: false }); // decisions are valid, but nothing has run the renderer's planners yet
    expect(p.preflight.status).toBe("not_run");
    const d = dec(p, "U01");
    expect(d).toMatchObject({ capability_id: "remotion:slow-push-in", engine: "remotion", implementation_ref: "remotion/slow-push-in", operations: ["trim_clip"], recipe_version: "0.1.0", verdict: "executable", reasons: ["OK"] });
    expect(d.capability_record_hash).toBe(reg.get("remotion:slow-push-in")!.record_hash);
    expect(d.readiness).toBe("validated");
    expect(d.verification).toMatchObject({ adapter_available: true, implementation_resolved: true, current_execution: "not_performed" });
    expect(dec(p, "U02")).toMatchObject({ capability_id: "ffmpeg:crossfade", engine: "ffmpeg" });
  });
  it("resolves parameters over the capability's defaults and keeps what the plan supplied", () => {
    const d = dec(p, "U01");
    expect(d.parameters.supplied).toEqual({ scale_end: 1.1 });
    expect(d.parameters.resolved).toMatchObject({ scale_end: 1.1, easing: "ease_in_out" });
    expect(d.parameters.issues).toEqual([]);
  });
  it("is honest about what it does not show", () => {
    expect(dec(p, "U01").limitations.join(" ")).toContain("no current execution has been verified");
    expect(p.unresolved).toEqual([]);
  });
  it("binds the scene's assets to the capability's slots", () => {
    expect(dec(p, "U01").slot_bindings).toEqual([{ slot_id: "primary_media", asset_id: "asset_beans", media_type: "video" }]);
  });
  it("conforms to the schema and carries the Director plan references", () => {
    expect(ProductionDecisionPlan.safeParse(p).success).toBe(true);
    expect(p.storyboard).toEqual(sbRef);
    expect(p.edit_plan.version).toBe(1);
    expect(p.registry.snapshot_hash).toBe(reg.snapshot.snapshot_hash);
    expect(p.registry.relevant_capability_ids).toEqual(["ffmpeg:crossfade", "remotion:end-card-cta", "remotion:pan-reframe", "remotion:slow-push-in"]);
  });
  it("validates against the same inputs and registry", () => {
    expect(validateProductionPlan(reg, input(), p)).toEqual({ ok: true, issues: [], notes: [] });
  });
});

describe("unsupported, unknown and invalid uses are blocked and never substituted silently", () => {
  const one = (u: unknown, over: Partial<PlanningInput> = {}, r: CapabilityRegistry = reg) => dec(gen(r, { editPlan: edit([u]), ...over }), (u as { use_id: string }).use_id);
  it("a recipe with no implementation", () => {
    const d = one(use(1, "S03", "loudness-normalise"));
    expect(d).toMatchObject({ verdict: "blocked", capability_id: "ffmpeg:loudness-normalise", substitute: null });
    expect(d.reasons).toContain("CAPABILITY_NOT_EXECUTABLE");
    expect(gen(reg, { editPlan: edit([use(1, "S03", "loudness-normalise")]) }).summary.clear).toBe(false);
  });
  it("a recipe that does not exist", () => {
    expect(one(use(1, "S01", "spin-3d-bottle"))).toMatchObject({ verdict: "blocked", reasons: ["RECIPE_UNKNOWN"], capability_id: null });
  });
  it("a scene that is not in the storyboard", () => {
    expect(one(use(1, "S09", "slow-push-in")).details.join(" ")).toContain("not in the storyboard");
  });
  it("an out-of-range parameter", () => {
    const d = one(use(1, "S01", "slow-push-in", { scale_end: 99 }));
    expect(d.reasons).toContain("PARAMETER_INVALID");
    expect(d.parameters.issues[0]).toMatchObject({ code: "PARAM_OUT_OF_RANGE", parameter: "scale_end" });
  });
  it("an invalid default makes an omitted value a blocker", () => {
    const bad = build({ recipes: withRecipe("slow-push-in", (r) => { const p = r.parameters.find((x) => x.name === "scale_end")!; if (p.kind === "number") p.default = p.max + 1; }) });
    const d = one(use(1, "S01", "slow-push-in"), {}, bad);
    expect(d.verdict).not.toBe("executable"); // a like-for-like alternative may be suggested, but the planned capability is not usable as written
    expect(d.parameters.issues.map((x) => x.code)).toContain("PARAM_DEFAULT_INVALID");
    expect(d.reasons).toContain("PARAMETER_INVALID");
  });
  it("a wrong kind of media", () => {
    expect(one(use(1, "S03", "clip-play")).reasons).toContain("MEDIA_NOT_ACCEPTED"); // S03 carries an image; clip-play takes video
  });
  it("a scene with no picture for a recipe that needs one", () => {
    const sp = plan(learnStoryboard(), "learn1");
    const d = dec(gen(reg, { scenePlan: sp, editPlan: edit([use(1, "S01", "slow-push-in")], "learn1"), assets: [], aspect_ratio: learnProject.aspect_ratio }), "U01");
    expect(d.reasons).toEqual(expect.arrayContaining(["MEDIA_NOT_ACCEPTED", "MANDATORY_ASSET_MISSING"]));
  });
  it("an unsupported aspect ratio and a scene that is too long", () => {
    const narrow = build({ recipes: withRecipe("slow-push-in", (r) => { r.compatibility.aspect_ratios = ["16:9"]; r.constraints.max_duration_s = 2; }) });
    expect(one(use(1, "S01", "slow-push-in"), {}, narrow).reasons).toEqual(expect.arrayContaining(["ASPECT_UNSUPPORTED", "DURATION_OUT_OF_RANGE"]));
  });
  it("an engine that is not available", () => {
    expect(one(use(1, "S01", "slow-push-in"), { available_engines: ["ffmpeg"] }).reasons).toContain("ENGINE_UNAVAILABLE");
  });
  it("a refusal the real adapter would make, found before approval (the S06 kind of failure)", () => {
    const d = one(use(1, "S01", "slow-push-in"), { preflight: (u) => [`operation ${u.use_id}: picture asset_beans would cover the scene's text; move it, make it smaller or give the scene to asset_stage`] });
    expect(d).toMatchObject({ verdict: "blocked", reasons: ["ADAPTER_REFUSES"] });
    expect(d.details.join(" ")).toContain("would cover the scene's text");
  });
  it("a scene whose picture nothing produces, supplied material that is missing, and audio that is not produced are stated, not hidden", () => {
    const sp = plan({ scenes: [{ ...(goodStoryboard.scenes[0] as Record<string, unknown>), voiceover: "Hello there.", required_assets: [{ need: "Shop footage", kind: "footage", availability: "needs_external", fallback: null }] }, goodStoryboard.scenes[1]!] }, "coffee1");
    const p = gen(reg, { scenePlan: sp, editPlan: edit([use(1, "S02", "pan-reframe")]) });
    expect(p.unresolved.map((x) => [x.scene_id, x.kind, x.reason])).toEqual(expect.arrayContaining([["S01", "external_asset", "EXTERNAL_ASSET_MISSING"], ["S01", "scene_picture", "NO_CAPABILITY"], ["S01", "audio", "AUDIO_NOT_PRODUCED"]]));
    expect(p.scenes.find((s) => s.scene_id === "S01")!.verdict).toBe("blocked");
    expect(p.summary.clear).toBe(false);
  });
  it("audio alone does not block a scene", () => {
    const sp = plan({ scenes: [{ ...(goodStoryboard.scenes[0] as Record<string, unknown>), audio_cues: ["soft chime"] }, goodStoryboard.scenes[1]!, goodStoryboard.scenes[2]!] }, "coffee1");
    const p = gen(reg, { scenePlan: sp });
    expect(p.unresolved.some((x) => x.kind === "audio")).toBe(true);
    expect(p.summary).toMatchObject({ blocked: 0, executable_with_substitute: 0 });
    expect(p.scenes.every((s) => s.verdict === "executable")).toBe(true); // audio is stated, not a blocker
  });
  it("nothing live: every decision is blocked and says so", () => {
    const none = build({ implementations: {}, adapter_failures: ALL.map((engine) => ({ engine, reason: "not here" })) });
    const p = gen(none, { available_engines: [] });
    expect(p.decisions.every((d) => d.verdict === "blocked")).toBe(true);
    expect(p.summary.clear).toBe(false);
  });
});

describe("ambiguity", () => {
  it("a recipe that maps to more than one capability is not guessed", () => {
    const dup = build({ recipes: [...recipes, structuredClone(recipes.find((r) => r.recipe_id === "slow-push-in")!)] });
    const d = dec(gen(dup), "U01");
    expect(d).toMatchObject({ verdict: "blocked", reasons: ["AMBIGUOUS_CAPABILITY"], capability_id: null });
    expect(d.details.join(" ")).toContain("cannot say which one is meant");
  });
  it("two equally eligible alternatives: neither is chosen on the plan's behalf", () => {
    const rec = learned.records.find((x) => x.capability_id === "hyperframes:slow-push-in-hyperframes")!;
    const twin = { ...structuredClone(rec), capability_id: "hyperframes:slow-push-in-hyperframes-b", recipe_id: "slow-push-in-hyperframes-b" };
    const twinRecipe = { ...structuredClone(recipes.find((r) => r.recipe_id === "slow-push-in-hyperframes")!), recipe_id: "slow-push-in-hyperframes-b" };
    const two = build({ recipes: [...recipes, twinRecipe], learned: { records: [...learned.records, twin], usable: [...learned.usable, twin], problems: [] } });
    const d = dec(gen(two, { available_engines: ["ffmpeg", "hyperframes"] }), "U01");
    expect(d.verdict).toBe("blocked");
    expect(d.reasons).toContain("AMBIGUOUS_CAPABILITY");
    expect(d.substitute).toBeNull();
    expect(d.alternatives_considered.filter((a) => a.compatible).map((a) => a.capability_id).sort()).toEqual(["hyperframes:slow-push-in-hyperframes", "hyperframes:slow-push-in-hyperframes-b"]);
  });
});

describe("substitutes are suggestions only", () => {
  const down = ["ffmpeg", "hyperframes"] as Renderer[];
  it("one compatible like-for-like alternative is offered, the plan is not clear, and nothing in the plan changes", () => {
    const p = gen(reg, { available_engines: down });
    const d = dec(p, "U01");
    expect(d.verdict).toBe("executable_with_substitute");
    expect(d.reasons).toEqual(expect.arrayContaining(["ENGINE_UNAVAILABLE", "SUBSTITUTE_NEEDS_APPROVAL"]));
    expect(d.substitute).toMatchObject({ capability_id: "hyperframes:slow-push-in-hyperframes", engine: "hyperframes" });
    expect(d.recipe_id).toBe("slow-push-in");
    expect(d.capability_id).toBe("remotion:slow-push-in");
    expect(p.summary).toMatchObject({ executable_with_substitute: 3, clear: false }); // every remotion use has a hyperframes twin; only the ffmpeg crossfade stands
  });
  it("a substitute the adapter would refuse is not offered", () => {
    const d = dec(gen(reg, { available_engines: down, preflight: (_u, _s, c) => (c.engine === "hyperframes" ? ["hyperframes refuses this scene"] : []) }), "U01");
    expect(d.verdict).toBe("blocked");
    expect(d.substitute).toBeNull();
  });
  it("an unrelated capability is never a substitute", () => {
    expect(dec(gen(reg, { editPlan: edit([use(1, "S03", "loudness-normalise")]) }), "U01").substitute).toBeNull();
  });
  it("a substitute that cannot take the planned parameters is not offered", () => {
    const d = dec(gen(reg, { available_engines: down, editPlan: edit([use(1, "S01", "slow-push-in", { not_a_parameter: 1 })]) }), "U01");
    expect(d.substitute).toBeNull();
  });
});

describe("hash behavior", () => {
  const base = gen();
  it("is stable: the same inputs give the same plan and hash, whatever the creation time or source order", () => {
    expect(gen().plan_hash).toBe(base.plan_hash);
    expect(gen(reg, { now: () => new Date("2030-01-01T00:00:00.000Z") }).plan_hash).toBe(base.plan_hash);
    expect(gen(build({ recipes: [...recipes].reverse(), visual: [...visual].reverse() })).plan_hash).toBe(base.plan_hash);
    expect(JSON.stringify(gen())).toBe(JSON.stringify(base));
  });
  it("verifies, and is not circular: it ignores itself, the creation time, the whole-snapshot hash and the alternatives", () => {
    expect(productionPlanHash(base)).toBe(base.plan_hash);
    expect(productionPlanHash({ ...base, plan_hash: "0".repeat(64) })).toBe(base.plan_hash);
    expect(productionPlanHash({ ...base, created_at: "2031-01-01T00:00:00.000Z" })).toBe(base.plan_hash);
    expect(productionPlanHash({ ...base, registry: { ...base.registry, snapshot_hash: "c".repeat(64) } })).toBe(base.plan_hash);
    expect(productionPlanHash({ ...base, decisions: base.decisions.map((d) => ({ ...d, alternatives_considered: [{ capability_id: "x:y", compatible: false, reasons: ["ENGINE_UNAVAILABLE"] }] })) })).toBe(base.plan_hash);
  });
  it("covers what is selected: the capability, record hash, engine, implementation, parameters, verdict, relevant hash and Director references", () => {
    const h = (f: (p: ReturnType<typeof gen>) => unknown) => productionPlanHash(f(structuredClone(base)) as never);
    const first = (p: ReturnType<typeof gen>) => p.decisions[0]!;
    for (const mutate of [
      (p: ReturnType<typeof gen>) => { first(p).capability_id = "remotion:pan-reframe"; },
      (p: ReturnType<typeof gen>) => { first(p).capability_record_hash = "d".repeat(64); },
      (p: ReturnType<typeof gen>) => { first(p).engine = "hyperframes"; },
      (p: ReturnType<typeof gen>) => { first(p).implementation_ref = "remotion/pan-reframe"; },
      (p: ReturnType<typeof gen>) => { first(p).parameters.resolved["scale_end"] = 1.2; },
      (p: ReturnType<typeof gen>) => { first(p).verdict = "blocked"; },
      (p: ReturnType<typeof gen>) => { p.registry.relevant_capabilities_hash = "e".repeat(64); },
      (p: ReturnType<typeof gen>) => { p.storyboard.hash = "f".repeat(64); },
      (p: ReturnType<typeof gen>) => { p.edit_plan.version = 2; },
      (p: ReturnType<typeof gen>) => { p.decisions.reverse(); },
    ]) expect(h((p) => { mutate(p); return p; }), String(mutate)).not.toBe(base.plan_hash);
  });
  it("changes with the Director plan: a different parameter, or a different storyboard hash", () => {
    expect(gen(reg, { editPlan: edit([use(1, "S01", "slow-push-in", { scale_end: 1.2 }), GOOD[1]!, GOOD[2]!]) }).plan_hash).not.toBe(base.plan_hash);
    expect(gen(reg, { storyboard: { version: 1, hash: "a".repeat(64) } }).plan_hash).not.toBe(base.plan_hash);
  });
  it("binds to the storyboard hash the Director really computes", () => {
    expect(storyboardHash(treatment as never, coffee)).toMatch(/^[a-f0-9]{64}$/); // the Director passes this value in; the plan carries it unchanged
  });
});

describe("unrelated capability changes do not invalidate an approval; selected ones do", () => {
  const base = gen();
  it("changing an unrelated capability changes the snapshot hash but neither the relevant hash nor the plan hash", () => {
    const other = build({ recipes: withRecipe("title-subtitle", (r) => { r.purpose += " (edited)"; }) });
    expect(other.snapshot.snapshot_hash).not.toBe(reg.snapshot.snapshot_hash);
    const p = gen(other);
    expect(p.registry.relevant_capabilities_hash).toBe(base.registry.relevant_capabilities_hash);
    expect(p.plan_hash).toBe(base.plan_hash);
    const v = validateProductionPlan(other, input(), base);
    expect(v.ok).toBe(true);
    expect(v.notes.join(" ")).toContain("nothing this plan relies on changed");
  });
  it("deprecating or losing an unrelated implementation does not invalidate it either", () => {
    const other = build({ deprecated: new Set(["ffmpeg/bullet-list"]), implementations: { ...liveImplementations(DECL), "ffmpeg/stat-callout": [] } });
    expect(other.snapshot.snapshot_hash).not.toBe(reg.snapshot.snapshot_hash);
    expect(validateProductionPlan(other, input(), base).ok).toBe(true);
    expect(gen(other).plan_hash).toBe(base.plan_hash);
  });
  it("a change to a rejected alternative's state only changes the notes, not the hash", () => {
    const twins = build({ implementations: { ...liveImplementations(DECL), "hyperframes/slow-push-in": [] } });
    const p = gen(twins);
    expect(dec(p, "U01").alternatives_considered).not.toEqual(dec(base, "U01").alternatives_considered);
    expect(p.plan_hash).toBe(base.plan_hash);
  });
  it("changing a selected capability changes the relevant hash and the plan hash, and the old plan no longer validates", () => {
    const changed = build({ recipes: withRecipe("slow-push-in", (r) => { r.purpose += " (edited)"; }) });
    const p = gen(changed);
    expect(p.registry.relevant_capabilities_hash).not.toBe(base.registry.relevant_capabilities_hash);
    expect(p.plan_hash).not.toBe(base.plan_hash);
    const v = validateProductionPlan(changed, input(), base);
    expect(v.ok).toBe(false);
    expect(v.issues.join(" ")).toContain("relevant-capabilities hash mismatch");
  });
  it("a selected capability whose evidence went stale, or whose engine disappeared, invalidates it", () => {
    const stale = build({ learned: { ...learned, usable: learned.usable.filter((u) => u.capability_id !== "remotion:slow-push-in") } });
    expect(validateProductionPlan(stale, input(), base).ok).toBe(false);
    const gone = build({ implementations: liveImplementations(DECL, ["ffmpeg"]) });
    const v = validateProductionPlan(gone, input({ available_engines: ["ffmpeg"] }), base);
    expect(v.ok).toBe(false);
    expect(v.issues.join(" ")).toMatch(/would now be|relevant-capabilities/);
  });
  it("a drawn visual brings in its block and the composition parent, and only that block", () => {
    const sc = (learnStoryboard().scenes[0] as Record<string, unknown>);
    const sp = plan({ scenes: [{ ...sc, visual: EXAMPLE_VISUALS.kinetic_type.visual, overlay: { text: EXAMPLE_VISUALS.kinetic_type.overlay_text ?? "Words", safe_area: "platform_safe" }, duration_seconds: 4 }] }, "learn1");
    const inp = input({ scenePlan: sp, editPlan: edit([use(1, "S01", "scene-composition")], "learn1"), assets: [], aspect_ratio: "16:9" });
    const p = generateProductionPlan(reg, inp);
    expect(p.registry.relevant_capability_ids).toEqual(["remotion:scene-composition", "remotion:scene-composition:kinetic_type"]);
    expect(dec(p, "U01").variant?.capability_id).toBe("remotion:scene-composition:kinetic_type");
    const staleOther = build({ visual: visual.map((v) => (v.block === "end_card" ? { ...v, usable: false, reason: "stale" } : v)) });
    expect(generateProductionPlan(staleOther, inp).plan_hash).toBe(p.plan_hash);
    const staleSelected = build({ visual: visual.map((v) => (v.block === "kinetic_type" ? { ...v, usable: false, reason: "stale" } : v)) });
    expect(generateProductionPlan(staleSelected, inp).plan_hash).not.toBe(p.plan_hash);
    const gone = build({ visual: visual.filter((v) => v.block !== "kinetic_type") });
    expect(dec(generateProductionPlan(gone, inp), "U01").reasons).toContain("VISUAL_BLOCK_NOT_EXECUTABLE");
  });
});

describe("validation catches tampering and staleness", () => {
  const base = gen();
  it("a plan edited after it was made", () => {
    const t = structuredClone(base);
    t.decisions[0]!.engine = "hyperframes";
    expect(validateProductionPlan(reg, input(), t).issues.join(" ")).toContain("changed after it was made");
  });
  it("a plan made for another storyboard or Director plan", () => {
    expect(validateProductionPlan(reg, input({ storyboard: { version: 1, hash: "a".repeat(64) } }), base).issues.join(" ")).toContain("different storyboard");
    expect(validateProductionPlan(reg, input({ editPlan: edit([GOOD[0]!]) }), base).ok).toBe(false);
  });
  it("garbage", () => {
    expect(validateProductionPlan(reg, input(), { nope: true }).ok).toBe(false);
    expect(validateProductionPlan(reg, input(), null).ok).toBe(false);
  });
  it("a Director plan that now needs something else", () => {
    const v = validateProductionPlan(reg, input({ editPlan: edit([use(1, "S01", "slow-push-in", { scale_end: 1.1 }), GOOD[1]!, use(3, "S03", "loudness-normalise")]) }), base);
    expect(v.ok).toBe(false);
  });
});

describe("what the model may be offered", () => {
  const scene = coffee.scenes[0]!;
  const ctx = { assets, aspect_ratio: project.aspect_ratio, available_engines: ALL };
  it("only recipes whose capability is live-resolved and fits the scene", () => {
    const ids = candidateRecipeIds(reg, scene, "trim_clip", ctx);
    expect(ids).toEqual(expect.arrayContaining(["slow-push-in", "pan-reframe"]));
    expect(ids).not.toContain("static-hold"); // no implementation
  });
  it("recipes on an unavailable engine are not offered", () => {
    expect(candidateRecipeIds(reg, scene, "trim_clip", { ...ctx, available_engines: ["ffmpeg"] })).not.toContain("slow-push-in");
  });
  it("audio operations have no candidates (nothing implements them)", () => {
    expect(candidateRecipeIds(reg, scene, "mix_audio", ctx)).toEqual([]);
  });
  it("a recipe that maps to more than one capability is not offered", () => {
    const dup = build({ recipes: [...recipes, structuredClone(recipes.find((r) => r.recipe_id === "slow-push-in")!)] });
    expect(candidateRecipeIds(dup, scene, "trim_clip", ctx)).not.toContain("slow-push-in");
  });
});
