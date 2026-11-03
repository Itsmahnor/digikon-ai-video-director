import { z } from "zod";
import { Energy, RecipeParam, Renderer } from "./recipe.js";
import { AspectRatio, SCENE_NEED_KINDS } from "./schemas.js";

/**
 * DRAFT contracts for the template library (Phase 1). Nothing reads these yet: no renderer, no Director step and no approval depends on them, so they can
 * still change. A template is a reviewed, parameterised scene described as a scene graph; it never carries code.
 */

const id = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const SCENE_GRAPH_NODE_KINDS = ["text", "shape", "image", "video", "group", "mask", "chart", "particles"] as const;
export const EASINGS = ["linear", "ease_in", "ease_out", "ease_in_out", "spring"] as const;

export const SceneGraphNode = z.object({
  node_id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  kind: z.enum(SCENE_GRAPH_NODE_KINDS),
  /** The group this node sits in; null for a root node. */
  parent_id: z.string().nullable().default(null),
  /** Static properties (position, size, colour token, font role). Values reference design tokens, never raw brand data. */
  props: z.record(z.unknown()).default({}),
  /** Names of template parameters that fill this node (for example "headline_text"). */
  bindings: z.record(z.string()).default({}),
});

export const Keyframe = z.object({ t_s: z.number().nonnegative(), value: z.union([z.number(), z.string(), z.boolean()]), easing: z.enum(EASINGS).default("ease_in_out") });
export const SceneGraphAnimation = z.object({
  target: z.string(),
  property: z.string().min(1),
  keyframes: z.array(Keyframe).min(2),
});

export const SceneGraph = z
  .object({
    format: z.literal("digikon.scene-graph"),
    format_version: z.literal(1),
    canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive().max(120) }),
    duration_s: z.number().positive().max(60),
    nodes: z.array(SceneGraphNode).min(1).max(200),
    animations: z.array(SceneGraphAnimation).max(400).default([]),
  })
  .superRefine((g, ctx) => {
    const ids = new Set<string>();
    for (const n of g.nodes) {
      if (ids.has(n.node_id)) ctx.addIssue({ code: "custom", path: ["nodes"], message: `duplicate node ${n.node_id}` });
      ids.add(n.node_id);
    }
    const byId = new Map(g.nodes.map((n) => [n.node_id, n]));
    for (const n of g.nodes) {
      if (n.parent_id !== null) {
        const p = byId.get(n.parent_id);
        if (!p) ctx.addIssue({ code: "custom", path: ["nodes"], message: `node ${n.node_id} names a parent ${n.parent_id} that does not exist` });
        else if (p.kind !== "group" && p.kind !== "mask") ctx.addIssue({ code: "custom", path: ["nodes"], message: `node ${n.node_id}'s parent ${n.parent_id} is a ${p.kind}, not a group or mask` });
      }
      const seen = new Set<string>([n.node_id]);
      for (let c = n.parent_id ? byId.get(n.parent_id) : undefined; c; c = c.parent_id ? byId.get(c.parent_id) : undefined) {
        if (seen.has(c.node_id)) { ctx.addIssue({ code: "custom", path: ["nodes"], message: `node ${n.node_id} is inside a parent cycle` }); break; }
        seen.add(c.node_id);
      }
    }
    for (const a of g.animations) {
      if (!ids.has(a.target)) ctx.addIssue({ code: "custom", path: ["animations"], message: `animation targets ${a.target}, which is not a node` });
      a.keyframes.forEach((k, i) => {
        if (k.t_s > g.duration_s) ctx.addIssue({ code: "custom", path: ["animations"], message: `a keyframe of ${a.target}.${a.property} is at ${k.t_s}s, after the ${g.duration_s}s scene` });
        if (i > 0 && k.t_s < a.keyframes[i - 1]!.t_s) ctx.addIssue({ code: "custom", path: ["animations"], message: `keyframes of ${a.target}.${a.property} are not in time order` });
      });
    }
  });
export type SceneGraph = z.infer<typeof SceneGraph>;

export const TemplateStatus = z.enum(["draft", "reviewed", "approved", "retired"]);

export const TemplateRecord = z
  .object({
    format: z.literal("digikon.template"),
    format_version: z.literal(1),
    template_id: id,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    category: z.string().min(1),
    title: z.string().min(1),
    /** What a viewer sees and what it is for, in plain words; embedded for retrieval. */
    description: z.string().min(1),
    /** Which scene needs (Scene.needs[].kind) this template serves. */
    serves_needs: z.array(z.enum(SCENE_NEED_KINDS)).min(1),
    archetypes: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
    family: id.optional(),
    variant_of: id.optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(24).default([]),
    energy: Energy,
    aspect_ratios: z.array(AspectRatio).min(1),
    renderers: z.array(Renderer).min(1),
    parameters: z.array(RecipeParam).default([]),
    scene_graph: SceneGraph,
    status: TemplateStatus.default("draft"),
    source: z.object({ origin: z.enum(["original", "licensed", "generated"]), license: z.string().min(1) }),
  })
  .superRefine((t, ctx) => {
    if (t.variant_of === t.template_id) ctx.addIssue({ code: "custom", path: ["variant_of"], message: "a template cannot be a variant of itself" });
    const params = new Set(t.parameters.map((p) => p.name));
    for (const n of t.scene_graph.nodes) for (const p of Object.values(n.bindings)) {
      if (!params.has(p)) ctx.addIssue({ code: "custom", path: ["scene_graph"], message: `node ${n.node_id} is bound to parameter ${p}, which the template does not declare` });
    }
  });
export type TemplateRecord = z.infer<typeof TemplateRecord>;
