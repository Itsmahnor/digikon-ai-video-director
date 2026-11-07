import type { Composition, SceneGraphV2, SgEasing } from "@digikon/contracts";
import type { z } from "zod";
import type { TextMeter } from "../font-metrics.js";
import { wrapMeasured } from "../layout.js";

/**
 * Turns a composition (what the Director wrote: elements placed as shares of the frame, with their own type, colour and motion) into a scene graph in pixels for one frame
 * size. Nothing is chosen here: positions, sizes, delays and durations are the plan's, scaled; the only decisions are how a named arrival (fade, rise, wipe, pop ...) becomes
 * keyframes. The scene graph is then validated like any other before it can be drawn.
 *
 * Groups and masks are containers. An element that names one as its parent keeps its position as a share of the frame in the plan; here it is turned into a position relative to
 * the container, which is how the scene graph (and the renderers) place children.
 */
type Comp = z.infer<typeof Composition>;
type Easing = z.infer<typeof SgEasing>;
type Element = SceneGraphV2["elements"][number];
type Track = Element["timeline"]["tracks"][number];
type CompEl = Comp["elements"][number];
type EaseName = CompEl["motion"]["easing"];

/**
 * `meter`: when given, each text is broken into lines at its box width with the same measure the validator uses. The scene-graph renderers draw text as given (white-space: pre), so a
 * text without explicit line breaks is ONE line however wide it is. Without this, the validator judged a headline as wrapped over three lines while the render drew it on one line
 * under a neighbouring card.
 */
export interface AuthorFrame { width: number; height: number; fps: number; duration_s: number; meter?: TextMeter }

const spring: Easing = { spring: { damping: 14, stiffness: 120, mass: 1, overshoot_clamp: true } };
const bouncy: Easing = { spring: { damping: 8, stiffness: 150, mass: 1, overshoot_clamp: false } };
/** The named easings the Director may use. The curves are standard ones: snappy starts fast and settles; soft eases both ends; back_out overshoots a little and returns. */
const EASINGS: Record<EaseName, Easing> = {
  ease_out: "ease_out", ease_in_out: "ease_in_out", spring,
  snappy: { bezier: [0.2, 0.9, 0.1, 1] }, soft: { bezier: [0.4, 0, 0.2, 1] }, back_out: { bezier: [0.34, 1.56, 0.64, 1] }, bouncy,
};
const easingOf = (e: EaseName): Easing => EASINGS[e];
const k = (at: number, value: number) => ({ at, value });
const ramp = (property: Track["property"], from: number, to: number, easing: Easing): Track => ({ property, keyframes: [k(0, from), k(1, to)], easing });

