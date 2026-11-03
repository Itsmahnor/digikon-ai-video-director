import type { LibraryTemplate } from "@digikon/contracts";
import { jaccard, structuralFeatures } from "./library.js";

/**
 * Distinctness. A template counts toward its category only if it is not a near-duplicate of one already counted. Two measures are used together:
 *
 *  - structural similarity: Jaccard overlap of the design-decision sets in library.ts (layout cells, alignment, animated properties, stagger unit,
 *    motion personality, type pairing, palette roles, backdrop). Colours are not in it.
 *  - look similarity: cosine of the CLIP embeddings of the rendered 16:9 preview frames, which does see colour, density and weight.
 *
 * A candidate is a duplicate when BOTH are at or above their thresholds (same skeleton and the same look), or when the look alone is at or above the
 * hard threshold (it simply looks the same). Candidates are considered bases first, then variants in id order, so a base is never removed because of
 * one of its own variants. The thresholds are exported, versioned and reported with every run.
 */
export const DEDUPE = { version: 1, struct_dup: 0.78, look_dup: 0.93, look_hard: 0.975 } as const;
export type DedupeThresholds = { struct_dup: number; look_dup: number; look_hard: number };

export interface Candidate { t: LibraryTemplate; feats: Set<string>; look: number[] }
export const candidateOf = (t: LibraryTemplate, look: number[]): Candidate => ({ t, feats: structuralFeatures(t), look });

const dot = (a: readonly number[], b: readonly number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };
export interface Pair { struct: number; look: number }
export const compare = (a: Candidate, b: Candidate): Pair => ({ struct: jaccard(a.feats, b.feats), look: dot(a.look, b.look) });
export const isDuplicate = (p: Pair, th: DedupeThresholds = DEDUPE): boolean => p.look >= th.look_hard || (p.struct >= th.struct_dup && p.look >= th.look_dup);

export interface Decision { id: string; category: string; accepted: boolean; nearest: string | null; nearest_struct: number; nearest_look: number; duplicate_of: string | null }

/** Greedy selection within each category. Returns the decision for every candidate in the order it was considered. */
export function dedupe(cands: readonly Candidate[], th: DedupeThresholds = DEDUPE): Decision[] {
  const order = [...cands].sort((a, b) => Number(!!a.t.variant_of) - Number(!!b.t.variant_of) || a.t.category.localeCompare(b.t.category) || a.t.template_id.localeCompare(b.t.template_id));
  const kept = new Map<string, Candidate[]>();
  const out: Decision[] = [];
  for (const c of order) {
    const pool = kept.get(c.t.category) ?? [];
    let nearest: Candidate | null = null, np: Pair = { struct: 0, look: -1 }, dup: string | null = null;
    for (const k of pool) {
      const p = compare(c, k);
      if (p.look > np.look) { nearest = k; np = p; }
      if (dup === null && isDuplicate(p, th)) dup = k.t.template_id;
    }
    const accepted = dup === null;
    if (accepted) { pool.push(c); kept.set(c.t.category, pool); }
    out.push({ id: c.t.template_id, category: c.t.category, accepted, nearest: nearest?.t.template_id ?? null, nearest_struct: round(np.struct), nearest_look: round(Math.max(np.look, 0)), duplicate_of: dup });
  }
  return out;
}
const round = (v: number) => Math.round(v * 1e4) / 1e4;
