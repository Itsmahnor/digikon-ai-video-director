import type { SceneGraphV2, SgEasing } from "@digikon/contracts";
import type { z } from "zod";
import type { CompositionScene } from "../composition.js";

/**
 * Three of the fixed blocks (title_plate, quote_statement, closing_signature) expressed as scene graphs. A preset takes the block's planned scene, so
 * the sizes, wrapped lines and positions are the planner's own, and gives the same elements the block draws with the timing the block uses: each
 * element's slot is its share of the scene's active window (the first 70%, so the end is held), eased the way the film's motion says.
 * The block's text opacity is clamp(1.6 * k) and the graph reaches 1 at the same moment with a linear ramp, within a tolerance the parity test states.
 */

type Easing = z.infer<typeof SgEasing>;
type Geom = { top?: number; eyebrow?: { px: number; lines: string[] } | null; sub?: { px: number; lines: string[] } | null; mark?: unknown; by?: { px: number; lines: string[] } | null; head?: { px: number; lines: string[] } | null; action?: { px: number; lines: string[] } };

export const activeWindow = (frames: number, fps: number): number => { const T = frames / fps; return Math.max(0.5, Math.min(T * 0.7, T - 1)); };

export const easingOf = (m: CompositionScene["motion"]["easing"]): Easing =>
  m === "spring" ? { spring: { damping: 14, stiffness: 120, mass: 1, overshoot_clamp: false } } : m;

interface Slot { start_s: number; duration_s: number }
const slotter = (s: CompositionScene, fps: number) => {
  const active = activeWindow(s.frames, fps);
  return (start: number, dur: number): Slot => ({ start_s: start * active, duration_s: Math.max(0.01, Math.min(dur * s.motion.speed, 1 - start)) * active });
};

const key = (at: number, value: number) => ({ at, value });
/** Opacity that reaches full at the same moment clamp(k * mul) does for an out-cubic k, then holds. */
const fadeIn = (mul: number, easing: Easing) => {
  const stop = typeof easing === "string" && easing === "ease_out" ? 1 - Math.pow(1 - 1 / mul, 1 / 3) : 1 / mul;
  return { property: "opacity" as const, keyframes: [key(0, 0), key(Math.min(0.99, stop), 1), key(1, 1)], easing: "linear" as const };
};

type Draft = SceneGraphV2["elements"][number];
const text = (id: string, x: number, y: number, w: number, px: number, line_height: number, str: string, o: { align: "left" | "center"; color: "text" | "muted" | "accent"; upper?: boolean; bold: boolean; tracking?: number }, slot: Slot, tracks: Draft["timeline"]["tracks"], stagger?: Draft["stagger"]): Draft =>
  ({ id, kind: "text", parent: null, props: { text: str, x, y, w, font_px: px, line_height, align: o.align, color: o.color, upper: o.upper ?? false, weight: o.bold ? "bold" : "regular" }, timeline: { ...slot, tracks }, stagger, bindings: {} });

const wrap = (s: CompositionScene, fps: number, elements: Draft[]): SceneGraphV2 =>
  ({ format: "digikon.scene-graph", format_version: 2, canvas: { width: s.width, height: s.height, fps: fps }, duration_s: s.frames / (fps), elements });

export function titlePlatePreset(s: CompositionScene, fps = 30): SceneGraphV2 {
  const g = s.geom as Geom, h = s.headline!, at = slotter(s, fps), ez = easingOf(s.motion.easing);
  const bold = s.type.bold, f = h.font_px, hair = s.visual.block === "title_plate" && s.visual.plate === "hairline";
  const els: Draft[] = [];
  let y = g.top!;
  if (g.eyebrow) {
    els.push(text("eyebrow", h.box.x, y, h.box.w, g.eyebrow.px, 1.2, g.eyebrow.lines[0]!, { align: "center", color: "muted", upper: true, bold }, at(0, 0.3), [{ ...fadeIn(1 / 1, "linear"), keyframes: [key(0, 0), key(1, 1)], easing: ez }]));
    y += g.eyebrow.px * 2.4;
  }
  if (hair) y += 1 + f * 0.34;
  const ruleW = h.box.w * 0.46;
  const rule = (id: string, ry: number): Draft => ({ id, kind: "shape", parent: null, props: { shape: "rect", x: h.box.x + (h.box.w - ruleW) / 2, y: ry, w: ruleW, h: 1, fill: "text" }, timeline: { ...at(0.1, 0.5), tracks: [{ property: "w", keyframes: [key(0, 0), key(1, ruleW)], easing: ez }, { property: "x", keyframes: [key(0, ruleW / 2), key(1, 0)], easing: ez }] }, bindings: {} });
  if (hair) els.push(rule("rule_top", y - f * 0.34 - 1));
  const each = at(0.15, 0.55).start_s - at(0.05, 0.55).start_s;
  els.push(text("headline", h.box.x, y, h.box.w, f, 1.14, h.lines.join("\n"), { align: "center", color: "text", bold }, at(0.05, 0.55),
    [fadeIn(1.6, ez), { property: "y", keyframes: [key(0, f * 0.12), key(1, 0)], easing: ez }, { property: "tracking", keyframes: [key(0, 0.09), key(1, 0)], easing: ez }], { unit: "line", each_s: each, from: "start" }));
  y += h.lines.length * f * 1.14;
  if (hair) els.push(rule("rule_bottom", y + f * 0.34 - 1));
  if (g.sub) els.push(text("subline", h.box.x, y + g.sub.px * 1.2, h.box.w * 1, g.sub.px, 1.3, g.sub.lines.join("\n"), { align: "center", color: "muted", bold: false }, at(0.45, 0.35), [{ property: "opacity", keyframes: [key(0, 0), key(1, 1)], easing: ez }]));
  return wrap(s, fps, els);
}

