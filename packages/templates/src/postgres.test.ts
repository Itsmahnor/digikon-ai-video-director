import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chooseEmbedder, MemoryDataStore, PgDataStore, readMigrations, runMigrations, type DataStore, type Embedder, type SqlClient } from "@digikon/rag";
import { ingestLibrary } from "./ingest.js";
import { LIBRARY_DIR, REPO_ROOT, loadLibrary } from "./library.js";
import { ensureLooks, MODELS_DIR } from "./looks.js";
import { searchTemplates } from "./search.js";

/**
 * Real Postgres with the real pgvector extension, in-process (PGlite: Postgres compiled to WebAssembly, with the pgvector extension), running the
 * project's own migrations and the PgDataStore SQL against the real library: the same code path DATABASE_URL uses, without needing a server.
 * It is not the pgvector/pgvector:pg16 container (there is no Docker on the development machine), so the same suite also runs against a server when
 * DATABASE_URL is set (see packages/rag/src/db/pg.integration.test.ts for the store-level tests that do).
 */
interface PGliteLike { query(t: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; exec(t: string): Promise<{ rows: Record<string, unknown>[] }[]>; close(): Promise<void> }

let db: PGliteLike, pg: PgDataStore, mem: MemoryDataStore, embedder: Embedder, real = false;
const lib = loadLibrary(LIBRARY_DIR).flatMap((l) => (l.record ? [l.record] : []));

const client = (d: PGliteLike): SqlClient => ({
  // PGlite's extended protocol takes one statement; a migration is many, so statements without parameters go through exec.
  query: async (text, params) => {
    if (params && params.length) return { rows: (await d.query(text, [...params])).rows };
    const r = await d.exec(text);
    return { rows: r.length ? r[r.length - 1]!.rows : [] };
  },
  end: async () => d.close(),
});

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  db = (await PGlite.create({ extensions: { vector } })) as unknown as PGliteLike;
  const sql = client(db);
  const migrations = readMigrations(resolve(REPO_ROOT, "db", "migrations"));
  const first = await runMigrations(sql, migrations);
  expect(first.applied.length).toBe(migrations.length);
  pg = new PgDataStore(sql);
  mem = new MemoryDataStore();
  const c = chooseEmbedder(MODELS_DIR);
  embedder = c.embedder; real = c.real;
  const looks = await ensureLooks(lib, { render: false });
  await ingestLibrary(pg, embedder, lib, looks);
  await ingestLibrary(mem, embedder, lib, looks);
}, 600_000);
afterAll(async () => { await db?.close(); });

