// npm run db:migrate | npm run db:health. Needs DATABASE_URL and the `pg` package (npm install pg --workspace @digikon/rag).
import { resolve } from "node:path";
import { connectPgSingle, PgDataStore, readMigrations, runMigrations } from "@digikon/rag";

const url = process.env["DATABASE_URL"];
const cmd = process.argv[2];
if (!url) { console.error("DATABASE_URL is not set (see .env.example). Nothing to do."); process.exit(2); }

const db = await connectPgSingle(url);
try {
  if (cmd === "migrate") {
    const r = await runMigrations(db, readMigrations(resolve(import.meta.dirname, "..", "db", "migrations")));
    console.log(`applied: ${r.applied.join(", ") || "none"}; already applied: ${r.skipped.join(", ") || "none"}`);
  }
  if (cmd === "migrate" || cmd === "health") {
    const h = await new PgDataStore(db).health();
    console.log(`${h.ok ? "OK" : "NOT OK"}: ${h.detail}`);
    process.exitCode = h.ok ? 0 : 1;
  } else { console.error("usage: db.mts migrate | health"); process.exitCode = 2; }
} finally { await db.end(); }
