import { describe, expect, it } from "vitest";
import { MemoryDataStore, type SkillRow } from "./db/store.js";
import { HashEmbedder } from "./embeddings.js";
import { HybridRetriever, skillVectorIndex } from "./hybrid.js";
import { ScopedRetriever } from "./scopes.js";
import { skillDoc } from "./skills.js";

const row = (id: string, category: string, text: string, over: Partial<SkillRow> = {}): SkillRow => ({ id, category, funnel_stage: "awareness", platform: ["tiktok"], grade: "A", status: "approved", title: id.replace(/-/g, " "), body: text, content_hash: id, source_id: "s", ...over });
const ROWS = [
  row("open-on-a-question", "hook", "Open the video on a question the viewer cannot ignore."),
  row("open-on-the-result", "hook", "Open on the finished result before explaining how it was made.", { platform: ["youtube"] }),
  row("end-on-one-action", "cta_end", "Close the video with one clear action held on screen.", { grade: "B" }),
  row("show-the-product-screen", "ui_demo", "Open the video on the real product screen and move the cursor to the key control."),
  row("draft-hook-idea", "hook", "Open the video with a draft idea.", { status: "draft" }),
  row("retired-hook", "hook", "Open the video with a retired idea.", { status: "retired" }),
];

async function build() {
  const store = new MemoryDataStore();
  await store.upsertSkillSource({ id: "s", repo: "r", url: "u", licence: "MIT", attribution: null, checked_on: "2026-11-04" });
  const emb = new HashEmbedder();
  for (const r of ROWS) {
    await store.upsertSkill(r);
    await store.upsertSkillEmbedding({ skill_id: r.id, model: emb.model, model_version: emb.version, vector: (await emb.embed([`${r.title}. ${r.body}`]))[0]! });
  }
  const docs = (await store.listSkills()).map(skillDoc).filter((d) => d !== null);
  return { docs, hybrid: await HybridRetriever.create(docs, emb, {}), emb, store };
}

describe("skills retrieval", () => {
  it("retired skills are not documents", async () => {
    const { docs } = await build();
    expect(docs.map((d) => d.id)).not.toContain("retired-hook");
  });
  it("a category query returns only that category", async () => {
    const { hybrid } = await build();
    const hits = await hybrid.retrieve({ text: "open the video", collection: "skills", k: 10, filter: { category: "hook" } });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.doc.metadata.skill_category === "hook")).toBe(true);
  });
  it("filters by platform and grade, and keeps drafts out unless allowed", async () => {
    const { hybrid } = await build();
    const ids = async (filter: object) => (await hybrid.retrieve({ text: "open the video", collection: "skills", k: 10, filter })).map((h) => h.doc.id);
    expect(await ids({ platform: "youtube" })).toEqual(["open-on-the-result"]);
    expect(await ids({ skill_grade: "b" })).toEqual(["end-on-one-action"]);
    expect(await ids({})).not.toContain("draft-hook-idea");
    expect(await ids({ include_draft: true })).toContain("draft-hook-idea");
  });
  it("both agents may read skills, through their scope", async () => {
    const { hybrid } = await build();
    for (const agent of ["director", "editor"] as const) {
      const scoped = new ScopedRetriever(hybrid, agent);
      const hits = await scoped.retrieve({ text: "open the video", collection: "skills", k: 5, filter: { category: "hook" } });
      expect(hits.length).toBeGreaterThan(0);
      expect(scoped.records[0]!.filter).not.toHaveProperty("out_of_scope");
    }
  });
  it("the store-backed vector index returns skills", async () => {
    const { store, emb } = await build();
    const hits = await skillVectorIndex(store, emb).search((await emb.embed(["open on a question the viewer cannot ignore"]))[0]!, 1);
    expect(hits[0]!.id).toBe("open-on-a-question");
  });
});
