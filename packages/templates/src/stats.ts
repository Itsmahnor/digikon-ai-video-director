import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CATEGORY_TARGET, TEMPLATE_CATEGORIES, type LibraryTemplate, type TemplateCategory, type TemplateValidation } from "@digikon/contracts";
import { DEDUPE, candidateOf, dedupe } from "./dedupe.js";
import { countSkeletons } from "./build.js";
import { REPORT_DIR, isValidAtAll, loadLibrary, validateTemplate, type LoadedTemplate } from "./library.js";
import { ensureLooks } from "./looks.js";
import { readReviews, rejectedIds } from "./review.js";

/** Validates every template file and writes templates/_reports/validation.json. */
export function validateLibrary(root?: string, only?: string): { loaded: LoadedTemplate[]; results: TemplateValidation[]; failed: { id: string; issues: string[] }[]; unreadable: LoadedTemplate[] } {
  const loaded = loadLibrary(root).filter((l) => !only || l.file.includes(`${only}`) || l.record?.category === only);
  const results: TemplateValidation[] = [], failed: { id: string; issues: string[] }[] = [];
  for (const l of loaded) {
    if (!l.record) continue;
    const v = validateTemplate(l.record);
    results.push(...v);
    if (!isValidAtAll(v, l.record.needs.aspect_ratios)) failed.push({ id: l.record.template_id, issues: [...new Set(v.flatMap((x) => x.issues))].slice(0, 8) });
  }
  return { loaded, results, failed, unreadable: loaded.filter((l) => !l.record) };
}

export function writeValidationReport(results: TemplateValidation[], dir = REPORT_DIR): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "validation.json");
  writeFileSync(file, JSON.stringify({ generated_by: "templates validate", results }) + "\n");
  return file;
}

export interface StatsRow { category: TemplateCategory; files: number; families: number; variants: number; valid: number; rejected: number; distinct: number; skeletons: number; target: number }

/**
 * Per-category counts against the target. `valid` is valid at every declared aspect ratio; `distinct` is valid, not rejected in review, and not a
 * near-duplicate of another counted template under the thresholds in dedupe.ts. `skeletons` is how many different structures those distinct ones use.
 */
export async function libraryStats(o: { root?: string; render?: boolean; looksFile?: string; reviewRoot?: string } = {}): Promise<{ rows: StatsRow[]; thresholds: typeof DEDUPE }> {
  const loaded = loadLibrary(o.root), recs = loaded.flatMap((l) => (l.record ? [l.record] : []));
  const okIds = new Set<string>(), rej = rejectedIds(readReviews(o.reviewRoot ?? o.root));
  for (const t of recs) if (isValidAtAll(validateTemplate(t), t.needs.aspect_ratios)) okIds.add(t.template_id);
  const pool = recs.filter((t) => okIds.has(t.template_id) && !rej.has(t.template_id));
  const looks = await ensureLooks(pool, { render: o.render ?? false, file: o.looksFile });
  const cands = pool.map((t) => candidateOf(t, looks.get(t.template_id)!));
  const keep = new Set(dedupe(cands).filter((d) => d.accepted).map((d) => d.id));
  const byId = new Map(cands.map((c) => [c.t.template_id, c]));
  const rows = TEMPLATE_CATEGORIES.map((category) => {
    const inCat = recs.filter((t) => t.category === category), distinct = pool.filter((t) => t.category === category && keep.has(t.template_id));
    return { category, files: inCat.length, families: new Set(inCat.map((t) => t.family)).size, variants: inCat.filter((t) => t.variant_of).length, valid: inCat.filter((t) => okIds.has(t.template_id)).length, rejected: inCat.filter((t) => rej.has(t.template_id)).length, distinct: distinct.length, skeletons: countSkeletons(distinct.map((t) => byId.get(t.template_id)!)), target: CATEGORY_TARGET };
  });
  return { rows, thresholds: DEDUPE };
}

export function formatStats(rows: readonly StatsRow[]): string {
  const head = "category                 files  fam  var  valid  rej  distinct  skeletons  target   %";
  const lines = rows.map((r) => `${r.category.padEnd(24)} ${String(r.files).padStart(5)} ${String(r.families).padStart(4)} ${String(r.variants).padStart(4)} ${String(r.valid).padStart(6)} ${String(r.rejected).padStart(4)} ${String(r.distinct).padStart(9)} ${String(r.skeletons).padStart(10)} ${String(r.target).padStart(7)} ${String(Math.round((r.distinct / r.target) * 100)).padStart(3)}%`);
  const sum = (k: keyof StatsRow) => rows.reduce((s, r) => s + (r[k] as number), 0);
  lines.push("-".repeat(head.length), `${"TOTAL".padEnd(24)} ${String(sum("files")).padStart(5)} ${String(sum("families")).padStart(4)} ${String(sum("variants")).padStart(4)} ${String(sum("valid")).padStart(6)} ${String(sum("rejected")).padStart(4)} ${String(sum("distinct")).padStart(9)} ${String(sum("skeletons")).padStart(10)} ${String(sum("target")).padStart(7)} ${String(Math.round((sum("distinct") / sum("target")) * 100)).padStart(3)}%`);
  return [head, "-".repeat(head.length), ...lines].join("\n");
}
export type { LibraryTemplate };
