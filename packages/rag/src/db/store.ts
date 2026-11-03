/**
 * Data access for the Postgres + pgvector library. Everything above this file talks to `DataStore`; there are two implementations: `MemoryDataStore`
 * (tests, and any run with no DATABASE_URL) and `PgDataStore` (a real database, behind the small `SqlClient` interface so the driver is swappable).
 */

export type EmbeddingKind = "text" | "look";

export interface TemplateRow { id: string; category_id: string | null; title: string; family: string | null; variant_of: string | null; archetype: string | null; tags: string[]; status: "draft" | "reviewed" | "approved" | "retired"; body: unknown; content_hash: string }
export interface EmbeddingRow { template_id: string; kind: EmbeddingKind; model: string; model_version: string; vector: number[] }
export interface ModelCallRow { film_id: string | null; provider: string; model: string; name: string; input_tokens: number; output_tokens: number; cost_usd: number; attempts: number; outcome: "ok" | "error" | "budget_stop"; error_code: string | null; duration_ms: number }
export interface RetrievalLogRow { film_id: string | null; query: string; collection: string | null; hits: unknown[] }
export interface Neighbour { template_id: string; score: number }
export interface TemplateUsageRow { template_id: string; film_id: string | null; scene_id: string | null; outcome: unknown }
/** Template use counts, overall and in one film (the shape rerank.ts reads). */
export interface UsageCounts { total: Map<string, number>; in_film: Map<string, number> }

export interface CategoryRow { id: string; name: string; parent_id: string | null; description: string }
export interface ReviewRow { template_id: string; reviewer: string; verdict: "approved" | "rejected" | "needs_changes"; notes: string }

export interface DataStore {
  upsertCategory(row: CategoryRow): Promise<void>;
  listCategories(): Promise<CategoryRow[]>;
  addReview(row: ReviewRow): Promise<void>;
  listReviews(templateId?: string): Promise<ReviewRow[]>;
  logTemplateUsage(row: TemplateUsageRow): Promise<void>;
  /** How often each template was used, overall and in one film. */
  usage(filmId?: string): Promise<UsageCounts>;
  upsertTemplate(row: TemplateRow): Promise<void>;
  getTemplate(id: string): Promise<TemplateRow | null>;
  listTemplates(filter?: { family?: string; status?: TemplateRow["status"] }): Promise<TemplateRow[]>;
  upsertEmbedding(row: EmbeddingRow): Promise<void>;
  /** Nearest templates by cosine similarity (higher is closer), for one kind and one model version. */
  nearest(q: { kind: EmbeddingKind; model: string; model_version: string; vector: readonly number[]; k: number }): Promise<Neighbour[]>;
  logModelCall(row: ModelCallRow): Promise<void>;
  modelCalls(filmId?: string): Promise<ModelCallRow[]>;
  logRetrieval(row: RetrievalLogRow): Promise<void>;
  /** Cheap liveness check; the pgvector one also confirms the extension is installed. */
  health(): Promise<StoreHealth>;
  close(): Promise<void>;
}
export interface StoreHealth { ok: boolean; backend: "memory" | "postgres"; vector_extension: boolean | null; detail: string }

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export class MemoryDataStore implements DataStore {
  private templates = new Map<string, TemplateRow>();
  private embeddings = new Map<string, EmbeddingRow>();
  private calls: ModelCallRow[] = [];
  private retrievals: RetrievalLogRow[] = [];
  private uses: TemplateUsageRow[] = [];
  private categories = new Map<string, CategoryRow>();
  private reviews: ReviewRow[] = [];
  async upsertCategory(row: CategoryRow) {
    if (row.parent_id !== null && !this.categories.has(row.parent_id)) throw new Error(`no category ${row.parent_id}`);
    this.categories.set(row.id, { ...row });
  }
  async listCategories() { return [...this.categories.values()].map((c) => ({ ...c })); }
  async addReview(row: ReviewRow) { if (!this.templates.has(row.template_id)) throw new Error(`no template ${row.template_id}`); this.reviews.push({ ...row }); }
  async listReviews(templateId?: string) { return this.reviews.filter((r) => templateId === undefined || r.template_id === templateId).map((r) => ({ ...r })); }
  async logTemplateUsage(row: TemplateUsageRow) { if (!this.templates.has(row.template_id)) throw new Error(`no template ${row.template_id}`); this.uses.push(structuredClone(row)); }
  async usage(filmId?: string): Promise<UsageCounts> { return countUses(this.uses, filmId); }
  async upsertTemplate(row: TemplateRow) { this.templates.set(row.id, structuredClone(row)); }
  async getTemplate(id: string) { const t = this.templates.get(id); return t ? structuredClone(t) : null; }
  async listTemplates(f: { family?: string; status?: TemplateRow["status"] } = {}) {
    return [...this.templates.values()].filter((t) => (!f.family || t.family === f.family) && (!f.status || t.status === f.status)).map((t) => structuredClone(t));
  }
  async upsertEmbedding(row: EmbeddingRow) {
    if (!this.templates.has(row.template_id)) throw new Error(`no template ${row.template_id}`);
    this.embeddings.set(`${row.template_id}|${row.kind}|${row.model}|${row.model_version}`, structuredClone(row));
  }
  async nearest(q: { kind: EmbeddingKind; model: string; model_version: string; vector: readonly number[]; k: number }) {
    return [...this.embeddings.values()].filter((e) => e.kind === q.kind && e.model === q.model && e.model_version === q.model_version)
      .map((e) => ({ template_id: e.template_id, score: cosine(e.vector, q.vector) })).sort((a, b) => b.score - a.score || a.template_id.localeCompare(b.template_id)).slice(0, q.k);
  }
  async logModelCall(row: ModelCallRow) { this.calls.push({ ...row }); }
  async modelCalls(filmId?: string) { return this.calls.filter((c) => filmId === undefined || c.film_id === filmId).map((c) => ({ ...c })); }
  async logRetrieval(row: RetrievalLogRow) { this.retrievals.push(structuredClone(row)); }
  async health(): Promise<StoreHealth> { return { ok: true, backend: "memory", vector_extension: null, detail: "in-memory store (no DATABASE_URL)" }; }
  async close() { /* nothing to release */ }
}

