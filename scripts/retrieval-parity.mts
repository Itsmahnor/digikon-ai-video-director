import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CachedEmbedder, HybridRetriever, MemoryVectorIndex, SKILLS_LOCAL_OPTIONS, chooseEmbedder, createDbBackedRetriever, embeddingTextOf, loadSkillDocs, openStore, skillDoc, type Doc } from "@digikon/rag";

/**
 * `npm run eval:parity` (needs DATABASE_URL and `npm run skills -- import examples/skills`): runs every local benchmark query through the in-process index and through Postgres + pgvector
 * with the same embedder and options, and reports how often the top results agree. They should be identical up to vector rounding.
 */
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set."); process.exit(2); }
const chosen = chooseEmbedder(join(root, "storage", "models"));
if (!chosen.real) { console.error("No local sentence model."); process.exit(2); }
const emb = new CachedEmbedder(chosen.embedder, join(root, "storage", "index", "eval-skills.json"));
const store = await openStore();
const rows = await store.listSkills();
const dbDocs = rows.map(skillDoc).filter((d): d is Doc => d !== null);
const fileDocs = loadSkillDocs(join(root, "examples", "skills"));
const vs = await emb.embed(fileDocs.map(embeddingTextOf));
const ix = new MemoryVectorIndex(), m = new Map<string, readonly number[]>();
fileDocs.forEach((d, i) => { ix.set(`${d.collection}\u0000${d.id}`, vs[i]!); m.set(`${d.collection}\u0000${d.id}`, vs[i]!); });
const memory = new HybridRetriever(fileDocs, emb, ix, SKILLS_LOCAL_OPTIONS, m);
const pg = (await createDbBackedRetriever(store, emb, [], SKILLS_LOCAL_OPTIONS))(dbDocs);
const qs = (JSON.parse(readFileSync(join(root, "evals", "local-retrieval-benchmark.json"), "utf8")) as { queries: { query: string; filter: Record<string, unknown> }[] }).queries;
let same1 = 0, sameSet5 = 0, sameOrder5 = 0;
for (const q of qs) {
  const a = (await memory.retrieve({ text: q.query, collection: "skills", k: 5, filter: q.filter })).map((h) => h.doc.id);
  const b = (await pg.retrieve({ text: q.query, collection: "skills", k: 5, filter: q.filter })).map((h) => h.doc.id);
  if (a[0] === b[0]) same1++;
  if ([...a].sort().join() === [...b].sort().join()) sameSet5++;
  if (a.join() === b.join()) sameOrder5++; else console.log("differs:", q.query.slice(0, 60), "\n  memory:", a.join(","), "\n  pg:    ", b.join(","));
}
console.log(`queries ${qs.length}: same top-1 ${same1}, same top-5 set ${sameSet5}, same top-5 order ${sameOrder5}`);
await store.close();
