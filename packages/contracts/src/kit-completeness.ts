import { KIT_FIELDS, getField, type KitField, type ProjectKit } from "./kit.js";

/**
 * Deterministic completeness of a project kit (no model involved). Which fields are required, recommended or optional depends on the video category: a SaaS video wants the product's
 * website and screen recordings, a shop video wants product pictures and offer facts. A required field cannot be skipped; recommended and optional ones can, and a skip is a decision, not a gap.
 */
export type Level = "required" | "recommended" | "optional";
export type Category = ProjectKit["video_category"];

const BASE: Record<KitField, Level> = {
  goal: "required", audience: "required", platform: "required",
  "brand.colours": "recommended", "brand.logo": "recommended", "brand.tone": "recommended", facts: "recommended", assets: "recommended",
  "brand.fonts": "optional", website: "optional", guideline: "optional",
};
const BY_CATEGORY: Record<NonNullable<Category>, Partial<Record<KitField, Level>>> = {
  saas: { website: "recommended", facts: "recommended", assets: "recommended" },
  ecommerce: { assets: "recommended", facts: "recommended", website: "recommended", "brand.logo": "recommended" },
  "general-promo": { facts: "recommended", website: "optional" },
};

export function levelOf(field: KitField, category: Category): Level {
  return (category ? BY_CATEGORY[category][field] : undefined) ?? BASE[field];
}

export interface CompletenessItem {
  field: KitField;
  level: Level;
  state: "provided" | "skipped" | "missing";
  /** True when nothing more is needed for this field: provided, or skipped where skipping is allowed. */
  satisfied: boolean;
  can_skip: boolean;
  /** Provided from a website or file but not confirmed by the user yet. */
  needs_confirmation: boolean;
}
export interface Completeness {
  video_category: Category;
  items: CompletenessItem[];
  /** Every required field is provided. Skipped recommended or optional fields do not block. */
  ready: boolean;
  /** What to ask next, in order: required fields not yet provided (a skipped required field is asked again), then recommended fields still missing. Optional and skipped optional or recommended fields are never asked. */
  next: KitField[];
  counts: Record<Level, { provided: number; skipped: number; missing: number }>;
}

export function completeness(kit: ProjectKit): Completeness {
  const items: CompletenessItem[] = KIT_FIELDS.map((field) => {
    const f = getField(kit, field), level = levelOf(field, kit.video_category);
    const needs = f.state === "provided" && f.source !== null && f.source !== "user" && f.source !== "upload" && !f.confirmed;
    const can_skip = level !== "required";
    return { field, level, state: f.state, satisfied: f.state === "provided" || (f.state === "skipped" && can_skip), can_skip, needs_confirmation: needs };
  });
  const rank: Record<Level, number> = { required: 0, recommended: 1, optional: 2 };
  const next = items.filter((i) => (i.state === "missing" && i.level !== "optional") || (i.level === "required" && i.state !== "provided")).sort((a, b) => rank[a.level] - rank[b.level] || KIT_FIELDS.indexOf(a.field) - KIT_FIELDS.indexOf(b.field)).map((i) => i.field);
  const counts = { required: { provided: 0, skipped: 0, missing: 0 }, recommended: { provided: 0, skipped: 0, missing: 0 }, optional: { provided: 0, skipped: 0, missing: 0 } } as Completeness["counts"];
  for (const i of items) counts[i.level][i.state]++;
  return { video_category: kit.video_category, items, ready: items.filter((i) => i.level === "required").every((i) => i.state === "provided"), next, counts };
}
