// npm run templates -- <command>
//
// Library (templates/<category>/*.json, scene-graph v2 records):
//   build [--per-family N] [--only <family|category>] [--no-write] [--sheets]   author -> expand -> validate -> render -> dedupe -> write
//   validate [category]            validate every file at 16:9, 9:16 and 1:1; writes templates/_reports/validation.json; exit 1 on any failure
//   dedupe                         distinctness of the library (structure + CLIP look): near-duplicate pairs and why
//   stats                          per-category counts against the 100 target
//   review-queue [category] [--limit N]                  candidates beside nearest neighbours
//   review-queue approve|reject|changes <id> --reason "..." [--reviewer name]
//   ingest [--render]              seed the 18 categories and store templates + text and look embeddings (DATABASE_URL -> Postgres, else in-memory)
//   search "<text>" [--category c] [--aspect 9:16] [--status draft,reviewed] [--proven] [--k 8]
// Legacy draft records (format_version 1):  ingest <dir> | dedupe <dir> [--threshold 0.9]
//
// The look embedding uses the CLIP model in storage/models and the text embedding the local sentence model when present; nothing is downloaded.
import { resolve } from "node:path";
import { chooseEmbedder, dedupeReport, ingestTemplates, openStore, readTemplateFiles } from "@digikon/rag";
import { DEDUPE, MODELS_DIR, buildLibrary, candidateOf, decide, dedupe, ensureLooks, formatStats, ingestLibrary, libraryStats, loadLibrary, pruneLooks, readReviews, reviewQueue, searchTemplates, validateLibrary, writeContactSheets, writeValidationReport } from "@digikon/templates";

const args = process.argv.slice(2);
const cmd = args[0];
const FLAGS = ["render", "no-write", "sheets", "proven"];
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1]!.startsWith("--") && !FLAGS.includes(all[i - 1]!.slice(2))));
const log = (s: string) => console.log(s);

async function legacy(dir: string) {
  const threshold = Number(opt("threshold") ?? 0.9);
  const { embedder, real, note } = chooseEmbedder(resolve(import.meta.dirname, "..", "storage", "models"));
  console.log(`embedder: ${embedder.model}@${embedder.version} (${note})`);
  const store = await openStore();
  try {
    const files = readTemplateFiles(resolve(dir));
    const r = await ingestTemplates(store, embedder, files.flatMap((f) => (f.record ? [f.record] : [])), files.filter((f) => !f.record).map((f) => ({ file: f.file, problems: f.problems })));
    console.log(`ingest: ${r.added.length} added, ${r.updated.length} updated, ${r.unchanged.length} unchanged, ${r.rejected.length} rejected`);
    for (const x of r.rejected) console.log(`  rejected ${x.file}: ${x.problems.join("; ")}`);
    if (cmd === "dedupe") {
      const d = await dedupeReport(store, embedder, threshold);
      console.log(`dedupe: ${d.templates} templates, threshold ${d.threshold}, ${d.pairs.length} near-duplicate pair(s)${real ? "" : " (hash embedder: similarity reflects wording only)"}`);
      for (const p of d.pairs) console.log(`  ${p.similarity.toFixed(3)}  ${p.a}  ~  ${p.b}${p.same_family ? "  (same family)" : ""}`);
    }
    if (r.rejected.length) process.exitCode = 1;
  } finally { await store.close(); }
}

function formatBuild(counts: { category: string; families: number; generated: number; valid: number; distinct: number; skeletons: number }[]): string {
  const head = "category                 families  generated  valid(3 aspects)  distinct  skeletons  of 100";
  const rows = counts.map((c) => `${c.category.padEnd(24)} ${String(c.families).padStart(8)} ${String(c.generated).padStart(10)} ${String(c.valid).padStart(17)} ${String(c.distinct).padStart(9)} ${String(c.skeletons).padStart(10)}  ${String(c.distinct).padStart(5)}%`);
  const t = (k: "families" | "generated" | "valid" | "distinct" | "skeletons") => counts.reduce((s, c) => s + c[k], 0);
  return [head, ...rows, `${"TOTAL".padEnd(24)} ${String(t("families")).padStart(8)} ${String(t("generated")).padStart(10)} ${String(t("valid")).padStart(17)} ${String(t("distinct")).padStart(9)} ${String(t("skeletons")).padStart(10)}`].join("\n");
}

