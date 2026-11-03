import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HashEmbedder, HybridRetriever, KeywordRetriever, chooseEmbedder, loadKnowledge, recipeDocs, type Doc, type Embedder, type Retriever } from "@digikon/rag";
import { loadRecipes } from "@digikon/recipes";
import { normaliseBenchmark, runRetrievalEval, type Baseline, type BenchmarkQuery, type SeedQuery } from "./retrieval-eval.js";

/**
 * Measures the hybrid retriever (BM25 + vector, reciprocal rank fusion) against the BM25 baseline on the same queries, and writes the comparison.
 * Usage: npm run eval:hybrid [-- --out <dir>] [--embedder hash|auto]
 * `auto` uses a sentence model from storage/models when one is there; otherwise it falls back to the hash embedder and says so.
 */
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };

type Row = { p_at_1: number | null; recall_at_3: number | null; mrr: number | null; ndcg_at_3: number | null; n: number };
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e4) / 1e4 : null);
const subset = (b: Baseline, pred: (q: Baseline["queries"][number]) => boolean): Row & { neg_empty: string } => {
  const rs = b.queries.filter(pred), ret = rs.filter((q) => q.kind === "retrieval" && q.metrics), neg = rs.filter((q) => q.kind === "negative");
  return { n: ret.length, p_at_1: mean(ret.map((q) => q.metrics!.p_at_1)), recall_at_3: mean(ret.map((q) => q.metrics!.recall_at_3)), mrr: mean(ret.map((q) => q.metrics!.rr)), ndcg_at_3: mean(ret.map((q) => q.metrics!.ndcg_at_3)), neg_empty: `${neg.filter((q) => q.returned_empty).length}/${neg.length}` };
};

export interface Comparison { embedder: string; real_model: boolean; note: string; sweep: { min_similarity: number; overall: Row & { neg_empty: string } }[]; groups: Record<string, { bm25: Row & { neg_empty: string }; hybrid: Row & { neg_empty: string } }> }

