import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HybridRetriever, SKILLS_HYBRID_OPTIONS, chooseEmbedder, createDbBackedRetriever, loadSkillDocs, openStore, skillDoc, type Doc, type Retriever } from "@digikon/rag";
import { normaliseBenchmark, runRetrievalEval, type BenchmarkQuery } from "./retrieval-eval.js";

/**
 * Runs the skills benchmark through the database: skill text and vectors come from Postgres (DATABASE_URL), ranking is the default skills retriever (hybrid with the off-topic floor).
 * It is compared with the same retriever built from the files, on both query sets. Same embedder, same documents, so the two should agree; a difference means the database path is wrong.
 * Usage: npm run eval:skills:db   (needs DATABASE_URL and the skills imported: npm run skills -- import examples/skills)
 */
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const load = (file: string) => normaliseBenchmark([], (JSON.parse(readFileSync(join(repoRoot, "evals", file), "utf8")) as { queries: BenchmarkQuery[] }).queries);

async function main() {
  if (!process.env["DATABASE_URL"]) { console.error("DATABASE_URL is not set: this benchmark needs a real database."); process.exit(2); }
  const store = await openStore();
  try {
    const health = await store.health();
    if (!health.ok || health.backend !== "postgres") throw new Error(`not a usable Postgres database: ${health.detail}`);
    const rows = await store.listSkills();
    const dbDocs: Doc[] = rows.map(skillDoc).filter((d): d is Doc => d !== null);
    const fileDocs = loadSkillDocs(join(repoRoot, "examples", "skills"));
    const { embedder, note } = chooseEmbedder(join(repoRoot, "storage", "models"));

    const fromDb: Retriever = (await createDbBackedRetriever(store, embedder, [], SKILLS_HYBRID_OPTIONS))(dbDocs);
    // The importer embeds title, topic, category, funnel stage, platforms and body (skillText in rag/skills.ts), so the file side must embed the same text to be comparable.
    const importerText = (d: Doc) => { const m = d.metadata; const dash = (s?: string) => (s ?? "").replace(/[-_]/g, " "); return [d.title, dash(m.skill_topic), dash(m.skill_category), dash(m.skill_funnel_stage), (m.skill_platforms ?? []).join(" "), d.text.slice(d.title.length + 2)].join(". "); };
    // One at a time, as the importer does: a quantized model can differ in the last digits when texts are batched and padded together.
    const vs: number[][] = [];
    for (const d of fileDocs) vs.push((await embedder.embed([importerText(d)]))[0]!);
    const vectors = new Map(fileDocs.map((d, i) => [`${d.collection}\u0000${d.id}`, vs[i]!] as const));
    const { MemoryVectorIndex } = await import("@digikon/rag");
    const idx = new MemoryVectorIndex(); for (const [k, v] of vectors) idx.set(k, v);
    const fromFiles: Retriever = new HybridRetriever(fileDocs, embedder, idx, SKILLS_HYBRID_OPTIONS, vectors);

    const report: string[] = [`Skills benchmark through the database (${health.detail}); ${note}.`, `Skills in the database: ${rows.length}; in the files: ${fileDocs.length}.`, ""];
    report.push("| set | retriever | n | P@1 | R@3 | MRR | nDCG@3 | off-topic answered empty |", "|---|---|---|---|---|---|---|---|");
    let identical = true;
    for (const [name, qs] of [["independent (85)", load("skills-benchmark-independent.json")], ["old (51)", load("skills-benchmark.json")]] as const) {
      const results: Record<string, ReturnType<typeof summarise>> = {};
      for (const [label, r, docs] of [["files", fromFiles, fileDocs], ["database", fromDb, dbDocs]] as const) {
        const b = await runRetrievalEval(qs, docs, r, { name: "skills", algorithm: label, k1: 1.5, b: 0.75 });
        results[label] = summarise(b);
        const s = results[label]!;
        report.push(`| ${name} | ${label} | ${s.n} | ${s.p1} | ${s.r3} | ${s.mrr} | ${s.ndcg} | ${s.neg} |`);
      }
      if (JSON.stringify(results["files"]) !== JSON.stringify(results["database"])) identical = false;
    }
    report.push("", identical ? "The database path and the file path give identical numbers on both sets (the file side embeds the importer's text, so this checks the database path: stored text, stored vectors, pgvector search)." : "**The database path and the file path DIFFER: investigate.**");
    console.log(report.join("\n"));
    process.exitCode = identical ? 0 : 1;
  } finally { await store.close(); }
}
const f3 = (x: number | null) => (x === null ? "-" : x.toFixed(3));
function summarise(b: Awaited<ReturnType<typeof runRetrievalEval>>) {
  const m = b.metrics.overall;
  return { n: m.queries, p1: f3(m.p_at_1), r3: f3(m.recall_at_3), mrr: f3(m.mrr), ndcg: f3(m.ndcg_at_3), neg: `${m.negative.empty_correct}/${m.negative.queries}` };
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
