import { z } from "zod";
import { HexColor } from "./visual.js";

/**
 * What the product knows about an uploaded picture, and how a scene uses one. Measured facts, what a local vision model said (with its
 * confidence) and what the user said are kept apart: a user's word always wins, a failed analysis says it failed, and nothing is inferred
 * from a filename. Every field added to Scene or AssetNotes here is optional with no default, so approved plans hash exactly as they did.
 */

export const IMAGE_CATEGORIES = [
  "brand_logo", "company_logo", "product_photo", "person_or_team_photo", "website_screenshot", "app_screenshot", "dashboard_ui",
  "icon_symbol", "illustration", "background_texture", "marketing_graphic", "document_infographic", "other_unknown",
] as const;
export const ImageCategory = z.enum(IMAGE_CATEGORIES);
export type ImageCategory = z.infer<typeof ImageCategory>;

export const CATEGORY_LABELS: Record<ImageCategory, string> = {
  brand_logo: "Brand logo", company_logo: "Company logo", product_photo: "Product photograph", person_or_team_photo: "Person or team photograph",
  website_screenshot: "Website screenshot", app_screenshot: "Application screenshot", dashboard_ui: "Dashboard or software UI", icon_symbol: "Icon or symbol",
  illustration: "Illustration", background_texture: "Background or texture", marketing_graphic: "Marketing graphic", document_infographic: "Document or infographic", other_unknown: "Other / unknown",
};

export const ANALYSIS_STATES = ["pending", "running", "analyzed", "partial", "failed", "unsupported"] as const;
export const AnalysisStatus = z.enum(ANALYSIS_STATES);
export type AnalysisStatus = z.infer<typeof AnalysisStatus>;

const Share = z.number().min(0).max(1);
/** A rectangle as shares of the image, 0 to 1. */
export const NormBox = z.object({ x: Share, y: Share, w: Share.positive(), h: Share.positive() });
export type NormBox = z.infer<typeof NormBox>;

/** Read from the file by FFprobe, FFmpeg and the image library. Never evidence of what a picture shows. */
export const ImageTechnical = z.object({
  format: z.string().min(1),
  mime: z.string().min(1),
  /** The MIME type the file's own bytes prove, and whether the extension agreed with it. */
  extension_matches: z.boolean(),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aspect_ratio: z.number().positive(),
  color_space: z.string().nullable(),
  pixel_format: z.string().nullable(),
  decodes: z.boolean(),
  has_alpha_channel: z.boolean(),
  /** Share of pixels that are mostly see-through. Zero when an alpha channel exists but is unused. */
  transparent_share: Share,
  /** Where the picture's content is once transparent or flat surrounding padding is ignored. */
  content_box: NormBox,
  animated: z.boolean().default(false),
});
export type ImageTechnical = z.infer<typeof ImageTechnical>;

export const ImageVisual = z.object({
  /** What is depicted, from a vision model. Null when no model produced one: it is never made up. */
  description: z.string().max(800).nullable(),
  /** The image's likely purpose, derived from its category. */
  purpose: z.string().max(240).nullable(),
  subjects: z.array(z.string().min(1).max(80)).max(20),
  ocr: z.object({ status: z.enum(["read", "no_text", "unavailable", "failed"]), engine: z.string().nullable(), text: z.string().max(4000), lines: z.array(z.string().max(300)).max(60) }),
  dominant_colours: z.array(z.object({ hex: HexColor, share: Share })).max(6),
  background: z.object({ kind: z.enum(["transparent", "flat_light", "flat_dark", "flat_colour", "gradient", "busy"]), colour: HexColor.nullable() }),
  composition: z.object({ subject_position: z.enum(["center", "left", "right", "top", "bottom", "full_frame"]), fill_share: Share }),
  /** Roles this picture could fill, derived from its category, shape and text. */
  suitable_roles: z.array(z.string().min(1).max(40)).max(12),
});
export type ImageVisual = z.infer<typeof ImageVisual>;

export const ImageAnalysis = z.object({
  status: AnalysisStatus,
  analysed_at: z.string().datetime().nullable(),
  /** Which models and which version of this pipeline made it. Null for a part that did not run. */
  model: z.object({ classifier: z.string().nullable(), describer: z.string().nullable(), ocr: z.string().nullable(), pipeline_version: z.string().min(1) }),
  /** Best first. Several may apply. other_unknown when nothing was confident. */
  categories: z.array(z.object({ category: ImageCategory, confidence: Share })).max(13),
  visual: ImageVisual.nullable(),
  /** Why the labels were given: model scores and measured facts, in plain words. */
  evidence: z.array(z.string().max(300)).max(24),
  error: z.string().max(400).nullable(),
  retryable: z.boolean(),
});
export type ImageAnalysis = z.infer<typeof ImageAnalysis>;

export const ASSET_USAGE = ["auto", "must_use", "optional", "reference_only", "do_not_use"] as const;
export const AssetUsage = z.enum(ASSET_USAGE);
export type AssetUsage = z.infer<typeof AssetUsage>;

