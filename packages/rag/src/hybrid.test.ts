import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TemplateRecord } from "@digikon/contracts";
import { MemoryDataStore } from "./db/store.js";
import { HashEmbedder, TransformersEmbedder, chooseEmbedder, dot, findLocalSentenceModel } from "./embeddings.js";
import { HybridRetriever, MemoryVectorIndex, storeVectorIndex } from "./hybrid.js";
import { KeywordRetriever } from "./keyword.js";
import { mmr, noRepeat } from "./rerank.js";
import { dedupeReport, ingestTemplates, readTemplateFiles, templateDoc } from "./templates.js";
import type { Doc } from "./types.js";

const doc = (id: string, title: string, text: string, collection: Doc["collection"] = "ad_playbooks", metadata: Doc["metadata"] = {}): Doc => ({ id, collection, title, text, source: "test", metadata });
const DOCS = [
  doc("hook", "Hook in the first seconds", "Open on the most striking view of the product or the result it creates, not on a logo or a slow title."),
  doc("cta", "One clear call to action", "End with one action in plain words, shown long enough to read, ideally with the brand mark."),
  doc("claims", "Only claim what is approved", "Every factual statement about the product must be approved before it is shown."),
  doc("draft", "Draft note about hooks", "Open with a hook.", "ad_playbooks", { status: "draft" }),
];
const tpl = (id: string, title: string, description: string, over: Partial<TemplateRecord> = {}): TemplateRecord => TemplateRecord.parse({
  format: "digikon.template", format_version: 1, template_id: id, version: "1.0.0", category: "titles", title, description, serves_needs: ["emphasise_claim"], energy: "low", aspect_ratios: ["16:9"], renderers: ["remotion"],
  scene_graph: { format: "digikon.scene-graph", format_version: 1, canvas: { width: 1280, height: 720, fps: 30 }, duration_s: 3, nodes: [{ node_id: "t", kind: "text" }], animations: [] },
  source: { origin: "original", license: "original" }, ...over,
});

describe("HashEmbedder", () => {
  const e = new HashEmbedder();
  it("is deterministic, unit length, and puts similar wording closer than different wording", async () => {
    const [a, b, c] = await e.embed(["slow zoom toward the product", "a slow zooming push toward the product", "dissolve between two calm scenes"]);
    expect((await e.embed(["slow zoom toward the product"]))[0]).toEqual(a);
    expect(dot(a!, a!)).toBeCloseTo(1, 9);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
  });
  it("an empty text is the zero vector, not NaN", async () => { expect((await e.embed(["the a of"]))[0]!.every((x) => x === 0)).toBe(true); });
});

