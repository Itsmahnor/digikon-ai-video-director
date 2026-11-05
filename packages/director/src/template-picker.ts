import type { Asset, Project, ScenePlan } from "@digikon/contracts";
import { mediaOf, type Deps } from "./nodes.js";

/**
 * TEMPORARY template picker. For one scene it offers 3 to 5 recipes found by retrieval; the user may pick one or skip. A pick is only a hint to the edit plan (the model may use it
 * when it is a candidate that fits, and ignores it otherwise), so it cannot add a recipe the library does not offer or change a gate. To be removed once the Editor chooses well.
 */
export interface TemplateOption { recipe_id: string; type: string; purpose: string }

const TYPES = ["animation", "camera_move", "transition"] as const;

export async function templateOptions(deps: Pick<Deps, "retriever" | "recipes">, project: Pick<Project, "aspect_ratio">, assets: readonly Asset[], scene: ScenePlan["scenes"][number], max = 5): Promise<TemplateOption[]> {
  const include_draft = deps.recipes.minStatus === "draft";
  const media = mediaOf(scene, [...assets]);
  const text: Record<(typeof TYPES)[number], string> = {
    animation: `${scene.overlay?.text ?? ""} ${scene.purpose} on-screen text`,
    camera_move: `${scene.shot.camera_motion} ${scene.shot.visual_action}`,
    transition: `${scene.purpose} ${scene.transition_out} transition`,
  };
  const found = new Map<string, TemplateOption>();
  for (let round = 0; round < 2 && found.size < max; round++) {
    for (const type of TYPES) {
      const hits = await deps.retriever.retrieve({ text: text[type], collection: "shot_recipes", k: 3 + round * 2, max_tokens: 900, filter: { aspect_ratio: project.aspect_ratio, duration_s: scene.duration_seconds, media, include_draft, recipe_type: type } });
      for (const h of hits) {
        const r = deps.recipes.get(h.doc.id);
        if (r && deps.recipes.isAvailable(r) && !found.has(r.recipe_id) && found.size < max) found.set(r.recipe_id, { recipe_id: r.recipe_id, type: r.type, purpose: r.purpose });
      }
    }
  }
  return [...found.values()];
}