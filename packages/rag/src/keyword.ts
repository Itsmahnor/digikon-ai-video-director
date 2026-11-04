import type { Doc, Hit, RetrieveFilter, RetrieveQuery, Retriever } from "./types.js";

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "it", "this", "that", "at", "by", "as", "be", "from"]);

/** Lowercases, splits on non-alphanumerics and strips common English suffixes so "zooming" matches "zoom". */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => {
      if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
      if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
      if (t.length > 4 && t.endsWith("es")) return t.slice(0, -2);
      if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
      return t;
    });
}

/** Eligibility rules from the proposal. Applied before ranking so ineligible documents can never be returned. */
export function eligible(d: Doc, f: RetrieveFilter = {}): boolean {
  const m = d.metadata;
  if (f.topics?.length && !(m.topics ?? []).some((x) => f.topics!.includes(x))) return false;
  if (d.collection !== "shot_recipes" && m.status === "draft" && !f.include_draft) return false;
  if (f.min_grade && (!m.grade || m.grade > f.min_grade)) return false;
  switch (d.collection) {
    case "skills":
      if (f.category && m.skill_category !== f.category && m.skill_category !== "all") return false;
      if (f.topic && m.skill_topic !== f.topic) return false;
      if (f.skill_scope && m.skill_scope !== "both" && m.skill_scope !== f.skill_scope) return false;
      if (f.platform && !(m.skill_platforms ?? []).includes(f.platform)) return false;
      if (f.skill_grade && (m.skill_grade ?? "").toLowerCase() !== f.skill_grade.toLowerCase()) return false;
      return true;
    case "platform_specs":
      return m.verified === true;
    case "brand_product_facts":
      return !!f.project_id && m.project_id === f.project_id;
    case "shot_recipes": {
      if (m.recipe_status !== "reviewed" && !f.include_draft) return false;
      if (f.implemented_only && m.recipe_implemented !== true) return false;
      if (f.recipe_type && m.recipe_type !== f.recipe_type) return false;
      if (f.aspect_ratio && m.recipe_aspect_ratios && !m.recipe_aspect_ratios.includes(f.aspect_ratio)) return false;
      if (f.energy && m.recipe_energy !== f.energy) return false;
      if (f.duration_s !== undefined) {
        if (m.recipe_min_duration_s !== undefined && f.duration_s < m.recipe_min_duration_s) return false;
        if (m.recipe_max_duration_s !== undefined && f.duration_s > m.recipe_max_duration_s) return false;
      }
      if (f.media && m.recipe_media_types) {
        const ok = f.media.length === 0 ? m.recipe_media_types.includes("none") : f.media.some((x) => m.recipe_media_types!.includes(x));
        if (!ok) return false;
      }
      return true;
    }
    default:
      return true;
  }
}

/**
 * A floor that lets a query match nothing. For the listed collections a document is returned only if the query terms it contains carry at least `min_idf_coverage` of the
 * query's total weight (each term weighted by its rarity in the corpus; a term the corpus has never seen counts in full and can never be matched). A query that shares only
 * common words with a document ("how", "to") fails; one that shares its distinctive words passes. Collections not listed are untouched.
 */
export interface LexicalFloor { min_idf_coverage: number; collections: readonly Doc["collection"][] }

const approxTokens = (s: string) => Math.ceil(s.length / 4);
const IMPLEMENTED_BOOST = 1.15;

/** BM25 over title and text. This is the baseline the Qdrant retriever must beat to be adopted. */
export class KeywordRetriever implements Retriever {
  private readonly tf = new Map<string, Map<string, number>>();
  private readonly len = new Map<string, number>();
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(private readonly docs: Doc[], private readonly k1 = 1.5, private readonly b = 0.75, private readonly floor?: LexicalFloor) {
    let total = 0;
    for (const d of docs) {
      const toks = tokenize(`${d.title} ${d.title} ${d.text}`);
      const counts = new Map<string, number>();
      for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
      this.tf.set(d.id, counts);
      this.len.set(d.id, toks.length);
      total += toks.length;
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = docs.length ? total / docs.length : 0;
  }

  async get(id: string, collection: Doc['collection'], filter: RetrieveFilter = {}): Promise<Doc | null> {
    const d = this.docs.find((x) => x.id === id && x.collection === collection);
    return d && eligible(d, filter) ? d : null;
  }

  async retrieve(q: RetrieveQuery): Promise<Hit[]> {
    const terms = [...new Set(tokenize(q.text))];
    const n = this.docs.length;
    const scored: Hit[] = [];
    const idfOf = (t: string) => Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
    const floor = this.floor && this.floor.collections.includes(q.collection) ? this.floor.min_idf_coverage : 0;
    const totalIdf = terms.reduce((s, t) => s + idfOf(t), 0);
    for (const doc of this.docs) {
      if (doc.collection !== q.collection || !eligible(doc, q.filter)) continue;
      const counts = this.tf.get(doc.id)!;
      const dl = this.len.get(doc.id)!;
      let score = 0, matchedIdf = 0;
      for (const t of terms) {
        const f = counts.get(t);
        if (!f) continue;
        matchedIdf += idfOf(t);
        const idf = Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * dl) / (this.avgLen || 1))));
      }
      // A recipe that is known to have a working template ranks a little above an equally good match that has none, so a capability that was
      // learned in one project is the one picked in the next. A recipe whose state is unknown is not penalised.
      // Once validation is known, the boost means "proven by a real render"; otherwise it means "an implementation is registered".
      const boosted = doc.metadata.recipe_validated ?? doc.metadata.recipe_implemented;
      if (boosted === true) score *= IMPLEMENTED_BOOST;
      else if (boosted === false) score *= 1 / IMPLEMENTED_BOOST;
      if (floor > 0 && (totalIdf === 0 || matchedIdf / totalIdf < floor)) continue;
      if (score > 0) scored.push({ doc, score });
    }
    scored.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));

    const out: Hit[] = [];
    let used = 0;
    for (const h of scored.slice(0, q.k)) {
      const cost = approxTokens(h.doc.text) + approxTokens(h.doc.title);
      if (q.max_tokens !== undefined && used + cost > q.max_tokens && out.length > 0) break;
      used += cost;
      out.push(h);
    }
    return out;
  }
}
