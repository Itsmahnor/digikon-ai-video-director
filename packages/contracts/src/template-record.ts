import { z } from "zod";
import { Energy } from "./recipe.js";
import { AspectRatio } from "./schemas.js";
import { SceneGraphV2 } from "./scene-graph.js";

/**
 * The template library record (format version 2 of `digikon.template`). It is additive: the draft version-1 record in templates.ts is unchanged and still
 * parses. A library template is a reviewed, parameterised scene described as scene graphs (one per aspect ratio, because a graph's positions are pixels);
 * it never carries code. Files live in git as JSON under templates/<category>/; the database is built from them, never the other way round.
 */

export const SCENE_CATEGORIES = ["hook", "problem", "solution_reveal", "ui_demo", "feature_highlight", "process", "data_proof", "comparison", "social_proof", "brand_moment", "transition_beat", "cta_end"] as const;
export const SUPPORT_CATEGORIES = ["kinetic_type", "transitions", "backgrounds", "camera_moves", "charts", "lower_thirds_captions"] as const;
export const TEMPLATE_CATEGORIES = [...SCENE_CATEGORIES, ...SUPPORT_CATEGORIES] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const CATEGORY_TARGET = 100;

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const snake = z.string().regex(/^[a-z][a-z0-9_]*$/);
const word = z.string().trim().min(1).max(40);

export const MOTION_PERSONALITIES = ["snappy", "bouncy", "smooth", "mechanical", "cinematic"] as const;
export const TYPE_PERSONALITIES = ["editorial", "technical", "plain", "mixed"] as const;
export const PACINGS = ["slow", "medium", "fast"] as const;

export const TemplateTags = z.object({
  mood: z.array(word).min(1).max(6),
  energy: Energy,
  pacing: z.enum(PACINGS),
  industry: z.array(word).max(8).default([]),
  tone: z.array(word).min(1).max(6),
  motion_personality: z.enum(MOTION_PERSONALITIES),
  type_personality: z.enum(TYPE_PERSONALITIES),
});

export const TextSlot = z.object({ name: snake, role: z.enum(["headline", "subline", "label", "number", "caption", "name", "item"]), max_chars: z.number().int().min(1).max(400), required: z.boolean().default(true), example: z.string().min(1).max(400) });
export const TemplateNeeds = z.object({
  media: z.array(z.enum(["none", "image", "video"])).min(1).default(["none"]),
  text_slots: z.array(TextSlot).max(12),
  aspect_ratios: z.array(AspectRatio).min(1),
  duration_range: z.object({ min_s: z.number().positive(), max_s: z.number().positive() }).refine((d) => d.max_s >= d.min_s, "max_s is below min_s"),
});

/** A parameter with a range: a number or a choice a caller may vary without changing what the template is. */
export const TemplateParam = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("number"), name: snake, min: z.number(), max: z.number(), default: z.number() }),
  z.object({ kind: z.literal("choice"), name: snake, options: z.array(z.string().min(1)).min(2), default: z.string().min(1) }),
]);

const PALETTE_TOKENS = ["text", "muted", "accent", "accent_2", "surface", "background"] as const;
export const PaletteRules = z.object({
  /** The palette tokens the graphs draw with: a caller's palette must define these. */
  roles_used: z.array(z.enum(PALETTE_TOKENS)).min(1),
  min_text_contrast: z.number().min(3).max(21).default(4.5),
  /** The look the template was reviewed with; any palette that meets the contrast rules is allowed. */
  reference_palette: z.object({ name: z.string().min(1), background: z.string(), surface: z.string(), text: z.string(), muted: z.string(), accent: z.string(), accent_2: z.string() }),
});
export const TypeRules = z.object({
  /** The roles the graphs ask for: display, body, mono. A caller maps a role to one of its approved fonts. */
  roles_used: z.array(z.enum(["display", "body", "mono"])).min(1),
  pairing: z.object({ name: z.string().min(1), display: z.string().min(1), body: z.string().min(1), mono: z.string().min(1) }),
  min_px_short_edge_ratio: z.number().min(0.01).max(0.2).default(0.03),
});

export const EngineSupport = z.object({
  scene_graph_version: z.literal(2),
  renderers: z.array(z.literal("remotion")).min(1),
  /** The flag that must be on for the engine to draw this. Default off. */
  requires_flag: z.literal("SCENE_GRAPH"),
});

export const TemplateSource = z.object({
  kind: z.enum(["authored", "adapted", "generated"]),
  origin: z.string().min(1),
  licence: z.string().min(1),
  licence_ok: z.boolean(),
});

