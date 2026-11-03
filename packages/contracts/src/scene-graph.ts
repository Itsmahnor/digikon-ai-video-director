import { z } from "zod";

/**
 * The scene graph (format version 2): a scene described as elements on a timeline, never as code. It is additive: the draft version 1 graph in
 * templates.ts is unchanged and still parses. Nothing draws a graph unless the SCENE_GRAPH flag is on, and a graph is validated (render package)
 * before it is compiled.
 *
 * Every animated number is a track of keyframes at `at` = 0..1 of the element's own duration, eased per segment. Position, size and font size are
 * pixels in the canvas; colours are palette tokens or #rrggbb.
 */

export const SCENE_GRAPH_V2 = "digikon.scene-graph" as const;
export const ELEMENT_KINDS = ["text", "shape", "image", "video", "mask", "group", "chart", "cursor"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];
export const NAMED_EASINGS = ["linear", "ease_in", "ease_out", "ease_in_out"] as const;
export const ANIMATABLE = ["x", "y", "scale", "rotate", "opacity", "progress", "w", "h", "tracking"] as const;
export type Animatable = (typeof ANIMATABLE)[number];

export const CubicBezier = z.object({ bezier: z.tuple([z.number().min(0).max(1), z.number().min(-2).max(3), z.number().min(0).max(1), z.number().min(-2).max(3)]) });
export const SpringEasing = z.object({
  spring: z.object({
    damping: z.number().min(1).max(100).default(12),
    stiffness: z.number().min(10).max(500).default(100),
    mass: z.number().min(0.1).max(10).default(1),
    overshoot_clamp: z.boolean().default(false),
  }),
});
export const Easing = z.union([z.enum(NAMED_EASINGS), CubicBezier, SpringEasing]);
export type Easing = z.infer<typeof Easing>;

export const Key = z.object({ at: z.number().min(0).max(1), value: z.number(), easing: Easing.optional() });
export const Track = z.object({
  property: z.enum(ANIMATABLE),
  keyframes: z.array(Key).min(2).max(24),
  /** The easing used on a segment whose keyframe names none. */
  easing: Easing.default("ease_out"),
});
export type Track = z.infer<typeof Track>;

export const Timeline = z.object({
  start_s: z.number().min(0),
  duration_s: z.number().positive(),
  tracks: z.array(Track).max(16).default([]),
});

/** Offsets each unit of a text run so lines, words or characters arrive one after another. */
export const Stagger = z.object({
  unit: z.enum(["line", "word", "char"]),
  each_s: z.number().min(0.005).max(1),
  from: z.enum(["start", "end", "center"]).default("start"),
});

