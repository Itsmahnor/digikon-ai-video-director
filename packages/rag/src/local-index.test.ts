import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CachedEmbedder } from "./embedding-cache.js";
import { HashEmbedder } from "./embeddings.js";
import { createLocalHybridRetriever } from "./local-retriever.js";
import { describeRetrieval, isSemantic, type RetrievalStatus } from "./status.js";
import type { Doc } from "./types.js";

describe("in-process vector index", () => {
  it("embeds once, serves repeats from disk, and re-embeds only changed text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emb-"));
    try {
      const file = join(dir, "c.json");
      const a = new CachedEmbedder(new HashEmbedder(), file);
      await a.embed(["one", "two"]); a.save();
      const b = new CachedEmbedder(new HashEmbedder(), file);
      const v = await b.embed(["one", "two", "three"]);
      expect(b.hits).toBe(2); expect(b.misses).toBe(1); expect(v.length).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("searches with the hybrid retriever and no database", async () => {
    const docs: Doc[] = [
      { id: "hooks", collection: "skills", title: "Hook patterns", text: "open with a hook in the first seconds", source: "s", metadata: { status: "reviewed", topics: ["hook"] } },
      { id: "audio", collection: "skills", title: "Audio levels", text: "keep music under the voice", source: "s", metadata: { status: "reviewed", topics: ["audio"] } },
    ];
    const build = await createLocalHybridRetriever(new HashEmbedder(), docs, { min_similarity: 0.1 });
    const hits = await build(docs).retrieve({ text: "hook in the first seconds", collection: "skills", k: 2, filter: {} });
    expect(hits[0]!.doc.id).toBe("hooks");
  });
});

describe("retrieval status", () => {
  const base: RetrievalStatus = { mode: "bm25-only", embedder: { model: "hash-features", version: "1", real: false }, counts: { skills: 1, templates: 0, recipes: 1, notes: 1 }, degraded: ["no model"], vectors: null };
  it("says plainly when meaning-based search is off", () => {
    expect(isSemantic(base)).toBe(false);
    expect(describeRetrieval(base)).toContain("KEYWORD ONLY");
    expect(describeRetrieval(base)).toContain("WARNING: no model");
    expect(isSemantic({ ...base, mode: "memory-hybrid", embedder: { model: "m", version: "1", real: true }, degraded: [] })).toBe(true);
  });
});
