import { SCENE_CATEGORIES, SUPPORT_CATEGORIES, type TemplateCategory } from "@digikon/contracts";
import type { CategoryRow } from "@digikon/rag";

export const GROUPS = { scene: "Scene templates", support: "Supporting templates" } as const;

export const CATEGORY_INFO: Record<TemplateCategory, { name: string; description: string }> = {
  hook: { name: "Hook", description: "Opening scenes that earn the first seconds: a claim, a question, a number or a contrast." },
  problem: { name: "Problem", description: "Scenes that name what is wrong or what it costs before the answer arrives." },
  solution_reveal: { name: "Solution reveal", description: "The moment the answer, product or idea arrives." },
  ui_demo: { name: "UI demo", description: "Scenes that show a product interface working, drawn from shapes and a cursor." },
  feature_highlight: { name: "Feature highlight", description: "One feature or a small set of features, named and shown." },
  process: { name: "Process", description: "Steps, timelines and checklists that show how something works." },
  data_proof: { name: "Data proof", description: "Numbers, counters and comparisons that back a claim." },
  comparison: { name: "Comparison", description: "Before and after, this versus that, side by side." },
  social_proof: { name: "Social proof", description: "Quotes, ratings and names that show others rely on it." },
  brand_moment: { name: "Brand moment", description: "Wordmark and tagline scenes that sign a film or a section." },
  transition_beat: { name: "Transition beat", description: "Short scenes that mark a change of idea or a chapter." },
  cta_end: { name: "CTA and end", description: "Closing scenes that ask for one action and sign off." },
  kinetic_type: { name: "Kinetic type", description: "Text-only motion: words, characters and lines arriving with character." },
  transitions: { name: "Transitions", description: "Overlay motions that carry a cut: wipes, irises, stripes." },
  backgrounds: { name: "Backgrounds", description: "Moving shape backgrounds that sit behind other scenes." },
  camera_moves: { name: "Camera moves", description: "Scenes defined by a camera push, pull, pan, tilt or roll over simple content." },
  charts: { name: "Charts", description: "Bars and progress drawn from numbers." },
  lower_thirds_captions: { name: "Lower thirds and captions", description: "Names, titles and caption treatments that sit over footage." },
};

/** Rows for the template_categories table: two group rows, then the eighteen categories under them. */
export function categoryRows(): CategoryRow[] {
  const rows: CategoryRow[] = [{ id: "scene", name: GROUPS.scene, parent_id: null, description: "Whole scenes with a job in the story." }, { id: "support", name: GROUPS.support, parent_id: null, description: "Motion, type and layout pieces used inside or between scenes." }];
  for (const c of SCENE_CATEGORIES) rows.push({ id: c, name: CATEGORY_INFO[c].name, parent_id: "scene", description: CATEGORY_INFO[c].description });
  for (const c of SUPPORT_CATEGORIES) rows.push({ id: c, name: CATEGORY_INFO[c].name, parent_id: "support", description: CATEGORY_INFO[c].description });
  return rows;
}