describe("Postgres + pgvector, with the real library", () => {
  it("has the library to test with", () => { expect(lib.length).toBeGreaterThan(100); });

  it("applies the migrations once and reports pgvector healthy", async () => {
    const again = await runMigrations(client(db), readMigrations(resolve(REPO_ROOT, "db", "migrations")));
    expect(again.applied).toEqual([]);
    expect(again.skipped.length).toBeGreaterThan(0);
    const h = await pg.health();
    expect(h).toMatchObject({ ok: true, backend: "postgres", vector_extension: true });
  });

  it("seeds the 18 categories under their two groups and stores every template with its embeddings", async () => {
    const cats = await pg.listCategories();
    expect(cats.filter((c) => c.parent_id !== null)).toHaveLength(18);
    expect(cats.filter((c) => c.parent_id === null).map((c) => c.id).sort()).toEqual(["scene", "support"]);
    const rows = await pg.listTemplates();
    expect(rows).toHaveLength(lib.length);
    expect(new Set(rows.map((r) => r.category_id)).size).toBe(18);
    const counts = (await db.query("SELECT kind, count(*)::int AS n FROM template_embeddings GROUP BY kind ORDER BY kind")).rows;
    expect(counts).toEqual([{ kind: "look", n: lib.length }, { kind: "text", n: lib.length }]);
    const dims = (await db.query("SELECT kind, min(vector_dims(vector))::int AS d FROM template_embeddings GROUP BY kind ORDER BY kind")).rows;
    expect(dims).toEqual([{ kind: "look", d: 512 }, { kind: "text", d: embedder.dim }]);
  });

  it("a second ingest changes nothing (content hashes and embeddings are already stored)", async () => {
    const looks = await ensureLooks(lib, { render: false });
    const s = await ingestLibrary(pg, embedder, lib, looks);
    expect(s).toMatchObject({ added: 0, updated: 0, unchanged: lib.length, text_vectors: 0, look_vectors: 0 });
  });

  it("pgvector's nearest-neighbour answer equals the in-memory cosine answer", async () => {
    const q = (await embedder.embed(["a big statistic counting up as an opening hook"]))[0]!;
    const a = await pg.nearest({ kind: "text", model: embedder.model, model_version: embedder.version, vector: q, k: 15 });
    const b = await mem.nearest({ kind: "text", model: embedder.model, model_version: embedder.version, vector: q, k: 15 });
    expect(a.map((x) => x.template_id)).toEqual(b.map((x) => x.template_id));
    a.forEach((x, i) => expect(x.score).toBeCloseTo(b[i]!.score, 4));
    expect(a[0]!.score).toBeGreaterThan(a[14]!.score);
  });

  it("the look embeddings of a template and its own copy are identical, and differ from another family", async () => {
    const t = lib.find((x) => x.template_id === "hook-bold-claim")!;
    const v = (await db.query("SELECT vector::text AS v FROM template_embeddings WHERE template_id=$1 AND kind='look'", [t.template_id])).rows[0]!["v"] as string;
    const vec = JSON.parse(v) as number[];
    const near = await pg.nearest({ kind: "look", model: "Xenova/clip-vit-base-patch32", model_version: "q8-image_embeds-1", vector: vec, k: 3 });
    expect(near[0]).toMatchObject({ template_id: t.template_id });
    expect(near[0]!.score).toBeCloseTo(1, 3);
    expect(near[2]!.score).toBeLessThan(1);
  });

  it("search_templates answers real intents from Postgres: right category first, right family near the top", async () => {
    const cases: [string, string, string][] = [
      ["opening scene with a shocking statistic that counts up", "hook", "hook-number-shock"],
      ["customer testimonial quote with name and role", "social_proof", "social-quote-card"],
      ["closing call to action with a pill button and web address", "cta_end", "cta-button-pulse"],
      ["app window where a cursor clicks a button", "ui_demo", "ui-click-flow"],
      ["three numbered steps joined by a line showing how it works", "process", "process-three-steps"],
      ["old way versus new way before and after comparison", "comparison", "comparison-two-columns"],
      ["lower third with a speaker name and role", "lower_thirds_captions", "lt-name-bar"],
      ["slow push in camera move", "camera_moves", "cam-push-in"],
      ["bars growing from the baseline chart", "charts", "chart-bars-rise"],
      ["crossed out myth that is wrong", "problem", "problem-crossed-out"],
      ["wipe transition with an accent panel crossing the frame", "transitions", "tr-wipe-panel"],
      ["words popping in one by one big text", "kinetic_type", "kt-word-pop"],
    ];
    let familyHits = 0;
    for (const [text, category, family] of cases) {
      const hits = await searchTemplates(pg, embedder, { text, category: category as never, status: ["draft", "reviewed"], k: 5 });
      expect(hits.length, text).toBeGreaterThan(0);
      expect(hits.every((h) => h.category === category), text).toBe(true);
      if (hits.some((h) => h.family === family)) familyHits++;
    }
    // reported, not hidden: the share of intents whose intended family is among the top 5 of its category
    console.log(`search_templates on Postgres: intended family in the top 5 for ${familyHits}/${cases.length} intents (${real ? "bge-small-en-v1.5" : "hash embedder"})`);
    expect(familyHits).toBeGreaterThanOrEqual(Math.ceil(cases.length * 0.75));
  }, 180_000);

  it("search on Postgres: aspect and status filters, MMR variety, and no-repeat from template_usage", async () => {
    const q = { text: "opening hook headline", category: "hook" as const, status: ["draft", "reviewed"] as ("draft" | "reviewed")[], k: 6 };
    expect(await searchTemplates(pg, embedder, { ...q, status: ["reviewed"] })).toEqual([]);
    const all = await searchTemplates(pg, embedder, q);
    expect(all).toHaveLength(6);
    expect(new Set(all.map((h) => h.family)).size).toBeGreaterThan(1); // variety across families, not six variants of one
    const tall = await searchTemplates(pg, embedder, { ...q, aspect: "9:16" });
    expect(tall.length).toBeGreaterThan(0);
    await pg.logTemplateUsage({ template_id: all[0]!.template_id, film_id: "film-1", scene_id: "S01", outcome: { ok: true } });
    const again = await searchTemplates(pg, embedder, { ...q, film_id: "film-1" });
    expect(again[0]!.template_id).not.toBe(all[0]!.template_id);
    expect(again.find((h) => h.template_id === all[0]!.template_id)?.why.join(" ") ?? "already used").toMatch(/already used/);
    const u = await pg.usage("film-1");
    expect(u.total.get(all[0]!.template_id)).toBe(1);
    expect(u.in_film.get(all[0]!.template_id)).toBe(1);
  }, 180_000);

  it("template_review and the foreign keys hold: a review needs a template, a template needs a category", async () => {
    await pg.addReview({ template_id: "hook-bold-claim", reviewer: "tester", verdict: "approved", notes: "ok" });
    expect((await pg.listReviews("hook-bold-claim")).map((r) => r.verdict)).toEqual(["approved"]);
    await expect(pg.addReview({ template_id: "no-such-template", reviewer: "t", verdict: "approved", notes: "" })).rejects.toThrow();
    await expect(pg.upsertTemplate({ id: "orphan", category_id: "no_such_category", title: "x", family: null, variant_of: null, archetype: null, tags: [], status: "draft", body: {}, content_hash: "h" })).rejects.toThrow();
    await expect(db.query("UPDATE templates SET status='nonsense' WHERE id='hook-bold-claim'")).rejects.toThrow();
  });
});

export type { DataStore };
