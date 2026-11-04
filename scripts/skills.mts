// npm run skills -- import <folder> [--dry-run]
// <folder> is either one source (it has skills-source.json) or a parent whose subfolders are sources.
// Imports skills: licence gate -> normalise -> near-duplicate removal -> embed -> store.
// DATABASE_URL set -> Postgres, otherwise an in-memory store (a dry check only). Nothing is downloaded.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chooseEmbedder, importSkills, openStore } from "@digikon/rag";

const args = process.argv.slice(2);
if (args[0] !== "import" || !args[1]) { console.error("usage: skills import <folder> [--dry-run]"); process.exit(2); }

const root = resolve(args[1]);
const sources = existsSync(join(root, "skills-source.json")) ? [root] : readdirSync(root).map((n) => join(root, n)).filter((p) => statSync(p).isDirectory() && existsSync(join(p, "skills-source.json")) || statSync(p).isDirectory() && existsSync(join(p, "skills")));
const store = await openStore();
const { embedder, note } = chooseEmbedder(resolve(import.meta.dirname, "..", "storage", "models"));
console.log(`embedder: ${note}`);
let refused = 0;
const totals = { added: 0, updated: 0, unchanged: 0, duplicates: 0, rejected: 0 };
try {
  for (const dir of sources) {
    const r = await importSkills(store, embedder, dir, { dryRun: args.includes("--dry-run") });
    console.log(`\n${dir.slice(root.length + 1) || dir}`);
    console.log(`  licence: ${r.licence ? `${r.licence.ok ? "OK" : "REFUSED"} (${r.licence.licence ?? "unknown"}) - ${r.licence.reason}` : "not checked"}`);
    console.log(`  added ${r.added.length}, updated ${r.updated.length}, unchanged ${r.unchanged.length}, near-duplicates dropped ${r.duplicates.length}, rejected ${r.rejected.length}`);
    for (const d of r.duplicates) console.log(`    duplicate: ${d.id} ~ ${d.of} (${d.similarity})`);
    for (const x of r.rejected) console.log(`    rejected: ${x.file}: ${x.problems.join("; ")}`);
    if (r.licence?.ok === false) refused++;
    totals.added += r.added.length; totals.updated += r.updated.length; totals.unchanged += r.unchanged.length; totals.duplicates += r.duplicates.length; totals.rejected += r.rejected.length;
  }
  console.log(`\nTOTAL: added ${totals.added}, updated ${totals.updated}, unchanged ${totals.unchanged}, near-duplicates dropped ${totals.duplicates}, rejected ${totals.rejected}, sources refused ${refused}`);
  if (!args.includes("--dry-run")) {
    const by = new Map<string, number>();
    for (const s of await store.listSkills()) by.set(s.category, (by.get(s.category) ?? 0) + 1);
    console.log(`stored per category: ${[...by].sort().map(([c, n]) => `${c}=${n}`).join(", ") || "none"}`);
  }
  process.exitCode = refused > 0 ? 1 : 0;
} finally { await store.close(); }
