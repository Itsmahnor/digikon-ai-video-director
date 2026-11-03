import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LibraryTemplate } from "@digikon/contracts";
import { compare, candidateOf } from "./dedupe.js";
import { LIBRARY_DIR, isValidAtAll, loadLibrary, validateTemplate, writeTemplate } from "./library.js";
import { ensureLooks } from "./looks.js";

/**
 * A simple review queue. Candidates are the library's draft templates that have no decision yet for their current design (content hash). Each is listed
 * beside its nearest neighbours in the same category, so a reviewer sees what it might duplicate. Decisions are appended to
 * templates/_reviews/reviews.jsonl, which is the record of who decided what and why, and are mirrored into the database by `ingest`.
 */

export interface ReviewEntry { template_id: string; content_hash: string; reviewer: string; verdict: "approved" | "rejected" | "needs_changes"; notes: string; at: string }
export const REVIEW_FILE = (root = LIBRARY_DIR) => join(root, "_reviews", "reviews.jsonl");

export function readReviews(root = LIBRARY_DIR): ReviewEntry[] {
  const f = REVIEW_FILE(root);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ReviewEntry);
}

/** The latest decision per template, for its current hash only: a changed design is a new candidate. */
export function latestDecisions(entries: readonly ReviewEntry[], hashes: ReadonlyMap<string, string>): Map<string, ReviewEntry> {
  const m = new Map<string, ReviewEntry>();
  for (const e of entries) if (hashes.get(e.template_id) === e.content_hash) m.set(e.template_id, e);
  return m;
}
export const rejectedIds = (entries: readonly ReviewEntry[]): Set<string> => {
  const last = new Map<string, ReviewEntry>();
  for (const e of entries) last.set(e.template_id, e);
  return new Set([...last.values()].filter((e) => e.verdict === "rejected").map((e) => e.template_id));
};

export interface QueueItem { template: LibraryTemplate; valid: boolean; neighbours: { id: string; look: number; struct: number }[] }

export async function reviewQueue(o: { category?: string; limit?: number; neighbours?: number; root?: string; looksFile?: string } = {}): Promise<QueueItem[]> {
  const recs = loadLibrary(o.root).flatMap((l) => (l.record ? [l.record] : []));
  const hashes = new Map(recs.map((t) => [t.template_id, t.content_hash]));
  const decided = latestDecisions(readReviews(o.root), hashes);
  const pool = recs.filter((t) => !o.category || t.category === o.category);
  const todo = pool.filter((t) => t.status === "draft" && !decided.has(t.template_id)).sort((a, b) => Number(!!a.variant_of) - Number(!!b.variant_of) || a.template_id.localeCompare(b.template_id)).slice(0, o.limit ?? 20);
  const looks = await ensureLooks(pool, { render: false, file: o.looksFile });
  const cands = new Map(pool.map((t) => [t.template_id, candidateOf(t, looks.get(t.template_id)!)]));
  return todo.map((t) => {
    const me = cands.get(t.template_id)!;
    const ns = pool.filter((p) => p.category === t.category && p.template_id !== t.template_id).map((p) => ({ id: p.template_id, ...compare(me, cands.get(p.template_id)!) })).sort((a, b) => b.look - a.look).slice(0, o.neighbours ?? 3);
    return { template: t, valid: isValidAtAll(validateTemplate(t), t.needs.aspect_ratios), neighbours: ns };
  });
}

export function decide(id: string, verdict: ReviewEntry["verdict"], notes: string, reviewer: string, root = LIBRARY_DIR): ReviewEntry {
  if (!notes.trim()) throw new Error("a review decision needs a reason");
  const rec = loadLibrary(root).find((l) => l.record?.template_id === id)?.record;
  if (!rec) throw new Error(`no template ${id} in the library`);
  if (verdict === "approved") {
    if (!isValidAtAll(validateTemplate(rec), rec.needs.aspect_ratios)) throw new Error(`${id} is not valid at every aspect ratio, so it cannot be approved`);
    if (!rec.source.licence_ok) throw new Error(`${id} has licence_ok false`);
  }
  const entry: ReviewEntry = { template_id: id, content_hash: rec.content_hash, reviewer, verdict, notes: notes.trim(), at: new Date().toISOString() };
  const f = REVIEW_FILE(root);
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, JSON.stringify(entry) + "\n");
  if (verdict === "approved") writeTemplate({ ...rec, status: "reviewed", evidence: [...rec.evidence.filter((e) => e.kind !== "review"), ...(rec.evidence.some((e) => e.kind === "validation") ? [] : [{ kind: "validation" as const, ref: `templates/_reports/validation.json#${id}` }]), { kind: "review", ref: `templates/_reviews/reviews.jsonl#${id}`, note: entry.notes }] }, root);
  void writeFileSync;
  return entry;
}
