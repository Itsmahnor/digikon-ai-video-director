import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDataStore, openStore, PgDataStore, cosine, type SqlClient, type TemplateRow } from "./store.js";
import { readMigrations, runMigrations } from "./migrate.js";

const tpl = (id: string, over: Partial<TemplateRow> = {}): TemplateRow => ({ id, category_id: null, title: id, family: "kinetic", variant_of: null, archetype: null, tags: [], status: "draft", body: { id }, content_hash: "h", ...over });

describe("MemoryDataStore (no database needed)", () => {
  it("stores templates and filters them", async () => {
    const s = new MemoryDataStore();
    await s.upsertTemplate(tpl("a")); await s.upsertTemplate(tpl("b", { family: "wipe", status: "approved" })); await s.upsertTemplate(tpl("a", { title: "A2" }));
    expect((await s.getTemplate("a"))!.title).toBe("A2");
    expect((await s.listTemplates({ family: "wipe" })).map((t) => t.id)).toEqual(["b"]);
    expect((await s.listTemplates({ status: "draft" })).length).toBe(1);
    expect(await s.getTemplate("zzz")).toBeNull();
  });
  it("finds nearest neighbours per kind and model version", async () => {
    const s = new MemoryDataStore();
    for (const id of ["a", "b", "c"]) await s.upsertTemplate(tpl(id));
    const e = (template_id: string, vector: number[], kind: "text" | "look" = "text", model_version = "1") => s.upsertEmbedding({ template_id, kind, model: "m", model_version, vector });
    await e("a", [1, 0]); await e("b", [0.9, 0.1]); await e("c", [0, 1]); await e("c", [1, 0], "look"); await e("a", [0, 1], "text", "2");
    const hits = await s.nearest({ kind: "text", model: "m", model_version: "1", vector: [1, 0], k: 2 });
    expect(hits.map((h) => h.template_id)).toEqual(["a", "b"]);
    expect(hits[0]!.score).toBeCloseTo(1);
    expect((await s.nearest({ kind: "look", model: "m", model_version: "1", vector: [1, 0], k: 5 })).map((h) => h.template_id)).toEqual(["c"]);
    await expect(s.upsertEmbedding({ template_id: "nope", kind: "text", model: "m", model_version: "1", vector: [1] })).rejects.toThrow();
  });
  it("logs model calls per film and reports healthy", async () => {
    const s = new MemoryDataStore();
    const row = { provider: "p", model: "m", name: "n", input_tokens: 1, output_tokens: 2, cost_usd: 0, attempts: 1, outcome: "ok" as const, error_code: null, duration_ms: 3 };
    await s.logModelCall({ film_id: "f1", ...row }); await s.logModelCall({ film_id: "f2", ...row });
    expect((await s.modelCalls("f1")).length).toBe(1);
    expect((await s.modelCalls()).length).toBe(2);
    expect(await s.health()).toMatchObject({ ok: true, backend: "memory" });
  });
  it("openStore uses memory without DATABASE_URL", async () => {
    await expect((await openStore({})).health()).resolves.toMatchObject({ backend: "memory" });
  });
  it("cosine handles degenerate input", () => { expect(cosine([], [])).toBe(0); expect(cosine([0, 0], [1, 1])).toBe(0); expect(cosine([1], [1, 2])).toBe(0); });
});

/** A recording fake of the SQL client. */
function fakeSql(handler: (text: string, params?: readonly unknown[]) => Record<string, unknown>[] = () => []) {
  const log: { text: string; params?: readonly unknown[] }[] = [];
  const client: SqlClient = { query: async (text, params) => { log.push({ text, ...(params ? { params } : {}) }); return { rows: handler(text, params) }; }, end: async () => {} };
  return { client, log };
}

