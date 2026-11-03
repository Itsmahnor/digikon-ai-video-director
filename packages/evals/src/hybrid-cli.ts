import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HashEmbedder, HybridRetriever, KeywordRetriever, chooseEmbedder, loadKnowledge, recipeDocs, type Doc, type Embedder, type Retriever } from "@digikon/rag";
import { loadRecipes } from "@digikon/recipes";
import { normaliseBenchmark, runRetrievalEval, type Baseline, type BenchmarkQuery, type SeedQuery } from "./retrieval-eval.js";

/**
 * Measures the hybrid retriever (BM25 + vector, reciprocal rank fusion) against the BM25 baseline on the same queries, and writes the comparison.
 * Usage: npm run eval:hybrid [-- --out <dir>] [--embedder hash|auto] [--split all|dev|test] [--min-sim 0.2] [--rrf-k 60] [--tune]
 * The split is fixed by a hash of the query id (even = dev, odd = test), so it never changes as queries are added. `--tune` grid-searches min_similarity and
 * RRF k on the dev split only; the chosen values are then reported on the test split, which tuning never sees.
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

async function tune(queries: BenchmarkQuery[], docs: Doc[], embedder: Embedder) {
  const rows: { min: number; k: number; mrr: number; p1: number; neg: string; negN: number }[] = [];
  for (const k of [20, 40, 60, 100]) for (const min of [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7]) {
    const b = await runRetrievalEval(queries, docs, (await HybridRetriever.create(docs, embedder, { min_similarity: min, rrf_k: k })) as Retriever, { name: "HybridRetriever", algorithm: "tune", k1: 1.5, b: 0.75 });
    const s = subset(b, () => true);
    rows.push({ min, k, mrr: s.mrr ?? 0, p1: s.p_at_1 ?? 0, neg: s.neg_empty, negN: Number(s.neg_empty.split("/")[0]) });
  }
  rows.sort((a, b) => (b.mrr + 0.01 * b.negN) - (a.mrr + 0.01 * a.negN));
  console.log(`dev queries: ${queries.length}. Ranked by MRR + 0.01 per empty negative:`);
  for (const r of rows.slice(0, 10)) console.log(`k=${r.k} min=${r.min}  MRR ${r.mrr.toFixed(3)}  P@1 ${r.p1.toFixed(3)}  neg ${r.neg}`);
}

async function main() {
  const seed = JSON.parse(readFileSync(join(repoRoot, "evals", "retrieval.json"), "utf8")) as SeedQuery[];
  const extra = (JSON.parse(readFileSync(join(repoRoot, "evals", "retrieval-benchmark.json"), "utf8")) as { queries: BenchmarkQuery[] }).queries;
  const split = arg("split") ?? "all";
  const stableHash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  const queries = normaliseBenchmark(seed, extra).filter((q) => split === "all" || (split === "dev") === (stableHash(q.id) % 2 === 0));
  const docs: Doc[] = [...recipeDocs(loadRecipes(join(repoRoot, "recipes"))), ...loadKnowledge(join(repoRoot, "knowledge"))];

  let embedder: Embedder = new HashEmbedder(), real = false, note = "hash embedder (wording only; no sentence model was asked for)";
  if (arg("embedder") === "auto") ({ embedder, real, note } = chooseEmbedder(join(repoRoot, "storage", "models")));

  const DEFAULT_MIN = Number(arg("min-sim") ?? 0.2), RRF_K = Number(arg("rrf-k") ?? 60);
  if (process.argv.includes("--tune")) { await tune(queries, docs, embedder); return; }
  const bm25 = await runRetrievalEval(queries, docs, new KeywordRetriever(docs), { name: "KeywordRetriever", algorithm: "BM25 (title x2 + text)", k1: 1.5, b: 0.75 });
  const run = async (min_similarity: number) => runRetrievalEval(queries, docs, (await HybridRetriever.create(docs, embedder, { min_similarity, rrf_k: RRF_K })) as Retriever, { name: "HybridRetriever", algorithm: `BM25 + ${embedder.model} vectors, RRF k=${RRF_K}, min_similarity ${min_similarity}`, k1: 1.5, b: 0.75 });
  const sweepVals = [...new Set([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.65, 0.7, DEFAULT_MIN])].sort((a, b) => a - b);
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
  const tag = (real ? embedder.model.replace(/[^a-z0-9]+/gi, "-") : "hash") + (split === "all" ? "" : `-${split}`);
  writeFileSync(join(out, `hybrid-vs-bm25-${tag}.json`), JSON.stringify(cmp, null, 2) + "\n", "utf8");
  const f = (x: number | null) => (x === null ? "-" : x.toFixed(3));
  const L = [`# Hybrid vs BM25 (${cmp.embedder})`, "", `Embedder: ${note}.`, `Queries: ${bm25.benchmark.total_queries} (${bm25.benchmark.by_kind.retrieval} retrieval, ${bm25.benchmark.by_kind.negative} negative, ${bm25.benchmark.by_kind.missing_knowledge} missing-knowledge). Split: ${split}. Hybrid uses RRF k=${RRF_K} and min_similarity ${DEFAULT_MIN}.`, "", "| group | n | BM25 P@1 | hybrid P@1 | BM25 R@3 | hybrid R@3 | BM25 MRR | hybrid MRR | BM25 nDCG@3 | hybrid nDCG@3 | negatives empty (BM25 / hybrid) |", "|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const [g, v] of Object.entries(groups)) L.push(`| ${g} | ${v.bm25.n} | ${f(v.bm25.p_at_1)} | ${f(v.hybrid.p_at_1)} | ${f(v.bm25.recall_at_3)} | ${f(v.hybrid.recall_at_3)} | ${f(v.bm25.mrr)} | ${f(v.hybrid.mrr)} | ${f(v.bm25.ndcg_at_3)} | ${f(v.hybrid.ndcg_at_3)} | ${v.bm25.neg_empty} / ${v.hybrid.neg_empty} |`);
  L.push("", "## Sensitivity to min_similarity (overall)", "", "| min_similarity | P@1 | R@3 | MRR | nDCG@3 | negatives empty |", "|---|---|---|---|---|---|");
  for (const s of sweep) L.push(`| ${s.min_similarity} | ${f(s.overall.p_at_1)} | ${f(s.overall.recall_at_3)} | ${f(s.overall.mrr)} | ${f(s.overall.ndcg_at_3)} | ${s.overall.neg_empty} |`);
  if (!real) L.push("", "The hash embedder matches wording, spelling and word forms, not meaning. It cannot be expected to recover paraphrases that share no words with the document; a real sentence-embedding model has to be downloaded and approved before this comparison says anything about semantic retrieval.");
  writeFileSync(join(out, `hybrid-vs-bm25-${tag}.md`), L.join("\n") + "\n", "utf8");

  for (const [g, v] of Object.entries(groups)) if (g === "overall" || g.startsWith("tag:")) console.log(`${g.padEnd(16)} n=${v.bm25.n}  P@1 ${f(v.bm25.p_at_1)} -> ${f(v.hybrid.p_at_1)}  R@3 ${f(v.bm25.recall_at_3)} -> ${f(v.hybrid.recall_at_3)}  MRR ${f(v.bm25.mrr)} -> ${f(v.hybrid.mrr)}  neg ${v.bm25.neg_empty} -> ${v.hybrid.neg_empty}`);
  console.log(`Reports written to ${out}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