/** The part of a Postgres driver the store uses. `pg`'s Pool satisfies it. */
export interface SqlClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  end(): Promise<void>;
}

function countUses(rows: readonly TemplateUsageRow[], filmId?: string): UsageCounts {
  const total = new Map<string, number>(), in_film = new Map<string, number>();
  for (const u of rows) {
    total.set(u.template_id, (total.get(u.template_id) ?? 0) + 1);
    if (filmId !== undefined && u.film_id === filmId) in_film.set(u.template_id, (in_film.get(u.template_id) ?? 0) + 1);
  }
  return { total, in_film };
}

const vec = (v: readonly number[]): string => `[${v.join(",")}]`;

export class PgDataStore implements DataStore {
  constructor(private readonly sql: SqlClient) {}
  async upsertCategory(c: CategoryRow) {
    await this.sql.query("INSERT INTO template_categories (id, name, parent_id, description) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET name=$2, parent_id=$3, description=$4", [c.id, c.name, c.parent_id, c.description]);
  }
  async listCategories() {
    const r = await this.sql.query("SELECT id, name, parent_id, description FROM template_categories ORDER BY id");
    return r.rows.map((x) => ({ id: String(x["id"]), name: String(x["name"]), parent_id: (x["parent_id"] as string | null) ?? null, description: String(x["description"] ?? "") }));
  }
  async addReview(r: ReviewRow) { await this.sql.query("INSERT INTO template_review (template_id, reviewer, verdict, notes) VALUES ($1,$2,$3,$4)", [r.template_id, r.reviewer, r.verdict, r.notes]); }
  async listReviews(templateId?: string) {
    const r = await this.sql.query("SELECT template_id, reviewer, verdict, notes FROM template_review WHERE ($1::text IS NULL OR template_id=$1) ORDER BY id", [templateId ?? null]);
    return r.rows.map((x) => ({ template_id: String(x["template_id"]), reviewer: String(x["reviewer"]), verdict: x["verdict"] as ReviewRow["verdict"], notes: String(x["notes"] ?? "") }));
  }
  async logTemplateUsage(u: TemplateUsageRow) { await this.sql.query("INSERT INTO template_usage (template_id, film_id, scene_id, outcome) VALUES ($1,$2,$3,$4::jsonb)", [u.template_id, u.film_id, u.scene_id, JSON.stringify(u.outcome ?? {})]); }
  async usage(filmId?: string): Promise<UsageCounts> {
    const r = await this.sql.query("SELECT template_id, film_id FROM template_usage");
    return countUses(r.rows.map((x) => ({ template_id: String(x["template_id"]), film_id: (x["film_id"] as string | null) ?? null, scene_id: null, outcome: null })), filmId);
  }
  async upsertTemplate(t: TemplateRow) {
    await this.sql.query(
      `INSERT INTO templates (id, category_id, title, family, variant_of, archetype, tags, status, body, content_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       ON CONFLICT (id) DO UPDATE SET category_id=$2, title=$3, family=$4, variant_of=$5, archetype=$6, tags=$7, status=$8, body=$9::jsonb, content_hash=$10, updated_at=now()`,
      [t.id, t.category_id, t.title, t.family, t.variant_of, t.archetype, t.tags, t.status, JSON.stringify(t.body), t.content_hash]);
  }
  async getTemplate(id: string) { const r = await this.sql.query("SELECT * FROM templates WHERE id=$1", [id]); return r.rows[0] ? toTemplate(r.rows[0]) : null; }
  async listTemplates(f: { family?: string; status?: TemplateRow["status"] } = {}) {
    const r = await this.sql.query("SELECT * FROM templates WHERE ($1::text IS NULL OR family=$1) AND ($2::text IS NULL OR status=$2) ORDER BY id", [f.family ?? null, f.status ?? null]);
    return r.rows.map(toTemplate);
  }
  async upsertEmbedding(e: EmbeddingRow) {
    await this.sql.query(
      `INSERT INTO template_embeddings (template_id, kind, model, model_version, vector) VALUES ($1,$2,$3,$4,$5::vector)
       ON CONFLICT (template_id, kind, model, model_version) DO UPDATE SET vector=$5::vector`, [e.template_id, e.kind, e.model, e.model_version, vec(e.vector)]);
  }
  async nearest(q: { kind: EmbeddingKind; model: string; model_version: string; vector: readonly number[]; k: number }) {
    const r = await this.sql.query(
      `SELECT template_id, 1 - (vector <=> $4::vector) AS score FROM template_embeddings WHERE kind=$1 AND model=$2 AND model_version=$3 ORDER BY vector <=> $4::vector, template_id LIMIT $5`,
      [q.kind, q.model, q.model_version, vec(q.vector), q.k]);
    return r.rows.map((x) => ({ template_id: String(x["template_id"]), score: Number(x["score"]) }));
  }
  async logModelCall(c: ModelCallRow) {
    await this.sql.query("INSERT INTO model_calls (film_id, provider, model, name, input_tokens, output_tokens, cost_usd, attempts, outcome, error_code, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [c.film_id, c.provider, c.model, c.name, c.input_tokens, c.output_tokens, c.cost_usd, c.attempts, c.outcome, c.error_code, c.duration_ms]);
  }
  async modelCalls(filmId?: string) {
    const r = await this.sql.query("SELECT film_id, provider, model, name, input_tokens, output_tokens, cost_usd, attempts, outcome, error_code, duration_ms FROM model_calls WHERE ($1::text IS NULL OR film_id=$1) ORDER BY id", [filmId ?? null]);
    return r.rows.map((x) => ({ ...(x as unknown as ModelCallRow), cost_usd: Number(x["cost_usd"]) }));
  }
  async logRetrieval(l: RetrievalLogRow) { await this.sql.query("INSERT INTO retrieval_log (film_id, query, collection, hits) VALUES ($1,$2,$3,$4::jsonb)", [l.film_id, l.query, l.collection, JSON.stringify(l.hits)]); }
  async health(): Promise<StoreHealth> {
    try {
      await this.sql.query("SELECT 1");
      const ext = await this.sql.query("SELECT 1 FROM pg_extension WHERE extname='vector'");
      const has = ext.rows.length > 0;
      return { ok: has, backend: "postgres", vector_extension: has, detail: has ? "connected; pgvector installed" : "connected, but the vector extension is missing (run the migrations)" };
    } catch (e) { return { ok: false, backend: "postgres", vector_extension: null, detail: `cannot connect: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` }; }
  }
  async close() { await this.sql.end(); }
}
const toTemplate = (r: Record<string, unknown>): TemplateRow => ({ id: String(r["id"]), category_id: (r["category_id"] as string | null) ?? null, title: String(r["title"]), family: (r["family"] as string | null) ?? null, variant_of: (r["variant_of"] as string | null) ?? null, archetype: (r["archetype"] as string | null) ?? null, tags: (r["tags"] as string[] | null) ?? [], status: r["status"] as TemplateRow["status"], body: r["body"], content_hash: String(r["content_hash"]) });

/**
 * Opens the real database. The `pg` driver is loaded only here and only when asked for, so nothing else needs it installed;
 * install it with `npm install pg --workspace @digikon/rag` before using DATABASE_URL.
 */
export async function connectPg(connectionString: string): Promise<PgDataStore> {
  const name = "pg";
  let mod: { default?: { Pool: new (o: { connectionString: string }) => SqlClient }; Pool?: new (o: { connectionString: string }) => SqlClient };
  try { mod = (await import(name)) as typeof mod; } catch { throw new Error("The `pg` package is not installed. Run: npm install pg --workspace @digikon/rag"); }
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (!Pool) throw new Error("The installed `pg` package has no Pool.");
  return new PgDataStore(new Pool({ connectionString }));
}

/** One dedicated connection (a `pg` Client, not a Pool), which migrations need because BEGIN/COMMIT must share a connection. */
export async function connectPgSingle(connectionString: string): Promise<SqlClient & { connect(): Promise<void> }> {
  const name = "pg";
  let mod: { default?: { Client: new (o: { connectionString: string }) => SqlClient & { connect(): Promise<void> } }; Client?: new (o: { connectionString: string }) => SqlClient & { connect(): Promise<void> } };
  try { mod = (await import(name)) as typeof mod; } catch { throw new Error("The `pg` package is not installed. Run: npm install pg --workspace @digikon/rag"); }
  const Client = mod.Client ?? mod.default?.Client;
  if (!Client) throw new Error("The installed `pg` package has no Client.");
  const c = new Client({ connectionString });
  await c.connect();
  return c;
}

/** DATABASE_URL set Ã¢â€ â€™ Postgres; otherwise the in-memory store. */
export async function openStore(env: Record<string, string | undefined> = process.env): Promise<DataStore> {
  const url = env["DATABASE_URL"];
  return url ? connectPg(url) : new MemoryDataStore();
}


