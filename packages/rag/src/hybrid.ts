import { dot, type Embedder } from "./embeddings.js";
import { eligible, KeywordRetriever, type LexicalFloor } from "./keyword.js";
import { mmr, noRepeat, type NoRepeatOptions, type UsageSource } from "./rerank.js";
import type { Collection, Doc, Hit, RetrieveFilter, RetrieveQuery, Retriever } from "./types.js";

/**
 * Hybrid retrieval behind the same `Retriever` interface the Director already uses: BM25 (KeywordRetriever) and vector similarity are each ranked,
 * then fused with reciprocal rank fusion, so neither score scale matters. Eligibility rules are applied to both lists before fusion; a vector hit
 * below `min_similarity` is dropped, which is what lets a query that matches nothing return nothing.
 */

/** Something that answers "which documents are nearest to this vector". */
export interface VectorIndex { search(vector: readonly number[], k: number): Promise<{ id: string; score: number }[]> }

/** Vectors held in memory (tests, and any corpus small enough that a database adds nothing). */
export class MemoryVectorIndex implements VectorIndex {
  readonly vectors = new Map<string, readonly number[]>();
  set(id: string, v: readonly number[]) { this.vectors.set(id, v); }
  async search(vector: readonly number[], k: number) {
    return [...this.vectors].map(([id, v]) => ({ id, score: dot(v, vector) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
  }
}

/** Searches the skill embeddings in a DataStore, for one embedding model. */
export function skillVectorIndex(store: { nearestSkills(q: { model: string; model_version: string; vector: readonly number[]; k: number }): Promise<{ skill_id: string; score: number }[]> }, embedder: Embedder): VectorIndex {
  return { search: async (vector, k) => (await store.nearestSkills({ model: embedder.model, model_version: embedder.version, vector, k })).map((n) => ({ id: n.skill_id, score: n.score })) };
}

/** Searches the template embeddings in a DataStore (Memory or Postgres + pgvector), for one embedding model. */
export function storeVectorIndex(store: { nearest(q: { kind: "text" | "look"; model: string; model_version: string; vector: readonly number[]; k: number }): Promise<{ template_id: string; score: number }[]> }, embedder: Embedder): VectorIndex {
  return { search: async (vector, k) => (await store.nearest({ kind: "text", model: embedder.model, model_version: embedder.version, vector, k })).map((n) => ({ id: n.template_id, score: n.score })) };
}

export interface HybridOptions {
  /** Reciprocal rank fusion constant. 60 is the usual value. */
  rrf_k?: number;
  /** How many candidates each ranker contributes before fusion. */
  candidates?: number;
  /** Vector hits below this cosine similarity are ignored. */
  min_similarity?: number;
  /** Weights of the two rankers in the fusion. */
  weight_lexical?: number;
  weight_vector?: number;
  /** Variety: MMR re-rank with this lambda (1 turns it off). Needs document vectors. */
  mmr_lambda?: number;
  /** Library use history; with a film id in the query filter, what the film already used is pushed down. */
  usage?: UsageSource;
  no_repeat?: NoRepeatOptions;
  /**
   * Lets a query return nothing, for the listed collections only. `min_idf_coverage` is the BM25 floor (see LexicalFloor). `lexical_min_similarity` says that a document found only
   * by keywords must also have at least this cosine similarity to the query; a document found by vectors is judged by `min_similarity` as before.
   */
  floor?: LexicalFloor & {
    lexical_min_similarity?: number;
    /** Abstain: if no eligible document has at least this cosine similarity to the query, return nothing at all (keyword hits included). Leaves queries that do have a close document untouched. */
    abstain_below?: number;
    /** Two-stage: if the keyword floor leaves no keyword hit at all, return nothing (vector hits included); otherwise rank with both rankers as usual. Needs min_idf_coverage > 0. */
    require_keyword?: boolean;
  };
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);

export class HybridRetriever implements Retriever {
  private readonly lexical: KeywordRetriever;
  private readonly byId = new Map<string, Doc>();
  private readonly vectors = new Map<string, readonly number[]>();

  /** Use `HybridRetriever.create` to embed the documents; this takes vectors that are already made. */
  constructor(private readonly docs: Doc[], private readonly embedder: Embedder, private readonly index: VectorIndex, private readonly opts: HybridOptions = {}, vectors?: ReadonlyMap<string, readonly number[]>) {
    this.lexical = new KeywordRetriever(docs, 1.5, 0.75, opts.floor ? { min_idf_coverage: opts.floor.min_idf_coverage, collections: opts.floor.collections } : undefined);
    for (const d of docs) this.byId.set(`${d.collection}\u0000${d.id}`, d);
    if (vectors) for (const [k, v] of vectors) this.vectors.set(k, v);
  }

  /** Embeds every document (title twice, as the keyword ranker weights it) and indexes them in memory. */
  static async create(docs: Doc[], embedder: Embedder, opts: HybridOptions = {}): Promise<HybridRetriever> {
    const vs = await embedder.embed(docs.map((d) => `${d.title}. ${d.title}. ${d.text}`));
    const index = new MemoryVectorIndex();
    const map = new Map<string, readonly number[]>();
    docs.forEach((d, i) => { index.set(`${d.collection}\u0000${d.id}`, vs[i]!); map.set(`${d.collection}\u0000${d.id}`, vs[i]!); });
    return new HybridRetriever(docs, embedder, index, opts, map);
  }

  get(id: string, collection: Collection, filter?: RetrieveFilter) { return this.lexical.get(id, collection, filter); }

  async retrieve(q: RetrieveQuery): Promise<Hit[]> {
    const o = this.opts, rrfK = o.rrf_k ?? 60, n = o.candidates ?? 50, minSim = o.min_similarity ?? 0.2, wl = o.weight_lexical ?? 1, wv = o.weight_vector ?? 1;
    const lex = await this.lexical.retrieve({ ...q, k: n, max_tokens: undefined });
    const qv = this.embedder.embedQuery ? await this.embedder.embedQuery(q.text) : (await this.embedder.embed([q.text]))[0];
    const raw = qv ? await this.index.search(qv, Math.max(n * 4, 200)) : [];
    const vec: { doc: Doc; sim: number }[] = [];
    for (const r of raw) {
      if (r.score < minSim) continue;
      const doc = this.byId.get(r.id.includes("\u0000") ? r.id : `${q.collection}\u0000${r.id}`);
      if (!doc || doc.collection !== q.collection || !eligible(doc, q.filter)) continue;
      vec.push({ doc, sim: r.score });
      if (vec.length >= n) break;
    }

    const abstainBelow = o.floor?.abstain_below !== undefined && o.floor.collections.includes(q.collection) ? o.floor.abstain_below : null;
    if (abstainBelow !== null) {
      let best = -1;
      for (const r of raw) {
        const doc = this.byId.get(r.id.includes("\u0000") ? r.id : `${q.collection}\u0000${r.id}`);
        if (doc && doc.collection === q.collection && eligible(doc, q.filter) && r.score > best) best = r.score;
      }
      if (best < abstainBelow) return [];
    }
    // Cosine similarity of every document the vector index returned, for the keyword-only gate below.
    const simOf = new Map<string, number>();
    for (const r of raw) { if (r.id.includes("\u0000")) { const [c, id] = r.id.split("\u0000"); if (c === q.collection) simOf.set(id!, r.score); } else simOf.set(r.id, r.score); }
    const gate = o.floor && o.floor.lexical_min_similarity !== undefined && o.floor.collections.includes(q.collection) ? o.floor.lexical_min_similarity : null;
    const vecIds = new Set(vec.map((v) => v.doc.id));
    if (o.floor?.require_keyword && o.floor.min_idf_coverage > 0 && o.floor.collections.includes(q.collection) && lex.length === 0) return [];
    const fused = new Map<string, Hit>();
    lex.filter((h) => gate === null || vecIds.has(h.doc.id) || (simOf.get(h.doc.id) ?? -1) >= gate).forEach((h, i) => fused.set(h.doc.id, { doc: h.doc, score: wl / (rrfK + i + 1) }));
    vec.forEach((v, i) => {
      const cur = fused.get(v.doc.id);
      fused.set(v.doc.id, { doc: v.doc, score: (cur?.score ?? 0) + wv / (rrfK + i + 1) });
    });
    let hits = [...fused.values()].sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));

    if (o.usage && q.filter?.film_id !== undefined) hits = noRepeat(hits, await o.usage.usage(q.filter.film_id), o.no_repeat);
    if (o.mmr_lambda !== undefined && o.mmr_lambda < 1) hits = mmr(hits, await this.vectorsFor(hits.map((h) => h.doc)), q.k, o.mmr_lambda);

    const out: Hit[] = [];
    let used = 0;
    for (const h of hits.slice(0, q.k)) {
      const cost = approxTokens(h.doc.text) + approxTokens(h.doc.title);
      if (q.max_tokens !== undefined && used + cost > q.max_tokens && out.length > 0) break;
      used += cost;
      out.push(h);
    }
    return out;
  }

  private async vectorsFor(docs: readonly Doc[]): Promise<Map<string, readonly number[]>> {
    const missing = docs.filter((d) => !this.vectors.has(`${d.collection}\u0000${d.id}`));
    if (missing.length) {
      const vs = await this.embedder.embed(missing.map((d) => `${d.title}. ${d.title}. ${d.text}`));
      missing.forEach((d, i) => this.vectors.set(`${d.collection}\u0000${d.id}`, vs[i]!));
    }
    return new Map(docs.map((d) => [d.id, this.vectors.get(`${d.collection}\u0000${d.id}`)!]));
  }
}