async function main() {
  const seed = JSON.parse(readFileSync(join(repoRoot, "evals", "retrieval.json"), "utf8")) as SeedQuery[];
  const extra = (JSON.parse(readFileSync(join(repoRoot, "evals", "retrieval-benchmark.json"), "utf8")) as { queries: BenchmarkQuery[] }).queries;
  const queries = normaliseBenchmark(seed, extra);
  const docs: Doc[] = [...recipeDocs(loadRecipes(join(repoRoot, "recipes"))), ...loadKnowledge(join(repoRoot, "knowledge"))];

  let embedder: Embedder = new HashEmbedder(), real = false, note = "hash embedder (wording only; no sentence model was asked for)";
  if (arg("embedder") === "auto") ({ embedder, real, note } = chooseEmbedder(join(repoRoot, "storage", "models")));

  const bm25 = await runRetrievalEval(queries, docs, new KeywordRetriever(docs), { name: "KeywordRetriever", algorithm: "BM25 (title x2 + text)", k1: 1.5, b: 0.75 });
  const run = async (min_similarity: number) => runRetrievalEval(queries, docs, (await HybridRetriever.create(docs, embedder, { min_similarity })) as Retriever, { name: "HybridRetriever", algorithm: `BM25 + ${embedder.model} vectors, RRF k=60, min_similarity ${min_similarity}`, k1: 1.5, b: 0.75 });
  const DEFAULT_MIN = 0.2;
  const sweepVals = [0.1, 0.2, 0.3, 0.4, 0.5];
  const sweep: Comparison["sweep"] = [];
  let hybrid!: Baseline;
  for (const m of sweepVals) { const b = await run(m); sweep.push({ min_similarity: m, overall: subset(b, () => true) }); if (m === DEFAULT_MIN) hybrid = b; }

  const groups: Comparison["groups"] = {};
  const add = (name: string, pred: (q: Baseline["queries"][number]) => boolean) => { groups[name] = { bm25: subset(bm25, pred), hybrid: subset(hybrid, pred) }; };
  add("overall", () => true);
  for (const c of ["directing_principles", "ad_playbooks", "shot_recipes", "platform_specs", "brand_product_facts", "approved_examples"]) add(`collection:${c}`, (q) => q.collection === c);
  for (const t of ["seed", "paraphrase", "scene_level", "negative", "semantic"]) add(`tag:${t}`, (q) => q.tags.includes(t));
  const cmp: Comparison = { embedder: `${embedder.model}@${embedder.version}`, real_model: real, note, sweep, groups };

  const out = resolve(arg("out") ?? join(repoRoot, "evals", "baselines"));
  mkdirSync(out, { recursive: true });
  const tag = real ? embedder.model.replace(/[^a-z0-9]+/gi, "-") : "hash";
  writeFileSync(join(out, `hybrid-vs-bm25-${tag}.json`), JSON.stringify(cmp, null, 2) + "\n", "utf8");
  const f = (x: number | null) => (x === null ? "-" : x.toFixed(3));
  const L = [`# Hybrid vs BM25 (${cmp.embedder})`, "", `Embedder: ${note}.`, `Queries: ${bm25.benchmark.total_queries} (${bm25.benchmark.by_kind.retrieval} retrieval, ${bm25.benchmark.by_kind.negative} negative, ${bm25.benchmark.by_kind.missing_knowledge} missing-knowledge). Hybrid uses RRF k=60 and min_similarity ${DEFAULT_MIN}, fixed in advance, not tuned on this set.`, "", "| group | n | BM25 P@1 | hybrid P@1 | BM25 R@3 | hybrid R@3 | BM25 MRR | hybrid MRR | BM25 nDCG@3 | hybrid nDCG@3 | negatives empty (BM25 / hybrid) |", "|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const [g, v] of Object.entries(groups)) L.push(`| ${g} | ${v.bm25.n} | ${f(v.bm25.p_at_1)} | ${f(v.hybrid.p_at_1)} | ${f(v.bm25.recall_at_3)} | ${f(v.hybrid.recall_at_3)} | ${f(v.bm25.mrr)} | ${f(v.hybrid.mrr)} | ${f(v.bm25.ndcg_at_3)} | ${f(v.hybrid.ndcg_at_3)} | ${v.bm25.neg_empty} / ${v.hybrid.neg_empty} |`);
  L.push("", "## Sensitivity to min_similarity (overall)", "", "| min_similarity | P@1 | R@3 | MRR | nDCG@3 | negatives empty |", "|---|---|---|---|---|---|");
  for (const s of sweep) L.push(`| ${s.min_similarity} | ${f(s.overall.p_at_1)} | ${f(s.overall.recall_at_3)} | ${f(s.overall.mrr)} | ${f(s.overall.ndcg_at_3)} | ${s.overall.neg_empty} |`);
  if (!real) L.push("", "The hash embedder matches wording, spelling and word forms, not meaning. It cannot be expected to recover paraphrases that share no words with the document; a real sentence-embedding model has to be downloaded and approved before this comparison says anything about semantic retrieval.");
  writeFileSync(join(out, `hybrid-vs-bm25-${tag}.md`), L.join("\n") + "\n", "utf8");

  for (const [g, v] of Object.entries(groups)) if (g === "overall" || g.startsWith("tag:")) console.log(`${g.padEnd(16)} n=${v.bm25.n}  P@1 ${f(v.bm25.p_at_1)} -> ${f(v.hybrid.p_at_1)}  R@3 ${f(v.bm25.recall_at_3)} -> ${f(v.hybrid.recall_at_3)}  MRR ${f(v.bm25.mrr)} -> ${f(v.hybrid.mrr)}  neg ${v.bm25.neg_empty} -> ${v.hybrid.neg_empty}`);
  console.log(`Reports written to ${out}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
