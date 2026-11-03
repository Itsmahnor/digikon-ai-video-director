import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LibraryTemplate, Palette, TEMPLATE_CATEGORIES, contrastRatio, type TemplateCategory, type TemplateValidation } from "@digikon/contracts";
import { canonicalJson } from "@digikon/rag";
import { ESTIMATE_METER, validateSceneGraph } from "@digikon/render";

/** Where the library lives: templates/<category>/<template_id>.json in the repository. Git is the source of truth; the database is built from it. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const LIBRARY_DIR = join(REPO_ROOT, "templates");
export const REPORT_DIR = join(LIBRARY_DIR, "_reports");
export const PREVIEW_DIR = join(REPO_ROOT, "docs", "templates");

/** The hash covers the design (everything except itself, the review status and the evidence list, which change as the template is reviewed). */
export function templateHash(t: LibraryTemplate): string {
  const { content_hash: _h, status: _s, evidence: _e, ...design } = t;
  void _h; void _s; void _e;
  return createHash("sha256").update(canonicalJson(design)).digest("hex").slice(0, 32);
}
export const withHash = (t: LibraryTemplate): LibraryTemplate => ({ ...t, content_hash: templateHash(t) });

export const categoryDir = (c: TemplateCategory, root = LIBRARY_DIR) => join(root, c);

export function writeTemplate(t: LibraryTemplate, root = LIBRARY_DIR): string {
  const dir = categoryDir(t.category, root);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${t.template_id}.json`);
  writeFileSync(file, JSON.stringify(withHash(t)) + "\n", "utf8");
  return file;
}

export interface LoadedTemplate { file: string; record: LibraryTemplate | null; problems: string[] }
/** Reads every template file under the library. A file that is not a valid record is reported, never silently dropped. */
export function loadLibrary(root = LIBRARY_DIR): LoadedTemplate[] {
  const out: LoadedTemplate[] = [];
  if (!existsSync(root)) return out;
  for (const c of readdirSync(root, { withFileTypes: true })) {
    if (!c.isDirectory() || c.name.startsWith("_")) continue;
    for (const f of readdirSync(join(root, c.name)).filter((x) => x.endsWith(".json")).sort()) {
      const file = join(root, c.name, f);
      try {
        const parsed = LibraryTemplate.safeParse(JSON.parse(readFileSync(file, "utf8")));
        const problems = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`);
        if (parsed.success && parsed.data.category !== c.name) problems.push(`category ${parsed.data.category} does not match its folder ${c.name}`);
        if (parsed.success && `${parsed.data.template_id}.json` !== f) problems.push(`file name ${f} does not match template_id ${parsed.data.template_id}`);
        out.push({ file, record: parsed.success && !problems.length ? parsed.data : null, problems });
      } catch (e) { out.push({ file, record: null, problems: [`not readable JSON: ${e instanceof Error ? e.message : String(e)}`] }); }
    }
  }
  return out;
}

// ---------------------------------------------------------------- validation
const ASPECT_OF = (w: number, h: number) => (w > h ? "16:9" : w < h ? "9:16" : "1:1");

/** Validates one template at every aspect ratio it declares: the contract, then the scene-graph validator on each graph with the reference palette. */
export function validateTemplate(t: LibraryTemplate): TemplateValidation[] {
  const results: TemplateValidation[] = [];
  const base: string[] = [];
  if (templateHash(t) !== t.content_hash) base.push(`content_hash ${t.content_hash} does not match the design (${templateHash(t)})`);
  const pal = Palette.safeParse(t.palette_rules.reference_palette);
  if (!pal.success) base.push(...pal.error.issues.map((i) => `reference palette: ${i.message}`));
  for (const s of t.needs.text_slots) if (s.example.length > s.max_chars) base.push(`slot ${s.name}: the example is ${s.example.length} characters, over max_chars ${s.max_chars}`);
  for (const aspect of t.needs.aspect_ratios) {
    const g = t.scene_graph[aspect];
    const issues = [...base];
    if (!g) { issues.push(`no graph for ${aspect}`); results.push({ template_id: t.template_id, content_hash: t.content_hash, aspect, ok: false, issues }); continue; }
    if (ASPECT_OF(g.canvas.width, g.canvas.height) !== aspect) issues.push(`the ${aspect} graph has a ${g.canvas.width}x${g.canvas.height} canvas`);
    if (pal.success) {
      const v = validateSceneGraph(g, { palette: pal.data, meter: ESTIMATE_METER });
      if (!v.ok) issues.push(...v.issues);
      const short = Math.min(g.canvas.width, g.canvas.height);
      for (const e of g.elements) if (e.kind === "text" && Number((e.props as { font_px: number }).font_px) < short * t.type_rules.min_px_short_edge_ratio * 0.7) issues.push(`${e.id}: text is under ${Math.round(short * t.type_rules.min_px_short_edge_ratio * 0.7)}px for this frame`);
      for (const r of ["muted", "accent"] as const) if (t.palette_rules.roles_used.includes(r) && contrastRatio(pal.data[r], pal.data.background) < t.palette_rules.min_text_contrast && g.elements.some((e) => e.kind === "text" && (e.props as { color?: string }).color === r)) issues.push(`${r} text on the background is below ${t.palette_rules.min_text_contrast}:1`);
    }
    results.push({ template_id: t.template_id, content_hash: t.content_hash, aspect, ok: issues.length === 0, issues });
  }
  return results;
}

