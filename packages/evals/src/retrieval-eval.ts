import { createHash } from "node:crypto";
import { COLLECTIONS, tokenize, type Collection, type Doc, type RetrieveFilter, type Retriever } from "@digikon/rag";

// ---------- benchmark case shape ----------

export type QueryKind = "retrieval" | "negative" | "missing_knowledge";

export interface BenchmarkQuery {
  id: string;
  collection: Collection;
  kind: QueryKind;
  tags: string[];
  query: string;
  /** Relevant document ids. Empty for negative and missing_knowledge queries. */
  expect: string[];
  /** Interchangeable substitutes for a relevant document (for example the same recipe on another renderer). */
  equivalent?: string[];
  filter?: RetrieveFilter;
  why: string;
}

/** Seed entries from evals/retrieval.json keep their original shape; they are always retrieval queries. */
export interface SeedQuery { query: string; collection: Collection; expect: string[] }

export function normaliseBenchmark(seed: SeedQuery[], extra: BenchmarkQuery[]): BenchmarkQuery[] {
  const seeds: BenchmarkQuery[] = seed.map((s, i) => ({
    id: `seed-${String(i + 1).padStart(2, "0")}`,
    collection: s.collection,
    kind: "retrieval",
    tags: ["seed"],
    query: s.query,
    expect: s.expect,
    why: "Seed query from evals/retrieval.json (unchanged).",
  }));
  const all = [...seeds, ...extra];
  const ids = new Set<string>();
  for (const q of all) {
    if (ids.has(q.id)) throw new Error(`duplicate benchmark id ${q.id}`);
    ids.add(q.id);
    if (!(COLLECTIONS as readonly string[]).includes(q.collection)) throw new Error(`${q.id}: unknown collection ${q.collection}`);
    if (q.kind === "retrieval" && q.expect.length === 0) throw new Error(`${q.id}: retrieval query needs expected ids`);
    if (q.kind !== "retrieval" && q.expect.length > 0) throw new Error(`${q.id}: ${q.kind} query must not list expected ids`);
  }
  return all;
}

/** Fails if any expected id is not a real document in the stated collection, or is not eligible under the query's own filter. */
export async function validateBenchmark(queries: BenchmarkQuery[], docs: Doc[], retriever: Retriever): Promise<void> {
  const problems: string[] = [];
  for (const q of queries) {
    for (const id of [...q.expect, ...(q.equivalent ?? [])]) {
      const doc = docs.find((d) => d.id === id && d.collection === q.collection);
      if (!doc) { problems.push(`${q.id}: "${id}" is not a document in ${q.collection}`); continue; }
      if (!(await retriever.get(id, q.collection, filterFor(q)))) problems.push(`${q.id}: "${id}" is excluded by the query's own filter`);
    }
  }
  if (problems.length) throw new Error(`Benchmark references documents that do not exist or cannot be retrieved:\n${problems.join("\n")}`);
}

/** Recipes are all draft today, so recipe queries default to include_draft (as the seed test does). A query may override it. */
export const filterFor = (q: BenchmarkQuery): RetrieveFilter => ({ ...(q.collection === "shot_recipes" ? { include_draft: true } : {}), ...(q.filter ?? {}) });

// ---------- metrics (pure) ----------

const log2 = (n: number) => Math.log(n) / Math.log(2);

export interface QueryMetrics { p_at_1: number; recall_at_3: number; rr: number; ndcg_at_3: number }

/** `ranked` is the full returned id list in rank order. Relevant = expect + equivalent. */
export function scoreQuery(ranked: string[], expect: string[], equivalent: string[] = []): QueryMetrics {
  const relevant = new Set([...expect, ...equivalent]);
  const top3 = ranked.slice(0, 3);
  const p_at_1 = ranked[0] !== undefined && relevant.has(ranked[0]) ? 1 : 0;
  const found = expect.filter((e) => top3.includes(e)).length;
  const missing = expect.length - found;
  const equivHits = equivalent.filter((e) => top3.includes(e)).length;
  const recall_at_3 = expect.length ? Math.min(expect.length, found + Math.min(equivHits, missing)) / expect.length : 0;
  const firstRel = ranked.findIndex((id) => relevant.has(id));
  const rr = firstRel >= 0 ? 1 / (firstRel + 1) : 0;
  // Equivalents are substitutes, not extra targets: at most expect.length relevant hits earn gain, and the ideal ranking has expect.length ones.
  let gains = 0;
  const dcg = top3.reduce((s, id, i) => (relevant.has(id) && gains++ < expect.length ? s + 1 / log2(i + 2) : s), 0);
  const idcg = Array.from({ length: Math.min(expect.length, 3) }).reduce<number>((s, _, i) => s + 1 / log2(i + 2), 0);
  return { p_at_1, recall_at_3, rr, ndcg_at_3: idcg ? dcg / idcg : 0 };
}

