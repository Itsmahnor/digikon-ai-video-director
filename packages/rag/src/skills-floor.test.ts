import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HashEmbedder } from "./embeddings.js";
import { HybridRetriever } from "./hybrid.js";
import { KeywordRetriever } from "./keyword.js";
import { loadKnowledge } from "./docs.js";
import { loadSkillDocs } from "./skills.js";
import { SKILLS_HYBRID_OPTIONS, SKILLS_KEYWORD_FLOOR } from "./skills-defaults.js";
import type { Doc } from "./types.js";

const root = resolve(import.meta.dirname, "..", "..", "..");
const skillDocs = loadSkillDocs(resolve(root, "examples", "skills"));
const filter = (category: string) => ({ category, include_draft: true, skill_scope: "director" as const }); // same filter as the benchmark: a Director query

/**
 * Off-topic queries from both benchmarks (4 + 12). The floor is a keyword-coverage rule, so it is sensitive to which words the skills use: a word that really occurs in a
 * skill ("recipe", "options", "employee") can let a query through. The tests therefore assert the behaviour (most are answered with nothing, far more than without the floor), plus two
 * cases that share no distinctive word with any skill, not a fixed list that a skill edit would silently break.
 */
const OFF: [string, string][] = [
  ["saas", "quantum chromodynamics lecture notes"], ["saas", "recipe for sourdough bread starter"], ["saas", "what is the capital of australia"], ["saas", "fix a leaking kitchen tap"],
  ["ecommerce", "how to repair a car gearbox"], ["ecommerce", "guitar chords for a beginner song"], ["ecommerce", "symptoms of seasonal flu"], ["ecommerce", "football match score yesterday"],
  ["general-promo", "tax treatment of employee stock options"], ["general-promo", "how to train for a half marathon"], ["general-promo", "best way to learn spanish quickly"], ["general-promo", "visa requirements for travel to japan"],
];
const emptyCount = async (r: { retrieve(q: { text: string; collection: "skills"; k: number; filter: object }): Promise<unknown[]> }) => {
  let n = 0;
  for (const [cat, q] of OFF) if ((await r.retrieve({ text: q, collection: "skills", k: 5, filter: filter(cat) })).length === 0) n++;
  return n;
};

describe("off-topic floor for the skills collection", () => {
  const keyword = new KeywordRetriever(skillDocs, 1.5, 0.75, SKILLS_KEYWORD_FLOOR);
  it("BM25 with the floor answers most off-topic queries with nothing; without it almost none", async () => {
    const withFloor = await emptyCount(keyword), without = await emptyCount(new KeywordRetriever(skillDocs));
    expect(withFloor).toBeGreaterThanOrEqual(Math.ceil(OFF.length * 0.65));
    expect(without).toBeLessThanOrEqual(Math.floor(OFF.length * 0.3));
    for (const q of ["quantum chromodynamics lecture notes", "how to repair a car gearbox"]) expect(await keyword.retrieve({ text: q, collection: "skills", k: 5, filter: filter("saas") }), q).toEqual([]);
  });
  it("the default hybrid retriever (hybrid ranking, nothing returned without a keyword hit) answers the same off-topic queries with nothing", async () => {
    const hybrid = await HybridRetriever.create(skillDocs, new HashEmbedder(), SKILLS_HYBRID_OPTIONS);
    expect(await emptyCount(hybrid)).toBeGreaterThanOrEqual(Math.ceil(OFF.length * 0.65));
    for (const q of ["quantum chromodynamics lecture notes", "how to repair a car gearbox"]) expect(await hybrid.retrieve({ text: q, collection: "skills", k: 5, filter: filter("ecommerce") }), q).toEqual([]);
  });  it("a query that shares a real word with a skill still returns that skill: a keyword floor cannot tell it is off-topic (documented gap)", async () => {
    const hits = await keyword.retrieve({ text: "recipe for sourdough bread starter", collection: "skills", k: 5, filter: filter("saas") });
    for (const h of hits) expect(h.doc.text.toLowerCase()).toMatch(/recipe|start/); // the only reason they match (the query's "starter" stems to "start")
  });
  it("on-topic queries are unaffected, and other collections are never floored", async () => {
    const hybrid = await HybridRetriever.create(skillDocs, new HashEmbedder(), SKILLS_HYBRID_OPTIONS);
    for (const r of [keyword, hybrid]) {
      const ids = (await r.retrieve({ text: "show a customer how the product works step by step on the real interface", collection: "skills", k: 5, filter: filter("saas") })).map((h) => h.doc.id);
      expect(ids.slice(0, 3)).toContain("saas-product-demo");
    }
    const knowledge: Doc[] = loadKnowledge(resolve(root, "knowledge"));
    const q = { text: "quantum chromodynamics lecture notes camera", collection: "directing_principles" as const, k: 5, filter: {} };
    const a = await new KeywordRetriever([...knowledge, ...skillDocs]).retrieve(q);
    const b = await new KeywordRetriever([...knowledge, ...skillDocs], 1.5, 0.75, SKILLS_KEYWORD_FLOOR).retrieve(q);
    expect(b.map((h) => h.doc.id)).toEqual(a.map((h) => h.doc.id));
  });
});
