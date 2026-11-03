import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPgSingle, PgDataStore, type SqlClient, type TemplateRow } from "./store.js";
import { readMigrations, runMigrations } from "./migrate.js";

/** Runs against a real Postgres with pgvector, in a throwaway schema. Skipped unless DATABASE_URL is set. */
const url = process.env["DATABASE_URL"];
const tpl = (id: string, over: Partial<TemplateRow> = {}): TemplateRow => ({ id, category_id: null, title: id, family: "kinetic", variant_of: null, archetype: null, tags: ["a", "b"], status: "draft", body: { id, nested: { n: 1 } }, content_hash: "h", ...over });

describe.skipIf(!url)("Postgres + pgvector integration", () => {
  const schema = `t_${randomBytes(4).toString("hex")}`;
  let db: SqlClient & { connect(): Promise<void> };
  let store: PgDataStore;
  const migrations = readMigrations(resolve(import.meta.dirname, "..", "..", "..", "..", "db", "migrations"));

  beforeAll(async () => {
    db = await connectPgSingle(url!);
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
    for (const name of ["templates", "template_categories", "template_embeddings", "template_usage", "template_review", "capability_index", "retrieval_log", "model_calls", "render_jobs"]) {
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
});
