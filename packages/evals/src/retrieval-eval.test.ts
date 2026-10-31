import { describe, expect, it } from "vitest";
import { KeywordRetriever, type Doc } from "@digikon/rag";
import { normaliseBenchmark, runRetrievalEval, scoreQuery, validateBenchmark, type BenchmarkQuery } from "./retrieval-eval.js";

const doc = (id: string, collection: Doc["collection"], text: string): Doc => ({ id, collection, title: id, text, source: "t", metadata: { grade: "A" } });
const docs = [doc("a", "ad_playbooks", "opening hook scene"), doc("b", "ad_playbooks", "closing call to action"), doc("c", "ad_playbooks", "claims need approved facts")];
const info = { name: "KeywordRetriever", algorithm: "BM25", k1: 1.5, b: 0.75 };

describe("scoreQuery", () => {
  it("scores a perfect first hit", () => expect(scoreQuery(["a", "x"], ["a"])).toEqual({ p_at_1: 1, recall_at_3: 1, rr: 1, ndcg_at_3: 1 }));
  it("scores a hit at rank 2", () => {
    const m = scoreQuery(["x", "a", "y"], ["a"]);
    expect(m.p_at_1).toBe(0); expect(m.recall_at_3).toBe(1); expect(m.rr).toBe(0.5);
    expect(m.ndcg_at_3).toBeCloseTo(1 / Math.log2(3), 6);
  });
  it("scores a miss outside the top 3 as zero recall but keeps MRR", () => {
    const m = scoreQuery(["x", "y", "z", "a"], ["a"]);
    expect(m.recall_at_3).toBe(0); expect(m.rr).toBe(0.25); expect(m.ndcg_at_3).toBe(0);
  });
  it("gives partial recall for several relevant documents", () => expect(scoreQuery(["a", "x", "y"], ["a", "b"]).recall_at_3).toBe(0.5));
  it("treats an equivalent substitute as a hit", () => {
    const m = scoreQuery(["a-alt", "x"], ["a"], ["a-alt"]);
    expect(m.p_at_1).toBe(1); expect(m.recall_at_3).toBe(1); expect(m.ndcg_at_3).toBe(1);
  });
  it("scores an empty result as zero", () => expect(scoreQuery([], ["a"])).toEqual({ p_at_1: 0, recall_at_3: 0, rr: 0, ndcg_at_3: 0 }));
});

describe("benchmark integrity", () => {
  const q = (over: Partial<BenchmarkQuery>): BenchmarkQuery => ({ id: "t1", collection: "ad_playbooks", kind: "retrieval", tags: [], query: "hook", expect: ["a"], why: "w", ...over });
  it("rejects expected ids that are not real documents", async () => {
    await expect(validateBenchmark([q({ expect: ["invented"] })], docs, new KeywordRetriever(docs))).rejects.toThrow(/not a document/);
  });
  it("rejects expected ids excluded by the query's own filter", async () => {
    await expect(validateBenchmark([q({ filter: { topics: ["strategy"] } })], docs, new KeywordRetriever(docs))).rejects.toThrow(/excluded by the query's own filter/);
  });
  it("rejects duplicate ids and negative queries with expectations", () => {
    expect(() => normaliseBenchmark([], [q({}), q({})])).toThrow(/duplicate/);
    expect(() => normaliseBenchmark([], [q({ kind: "negative" })])).toThrow(/must not list/);
  });
});

describe("runRetrievalEval", () => {
  it("separates retrieval, negative and missing-knowledge queries and handles empty collections", async () => {
    const queries: BenchmarkQuery[] = [
      { id: "r1", collection: "ad_playbooks", kind: "retrieval", tags: [], query: "opening hook", expect: ["a"], why: "" },
      { id: "n1", collection: "ad_playbooks", kind: "negative", tags: [], query: "tax deadlines", expect: [], why: "" },
      { id: "n2", collection: "ad_playbooks", kind: "negative", tags: [], query: "scene", expect: [], why: "" }, // BM25 returns "a": noise
      { id: "m1", collection: "platform_specs", kind: "missing_knowledge", tags: [], query: "tiktok safe area", expect: [], why: "" },
    ];
    const b = await runRetrievalEval(queries, docs, new KeywordRetriever(docs), info);
    expect(b.metrics.overall.queries).toBe(1);
    expect(b.metrics.overall.p_at_1).toBe(1);
    expect(b.metrics.overall.negative).toMatchObject({ queries: 2, empty_correct: 1, accuracy: 0.5 });
    expect(b.metrics.per_collection.platform_specs).toMatchObject({ queries: 0, p_at_1: null, missing_knowledge: { queries: 1, returned_empty: 1 } });
    expect(b.missing_knowledge.empty_collections).toContain("platform_specs");
    expect(b.failures.negative_queries_that_returned_results.map((r) => r.id)).toEqual(["n2"]);
    expect(b.failures.genuine_retrieval_failures).toEqual([]);
  });

  it("is deterministic", async () => {
    const queries: BenchmarkQuery[] = [{ id: "r1", collection: "ad_playbooks", kind: "retrieval", tags: [], query: "claims facts", expect: ["c"], why: "" }];
    const a = await runRetrievalEval(queries, docs, new KeywordRetriever(docs), info);
    const b = await runRetrievalEval(queries, docs, new KeywordRetriever(docs), info);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
