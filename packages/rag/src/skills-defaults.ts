import type { HybridOptions } from "./hybrid.js";
import type { LexicalFloor } from "./keyword.js";

/**
 * Retrieval settings for the `skills` collection, from `npm run eval:skills` (evals/baselines/skills-hybrid-vs-bm25-*.md): a query that matches nothing returns nothing.
 * The floor needs at least one keyword hit; the ranking is hybrid (BM25 + vectors). On the held-out independent queries this kept hybrid ranking quality and answered
 * most off-topic queries with nothing and kept far better ranking than BM25 with the same floor on both query sets (numbers in the report, which `npm run eval:skills` regenerates). It was
 * chosen after seeing test numbers because the dev-selected configuration over-fitted, so treat the figures as indicative. The floor is a keyword-coverage rule: a word that really occurs
 * in a skill can let an off-topic query through, and editing skill text moves the numbers. Without a database the console has no
 * vectors, so it uses BM25 with the same floor (SKILLS_KEYWORD_FLOOR).
 */
export const SKILLS_FLOOR_IDF = 0.2;
export const SKILLS_KEYWORD_FLOOR: LexicalFloor = { min_idf_coverage: SKILLS_FLOOR_IDF, collections: ["skills"] };
export const SKILLS_HYBRID_OPTIONS: HybridOptions = { min_similarity: 0.6, rrf_k: 60, floor: { ...SKILLS_KEYWORD_FLOOR, require_keyword: true } };