export function quoteStatementPreset(s: CompositionScene, fps = 30): SceneGraphV2 {
  const g = s.geom as Geom & { mark: number }, h = s.headline!, at = slotter(s, fps), ez = easingOf(s.motion.easing), f = h.font_px, bold = s.type.bold;
  const els: Draft[] = [];
  els.push(text("mark", h.box.x, h.box.y, h.box.w, g.mark, 0.6, "â€œ", { align: "left", color: "accent", bold: false }, at(0, 0.3), [{ property: "opacity", keyframes: [key(0, 0), key(1, 1)], easing: ez }]));
  const y = h.box.y + g.mark * 0.6;
  const each = at(0.2, 0.3).start_s - at(0.08, 0.3).start_s;
  els.push(text("quote", h.box.x, y, h.box.w, f, 1.22, h.lines.join("\n"), { align: "left", color: "text", bold }, at(0.08, 0.3),
    [fadeIn(1.5, ez), { property: "x", keyframes: [key(0, f * 0.4), key(1, 0)], easing: ez }], { unit: "line", each_s: each, from: "start" }));
  if (g.by) els.push(text("attribution", h.box.x, y + h.lines.length * f * 1.22 + g.by.px * 1.2, h.box.w, g.by.px, 1.2, `â€” ${g.by.lines[0]}`, { align: "left", color: "muted", bold: false }, at(0.65, 0.25), [{ property: "opacity", keyframes: [key(0, 0), key(1, 1)], easing: ez }]));
  return wrap(s, fps, els);
}

export function closingSignaturePreset(s: CompositionScene, fps = 30): SceneGraphV2 {
  const g = s.geom as Geom, at = slotter(s, fps), ez = easingOf(s.motion.easing), bold = s.type.bold, W = s.width;
  const els: Draft[] = [];
  const full = (id: string, y: number, ls: { px: number; lines: string[] }, lh: number, color: "text" | "muted" | "accent", b: boolean, slot: Slot, tracks: Draft["timeline"]["tracks"]) =>
    els.push(text(id, 0, y, W, ls.px, lh, ls.lines.join("\n"), { align: "center", color, bold: b }, slot, tracks));
  const fade: Draft["timeline"]["tracks"] = [{ property: "opacity", keyframes: [key(0, 0), key(1, 1)], easing: ez }];
  let y = g.top!;
  const m = g.mark as { px: number; lines: string[] } | null;
  if (m) {
    full("wordmark", y, m, 1.15, "text", bold, at(0, 0.6), [{ property: "opacity", keyframes: [key(0, 0), key(2 / 3, 1), key(1, 1)], easing: ez }, { property: "tracking", keyframes: [key(0, 0.14), key(1, 0.04)], easing: ez }]);
    y += m.lines.length * m.px * 1.15 + m.px * 0.3;
    const rw = W * 0.16;
    els.push({ id: "rule", kind: "shape", parent: null, props: { shape: "rect", x: (W - rw) / 2, y, w: rw, h: 1, fill: "accent" }, timeline: { ...at(0.2, 0.4), tracks: [{ property: "w", keyframes: [key(0, 0), key(1, rw)], easing: ez }, { property: "x", keyframes: [key(0, rw / 2), key(1, 0)], easing: ez }] }, bindings: {} });
    y += 1 + m.px * 0.3;
  }
  if (g.head) { full("line", y, g.head, 1.25, "text", false, at(0.3, 0.3), fade); y += g.head.lines.length * g.head.px * 1.25 + g.head.px * 0.8; }
  full("action", y, g.action!, 1.3, "accent", bold, at(0.5, 0.3), fade);
  y += g.action!.lines.length * g.action!.px * 1.3;
  if (g.sub) full("subline", y + g.sub.px, g.sub, 1.3, "muted", false, at(0.65, 0.25), fade);
  return wrap(s, fps, els);
}

/**
 * A scene the fixed blocks cannot express: a headline types in word by word, a bar grows under it, a shape is revealed through a mask that wipes in,
 * and a number counts up beside it, all on one timeline. Sizes follow the canvas, so it fits any frame.
 */
