import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRecipes } from "@digikon/recipes";
import { KeywordRetriever, brandFactDocs, eligible, loadKnowledge, recipeDocs, type Doc } from "./index.js";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const recipes = loadRecipes(root("recipes"));
const knowledge = loadKnowledge(root("knowledge"));
const docs: Doc[] = [...recipeDocs(recipes), ...knowledge];
const retriever = new KeywordRetriever(docs);
const evalSet: { query: string; collection: Doc["collection"]; expect: string[] }[] = JSON.parse(
  readFileSync(root("evals/retrieval.json"), "utf8"),
);

describe("keyword baseline retrieval", () => {
  it("meets recall@3 on the seed question set", async () => {
    let hit = 0;
    const misses: string[] = [];
    for (const q of evalSet) {
      const res = await retriever.retrieve({ text: q.query, collection: q.collection, k: 3, filter: { include_draft: true } });
      const ids = res.map((h) => h.doc.id);
      if (q.expect.some((e) => ids.includes(e))) hit++;
      else misses.push(`${q.query} -> ${ids.join(",") || "none"}`);
    }
    const recall = hit / evalSet.length;
    console.log(`keyword baseline recall@3 = ${recall.toFixed(2)} (${hit}/${evalSet.length}) misses: ${misses.join(" | ")}`);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });

  it("never returns draft recipes unless asked", async () => {
    const res = await retriever.retrieve({ text: "zoom", collection: "shot_recipes", k: 5 });
    expect(res).toEqual([]);
  });

  it("filters recipes by type, duration and aspect ratio", async () => {
    const res = await retriever.retrieve({
      text: "soft blend smooth", collection: "shot_recipes", k: 5,
      filter: { include_draft: true, recipe_type: "transition", duration_s: 0.8, aspect_ratio: "9:16" },
    });
    expect(res.every((h) => h.doc.metadata.recipe_type === "transition")).toBe(true);
    expect(res.map((h) => h.doc.id)).not.toContain("crossfade"); // needs a scene of at least 1s
  });

  it("returns only verified platform specs", () => {
    const unverified: Doc = { id: "x", collection: "platform_specs", title: "t", text: "t", source: "s", metadata: {} };
    expect(eligible(unverified)).toBe(false);
    expect(eligible({ ...unverified, metadata: { verified: true } })).toBe(true);
  });

  it("isolates brand facts by project", async () => {
    const r = new KeywordRetriever([...brandFactDocs([{ fact_id: "F1", text: "Contains no added sugar", source: "label" }], "projA")]);
    const q = { text: "sugar", collection: "brand_product_facts" as const, k: 3 };
    expect(await r.retrieve({ ...q, filter: { project_id: "projB" } })).toEqual([]);
    expect(await r.retrieve(q)).toEqual([]);
    expect((await r.retrieve({ ...q, filter: { project_id: "projA" } })).length).toBe(1);
  });

  it("filters knowledge by topic and excludes notes with no topics when a topic filter is set", async () => {
    const q = { text: "cut transition shot framing hook structure", collection: "directing_principles" as const, k: 10 };
    const craft = await retriever.retrieve({ ...q, filter: { topics: ["cinematography"] } });
    expect(craft.length).toBeGreaterThan(0);
    expect(craft.every((h) => h.doc.metadata.topics!.includes("cinematography"))).toBe(true);
    const untagged: Doc = { id: "u", collection: "directing_principles", title: "t", text: "cut", source: "s", metadata: {} };
    expect(eligible(untagged, { topics: ["editing"] })).toBe(false);
    expect(eligible(untagged, {})).toBe(true);
  });

  it("fetches a pinned note by id under the same rules", async () => {
    expect((await retriever.get("claims-discipline", "ad_playbooks"))?.id).toBe("claims-discipline");
    expect(await retriever.get("claims-discipline", "directing_principles")).toBeNull(); // wrong collection
    expect(await retriever.get("claims-discipline", "ad_playbooks", { topics: ["editing"] })).toBeNull(); // filtered out
    expect(await retriever.get("no-such-note", "ad_playbooks")).toBeNull();
    expect(await retriever.get("slow-push-in", "shot_recipes")).toBeNull(); // draft recipe, not eligible without include_draft
  });

  it("caps returned tokens", async () => {
    const res = await retriever.retrieve({ text: "ad hook call to action claims", collection: "ad_playbooks", k: 5, max_tokens: 60 });
    expect(res.length).toBeLessThanOrEqual(2);
  });
});
