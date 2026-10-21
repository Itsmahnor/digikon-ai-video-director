import { z } from "zod";
import { QAFinding } from "./schemas.js";

/** Time range inside a source asset, in seconds. */
const Range = z
  .object({ start: z.number().nonnegative(), end: z.number().positive() })
  .refine((r) => r.end > r.start, "end must be after start");

export const AssetNotes = z.object({
  asset_id: z.string().min(1),
  usable_segments: z.array(Range),
  quality_flags: z.array(
    z.object({
      flag: z.enum(["blur", "shake", "exposure", "low_resolution", "noise", "black_frames", "frozen", "silence", "other"]),
      start: z.number().nonnegative(),
      end: z.number().positive(),
    }),
  ).default([]),
  /** Only what is visible or audible. Never guessed product features. Empty until a vision pass has looked at the footage. */
  content_summary: z.string(),
  /** Observations that were not confirmed. Downstream steps must not rely on these. */
  uncertain: z.array(z.string()).default([]),
  transcript_ref: z.string().nullable().default(null),
  /** Times, in seconds, where the picture cuts to a new shot. Measured, not guessed. */
  shots: z.array(z.number().nonnegative()).default([]),
  /** Integrated loudness of the audio track in LUFS, when measured. */
  loudness_lufs: z.number().nullable().default(null),
  /** What is said, when speech was detected. The text is trimmed for the prompt; the full transcript is stored separately. */
  speech: z.object({ language: z.string(), text: z.string(), word_count: z.number().int().nonnegative() }).nullable().default(null),
  /** Paths of sampled frames saved for the vision pass. Never shown to the model as text. */
  keyframe_refs: z.array(z.string()).default([]),
});
export const BrandFact = z.object({
  fact_id: z.string().min(1),
  text: z.string().min(1),
  source: z.string().min(1),
});

/** brand_fact_id === null means "unsupported". The model proposes claims; code decides. */
export const Claim = z.object({
  claim_id: z.string().regex(/^C\d{2,}$/),
  text: z.string().min(1),
  brand_fact_id: z.string().nullable(),
});

export const Treatment = z.object({
  logline: z.string().min(1),
  hook: z.string().min(1),
  tone: z.string().min(1),
  beats: z.array(z.object({
    beat: z.string().min(1),
    purpose: z.string().min(1),
    approx_seconds: z.number().positive(),
  })).min(1),
  cta: z.string().min(1),
  claims: z.array(Claim).default([]),
  /** Conflicts between skills and how the priority order resolved them. */
  conflicts_log: z.array(z.object({ conflict: z.string(), decision: z.string() })).default([]),
});

export const RecipeUse = z.object({
  use_id: z.string().regex(/^U\d{2,}$/),
  scene_id: z.string().regex(/^S\d{2,}$/),
  recipe_id: z.string().min(1),
  params: z.record(z.union([z.number(), z.string(), z.boolean()])),
  rationale: z.string().min(1),
});

/** The Director's edit plan: every operation is a recipe reference plus parameters. Nothing else is executable. */
export const EditPlan = z.object({
  project_id: z.string().min(1),
  version: z.number().int().positive(),
  uses: z.array(RecipeUse),
});

export const OwnerSkill = z.enum([
  "video-director", "commercial-strategy", "cinematography",
  "editing-director", "motion-graphics", "sound-design",
]);

export const RevisionTicket = z.object({
  ticket_id: z.string().min(1),
  finding_id: z.string().min(1),
  scene_ids: z.array(z.string().regex(/^S\d{2,}$/)).min(1),
  owner_skill: OwnerSkill,
  instruction: z.string().min(1),
  attempt: z.number().int().min(1).max(2),
  status: z.enum(["open", "done", "escalated"]).default("open"),
});

export const Escalation = z.object({
  what_failed: z.string().min(1),
  evidence: z.array(z.string()).min(1),
  what_was_tried: z.array(z.string()),
  options_left: z.array(z.string()),
  decision_needed: z.string().min(1),
});

export type AssetNotes = z.infer<typeof AssetNotes>;
export type OwnerSkill = z.infer<typeof OwnerSkill>;
export type BrandFact = z.infer<typeof BrandFact>;
export type Claim = z.infer<typeof Claim>;
export type Treatment = z.infer<typeof Treatment>;
export type RecipeUse = z.infer<typeof RecipeUse>;
export type EditPlan = z.infer<typeof EditPlan>;
export type RevisionTicket = z.infer<typeof RevisionTicket>;
export type Escalation = z.infer<typeof Escalation>;
export type { QAFinding };
