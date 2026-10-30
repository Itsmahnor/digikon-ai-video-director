import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AnthropicClient, DemoClient, SkillLibrary, type LlmClient } from "@digikon/director";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import { ModelUnavailable, formatReport, parseDirectorCases, parseRouterCases, runDirectorCases, runRouterCases } from "./run.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) delete process.env.ANTHROPIC_API_KEY;
  try { process.loadEnvFile(join(repoRoot, ".env")); } catch { /* optional */ }

  const live = flag("live");
  const llm: LlmClient = live ? new AnthropicClient() : new DemoClient({ creative: true });
  const mode = live ? `LIVE (${(llm as AnthropicClient).model})` : "DEMO: canned model, checks the harness and the pipeline, says nothing about Claude's quality";

  const recipes = loadRecipes(join(repoRoot, "recipes"));
  const library = new RecipeLibrary(recipes, flag("reviewed") ? "reviewed" : "draft");
  const retriever = new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repoRoot, "knowledge"))]);
  const skills = new SkillLibrary(join(repoRoot, "skills"));

  const only = arg("only");
  const keep = <T extends { id: string }>(xs: T[]) => (only ? xs.filter((x) => x.id === only) : xs);
  const briefs = keep(parseDirectorCases(JSON.parse(readFileSync(join(repoRoot, "evals", "golden-briefs.json"), "utf8"))));
  const routes = keep(parseRouterCases(JSON.parse(readFileSync(join(repoRoot, "evals", "router-cases.json"), "utf8"))));

  console.log(`Running ${briefs.length} Director cases and ${routes.length} router cases...\n`);
  const results = [
    ...(await runRouterCases(routes, { llm, skills })),
    ...(await runDirectorCases(briefs, { llm, skills, retriever, recipes: library })),
  ];
  console.log(formatReport(results, mode));

  const dir = join(repoRoot, "storage", "evals");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${live ? "live" : "demo"}.json`);
  writeFileSync(file, JSON.stringify({ mode, ran_at: new Date().toISOString(), results }, null, 2) + "\n", "utf8");
  console.log(`\nReport saved to ${file}`);
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

main().catch((e) => {
  if (e instanceof ModelUnavailable) { console.error(`\nThe model is not available, so no cases were scored.\n${e.message}`); process.exit(3); }
  console.error(e instanceof Error ? e.message : e); process.exit(1);
});
