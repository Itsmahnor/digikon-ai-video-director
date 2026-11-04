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
const filter = (category: string) => ({ category, include_draft: true });

/** The four off-topic queries of the first benchmark: a retriever with the skills floor must answer nothing when no distinctive word is shared. */
const OFF_TOPIC: [string, string][] = [["saas", "quantum chromodynamics lecture notes"], ["ecommerce", "how to repair a car gearbox"], ["general-promo", "tax treatment of employee stock options"]];

describe("off-topic floor for the skills collection", () => {
  const keyword = new KeywordRetriever(skillDocs, 1.5, 0.75, SKILLS_KEYWORD_FLOOR);
  it("BM25 with the floor returns nothing for off-topic queries; without it, it returns noise", async () => {
    const plain = new KeywordRetriever(skillDocs);
    for (const [cat, q] of OFF_TOPIC) {
      expect(await keyword.retrieve({ text: q, collection: "skills", k: 5, filter: filter(cat) }), q).toEqual([]);
    }
    expect((await plain.retrieve({ text: "how to repair a car gearbox", collection: "skills", k: 5, filter: filter("ecommerce") })).length).toBeGreaterThan(0);
  });
  it("the default hybrid retriever (hybrid ranking, nothing returned without a keyword hit) also returns nothing", async () => {
    const hybrid = await HybridRetriever.create(skillDocs, new HashEmbedder(), SKILLS_HYBRID_OPTIONS);
    for (const [cat, q] of OFF_TOPIC) expect(await hybrid.retrieve({ text: q, collection: "skills", k: 5, filter: filter(cat) }), q).toEqual([]);
  });
  it("a query that shares a real word with a skill still returns that skill: a keyword floor cannot tell it is off-topic (documented gap)", async () => {
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
