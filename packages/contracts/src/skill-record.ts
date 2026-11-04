import { z } from "zod";

/**
 * A skill in the library (`digikon.skill` v1). Every skill names its source and the licence it was taken under; a record with no licence does not parse.
 * Which licences are allowed is the importer's decision (rag/skills.ts), not the contract's: the contract only guarantees one is recorded.
 */

const slug = z.string().regex(/^[a-z0-9]+([-_][a-z0-9]+)*$/);
const text = z.string().trim().min(1);

/** The video category a skill serves. `all` marks a cross-cutting skill that applies to any category. */
export const SKILL_CATEGORIES = ["saas", "ecommerce", "general-promo", "all"] as const;
export const SKILL_SCOPES = ["director", "editor", "both"] as const;

export const SKILL_STATUSES = ["draft", "reviewed", "approved", "retired"] as const;

export const SkillSource = z.object({
  repo: text,
  url: text,
  licence: text,
  attribution: z.string().trim().min(1).nullable().default(null),
  checked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();
export type SkillSource = z.infer<typeof SkillSource>;

export const SkillRecord = z.object({
  format: z.literal("digikon.skill").default("digikon.skill"),
  format_version: z.literal(1).default(1),
  id: slug,
  title: text,
  category: z.enum(SKILL_CATEGORIES),
  /** The concept the skill teaches (hook, pacing, claims-safety, motion, ...). */
  topic: slug,
  scope: z.enum(SKILL_SCOPES).default("both"),
  funnel_stage: slug,
  platform: z.array(slug).default([]),
  grade: text,
  status: z.enum(SKILL_STATUSES).default("draft"),
  body: z.string().min(1),
  source: SkillSource,
}).strict();
export type SkillRecord = z.infer<typeof SkillRecord>;

export const AssetLibraryRecord = z.object({
  id: slug,
  kind: z.enum(["font", "sound", "music"]),
  file: text,
  licence: text,
  source: text,
}).strict();
export type AssetLibraryRecord = z.infer<typeof AssetLibraryRecord>;
