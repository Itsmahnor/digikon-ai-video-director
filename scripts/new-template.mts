// npm run new-template -- <category> <template-id> "<Title>" ["<description>"] [--no-ingest]
//
// Scaffolds a template: writes templates/<category>/<id>.json (a valid draft starter record at 16:9, 9:16 and 1:1), validates it at all three,
// renders a real preview frame to docs/templates/<category>/<id>.png, embeds the retrieval text and the preview, stores the look vector and, unless
// --no-ingest, ingests it into the store (DATABASE_URL -> Postgres, else a throwaway in-memory store). Edit the file, then run `npm run templates -- validate`.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chooseEmbedder, openStore } from "@digikon/rag";
import { MODELS_DIR, PREVIEW_DIR, PreviewRenderer, categoryDir, ensureLooks, ingestLibrary, isValidAtAll, scaffoldTemplate, validateTemplate, withHash, writeTemplate } from "@digikon/templates";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [category, id, title, description] = args;
if (!category || !id || !title) { console.error('usage: new-template <category> <template-id> "<Title>" ["<description>"] [--no-ingest]'); process.exit(2); }
const t = withHash(scaffoldTemplate(id, category, title, description));
if (existsSync(join(categoryDir(t.category), `${id}.json`))) { console.error(`templates/${category}/${id}.json already exists; nothing was changed`); process.exit(1); }

const v = validateTemplate(t);
if (!isValidAtAll(v, t.needs.aspect_ratios)) { console.error("the starter is not valid (this is a bug in the scaffold):", v.flatMap((x) => x.issues).join("; ")); process.exit(1); }
const file = writeTemplate(t);
console.log(`record:   ${file}`);
console.log(`validate: valid at ${t.needs.aspect_ratios.join(", ")}`);

const r = new PreviewRenderer();
await r.open();
try {
  const dir = join(PREVIEW_DIR, t.category);
  mkdirSync(dir, { recursive: true });
  const png = join(dir, `${id}.png`);
  writeFileSync(png, await r.still({ template: t, aspect: "16:9", scale: 0.5 }));
  console.log(`preview:  ${png}`);
} finally { await r.close(); }

const looks = await ensureLooks([t], { render: true });
console.log(`look:     ${looks.get(id)!.length}-dimension CLIP vector stored in templates/_reports/look-vectors.json`);
const { embedder, note } = chooseEmbedder(MODELS_DIR);
console.log(`text:     ${embedder.model}@${embedder.version} (${note})`);
if (!process.argv.includes("--no-ingest")) {
  const store = await openStore();
  try { const s = await ingestLibrary(store, embedder, [t], looks); console.log(`ingest:   ${s.added} added, ${s.text_vectors} text and ${s.look_vectors} look vectors${process.env["DATABASE_URL"] ? "" : " (in-memory store, discarded)"}`); } finally { await store.close(); }
}