export const EvidenceRef = z.object({ kind: z.enum(["validation", "render_preview", "review"]), ref: z.string().min(1), note: z.string().optional() });

export const LibraryTemplateStatus = z.enum(["draft", "reviewed"]);

export const LibraryTemplate = z
  .object({
    format: z.literal("digikon.template"),
    format_version: z.literal(2),
    template_id: slug,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** sha256 (first 32 hex) of the record without content_hash, status and evidence. Recomputed by `templates validate`. */
    content_hash: z.string().regex(/^[0-9a-f]{32}$/),
    category: z.enum(TEMPLATE_CATEGORIES),
    /** The base design this one was derived from or is. Every record in a family shares it. */
    family: slug,
    /** The template this was generated from by variant expansion; absent on a hand-authored base. */
    variant_of: slug.optional(),
    /** Which declared axes were varied from the base: { palette: "ink", layout: "flip" }. Empty on a base. */
    variant_axes: z.record(z.string()).default({}),
    archetype: snake,
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(600),
    tags: TemplateTags,
    needs: TemplateNeeds,
    /** One graph per supported aspect ratio, keyed by it. Text that a slot fills carries a binding to the slot's name. */
    scene_graph: z.record(AspectRatio, SceneGraphV2),
    params: z.array(TemplateParam).max(12).default([]),
    palette_rules: PaletteRules,
    type_rules: TypeRules,
    engine_support: EngineSupport,
    source: TemplateSource,
    evidence: z.array(EvidenceRef).default([]),
    status: LibraryTemplateStatus.default("draft"),
    /** What is embedded for text retrieval: plain words a director would search with. */
    retrieval_text: z.string().min(20).max(1200),
  })
  .superRefine((t, ctx) => {
    if (t.variant_of === t.template_id) ctx.addIssue({ code: "custom", path: ["variant_of"], message: "a template cannot be a variant of itself" });
    if (t.variant_of && !t.template_id.startsWith(t.family)) ctx.addIssue({ code: "custom", path: ["template_id"], message: "a variant's id starts with its family" });
    const declared = new Set(t.needs.aspect_ratios), have = Object.keys(t.scene_graph);
    for (const a of declared) if (!have.includes(a)) ctx.addIssue({ code: "custom", path: ["scene_graph"], message: `declares ${a} but has no graph for it` });
    for (const a of have) if (!declared.has(a as never)) ctx.addIssue({ code: "custom", path: ["scene_graph"], message: `has a graph for ${a}, which needs.aspect_ratios does not declare` });
    const slots = new Set(t.needs.text_slots.map((s) => s.name)), params = new Set(t.params.map((p) => p.name));
    const dupSlots = t.needs.text_slots.length - slots.size;
    if (dupSlots) ctx.addIssue({ code: "custom", path: ["needs", "text_slots"], message: "duplicate text slot names" });
    const bound = new Set<string>();
    for (const [aspect, g] of Object.entries(t.scene_graph)) {
      for (const e of g.elements) for (const p of Object.values(e.bindings)) {
        bound.add(p);
        if (!slots.has(p) && !params.has(p)) ctx.addIssue({ code: "custom", path: ["scene_graph", aspect], message: `${e.id} is bound to ${p}, which is neither a text slot nor a parameter` });
      }
      if (g.duration_s < t.needs.duration_range.min_s - 1e-6 || g.duration_s > t.needs.duration_range.max_s + 1e-6) ctx.addIssue({ code: "custom", path: ["scene_graph", aspect], message: `the ${aspect} graph runs ${g.duration_s}s, outside the declared ${t.needs.duration_range.min_s}-${t.needs.duration_range.max_s}s` });
    }
    for (const s of slots) if (!bound.has(s)) ctx.addIssue({ code: "custom", path: ["needs", "text_slots"], message: `text slot ${s} is not bound to any element` });
    if (t.status === "reviewed" && !t.source.licence_ok) ctx.addIssue({ code: "custom", path: ["source", "licence_ok"], message: "a reviewed template needs licence_ok" });
    if (t.status === "reviewed" && !t.evidence.some((e) => e.kind === "validation")) ctx.addIssue({ code: "custom", path: ["evidence"], message: "a reviewed template needs validation evidence" });
  });
export type LibraryTemplate = z.infer<typeof LibraryTemplate>;

/** A result `templates validate` writes for one template at one aspect ratio. */
export const TemplateValidation = z.object({ template_id: slug, content_hash: z.string(), aspect: AspectRatio, ok: z.boolean(), issues: z.array(z.string()) });
export type TemplateValidation = z.infer<typeof TemplateValidation>;