export function authorGraph(c: Comp, f: AuthorFrame): SceneGraphV2 {
  const { width: W, height: H } = f, short = Math.min(W, H), portrait = H >= W, D = f.duration_s;
  const placeOf = (e: CompEl) => {
    const o = portrait && (e.kind === "text" || e.kind === "shape") ? e.portrait : undefined;
    return { ...e.at, ...(o ? Object.fromEntries(Object.entries(o).filter(([key, v]) => key !== "size" && v !== undefined)) : {}) } as { x: number; y: number; w?: number; h?: number };
  };
  // where each container's own origin sits, in frame pixels: children are placed relative to it
  const origin = new Map<string, { x: number; y: number }>();
  for (const e of c.elements) if (e.kind === "group" || e.kind === "mask") { const a = placeOf(e); origin.set(e.id, { x: a.x * W, y: a.y * H }); }
  const elements: Element[] = c.elements.map((e) => {
    const at = placeOf(e);
    const parentId = (e.kind === "text" || e.kind === "shape") && e.parent && origin.has(e.parent) ? e.parent : null;
    const po = parentId ? origin.get(parentId)! : { x: 0, y: 0 };
    const x = at.x * W - po.x, y = at.y * H - po.y, w = Math.max(1, (at.w ?? 0) * W);
    const m = e.motion;
    const ease = easingOf(m.easing);
    const tracks: Track[] = [];
    const dy = 0.045 * H, dx = 0.07 * W;
    const target = e.kind === "shape" ? e.opacity : 1;
    const isText = e.kind === "text";
    if (e.kind === "mask") {
      // a mask reveals its children through a moving edge; the arrival is the reveal
      tracks.push(ramp("progress", 0, 1, ease));
    } else switch (m.enter) {
      case "none": if (target < 1) tracks.push(ramp("opacity", target, target, "linear")); break;
      case "fade": tracks.push(ramp("opacity", 0, target, "ease_out")); break;
      case "rise": tracks.push(ramp("opacity", 0, target, "ease_out"), ramp("y", dy, 0, ease)); break;
      case "drop": tracks.push(ramp("opacity", 0, target, "ease_out"), ramp("y", -dy, 0, ease)); break;
      case "slide_left": tracks.push(ramp("opacity", 0, target, "ease_out"), ramp("x", dx, 0, ease)); break;
      case "slide_right": tracks.push(ramp("opacity", 0, target, "ease_out"), ramp("x", -dx, 0, ease)); break;
      case "scale_in": tracks.push(ramp("opacity", 0, target, "ease_out"), ramp("scale", 0.9, 1, ease)); break;
      case "pop": tracks.push(ramp("opacity", 0, target, "ease_out"), ramp("scale", 0.55, 1, bouncy)); break;
      case "zoom_out": tracks.push(ramp("opacity", 0, target, "ease_out"), ramp("scale", 1.18, 1, ease)); break;
      case "rotate_in": tracks.push(ramp("opacity", 0, target, "ease_out"), ramp("rotate", -6, 0, ease), ramp("y", dy * 0.6, 0, ease)); break;
      case "tracking_in":
        // letters start spread wide and close up as the text fades in; anything that is not text just fades
        tracks.push(ramp("opacity", 0, target, "ease_out"));
        if (isText) tracks.push(ramp("tracking", 0.18, 0, ease));
        break;
      case "wipe":
        // a shape draws itself across; text and anything else slides in a little and fades
        if (e.kind === "shape") tracks.push(ramp("w", 0, e.shape === "line" ? w : w, ease), ramp("opacity", target, target, "linear"));
        else tracks.push(ramp("opacity", 0, 1, "ease_out"), ramp("x", -dx * 0.5, 0, ease));
        break;
    }
    const timeline = { start_s: m.delay * D, duration_s: Math.max(0.05, m.duration * D), tracks };
    if (e.kind === "text") {
      const px = ((portrait && e.portrait?.size) || e.size) * short;
      return {
        id: e.id, kind: "text" as const, parent: parentId,
        props: { text: f.meter ? wrapMeasured(e.text, f.meter, px, w, { upper: e.upper, bold: e.weight !== "regular" }, false).lines.join(String.fromCharCode(10)) : e.text, x, y, w, font_px: px, weight: e.weight, align: e.align, upper: e.upper, color: e.color, line_height: e.line_height, ...(e.font ? { font: e.font } : {}) },
        timeline, ...(m.stagger ? { stagger: { unit: m.stagger.unit, each_s: Math.max(0.005, m.stagger.each * D), from: m.stagger.from ?? ("start" as const) } } : {}), bindings: {},
      };
    }
    if (e.kind === "group") return { id: e.id, kind: "group" as const, parent: null, props: { x: at.x * W, y: at.y * H }, timeline, bindings: {} };
    if (e.kind === "mask") return { id: e.id, kind: "mask" as const, parent: null, props: { reveal: e.reveal, x: at.x * W, y: at.y * H, w, h: (at.h ?? 0) * H }, timeline, bindings: {} };
    return {
      id: e.id, kind: "shape" as const, parent: parentId,
      props: { shape: e.shape, x, y, w, h: (at.h ?? e.at.h) * H, ...(e.fill ? { fill: e.fill } : {}), ...(e.stroke ? { stroke: e.stroke } : {}), stroke_w: e.stroke_w * short, radius: e.radius * short },
      timeline, bindings: {},
    };
  });
  // drawing order is the order the Director wrote; a container is drawn where it is listed, and the structure check requires it to come before its children
  return { format: "digikon.scene-graph", format_version: 2, canvas: { width: W, height: H, fps: f.fps }, duration_s: D, elements } as SceneGraphV2;
}
