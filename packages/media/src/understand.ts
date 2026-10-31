import { ContentRecord, CATEGORY_LABELS, type Asset, type AssetManifestEntry, type AssetNotes, type ImageMeasure, type RegistryAsset } from "@digikon/contracts";
import type { AssetRegistry } from "./asset-registry.js";
import { deriveFiles, inspectImage } from "./inspect.js";
import type { OcrEngine } from "./ocr.js";
import { CONFIDENT, analyseImage, type VisionModel } from "./vision.js";

export interface UnderstandDeps { registry: AssetRegistry; vision: VisionModel | null; ocr: readonly OcrEngine[] }

const inFlight = new Map<string, Promise<ContentRecord>>();

/**
 * Analyses one file's bytes unless that has already been done: a picture reused in another project keeps its analysis. Anything that failed and can be
 * retried runs again; a file that cannot be decoded is recorded as such, and the upload is kept. The original is never written to.
 */
export function analyseContent(deps: UnderstandDeps, content_id: string, path: string, measure: ImageMeasure | null, opts: { force?: boolean } = {}): Promise<ContentRecord> {
  const running = inFlight.get(content_id);
  if (running) return running;
  const job = (async () => {
    const rec = deps.registry.ensureContent(content_id);
    if (!opts.force && (rec.analysis.status === "analyzed" || rec.analysis.status === "unsupported" || (rec.analysis.status === "partial" && !rec.analysis.retryable))) return rec;
    deps.registry.saveContent({ ...rec, analysis: { ...rec.analysis, status: "running", error: null } });
    const now = new Date().toISOString();
    const inspected = await inspectImage(path);
    if (!inspected.ok) {
      const next: ContentRecord = { ...rec, analysis: { ...rec.analysis, status: inspected.code === "unsupported_format" || inspected.code === "corrupt" ? "unsupported" : "failed", analysed_at: now, error: inspected.message, retryable: inspected.retryable, evidence: [] } };
      deps.registry.saveContent(next);
      return deps.registry.content(content_id)!;
    }
    const { technical, facts } = inspected;
    const derived = await deriveFiles(path, technical, deps.registry.contentDir(content_id));
    const analysis = await analyseImage({ technical, facts, viewPath: derived.trimmed_path ?? derived.normalized_path ?? path, describePath: derived.normalized_path ?? path, photographic: measure?.kind === "photographic", vision: deps.vision, ocr: deps.ocr });
    deps.registry.saveContent({ ...rec, technical, analysis, ...derived });
    return deps.registry.content(content_id)!;
  })();
  inFlight.set(content_id, job);
  void job.finally(() => inFlight.delete(content_id));
  return job;
}

/** What the Director is told about one picture. It says plainly what is not known, and it carries no file paths. */
export function manifestEntry(a: RegistryAsset): AssetManifestEntry {
  const an = a.content.analysis, v = an.visual, t = a.content.technical;
  const caveats: string[] = [];
  const top = a.effective_categories[0];
  if (an.status === "failed" || an.status === "unsupported") caveats.push(`Analysis ${an.status}: ${an.error ?? "no detail"}. Do not assume what this picture shows.`);
  if (an.status === "partial") caveats.push("Analysis is partial: part of it did not run, so treat what is here as incomplete.");
  if (!a.user.category && (!top || top.category === "other_unknown" || top.confidence < CONFIDENT)) caveats.push("The classifier is not confident. Do not rely on this picture for a specific role unless the brief says what it is.");
  if (a.availability !== "available") caveats.push(`The file is ${a.availability.replaceAll("_", " ")}; it cannot be rendered.`);
  return {
    asset_id: a.asset_id, original_filename: a.original_filename, width: t?.width ?? null, height: t?.height ?? null, analysis_status: an.status,
    categories: a.effective_categories, description: a.effective_description, purpose: v?.purpose ?? null, visible_text: v?.ocr.text ?? "", subjects: v?.subjects ?? [],
    dominant_colours: (v?.dominant_colours ?? []).slice(0, 3).map((c) => c.hex), transparent: (t?.transparent_share ?? 0) > 0.01, background: v?.background.kind ?? null, suitable_roles: v?.suitable_roles ?? [],
    usage: a.user.usage, user_description: a.user.description, caveats,
  };
}

/** The notes of an analysed picture. Only what was established goes in; the measured note stays as it was when analysis failed. */
export function notesWithAnalysis(n: AssetNotes, a: RegistryAsset): AssetNotes {
  const m = manifestEntry(a);
  const label = m.categories.filter((c) => c.category !== "other_unknown").map((c) => CATEGORY_LABELS[c.category]).join(", ");
  const known = !!a.effective_description || !!label;
  return {
    ...n, image_manifest: m,
    content_summary: known ? [label, a.effective_description].filter(Boolean).join(": ") : n.content_summary,
    uncertain: known ? [...n.uncertain.filter((u) => !/Nobody has reviewed/.test(u)), ...m.caveats] : [...n.uncertain, ...m.caveats],
  };
}

/** Records one picture in the registry for its project, and analyses it if it has not been. */
export async function understandAsset(deps: UnderstandDeps, ids: { session_id: string; project_id: string }, asset: Asset, measure: ImageMeasure | null): Promise<RegistryAsset | null> {
  const sha = asset.metadata?.["sha256"];
  if (typeof sha !== "string") return null;
  deps.registry.link({ asset_id: asset.asset_id, content_id: sha, project_id: ids.project_id, session_id: ids.session_id, original_filename: String(asset.metadata?.["original_name"] ?? asset.asset_id), original_path: asset.uri });
  await analyseContent(deps, sha, asset.uri, measure);
  return deps.registry.resolve(ids.session_id, asset.asset_id);
}
