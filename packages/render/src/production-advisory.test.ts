import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdvisoryReport, Scene, ScenePlan, deriveProductionMethod, type Renderer } from "@digikon/contracts";
import { CapabilityRegistry, EXAMPLE_VISUALS, declaredImplementations, liveImplementations, loadCapabilityRegistry, loadVisualCapabilities, type RegistrySources } from "./index.js";
import { adviseFeasibility as advise, type AdvisoryInput } from "@digikon/director";
import { assets, goodStoryboard, learnProject, learnStoryboard, learnStoryboardWithAudio, project, recipes, root } from "../../director/src/fixtures.js";

const capDir = join(root(""), "capabilities");
const learned = loadCapabilityRegistry(capDir, { dependency: () => null, recipes: { get: (id) => recipes.find((r) => r.recipe_id === id) } });
const visual = loadVisualCapabilities(capDir);
const DECL = declaredImplementations(learned.usable);
const build = (over: Partial<RegistrySources> = {}) => CapabilityRegistry.from({ recipes, learned, visual, implementations: liveImplementations(DECL), declared: DECL, ...over });
const reg = build();
const adviseFeasibility = (r: CapabilityRegistry, i: AdvisoryInput) => advise(r.snapshot, i);
const ALL: Renderer[] = ["ffmpeg", "remotion", "hyperframes"];
const plan = (raw: { scenes: Record<string, unknown>[] }, project_id: string): ScenePlan => {
  let t = 0;
  return ScenePlan.parse({ project_id, version: 1, scenes: raw.scenes.map((s) => {
    const start = t; t += s.duration_seconds as number;
    const base = Scene.parse({ ...s, start_time: start, end_time: t, production_method: null });
    return { ...base, production_method: deriveProductionMethod(base) };
  }) });
};
const coffee = plan(goodStoryboard, "coffee1");
const explainer = plan(learnStoryboard(), "learn1");
const inp = (over: Partial<AdvisoryInput> = {}): AdvisoryInput => ({ scenePlan: coffee, assets, aspect_ratio: project.aspect_ratio, available_engines: ALL, ...over });
const reqs = (r: ReturnType<typeof adviseFeasibility>) => r.scenes.flatMap((s) => s.requirements);

describe("advisory feasibility looks at storyboard requirements only", () => {
  const r = adviseFeasibility(reg, inp());
  it("states what each scene requires and whether live-resolved capabilities could carry it out", () => {
    expect(AdvisoryReport.safeParse(r).success).toBe(true);
    expect(r.scenes.map((s) => s.scene_id)).toEqual(["S01", "S02", "S03"]);
    expect(r.summary.not_producible, r.warnings.join("\n")).toBe(0);
    expect(reqs(r).map((x) => x.kind)).toEqual(expect.arrayContaining(["scene_picture", "on_screen_text", "transition"]));
    expect(reqs(r).every((x) => x.candidate_count > 0)).toBe(true);
  });
  it("selects nothing: no recipe id, capability id or template appears anywhere in the report", () => {
    const text = JSON.stringify(r);
    for (const rec of recipes.filter((x) => x.recipe_id !== "crossfade")) expect(text, rec.recipe_id).not.toContain(rec.recipe_id); // "crossfade" is the storyboard's own word for the transition it asks for
    for (const c of reg.snapshot.capabilities) { expect(text).not.toContain(c.capability_id); if (c.implementation_ref) expect(text).not.toContain(c.implementation_ref); }
    expect(text).not.toMatch(/(ffmpeg|remotion|hyperframes)[:/][a-z]/);
  });
  it("needs no edit plan: its input has none, and the result does not depend on one", () => {
    expect(Object.keys(inp())).not.toContain("editPlan");
  });
  it("counts candidates, it does not name a winner", () => {
    for (const x of reqs(r)) expect(x.details.join(" ")).toMatch(/none is selected yet|visual block is live-resolved|no live-resolved/);
  });
  it("authorizes nothing and mutates nothing; the same inputs give the same report", () => {
    const before = JSON.stringify(reg.snapshot), sb = JSON.stringify(coffee);
    const a = JSON.stringify(adviseFeasibility(reg, inp())), b = JSON.stringify(adviseFeasibility(build(), inp()));
    expect(a).toBe(b);
    expect(JSON.stringify(reg.snapshot)).toBe(before);
    expect(JSON.stringify(coffee)).toBe(sb);
  });
});

