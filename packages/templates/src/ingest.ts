import type { LibraryTemplate } from "@digikon/contracts";
import { contentHash, type DataStore, type Embedder, type TemplateRow } from "@digikon/rag";
import { categoryRows } from "./categories.js";
import { LOOK_MODEL, LOOK_MODEL_VERSION } from "./look.js";
import { readReviews } from "./review.js";

/** The row a library template is stored as. Tags are flattened so the database's tag index and filters can use them. */
export function toRow(t: LibraryTemplate): TemplateRow {
  const g = t.tags;
  return { id: t.template_id, category_id: t.category, title: t.title, family: t.family, variant_of: t.variant_of ?? null, archetype: t.archetype, tags: [...new Set([...g.mood, ...g.tone, ...g.industry, g.energy, g.pacing, g.motion_personality, g.type_personality, ...t.needs.aspect_ratios.map((a) => `aspect:${a}`)])], status: t.status, body: t, content_hash: t.content_hash };
}

export interface IngestSummary { categories: number; added: number; updated: number; unchanged: number; reviews: number; text_vectors: number; look_vectors: number; skipped_no_look: string[] }

/**
 * Builds the database from the library files: seeds the 18 categories (and their two groups), stores each template, and stores its text embedding
 * (of retrieval_text) and its look embedding (CLIP of the preview). A template whose hash is unchanged and which already has both embeddings is left alone,
 * so a second run changes nothing. The review log is mirrored into template_review.
 */
export async function ingestLibrary(store: DataStore, embedder: Embedder, templates: readonly LibraryTemplate[], looks: ReadonlyMap<string, number[]>, o: { reviewRoot?: string } = {}): Promise<IngestSummary> {
  const s: IngestSummary = { categories: 0, added: 0, updated: 0, unchanged: 0, reviews: 0, text_vectors: 0, look_vectors: 0, skipped_no_look: [] };
  for (const c of categoryRows()) { await store.upsertCategory(c); s.categories++; }
  const have = new Set((await store.listCategories()).map((c) => c.id));
  const want = new Map<string, number[]>();
  const probeVec = (await embedder.embed(["probe"]))[0]!;
  const embedded = new Set((await store.nearest({ kind: "text", model: embedder.model, model_version: embedder.version, vector: probeVec, k: 100000 })).map((n) => n.template_id));
  const lookDone = new Set((await store.nearest({ kind: "look", model: LOOK_MODEL, model_version: LOOK_MODEL_VERSION, vector: [...looks.values()][0] ?? [], k: 100000 }).catch(() => [])).map((n) => n.template_id));
  // a variant references its base by foreign key, so bases go first; a variant whose base is not in this library keeps its family but has no variant_of
  const known = new Set(templates.map((t) => t.template_id));
  const ordered = [...templates].sort((a, b) => Number(!!a.variant_of) - Number(!!b.variant_of) || a.template_id.localeCompare(b.template_id));
  for (const t of ordered) {
    if (!have.has(t.category)) throw new Error(`category ${t.category} is not seeded`);
    const row = { ...toRow(t), variant_of: t.variant_of && known.has(t.variant_of) ? t.variant_of : null }, before = await store.getTemplate(t.template_id);
    const look = looks.get(t.template_id);
    if (!look) { s.skipped_no_look.push(t.template_id); continue; }
    if (before && before.content_hash === row.content_hash && before.status === row.status && embedded.has(t.template_id) && lookDone.has(t.template_id)) { s.unchanged++; continue; }
    await store.upsertTemplate(row);
    want.set(t.template_id, look);
    if (before) s.updated++; else s.added++;
  }
  const changed = templates.filter((t) => want.has(t.template_id));
  const vecs = changed.length ? await embedder.embed(changed.map((t) => `${t.title}. ${t.retrieval_text}`)) : [];
  for (let i = 0; i < changed.length; i++) {
    const t = changed[i]!;
    await store.upsertEmbedding({ template_id: t.template_id, kind: "text", model: embedder.model, model_version: embedder.version, vector: vecs[i]! }); s.text_vectors++;
    await store.upsertEmbedding({ template_id: t.template_id, kind: "look", model: LOOK_MODEL, model_version: LOOK_MODEL_VERSION, vector: want.get(t.template_id)! }); s.look_vectors++;
  }
  const done = new Set((await store.listReviews()).map((r) => `${r.template_id}|${r.verdict}|${r.notes}`));
  for (const r of readReviews(o.reviewRoot)) if (known.has(r.template_id) && !done.has(`${r.template_id}|${r.verdict}|${r.notes}`) && (await store.getTemplate(r.template_id))) { await store.addReview({ template_id: r.template_id, reviewer: r.reviewer, verdict: r.verdict, notes: r.notes }); s.reviews++; }
  void contentHash;
  return s;
}
