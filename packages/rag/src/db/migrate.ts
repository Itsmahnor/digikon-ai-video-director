import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlClient } from "./store.js";

export interface MigrationFile { name: string; sql: string; checksum: string }

/** The .sql files of a folder in name order. */
export function readMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort().map((name) => {
    const sql = readFileSync(join(dir, name), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex") };
  });
}

/**
 * Applies the migrations that have not run yet, each in its own transaction, and records them in schema_migrations. A migration that was applied and has
 * since been edited is an error, never silently skipped: add a new numbered file instead.
 */
export async function runMigrations(db: SqlClient, migrations: readonly MigrationFile[]): Promise<{ applied: string[]; skipped: string[] }> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Map((await db.query("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [String(r["name"]), String(r["checksum"])]));
  const applied: string[] = [], skipped: string[] = [];
  for (const m of migrations) {
    const prior = done.get(m.name);
    if (prior !== undefined) {
      if (prior !== m.checksum) throw new Error(`migration ${m.name} was changed after it was applied; add a new migration instead`);
      skipped.push(m.name); continue;
    }
    await db.query("BEGIN");
    try {
      await db.query(m.sql);
      await db.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)", [m.name, m.checksum]);
      await db.query("COMMIT");
    } catch (e) { await db.query("ROLLBACK"); throw new Error(`migration ${m.name} failed: ${e instanceof Error ? e.message : String(e)}`); }
    applied.push(m.name);
  }
  return { applied, skipped };
}
