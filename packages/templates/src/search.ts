import type { LibraryTemplate, TemplateCategory } from "@digikon/contracts";
import { HybridRetriever, storeVectorIndex, type DataStore, type Doc, type Embedder, type NoRepeatOptions } from "@digikon/rag";
import { isValidAtAll, validateTemplate } from "./library.js";

/**
 * `search_templates`: hybrid retrieval (BM25 over the retrieval text, vector similarity over the stored text embeddings, reciprocal-rank fusion) over the
 * templates in the data store, with hard filters applied first, then MMR for variety and a no-repeat penalty from template_usage. It reads only the
 * store, never the files, and nothing in the Director or Editor calls it yet.
 */

export interface TemplateQuery {
  text: string;
  category?: TemplateCategory;
  /** Only templates that declare this aspect ratio. */
  aspect?: "16:9" | "9:16" | "1:1";
  /** Which statuses may be returned. Default: reviewed only. */
  status?: ("draft" | "reviewed")[];
  /** Only templates with review evidence, a licence that is ok, and a valid scene graph at every aspect ratio they declare; with `min_uses`, also used at least that many times. */
  proven_only?: boolean;
  min_uses?: number;
  /** The film being directed: what it already used is pushed down. */
  film_id?: string;
  k?: number;
  /** Variety: 1 turns MMR off. */
  mmr_lambda?: number;
  no_repeat?: NoRepeatOptions;
  /** Restrict to a family or exclude families already chosen. */
  exclude_families?: string[];
}
export interface TemplateHit { template_id: string; score: number; category: string; family: string; status: string; title: string; why: string[] }

const bodyOf = (row: { body: unknown }) => row.body as LibraryTemplate;

export function isProven(t: LibraryTemplate, uses: number, minUses = 0): boolean {
  return t.status === "reviewed" && t.source.licence_ok && t.evidence.some((e) => e.kind === "review") && isValidAtAll(validateTemplate(t), t.needs.aspect_ratios) && uses >= minUses;
}

export async function searchTemplates(store: DataStore, embedder: Embedder, q: TemplateQuery): Promise<TemplateHit[]> {
  const statuses = new Set(q.status ?? ["reviewed"]);
  const usage = await store.usage(q.film_id);
  const rows = (await store.listTemplates()).filter((r) => r.status !== "retired" && statuses.has(r.status as "draft" | "reviewed") && (!q.category || r.category_id === q.category));
  const eligible: Doc[] = [], bodies = new Map<string, LibraryTemplate>();
  for (const r of rows) {
    const t = bodyOf(r);
    if (q.aspect && !t.needs.aspect_ratios.includes(q.aspect)) continue;
    if (q.exclude_families?.includes(t.family)) continue;
    if (q.proven_only && !isProven(t, usage.total.get(t.template_id) ?? 0, q.min_uses ?? 0)) continue;
    bodies.set(t.template_id, t);
    eligible.push({ id: t.template_id, collection: "shot_recipes", title: t.title, text: t.retrieval_text, source: `template ${t.template_id}`, metadata: { recipe_status: t.status === "reviewed" ? "reviewed" : "draft", recipe_implemented: t.status === "reviewed", recipe_energy: t.tags.energy, recipe_aspect_ratios: t.needs.aspect_ratios, topics: [...t.tags.mood, ...t.tags.tone] } });
  }
  if (!eligible.length) return [];
  const r = new HybridRetriever(eligible, embedder, restrict(storeVectorIndex(store, embedder), new Set(eligible.map((d) => d.id))), { usage: { usage: async (film) => (film === q.film_id ? usage : await store.usage(film)) }, mmr_lambda: q.mmr_lambda ?? 0.75, no_repeat: q.no_repeat, candidates: 80, min_similarity: 0.15 });
  const hits = await r.retrieve({ text: q.text, collection: "shot_recipes", k: q.k ?? 8, filter: { include_draft: statuses.has("draft"), film_id: q.film_id, aspect_ratio: q.aspect } });
  return hits.map((h) => {
    const t = bodies.get(h.doc.id)!;
    const why = [`category ${t.category}`, `${t.tags.motion_personality} motion`, `${t.tags.type_personality} type`, `${t.tags.energy} energy`];
    const used = usage.in_film.get(h.doc.id) ?? 0;
    if (used) why.push(`already used ${used}x in this film (ranked lower)`);
    return { template_id: h.doc.id, score: Math.round(h.score * 1e5) / 1e5, category: t.category, family: t.family, status: t.status, title: t.title, why };
  });
}

/** The store's vector search is over every template; keep only hits that passed the hard filters, so a filtered-out template can never be returned. */
const restrict = (index: ReturnType<typeof storeVectorIndex>, allowed: ReadonlySet<string>): ReturnType<typeof storeVectorIndex> => ({ search: async (v, k) => (await index.search(v, k)).filter((h) => allowed.has(h.id.includes("\u0000") ? h.id.split("\u0000")[1]! : h.id)) });