describe("PgDataStore issues the right SQL", () => {
  it("upserts a template and an embedding with a vector literal", async () => {
    const { client, log } = fakeSql();
    const s = new PgDataStore(client);
    await s.upsertTemplate(tpl("a"));
    await s.upsertEmbedding({ template_id: "a", kind: "look", model: "m", model_version: "1", vector: [0.5, 1] });
    expect(log[0]!.text).toContain("INSERT INTO templates");
    expect(log[1]!.text).toContain("template_embeddings");
    expect(log[1]!.params).toEqual(["a", "look", "m", "1", "[0.5,1]"]);
  });
  it("nearest uses cosine distance and maps rows", async () => {
    const { client, log } = fakeSql(() => [{ template_id: "a", score: "0.9" }]);
    expect(await new PgDataStore(client).nearest({ kind: "text", model: "m", model_version: "1", vector: [1, 2], k: 3 })).toEqual([{ template_id: "a", score: 0.9 }]);
    expect(log[0]!.text).toContain("<=>");
  });
  it("health needs the vector extension", async () => {
    expect(await new PgDataStore(fakeSql((t) => (t.includes("pg_extension") ? [{ "?column?": 1 }] : [{}])).client).health()).toMatchObject({ ok: true, vector_extension: true });
    expect(await new PgDataStore(fakeSql((t) => (t.includes("pg_extension") ? [] : [{}])).client).health()).toMatchObject({ ok: false, vector_extension: false });
    const down: SqlClient = { query: async () => { throw new Error("ECONNREFUSED"); }, end: async () => {} };
    expect(await new PgDataStore(down).health()).toMatchObject({ ok: false, vector_extension: null });
  });
});

describe("migrations", () => {
  it("the shipped migration creates the extension and every foundation table", () => {
    const ms = readMigrations(resolve(import.meta.dirname, "..", "..", "..", "..", "db", "migrations"));
    expect(ms.length).toBeGreaterThan(0);
    const sql = ms.map((m) => m.sql).join("\n");
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    for (const t of ["template_categories", "templates", "template_embeddings", "template_usage", "template_review", "capability_index", "retrieval_log", "model_calls", "render_jobs"]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t} `);
    expect(sql).toMatch(/kind\s+text NOT NULL CHECK \(kind IN \('text', 'look'\)\)/);
  });
  it("applies pending migrations once, in order, and refuses an edited one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    try {
      writeFileSync(join(dir, "0002_b.sql"), "SELECT 2;"); writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;"); writeFileSync(join(dir, "notes.txt"), "x");
      const applied = new Map<string, string>();
      const ran: string[] = [];
      const { client } = fakeSql((text, params) => {
        if (text.startsWith("SELECT name")) return [...applied].map(([name, checksum]) => ({ name, checksum }));
        if (text.startsWith("INSERT INTO schema_migrations")) applied.set(String(params![0]), String(params![1]));
        else if (/^(BEGIN|COMMIT|ROLLBACK|CREATE TABLE)/.test(text)) ran.push(text.split(" ")[0]!); else ran.push(text);
        return [];
      });
      const ms = readMigrations(dir);
      expect(ms.map((m) => m.name)).toEqual(["0001_a.sql", "0002_b.sql"]);
      expect(await runMigrations(client, ms)).toEqual({ applied: ["0001_a.sql", "0002_b.sql"], skipped: [] });
      expect(ran.filter((x) => x.startsWith("SELECT"))).toEqual(["SELECT 1;", "SELECT 2;"]);
      expect(await runMigrations(client, ms)).toEqual({ applied: [], skipped: ["0001_a.sql", "0002_b.sql"] });
      writeFileSync(join(dir, "0001_a.sql"), "SELECT 99;");
      await expect(runMigrations(client, readMigrations(dir))).rejects.toThrow(/changed after it was applied/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("a failing migration rolls back and is reported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    try {
      writeFileSync(join(dir, "0001_a.sql"), "BAD;");
      const seen: string[] = [];
      const client: SqlClient = { query: async (t) => { seen.push(t.split(" ")[0]!); if (t === "BAD;") throw new Error("syntax"); return { rows: [] }; }, end: async () => {} };
      await expect(runMigrations(client, readMigrations(dir))).rejects.toThrow(/0001_a.sql failed: syntax/);
      expect(seen).toContain("ROLLBACK");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