describe("local sentence models are used only if they are on disk, and nothing is downloaded", () => {
  it("finds none in an empty folder and falls back to the hash embedder, saying a model must be approved", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    try {
      expect(findLocalSentenceModel(dir)).toBeNull();
      const c = chooseEmbedder(dir);
      expect(c.real).toBe(false);
      expect(c.note).toContain("must be downloaded and approved");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("finds a known model once its config and an onnx file exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    try {
      mkdirSync(join(dir, "Xenova", "all-MiniLM-L6-v2", "onnx"), { recursive: true });
      writeFileSync(join(dir, "Xenova", "all-MiniLM-L6-v2", "config.json"), "{}");
      expect(findLocalSentenceModel(dir)).toBeNull();
      writeFileSync(join(dir, "Xenova", "all-MiniLM-L6-v2", "onnx", "model.onnx"), "x");
      expect(findLocalSentenceModel(dir)).toBe("Xenova/all-MiniLM-L6-v2");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("the transformers embedder refuses, with instructions, when its folder is missing", async () => {
    await expect(new TransformersEmbedder("Xenova/nonexistent", join(tmpdir(), "no-such-models")).embed(["x"])).rejects.toThrow(/never downloads/);
  });
});

describe("HybridRetriever", () => {
  it("fuses the two rankings: a document both rankers like beats one only one likes", async () => {
    const h = await HybridRetriever.create(DOCS, new HashEmbedder());
    const hits = await h.retrieve({ text: "call to action at the end", collection: "ad_playbooks", k: 3 });
    expect(hits[0]!.doc.id).toBe("cta");
  });
  it("never returns what the filter rules out: drafts, other projects' facts, unverified specs", async () => {
    const h = await HybridRetriever.create([...DOCS, doc("fact", "Brand fact", "The product hook is red.", "brand_product_facts", { project_id: "p1" })], new HashEmbedder());
    expect((await h.retrieve({ text: "open with a hook", collection: "ad_playbooks", k: 5 })).map((x) => x.doc.id)).not.toContain("draft");
    expect(await h.retrieve({ text: "the product hook", collection: "brand_product_facts", k: 5, filter: { project_id: "p2" } })).toEqual([]);
    expect((await h.retrieve({ text: "the product hook", collection: "brand_product_facts", k: 5, filter: { project_id: "p1" } })).map((x) => x.doc.id)).toEqual(["fact"]);
  });
  it("a query that matches nothing returns nothing", async () => {
    const h = await HybridRetriever.create(DOCS, new HashEmbedder(), { min_similarity: 0.3 });
    expect(await h.retrieve({ text: "weather forecast lisbon tomorrow", collection: "ad_playbooks", k: 3 })).toEqual([]);
  });
  it("respects k and the token budget, and get() applies the same eligibility", async () => {
    const h = await HybridRetriever.create(DOCS, new HashEmbedder());
    expect((await h.retrieve({ text: "product", collection: "ad_playbooks", k: 1 })).length).toBeLessThanOrEqual(1);
    expect(await h.get("draft", "ad_playbooks")).toBeNull();
    expect((await h.get("hook", "ad_playbooks"))!.id).toBe("hook");
  });
  it("is the same answer as the keyword ranker when the vector side contributes nothing", async () => {
    const h = await HybridRetriever.create(DOCS, new HashEmbedder(), { weight_vector: 0 });
    const k = new KeywordRetriever(DOCS);
    const q = { text: "claim approved statement", collection: "ad_playbooks" as const, k: 3 };
    expect((await h.retrieve(q)).map((x) => x.doc.id)).toEqual((await k.retrieve(q)).map((x) => x.doc.id));
  });
});

describe("variety: no-repeat and MMR", () => {
  const hits = DOCS.slice(0, 3).map((d, i) => ({ doc: d, score: 1 - i * 0.1 }));
  it("a template this film already used is pushed down, and heavy use elsewhere pushes down a little", () => {
    const out = noRepeat(hits, { total: new Map([["hook", 1], ["cta", 20]]), in_film: new Map([["hook", 1]]) });
    expect(out.map((h) => h.doc.id)).toEqual(["claims", "cta", "hook"]);
    expect(out.find((h) => h.doc.id === "cta")!.score).toBeCloseTo(0.9 * 0.8, 9);
    expect(out.find((h) => h.doc.id === "hook")!.score).toBeCloseTo(1 * 0.35 * 0.98, 9);
  });
  it("MMR with lambda 1 keeps relevance order and with a low lambda prefers the unlike one", () => {
    const v = new Map<string, number[]>([["hook", [1, 0]], ["cta", [0.99, 0.14]], ["claims", [0, 1]]]);
    expect(mmr(hits, v, 3, 1).map((h) => h.doc.id)).toEqual(["hook", "cta", "claims"]);
    expect(mmr(hits, v, 3, 0.4).map((h) => h.doc.id)).toEqual(["hook", "claims", "cta"]);
  });
  it("the library's use history drives it: after logging a use in a film, that template drops in that film only", async () => {
    const store = new MemoryDataStore();
    const embedder = new HashEmbedder();
    const recs = [tpl("push-a", "Slow push in", "A slow gradual zoom toward the subject"), tpl("push-b", "Slow push in alt", "A slow gradual zoom toward the subject, alternate")];
    await ingestTemplates(store, embedder, recs);
    await store.logTemplateUsage({ template_id: "push-a", film_id: "f1", scene_id: "S1", outcome: {} });
    const docs = (await store.listTemplates()).map(templateDoc);
    const h = await HybridRetriever.create(docs, embedder, { usage: { usage: (f) => store.usage(f) } });
    const q = { text: "slow gradual zoom toward the subject", collection: "shot_recipes" as const, k: 2 };
    const score = async (film: string, id: string) => (await h.retrieve({ ...q, filter: { film_id: film, include_draft: true } })).find((x) => x.doc.id === id)!.score;
    expect((await h.retrieve({ ...q, filter: { film_id: "f1", include_draft: true } }))[0]!.doc.id).toBe("push-b");
    expect(await score("f2", "push-a")).toBeGreaterThan((await score("f1", "push-a")) * 2); // used in f1, so pushed down there; in f2 only the small overuse share applies
  });
});

describe("template ingest and dedupe", () => {
  const recs = [
    tpl("fade-a", "Fade up title", "Title text fades in while rising slightly", { family: "fade" }),
    tpl("fade-b", "Fade up title copy", "Title text fades in while rising slightly", { family: "fade" }),
    tpl("wipe", "Graphic wipe", "Energetic wipe across the frame to the next scene", { energy: "high" }),
  ];
  it("stores and embeds, then a second ingest changes nothing, and an edit updates only that template", async () => {
    const store = new MemoryDataStore(), e = new HashEmbedder();
    const r1 = await ingestTemplates(store, e, recs);
    expect(r1.added.sort()).toEqual(["fade-a", "fade-b", "wipe"]);
    expect((await ingestTemplates(store, e, recs)).unchanged.length).toBe(3);
    const r3 = await ingestTemplates(store, e, [recs[0]!, { ...recs[1]!, title: "Fade up title v2" }, recs[2]!]);
    expect(r3.updated).toEqual(["fade-b"]);
  });
  it("a duplicate id in one ingest is rejected", async () => {
    const r = await ingestTemplates(new MemoryDataStore(), new HashEmbedder(), [recs[0]!, recs[0]!]);
    expect(r.rejected[0]!.problems[0]).toContain("duplicate");
  });
  it("the dedupe report finds the near-identical pair and not the unlike one, and reports every nearest neighbour", async () => {
    const store = new MemoryDataStore(), e = new HashEmbedder();
    await ingestTemplates(store, e, recs);
    const d = await dedupeReport(store, e, 0.85);
    expect(d.pairs.map((p) => [p.a, p.b])).toEqual([["fade-a", "fade-b"]]);
    expect(d.pairs[0]!.same_family).toBe(true);
    expect(d.nearest.find((n) => n.id === "wipe")!.neighbour).not.toBeNull();
  });
  it("files: valid ones become records, invalid ones are reported with the reason and never stored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tpl-"));
    try {
      writeFileSync(join(dir, "ok.json"), JSON.stringify(recs[0]));
      writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...recs[0], template_id: "BAD ID" }));
      writeFileSync(join(dir, "junk.json"), "{nope");
      const files = readTemplateFiles(dir);
      expect(files.filter((f) => f.record).map((f) => f.file)).toEqual(["ok.json"]);
      expect(files.find((f) => f.file === "bad.json")!.problems.join(" ")).toContain("template_id");
      expect(files.find((f) => f.file === "junk.json")!.problems[0]).toContain("not readable");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("the store-backed vector index returns the nearest template for a query", async () => {
    const store = new MemoryDataStore(), e = new HashEmbedder();
    await ingestTemplates(store, e, recs);
    const idx = storeVectorIndex(store, e);
    const [q] = await e.embed(["energetic wipe to the next scene"]);
    expect((await idx.search(q!, 1))[0]!.id).toBe("wipe");
    expect(new MemoryVectorIndex().vectors.size).toBe(0);
  });
});