async function main() {
  if ((cmd === "ingest" || cmd === "dedupe") && positional[0]) return legacy(positional[0]);

  if (cmd === "build") {
    const r = await buildLibrary({ perFamily: Number(opt("per-family") ?? 12), only: opt("only"), write: !flag("no-write"), log });
    log("\n" + formatBuild(r.counts));
    log(`\nthresholds: struct >= ${DEDUPE.struct_dup} and look >= ${DEDUPE.look_dup}, or look >= ${DEDUPE.look_hard}`);
    for (const x of r.invalid.slice(0, 15)) log(`  invalid ${x.id}: ${x.issues.join(" | ")}`);
    if (flag("sheets") && !flag("no-write")) { log("\ncontact sheets:"); await writeContactSheets(r.accepted, { log }); }
    return;
  }

  if (cmd === "validate") {
    const v = validateLibrary(undefined, positional[0]);
    const ok = v.loaded.filter((l) => l.record).length - v.failed.length;
    if (!positional[0]) log(`report: ${writeValidationReport(v.results)}`);
    log(`${v.loaded.length} files, ${ok} valid at every declared aspect ratio, ${v.failed.length} invalid, ${v.unreadable.length} unreadable`);
    for (const u of v.unreadable) log(`  unreadable ${u.file}: ${u.problems.slice(0, 3).join("; ")}`);
    for (const f of v.failed.slice(0, 30)) log(`  invalid ${f.id}: ${f.issues.join(" | ")}`);
    if (v.failed.length || v.unreadable.length) process.exitCode = 1;
    return;
  }

  if (cmd === "stats") {
    const s = await libraryStats({ render: flag("render") });
    log(formatStats(s.rows));
    log(`\ndistinct = valid at all declared aspects, not rejected in review, and not a near-duplicate (struct >= ${s.thresholds.struct_dup} and look >= ${s.thresholds.look_dup}, or look >= ${s.thresholds.look_hard}) of one already counted`);
    log("skeletons = how many different structures the distinct templates use (palette, type and motion re-skins of one structure count once)");
    return;
  }

  if (cmd === "dedupe") {
    const recs = loadLibrary().flatMap((l) => (l.record ? [l.record] : []));
    const looks = await ensureLooks(recs, { render: true });
    const decisions = dedupe(recs.map((t) => candidateOf(t, looks.get(t.template_id)!)));
    const dups = decisions.filter((d) => !d.accepted);
    log(`${recs.length} templates, ${dups.length} near-duplicate(s) (struct >= ${DEDUPE.struct_dup} and look >= ${DEDUPE.look_dup}, or look >= ${DEDUPE.look_hard})`);
    for (const d of dups.slice(0, 40)) log(`  ${d.id}  ~  ${d.duplicate_of}  (struct ${d.nearest_struct}, look ${d.nearest_look})`);
    return;
  }

  if (cmd === "review-queue") {
    const verb = positional[0];
    if (verb === "approve" || verb === "reject" || verb === "changes") {
      const id = positional[1], reason = opt("reason");
      if (!id || !reason) { console.error('usage: review-queue approve|reject|changes <template-id> --reason "..." [--reviewer name]'); process.exit(2); }
      const e = decide(id, verb === "approve" ? "approved" : verb === "reject" ? "rejected" : "needs_changes", reason, opt("reviewer") ?? process.env["USERNAME"] ?? "reviewer");
      log(`${e.verdict}: ${e.template_id} by ${e.reviewer} - ${e.notes}`);
      return;
    }
    const q = await reviewQueue({ category: verb, limit: Number(opt("limit") ?? 12) });
    log(`${q.length} candidate(s) awaiting a decision (${readReviews().length} decisions recorded)`);
    for (const it of q) {
      log(`\n${it.template.template_id}  [${it.template.category}${it.template.variant_of ? `, variant of ${it.template.variant_of}` : ", base"}]  ${it.valid ? "valid at all aspects" : "INVALID"}`);
      log(`  ${it.template.title} - ${it.template.tags.motion_personality} motion, ${it.template.type_rules.pairing.name} type, ${it.template.palette_rules.reference_palette.name} palette`);
      for (const n of it.neighbours) log(`  nearest: ${n.id}  look ${n.look.toFixed(3)}  struct ${n.struct.toFixed(2)}`);
    }
    return;
  }

  if (cmd === "ingest") {
    const recs = loadLibrary().flatMap((l) => (l.record ? [l.record] : []));
    const { embedder, real, note } = chooseEmbedder(MODELS_DIR);
    log(`text embedder: ${embedder.model}@${embedder.version} (${note})`);
    const looks = await ensureLooks(recs, { render: flag("render") });
    const store = await openStore();
    try {
      const h = await store.health();
      log(`store: ${h.backend} - ${h.detail}`);
      const s = await ingestLibrary(store, embedder, recs, looks);
      log(`ingest: ${s.categories} categories; ${s.added} added, ${s.updated} updated, ${s.unchanged} unchanged; ${s.text_vectors} text and ${s.look_vectors} look vectors; ${s.reviews} reviews mirrored`);
      if (s.skipped_no_look.length) log(`  skipped (no look vector): ${s.skipped_no_look.length}`);
      if (!process.env["DATABASE_URL"]) log("  (no DATABASE_URL: the in-memory store is discarded when this command ends)");
      if (!real) log("  warning: the hash embedder was used for text; retrieval reflects wording only");
    } finally { await store.close(); }
    return;
  }

  if (cmd === "search") {
    const text = positional[0];
    if (!text) { console.error('usage: search "<text>" [--category c] [--aspect 9:16] [--status draft,reviewed] [--proven] [--k 8]'); process.exit(2); }
    const recs = loadLibrary().flatMap((l) => (l.record ? [l.record] : []));
    const { embedder } = chooseEmbedder(MODELS_DIR);
    const looks = await ensureLooks(recs, { render: false });
    const store = await openStore();
    try {
      await ingestLibrary(store, embedder, recs, looks);
      const hits = await searchTemplates(store, embedder, { text, category: opt("category") as never, aspect: opt("aspect") as never, status: (opt("status") ?? "draft,reviewed").split(",") as never, proven_only: flag("proven"), k: Number(opt("k") ?? 8) });
      for (const h of hits) log(`${h.score.toFixed(4)}  ${h.template_id}  [${h.category}/${h.status}]  ${h.why.join(", ")}`);
      if (!hits.length) log("no templates match");
    } finally { await store.close(); }
    return;
  }

  if (cmd === "prune-looks") { pruneLooks(new Set(loadLibrary().flatMap((l) => (l.record ? [l.record.template_id] : [])))); return; }

  console.error('usage: templates.mts build | validate [category] | dedupe | stats | review-queue [category|approve|reject <id> --reason ..] | ingest | search "<text>"   (legacy: ingest|dedupe <dir>)');
  process.exit(2);
}

await main();
