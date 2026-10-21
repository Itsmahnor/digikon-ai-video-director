import { z } from "zod";
import { AspectRatio } from "./schemas.js";

export const RecipeType = z.enum(["shot", "camera_move", "transition", "animation", "sound_cue"]);
export const Renderer = z.enum(["remotion", "ffmpeg"]);
export const RecipeStatus = z.enum(["draft", "reviewed"]);
export const Energy = z.enum(["low", "medium", "high"]);

const paramName = z.string().regex(/^[a-z][a-z0-9_]*$/);

export const RecipeParam = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("number"),
    name: paramName,
    unit: z.string().min(1),
    min: z.number(),
    max: z.number(),
    default: z.number(),
  }),
  z.object({
    kind: z.literal("enum"),
    name: paramName,
    options: z.array(z.string().min(1)).min(2),
    default: z.string(),
  }),
  z.object({
    kind: z.literal("string"),
    name: paramName,
    max_length: z.number().int().positive(),
    default: z.string(),
  }),
  z.object({
    kind: z.literal("boolean"),
    name: paramName,
    default: z.boolean(),
  }),
]);

/** Machine-checkable rules the recipe validator runs against a scene and its parameters. */
export const RecipeRule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("requires_overlay_text"), message: z.string().min(1) }),
  z.object({ kind: z.literal("requires_asset"), message: z.string().min(1) }),
  z.object({ kind: z.literal("param_lte_scene_duration"), param: paramName, message: z.string().min(1) }),
  z.object({
    kind: z.literal("param_lte_duration_fraction"),
    param: paramName,
    fraction: z.number().positive().max(1),
    message: z.string().min(1),
  }),
  z.object({ kind: z.literal("param_less_than"), lesser: paramName, greater: paramName, message: z.string().min(1) }),
]);

export const Recipe = z
  .object({
    recipe_id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    type: RecipeType,
    title: z.string().min(1),
    purpose: z.string().min(1),
    /** Short phrases an editor would use to look for this recipe; embedded together with purpose. */
    intents: z.array(z.string().min(1)).min(1),
    parameters: z.array(RecipeParam),
    constraints: z.object({
      min_duration_s: z.number().nonnegative(),
      max_duration_s: z.number().positive(),
      max_uses_per_film: z.number().int().positive().nullable(),
      energy: Energy,
    }),
    compatibility: z.object({
      renderers: z.array(Renderer).min(1),
      aspect_ratios: z.array(AspectRatio).min(1),
      /** Media the target scene must carry; "none" means a graphics-only scene is fine. */
      media_types: z.array(z.enum(["video", "image", "audio", "none"])).min(1),
    }),
    validation_rules: z.array(RecipeRule).default([]),
    /** Id of a reviewed Remotion/FFmpeg template. Never model-written code. */
    implementation_ref: z.string().min(1),
    source: z.object({
      origin: z.enum(["original", "shotcraft"]),
      url: z.string().url().nullable().default(null),
      license: z.string().min(1),
    }),
    status: RecipeStatus,
  })
  .superRefine((r, ctx) => {
    const names = new Set<string>();
    for (const p of r.parameters) {
      if (names.has(p.name)) ctx.addIssue({ code: "custom", message: `duplicate parameter ${p.name}` });
      names.add(p.name);
      if (p.kind === "number" && (p.default < p.min || p.default > p.max || p.min > p.max)) {
        ctx.addIssue({ code: "custom", message: `parameter ${p.name} default outside min/max` });
      }
      if (p.kind === "enum" && !p.options.includes(p.default)) {
        ctx.addIssue({ code: "custom", message: `parameter ${p.name} default not in options` });
      }
      if (p.kind === "string" && p.default.length > p.max_length) {
        ctx.addIssue({ code: "custom", message: `parameter ${p.name} default longer than max_length` });
      }
    }
    for (const rule of r.validation_rules) {
      const refs =
        rule.kind === "param_less_than" ? [rule.lesser, rule.greater]
        : "param" in rule ? [rule.param]
        : [];
      for (const n of refs) {
        if (!names.has(n)) ctx.addIssue({ code: "custom", message: `rule references unknown parameter ${n}` });
      }
    }
    if (r.constraints.min_duration_s > r.constraints.max_duration_s) {
      ctx.addIssue({ code: "custom", message: "min_duration_s greater than max_duration_s" });
    }
  });

export type Recipe = z.infer<typeof Recipe>;
export type RecipeType = z.infer<typeof RecipeType>;
export type Energy = z.infer<typeof Energy>;
export type Renderer = z.infer<typeof Renderer>;
export type RecipeParam = z.infer<typeof RecipeParam>;
