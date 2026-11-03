import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_CATEGORIES, type LibraryTemplate, type TemplateCategory, type TemplateValidation } from "@digikon/contracts";
import { DEDUPE, candidateOf, compare, dedupe, type Decision, type Candidate } from "./dedupe.js";
import { candidateStyles } from "./expand.js";
import { ALL_FAMILIES } from "./families/index.js";
import { ASPECTS, styleOf, toTemplate, type FamilyDef } from "./kit.js";
import { LIBRARY_DIR, REPORT_DIR, PREVIEW_DIR, isValidAtAll, validateTemplate, withHash, writeTemplate } from "./library.js";
import { ensureLooks, loadLooks, saveLooks } from "./looks.js";
import { PreviewRenderer } from "./preview.js";
import { contactSheet } from "./sheets.js";

/**
 * Builds the library from the authored families: expand each family to candidate variants on its declared axes, validate every candidate at all three
 * aspect ratios, render a real preview of every valid one, embed the previews, and keep only the candidates that pass the distinctness rule. The
 * result is written as JSON files under templates/, with a report of every decision, so nothing is silently dropped.
 */

export interface CategoryCounts { category: TemplateCategory; families: number; generated: number; valid: number; distinct: number; skeletons: number }
export interface BuildResult { thresholds: typeof DEDUPE; per_family: number; counts: CategoryCounts[]; decisions: Decision[]; invalid: { id: string; issues: string[] }[]; accepted: LibraryTemplate[] }

export function candidatesOf(fams: readonly FamilyDef[], perFamily: number): LibraryTemplate[] {
  const out: LibraryTemplate[] = [];
  for (const fam of fams) {
    const base = styleOf(fam);
    out.push(withHash(toTemplate(fam, base, base)));
    for (const s of candidateStyles(fam, perFamily)) out.push(withHash(toTemplate(fam, s, base)));
  }
  const ids = new Set<string>();
  for (const t of out) { if (ids.has(t.template_id)) throw new Error(`two candidates share the id ${t.template_id}`); ids.add(t.template_id); }
  return out;
}

/** Groups accepted templates into skeletons: a template joins a group when its structure matches the group's first member at the struct threshold. */
export function countSkeletons(cs: readonly Candidate[]): number {
  const reps: Candidate[] = [];
  for (const c of [...cs].sort((a, b) => Number(!!a.t.variant_of) - Number(!!b.t.variant_of) || a.t.template_id.localeCompare(b.t.template_id))) if (!reps.some((r) => compare(c, r).struct >= DEDUPE.struct_dup)) reps.push(c);
  return reps.length;
}

export interface BuildOptions { perFamily: number; only?: string; write: boolean; log?: (s: string) => void; fams?: readonly FamilyDef[] }

