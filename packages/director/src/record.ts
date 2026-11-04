import type { DirectorStateType } from "./graph.js";
import { currentEditPlan, currentStoryboard } from "./approvals.js";
import type { RecipeLibrary } from "@digikon/recipes";
import type { SkillLibrary } from "./skills.js";

/** Everything needed to reproduce or audit a run: which model, skills, recipes and documents shaped the plan, and who approved which version. */
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
    video_type: state.chosenVideoType ?? null,
    proposed_video_types: state.proposedVideoTypes ?? [],
    skills: state.skillsUsed.map((n) => {
      try {
        const s = ctx.skills.get(n);
        return `${n}@${s.version}`;
      } catch {
        return `${n}@1.0.0`;
      }
    }),
    references: state.referencesUsed,
    recipes_used: used,
    retrieved_ids: state.citations,
    recipe_library_mode: ctx.library.minStatus,
    plans: { storyboard: currentStoryboard(state), edit_plan: currentEditPlan(state) },
    revisions_used: state.revisions,
    approvals: state.approvals,
    trace: state.trace,
  };
}
