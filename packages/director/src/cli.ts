import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Asset, AssetNotes, BrandFact, Project } from "@digikon/contracts";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import { z } from "zod";
import { AnthropicClient } from "./llm.js";
import { approveCurrent, buildDirectorGraph, gateDecision } from "./graph.js";
import { buildRunRecord } from "./record.js";
import { SkillLibrary } from "./skills.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const readJson = <T,>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T => {
  const parsed = schema.safeParse(JSON.parse(readFileSync(resolve(path), "utf8")));
  if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return parsed.data;
};
const write = (dir: string, name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data, null, 2) + "\n", "utf8");

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) delete process.env.ANTHROPIC_API_KEY; // an empty value would block .env from loading
  try { process.loadEnvFile(join(repoRoot, ".env")); } catch { /* .env is optional; the key may come from the environment */ }
  const projectPath = arg("project");
  const assetsPath = arg("assets");
  if (!projectPath || !assetsPath) {
    console.log("Usage: npm run director -- --project project.json --assets assets.json [--facts facts.json] [--notes notes.json] [--draft] [--yes]");
    console.log("  --draft  allow draft recipes (development until recipes are reviewed)\n  --yes    approve both gates (storyboard, then edit plan) without prompting");
    process.exit(2);
  }

  const project = readJson(projectPath, Project);
  const assets = readJson(assetsPath, z.array(Asset));
  const facts = arg("facts") ? readJson(arg("facts")!, z.array(BrandFact)) : [];
  const notes = arg("notes") ? readJson(arg("notes")!, z.array(AssetNotes)) : [];

  const llm = new AnthropicClient();
  const recipes = loadRecipes(join(repoRoot, "recipes"));
  const library = new RecipeLibrary(recipes, flag("draft") ? "draft" : "reviewed");
  const skills = new SkillLibrary(join(repoRoot, "skills"));
  const retriever = new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repoRoot, "knowledge"))]);
  const graph = buildDirectorGraph({ llm, skills, retriever, recipes: library });
  const config = { configurable: { thread_id: `${project.project_id}-${Date.now()}` } };

  console.log(`Director running for "${project.project_id}" with model ${llm.model}`);
  let state = await graph.invoke({ project, assets, facts, notes }, config);
  for (const line of state.trace) console.log(`  ${line}`);

  const outDir = join(repoRoot, "storage", project.project_id);
  mkdirSync(outDir, { recursive: true });

  if (state.status === "needs_clarification") {
    console.log("\nThe brief needs answers before planning:");
    for (const q of state.intakeResult?.questions ?? []) console.log(`  - ${q}`);
    return;
  }
  if (state.status === "escalated") {
    write(outDir, "escalation.json", state.escalation);
    console.log("\nEscalated to a human. See storage/" + project.project_id + "/escalation.json");
    console.log(JSON.stringify(state.escalation, null, 2));
    process.exitCode = 1;
    return;
  }

  // Two human gates: the storyboard first, then the edit plan. A "no" asks for notes and sends the plan back for a new version.
  while (state.status === "awaiting_approval" && state.gate) {
    write(outDir, "treatment.json", state.treatmentDoc);
    write(outDir, "scene-plan.json", state.scenePlan);
    if (state.editPlan) write(outDir, "edit-plan.json", state.editPlan);
    const stage = state.gate;
    const version = stage === "storyboard" ? state.scenePlan!.version : state.editPlan!.version;
    console.log(stage === "storyboard"
      ? `\nStoryboard version ${version} ready: ${state.scenePlan!.scenes.length} scenes. Files in storage/${project.project_id}/`
      : `\nEdit plan version ${version} ready: ${state.editPlan!.uses.length} recipe uses. Files in storage/${project.project_id}/`);

    if (flag("yes")) { state = await graph.invoke(approveCurrent(state), config); }
    else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`Approve this ${stage === "storyboard" ? "storyboard" : "edit plan"}? (y/n) `)).trim().toLowerCase();
      const approved = answer === "y" || answer === "yes";
      const notes = approved ? "" : (await rl.question("What should change? ")).trim();
      rl.close();
      if (!approved && !notes) { console.log("A change request needs notes. Stopping here."); return; }
      state = await graph.invoke(gateDecision(stage, version, approved ? "approved" : "revision_requested", notes, state.scenePlan!.version), config);
    }
    for (const line of state.trace.slice(-3)) console.log(`  ${line}`);
  }

  write(outDir, "run-record.json", buildRunRecord(state, { model: llm.model, skills, library }));
  if (state.status === "escalated") {
    write(outDir, "escalation.json", state.escalation);
    console.log("\nEscalated to a human. See storage/" + project.project_id + "/escalation.json");
    process.exitCode = 1;
  }
  console.log(`\nStatus: ${state.status}. Audit record: storage/${project.project_id}/run-record.json`);
  if (state.status === "approved") console.log("Both approvals are recorded. Rendering is the next milestone: nothing is rendered yet, and a render must pass assertRenderable first.");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
