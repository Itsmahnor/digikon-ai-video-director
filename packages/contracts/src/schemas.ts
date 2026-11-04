import { z } from "zod";
import { SceneVisual } from "./visual.js";
import { SceneAssetRef } from "./assets.js";

export const ShotSize = z.enum([
  "extreme_wide", "wide", "medium", "close_up", "macro_close_up",
]);
export const CameraMotion = z.enum([
  "static", "slow_push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "tilt_down",
]);
export const Transition = z.enum(["cut", "match_cut", "crossfade", "dip_to_black", "wipe"]);
export const AspectRatio = z.enum(["16:9", "9:16", "1:1"]);
export const ApprovalStatus = z.enum(["draft", "pending_approval", "approved", "rejected"]);

export const Project = z.object({
  project_id: z.string().min(1),
  owner_id: z.string().min(1),
  brief: z.string().min(1),
  objective: z.string().min(1),
  audience: z.string().min(1),
  platform: z.string().min(1),
  aspect_ratio: AspectRatio,
  target_duration: z.number().positive().max(180),
  brand_id: z.string().nullable().default(null),
  /** The kind of video, which decides which skills the Director and Editor read (plus the cross-cutting ones). Null means not stated: only cross-cutting skills are used. */
  video_category: z.enum(["saas", "ecommerce", "general-promo"]).nullable().default(null),
  /** The chosen video type playbook id (e.g. saas-product-demo, ecom-product-showcase). Null means not yet chosen. */
  video_type: z.string().nullable().default(null),
  approval_status: ApprovalStatus.default("draft"),
});

/** What the user has said about the right to use a file. Never inferred: null means nothing was recorded. */
export const AssetLicense = z.object({
  status: z.enum(["user_owned", "licensed", "unknown"]),
  note: z.string().max(300).nullable().default(null),
});

export const Asset = z.object({
  asset_id: z.string().min(1),
  /** Right-to-use declaration for the file. The Editor requires one for audio. */
  license: AssetLicense.nullable().default(null),
  /** true: the user says this is a real capture of their product. false: illustrative. null: not declared. */
  genuine_product_ui: z.boolean().nullable().default(null),
  uri: z.string().min(1),
  media_type: z.enum(["video", "image", "audio"]),
  duration: z.number().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  audio_tracks: z.number().int().nonnegative().default(0),
  transcript_ref: z.string().nullable().default(null),
  keyframe_refs: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
});

/** How a scene will be made: from generated graphics, from supplied material, or both. Assigned by code from the scene's assets. */
export const ProductionMethod = z.enum(["graphics", "supplied_footage", "mixed"]);
export const AssetKind = z.enum(["footage", "image", "logo", "ui_screenshot", "audio", "graphics"]);
/**
 * supplied: the user gave it (asset_id names the file).
 * generate_graphics: the graphics workflow (animated text, shapes, end cards, UI-style graphics) can build it.
 * needs_external: live footage or real material that was not supplied; blocks production until it is.
 * missing_blocking: needed, not supplied, and nothing can stand in for it.
 */
export const AssetAvailability = z.enum(["supplied", "generate_graphics", "needs_external", "missing_blocking"]);
export const RequiredAsset = z.object({
  need: z.string().min(1).max(200),
  kind: AssetKind,
  availability: AssetAvailability,
  /** The supplied file, when availability is "supplied". */
  asset_id: z.string().nullable().default(null),
  /** A graphics-only stand-in for something the user has not supplied (a logo, a product screen). Shown to the user for approval. */
  placeholder: z.boolean().default(false),
  /** What could be done instead, keeping the creative intent. */
  fallback: z.string().max(300).nullable().default(null),
});
export const UnresolvedItem = z.object({
  kind: z.enum(["placeholder", "missing_input", "creative_decision"]),
  note: z.string().min(1).max(300),
});

/** What a scene needs from the picture, stated before any template is chosen, so a template is picked for the need and not the other way round. */
export const SCENE_NEED_KINDS = ["emphasise_claim", "show_data", "show_process", "show_place_or_object", "introduce_brand", "transition_idea", "emotional_beat", "call_to_action", "explain_concept", "ambient_context"] as const;
export const SceneNeed = z.object({
  kind: z.enum(SCENE_NEED_KINDS),
  /** The need in plain words, tied to this scene. */
  description: z.string().trim().min(1).max(240),
  /** A claim id from the treatment this need serves, when it serves one. */
  claim_id: z.string().nullable().default(null),
  priority: z.enum(["primary", "secondary"]).default("primary"),
});
export type SceneNeed = z.infer<typeof SceneNeed>;