describe("registered is not producible", () => {
  it("with no live adapter nothing is producible, even though every capability is registered", () => {
    const none = build({ implementations: {}, adapter_failures: ALL.map((engine) => ({ engine, reason: "not here" })) });
    expect(none.counts().registered).toBe(54);
    const r = adviseFeasibility(none, inp({ available_engines: [] }));
    expect(r.summary.producible).toBe(0);
    expect(r.summary.not_producible).toBeGreaterThan(0);
    expect(r.limitations.join(" ")).toContain("no rendering engine is available");
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("a capability that is only declared by the code tables is not counted", () => {
    const impl = { ...liveImplementations(DECL, ["ffmpeg"]) } as Record<string, readonly string[]>;
    delete impl["ffmpeg/clip-play"]; // declared in the tables, but no live adapter registers it
    const r = adviseFeasibility(build({ implementations: impl as never }), inp());
    const video = reqs(r).find((x) => x.kind === "scene_picture" && x.description.includes("video"))!;
    expect(video.verdict).toBe("not_producible");
    expect(video.candidate_count).toBe(0);
    expect(adviseFeasibility(reg, inp()).scenes[0]!.requirements.find((x) => x.kind === "scene_picture")!.candidate_count).toBeGreaterThan(0);
  });
  it("an engine that is not available is not counted even if its capabilities are live elsewhere in the registry", () => {
    const count = (engines: Renderer[]) => adviseFeasibility(reg, inp({ available_engines: engines })).scenes[0]!.requirements.find((x) => x.kind === "scene_picture")!.candidate_count;
    expect(count(["ffmpeg"])).toBeLessThan(count(ALL));
    expect(count([])).toBe(0);
  });
});

describe("requirements that cannot be met are reported with warnings", () => {
  it("supplied material that is missing", () => {
    const sp = plan({ scenes: [{ ...(goodStoryboard.scenes[0] as Record<string, unknown>), required_assets: [{ need: "Real shop footage", kind: "footage", availability: "needs_external", fallback: null }] }, goodStoryboard.scenes[1]!, goodStoryboard.scenes[2]!] }, "coffee1");
    const r = adviseFeasibility(reg, inp({ scenePlan: sp }));
    expect(reqs(r).some((x) => x.kind === "external_asset" && x.verdict === "not_producible" && x.reasons.includes("EXTERNAL_ASSET_MISSING"))).toBe(true);
    expect(r.warnings.join(" ")).toContain("Consider changing the storyboard");
  });
  it("a transition nothing live can draw", () => {
    const impl = { ...liveImplementations(DECL), "ffmpeg/xfade-fade": [] } as never;
    const r = adviseFeasibility(build({ implementations: impl }), inp());
    expect(reqs(r).some((x) => x.kind === "transition" && x.verdict === "not_producible" && x.reasons.includes("TRANSITION_NOT_EXECUTABLE"))).toBe(true);
  });
  it("audio is a limitation and an uncertain requirement, never a producible one", () => {
    const r = adviseFeasibility(reg, inp({ scenePlan: plan(learnStoryboardWithAudio(), "learn1"), assets: [], aspect_ratio: learnProject.aspect_ratio }));
    const audio = reqs(r).find((x) => x.kind === "audio")!;
    expect(audio).toMatchObject({ verdict: "uncertain", candidate_count: 0, reasons: ["AUDIO_NOT_PRODUCED"] });
    expect(r.limitations.join(" ")).toContain("S06: audio is not produced yet");
  });
  it("a graphics-only scene with text", () => {
    const r = adviseFeasibility(reg, inp({ scenePlan: explainer, assets: [], aspect_ratio: learnProject.aspect_ratio }));
    expect(reqs(r).filter((x) => x.kind === "graphics_scene").length).toBeGreaterThan(0);
    expect(r.scenes.find((s) => s.scene_id === "S01")!.requirements.some((x) => x.kind === "on_screen_text")).toBe(true);
  });
});

describe("drawn visuals", () => {
  const sc = learnStoryboard().scenes[0] as Record<string, unknown>;
  const drawn = plan({ scenes: [{ ...sc, visual: EXAMPLE_VISUALS.kinetic_type.visual, duration_seconds: 4 }] }, "learn1");
  const run = (r: CapabilityRegistry, over: Partial<AdvisoryInput> = {}) => adviseFeasibility(r, inp({ scenePlan: drawn, assets: [], aspect_ratio: "16:9", ...over })).scenes[0]!.requirements.find((x) => x.kind === "visual_block")!;
  it("a block with a current validation record is producible; its limits are stated", () => {
    const current = build({ visual: visual.map((v) => ({ ...v, usable: true, reason: "validated" })) });
    const x = run(current);
    expect(x.verdict).toBe("producible");
    expect(x.details.join(" ")).toContain("no current render has verified it");
  });
  it("a block whose validation record is stale is uncertain, not producible", () => {
    const x = run(build({ visual: visual.map((v) => ({ ...v, usable: false, reason: "the drawing code changed" })) }));
    expect(x.verdict).toBe("uncertain");
    expect(x.reasons.join(" ")).toContain("HISTORICAL_EVIDENCE");
  });
  it("a block with no live composition adapter is not producible", () => {
    const impl = { ...liveImplementations(DECL) } as Record<string, readonly string[]>;
    delete impl["remotion/scene-composition"];
    expect(run(build({ implementations: impl as never })).verdict).toBe("not_producible");
    expect(run(reg, { available_engines: ["ffmpeg"] }).verdict).toBe("not_producible");
  });
});