export const isValidAtAll = (v: TemplateValidation[], aspects: readonly string[]): boolean => aspects.every((a) => v.find((x) => x.aspect === a)?.ok);

// ---------------------------------------------------------------- structural fingerprint
/**
 * A structural fingerprint is the set of design decisions that make two templates feel the same or different, independent of their colours: layout
 * cells, alignment, which animated properties each element uses, the stagger unit, the motion personality, the type pairing and font roles, the
 * palette roles in use (tokens, never hex values) and the backdrop. Similarity is the Jaccard overlap of the sets, 1 meaning identical structure.
 */
export function structuralFeatures(t: LibraryTemplate): Set<string> {
  const f = new Set<string>();
  f.add(`arch:${t.archetype}`); f.add(`family:${t.family}`);
  f.add(`motion:${t.tags.motion_personality}`); f.add(`pairing:${t.type_rules.pairing.name}`);
  for (const r of t.palette_rules.roles_used) f.add(`role:${r}`);
  const g = t.scene_graph["16:9"] ?? Object.values(t.scene_graph)[0]!;
  const W = g.canvas.width, H = g.canvas.height;
  for (const e of g.elements) {
    const p = e.props as Record<string, unknown>;
    const x = Number(p["x"] ?? 0), y = Number(p["y"] ?? 0), w = Number(p["w"] ?? 0), h = Number(p["h"] ?? 0);
    const cx = x + (p["align"] === "center" ? w / 2 : p["align"] === "right" ? w : 0) + (e.kind === "text" ? 0 : w / 2), cy = y + (e.kind === "text" ? 0 : h / 2);
    const cell = `${Math.min(2, Math.max(0, Math.floor((cx / W) * 3)))}${Math.min(2, Math.max(0, Math.floor((cy / H) * 3)))}`;
    const size = e.kind === "text" ? `px${Math.round(Math.log2(Math.max(8, Number(p["font_px"]) || 8)) * 2)}` : `s${Math.round(Math.log2(Math.max(8, Math.max(w, h))))}`;
    if (e.id.startsWith("bd_")) { f.add(`backdrop:${e.id.replace(/\d+$/, "")}`); continue; }
    f.add(`${e.kind}@${cell}`); f.add(`${e.kind}:${size}`);
    if (e.kind === "text") { f.add(`font:${String(p["font"] ?? "body")}`); f.add(`align:${String(p["align"])}`); f.add(`col:${String(p["color"])}`); }
    else { f.add(`fill:${String(p["fill"] ?? p["stroke"] ?? "")}`); if (e.kind === "shape") f.add(`shape:${String(p["shape"])}`); }
    if (e.stagger) f.add(`stagger:${e.stagger.unit}`);
    for (const tr of e.timeline.tracks) f.add(`anim:${e.kind}:${tr.property}`);
    f.add(`start:${Math.round(e.timeline.start_s * 2)}`);
  }
  if (g.camera) for (const tr of g.camera.timeline.tracks) f.add(`camera:${tr.property}:${tr.keyframes[tr.keyframes.length - 1]!.value > tr.keyframes[0]!.value ? "up" : "down"}`);
  return f;
}
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

export const CATEGORY_ORDER: readonly TemplateCategory[] = TEMPLATE_CATEGORIES;
