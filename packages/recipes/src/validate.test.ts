import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Asset, EditPlan, Project, Scene, ScenePlan } from "@digikon/contracts";
import { RecipeLibrary, loadRecipes, validateEditPlan, resolveParams } from "./index.js";

const recipes = loadRecipes(fileURLToPath(new URL("../../../recipes", import.meta.url)));
const lib = new RecipeLibrary(recipes, "draft");

const project = Project.parse({
  project_id: "p1", owner_id: "u1", brief: "b", objective: "o", audience: "a",
  platform: "instagram", aspect_ratio: "9:16", target_duration: 30,
});
const assets = [
  Asset.parse({ asset_id: "asset_video", uri: "v.mp4", media_type: "video", duration: 20, width: 1080, height: 1920 }),
  Asset.parse({ asset_id: "asset_logo", uri: "l.png", media_type: "image", duration: null, width: 500, height: 500 }),
];
const scene = (id: string, start: number, dur: number, assetIds: string[], overlay: string | null = null) =>
  Scene.parse({
    scene_id: id, purpose: "p", start_time: start, duration_seconds: dur, asset_ids: assetIds,
    shot: { shot_size: "close_up", camera_motion: "static", visual_action: "x" }, transition_out: "cut",
    overlay: overlay ? { text: overlay, safe_area: "platform_safe" } : null,
  });
const scenes = ScenePlan.parse({
  project_id: "p1", version: 1,
  scenes: [scene("S01", 0, 4, ["asset_video"]), scene("S02", 4, 4, ["asset_video"], "Fresh daily"), scene("S03", 8, 3, ["asset_logo"], "Buy now"), scene("S04", 11, 1, ["asset_video"])],
});
const edit = (...uses: { scene: string; recipe: string; params?: Record<string, number | string | boolean> }[]) =>
  EditPlan.parse({
    project_id: "p1", version: 1,
    uses: uses.map((u, i) => ({ use_id: `U${String(i + 1).padStart(2, "0")}`, scene_id: u.scene, recipe_id: u.recipe, params: u.params ?? {}, rationale: "r" })),
  });
const codes = (e: ReturnType<typeof edit>) => validateEditPlan(e, scenes, lib, project, assets).map((i) => i.code);

describe("starter recipe library", () => {
  it("loads 15 to 20 valid recipes covering every type", () => {
    expect(recipes.length).toBeGreaterThanOrEqual(15);
    expect(recipes.length).toBeLessThanOrEqual(30); // was 20 before the FFmpeg scene templates added five draft recipes; the library is still small enough to review by hand
    expect(new Set(recipes.map((r) => r.type))).toEqual(new Set(["shot", "camera_move", "transition", "animation", "sound_cue"]));
  });
  it("is empty in production mode until recipes are reviewed", () => {
    expect(new RecipeLibrary(recipes, "reviewed").available()).toEqual([]);
  });
  it("fills defaults", () => {
    const r = lib.get("slow-push-in")!;
    expect(resolveParams(r, { scale_end: 1.2 })).toEqual({ scale_end: 1.2, easing: "ease_in_out" });
  });
});

describe("recipe invariants", () => {
  // A recipe used with no parameters must be valid for every scene length it claims to support.
  it.each(recipes.map((r) => [r.recipe_id, r] as const))("%s: defaults satisfy its own rules at its shortest scene", (_id, r) => {
    const dflt = Object.fromEntries(r.parameters.map((p) => [p.name, p.default]));
    const shortest = r.constraints.min_duration_s;
    for (const rule of r.validation_rules) {
      if (rule.kind === "param_lte_scene_duration") expect(Number(dflt[rule.param]), rule.message).toBeLessThanOrEqual(shortest + 1e-9);
      if (rule.kind === "param_lte_duration_fraction") expect(Number(dflt[rule.param]), rule.message).toBeLessThanOrEqual(rule.fraction * shortest + 1e-9);
      if (rule.kind === "param_less_than") expect(Number(dflt[rule.lesser]), rule.message).toBeLessThan(Number(dflt[rule.greater]));
    }
  });
});

