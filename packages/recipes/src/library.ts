import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Recipe, type RecipeParam } from "@digikon/contracts";
export type RecipeStatusFloor = "draft" | "reviewed";

/** Reads every recipes/<type>/<id>.json, parses it and checks id and folder consistency. Throws on the first bad file. */
export function loadRecipes(dir: string): Recipe[] {
  const out: Recipe[] = [];
  const ids = new Set<string>();
  for (const type of readdirSync(dir)) {
    const typeDir = join(dir, type);
    if (!statSync(typeDir).isDirectory()) continue;
    for (const file of readdirSync(typeDir)) {
      if (!file.endsWith(".json")) continue;
      const path = join(typeDir, file);
      const parsed = Recipe.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.success) {
        throw new Error(`Invalid recipe ${path}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      }
      const r = parsed.data;
      if (basename(file, ".json") !== r.recipe_id) throw new Error(`${path}: file name must equal recipe_id (${r.recipe_id})`);
      if (type !== r.type) throw new Error(`${path}: folder "${type}" does not match type "${r.type}"`);
      if (ids.has(r.recipe_id)) throw new Error(`Duplicate recipe_id ${r.recipe_id}`);
      ids.add(r.recipe_id);
      out.push(r);
    }
  }
  return out.sort((a, b) => a.recipe_id.localeCompare(b.recipe_id));
}

/**
 * The set of recipes the Director may use. `minStatus: "reviewed"` is the production setting;
 * "draft" is for development until templates have been test-rendered and reviewed.
 */
export class RecipeLibrary {
  private readonly byId = new Map<string, Recipe>();
  constructor(
    recipes: Recipe[],
    readonly minStatus: RecipeStatusFloor = "reviewed",
  ) {
    for (const r of recipes) this.byId.set(r.recipe_id, r);
  }

  /** Every recipe, ignoring status. Used by the validator to give a precise error for draft recipes. */
  get(id: string): Recipe | undefined {
    return this.byId.get(id);
  }

  /** Every recipe whatever its status. For the capability registry, which must account for all of them. */
  all(): Recipe[] {
    return [...this.byId.values()];
  }

  isAvailable(r: Recipe): boolean {
    return this.minStatus === "draft" || r.status === "reviewed";
  }

  available(): Recipe[] {
    return [...this.byId.values()].filter((r) => this.isAvailable(r));
  }
}

export interface RecipeReadiness {
  /** True only for a reviewed recipe with a review record. No recipe is production-ready on its own say-so. */
  production_ready: boolean;
  evidence: "none" | "review_record";
  reason: string;
}

/** Whether a recipe has evidence behind it. A draft recipe, or a reviewed one with no record, is never production-ready. */
export function recipeReadiness(r: Recipe): RecipeReadiness {
  if (r.status === "reviewed" && r.review) {
    return { production_ready: true, evidence: "review_record", reason: `reviewed by ${r.review.reviewed_by} on ${r.review.reviewed_at.slice(0, 10)}: ${r.review.evidence}` };
  }
  return { production_ready: false, evidence: "none", reason: `${r.recipe_id} is ${r.status}: no review evidence` };
}

/** Fills defaults for parameters the model left out. Does not validate; use validateEditPlan for that. */
export function resolveParams(recipe: Recipe, params: Record<string, number | string | boolean>) {
  const out: Record<string, number | string | boolean> = {};
  for (const p of recipe.parameters) out[p.name] = p.name in params ? params[p.name]! : p.default;
  return out;
}

export function describeParam(p: RecipeParam): string {
  switch (p.kind) {
    case "number": return `${p.name} (${p.unit}, ${p.min} to ${p.max}, default ${p.default})`;
    case "enum": return `${p.name} (one of ${p.options.join(" | ")}, default ${p.default})`;
    case "string": return `${p.name} (text up to ${p.max_length} chars)`;
    case "boolean": return `${p.name} (true/false, default ${p.default})`;
  }
}
