import { z } from "zod";

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
  approval_status: ApprovalStatus.default("draft"),
});

export const Asset = z.object({
  asset_id: z.string().min(1),
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

export const Scene = z.object({
  scene_id: z.string().regex(/^S\d{2,}$/),
  purpose: z.string().min(1),
  start_time: z.number().nonnegative(),
  duration_seconds: z.number().positive().max(60),
  asset_ids: z.array(z.string()).default([]),
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
export type ScenePlan = z.infer<typeof ScenePlan>;
export type EditOperation = z.infer<typeof EditOperation>;
export type QAFinding = z.infer<typeof QAFinding>;