const Color = z.string().regex(/^(text|muted|accent|accent_2|surface|background|#[0-9a-fA-F]{6})$/, "a palette token or #rrggbb");
const Px = z.number().finite();

export const TextProps = z.object({
  text: z.string().min(1).max(400),
  font_px: z.number().min(8).max(600),
  x: Px, y: Px, w: z.number().positive(),
  weight: z.enum(["regular", "bold"]).default("bold"),
  align: z.enum(["left", "center", "right"]).default("left"),
  upper: z.boolean().default(false),
  /** Which of the film's font roles draws this text. Absent means the film's single font, as before. */
  font: z.enum(["display", "body", "mono"]).optional(),
  color: Color.default("text"),
  line_height: z.number().min(0.4).max(2).default(1.2),
  /** Counts a number up: the text is `prefix` + value + `suffix`, and the `progress` track runs 0..1 from `from` to `to`. */
  counter: z.object({ from: z.number(), to: z.number(), decimals: z.number().int().min(0).max(4).default(0), prefix: z.string().max(8).default(""), suffix: z.string().max(8).default("") }).optional(),
});
export const ShapeProps = z.object({
  shape: z.enum(["rect", "ellipse", "line"]),
  x: Px, y: Px, w: z.number().positive(), h: z.number().min(0),
  fill: Color.optional(), stroke: Color.optional(), stroke_w: z.number().min(0).max(40).default(0), radius: z.number().min(0).default(0),
});
export const MediaProps = z.object({ asset_ref: z.string().min(1), x: Px, y: Px, w: z.number().positive(), h: z.number().positive(), fit: z.enum(["cover", "contain"]).default("cover") });
export const MaskProps = z.object({ reveal: z.enum(["left", "right", "up", "down", "circle"]), x: Px, y: Px, w: z.number().positive(), h: z.number().positive() });
export const GroupProps = z.object({ x: Px.default(0), y: Px.default(0) });
export const ChartProps = z.object({ chart: z.enum(["bar", "line"]), values: z.array(z.number()).min(2).max(24), x: Px, y: Px, w: z.number().positive(), h: z.number().positive(), color: Color.default("accent") });
export const CursorProps = z.object({ x: Px, y: Px, size: z.number().min(8).max(200).default(28), color: Color.default("text") });

const PROPS = { text: TextProps, shape: ShapeProps, image: MediaProps, video: MediaProps, mask: MaskProps, group: GroupProps, chart: ChartProps, cursor: CursorProps } as const;

export const Element = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    kind: z.enum(ELEMENT_KINDS),
    /** A group or mask this element sits in; null for a root element. A mask clips its children. */
    parent: z.string().nullable().default(null),
    props: z.record(z.unknown()),
    timeline: Timeline,
    stagger: Stagger.optional(),
    /** Names of template parameters that fill props of this element: { prop: parameter } (for example { text: "headline_text" }). */
    bindings: z.record(z.string()).default({}),
  })
  .superRefine((e, ctx) => {
    const r = PROPS[e.kind].safeParse(e.props);
    if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: "custom", path: ["props", ...i.path], message: `${e.kind} ${e.id}: ${i.message}` });
    if (e.stagger && e.kind !== "text") ctx.addIssue({ code: "custom", path: ["stagger"], message: `${e.id}: only a text element staggers` });
  });
export type Element = z.infer<typeof Element>;

/** A camera over the whole scene: x/y pan in pixels, scale is zoom, rotate in degrees. */
export const CameraRig = z.object({ timeline: Timeline.extend({ tracks: z.array(Track.extend({ property: z.enum(["x", "y", "scale", "rotate"]) })).max(4) }) });

export const SceneGraphV2 = z
  .object({
    format: z.literal(SCENE_GRAPH_V2),
    format_version: z.literal(2),
    canvas: z.object({ width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096), fps: z.number().positive().max(120) }),
    duration_s: z.number().positive().max(60),
    elements: z.array(Element).min(1).max(120),
    camera: CameraRig.optional(),
  })
  .superRefine((g, ctx) => {
    const byId = new Map<string, Element>();
    for (const e of g.elements) {
      if (byId.has(e.id)) ctx.addIssue({ code: "custom", path: ["elements"], message: `duplicate element ${e.id}` });
      byId.set(e.id, e);
    }
    for (const e of g.elements) {
      if (e.parent !== null) {
        const p = byId.get(e.parent);
        if (!p) ctx.addIssue({ code: "custom", path: ["elements"], message: `${e.id} names a parent ${e.parent} that does not exist` });
        else if (p.kind !== "group" && p.kind !== "mask") ctx.addIssue({ code: "custom", path: ["elements"], message: `${e.id}'s parent ${e.parent} is a ${p.kind}, not a group or mask` });
      }
      const seen = new Set([e.id]);
      for (let c = e.parent ? byId.get(e.parent) : undefined; c; c = c.parent ? byId.get(c.parent) : undefined) {
        if (seen.has(c.id)) { ctx.addIssue({ code: "custom", path: ["elements"], message: `${e.id} is inside a parent cycle` }); break; }
        seen.add(c.id);
      }
      e.timeline.tracks.forEach((t) => {
        t.keyframes.forEach((k, i) => { if (i > 0 && k.at < t.keyframes[i - 1]!.at) ctx.addIssue({ code: "custom", path: ["elements"], message: `${e.id}.${t.property}: keyframes are not in order` }); });
      });
    }
  });
export type SceneGraphV2 = z.infer<typeof SceneGraphV2>;

/** The scene-graph engine is off unless SCENE_GRAPH=on. Anything else, including unset, is off. */
export const sceneGraphEnabled = (env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env): boolean => env["SCENE_GRAPH"] === "on";
