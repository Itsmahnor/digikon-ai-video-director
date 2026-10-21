import type { DirectorStateType } from "./graph.js";
import type { RecipeLibrary } from "@digikon/recipes";
import type { SkillLibrary } from "./skills.js";

/** Everything needed to reproduce or audit a run: which model, skills, recipes and documents shaped the plan. */
export function buildRunRecord(
  state: DirectorStateType,
  ctx: { model: string; skills: SkillLibrary; library: RecipeLibrary },
) {
  const used = [...new Set((state.editPlan?.uses ?? []).map((u) => u.recipe_id))].map((id) => {
    const r = ctx.library.get(id);
    return `${id}@${r?.version} (${r?.status})`;
  });
  return {
    project_id: state.project.project_id,
    finished_at: new Date().toISOString(),
    status: state.status,
    model: ctx.model,
    skills: state.skillsUsed.map((n) => `${n}@${ctx.skills.get(n).version}`),
    references: state.referencesUsed,
    recipes_used: used,
    retrieved_ids: state.citations,
    recipe_library_mode: ctx.library.minStatus,
    trace: state.trace,
  };
}
