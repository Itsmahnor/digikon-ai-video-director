// npm run templates -- ingest <dir> | dedupe <dir> [--threshold 0.9]
// Reads digikon.template JSON files, stores them (DATABASE_URL -> Postgres, otherwise a throwaway in-memory store) and embeds them.
// Uses a local sentence model when one is on disk (storage/models); otherwise the hash embedder, and says so. It downloads nothing.
import { resolve } from "node:path";
import { chooseEmbedder, dedupeReport, ingestTemplates, openStore, readTemplateFiles } from "@digikon/rag";

const [cmd, dir] = [process.argv[2], process.argv[3]];
const ti = process.argv.indexOf("--threshold");
const threshold = ti >= 0 ? Number(process.argv[ti + 1]) : 0.9;
if (!cmd || !dir || !["ingest", "dedupe"].includes(cmd) || !Number.isFinite(threshold)) { console.error("usage: templates.mts ingest <dir> | dedupe <dir> [--threshold 0.9]"); process.exit(2); }

const { embedder, real, note } = chooseEmbedder(resolve(import.meta.dirname, "..", "storage", "models"));
console.log(`embedder: ${embedder.model}@${embedder.version} (${note})`);
const store = await openStore();
try {
  const files = readTemplateFiles(resolve(dir));
  const r = await ingestTemplates(store, embedder, files.flatMap((f) => (f.record ? [f.record] : [])), files.filter((f) => !f.record).map((f) => ({ file: f.file, problems: f.problems })));
  console.log(`ingest: ${r.added.length} added, ${r.updated.length} updated, ${r.unchanged.length} unchanged, ${r.rejected.length} rejected`);
  for (const x of r.rejected) console.log(`  rejected ${x.file}: ${x.problems.join("; ")}`);
  if (!process.env["DATABASE_URL"]) console.log("  (no DATABASE_URL: the in-memory store is discarded when this command ends)");
  if (cmd === "dedupe") {
    const d = await dedupeReport(store, embedder, threshold);
    console.log(`dedupe: ${d.templates} templates, threshold ${d.threshold}, ${d.pairs.length} near-duplicate pair(s)${real ? "" : " (hash embedder: similarity reflects wording only)"}`);
    for (const p of d.pairs) console.log(`  ${p.similarity.toFixed(3)}  ${p.a}  ~  ${p.b}${p.same_family ? "  (same family)" : ""}`);
    for (const n of d.nearest) console.log(`  nearest of ${n.id}: ${n.neighbour ?? "-"} (${n.similarity.toFixed(3)})`);
  }
  if (r.rejected.length) process.exitCode = 1;
} finally { await store.close(); }
