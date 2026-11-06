import { ScopedRetriever, type Hit, type Retriever } from "@digikon/rag";

/**
 * Per-query skill selection. A brief says several different things (what the film is for, who it is for, how it opens, what each beat does), and one short query
 * can only match one of them. So the brief is expanded into several focused queries, each is run through the scoped retriever, the ranked lists are fused
 * (a skill that matches several facets rises), variety is enforced, and the policy skills a step must always see are pinned in front whatever they scored.
 * No model is called: the expansion is plain text handling, so it is cheap, repeatable and testable.
 */

export type SkillStep = "treatment" | "storyboard" | "edit_plan";

/** Skills a step must always have in front of it, whatever the ranking says. Shown first. Reviewed by the owner; an id that does not exist is skipped, not an error. */
export const PINNED_SKILLS: Record<SkillStep, readonly string[]> = {
  treatment: ["proof-and-claims-safety", "hook-must-pay-off"],
  storyboard: ["storyboard-shot-table", "proof-and-claims-safety"],
  edit_plan: [],
};

export interface SkillQueryInput {
  objective: string;
  audience: string;
  platform: string;
  brief: string;
  video_category?: string | null;
  /** The treatment's opening line and beat purposes, when the step has them. */
  hook?: string;
  beats?: readonly { purpose: string }[];
  /** Scene purposes (edit plan). */
  scene_purposes?: readonly string[];
}

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n).trim();
const MAX_QUERIES = 8;

/** The brief as up to three sentences, longest first, so a long brief contributes its substance and not just its first 160 characters. */
function briefParts(brief: string): string[] {
  const sentences = brief.split(/(?<=[.!?])\s+|\n+/).map((s) => clip(s, 220)).filter((s) => s.length >= 20);
  return [...new Set(sentences)].sort((a, b) => b.length - a.length).slice(0, 3);
}

export function buildSkillQueries(step: SkillStep, p: SkillQueryInput): string[] {
  const out: string[] = [];
  const add = (q: string) => { const c = clip(q, 260); if (c.length >= 8 && !out.includes(c)) out.push(c); };
  add(`${p.objective} ${p.platform} video${p.video_category && p.video_category !== "all" ? ` for ${p.video_category}` : ""}`);
  add(`video for ${p.audience}: ${p.objective}`);
  if (step === "treatment") {
    for (const part of briefParts(p.brief)) add(part);
    add(`opening hook for ${p.platform}: ${clip(p.brief, 120)}`);
    add(`call to action and offer for ${p.objective}`);
    add(`story structure and proof for ${p.audience}`);
  } else if (step === "storyboard") {
    if (p.hook) add(`opening hook: ${p.hook}`);
    for (const b of (p.beats ?? []).slice(0, 4)) add(`scene beat: ${b.purpose}`);
    add(`scene beats pacing on-screen text for ${p.platform}`);
    add(`storyboard shot table ${p.objective}`);
  } else {
    for (const s of [...new Set(p.scene_purposes ?? [])].slice(0, 4)) add(`editing and motion for a scene that must ${s}`);
    add(`pacing transitions and cuts for a ${p.platform} ${p.objective} film`);
    add("on-screen text timing and legibility");
  }
  return out.slice(0, MAX_QUERIES);
}

export interface SkillSelection { hits: Hit[]; queries: { query: string; ids: string[] }[]; pinned: string[] }

export interface SelectOptions {
  /** Skills returned besides pins. */
  k?: number;
  /** Per query. */
  per_query?: number;
  /** At most this many skills of one topic, for variety. */
  max_per_topic?: number;
  /** Skills ranked beyond this many get a short excerpt instead of the full text. */
  full_text_for?: number;
  excerpt_chars?: number;
  category: string;
  include_draft: boolean;
  pins?: readonly string[];
}

const topicOf = (h: Hit) => String(h.doc.metadata.skill_topic ?? "");

/** Runs the queries, fuses them, applies variety and pins. `scoped` records every query for replay. */
export async function selectSkills(scoped: ScopedRetriever, queries: readonly string[], o: SelectOptions): Promise<SkillSelection> {
  const k = o.k ?? 5, per = o.per_query ?? 5, maxTopic = o.max_per_topic ?? 2, fullFor = o.full_text_for ?? 3, excerpt = o.excerpt_chars ?? 260;
  const filter = { category: o.category, include_draft: o.include_draft };
  const score = new Map<string, number>(), doc = new Map<string, Hit>(), log: SkillSelection["queries"] = [];
  for (const query of queries) {
    const hits = await scoped.retrieve({ text: query, collection: "skills", k: per, filter });
    log.push({ query, ids: hits.map((h) => h.doc.id) });
    hits.forEach((h, i) => { score.set(h.doc.id, (score.get(h.doc.id) ?? 0) + 1 / (60 + i + 1)); doc.set(h.doc.id, h); });
  }
  const pins: Hit[] = [];
  for (const id of o.pins ?? []) {
    const d = doc.get(id)?.doc ?? (await scoped.get(id, "skills", filter));
    if (d) pins.push({ doc: d, score: Number.POSITIVE_INFINITY });
  }
  const pinned = new Set(pins.map((p) => p.doc.id));
  const ranked = [...score].filter(([id]) => !pinned.has(id)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, s]) => ({ doc: doc.get(id)!.doc, score: s }));
  const perTopic = new Map<string, number>(), chosen: Hit[] = [];
  for (const h of ranked) {
    const t = topicOf(h), n = perTopic.get(t) ?? 0;
    if (t && n >= maxTopic) continue;
    perTopic.set(t, n + 1);
    chosen.push(h);
    if (chosen.length >= k) break;
  }
  const all = [...pins, ...chosen].map((h, i) => (i < fullFor + pins.length ? h : { ...h, doc: { ...h.doc, text: h.doc.text.length > excerpt ? `${h.doc.text.slice(0, excerpt).trim()}…` : h.doc.text } }));
  return { hits: all, queries: log, pinned: [...pinned] };
}

export type { Retriever };