/** What the user said about one picture in one project. It takes precedence over any automated result and never crosses into another project. */
export const AssetUserInput = z.object({
  description: z.string().trim().max(500).nullable().default(null),
  category: ImageCategory.nullable().default(null),
  usage: AssetUsage.default("auto"),
  updated_at: z.string().datetime().nullable().default(null),
});
export type AssetUserInput = z.infer<typeof AssetUserInput>;

/** Identity and analysis of the file's bytes. The same bytes share one of these across projects, so a picture is analysed once. */
export const ContentRecord = z.object({
  content_id: z.string().regex(/^[a-f0-9]{64}$/),
  technical: ImageTechnical.nullable(),
  analysis: ImageAnalysis,
  thumbnail_path: z.string().nullable(),
  /** A copy the renderers can load, when the original cannot be used as it is. Null means the original is used. */
  normalized_path: z.string().nullable(),
  /** The content without its surrounding padding, for logos. Null when there is no padding to remove. */
  trimmed_path: z.string().nullable(),
  normalize_reason: z.string().nullable(),
  /** Pixel size of each derived copy, so layout never has to guess. */
  normalized_size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable().default(null),
  trimmed_size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type ContentRecord = z.infer<typeof ContentRecord>;

/** One project's use of one picture. Deleted or moved files are caught by `availability`, never assumed. */
export const ProjectAssetLink = z.object({
  asset_id: z.string().min(1),
  content_id: z.string().regex(/^[a-f0-9]{64}$/),
  project_id: z.string().min(1),
  session_id: z.string().min(1),
  original_filename: z.string().min(1),
  original_path: z.string().min(1),
  uploaded_at: z.string().datetime(),
  user: AssetUserInput,
});
export type ProjectAssetLink = z.infer<typeof ProjectAssetLink>;

export const AssetAvailabilityStatus = z.enum(["available", "missing_file", "changed_on_disk"]);

/** The registry's view of a project's picture: link and content together, with the user's word applied. */
export interface RegistryAsset extends ProjectAssetLink {
  content: ContentRecord;
  availability: z.infer<typeof AssetAvailabilityStatus>;
  effective_categories: { category: ImageCategory; confidence: number; source: "user" | "vision" }[];
  effective_description: string | null;
}

/** The user's word first, then the model's labels. A correction replaces the labels, it does not sit beside them. */
export function effectiveCategories(analysis: ImageAnalysis, user: AssetUserInput): RegistryAsset["effective_categories"] {
  if (user.category) return [{ category: user.category, confidence: 1, source: "user" }];
  return analysis.categories.map((c) => ({ ...c, source: "vision" as const }));
}
export const effectiveDescription = (analysis: ImageAnalysis, user: AssetUserInput): string | null => user.description || analysis.visual?.description || null;

/** The form the Director is given, with file paths left out. */
export const AssetManifestEntry = z.object({
  asset_id: z.string(),
  original_filename: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  analysis_status: AnalysisStatus,
  categories: z.array(z.object({ category: ImageCategory, confidence: Share, source: z.enum(["user", "vision"]) })),
  description: z.string().nullable(),
  purpose: z.string().nullable(),
  visible_text: z.string(),
  subjects: z.array(z.string()),
  dominant_colours: z.array(HexColor),
  transparent: z.boolean(),
  background: z.string().nullable(),
  suitable_roles: z.array(z.string()),
  usage: AssetUsage,
  user_description: z.string().nullable(),
  /** Why this entry should not be trusted, in plain words. Empty when the analysis was confident. */
  caveats: z.array(z.string()),
});
export type AssetManifestEntry = z.infer<typeof AssetManifestEntry>;

// ---------- how a scene uses a picture ----------

export const ASSET_ROLES = ["logo", "hero", "product", "screen", "team", "background", "inset"] as const;
export const ASSET_PLACEMENTS = ["center", "left", "right", "top", "bottom", "top_left", "top_right", "bottom_left", "bottom_right", "full_frame"] as const;
export const ASSET_ANIMATIONS = ["none", "fade_in", "scale_in", "slide_up", "ken_burns_in", "ken_burns_out", "pan_left", "pan_right", "zoom_to_region"] as const;

export const SceneAssetRef = z.object({
  asset_id: z.string().min(1),
  role: z.enum(ASSET_ROLES),
  placement: z.enum(ASSET_PLACEMENTS),
  /** The largest share of the frame's width or height the picture may take, 0.05 to 1. */
  scale: z.number().min(0.05).max(1),
  /** contain shows the whole picture, cover fills the box by cropping evenly, crop shows `crop` only. */
  fit: z.enum(["contain", "cover", "crop"]),
  crop: NormBox.nullable().default(null),
  /** Higher is in front. */
  layer: z.number().int().min(0).max(9),
  animation: z.enum(ASSET_ANIMATIONS),
  /** A browser or device frame for a screen. */
  frame: z.enum(["none", "browser", "device"]).default("none"),
  mandatory: z.boolean(),
  reason: z.string().trim().min(1).max(240),
});
export type SceneAssetRef = z.infer<typeof SceneAssetRef>;

export interface AssetPlanIssue { scene_id: string; code: string; message: string }

/** Everything a plan may not do with the project's pictures. `manifest` is the analysed list the Director was given. */
export function assetRefIssues(scenes: readonly { scene_id: string; asset_ids: string[]; asset_refs?: readonly SceneAssetRef[]; unresolved?: readonly { note: string }[]; visual?: { block: string } | null }[], manifest: readonly Pick<AssetManifestEntry, "asset_id" | "usage" | "categories" | "original_filename">[]): AssetPlanIssue[] {
  const issues: AssetPlanIssue[] = [];
  const byId = new Map(manifest.map((m) => [m.asset_id, m]));
  const placed = new Set<string>();
  for (const s of scenes) {
    const layers = new Set<number>();
    if (s.visual?.block === "kinetic_type" && s.asset_refs?.length) issues.push({ scene_id: s.scene_id, code: "picture_over_kinetic_type", message: "kinetic_type fills the frame with its words, so a picture would cover them; use asset_stage with a headline instead" });
    for (const r of s.asset_refs ?? []) {
      const m = byId.get(r.asset_id);
      const bad = (code: string, message: string) => issues.push({ scene_id: s.scene_id, code, message });
      if (!m) { bad("unknown_asset_ref", `${r.asset_id} is not a picture in this project; use only the ids listed in the asset manifest`); continue; }
      placed.add(r.asset_id);
      if (!s.asset_ids.includes(r.asset_id)) bad("asset_ref_not_listed", `${r.asset_id} is placed but the scene does not list it in asset_ids`);
      if (m.usage === "reference_only") bad("asset_reference_only", `${r.asset_id} (${m.original_filename}) is a style reference; the user said not to show it directly`);
      if (m.usage === "do_not_use") bad("asset_do_not_use", `${r.asset_id} (${m.original_filename}) must not be used; the user said so`);
      if (r.fit === "crop" && !r.crop) bad("asset_crop_missing", `${r.asset_id} is set to crop but has no crop region`);
      if (r.animation === "zoom_to_region" && !r.crop) bad("asset_crop_missing", `${r.asset_id} zooms to a region but has no crop region`);
      if (r.crop && (r.crop.x + r.crop.w > 1 + 1e-6 || r.crop.y + r.crop.h > 1 + 1e-6)) bad("asset_crop_outside", `${r.asset_id}: the crop region leaves the picture`);
      if (r.role === "logo" && (r.fit !== "contain" || r.crop || r.animation === "zoom_to_region")) bad("logo_altered", `${r.asset_id} is a logo: show the whole mark with fit contain, never cropped`);
      if (layers.has(r.layer)) bad("asset_layer_clash", `two pictures share layer ${r.layer}; give each its own`);
      layers.add(r.layer);
    }
  }
  for (const m of manifest) {
    if (m.usage !== "must_use" || placed.has(m.asset_id)) continue;
    const named = scenes.flatMap((s) => (s.unresolved ?? []).map((u) => ({ s, note: u.note }))).find((u) => u.note.includes(m.asset_id));
    if (!named) issues.push({ scene_id: scenes[0]?.scene_id ?? "S01", code: "mandatory_asset_unplaced", message: `${m.asset_id} (${m.original_filename}) must appear: place it in a scene with asset_refs, or say why it cannot in an unresolved item naming ${m.asset_id}` });
  }
  return issues;
}

// ---------- what happened to each picture ----------

/** Each stage is a separate fact. A later stage is never implied by an earlier one. */
export const ASSET_STAGES = ["uploaded", "analyzed", "classified", "available_to_director", "assigned_to_storyboard", "approved", "resolved_by_renderer", "rendered", "visually_validated"] as const;
export type AssetLifecycleStage = (typeof ASSET_STAGES)[number];

export const AssetSceneCheck = z.object({
  asset_id: z.string(),
  scene_id: z.string(),
  mandatory: z.boolean(),
  role: z.string(),
  /** Each stage reached for this use of the picture. */
  stages: z.array(z.enum(ASSET_STAGES)),
  resolved_file: z.string().nullable(),
  sha256: z.string().nullable(),
  /** Measured on real frames of the final file. Null when the check did not run. */
  match_score: z.number().nullable(),
  frames_checked: z.array(z.number().int().nonnegative()),
  verdict: z.enum(["visible", "not_visible", "not_rendered", "not_checked"]),
  failure: z.string().nullable(),
});
export type AssetSceneCheck = z.infer<typeof AssetSceneCheck>;

export const AssetValidationReport = z.object({
  checks: z.array(AssetSceneCheck),
  /** Mandatory uses that did not reach `visually_validated`, each naming the scene, the asset and the reason. */
  failures: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type AssetValidationReport = z.infer<typeof AssetValidationReport>;
