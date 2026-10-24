import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RECIPE_OPERATIONS, Recipe } from "@digikon/contracts";
import { RecipeLibrary, loadRecipes, recipeReadiness } from "./index.js";

const recipes = loadRecipes(fileURLToPath(new URL("../../../recipes", import.meta.url)));
const base = recipes.find((r) => r.recipe_id === "slow-push-in")!;
const parse = (over: Record<string, unknown>) => Recipe.safeParse({ ...base, ...over });
const message = (over: Record<string, unknown>) => {
  const r = parse(over);
  return r.success ? "" : r.error.issues.map((i) => i.message).join("; ");
};

describe("recipe and edit-operation compatibility", () => {
  it("gives every shipped recipe an operation its recipe type allows", () => {
    expect(recipes).toHaveLength(19);
    for (const r of recipes) expect(RECIPE_OPERATIONS[r.type], r.recipe_id).toContain(r.operation_type);
  });

  it("maps each recipe type to the operations it can become", () => {
    expect(RECIPE_OPERATIONS).toEqual({
      shot: ["trim_clip"], camera_move: ["trim_clip"], transition: ["concat", "mix_audio"],
      animation: ["overlay_text", "render_graphics_scene"], sound_cue: ["mix_audio"],
    });
    const byId = Object.fromEntries(recipes.map((r) => [r.recipe_id, r.operation_type]));
    expect(byId).toMatchObject({
      "slow-push-in": "trim_clip", "crossfade": "concat", "j-cut-audio-lead": "mix_audio", "text-fade-up": "overlay_text",
      "end-card-cta": "render_graphics_scene", "logo-reveal": "render_graphics_scene", "loudness-normalise": "mix_audio",
    });
  });

  it("rejects an incompatible operation and a missing one", () => {
    expect(message({ operation_type: "overlay_text" })).toContain("a camera_move recipe cannot become a overlay_text operation");
    expect(message({ operation_type: "mix_audio" })).toContain("allowed: trim_clip");
    expect(parse({ operation_type: undefined }).success).toBe(false);
    expect(parse({ operation_type: "export_everything" }).success).toBe(false);
  });

  it("rejects an implementation that names a renderer the recipe does not list", () => {
    expect(message({ implementation_ref: "premiere/slow-push-in" })).toContain("names a renderer that compatibility.renderers does not list");
    expect(message({ compatibility: { ...base.compatibility, renderers: ["ffmpeg"] }, implementation_ref: "remotion/slow-push-in" })).toContain("renderer");
  });

  it("keeps every shipped recipe a draft with no review evidence, and says so", () => {
    for (const r of recipes) {
      expect(r.status, r.recipe_id).toBe("draft");
      const ready = recipeReadiness(r);
      expect(ready).toEqual({ production_ready: false, evidence: "none", reason: `${r.recipe_id} is draft: no review evidence` });
    }
    expect(new RecipeLibrary(recipes, "reviewed").available()).toEqual([]);
  });

  it("accepts the reviewed label only with a review record, and only then counts it as evidence", () => {
    expect(message({ status: "reviewed" })).toContain("a reviewed recipe needs a review record");
    const review = { reviewed_by: "A. Reviewer", reviewed_at: "2026-10-24T09:00:00.000Z", evidence: "test render rendered/slow-push-in.mp4 inspected" };
    const parsed = parse({ status: "reviewed", review });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(recipeReadiness(parsed.data)).toMatchObject({ production_ready: true, evidence: "review_record" });
      expect(new RecipeLibrary([parsed.data], "reviewed").available()).toHaveLength(1);
    }
    expect(message({ status: "reviewed", review: { ...review, evidence: "" } })).toContain("String must contain at least 1 character");
  });
});
