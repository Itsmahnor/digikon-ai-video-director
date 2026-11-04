import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KeywordRetriever, loadSkillDocs } from "@digikon/rag";
import { normaliseBenchmark, runRetrievalEval, validateBenchmark, type BenchmarkQuery } from "./retrieval-eval.js";

const root = resolve(import.meta.dirname, "..", "..", "..");
const queries = (JSON.parse(readFileSync(resolve(root, "evals", "skills-benchmark.json"), "utf8")) as { queries: BenchmarkQuery[] }).queries;
const docs = loadSkillDocs(resolve(root, "examples", "skills"));

describe("skills benchmark", () => {
  it("is well formed: unique ids, known collection, every expected skill exists and is retrievable under the query's own filter", async () => {
    const all = normaliseBenchmark([], queries);
    expect(all.length).toBeGreaterThanOrEqual(40);
    expect(new Set(all.map((q) => q.collection))).toEqual(new Set(["skills"]));
    await validateBenchmark(all, docs, new KeywordRetriever(docs));
  });
  it("covers all three video categories, cross-cutting skills, the Editor scope and negatives", () => {
    const tags = new Set(queries.flatMap((q) => q.tags));
    for (const t of ["cat:saas", "cat:ecommerce", "cat:general-promo", "cross_cutting", "editor_scope", "negative"]) expect(tags.has(t), t).toBe(true);
  });
  it("BM25 over the skills corpus finds a relevant skill first for most retrieval queries and never leaks another category", async () => {
    const b = await runRetrievalEval(queries, docs, new KeywordRetriever(docs), { name: "KeywordRetriever", algorithm: "BM25", k1: 1.5, b: 0.75 });
    expect(b.metrics.overall.p_at_1!).toBeGreaterThan(0.7);
    for (const q of b.queries) {
      const cat = q.filter.category;
      for (const h of q.returned) {
        const d = docs.find((x) => x.id === h.id)!;
        expect([cat, "all"]).toContain(d.metadata.skill_category);
      }
    }
  });
});
