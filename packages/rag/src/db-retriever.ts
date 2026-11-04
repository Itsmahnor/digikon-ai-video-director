import type { SkillNeighbour } from "./db/store.js";
import type { Embedder } from "./embeddings.js";
import { HybridRetriever, MemoryVectorIndex, type HybridOptions, type VectorIndex } from "./hybrid.js";
import type { Doc, Retriever } from "./types.js";

/**
 * The retriever the console uses when DATABASE_URL is set. Skills come from the database (their text, and their stored embeddings through pgvector); everything
 * else (recipes, knowledge notes) is embedded once at start-up. It is the same HybridRetriever (BM25 + vectors, reciprocal rank fusion) as everywhere else, so
 * eligibility, scopes and filters behave identically. It is built synchronously per request from documents whose vectors are already computed, because the console
 * rebuilds its retriever whenever the capability registry changes and must not re-embed then.
 */
export interface SkillVectors { nearestSkills(q: { model: string; model_version: string; vector: readonly number[]; k: number }): Promise<SkillNeighbour[]> }

const key = (d: Pick<Doc, "collection" | "id">) => `${d.collection}\u0000${d.id}`;

/** Vector search over the stored skill embeddings; ids are plain skill ids, which the retriever resolves against the queried collection. */
function skillIndex(store: SkillVectors, embedder: Embedder): VectorIndex {
  return { search: async (vector, k) => (await store.nearestSkills({ model: embedder.model, model_version: embedder.version, vector, k })).map((n) => ({ id: n.skill_id, score: n.score })) };
}

/** Memory index for the non-skill documents, plus the stored skill vectors, merged by score. */
class CompositeIndex implements VectorIndex {
  constructor(private readonly memory: MemoryVectorIndex, private readonly skills: VectorIndex) {}
  async search(vector: readonly number[], k: number) {
    const [a, b] = await Promise.all([this.memory.search(vector, k), this.skills.search(vector, k)]);
    return [...a, ...b].sort((x, y) => y.score - x.score || x.id.localeCompare(y.id)).slice(0, k);
  }
}

export async function createDbBackedRetriever(store: SkillVectors, embedder: Embedder, baseDocs: readonly Doc[], opts: HybridOptions = {}): Promise<(docs: Doc[]) => Retriever> {
  const vectors = new Map<string, readonly number[]>();
  const embed = baseDocs.filter((d) => d.collection !== "skills");
  const vs = await embedder.embed(embed.map((d) => `${d.title}. ${d.title}. ${d.text}`));
  embed.forEach((d, i) => vectors.set(key(d), vs[i]!));
  return (docs: Doc[]) => {
    const memory = new MemoryVectorIndex();
    for (const d of docs) { const v = vectors.get(key(d)); if (v) memory.set(key(d), v); }
    return new HybridRetriever(docs, embedder, new CompositeIndex(memory, skillIndex(store, embedder)), opts, vectors);
  };
}
