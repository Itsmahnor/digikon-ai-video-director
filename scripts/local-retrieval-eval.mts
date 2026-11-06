import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CachedEmbedder, HybridRetriever, KeywordRetriever, MemoryVectorIndex, SKILLS_HYBRID_OPTIONS, SKILLS_KEYWORD_FLOOR, SKILLS_LOCAL_OPTIONS, chooseEmbedder, embeddingTextOf, loadSkillDocs, type Doc, type HybridOptions, type Retriever } from "@digikon/rag";
import { scoreQuery } from "../packages/evals/src/retrieval-eval.js";

/**
 * `npm run eval:local`: does the in-process semantic retriever work? Runs BM25, the old keyword-gated hybrid and the local hybrid over three query sets (local, independent, old) with the
 * real local embedding model. No network, no API. The local set is a development set, not held out: do not read it as a final score.
 */
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const load = (f: string) => (JSON.parse(readFileSync(join(root, "evals", f), "utf8")) as { queries: { id: string; query: string; filter: Record<string, unknown>; kind: string; expect: string[] }[] }).queries;
const sets = { "local (42, dev)": load("local-retrieval-benchmark.json"), "independent (85)": load("skills-benchmark-independent.json"), "old (51)": load("skills-benchmark.json") };
const docs: Doc[] = loadSkillDocs(join(root, "examples", "skills"));
const chosen = chooseEmbedder(join(root, "storage", "models"));
if (!chosen.real) { console.error("No local sentence model under storage/models: this evaluation needs one."); process.exit(1); }
const emb = new CachedEmbedder(chosen.embedder, join(root, "storage", "index", "eval-skills.json"));
const vs = await emb.embed(docs.map(embeddingTextOf));
emb.save();
const hybrid = (o: HybridOptions): Retriever => { const ix = new MemoryVectorIndex(); const m = new Map<string, readonly number[]>(); docs.forEach((d, i) => { ix.set(`${d.collection}\u0000${d.id}`, vs[i]!); m.set(`${d.collection}\u0000${d.id}`, vs[i]!); }); return new HybridRetriever(docs, emb, ix, o, m); };
const noGate: HybridOptions = { min_similarity: 0.6, rrf_k: 60 };
const retrievers: Record<string, Retriever> = {
  "BM25 + idf floor 0.2 (old fallback)": new KeywordRetriever(docs, 1.5, 0.75, SKILLS_KEYWORD_FLOOR),
  "hybrid, keyword required (old default)": hybrid(SKILLS_HYBRID_OPTIONS),
  "hybrid, no floor": hybrid(noGate),
  "hybrid, local default": hybrid(SKILLS_LOCAL_OPTIONS),
};
const f = (x: number) => x.toFixed(3);
for (const [setName, qs] of Object.entries(sets)) {
  console.log(`\n### ${setName}\n| retriever | P@1 | MRR | off-topic empty |\n|---|---|---|---|`);
  for (const [name, r] of Object.entries(retrievers)) {
    let p1 = 0, rr = 0, n = 0, empty = 0, neg = 0;
    for (const q of qs) {
      const hits = await r.retrieve({ text: q.query, collection: "skills", k: 5, filter: q.filter });
      if (q.kind === "negative") { neg++; if (hits.length === 0) empty++; continue; }
      const m = scoreQuery(hits.map((h) => h.doc.id), q.expect); n++; p1 += m.p_at_1; rr += m.rr;
    }
    console.log(`| ${name} | ${f(p1 / n)} | ${f(rr / n)} | ${empty}/${neg} |`);
  }
}
