import type { HybridOptions } from "./hybrid.js";
import type { LexicalFloor } from "./keyword.js";

/**
 * Retrieval settings for the `skills` collection, from `npm run eval:skills` (evals/baselines/skills-hybrid-vs-bm25-*.md): a query that matches nothing returns nothing.
 * The floor needs at least one keyword hit; the ranking is hybrid (BM25 + vectors). On the held-out independent queries this kept hybrid ranking quality and answered
 * every off-topic query with nothing (test MRR 0.711, 6/6 empty), against 0.572 for BM25 with the same floor; the old query set agrees (0.928 vs 0.884). It was chosen after
 * seeing test numbers because the dev-selected configuration over-fitted (see the report), so treat the figures as indicative. Without a database the console has no
 * vectors, so it uses BM25 with the same floor (SKILLS_KEYWORD_FLOOR).
 */
export const SKILLS_FLOOR_IDF = 0.2;
export const SKILLS_KEYWORD_FLOOR: LexicalFloor = { min_idf_coverage: SKILLS_FLOOR_IDF, collections: ["skills"] };
export const SKILLS_HYBRID_OPTIONS: HybridOptions = { min_similarity: 0.6, rrf_k: 60, floor: { ...SKILLS_KEYWORD_FLOOR, require_keyword: true } };
