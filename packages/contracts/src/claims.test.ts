import { describe, expect, it } from "vitest";
import { Asset, AssetNotes, Claim, Project, Recipe, Scene, ScenePlan, validatePlan } from "./index.js";

const project = Project.parse({
  project_id: "p", owner_id: "u", brief: "b", objective: "o", audience: "a",
  platform: "instagram", aspect_ratio: "9:16", target_duration: 8,
});
const assets = [Asset.parse({ asset_id: "a1", uri: "x.mp4", media_type: "video", duration: 20, width: 1080, height: 1920 })];
const scene = (id: string, start: number, dur: number, extra: Record<string, unknown> = {}) =>
  Scene.parse({
    scene_id: id, purpose: "p", start_time: start, duration_seconds: dur, asset_ids: ["a1"],
    shot: { shot_size: "close_up", camera_motion: "static", visual_action: "x" }, transition_out: "cut", ...extra,
  });
const plan = (...s: ReturnType<typeof scene>[]) => ScenePlan.parse({ project_id: "p", version: 1, scenes: s });
const facts = [{ fact_id: "F01", text: "roasted weekly", source: "sheet" }];
const claims = [
  Claim.parse({ claim_id: "C01", text: "roasted weekly", brand_fact_id: "F01" }),
  Claim.parse({ claim_id: "C02", text: "best in town", brand_fact_id: null }),
  Claim.parse({ claim_id: "C03", text: "ghost fact", brand_fact_id: "F99" }),
];
const codes = (p: ReturnType<typeof plan>, ctx = {}) => validatePlan(p, assets, project, { claims, facts, ...ctx }).map((i) => i.code);

describe("claims checks", () => {
  it("accepts a supported claim", () => {
    expect(codes(plan(scene("S01", 0, 4, { claim_ids: ["C01"] }), scene("S02", 4, 4)))).toEqual([]);
  });
  it("rejects unsupported, unknown-fact and unregistered claims", () => {
    expect(codes(plan(scene("S01", 0, 8, { claim_ids: ["C02"] })))).toContain("unsupported_claim");
    expect(codes(plan(scene("S01", 0, 8, { claim_ids: ["C03"] })))).toContain("unsupported_claim");
    expect(codes(plan(scene("S01", 0, 8, { claim_ids: ["C09"] })))).toContain("unknown_claim");
  });
});

describe("asset use checks", () => {
  const notes = [AssetNotes.parse({ asset_id: "a1", usable_segments: [{ start: 0, end: 4 }, { start: 10, end: 20 }], content_summary: "" })];
  it("rejects a scene outside every usable segment", () => {
    expect(codes(plan(scene("S01", 0, 8, { source_in_seconds: 2 })), { notes })).toContain("unusable_segment"); // 2-10 straddles the gap
  });
  it("accepts a scene fully inside one segment", () => {
    expect(codes(plan(scene("S01", 0, 8, { source_in_seconds: 10 })), { notes })).toEqual([]);
  });
  it("rejects a scene that runs past the end of the source", () => {
    expect(codes(plan(scene("S01", 0, 8, { source_in_seconds: 15 })))).toContain("asset_bounds");
  });
});

describe("timeline length", () => {
  it("flags a plan much shorter than the target", () => {
    expect(codes(plan(scene("S01", 0, 4)))).toContain("under_duration");
  });
});

describe("Recipe schema", () => {
  const base = {
    recipe_id: "x-y", version: "0.1.0", type: "transition", title: "t", purpose: "p", intents: ["i"],
    parameters: [{ kind: "number", name: "d", unit: "s", min: 0, max: 1, default: 0.5 }],
    constraints: { min_duration_s: 1, max_duration_s: 5, max_uses_per_film: null, energy: "low" },
    compatibility: { renderers: ["ffmpeg"], aspect_ratios: ["9:16"], media_types: ["video"] },
    implementation_ref: "ffmpeg/x", source: { origin: "original", license: "Digikon original" }, status: "draft",
  };
  it("accepts a valid recipe", () => expect(Recipe.safeParse(base).success).toBe(true));
  it("rejects a default outside its own range", () => {
    expect(Recipe.safeParse({ ...base, parameters: [{ ...base.parameters[0], default: 2 }] }).success).toBe(false);
  });
  it("rejects a rule that names a missing parameter", () => {
    expect(Recipe.safeParse({ ...base, validation_rules: [{ kind: "param_lte_scene_duration", param: "nope", message: "m" }] }).success).toBe(false);
  });
});