// ---------- run ----------

export type FailureCause = "vocabulary_mismatch" | "outranked" | "filtered_out_everything";

export interface QueryResult {
  id: string; collection: Collection; kind: QueryKind; tags: string[]; query: string; filter: RetrieveFilter;
  expect: string[]; equivalent: string[]; why: string;
  returned: { id: string; score: number }[];
  /** 1-based rank of the best relevant document in the full ranking, or null. */
  best_relevant_rank: number | null;
  metrics?: QueryMetrics;
  /** For negative and missing_knowledge queries: true when nothing was returned. */
  returned_empty?: boolean;
  /** Retrieval queries that did not put a relevant document first. */
  outcome: "ok" | "wrong_top_result" | "no_result" | "negative_correct" | "negative_returned_noise" | "missing_knowledge_empty" | "missing_knowledge_returned_noise";
  cause?: FailureCause;
  cause_detail?: string;
}

export interface Aggregate { queries: number; p_at_1: number | null; recall_at_3: number | null; mrr: number | null; ndcg_at_3: number | null }
export interface NegAggregate { queries: number; empty_correct: number; accuracy: number | null }

export interface Baseline {
  retriever: { name: string; algorithm: string; k1: number; b: number; tokenizer: string };
  corpus: { total_docs: number; fingerprint: string; per_collection: Record<string, { docs: number; ids: string[]; note?: string }> };
  benchmark: { total_queries: number; by_kind: Record<QueryKind, number>; by_collection: Record<string, Record<QueryKind, number>>; by_tag: Record<string, number> };
  metrics: {
    overall: Aggregate & { negative: NegAggregate };
    per_collection: Record<string, Aggregate & { negative: NegAggregate; missing_knowledge: { queries: number; returned_empty: number } }>;
  };
  failures: {
    genuine_retrieval_failures: QueryResult[];
    wrong_top_result: QueryResult[];
    no_relevant_result: QueryResult[];
    negative_queries_that_returned_results: QueryResult[];
  };
  missing_knowledge: {
    empty_collections: string[];
    queries: QueryResult[];
    notes: string[];
  };
  limitations: string[];
  queries: QueryResult[];
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r4 = (n: number | null) => (n === null ? null : Math.round(n * 10000) / 10000);

function aggregate(rs: QueryResult[]): Aggregate {
  const r = rs.filter((x) => x.kind === "retrieval" && x.metrics);
  return {
    queries: r.length,
    p_at_1: r4(mean(r.map((x) => x.metrics!.p_at_1))),
    recall_at_3: r4(mean(r.map((x) => x.metrics!.recall_at_3))),
    mrr: r4(mean(r.map((x) => x.metrics!.rr))),
    ndcg_at_3: r4(mean(r.map((x) => x.metrics!.ndcg_at_3))),
  };
}
function negAggregate(rs: QueryResult[]): NegAggregate {
  const n = rs.filter((x) => x.kind === "negative");
  const ok = n.filter((x) => x.returned_empty).length;
  return { queries: n.length, empty_correct: ok, accuracy: r4(n.length ? ok / n.length : null) };
}

export interface RetrieverInfo { name: string; algorithm: string; k1: number; b: number }

export async function runRetrievalEval(queries: BenchmarkQuery[], docs: Doc[], retriever: Retriever, info: RetrieverInfo): Promise<Baseline> {
  await validateBenchmark(queries, docs, retriever);
  const docById = new Map(docs.map((d) => [`${d.collection}/${d.id}`, d]));
  const results: QueryResult[] = [];

  for (const q of queries) {
    const filter = filterFor(q);
    // k=50 returns the whole eligible ranking (the largest collection has 40 documents), so MRR and rank diagnostics are exact.
    const hits = await retriever.retrieve({ text: q.query, collection: q.collection, k: 50, filter });
    const ranked = hits.map((h) => h.doc.id);
    const equivalent = q.equivalent ?? [];
    const relevant = new Set([...q.expect, ...equivalent]);
    const bestIdx = ranked.findIndex((id) => relevant.has(id));
    const base: QueryResult = {
      id: q.id, collection: q.collection, kind: q.kind, tags: q.tags, query: q.query, filter,
      expect: q.expect, equivalent, why: q.why,
      returned: hits.slice(0, 5).map((h) => ({ id: h.doc.id, score: Math.round(h.score * 1000) / 1000 })),
      best_relevant_rank: bestIdx >= 0 ? bestIdx + 1 : null,
      outcome: "ok",
    };
    if (q.kind === "retrieval") {
      base.metrics = scoreQuery(ranked, q.expect, equivalent);
      if (base.metrics.p_at_1 === 0) {
        base.outcome = ranked.length === 0 ? "no_result" : "wrong_top_result";
        const qTerms = new Set(tokenize(q.query));
        const overlap = [...relevant].filter((id) => {
          const d = docById.get(`${q.collection}/${id}`)!;
          return tokenize(`${d.title} ${d.text}`).some((t) => qTerms.has(t));
        });
        if (overlap.length === 0) { base.cause = "vocabulary_mismatch"; base.cause_detail = "no query term (after stop-word removal and stemming) occurs in any relevant document"; }
        else if (ranked.length === 0) { base.cause = "filtered_out_everything"; base.cause_detail = "nothing matched any query term"; }
        else { base.cause = "outranked"; base.cause_detail = `relevant document shares terms with the query but ranked ${base.best_relevant_rank ?? "below the cut"} behind ${ranked[0]}`; }
      }
    } else {
      base.returned_empty = ranked.length === 0;
      if (q.kind === "negative") base.outcome = base.returned_empty ? "negative_correct" : "negative_returned_noise";
      else base.outcome = base.returned_empty ? "missing_knowledge_empty" : "missing_knowledge_returned_noise";
    }
    results.push(base);
  }

  const per_collection: Baseline["metrics"]["per_collection"] = {};
  const perCol: Baseline["corpus"]["per_collection"] = {};
  for (const c of COLLECTIONS) {
    const rs = results.filter((r) => r.collection === c);
    const mk = rs.filter((r) => r.kind === "missing_knowledge");
    per_collection[c] = { ...aggregate(rs), negative: negAggregate(rs), missing_knowledge: { queries: mk.length, returned_empty: mk.filter((r) => r.returned_empty).length } };
    const cd = docs.filter((d) => d.collection === c);
    perCol[c] = { docs: cd.length, ids: cd.map((d) => d.id).sort() };
  }
  perCol.platform_specs!.note = "Only a README exists; no verified spec has been added, and unverified specs are never retrievable.";
  perCol.brand_product_facts!.note = "Facts are created per project at runtime (brandFactDocs) and are not part of the shared corpus.";
  perCol.approved_examples!.note = "No approved examples exist yet.";
  const draftRecipes = docs.filter((d) => d.collection === "shot_recipes" && d.metadata.recipe_status !== "reviewed").length;
  perCol.shot_recipes!.note = `${draftRecipes} of ${perCol.shot_recipes!.docs} recipes are draft, so production retrieval (no include_draft) returns none; recipe_implemented is not set in this corpus.`;

  const fingerprint = createHash("sha256").update(JSON.stringify(docs.map((d) => [d.collection, d.id, d.title, d.text, d.metadata]).sort())).digest("hex").slice(0, 16);
  const byKind = { retrieval: 0, negative: 0, missing_knowledge: 0 } as Record<QueryKind, number>;
  const byCol: Record<string, Record<QueryKind, number>> = {};
  const byTag: Record<string, number> = {};
  for (const r of results) {
    byKind[r.kind]++;
    (byCol[r.collection] ??= { retrieval: 0, negative: 0, missing_knowledge: 0 })[r.kind]++;
    for (const t of r.tags) byTag[t] = (byTag[t] ?? 0) + 1;
  }
  const emptyCollections = COLLECTIONS.filter((c) => perCol[c]!.docs === 0);
  const wrong = results.filter((r) => r.outcome === "wrong_top_result");
  const none = results.filter((r) => r.outcome === "no_result");
  const noisy = results.filter((r) => r.outcome === "negative_returned_noise");
  const mkQueries = results.filter((r) => r.kind === "missing_knowledge");

  const limitations: string[] = [];
  if (noisy.length) limitations.push(`No relevance threshold: ${noisy.length} of ${byKind.negative} negative queries still returned documents (${noisy.map((r) => r.id).join(", ")}) because any shared term gives a positive BM25 score. Production needs a score floor or a reranker to say "nothing suitable".`);
  const vocab = results.filter((r) => r.cause === "vocabulary_mismatch");
  if (vocab.length) limitations.push(`Vocabulary mismatch: ${vocab.length} retrieval queries share no stemmed term with their relevant document (${vocab.map((r) => r.id).join(", ")}). Only dense retrieval can recover these.`);
  const outranked = results.filter((r) => r.cause === "outranked");
  if (outranked.length) limitations.push(`Outranking: ${outranked.length} retrieval queries had a relevant document that shares terms with the query but ranked below a wrong one (${outranked.map((r) => r.id).join(", ")}).`);
  limitations.push("Recipe titles are indexed twice and 'Used for' phrases are keyword lists, so queries phrased like those lists succeed while paraphrases depend on shared stems.");
  limitations.push("Renderer variants (-hyperframes, -remotion) duplicate their base recipe text, so a plain query cannot distinguish them; the benchmark treats them as equivalent unless the query names the renderer.");
  limitations.push("The tokenizer is English-only suffix stripping with no synonyms, so 'dissolve' will not match 'crossfade' unless the document lists it.");
  if (emptyCollections.length) limitations.push(`${emptyCollections.length} of ${COLLECTIONS.length} collections are empty (${emptyCollections.join(", ")}), so retrieval quality there cannot be measured yet.`);

  const retrievalResults = results.filter((r) => r.kind === "retrieval");
  return {
    retriever: { ...info, tokenizer: "lowercase, split on non-alphanumerics, stop-word removal, suffix stripping (ing/ed/es/s)" },
    corpus: { total_docs: docs.length, fingerprint, per_collection: perCol },
    benchmark: { total_queries: results.length, by_kind: byKind, by_collection: byCol, by_tag: byTag },
    metrics: { overall: { ...aggregate(results), negative: negAggregate(results) }, per_collection },
    failures: {
      genuine_retrieval_failures: retrievalResults.filter((r) => r.metrics!.p_at_1 === 0 || r.metrics!.recall_at_3 < 1),
      wrong_top_result: wrong,
      no_relevant_result: [...none, ...retrievalResults.filter((r) => r.best_relevant_rank === null && r.outcome === "wrong_top_result")],
      negative_queries_that_returned_results: noisy,
    },
    missing_knowledge: {
      empty_collections: emptyCollections,
      queries: mkQueries,
      notes: [
        "missing_knowledge queries are legitimate questions the system should be able to answer; the corpus has no document for them. They are excluded from P@1, Recall@3, MRR and nDCG@3 and are not retrieval failures.",
        "Returning an empty result for them is correct behaviour today; the fix is to author and verify the documents, not to change retrieval.",
      ],
    },
    limitations,
    queries: results,
  };
}

// ---------- Markdown ----------

const pct = (n: number | null) => (n === null ? "n/a" : n.toFixed(3));
const row = (name: string, a: Aggregate, n: NegAggregate, mk?: { queries: number; returned_empty: number }) =>
  `| ${name} | ${a.queries} | ${pct(a.p_at_1)} | ${pct(a.recall_at_3)} | ${pct(a.mrr)} | ${pct(a.ndcg_at_3)} | ${n.queries ? `${n.empty_correct}/${n.queries} (${pct(n.accuracy)})` : "n/a"} | ${mk ? mk.queries : "-"} |`;

export function formatMarkdown(b: Baseline): string {
  const L: string[] = [];
  L.push("# BM25 retrieval baseline (Step 2B)", "");
  L.push(`Retriever: \`${b.retriever.name}\` (${b.retriever.algorithm}, k1=${b.retriever.k1}, b=${b.retriever.b}). Corpus: ${b.corpus.total_docs} documents, fingerprint \`${b.corpus.fingerprint}\`.`);
  L.push(`Benchmark: **${b.benchmark.total_queries} queries** (${b.benchmark.by_kind.retrieval} retrieval, ${b.benchmark.by_kind.negative} negative, ${b.benchmark.by_kind.missing_knowledge} missing-knowledge). Generated by \`npm run eval:retrieval\`; output is deterministic.`, "");
  L.push("## Collection coverage", "", "| Collection | Docs | Retrieval | Negative | Missing-knowledge | Note |", "|---|---|---|---|---|---|");
  for (const c of COLLECTIONS) {
    const k = b.benchmark.by_collection[c] ?? { retrieval: 0, negative: 0, missing_knowledge: 0 };
    L.push(`| ${c} | ${b.corpus.per_collection[c]!.docs} | ${k.retrieval} | ${k.negative} | ${k.missing_knowledge} | ${b.corpus.per_collection[c]!.note ?? ""} |`);
  }
  L.push("", "## Metrics", "", "P@1, Recall@3, MRR and nDCG@3 are averaged over retrieval queries only. Negative accuracy = share of negative queries that returned an empty result.", "");
  L.push("| Scope | Retrieval queries | P@1 | Recall@3 | MRR | nDCG@3 | Negative accuracy | Missing-knowledge queries |", "|---|---|---|---|---|---|---|---|");
  for (const c of COLLECTIONS) { const m = b.metrics.per_collection[c]!; L.push(row(c, m, m.negative, m.missing_knowledge)); }
  L.push(row("**Overall**", b.metrics.overall, b.metrics.overall.negative, { queries: b.benchmark.by_kind.missing_knowledge, returned_empty: b.missing_knowledge.queries.filter((q) => q.returned_empty).length }));

  L.push("", "## Genuine retrieval failures", "", "The relevant document exists, is eligible under the query's filter, and BM25 still did not rank it first.", "");
  const f = b.failures.genuine_retrieval_failures;
  if (!f.length) L.push("None.");
  for (const r of f) L.push(`- **${r.id}** (${r.collection}) \`${r.query}\` — expected ${r.expect.join(", ")}${r.equivalent.length ? ` (or ${r.equivalent.join(", ")})` : ""}; got ${r.returned.slice(0, 3).map((h) => h.id).join(", ") || "nothing"}; best relevant rank ${r.best_relevant_rank ?? "none"}; R@3 ${pct(r.metrics!.recall_at_3)}. Cause: ${r.cause ?? "partial recall"}${r.cause_detail ? ` (${r.cause_detail})` : ""}.`);

  L.push("", "## Queries with an incorrect top result", "");
  if (!b.failures.wrong_top_result.length) L.push("None.");
  for (const r of b.failures.wrong_top_result) L.push(`- ${r.id}: top result \`${r.returned[0]?.id}\`, expected ${[...r.expect, ...r.equivalent].join(" / ")}`);

  L.push("", "## Retrieval queries with no relevant result in the top 3", "");
  const noRel = b.queries.filter((r) => r.kind === "retrieval" && r.metrics!.recall_at_3 === 0);
  if (!noRel.length) L.push("None.");
  for (const r of noRel) L.push(`- ${r.id}: \`${r.query}\` returned ${r.returned.slice(0, 3).map((h) => h.id).join(", ") || "nothing"}`);

  L.push("", "## Negative queries", "");
  for (const r of b.queries.filter((x) => x.kind === "negative")) L.push(`- ${r.outcome === "negative_correct" ? "PASS" : "FAIL"} ${r.id} (${r.collection}) \`${r.query}\` → ${r.returned_empty ? "empty" : `returned ${r.returned.slice(0, 3).map((h) => `${h.id} (${h.score})`).join(", ")}`}`);

  L.push("", "## Missing knowledge (corpus gaps, not retrieval failures)", "");
  L.push(`Empty collections: ${b.missing_knowledge.empty_collections.join(", ") || "none"}.`, "");
  for (const r of b.missing_knowledge.queries) L.push(`- ${r.id} (${r.collection}) \`${r.query}\` → ${r.returned_empty ? "empty (correct today)" : `returned noise: ${r.returned.slice(0, 3).map((h) => h.id).join(", ")}`}. ${r.why}`);
  L.push("", ...b.missing_knowledge.notes.map((n) => `- ${n}`));

  L.push("", "## Retrieval limitations discovered", "", ...b.limitations.map((l) => `- ${l}`));

  L.push("", "## Every query", "", "| ID | Collection | Kind | Query | Top 3 | Best relevant rank | Outcome |", "|---|---|---|---|---|---|---|");
  for (const r of b.queries) L.push(`| ${r.id} | ${r.collection} | ${r.kind} | ${r.query.replace(/\|/g, "\\|")} | ${r.returned.slice(0, 3).map((h) => h.id).join(", ") || "-"} | ${r.best_relevant_rank ?? "-"} | ${r.outcome} |`);
  L.push("");
  return L.join("\n");
}
