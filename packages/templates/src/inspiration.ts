import type { LibraryTemplate } from "@digikon/contracts";
import type { DataStore, Embedder } from "@digikon/rag";
import { searchTemplates } from "./search.js";
import { jaccard, structuralFeatures } from "./library.js";
import { toRow } from "./ingest.js";
import { categoryRows } from "./categories.js";

/**
 * The template library as inspiration for the Director, without a database. Templates are read from the files, their text is embedded once (and cached by the
 * caller's embedder) and kept in a MemoryDataStore, so `searchTemplates` (hybrid BM25 + vectors, MMR variety, no-repeat) runs exactly as it does on Postgres.
 * The "look" (CLIP of a rendered frame) is not needed for this and is not computed.
 */

/** Stores templates and their text embeddings. Unchanged content is not re-embedded when the embedder caches. Returns how many were stored. */
export async function ingestTemplateText(store: DataStore, embedder: Embedder, templates: readonly LibraryTemplate[]): Promise<number> {
  for (const c of categoryRows()) await store.upsertCategory(c);
  const known = new Set(templates.map((t) => t.template_id));
  const ordered = [...templates].sort((a, b) => Number(!!a.variant_of) - Number(!!b.variant_of) || a.template_id.localeCompare(b.template_id));
  for (const t of ordered) await store.upsertTemplate({ ...toRow(t), variant_of: t.variant_of && known.has(t.variant_of) ? t.variant_of : null });
  const vecs = await embedder.embed(ordered.map((t) => `${t.title}. ${t.retrieval_text}`));
  for (let i = 0; i < ordered.length; i++) await store.upsertEmbedding({ template_id: ordered[i]!.template_id, kind: "text", model: embedder.model, model_version: embedder.version, vector: vecs[i]! });
  return ordered.length;
}

/** The part of the structural fingerprint that is about layout (where things sit, how big, which roles, stagger), so a composition and a template can be compared. */
const LAYOUT_PREFIXES = ["text@", "shape@", "text:px", "shape:s", "font:", "align:", "stagger:", "shape:rect", "shape:ellipse", "shape:line"];
export const layoutFeatures = (t: LibraryTemplate): Set<string> => new Set([...structuralFeatures(t)].filter((f) => LAYOUT_PREFIXES.some((p) => f.startsWith(p))));

interface CompositionLike { elements?: readonly { kind: string; at: { x: number; y: number; w: number; h?: number }; size?: number; align?: string; font?: string; shape?: string; motion?: { stagger?: { unit: string } } }[] }

/** The same layout tokens, derived from a Director composition (shares of the frame, so no pixel conversion is needed; sizes use a 1080 px shorter side). */
export function compositionLayoutFeatures(c: CompositionLike): Set<string> {
  const f = new Set<string>();
  for (const e of c.elements ?? []) {
    const isText = e.kind === "text";
    const cx = e.at.x + (isText ? (e.align === "center" ? e.at.w / 2 : e.align === "right" ? e.at.w : 0) : e.at.w / 2), cy = e.at.y + (isText ? 0 : (e.at.h ?? 0) / 2);
    const cell = `${Math.min(2, Math.max(0, Math.floor(cx * 3)))}${Math.min(2, Math.max(0, Math.floor(cy * 3)))}`;
    const kind = isText ? "text" : "shape";
    f.add(`${kind}@${cell}`);
    if (isText) { f.add(`text:px${Math.round(Math.log2(Math.max(8, (e.size ?? 0.05) * 1080)) * 2)}`); f.add(`font:${e.font ?? "body"}`); f.add(`align:${e.align ?? "left"}`); }
    else { f.add(`shape:s${Math.round(Math.log2(Math.max(8, Math.max(e.at.w, e.at.h ?? 0) * 1080)))}`); if (e.shape) f.add(`shape:${e.shape}`); }
    if (e.motion?.stagger) f.add(`stagger:${e.motion.stagger.unit}`);
  }
  return f;
}

export function layoutSimilarity(c: CompositionLike, t: LibraryTemplate): number { return jaccard(compositionLayoutFeatures(c), layoutFeatures(t)); }

export interface TemplateInspiration {
  suggest(q: { text: string; category?: string; film_id?: string; exclude_families?: string[]; k: number }): Promise<{ template_id: string; title: string; family: string; category: string; summary: string; motion: string; type: string; energy: string }[]>;
  compare(composition: unknown, template_ids: readonly string[]): Promise<{ template_id: string; similarity: number }[]>;
  readonly count: number;
}

/** Builds the Director's inspiration port over an already-filled store. `include_draft`: every shipped template is draft until reviewed, so drafts are included. */
export async function buildInspiration(store: DataStore, embedder: Embedder): Promise<TemplateInspiration> {
  const rows = await store.listTemplates();
  const bodies = new Map(rows.map((r) => [r.id, r.body as LibraryTemplate]));
  return {
    count: rows.length,
    async suggest(q) {
      const hits = await searchTemplates(store, embedder, { text: q.text, ...(q.category ? { category: q.category as never } : {}), status: ["draft", "reviewed"], k: q.k, ...(q.film_id ? { film_id: q.film_id } : {}), ...(q.exclude_families?.length ? { exclude_families: q.exclude_families } : {}) });
      return hits.map((h) => {
        const t = bodies.get(h.template_id)!;
        return { template_id: h.template_id, title: t.title, family: t.family, category: t.category, summary: t.retrieval_text.replace(/\s+/g, " ").slice(0, 170), motion: t.tags.motion_personality, type: t.tags.type_personality, energy: t.tags.energy };
      });
    },
    async compare(composition, ids) {
      return ids.flatMap((id) => { const t = bodies.get(id); return t ? [{ template_id: id, similarity: layoutSimilarity(composition as CompositionLike, t) }] : []; });
    },
  };
}


