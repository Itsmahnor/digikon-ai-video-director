import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HashEmbedder, HybridRetriever, KeywordRetriever, chooseEmbedder, loadSkillDocs, type Doc, type Embedder, type Retriever } from "@digikon/rag";
import { filterFor, normaliseBenchmark, runRetrievalEval, type Baseline, type BenchmarkQuery } from "./retrieval-eval.js";

/**
 * Benchmarks retrieval over the skills collection (examples/skills): BM25 against the hybrid retriever, on evals/skills-benchmark.json.
 * Usage: npm run eval:skills [-- --embedder hash|auto] [--out <dir>]
 * Every shipped skill is draft, so the queries run with include_draft; that is for benchmarking only and changes nothing in the skill files.
 * Same protocol as eval:hybrid: the split is a fixed hash of the query id (even = dev, odd = test); min_similarity is chosen on dev only and then reported on test.
 * It also checks category and scope leakage: a category query may return only that category and `all`, and an Editor query never a Director-only skill.
 */
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const stableHash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const isDev = (id: string) => stableHash(id) % 2 === 0;

type Row = { n: number; p_at_1: number | null; recall_at_3: number | null; mrr: number | null; ndcg_at_3: number | null; neg_empty: string };
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e4) / 1e4 : null);
const subset = (b: Baseline, pred: (q: Baseline["queries"][number]) => boolean): Row => {
  const rs = b.queries.filter(pred), ret = rs.filter((q) => q.kind === "retrieval" && q.metrics), neg = rs.filter((q) => q.kind === "negative");
  return { n: ret.length, p_at_1: mean(ret.map((q) => q.metrics!.p_at_1)), recall_at_3: mean(ret.map((q) => q.metrics!.recall_at_3)), mrr: mean(ret.map((q) => q.metrics!.rr)), ndcg_at_3: mean(ret.map((q) => q.metrics!.ndcg_at_3)), neg_empty: `${neg.filter((q) => q.returned_empty).length}/${neg.length}` };
};
const f = (x: number | null) => (x === null ? "-" : x.toFixed(3));

