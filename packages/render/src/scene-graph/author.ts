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
  /** Where each element sits in this frame, in pixels, with the portrait override applied. */
  const placeOf = (e: Comp["elements"][number]) => {
    const o = portrait ? e.portrait : undefined;
    const at = { ...e.at, ...(o ? Object.fromEntries(Object.entries(o).filter(([key, v]) => key !== "size" && v !== undefined)) : {}) } as { x: number; y: number; w?: number; h?: number };
    return { at, x: at.x * W, y: at.y * H, w: Math.max(1, (at.w ?? 0) * W) };
  };
  const origin = new Map(c.elements.map((e) => [e.id, placeOf(e)] as const));
  // A group's children arrive one after another: each child's start is pushed back by its place in the order times the group's `each`.
  const arrival = new Map<string, number>();
  for (const g of c.elements) {
    if (g.kind !== "group" || !g.stagger_children) continue;
    const kids = c.elements.filter((k) => "parent" in k && k.parent === g.id);
    const n = kids.length, from = g.stagger_children.from ?? "start";
    const order = from === "start" ? kids.map((_, i) => i) : from === "end" ? kids.map((_, i) => n - 1 - i) : kids.map((_, i) => i).sort((a, b) => Math.abs(a - (n - 1) / 2) - Math.abs(b - (n - 1) / 2) || a - b);
    kids.forEach((k, i) => arrival.set(k.id, (from === "center" ? order.indexOf(i) : order[i]!) * g.stagger_children!.each * D));
  }
  const STILL = { enter: "none" as const, delay: 0, duration: 1, easing: "ease_out" as const, stagger: undefined };
  const built: Element[] = c.elements.map((e) => {
    const { at, x: ax, y: ay, w: aw } = placeOf(e);
    // a child's position is relative to its group in the engine; the plan keeps frame shares, so the group's own place is taken away here
    const po = "parent" in e && e.parent ? origin.get(e.parent) : undefined;
    const x = ax - (po?.x ?? 0), y = ay - (po?.y ?? 0), w = aw;
    const parent = "parent" in e && e.parent ? e.parent : null;
    const m = e.kind === "group" ? (e.motion ?? STILL) : e.motion;
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
    const pivot = "pivot" in e && e.pivot ? { pivot_x: e.pivot.x, pivot_y: e.pivot.y } : {};
    const timeline = { start_s: m.delay * D + (arrival.get(e.id) ?? 0), duration_s: e.kind === "group" && !e.motion ? D : Math.max(0.05, m.duration * D), tracks };
    if (e.kind === "text") {
      const px = ((portrait && e.portrait?.size) || e.size) * short;
      return {
        id: e.id, kind: "text" as const, parent,
        props: { text: e.text, x, y, w, font_px: px, weight: e.weight, align: e.align, upper: e.upper, color: e.color, line_height: e.line_height, ...(e.font ? { font: e.font } : {}), ...pivot },
        timeline, ...(m.stagger ? { stagger: { unit: m.stagger.unit, each_s: Math.max(0.005, m.stagger.each * D), from: "start" as const } } : {}), bindings: {},
      };
    }
    if (e.kind === "group") return { id: e.id, kind: "group" as const, parent: null, props: { x: ax, y: ay }, timeline, bindings: {} };
    if (e.kind === "image") return { id: e.id, kind: "image" as const, parent, props: { asset_ref: e.asset_ref, x, y, w, h: (at.h ?? e.at.h) * H, fit: e.fit ?? "contain", ...pivot }, timeline, bindings: {} };
    // A gradient or a glow is drawn by the richer drawing code; the first stop is kept as the solid fill, so a drawer that does not know them still shows the shape and legibility is checked against a real colour.
    const look = {
      ...(e.gradient ? { gradient: { type: e.gradient.type, angle: e.gradient.angle, stops: e.gradient.stops.map((s) => ({ at: s.at, color: s.color, ...(s.alpha !== undefined ? { alpha: s.alpha } : {}) })) } } : {}),
      ...(e.glow ? { glow: { color: e.glow.color, radius: e.glow.radius * short, strength: e.glow.strength } } : {}),
      ...(e.blend ? { blend: e.blend } : {}),
    };
    const fill = e.fill ?? e.gradient?.stops[0]?.color;
    return {
      id: e.id, kind: "shape" as const, parent,
      props: { shape: e.shape, x, y, w, h: (at.h ?? e.at.h) * H, ...(fill ? { fill } : {}), ...(e.stroke ? { stroke: e.stroke } : {}), stroke_w: e.stroke_w * short, radius: e.radius * short, ...pivot, ...look },
      timeline, bindings: {},
    };
  });
  // A reveal mask wraps its element: the mask clips a box and uncovers it from progress 0 to 1, so the element is fully shown when the reveal is over. The box is the Director's region
  // joined with the element's own box (text height is estimated generously), so it is never smaller than what it reveals and nothing is left cropped.
  const elements: Element[] = [];
  c.elements.forEach((src, i) => {
    const el = built[i]!;
    const rv = src.reveal;
    if (!rv) { elements.push(el); return; }
    const own = placeOf(src);
    const grow = src.kind === "shape" && src.glow ? src.glow.radius * short * 2 : 0;
    const ox = own.x, oy = own.y;
    let ow = 0, oh = 0;
    if (src.kind === "text") {
      const px = ((portrait && src.portrait?.size) || src.size) * short;
      const lines = Math.max(1, Math.ceil((Array.from(src.text).length * px * 0.62) / own.w));
      ow = own.w; oh = lines * px * src.line_height + px * 0.5;
    } else if (src.kind === "shape" || src.kind === "image") { ow = own.w; oh = (own.at.h ?? src.at.h) * H; }
    let x0 = ox - grow, y0 = oy - grow, x1 = ox + ow + grow, y1 = oy + oh + grow;
    if (rv.region) { x0 = Math.min(x0, rv.region.x * W); y0 = Math.min(y0, rv.region.y * H); x1 = Math.max(x1, (rv.region.x + rv.region.w) * W); y1 = Math.max(y1, (rv.region.y + rv.region.h) * H); }
    const holder = "parent" in src && src.parent ? origin.get(src.parent) : undefined;
    const delay = rv.delay ?? (src.kind === "group" ? src.motion?.delay : src.motion.delay) ?? 0;
    const mask: Element = {
      id: `${src.id}_mask`, kind: "mask", parent: el.parent,
      props: { reveal: rv.from, x: x0 - (holder?.x ?? 0), y: y0 - (holder?.y ?? 0), w: x1 - x0, h: y1 - y0 },
      timeline: { start_s: delay * D + (arrival.get(src.id) ?? 0), duration_s: Math.max(0.05, (rv.duration ?? 0.3) * D), tracks: [ramp("progress", 0, 1, NAMED[rv.easing ?? "ease_out"])] },
      bindings: {},
    };
    // the element now sits in the mask, so its position is taken from the mask's corner
    const props = el.props as Record<string, unknown>;
    props["x"] = ox - x0; props["y"] = oy - y0;
    elements.push(mask, { ...el, parent: mask.id });
  });
  return { format: "digikon.scene-graph", format_version: 2, canvas: { width: W, height: H, fps: f.fps }, duration_s: D, elements } as SceneGraphV2;
}