describe("validateEditPlan", () => {
  it("accepts a valid plan", () => {
    expect(codes(edit({ scene: "S01", recipe: "slow-push-in", params: { scale_end: 1.12 } }, { scene: "S02", recipe: "text-fade-up" }))).toEqual([]);
  });
  it("rejects unknown recipes and scenes", () => {
    expect(codes(edit({ scene: "S01", recipe: "invented-spin" }))).toContain("unknown_recipe");
    expect(codes(edit({ scene: "S09", recipe: "slow-push-in" }))).toContain("unknown_scene");
  });
  it("rejects out-of-range, wrong-type and unknown parameters", () => {
    expect(codes(edit({ scene: "S01", recipe: "slow-push-in", params: { scale_end: 2 } }))).toContain("param_out_of_range");
    expect(codes(edit({ scene: "S01", recipe: "slow-push-in", params: { easing: "bounce" } }))).toContain("bad_enum");
    expect(codes(edit({ scene: "S01", recipe: "slow-push-in", params: { scale_end: "big" } }))).toContain("bad_param_type");
    expect(codes(edit({ scene: "S01", recipe: "slow-push-in", params: { spin: 1 } }))).toContain("unknown_param");
  });
  it("enforces maximum uses per film", () => {
    const e = edit(
      { scene: "S01", recipe: "punch-in-emphasis" }, { scene: "S02", recipe: "punch-in-emphasis" }, { scene: "S01", recipe: "punch-in-emphasis" },
    );
    expect(codes(e)).toContain("max_uses");
  });
  it("rejects a recipe on an incompatible media type", () => {
    expect(codes(edit({ scene: "S03", recipe: "slow-push-in" }))).toEqual([]); // image is allowed
    expect(codes(edit({ scene: "S03", recipe: "j-cut-audio-lead" }))).toContain("incompatible_media"); // needs video
  });
  it("applies recipe rules", () => {
    expect(codes(edit({ scene: "S01", recipe: "text-fade-up" }))).toContain("rule_violated"); // S01 has no overlay text
    expect(codes(edit({ scene: "S03", recipe: "end-card-cta", params: { hold_s: 4 } }))).toContain("rule_violated"); // hold 4s > scene 3s
    expect(codes(edit({ scene: "S03", recipe: "end-card-cta", params: { hold_s: 2.5 } }))).toEqual([]);
    expect(codes(edit({ scene: "S03", recipe: "crossfade", params: { duration_s: 1.5 } }))).toEqual([]); // exactly half of 3s
    expect(codes(edit({ scene: "S03", recipe: "crossfade", params: { duration_s: 1.6 } }))).toContain("rule_violated");
  });
  it("rejects scene durations outside the recipe's range", () => {
    expect(codes(edit({ scene: "S04", recipe: "slow-push-in" }))).toContain("scene_duration"); // 1s scene, recipe needs >= 1.5s
  });
  it("rejects a video scene for an image-only recipe", () => {
    expect(codes(edit({ scene: "S02", recipe: "end-card-cta" }))).toContain("incompatible_media");
  });
  it("rejects a recipe that does not support the project's aspect ratio", () => {
    const wide = Project.parse({ ...project, aspect_ratio: "16:9" });
    const lib2 = new RecipeLibrary(
      recipes.map((r) => (r.recipe_id === "slow-push-in" ? { ...r, compatibility: { ...r.compatibility, aspect_ratios: ["9:16" as const] } } : r)),
      "draft",
    );
    const issues = validateEditPlan(edit({ scene: "S01", recipe: "slow-push-in" }), scenes, lib2, wide, assets);
    expect(issues.map((i) => i.code)).toContain("incompatible_aspect");
  });
  it("rejects draft recipes in production mode", () => {
    const prod = new RecipeLibrary(recipes, "reviewed");
    const issues = validateEditPlan(edit({ scene: "S01", recipe: "slow-push-in" }), scenes, prod, project, assets);
    expect(issues.map((i) => i.code)).toEqual(["recipe_not_available"]);
  });
});
