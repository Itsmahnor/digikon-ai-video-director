/**
 * Which retriever is running, said out loud. The console builds one of these at start-up, serves it on /api/health and shows a banner whenever it is degraded,
 * so nobody is on keyword-only search or on the wording-only hash embedder without knowing.
 */
export type RetrievalMode = "pgvector-hybrid" | "memory-hybrid" | "bm25-only";

export interface RetrievalStatus {
  mode: RetrievalMode;
  /** The embedder in use; `real` is false for the hash embedder, which matches wording and word forms, not meaning. */
  embedder: { model: string; version: string; real: boolean } | null;
  counts: { skills: number; templates: number; recipes: number; notes: number };
  /** Plain-language reasons the semantic path is not fully active. Empty when everything is as intended. */
  degraded: string[];
  /** Where the vectors came from this start: "computed" or "cache (n of m)". */
  vectors: string | null;
}

export const isSemantic = (s: RetrievalStatus): boolean => s.mode !== "bm25-only" && !!s.embedder?.real;

/** One line for the console log and the UI banner. */
export function describeRetrieval(s: RetrievalStatus): string {
  const head = s.mode === "bm25-only" ? "Retrieval: KEYWORD ONLY (BM25). Meaning-based search is OFF." : `Retrieval: ${s.mode} (BM25 + vectors; ${s.embedder?.model}@${s.embedder?.version}).`;
  const tail = `skills ${s.counts.skills}, templates ${s.counts.templates}, recipes ${s.counts.recipes}, notes ${s.counts.notes}.`;
  return [head, tail, ...s.degraded.map((d) => `WARNING: ${d}`)].join(" ");
}