async function main() {
  const extra = (JSON.parse(readFileSync(join(repoRoot, "evals", "skills-benchmark.json"), "utf8")) as { queries: BenchmarkQuery[] }).queries;
  const all = normaliseBenchmark([], extra);
  const docs: Doc[] = loadSkillDocs(join(repoRoot, "examples", "skills"));
  let embedder: Embedder = new HashEmbedder(), real = false, note = "hash embedder (wording only)";
  if ((arg("embedder") ?? "auto") === "auto") ({ embedder, real, note } = chooseEmbedder(join(repoRoot, "storage", "models")));
  const info = (algorithm: string) => ({ name: "skills", algorithm, k1: 1.5, b: 0.75 });
  const bm25Retriever = new KeywordRetriever(docs);
  const hybridAt = async (min: number) => (await HybridRetriever.create(docs, embedder, { min_similarity: min, rrf_k: 60 })) as Retriever;
  const evalOn = async (qs: BenchmarkQuery[], r: Retriever, label: string) => runRetrievalEval(qs, docs, r, info(label));

  const dev = all.filter((q) => isDev(q.id)), test = all.filter((q) => !isDev(q.id));
  const MINS = [0.2, 0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85];
  // Tune on dev only.
  const devRows = [];
  for (const m of MINS) { const b = await evalOn(dev, await hybridAt(m), `hybrid min ${m}`); const s = subset(b, () => true); devRows.push({ min: m, ...s, score: (s.mrr ?? 0) + 0.01 * Number(s.neg_empty.split("/")[0]) }); }
  devRows.sort((a, b) => b.score - a.score || b.min - a.min);
  const chosen = devRows[0]!.min;

  const report: Record<string, { bm25: Row; hybrid: Row }> = {};
  const runSplit = async (name: string, qs: BenchmarkQuery[]) => {
    const bm = await evalOn(qs, bm25Retriever, "BM25 (title x2 + text)");
    const hy = await evalOn(qs, await hybridAt(chosen), `BM25 + ${embedder.model} vectors, RRF k=60, min_similarity ${chosen}`);
    report[`${name}:overall`] = { bm25: subset(bm, () => true), hybrid: subset(hy, () => true) };
    for (const cat of ["saas", "ecommerce", "general-promo"]) report[`${name}:category:${cat}`] = { bm25: subset(bm, (q) => q.tags.includes(`cat:${cat}`)), hybrid: subset(hy, (q) => q.tags.includes(`cat:${cat}`)) };
    for (const t of ["paraphrase", "scene_level", "cross_cutting", "editor_scope"]) report[`${name}:tag:${t}`] = { bm25: subset(bm, (q) => q.tags.includes(t)), hybrid: subset(hy, (q) => q.tags.includes(t)) };
    return { bm, hy };
  };
  const onTest = await runSplit("test", test);
  await runSplit("dev", dev);
  await runSplit("all", all);

  // Leakage: no returned skill may belong to another specific category, and Editor queries never return Director-only skills.
  const hy = await hybridAt(chosen);
  const leaks: { id: string; retriever: string; leaked: string[] }[] = [];
  for (const [name, r] of [["bm25", bm25Retriever as Retriever], ["hybrid", hy]] as const) {
    for (const q of all) {
      const filter = filterFor(q);
      const hits = await r.retrieve({ text: q.query, collection: "skills", k: 50, filter });
      const bad = hits.filter((h) => (filter.category && h.doc.metadata.skill_category !== filter.category && h.doc.metadata.skill_category !== "all") || (filter.skill_scope && h.doc.metadata.skill_scope !== "both" && h.doc.metadata.skill_scope !== filter.skill_scope)).map((h) => h.doc.id);
      if (bad.length) leaks.push({ id: q.id, retriever: name, leaked: bad });
    }
  }

  const out = resolve(arg("out") ?? join(repoRoot, "evals", "baselines"));
  mkdirSync(out, { recursive: true });
  const tag = real ? embedder.model.replace(/[^a-z0-9]+/gi, "-") : "hash";
  const payload = { embedder: `${embedder.model}@${embedder.version}`, real_model: real, note, corpus: { skills: docs.length, queries: all.length, dev: dev.length, test: test.length }, chosen_min_similarity_from_dev: chosen, dev_sweep: devRows, report, leaks, test_failures: { bm25: onTest.bm.queries.filter((q) => q.outcome !== "ok" && q.outcome !== "negative_correct").map((q) => ({ id: q.id, outcome: q.outcome, top: q.returned[0]?.id ?? null })), hybrid: onTest.hy.queries.filter((q) => q.outcome !== "ok" && q.outcome !== "negative_correct").map((q) => ({ id: q.id, outcome: q.outcome, top: q.returned[0]?.id ?? null })) } };
  writeFileSync(join(out, `skills-hybrid-vs-bm25-${tag}.json`), JSON.stringify(payload, null, 2) + "\n", "utf8");

  const L: string[] = [];
  L.push(`# Skills retrieval: hybrid vs BM25 (${embedder.model}@${embedder.version})`, "");
  L.push(`${note}. Corpus: ${docs.length} skills (all draft; queries run with include_draft for benchmarking only). Queries: ${all.length} (dev ${dev.length}, test ${test.length}). min_similarity chosen on dev: **${chosen}**; reported on the test split.`, "");
  L.push("| group | n | BM25 P@1 | hybrid P@1 | BM25 R@3 | hybrid R@3 | BM25 MRR | hybrid MRR | BM25 nDCG@3 | hybrid nDCG@3 | negatives empty (BM25 / hybrid) |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [k, v] of Object.entries(report).filter(([k]) => k.startsWith("test:") || k.startsWith("all:overall"))) L.push(`| ${k} | ${v.hybrid.n} | ${f(v.bm25.p_at_1)} | ${f(v.hybrid.p_at_1)} | ${f(v.bm25.recall_at_3)} | ${f(v.hybrid.recall_at_3)} | ${f(v.bm25.mrr)} | ${f(v.hybrid.mrr)} | ${f(v.bm25.ndcg_at_3)} | ${f(v.hybrid.ndcg_at_3)} | ${v.bm25.neg_empty} / ${v.hybrid.neg_empty} |`);
  L.push("", "## Dev sweep (min_similarity chosen on dev only)", "", "| min_similarity | P@1 | R@3 | MRR | negatives empty |", "|---|---|---|---|---|");
  for (const r of [...devRows].sort((a, b) => a.min - b.min)) L.push(`| ${r.min} | ${f(r.p_at_1)} | ${f(r.recall_at_3)} | ${f(r.mrr)} | ${r.neg_empty} |`);
  L.push("", "## Category and scope leakage", "", leaks.length ? `**${leaks.length} leaks:** ${leaks.map((l) => `${l.retriever}/${l.id}: ${l.leaked.join(", ")}`).join("; ")}` : `0 leaks over ${all.length} queries for BM25 and hybrid: no category query returned a skill from another specific category, and no Editor-scope query returned a Director-only skill.`);
  writeFileSync(join(out, `skills-hybrid-vs-bm25-${tag}.md`), L.join("\n") + "\n", "utf8");
  console.log(L.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
