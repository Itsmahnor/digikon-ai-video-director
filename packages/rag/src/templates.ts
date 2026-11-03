import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TemplateRecord } from "@digikon/contracts";
import type { DataStore, TemplateRow } from "./db/store.js";
import { dot, type Embedder } from "./embeddings.js";
import type { Doc } from "./types.js";

/**
 * Putting template files into the data store, finding near-duplicates among them, and presenting them to retrieval as documents.
 * A template file is a `digikon.template` JSON record (contracts/templates.ts). Ingest validates it, stores it, and embeds what a viewer would
 * search by: title, description, tags, archetypes and the scene needs it serves.
 */

export const canonicalJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));
export const contentHash = (v: unknown): string => createHash("sha256").update(canonicalJson(v)).digest("hex").slice(0, 32);

/** The text that is embedded for a template. */
export const templateEmbeddingText = (t: TemplateRecord): string =>
  [t.title, t.description, t.archetypes.join(" "), t.tags.join(" "), `serves ${t.serves_needs.join(" ")}`, `energy ${t.energy}`].join(". ");

export const toRow = (t: TemplateRecord): TemplateRow => ({ id: t.template_id, category_id: t.category, title: t.title, family: t.family ?? null, variant_of: t.variant_of ?? null, archetype: t.archetypes[0] ?? null, tags: t.tags, status: t.status, body: t, content_hash: contentHash(t) });

/** A template as a retrievable document, so templates can be ranked by the same Retriever as recipes and knowledge. */
export function templateDoc(row: TemplateRow): Doc {
  const body = row.body as Partial<TemplateRecord>;
  return {
    id: row.id, collection: "shot_recipes", title: row.title,
    text: [body.description ?? "", (body.archetypes ?? []).join(" "), row.tags.join(" ")].filter(Boolean).join(". "),
    source: `template ${row.id}`,
    metadata: { recipe_status: row.status === "draft" ? "draft" : "reviewed", recipe_implemented: row.status === "approved", recipe_energy: body.energy, recipe_aspect_ratios: body.aspect_ratios as string[] | undefined, topics: row.tags },
  };
}

export interface IngestResult { added: string[]; updated: string[]; unchanged: string[]; rejected: { file: string; problems: string[] }[] }

/** Reads every *.json in a folder as a template record. Files that are not valid records are reported, never stored. */
export function readTemplateFiles(dir: string): { file: string; record: TemplateRecord | null; problems: string[] }[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((file) => {
    try {
      const parsed = TemplateRecord.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
      return parsed.success ? { file, record: parsed.data, problems: [] } : { file, record: null, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`) };
    } catch (e) { return { file, record: null, problems: [`not readable JSON: ${e instanceof Error ? e.message : String(e)}`] }; }
  });
}

/** Stores the records and embeds them. A record whose content has not changed and already has an embedding for this model is left alone. */
export async function ingestTemplates(store: DataStore, embedder: Embedder, records: readonly TemplateRecord[], rejected: IngestResult["rejected"] = []): Promise<IngestResult> {
  const res: IngestResult = { added: [], updated: [], unchanged: [], rejected: [...rejected] };
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.template_id)) { res.rejected.push({ file: r.template_id, problems: ["duplicate template_id in this ingest"] }); continue; }
    seen.add(r.template_id);
    const row = toRow(r), before = await store.getTemplate(r.template_id);
    const probe = await store.nearest({ kind: "text", model: embedder.model, model_version: embedder.version, vector: (await embedder.embed([templateEmbeddingText(r)]))[0]!, k: 5000 });
    const embedded = probe.some((n) => n.template_id === r.template_id);
    if (before && before.content_hash === row.content_hash && embedded) { res.unchanged.push(r.template_id); continue; }
    await store.upsertTemplate(row);
    const [vector] = await embedder.embed([templateEmbeddingText(r)]);
    await store.upsertEmbedding({ template_id: r.template_id, kind: "text", model: embedder.model, model_version: embedder.version, vector: vector! });
    (before ? res.updated : res.added).push(r.template_id);
  }
  return res;
}

export interface NearDuplicate { a: string; b: string; similarity: number; same_family: boolean }
export interface DedupeReport {
  threshold: number;
  model: string;
  templates: number;
  pairs: NearDuplicate[];
  /** Each template's closest other template, whether or not it is over the threshold. */
  nearest: { id: string; neighbour: string | null; similarity: number }[];
}

/** Finds templates that are too alike: every pair at or above `threshold` cosine similarity, and each template's nearest neighbour. */
export async function dedupeReport(store: DataStore, embedder: Embedder, threshold = 0.9): Promise<DedupeReport> {
  const rows = await store.listTemplates();
  const vectors = new Map<string, number[]>();
  for (const r of rows) {
    const text = templateEmbeddingText(r.body as TemplateRecord);
    vectors.set(r.id, (await embedder.embed([text]))[0]!);
  }
  const ids = [...vectors.keys()].sort();
  const fam = new Map(rows.map((r) => [r.id, r.family]));
  const pairs: NearDuplicate[] = [], best = new Map<string, { n: string; s: number }>();
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i]!, b = ids[j]!, s = dot(vectors.get(a)!, vectors.get(b)!);
    if (s >= threshold) pairs.push({ a, b, similarity: Math.round(s * 1e4) / 1e4, same_family: fam.get(a) !== null && fam.get(a) === fam.get(b) });
    for (const [x, y] of [[a, b], [b, a]] as const) if (!best.has(x) || s > best.get(x)!.s) best.set(x, { n: y, s });
  }
  pairs.sort((p, q) => q.similarity - p.similarity || p.a.localeCompare(q.a));
  return { threshold, model: `${embedder.model}@${embedder.version}`, templates: ids.length, pairs, nearest: ids.map((id) => ({ id, neighbour: best.get(id)?.n ?? null, similarity: Math.round((best.get(id)?.s ?? 0) * 1e4) / 1e4 })) };
}
