import { dot } from "./embeddings.js";
import type { Hit } from "./types.js";

/** How often each template has been used, from the template_usage table: overall, and in one film. */
export interface UsageStats { total: Map<string, number>; in_film: Map<string, number> }
export interface UsageSource { usage(filmId?: string): Promise<UsageStats> }

export interface NoRepeatOptions {
  /** A template already used in this film keeps this share of its score (0.35 means it is pushed well down, not removed). */
  same_film_keeps?: number;
  /** Each earlier use anywhere takes this share off, up to `max_overuse`. */
  overuse_each?: number;
  max_overuse?: number;
}

/** Pushes down what this film has already used and, more gently, what is used everywhere, so a library of ten does not give the same answer ten times. */
export function noRepeat(hits: readonly Hit[], usage: UsageStats, o: NoRepeatOptions = {}): Hit[] {
  const keeps = o.same_film_keeps ?? 0.35, each = o.overuse_each ?? 0.02, max = o.max_overuse ?? 0.2;
  return hits
    .map((h) => {
      const inFilm = usage.in_film.get(h.doc.id) ?? 0, total = usage.total.get(h.doc.id) ?? 0;
      let s = h.score;
      if (inFilm > 0) s *= keeps;
      s *= 1 - Math.min(max, each * total);
      return { doc: h.doc, score: s };
    })
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
}

/**
 * Maximal marginal relevance: picks the next hit that is relevant and unlike what is already picked. `lambda` 1 is plain relevance order; lower values
 * favour variety. Scores are scaled to 0..1 first so they can be mixed with cosine similarity.
 */
export function mmr(hits: readonly Hit[], vectors: ReadonlyMap<string, readonly number[]>, k: number, lambda = 0.7): Hit[] {
  if (hits.length === 0) return [];
  const top = Math.max(...hits.map((h) => h.score)) || 1;
  const pool = hits.map((h) => ({ h, rel: h.score / top })), out: Hit[] = [];
  while (out.length < k && pool.length) {
    let best = -1, bestV = -Infinity;
    pool.forEach((p, i) => {
      const v = vectors.get(p.h.doc.id);
      const sim = out.length === 0 || !v ? 0 : Math.max(...out.map((o) => { const ov = vectors.get(o.doc.id); return ov ? dot(v, ov) : 0; }));
      const val = lambda * p.rel - (1 - lambda) * sim;
      if (val > bestV + 1e-12 || (Math.abs(val - bestV) <= 1e-12 && best >= 0 && p.h.doc.id < pool[best]!.h.doc.id)) { best = i; bestV = val; }
    });
    out.push(pool.splice(best, 1)[0]!.h);
  }
  return out;
}
