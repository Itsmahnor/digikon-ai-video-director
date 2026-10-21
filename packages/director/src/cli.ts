import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Asset, AssetNotes, BrandFact, Project } from "@digikon/contracts";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import { z } from "zod";
import { AnthropicClient } from "./llm.js";
import { Command, buildDirectorGraph, type ApprovalDecision } from "./graph.js";
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
    console.log("  --draft  allow draft recipes (development until recipes are reviewed)\n  --yes    approve the plan without prompting");
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

  write(outDir, "treatment.json", state.treatmentDoc);
  write(outDir, "scene-plan.json", state.scenePlan);
  write(outDir, "edit-plan.json", state.editPlan);
  console.log(`\nPlan ready: ${state.scenePlan!.scenes.length} scenes, ${state.editPlan!.uses.length} recipe uses. Files in storage/${project.project_id}/`);

  let decision: ApprovalDecision = { approved: true };
  if (!flag("yes")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Approve this plan for rendering? (y/n) ")).trim().toLowerCase();
    rl.close();
    decision = { approved: answer === "y" || answer === "yes" };
  }
  state = await graph.invoke(new Command({ resume: decision }), config);

  write(outDir, "run-record.json", buildRunRecord(state, { model: llm.model, skills, library }));
  console.log(`\nStatus: ${state.status}. Audit record: storage/${project.project_id}/run-record.json`);
  if (state.status === "approved") console.log("Rendering is the next milestone: approved plans are not rendered yet.");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