export function statRevealScene(opts: { width: number; height: number; fps?: number; duration_s?: number; headline: string; value: number; suffix?: string; label: string }): SceneGraphV2 {
  const { width: W, height: H } = opts, short = Math.min(W, H), fps = opts.fps ?? 30, dur = opts.duration_s ?? 4;
  const m = Math.round(short * 0.08), headPx = Math.round(short * 0.07), numPx = Math.round(short * 0.2), labPx = Math.round(short * 0.04);
  const portrait = H >= W * 0.95; // a square frame stacks the picture and the number, as a portrait one does
  const headW = W - 2 * m, headY = m + Math.round(short * 0.02);
  const heroY = headY + Math.round(headPx * 2.8) , barW = Math.round(headW * 0.5);
  const maskW = portrait ? headW : Math.round(headW * 0.46), maskH = Math.round(short * 0.22);
  const numY = heroY + (portrait ? maskH + Math.round(short * 0.04) : 0), numX = portrait ? m : m + maskW + Math.round(short * 0.06);
  const numW = portrait ? headW : headW - maskW - Math.round(short * 0.06);
  const outCubic = "ease_out" as const;
  const spr = { spring: { damping: 14, stiffness: 110, mass: 1, overshoot_clamp: false } };
  const K = (a: number, v: number) => ({ at: a, value: v });
  const els: Draft[] = [
    { id: "headline", kind: "text", parent: null, props: { text: opts.headline, x: m, y: headY, w: headW, font_px: headPx, line_height: 1.15, align: "left", color: "text", weight: "bold", upper: false }, stagger: { unit: "word", each_s: 0.12, from: "start" },
      timeline: { start_s: 0.1, duration_s: 0.6, tracks: [{ property: "opacity", keyframes: [K(0, 0), K(0.5, 1), K(1, 1)], easing: "linear" }, { property: "y", keyframes: [K(0, headPx * 0.4), K(1, 0)], easing: spr }] }, bindings: { text: "headline_text" } },
    { id: "bar", kind: "shape", parent: null, props: { shape: "rect", x: m, y: heroY - Math.round(short * 0.025), w: barW, h: Math.max(3, Math.round(short * 0.006)), fill: "accent" }, timeline: { start_s: 0.9, duration_s: 0.7, tracks: [{ property: "w", keyframes: [K(0, 0), K(1, barW)], easing: { bezier: [0.22, 1, 0.36, 1] } }] }, bindings: {} },
    { id: "reveal", kind: "mask", parent: null, props: { reveal: "left", x: m, y: heroY, w: maskW, h: maskH }, timeline: { start_s: 1.2, duration_s: 0.9, tracks: [{ property: "progress", keyframes: [K(0, 0), K(1, 1)], easing: { bezier: [0.65, 0, 0.35, 1] } }] }, bindings: {} },
    { id: "panel", kind: "shape", parent: "reveal", props: { shape: "rect", x: 0, y: 0, w: maskW, h: maskH, fill: "surface", radius: Math.round(short * 0.02) }, timeline: { start_s: 1.2, duration_s: 0.9, tracks: [] }, bindings: {} },
    { id: "dot", kind: "shape", parent: "reveal", props: { shape: "ellipse", x: Math.round(maskW * 0.5 - maskH * 0.2), y: Math.round(maskH * 0.1), w: Math.round(maskH * 0.4), h: Math.round(maskH * 0.4), fill: "accent" }, timeline: { start_s: 1.2, duration_s: 0.9, tracks: [{ property: "scale", keyframes: [K(0, 0.6), K(1, 1)], easing: spr }] }, bindings: {} },
    { id: "number", kind: "text", parent: null, props: { text: String(opts.value), x: numX, y: numY, w: numW, font_px: numPx, line_height: 1, align: "left", color: "accent", weight: "bold", upper: false, counter: { from: 0, to: opts.value, decimals: Number.isInteger(opts.value) ? 0 : 1, prefix: "", suffix: opts.suffix ?? "" } },
      timeline: { start_s: 1.4, duration_s: 1.4, tracks: [{ property: "progress", keyframes: [K(0, 0), K(1, 1)], easing: outCubic }, { property: "opacity", keyframes: [K(0, 0), K(0.1, 1), K(1, 1)], easing: "linear" }] }, bindings: { counter: "stat_value" } },
    { id: "label", kind: "text", parent: null, props: { text: opts.label, x: numX, y: numY + numPx + Math.round(short * 0.01), w: numW, font_px: labPx, line_height: 1.25, align: "left", color: "muted", weight: "regular", upper: false },
      timeline: { start_s: 2.2, duration_s: 0.5, tracks: [{ property: "opacity", keyframes: [K(0, 0), K(1, 1)], easing: outCubic }] }, bindings: { text: "stat_label" } },
  ];
  return { format: "digikon.scene-graph", format_version: 2, canvas: { width: W, height: H, fps }, duration_s: dur, elements: els,
    camera: { timeline: { start_s: 0, duration_s: dur, tracks: [{ property: "scale", keyframes: [K(0, 1), K(1, 1.04)], easing: "linear" }] } } };
}