export const Scene = z.object({
  scene_id: z.string().regex(/^S\d{2,}$/),
  purpose: z.string().min(1),
  start_time: z.number().nonnegative(),
  /** start_time + duration_seconds, written by code. When present it must agree with them. */
  end_time: z.number().positive().nullable().default(null),
  duration_seconds: z.number().positive().max(60),
  /** Exact words spoken over the scene, if any. Music and sound effects stay in audio_cues. */
  voiceover: z.string().max(400).nullable().default(null),
  production_method: ProductionMethod.nullable().default(null),
  /** What the scene needs and whether it is supplied, buildable as graphics, or missing. */
  required_assets: z.array(RequiredAsset).max(12).default([]),
  /** Placeholders, missing inputs and open creative decisions the user must see. */
  unresolved: z.array(UnresolvedItem).max(12).default([]),
  /** What this scene's picture does that no other scene's does. Required once the treatment has art direction. */
  visual_purpose: z.string().trim().min(1).max(240).nullable().default(null),
  /** What the scene draws, as data: one of the supported visual blocks. Approved with the storyboard like everything else on the scene. */
  visual: SceneVisual.nullable().default(null),
  /** The kind of scene this is (for example "stat_reveal", "product_hero"). Optional and absent on older plans, so their approval hashes do not change. */
  scene_archetype: z.string().regex(/^[a-z][a-z0-9_]*$/).max(60).optional(),
  /** What the scene needs from its picture. Optional and absent on older plans, so their approval hashes do not change. */
  needs: z.array(SceneNeed).max(8).optional(),
  asset_ids: z.array(z.string()).default([]),
  /** How each uploaded picture is used in this scene. Absent on older plans, so their approval hashes do not change. Every id here is also in asset_ids. */
  asset_refs: z.array(SceneAssetRef).max(6).optional(),
  /** Offset into the source video where this scene starts, in seconds. */
  source_in_seconds: z.number().nonnegative().default(0),
  /** Claims from the treatment's claims register that this scene states or implies. */
  claim_ids: z.array(z.string()).default([]),
  shot: z.object({
    shot_size: ShotSize,
    camera_motion: CameraMotion,
    visual_action: z.string().min(1),
  }),
  overlay: z
    .object({ text: z.string().max(120), safe_area: z.enum(["platform_safe", "full"]) })
    .nullable()
    .default(null),
  audio_cues: z.array(z.string()).default([]),
  transition_out: Transition,
  constraints: z.array(z.string()).default([]),
});

export const OperationType = z.enum([
  "trim_clip", "render_graphics_scene", "overlay_text", "concat", "mix_audio",
]);

export const EditOperation = z.object({
  operation_id: z.string().min(1),
  target_scene_id: z.string().min(1),
  operation_type: OperationType,
  parameters: z.record(z.unknown()),
  preconditions: z.array(z.string()).default([]),
  expected_result: z.string().min(1),
  validation_status: z.enum(["unvalidated", "valid", "invalid"]).default("unvalidated"),
});

export const QAFinding = z.object({
  finding_id: z.string().min(1),
  scene_id: z.string().nullable(),
  severity: z.enum(["critical", "major", "minor", "info"]),
  category: z.enum(["technical", "product_fidelity", "pacing", "visual", "audio", "brand"]),
  // Evidence is mandatory: a frame/timestamp reference or probe result key.
  evidence_ref: z.string().min(1),
  description: z.string().min(1),
  suggested_fix: z.string().nullable().default(null),
  status: z.enum(["open", "fixed", "wontfix"]).default("open"),
});

export const ScenePlan = z.object({
  project_id: z.string().min(1),
  version: z.number().int().positive(),
  scenes: z.array(Scene).min(1),
});

export type Project = z.infer<typeof Project>;
export type Asset = z.infer<typeof Asset>;
export type Scene = z.infer<typeof Scene>;
export type RequiredAsset = z.infer<typeof RequiredAsset>;
export type ProductionMethod = z.infer<typeof ProductionMethod>;
export type ScenePlan = z.infer<typeof ScenePlan>;
export type EditOperation = z.infer<typeof EditOperation>;
export type QAFinding = z.infer<typeof QAFinding>;
