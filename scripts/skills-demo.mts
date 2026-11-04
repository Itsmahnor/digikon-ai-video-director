// npm run skills:demo
// Runs the Director's treatment and storyboard (up to the first approval gate) once per video category with the stub model (DemoClient: canned answers, NOT Claude),
// with skills from examples/skills and the real retriever, and prints which skills each step cited. Nothing is approved, rendered or written to the app's storage.
// Draft skills are allowed for the demo only through SKILLS_INCLUDE_DRAFT=1, which this script sets for itself; the skill files are never edited.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Project } from "@digikon/contracts";
import { DemoClient, SkillLibrary, buildDirectorGraph } from "@digikon/director";
import { KeywordRetriever, loadKnowledge, loadSkillDocs, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const includeDraft = (process.env.SKILLS_INCLUDE_DRAFT ?? "1") === "1";
const recipes = loadRecipes(join(repo, "recipes"));
const skillDocs = loadSkillDocs(join(repo, "examples", "skills"));
const byId = new Map(skillDocs.map((d) => [d.id, d]));
const retriever = new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge")), ...skillDocs]);

const cases = [
  { category: "saas", brief: "30 second product demo of an invoicing app that sends payment reminders automatically.", objective: "Get free trial sign-ups", audience: "Freelancers and small agencies", platform: "LinkedIn" },
  { category: "ecommerce", brief: "20 second showcase of an insulated steel water bottle, with an offer.", objective: "Drive first orders", audience: "Hikers and commuters", platform: "Instagram" },
  { category: "general-promo", brief: "20 second announcement that a local bakery is opening a second shop.", objective: "Get people to visit the new shop", audience: "Local residents", platform: "Instagram" },
] as const;

console.log(`Stub model (DemoClient), not Claude. Draft skills ${includeDraft ? "ARE" : "are NOT"} retrievable for this run.\n`);
for (const c of cases) {
  const project = Project.parse({ project_id: `demo-${c.category}`, owner_id: "demo", brief: c.brief, objective: c.objective, audience: c.audience, platform: c.platform, aspect_ratio: "9:16", target_duration: 20, video_category: c.category });
  const graph = buildDirectorGraph({ llm: new DemoClient({ creative: true }), skills: new SkillLibrary(join(repo, "skills")), retriever, recipes: new RecipeLibrary(recipes, "draft"), ...(includeDraft ? { skillsIncludeDraft: true } : {}) });
  const out = await graph.invoke({ project, assets: [], facts: [] }, { configurable: { thread_id: `demo-${c.category}` } });
  const cited = (out.citations as string[]).filter((id) => byId.has(id));
  console.log(`${c.category}: status ${out.status}, gate ${out.gate ?? "none"}, ${out.scenePlan?.scenes.length ?? 0} scenes`);
  console.log(`  skills cited (${cited.length}): ${cited.map((id) => { const m = byId.get(id)!.metadata; return `${id} [${m.skill_category}/${m.skill_scope}]`; }).join(", ") || "none"}`);
  const wrong = cited.filter((id) => ![c.category, "all"].includes(byId.get(id)!.metadata.skill_category!) || byId.get(id)!.metadata.skill_scope === "editor");
  console.log(`  category/scope check: ${wrong.length ? `FAILED (${wrong.join(", ")})` : "ok (only this category and cross-cutting, none Editor-only)"}\n`);
}
