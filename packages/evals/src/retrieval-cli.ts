import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { loadRecipes } from "@digikon/recipes";
import { formatMarkdown, normaliseBenchmark, runRetrievalEval, type BenchmarkQuery, type SeedQuery } from "./retrieval-eval.js";

/**
 * Measures the existing BM25 KeywordRetriever on evals/retrieval.json (seed) + evals/retrieval-benchmark.json.
 * Usage: npm run eval:retrieval [-- --out <dir>]   Writes bm25-baseline.json and bm25-baseline.md (default evals/baselines).
 * It reads the corpus exactly as the existing eval CLI does (recipes + knowledge) and never changes the retriever.
 */
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const seed = JSON.parse(readFileSync(join(repoRoot, "evals", "retrieval.json"), "utf8")) as SeedQuery[];
  const extra = (JSON.parse(readFileSync(join(repoRoot, "evals", "retrieval-benchmark.json"), "utf8")) as { queries: BenchmarkQuery[] }).queries;
  const queries = normaliseBenchmark(seed, extra);
  const docs = [...recipeDocs(loadRecipes(join(repoRoot, "recipes"))), ...loadKnowledge(join(repoRoot, "knowledge"))];
  const retriever = new KeywordRetriever(docs);
  const baseline = await runRetrievalEval(queries, docs, retriever, { name: "KeywordRetriever", algorithm: "BM25 (title x2 + text)", k1: 1.5, b: 0.75 });

  const out = resolve(arg("out") ?? join(repoRoot, "evals", "baselines"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "bm25-baseline.json"), JSON.stringify(baseline, null, 2) + "\n", "utf8");
  writeFileSync(join(out, "bm25-baseline.md"), formatMarkdown(baseline), "utf8");

  const o = baseline.metrics.overall;
  console.log(`BM25 baseline: ${baseline.benchmark.total_queries} queries (${baseline.benchmark.by_kind.retrieval} retrieval / ${baseline.benchmark.by_kind.negative} negative / ${baseline.benchmark.by_kind.missing_knowledge} missing-knowledge)`);
  console.log(`P@1=${o.p_at_1} Recall@3=${o.recall_at_3} MRR=${o.mrr} nDCG@3=${o.ndcg_at_3} negative-accuracy=${o.negative.empty_correct}/${o.negative.queries}`);
  console.log(`Reports written to ${out}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
