import type { Asset, EditPlan, Project, Recipe, RecipeParam, ScenePlan } from "@digikon/contracts";
import type { RecipeLibrary } from "./library.js";
import { resolveParams } from "./library.js";

export interface EditIssue {
  code:
    | "duplicate_use" | "unknown_scene" | "unknown_recipe" | "recipe_not_available"
    | "unknown_param" | "bad_param_type" | "param_out_of_range" | "bad_enum" | "string_too_long"
    | "scene_duration" | "max_uses" | "incompatible_aspect" | "incompatible_media" | "rule_violated";
  use_id: string;
  scene_id: string;
  message: string;
}

const EPS = 1e-6;

function checkParam(p: RecipeParam, v: unknown): { code: EditIssue["code"]; message: string } | null {
  switch (p.kind) {
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return { code: "bad_param_type", message: `${p.name} must be a number` };
      if (v < p.min - EPS || v > p.max + EPS) return { code: "param_out_of_range", message: `${p.name}=${v} outside ${p.min}..${p.max} ${p.unit}` };
      return null;
    case "enum":
      if (typeof v !== "string") return { code: "bad_param_type", message: `${p.name} must be a string` };
      return p.options.includes(v) ? null : { code: "bad_enum", message: `${p.name}="${v}" not one of ${p.options.join(", ")}` };
    case "string":
      if (typeof v !== "string") return { code: "bad_param_type", message: `${p.name} must be a string` };
      return v.length <= p.max_length ? null : { code: "string_too_long", message: `${p.name} longer than ${p.max_length} characters` };
    case "boolean":
      return typeof v === "boolean" ? null : { code: "bad_param_type", message: `${p.name} must be true or false` };
  }
}

/**
 * Checks that every recipe use is real, compatible with its scene and inside the recipe's own limits.
 * Returns [] when the edit plan can be handed to the render step.
 */
export function validateEditPlan(
  edit: EditPlan,
  scenes: ScenePlan,
  library: RecipeLibrary,
  project: Project,
  assets: Asset[],
): EditIssue[] {
  const issues: EditIssue[] = [];
  const sceneById = new Map(scenes.scenes.map((s) => [s.scene_id, s]));
  const assetById = new Map(assets.map((a) => [a.asset_id, a]));
  const useCount = new Map<string, number>();
  const seenUse = new Set<string>();

  for (const use of edit.uses) {
    const add = (code: EditIssue["code"], message: string) =>
      issues.push({ code, use_id: use.use_id, scene_id: use.scene_id, message });

    if (seenUse.has(use.use_id)) add("duplicate_use", `duplicate use_id ${use.use_id}`);
    seenUse.add(use.use_id);

    const scene = sceneById.get(use.scene_id);
    if (!scene) { add("unknown_scene", `scene ${use.scene_id} is not in the scene plan`); continue; }

    const recipe: Recipe | undefined = library.get(use.recipe_id);
    if (!recipe) { add("unknown_recipe", `recipe ${use.recipe_id} does not exist`); continue; }
    if (!library.isAvailable(recipe)) {
      add("recipe_not_available", `recipe ${recipe.recipe_id} is ${recipe.status}; library requires ${library.minStatus}`);
      continue;
    }

    useCount.set(recipe.recipe_id, (useCount.get(recipe.recipe_id) ?? 0) + 1);

    const known = new Map(recipe.parameters.map((p) => [p.name, p]));
    for (const name of Object.keys(use.params)) {
      if (!known.has(name)) add("unknown_param", `${recipe.recipe_id} has no parameter "${name}"`);
    }
    for (const p of recipe.parameters) {
      if (!(p.name in use.params)) continue; // defaults are valid by construction
      const problem = checkParam(p, use.params[p.name]);
      if (problem) add(problem.code, problem.message);
    }

    const { min_duration_s, max_duration_s } = recipe.constraints;
    if (scene.duration_seconds < min_duration_s - EPS || scene.duration_seconds > max_duration_s + EPS) {
      add("scene_duration", `scene lasts ${scene.duration_seconds}s; ${recipe.recipe_id} needs ${min_duration_s}..${max_duration_s}s`);
    }

    if (!recipe.compatibility.aspect_ratios.includes(project.aspect_ratio)) {
      add("incompatible_aspect", `${recipe.recipe_id} does not support ${project.aspect_ratio}`);
    }

    const sceneMedia = new Set(scene.asset_ids.map((id) => assetById.get(id)?.media_type).filter((m): m is Asset["media_type"] => !!m));
    const wanted = new Set(recipe.compatibility.media_types);
    const hasMedia = scene.asset_ids.length > 0;
    const ok = hasMedia ? [...sceneMedia].some((m) => wanted.has(m)) : wanted.has("none");
    if (!ok) add("incompatible_media", `${recipe.recipe_id} needs ${[...wanted].join("/")} but scene has ${hasMedia ? [...sceneMedia].join("/") : "no media"}`);

    const full = resolveParams(recipe, use.params);
    for (const rule of recipe.validation_rules) {
      let violated = false;
      switch (rule.kind) {
        case "requires_overlay_text": violated = !scene.overlay || scene.overlay.text.trim() === ""; break;
        case "requires_asset": violated = scene.asset_ids.length === 0; break;
        case "param_lte_scene_duration": violated = Number(full[rule.param]) > scene.duration_seconds + EPS; break;
        case "param_lte_duration_fraction": violated = Number(full[rule.param]) > rule.fraction * scene.duration_seconds + EPS; break;
        case "param_less_than": violated = !(Number(full[rule.lesser]) < Number(full[rule.greater])); break;
      }
      if (violated) add("rule_violated", rule.message);
    }
  }

  for (const [id, n] of useCount) {
    const max = library.get(id)?.constraints.max_uses_per_film;
    if (max != null && n > max) {
      const last = [...edit.uses].reverse().find((u) => u.recipe_id === id)!;
      issues.push({ code: "max_uses", use_id: last.use_id, scene_id: last.scene_id, message: `${id} used ${n} times; limit is ${max} per film` });
    }
  }
  return issues;
}
