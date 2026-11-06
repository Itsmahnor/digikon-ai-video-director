import type { Embedder } from "./embeddings.js";
import { HybridRetriever, MemoryVectorIndex, type HybridOptions } from "./hybrid.js";
import type { Doc, Retriever } from "./types.js";

/**
 * The no-Docker semantic path: every document (skills included) is embedded once, held in memory, and searched with the same HybridRetriever (BM25 + vectors,
 * reciprocal rank fusion) the Postgres path uses, so eligibility, scopes and filters behave identically. Returns a builder like `createDbBackedRetriever`:
 * the console rebuilds its retriever when the capability registry changes, and that must not re-embed anything.
 */
const key = (d: Pick<Doc, "collection" | "id">) => `${d.collection}\u0000${d.id}`;
const textOf = (d: Doc) => `${d.title}. ${d.title}. ${d.text}`;

export async function createLocalHybridRetriever(embedder: Embedder, baseDocs: readonly Doc[], opts: HybridOptions = {}): Promise<(docs: Doc[]) => Retriever> {
  const vectors = new Map<string, readonly number[]>();
  const vs = baseDocs.length ? await embedder.embed(baseDocs.map(textOf)) : [];
  baseDocs.forEach((d, i) => vectors.set(key(d), vs[i]!));
  return (docs: Doc[]) => {
    const index = new MemoryVectorIndex();
    for (const d of docs) { const v = vectors.get(key(d)); if (v) index.set(key(d), v); }
    return new HybridRetriever(docs, embedder, index, opts, vectors);
  };
}
