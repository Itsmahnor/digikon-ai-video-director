// npm run skills -- import <folder> [--dry-run]
// Imports skills from a folder or a local clone of a repo: licence gate -> normalise -> near-duplicate removal -> embed -> store.
// DATABASE_URL set -> Postgres, otherwise an in-memory store (a dry check only). Nothing is downloaded.
import { resolve } from "node:path";
import { chooseEmbedder, importSkills, openStore } from "@digikon/rag";

const args = process.argv.slice(2);
if (args[0] !== "import" || !args[1]) { console.error("usage: skills import <folder> [--dry-run]"); process.exit(2); }

const store = await openStore();
const { embedder, note } = chooseEmbedder(resolve(import.meta.dirname, "..", "storage", "models"));
try {
  const r = await importSkills(store, embedder, resolve(args[1]), { dryRun: args.includes("--dry-run") });
  console.log(`embedder: ${note}`);
  console.log(`licence: ${r.licence ? `${r.licence.ok ? "OK" : "REFUSED"} (${r.licence.licence ?? "unknown"}) - ${r.licence.reason}` : "not checked"}`);
  console.log(`added ${r.added.length}, updated ${r.updated.length}, unchanged ${r.unchanged.length}, near-duplicates dropped ${r.duplicates.length}, rejected ${r.rejected.length}`);
  for (const d of r.duplicates) console.log(`  duplicate: ${d.id} ~ ${d.of} (${d.similarity})`);
  for (const x of r.rejected) console.log(`  rejected: ${x.file}: ${x.problems.join("; ")}`);
  process.exitCode = r.licence?.ok === false ? 1 : 0;
} finally { await store.close(); }
