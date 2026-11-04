import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryDataStore } from "./db/store.js";
import { HashEmbedder } from "./embeddings.js";
import { HybridRetriever } from "./hybrid.js";
import { importSkills, ALLOWED_LICENCES, skillDoc, type ImportResult } from "./skills.js";
import { ScopedRetriever } from "./scopes.js";

/** The skills that ship in examples/skills: each source folder is imported through the licence gate, as `npm run skills -- import examples/skills` does. */
const ROOT = resolve(import.meta.dirname, "..", "..", "..", "examples", "skills");
const sources = readdirSync(ROOT).map((n) => join(ROOT, n)).filter((p) => statSync(p).isDirectory() && existsSync(join(p, "skills-source.json")));

const store = new MemoryDataStore();
const results: ImportResult[] = [];
const emb = new HashEmbedder();

beforeAll(async () => { for (const dir of sources) results.push(await importSkills(store, emb, dir, { today: "2026-11-04" })); });

describe("shipped skill library", () => {
  it("every source passes the licence gate and nothing is rejected", () => {
    expect(sources.length).toBeGreaterThanOrEqual(10);
    for (const r of results) { expect(r.licence?.ok).toBe(true); expect(r.rejected).toEqual([]); }
  });

  it("every stored skill has an allowed licence, an attribution, a source URL and the schema's fields", async () => {
    const skills = await store.listSkills();
    expect(skills.length).toBeGreaterThanOrEqual(70);
    for (const s of skills) {
      const src = (await store.getSkillSource(s.source_id))!;
      expect(src, s.id).toBeTruthy();
      expect((ALLOWED_LICENCES as readonly string[]).includes(src.licence), `${s.id}: ${src.licence}`).toBe(true);
      expect(src.attribution?.trim(), `${s.id} attribution`).toBeTruthy();
      expect(src.url, s.id).toMatch(/^(https:\/\/|urn:)/);
      expect(["saas", "ecommerce", "general-promo", "all"]).toContain(s.category);
      expect(["director", "editor", "both"]).toContain(s.scope);
      expect(s.topic.length).toBeGreaterThan(0);
      expect(s.status).toBe("draft");
      expect(s.grade).toBe("C");
    }
  });

  it("covers the video types, funnel stages and cross-cutting topics", async () => {
    const skills = await store.listSkills();
    const topics = new Set(skills.map((s) => s.topic));
    for (const t of ["video-type-playbook", "funnel", "platform-rules", "hook", "structure", "pacing", "text-captions", "cta-offer", "brand", "claims-safety", "accessibility", "audio", "asset-gaps", "motion", "renderer", "visual-design"]) expect(topics.has(t), t).toBe(true);
    for (const c of ["saas", "ecommerce", "general-promo"]) expect(skills.some((s) => s.category === c && s.topic === "video-type-playbook"), c).toBe(true);
    expect(new Set(skills.filter((s) => s.topic === "funnel").map((s) => s.funnel_stage))).toEqual(new Set(["awareness", "consideration", "conversion", "retention"]));
  });

  it("a category query returns that category plus `all`, and never another specific category", async () => {
    const skills = await store.listSkills();
    const hybrid = await HybridRetriever.create(skills.map(skillDoc).filter((d) => d !== null), emb, {});
    for (const category of ["saas", "ecommerce", "general-promo"]) {
      const hits = await hybrid.retrieve({ text: "video structure hook proof call to action", collection: "skills", k: 30, filter: { category, include_draft: true } });
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) expect([category, "all"], `${category} -> ${h.doc.id}`).toContain(h.doc.metadata.skill_category);
    }
    const listed = await store.listSkills({ category: "ecommerce" });
    expect(listed.every((s) => s.category === "ecommerce" || s.category === "all")).toBe(true);
  });

  it("the Editor does not receive Director-only skills and vice versa", async () => {
    const skills = await store.listSkills();
    const hybrid = await HybridRetriever.create(skills.map(skillDoc).filter((d) => d !== null), emb, {});
    const ids = async (agent: "director" | "editor") => (await new ScopedRetriever(hybrid, agent, { allowDraft: true }).retrieve({ text: "motion seam camera claims facts", collection: "skills", k: 80, filter: { include_draft: true } })).map((h) => h.doc.id);
    const byId = new Map(skills.map((s) => [s.id, s]));
    for (const id of await ids("editor")) expect(byId.get(id)!.scope).not.toBe("director");
    for (const id of await ids("director")) expect(byId.get(id)!.scope).not.toBe("editor");
  });

  it("a source with no licence (remotion-dev/skills has no LICENSE file) is refused whole and stores nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remotion-dev-"));
    writeFileSync(join(dir, "skills-source.json"), JSON.stringify({ repo: "remotion-dev/skills", url: "https://github.com/remotion-dev/skills" }));
    mkdirSync(join(dir, "skills"));
    writeFileSync(join(dir, "skills", "x.md"), "---\nid: x\ntitle: x\ncategory: all\ntopic: renderer\nfunnel_stage: all\ngrade: C\n---\nbody");
    const fresh = new MemoryDataStore();
    const r = await importSkills(fresh, emb, dir);
    expect(r.licence).toMatchObject({ ok: false });
    expect(r.rejected[0]!.problems[0]).toMatch(/licence gate: no licence declared/);
    expect(await fresh.listSkills()).toEqual([]);
  });
});