export async function buildLibrary(o: BuildOptions): Promise<BuildResult> {
  const log = o.log ?? (() => undefined);
  const fams = (o.fams ?? ALL_FAMILIES).filter((f) => !o.only || f.id === o.only || f.category === o.only);
  const cands = candidatesOf(fams, o.perFamily);
  log(`${fams.length} families, ${cands.length} candidates`);
  const valids = new Map<string, TemplateValidation[]>(), invalid: BuildResult["invalid"] = [];
  for (const t of cands) {
    const v = validateTemplate(t);
    valids.set(t.template_id, v);
    if (!isValidAtAll(v, t.needs.aspect_ratios)) invalid.push({ id: t.template_id, issues: [...new Set(v.flatMap((x) => x.issues))].slice(0, 6) });
  }
  const bad = new Set(invalid.map((x) => x.id));
  const valid = cands.filter((t) => !bad.has(t.template_id));
  log(`${valid.length} valid at ${ASPECTS.join(", ")}; ${invalid.length} failed validation`);
  const baseFail = invalid.filter((x) => !cands.find((t) => t.template_id === x.id)!.variant_of);
  if (baseFail.length) log(`  ${baseFail.length} BASE families failed: ${baseFail.map((x) => x.id).join(", ")}`);

  const looks = await ensureLooks(valid, { render: true, save: false, log });
  const cs = valid.map((t) => candidateOf(t, looks.get(t.template_id)!));
  const decisions = dedupe(cs);
  const keep = new Set(decisions.filter((d) => d.accepted).map((d) => d.id));
  const accepted = valid.filter((t) => keep.has(t.template_id));
  const csById = new Map(cs.map((c) => [c.t.template_id, c]));

  const counts: CategoryCounts[] = TEMPLATE_CATEGORIES.map((category) => {
    const inCat = cands.filter((t) => t.category === category), acc = accepted.filter((t) => t.category === category);
    return { category, families: fams.filter((f) => f.category === category).length, generated: inCat.length, valid: inCat.filter((t) => !bad.has(t.template_id)).length, distinct: acc.length, skeletons: countSkeletons(acc.map((t) => csById.get(t.template_id)!)) };
  });
  const result: BuildResult = { thresholds: DEDUPE, per_family: o.perFamily, counts, decisions, invalid, accepted };
  if (!o.write) return result;

  // ---- write the library: accepted templates only, with evidence pointing at the reports and the preview
  mkdirSync(LIBRARY_DIR, { recursive: true });
  for (const c of TEMPLATE_CATEGORIES) { const d = join(LIBRARY_DIR, c); if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith(".json") && !keep.has(f.slice(0, -5))) rmSync(join(d, f)); }
  for (const t of accepted) {
    const base = !t.variant_of;
    writeTemplate({ ...t, evidence: [{ kind: "validation", ref: `templates/_reports/validation.json#${t.template_id}` }, ...(base ? [{ kind: "render_preview" as const, ref: `docs/templates/${t.category}.png`, note: "real Remotion render of the 16:9 frame at 88% of the scene" }] : [])] });
  }
  const loads = loadLooks();
  loads.vectors = Object.fromEntries(accepted.map((t) => [t.template_id, { hash: t.content_hash, v: looks.get(t.template_id)!.map((x) => Math.round(x * 1e4) / 1e4) }]));
  saveLooks(loads);
  mkdirSync(REPORT_DIR, { recursive: true });
  const validation = accepted.flatMap((t) => valids.get(t.template_id)!);
  writeFileSync(join(REPORT_DIR, "validation.json"), JSON.stringify({ generated_by: "templates build", results: validation }) + "\n");
  writeFileSync(join(REPORT_DIR, "build.json"), JSON.stringify({ thresholds: DEDUPE, per_family: o.perFamily, counts, invalid, decisions }, null, 1) + "\n");
  return result;
}

/** One contact sheet per category: the 16:9 preview of each family's base template (and the accepted variants, up to `variants` per family). */
export async function writeContactSheets(accepted: readonly LibraryTemplate[], o: { variants?: number; log?: (s: string) => void } = {}): Promise<string[]> {
  const r = new PreviewRenderer(), files: string[] = [];
  await r.open();
  try {
    mkdirSync(PREVIEW_DIR, { recursive: true });
    for (const cat of TEMPLATE_CATEGORIES) {
      const inCat = accepted.filter((t) => t.category === cat);
      if (!inCat.length) continue;
      const perFam = new Map<string, number>();
      const items: { id: string; png: Uint8Array; note?: string }[] = [];
      for (const t of inCat) {
        const n = perFam.get(t.family) ?? 0;
        if (n > (o.variants ?? 3)) continue;
        perFam.set(t.family, n + 1);
        items.push({ id: t.template_id, png: await r.still({ template: t, aspect: "16:9", scale: 0.5 }), note: t.variant_of ? `variant of ${t.family}` : "base family" });
      }
      const file = join(PREVIEW_DIR, `${cat}.png`);
      writeFileSync(file, await contactSheet(items, { cols: 4, tileW: 400, tileH: 225 }));
      files.push(file); o.log?.(`  ${cat}: ${items.length} previews`);
    }
  } finally { await r.close(); }
  return files;
}
