import type { Composition, CompEasing, SceneGraphV2, SgEasing } from "@digikon/contracts";
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

/**
 * The named easings of the richer motion fields (contracts COMP_EASINGS), as the v2 engine's own easing values. The numbers live here, not in the plan: a Director can only name a curve.
 * `spring` is the same spring the entrances use.
 */
const NAMED: Record<CompEasing, Easing> = {
  ease_out: "ease_out",
  ease_in_out: "ease_in_out",
  spring,
  spring_soft: { spring: { damping: 18, stiffness: 90, mass: 1, overshoot_clamp: false } },
  spring_bouncy: { spring: { damping: 9, stiffness: 150, mass: 1, overshoot_clamp: false } },
  bezier_smooth: { bezier: [0.4, 0, 0.2, 1] },
  bezier_swift: { bezier: [0.2, 0.9, 0.1, 1] },
  bezier_snap: { bezier: [0.7, 0, 0.3, 1] },
  bezier_overshoot: { bezier: [0.34, 1.56, 0.64, 1] },
  bezier_anticipate: { bezier: [0.36, 0, 0.66, -0.56] },
};

/** A Director's track as a v2 track: x and y are shares of the frame, so they become pixels; the keys run from 0 to 1 (a hold is added at an end that the keys do not reach). */
function trackOf(t: NonNullable<Comp["elements"][number]["tracks"]>[number], W: number, H: number): Track {
  const scale = t.property === "x" ? W : t.property === "y" ? H : 1;
  const keys = t.keys.map((k) => ({ at: k.t, value: k.value * scale, ...(k.easing ? { easing: NAMED[k.easing] } : {}) }));
  if (keys[0]!.at > 0) keys.unshift({ at: 0, value: keys[0]!.value });
  const last = keys[keys.length - 1]!;
  if (last.at < 1) keys.push({ at: 1, value: last.value });
  return { property: t.property, keyframes: keys, easing: "ease_out" };
}
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
    // Keyframed motion, when the Director wrote it: a track replaces the entrance's own track for that property; the entrance keeps animating the rest.
    if (e.tracks?.length) {
      const own = new Set(e.tracks.map((t) => t.property));
      for (let i = tracks.length - 1; i >= 0; i--) if (own.has(tracks[i]!.property as never)) tracks.splice(i, 1);
      for (const t of e.tracks) tracks.push(trackOf(t, W, H));
    }
    const pivot = e.pivot ? { pivot_x: e.pivot.x, pivot_y: e.pivot.y } : {};
    const timeline = { start_s: m.delay * D, duration_s: Math.max(0.05, m.duration * D), tracks };
    if (e.kind === "text") {
      const px = ((portrait && e.portrait?.size) || e.size) * short;
      return {
        id: e.id, kind: "text" as const, parent: null,
        props: { text: e.text, x, y, w, font_px: px, weight: e.weight, align: e.align, upper: e.upper, color: e.color, line_height: e.line_height, ...(e.font ? { font: e.font } : {}), ...pivot },
        timeline, ...(m.stagger ? { stagger: { unit: m.stagger.unit, each_s: Math.max(0.005, m.stagger.each * D), from: "start" as const } } : {}), bindings: {},
      };
    }
    return {
      id: e.id, kind: "shape" as const, parent: null,
      props: { shape: e.shape, x, y, w, h: (at.h ?? e.at.h) * H, ...(e.fill ? { fill: e.fill } : {}), ...(e.stroke ? { stroke: e.stroke } : {}), stroke_w: e.stroke_w * short, radius: e.radius * short, ...pivot },
      timeline, bindings: {},
    };
  });
  return { format: "digikon.scene-graph", format_version: 2, canvas: { width: W, height: H, fps: f.fps }, duration_s: D, elements } as SceneGraphV2;
}