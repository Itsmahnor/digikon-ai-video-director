import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPgSingle, PgDataStore, type SqlClient, type TemplateRow } from "./store.js";
import { readMigrations, runMigrations } from "./migrate.js";

/**
 * Runs against Postgres with pgvector, in a throwaway schema. With DATABASE_URL set it uses that server (the real thing: docker compose up postgres).
 * Without it, it runs the same tests on PGlite (Postgres compiled to WebAssembly, with pgvector), in-process: same SQL and migrations, but not a server.
 * It is skipped only if neither is available. The backend that ran is printed, so a PGlite pass is never mistaken for a server pass.
 */
const url = process.env["DATABASE_URL"];
type Db = SqlClient & { connect(): Promise<void> };
interface PGliteLike { query(t: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; exec(t: string): Promise<{ rows: Record<string, unknown>[] }[]>; close(): Promise<void> }

async function pgliteClient(): Promise<Db | null> {
  let mod: { PGlite: { create(o: unknown): Promise<unknown> } }, vec: { vector: unknown };
  const core = "@electric-sql/pglite", ext = "@electric-sql/pglite/vector";
  try { mod = (await import(core)) as typeof mod; vec = (await import(ext)) as typeof vec; } catch { return null; }
  const d = (await mod.PGlite.create({ extensions: { vector: vec.vector } })) as PGliteLike;
  return {
    // PGlite's extended protocol takes one statement; a migration is many, so statements without parameters go through exec.
    query: async (text, params) => {
      if (params && params.length) return { rows: (await d.query(text, [...params])).rows };
      const r = await d.exec(text);
      return { rows: r.length ? r[r.length - 1]!.rows : [] };
    },
    end: async () => d.close(),
    connect: async () => undefined,
  };
}
const pglite = url ? null : await pgliteClient();
const available = !!url || !!pglite;
console.log(`[pg.integration] backend: ${url ? "Postgres server via DATABASE_URL" : pglite ? "PGlite (in-process WebAssembly Postgres, NOT a server)" : "none available (skipped)"}`);
const tpl = (id: string, over: Partial<TemplateRow> = {}): TemplateRow => ({ id, category_id: null, title: id, family: "kinetic", variant_of: null, archetype: null, tags: ["a", "b"], status: "draft", body: { id, nested: { n: 1 } }, content_hash: "h", ...over });

describe.skipIf(!available)("Postgres + pgvector integration", () => {
  const schema = `t_${randomBytes(4).toString("hex")}`;
  let db: SqlClient & { connect(): Promise<void> };
  let store: PgDataStore;
  const migrations = readMigrations(resolve(import.meta.dirname, "..", "..", "..", "..", "db", "migrations"));

  beforeAll(async () => {
    db = url ? await connectPgSingle(url) : pglite!;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}, public`);
    store = new PgDataStore(db);
  });
  afterAll(async () => {
    if (!db) return;
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  });

  it("migrations apply once and are idempotent; the extension and tables exist", async () => {
    const first = await runMigrations(db, migrations);
    expect(first.applied).toEqual(migrations.map((m) => m.name));
    const second = await runMigrations(db, migrations);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(migrations.map((m) => m.name));
    expect(await store.health()).toMatchObject({ ok: true, backend: "postgres", vector_extension: true });
    const t = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1", [schema]);
    for (const name of ["templates", "template_categories", "template_embeddings", "template_usage", "template_review", "capability_index", "retrieval_log", "model_calls", "render_jobs", "skill_sources", "skills", "skill_embeddings", "assets_library"]) {
      expect(t.rows.map((r) => r["table_name"])).toContain(name);
    }
  });

  it("inserts, updates, reads and filters templates, with jsonb and array columns round-tripping", async () => {
    await store.upsertTemplate(tpl("alpha"));
    await store.upsertTemplate(tpl("beta", { family: "wipe", status: "approved" }));
    await store.upsertTemplate(tpl("alpha", { title: "Alpha 2", tags: ["z"] }));
    expect(await store.getTemplate("alpha")).toMatchObject({ title: "Alpha 2", tags: ["z"], body: { id: "alpha", nested: { n: 1 } } });
    expect((await store.listTemplates({ family: "wipe" })).map((x) => x.id)).toEqual(["beta"]);
    expect((await store.listTemplates()).length).toBe(2);
    expect(await store.getTemplate("nope")).toBeNull();
  });

  it("finds nearest neighbours with the cosine operator, per kind and model version", async () => {
    await store.upsertTemplate(tpl("gamma"));
    const put = (template_id: string, vector: number[], kind: "text" | "look" = "text", model_version = "1") => store.upsertEmbedding({ template_id, kind, model: "m", model_version, vector });
    await put("alpha", [1, 0, 0]); await put("beta", [0.9, 0.1, 0]); await put("gamma", [0, 0, 1]); await put("gamma", [1, 0, 0], "look"); await put("alpha", [0, 1, 0], "text", "2");
    await put("alpha", [1, 0, 0]); // upsert, not a duplicate
    const hits = await store.nearest({ kind: "text", model: "m", model_version: "1", vector: [1, 0, 0], k: 2 });
    expect(hits.map((h) => h.template_id)).toEqual(["alpha", "beta"]);
    expect(hits[0]!.score).toBeCloseTo(1, 5);
    expect(hits[1]!.score).toBeLessThan(hits[0]!.score);
    expect((await store.nearest({ kind: "look", model: "m", model_version: "1", vector: [1, 0, 0], k: 5 })).map((h) => h.template_id)).toEqual(["gamma"]);
    const count = await db.query("SELECT count(*)::int AS n FROM template_embeddings WHERE template_id='alpha' AND kind='text' AND model_version='1'");
    expect(count.rows[0]!["n"]).toBe(1);
    await expect(store.upsertEmbedding({ template_id: "ghost", kind: "text", model: "m", model_version: "1", vector: [1, 0, 0] })).rejects.toThrow();
  });

  it("records template usage and cascades it when the template is deleted", async () => {
    await db.query("INSERT INTO template_usage (template_id, film_id, scene_id, outcome) VALUES ($1,$2,$3,$4::jsonb)", ["beta", "film1", "S01", JSON.stringify({ rendered: true })]);
    const u = await db.query("SELECT template_id, film_id, outcome FROM template_usage");
    expect(u.rows).toEqual([{ template_id: "beta", film_id: "film1", outcome: { rendered: true } }]);
    await db.query("DELETE FROM templates WHERE id='beta'");
    expect((await db.query("SELECT 1 FROM template_usage")).rows).toEqual([]);
    expect((await db.query("SELECT 1 FROM template_embeddings WHERE template_id='beta'")).rows).toEqual([]);
  });

  it("logs model calls and retrievals", async () => {
    await store.logModelCall({ film_id: "film1", provider: "p", model: "m", name: "treatment", input_tokens: 10, output_tokens: 5, cost_usd: 0.0123, attempts: 1, outcome: "ok", error_code: null, duration_ms: 42 });
    expect(await store.modelCalls("film1")).toMatchObject([{ name: "treatment", cost_usd: 0.0123, outcome: "ok" }]);
    await store.logRetrieval({ film_id: "film1", query: "q", collection: "shot_recipes", hits: [{ id: "x" }] });
    expect((await db.query("SELECT hits FROM retrieval_log")).rows[0]).toEqual({ hits: [{ id: "x" }] });
  });

  it("skills: a licence is required by the database itself, and skills round-trip with filters and vector search", async () => {
    await expect(db.query("INSERT INTO skill_sources (id, repo, url, licence, checked_on) VALUES ('bad','r','u','  ','2026-11-04')")).rejects.toThrow();
    await expect(store.upsertSkillSource({ id: "bad", repo: "r", url: "u", licence: "", attribution: null, checked_on: "2026-11-04" })).rejects.toThrow(/licence/);
    await expect(db.query("INSERT INTO skills (id, category, funnel_stage, grade, title, body, content_hash, source_id) VALUES ('orphan','hook','awareness','a','t','\"x\"'::jsonb,'h','nosuch')")).rejects.toThrow();
    await expect(db.query("INSERT INTO assets_library (id, kind, file, licence, source) VALUES ('f','font','f.ttf','','x')")).rejects.toThrow();
    await store.upsertSkillSource({ id: "s1", repo: "acme/skills", url: "https://example.test", licence: "MIT", attribution: null, checked_on: "2026-11-04" });
    expect(await store.getSkillSource("s1")).toMatchObject({ licence: "MIT", checked_on: "2026-11-04" });
    const sk = (id: string, over: Record<string, unknown> = {}) => ({ id, category: "saas", topic: "hook", scope: "both" as const, funnel_stage: "awareness", platform: ["tiktok"], grade: "a", status: "approved" as const, title: id, body: "text", content_hash: "h", source_id: "s1", ...over });
    await store.upsertSkill(sk("k1")); await store.upsertSkill(sk("k2", { category: "ecommerce", platform: ["youtube"], scope: "editor" })); await store.upsertSkill(sk("k3", { category: "all", topic: "pacing", scope: "director" })); await store.upsertSkill(sk("k1", { title: "K1 v2" }));
    expect((await store.getSkill("k1"))!.title).toBe("K1 v2");
    expect((await store.listSkills({ category: "saas" })).map((s) => s.id)).toEqual(["k1", "k3"]);
    expect((await store.listSkills({ category: "ecommerce" })).map((s) => s.id)).toEqual(["k2", "k3"]);
    expect((await store.listSkills({ topic: "pacing" })).map((s) => s.id)).toEqual(["k3"]);
    expect((await store.listSkills({ scope: "editor" })).map((s) => s.id)).toEqual(["k1", "k2"]);
    expect((await store.listSkills({ platform: "youtube" })).map((s) => s.id)).toEqual(["k2"]);
    await store.upsertSkillEmbedding({ skill_id: "k1", model: "m", model_version: "1", vector: [1, 0, 0] });
    await store.upsertSkillEmbedding({ skill_id: "k2", model: "m", model_version: "1", vector: [0, 1, 0] });
    await store.upsertSkillEmbedding({ skill_id: "k1", model: "m", model_version: "1", vector: [1, 0, 0] });
    expect((await store.nearestSkills({ model: "m", model_version: "1", vector: [1, 0, 0], k: 2 })).map((h) => h.skill_id)).toEqual(["k1", "k2"]);
    await store.upsertLibraryAsset({ id: "inter", kind: "font", file: "Inter.ttf", licence: "OFL-1.1", source: "rsms.me/inter" });
    expect((await store.listLibraryAssets("font")).map((a) => a.id)).toEqual(["inter"]);
  });});
