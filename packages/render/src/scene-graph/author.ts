import type { Composition, SceneGraphV2, SgEasing } from "@digikon/contracts";
import type { z } from "zod";

/**
 * Turns a composition (what the Director wrote: elements placed as shares of the frame, with their own type, colour and motion) into a scene graph in pixels for one frame
 * size. Nothing is chosen here: positions, sizes, delays and durations are the plan's, scaled; the only decisions are how a named arrival (fade, rise, wipe ...) becomes
 * keyframes. The scene graph is then validated like any other before it can be drawn.
 */
type Comp = z.infer<typeof Composition>;
type Easing = z.infer<typeof SgEasing>;
type Element = SceneGraphV2["elements"][number];
type Track = Element["timeline"]["tracks"][number];

export interface AuthorFrame { width: number; height: number; fps: number; duration_s: number }

const spring: Easing = { spring: { damping: 14, stiffness: 120, mass: 1, overshoot_clamp: true } };
const easingOf = (e: "ease_out" | "ease_in_out" | "spring"): Easing => (e === "spring" ? spring : e);
const k = (at: number, value: number) => ({ at, value });
const ramp = (property: Track["property"], from: number, to: number, easing: Easing): Track => ({ property, keyframes: [k(0, from), k(1, to)], easing });

export function authorGraph(c: Comp, f: AuthorFrame): SceneGraphV2 {
  const { width: W, height: H } = f, short = Math.min(W, H), portrait = H >= W, D = f.duration_s;
  const elements: Element[] = c.elements.map((e) => {
    const o = portrait ? e.portrait : undefined;
    const at = { ...e.at, ...(o ? Object.fromEntries(Object.entries(o).filter(([key, v]) => key !== "size" && v !== undefined)) : {}) } as { x: number; y: number; w: number; h?: number };
    const x = at.x * W, y = at.y * H, w = Math.max(1, at.w * W);
    const m = e.motion;
    const ease = easingOf(m.easing);
    const tracks: Track[] = [];
    const dy = 0.045 * H, dx = 0.07 * W;
    const target = e.kind === "shape" ? e.opacity : 1;
    switch (m.enter) {
      case "none": if (target < 1) tracks.push(ramp("opacity", target, target, "linear")); break;
      case "fade": tracks.push(ramp("opacity", 0, target, "ease_out")); break;
      case "rise": tracks.push(ramp("opacity", 0, target, "ease_out"), ramp("y", dy, 0, ease)); break;
      case "drop": tracks.push(ramp("opacity", 0, target, "ease_out"), ramp("y", -dy, 0, ease)); break;
      case "slide_left": tracks.push(ramp("opacity", 0, target, "ease_out"), ramp("x", dx, 0, ease)); break;
      case "slide_right": tracks.push(ramp("opacity", 0, target, "ease_out"), ramp("x", -dx, 0, ease)); break;
      case "scale_in": tracks.push(ramp("opacity", 0, target, "ease_out"), ramp("scale", 0.9, 1, ease)); break;
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
        id: e.id, kind: "text" as const, parent: null,
        props: { text: e.text, x, y, w, font_px: px, weight: e.weight, align: e.align, upper: e.upper, color: e.color, line_height: e.line_height, ...(e.font ? { font: e.font } : {}) },
        timeline, ...(m.stagger ? { stagger: { unit: m.stagger.unit, each_s: Math.max(0.005, m.stagger.each * D), from: "start" as const } } : {}), bindings: {},
      };
    }
    return {
      id: e.id, kind: "shape" as const, parent: null,
      props: { shape: e.shape, x, y, w, h: (at.h ?? e.at.h) * H, ...(e.fill ? { fill: e.fill } : {}), ...(e.stroke ? { stroke: e.stroke } : {}), stroke_w: e.stroke_w * short, radius: e.radius * short },
      timeline, bindings: {},
    };
  });
  return { format: "digikon.scene-graph", format_version: 2, canvas: { width: W, height: H, fps: f.fps }, duration_s: D, elements } as SceneGraphV2;
}