import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Transcript } from "@digikon/contracts";
import { DemoClient, SkillLibrary } from "@digikon/director";
import { KeywordRetriever, loadKnowledge, recipeDocs, type RetrievalStatus } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import type { SpeechEngine } from "@digikon/speech";
import { createApp } from "./app.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const recipes = loadRecipes(join(repo, "recipes"));
const dir = mkdtempSync(join(tmpdir(), "retr-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const speech: SpeechEngine = { model: "stub", transcribe: async () => Transcript.parse({ text: "x", language: "en", language_confidence: 1, model: "stub", duration_s: 1, words: [], segments: [] }) } as SpeechEngine;
const keywordOnly: RetrievalStatus = { mode: "bm25-only", embedder: { model: "hash-features", version: "1", real: false }, counts: { skills: 1, templates: 0, recipes: 1, notes: 1 }, degraded: ["No sentence-embedding model."], vectors: null };
const build = (extra: Record<string, unknown>) => createApp({
  llm: new DemoClient(), demo: true, speech, whisper: () => ({ state: "ready" }), skills: new SkillLibrary(join(repo, "skills")), editorSkills: new SkillLibrary(join(repo, "skills/editor")),
  retriever: new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge"))]),
  recipes: new RecipeLibrary(recipes, "draft"), ffmpegOk: true, renderFont: null, storageDir: dir, publicDir: join(repo, "apps/console/public"), ...extra,
} as never);

describe("retrieval status", () => {
  it("is served on /api/health", async () => {
    const h = (await (await build({ retrievalStatus: keywordOnly }).request("/api/health")).json()) as { retrieval: RetrievalStatus };
    expect(h.retrieval.mode).toBe("bm25-only");
    expect(h.retrieval.degraded.length).toBe(1);
  });
  it("strict mode refuses to plan on keyword-only search, and says why", async () => {
    const app = build({ retrievalStatus: keywordOnly, requireVectors: true });
    const { id } = (await (await app.request("/api/sessions", { method: "POST" })).json()) as { id: string };
    const r = await app.request(`/api/sessions/${id}/direct`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).toContain("search_degraded");
  });
  it("without strict mode the same session is not refused for search", async () => {
    const app = build({ retrievalStatus: keywordOnly });
    const { id } = (await (await app.request("/api/sessions", { method: "POST" })).json()) as { id: string };
    const r = await app.request(`/api/sessions/${id}/direct`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(JSON.stringify(await r.json())).not.toContain("search_degraded");
  });
});
