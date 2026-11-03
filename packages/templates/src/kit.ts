import { LibraryTemplate, type SceneGraphV2, type SgEasing, type TemplateCategory } from "@digikon/contracts";
import { ESTIMATE_METER, wrapMeasured } from "@digikon/render";
import type { z } from "zod";

/**
 * The authoring kit. A family builder describes one scene design with the helpers below and never writes pixels by hand; the kit turns a Style
 * (palette, type pairing, motion personality, alignment, backdrop, stagger, camera) into scene-graph elements for any frame, wraps text with the same
 * measuring the validator uses, and fits a stagger into the time the scene has. Everything is a pure function of its inputs: no clock, no randomness
 * outside the seeded variant picker in expand.ts.
 */

export type Aspect = "16:9" | "9:16" | "1:1";
export const ASPECTS: readonly Aspect[] = ["16:9", "9:16", "1:1"];
export const CANVAS: Record<Aspect, { width: number; height: number }> = { "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 }, "1:1": { width: 1080, height: 1080 } };
export const FPS = 30;

export type Color = "text" | "muted" | "accent" | "accent_2" | "surface" | "background";
export type Role = "display" | "body" | "mono";
export type Align = "left" | "center" | "right";
export type Draft = SceneGraphV2["elements"][number];
type Easing = z.infer<typeof SgEasing>;
type Track = Draft["timeline"]["tracks"][number];

// ---------------------------------------------------------------- style axes
export interface PaletteDef { name: string; mood: string; background: string; surface: string; text: string; muted: string; accent: string; accent_2: string }
export const PALETTES: readonly PaletteDef[] = [
  { name: "paper", mood: "light warm paper, editorial", background: "#f6f2ea", surface: "#ffffff", text: "#1b2230", muted: "#5d6678", accent: "#b8430a", accent_2: "#1f6f58" },
  { name: "ink", mood: "dark ink with amber, confident", background: "#0e1116", surface: "#1b212b", text: "#f2f4f8", muted: "#a3acbb", accent: "#ffb454", accent_2: "#5ad1b0" },
  { name: "midnight", mood: "deep navy with coral, corporate-tech", background: "#0b1f3a", surface: "#16335c", text: "#eef3fb", muted: "#a9b8d0", accent: "#ff8a66", accent_2: "#7bd3f7" },
  { name: "forest", mood: "deep green with gold, natural, premium", background: "#10281f", surface: "#1a3d2f", text: "#eef6f1", muted: "#a8c2b5", accent: "#f4c95d", accent_2: "#7fd6a1" },
  { name: "plum", mood: "dark plum with pink, playful, bold", background: "#2a1233", surface: "#3d1c4a", text: "#fbf1ff", muted: "#cdb3de", accent: "#ff9ecb", accent_2: "#ffd36e" },
  { name: "clay", mood: "light clay and terracotta, warm, human", background: "#efe3d3", surface: "#fbf5ec", text: "#2b1d14", muted: "#66503f", accent: "#a1330f", accent_2: "#226468" },
  { name: "graphite", mood: "near-black with acid yellow, edgy, high energy", background: "#161616", surface: "#262626", text: "#ffffff", muted: "#b8b8b8", accent: "#e8ff59", accent_2: "#59e8ff" },
  { name: "sky", mood: "light sky blue, clean, friendly, software", background: "#e8f1fb", surface: "#ffffff", text: "#0e2540", muted: "#46607e", accent: "#0b5fd1", accent_2: "#b8400b" },
];

export interface Pairing { name: string; type_personality: "editorial" | "technical" | "plain" | "mixed"; display: string; body: string; mono: string; words: string }
const SANS = "sans-serif", SERIF = "EB Garamond", MONO = "JetBrains Mono";
export const PAIRINGS: readonly Pairing[] = [
  { name: "editorial", type_personality: "editorial", display: SERIF, body: SANS, mono: MONO, words: "serif display headlines over clean sans body" },
  { name: "technical", type_personality: "technical", display: MONO, body: SANS, mono: MONO, words: "monospace display, engineered, developer-tool feel" },
  { name: "plain", type_personality: "plain", display: SANS, body: SANS, mono: MONO, words: "plain sans throughout, neutral" },
  { name: "serif", type_personality: "editorial", display: SERIF, body: SERIF, mono: MONO, words: "all-serif, literary, premium" },
  { name: "mixed", type_personality: "mixed", display: SANS, body: SERIF, mono: MONO, words: "bold sans headlines with serif body, contrast" },
];

export interface MotionDef { name: "snappy" | "bouncy" | "smooth" | "mechanical" | "cinematic"; ease: Easing; dur: number; each: number; travel: number; pace: "slow" | "medium" | "fast"; words: string }
export const MOTIONS: readonly MotionDef[] = [
  { name: "snappy", ease: { bezier: [0.22, 1, 0.36, 1] }, dur: 0.5, each: 0.07, travel: 0.05, pace: "fast", words: "snappy fast-out motion" },
  { name: "bouncy", ease: { spring: { damping: 9, stiffness: 140, mass: 1, overshoot_clamp: false } }, dur: 0.75, each: 0.09, travel: 0.07, pace: "medium", words: "springy bouncy playful motion" },
  { name: "smooth", ease: "ease_in_out", dur: 0.85, each: 0.12, travel: 0.04, pace: "medium", words: "smooth even motion" },
  { name: "mechanical", ease: "linear", dur: 0.4, each: 0.05, travel: 0.03, pace: "fast", words: "linear mechanical machine-like motion" },
  { name: "cinematic", ease: { bezier: [0.65, 0, 0.35, 1] }, dur: 1.1, each: 0.18, travel: 0.03, pace: "slow", words: "slow cinematic deliberate motion" },
];

export const BACKDROPS = ["none", "band", "corner", "grid", "frame", "orb", "stripes"] as const;
export type Backdrop = (typeof BACKDROPS)[number];
export const CAMERAS = ["none", "push", "pull", "drift"] as const;
export type CameraMove = (typeof CAMERAS)[number];
export type StaggerUnit = "line" | "word" | "char";

export interface Style { palette: PaletteDef; pairing: Pairing; motion: MotionDef; align: Align; flip: boolean; backdrop: Backdrop; stagger: StaggerUnit; camera: CameraMove }
export const AXES = ["palette", "pairing", "motion", "align", "flip", "backdrop", "stagger", "camera"] as const;
export type Axis = (typeof AXES)[number];
export const axisValue = (s: Style, a: Axis): string => (a === "palette" ? s.palette.name : a === "pairing" ? s.pairing.name : a === "motion" ? s.motion.name : a === "flip" ? (s.flip ? "flip" : "plain") : String(s[a]));

// ---------------------------------------------------------------- frame
export interface Frame { aspect: Aspect; W: number; H: number; short: number; portrait: boolean; square: boolean; wide: boolean; m: number }
export function frameOf(aspect: Aspect): Frame {
  const { width: W, height: H } = CANVAS[aspect], short = Math.min(W, H);
  return { aspect, W, H, short, portrait: H > W, square: H === W, wide: W > H, m: Math.round(short * 0.08) };
}

// ---------------------------------------------------------------- family definition
export interface SlotDef { name: string; role: "headline" | "subline" | "label" | "number" | "caption" | "name" | "item"; max_chars: number; example: string; required?: boolean }
export interface FamilyDef {
  id: string;
  category: TemplateCategory;
  archetype: string;
  title: string;
  description: string;
  /** Plain words a director would search with. */
  retrieval: string;
  mood: string[]; tone: string[]; industry?: string[];
  energy: "low" | "medium" | "high";
  slots: SlotDef[];
  duration_s: number;
  /** Which style axes this design can vary without breaking. */
  axes: readonly Axis[];
  base?: Partial<Style>;
  needs_media?: ("none" | "image" | "video")[];
  build(c: Ctx): void;
}

// ---------------------------------------------------------------- build context
export type Enter = "rise" | "drop" | "left" | "right" | "fade" | "pop" | "zoom" | "track" | "none";
export interface TOpts { id: string; slot: string; x: number; y: number; w: number; px: number; role?: Role; color?: Color; bold?: boolean; upper?: boolean; align?: Align; lh?: number; at: number; enter?: Enter; stagger?: StaggerUnit | "auto" | false; maxLines?: number; dur?: number; counter?: { to: number; decimals?: number; prefix?: string; suffix?: string }; text?: string; parent?: string | null; minPx?: number; bind?: boolean }
export interface SOpts { id: string; shape: "rect" | "ellipse" | "line"; x: number; y: number; w: number; h: number; fill?: Color; stroke?: Color; stroke_w?: number; radius?: number; at: number; dur?: number; enter?: Enter | "grow_x" | "grow_x_c" | "grow_x_r" | "grow_y" | "grow_y_up"; opacity?: number; parent?: string | null; tracks?: Track[]; ease?: Easing }

export type BlockItem = (Omit<TOpts, "x" | "y" | "w"> & { x?: number; w?: number; gapBefore?: number }) | { id?: string; h: number; gapBefore?: number; make(y: number, x: number, w: number): void };

const K = (at: number, value: number, easing?: Easing) => (easing ? { at, value, easing } : { at, value });

export class Ctx {
  readonly els: Draft[] = [];
  camera: SceneGraphV2["camera"];
  readonly D: number;
  readonly slotText: Record<string, string>;
  constructor(readonly f: Frame, readonly s: Style, readonly fam: FamilyDef) {
    this.D = fam.duration_s;
    this.slotText = Object.fromEntries(fam.slots.map((x) => [x.name, x.example]));
  }
  get ez(): Easing { return this.s.motion.ease; }
  /** Seconds at which the last text must be fully shown to leave the hold the validator asks for. */
  get lastStart(): number { return this.D - 0.95; }
  /** x of a block of width w placed at the style's alignment. */
  ax(w: number): number { const { W, m } = this.f; return this.s.align === "left" ? m : this.s.align === "right" ? W - m - w : Math.round((W - w) / 2); }
  /** An x that follows the style's flip: `x` as drawn when not flipped, mirrored across the frame when flipped. */
  fx(x: number, w: number): number { return this.s.flip ? this.f.W - x - w : x; }
  textAlign(): Align { return this.s.align; }
  measure(text: string, px: number, w: number, o: { bold?: boolean; upper?: boolean } = {}): { lines: string[]; width: number } {
    const r = wrapMeasured(text, ESTIMATE_METER, px, w, { upper: o.upper ?? false, bold: o.bold ?? true }, false);
    return { lines: r.lines, width: r.width };
  }
  /** Largest px at or below `px` with at most `maxLines` lines and no word wider than the box. */
  fit(text: string, px: number, w: number, maxLines: number, o: { bold?: boolean; upper?: boolean } = {}, minPx = 0): number {
    let p = px;
    for (let i = 0; i < 40; i++) {
      const r = this.measure(text, p, w, o);
      if (r.lines.length <= maxLines && r.width <= w + 0.5) return p;
      if (p * 0.94 < Math.max(minPx, 8)) break;
      p = Math.round(p * 0.94);
    }
    return p;
  }

  enterTracks(kind: Enter, travelMul = 1): Track[] {
    const m = this.s.motion, d = Math.round(this.f.short * m.travel * travelMul);
    const fade: Track = { property: "opacity", keyframes: [K(0, 0), K(0.55, 1), K(1, 1)], easing: "ease_out" };
    const mv = (property: "x" | "y" | "scale" | "tracking", from: number, to: number): Track => ({ property, keyframes: [K(0, from), K(1, to)], easing: this.ez });
    switch (kind) {
      case "rise": return [fade, mv("y", d, 0)];
      case "drop": return [fade, mv("y", -d, 0)];
      case "left": return [fade, mv("x", -d * 1.6, 0)];
      case "right": return [fade, mv("x", d * 1.6, 0)];
      case "fade": return [{ property: "opacity", keyframes: [K(0, 0), K(1, 1)], easing: "ease_out" }];
      case "pop": return [fade, mv("scale", 0.7, 1)];
      case "zoom": return [fade, mv("scale", 1.2, 1)];
      case "track": return [fade, mv("tracking", 0.22, 0)];
      default: return [];
    }
  }

  /** The height a text would occupy (and the size it would be set at) without adding it, so a builder can centre a block before placing it. */
  th(o: Pick<TOpts, "slot" | "w" | "px" | "role" | "bold" | "upper" | "lh" | "maxLines" | "text" | "counter" | "minPx">): { h: number; px: number; lines: number } {
    const role = o.role ?? "body", bold = o.bold ?? role !== "body", upper = o.upper ?? false, lh = o.lh ?? 1.15;
    const shown = o.counter ? `${o.counter.prefix ?? ""}${o.counter.to.toFixed(o.counter.decimals ?? 0)}${o.counter.suffix ?? ""}` : (o.text ?? this.slotText[o.slot] ?? "");
    const px = o.maxLines && !o.counter ? this.fit(shown, o.px, o.w, o.maxLines, { bold, upper }, o.minPx ?? 0) : o.px;
    const lines = o.counter ? 1 : this.measure(shown, px, o.w, { bold, upper }).lines.length;
    return { h: lines * px * lh, px, lines };
  }

  /** Adds a text element; returns the height it occupies so a builder can stack the next one under it. */
  t(o: TOpts): number {
    const role = o.role ?? "body", bold = o.bold ?? role !== "body", upper = o.upper ?? false, lh = o.lh ?? 1.15;
    const raw = o.text ?? this.slotText[o.slot] ?? "";
    const counter = o.counter;
    const shown = counter ? `${counter.prefix ?? ""}${counter.to.toFixed(counter.decimals ?? 0)}${counter.suffix ?? ""}` : raw;
    const px = o.maxLines && !counter ? this.fit(shown, o.px, o.w, o.maxLines, { bold, upper }, o.minPx ?? 0) : o.px;
    const wrapped = counter ? { lines: [shown] } : this.measure(shown, px, o.w, { bold, upper });
    const str = wrapped.lines.join("\n");
    const stag = o.stagger === undefined || o.stagger === "auto" ? (counter ? false : this.s.stagger) : o.stagger;
    const unit = stag === false ? undefined : stag === "line" && wrapped.lines.length < 2 ? "word" : stag;
    const n = !unit ? 1 : unit === "line" ? wrapped.lines.length : unit === "word" ? str.split(/(?<=\s)/).length : Array.from(str).length;
    const dur = o.dur ?? this.s.motion.dur;
    let each = this.s.motion.each, at = o.at;
    const budget = this.D - 0.95;
    if (unit && n > 1) { const room = budget - at - dur; if ((n - 1) * each > room) each = Math.max(0.01, room / (n - 1)); }
    const span = unit ? (n - 1) * each : 0;
    if (at + dur + span > budget) at = Math.max(0, budget - dur - span);
    const props: Record<string, unknown> = { text: str, x: Math.round(o.x), y: Math.round(o.y), w: Math.round(o.w), font_px: px, line_height: lh, align: o.align ?? this.s.align, color: o.color ?? "text", weight: bold ? "bold" : "regular", upper, font: role };
    if (counter) props["counter"] = { from: 0, to: counter.to, decimals: counter.decimals ?? 0, prefix: counter.prefix ?? "", suffix: counter.suffix ?? "" };
    const tracks = counter ? [{ property: "progress" as const, keyframes: [K(0, 0), K(1, 1)], easing: "ease_out" as Easing }, { property: "opacity" as const, keyframes: [K(0, 0), K(0.12, 1), K(1, 1)], easing: "linear" as Easing }] : this.enterTracks(o.enter ?? "rise");
    this.els.push({ id: o.id, kind: "text", parent: o.parent ?? null, props, timeline: { start_s: round(at), duration_s: dur, tracks }, stagger: unit ? { unit, each_s: round3(each), from: "start" } : undefined, bindings: o.bind === false ? {} : counter ? { counter: o.slot } : { text: o.slot } });
    return wrapped.lines.length * px * lh;
  }

  /** The content column most text-led designs use: wide frames take 70% of the width, others the width inside the margins. */
  get cw(): number { return this.f.wide ? Math.round(this.f.W * 0.7) : this.f.W - 2 * this.f.m; }

  /**
   * Stacks items top to bottom and centres the stack vertically (`bias` 0.5 centres, lower values sit higher). A text item is placed with t(); a shape
   * item is placed by its `make(y)` callback; a gap item only adds space. Returns where each item landed.
   */
  block(items: BlockItem[], o: { x?: number; w?: number; bias?: number; top?: number } = {}): Record<string, { y: number; h: number }> {
    const x = o.x ?? this.ax(o.w ?? this.cw), w = o.w ?? this.cw;
    const hs = items.map((it) => ("slot" in it ? this.th({ ...it, w: it.w ?? w }).h : it.h) + (it.gapBefore ?? 0));
    const total = hs.reduce((a, b) => a + b, 0);
    let y = o.top ?? Math.max(this.f.m, (this.f.H - total) * (o.bias ?? 0.5));
    const out: Record<string, { y: number; h: number }> = {};
    items.forEach((it, i) => {
      y += it.gapBefore ?? 0;
      const h = hs[i]! - (it.gapBefore ?? 0);
      if ("slot" in it) { this.t({ ...it, x: it.x ?? x, y, w: it.w ?? w }); out[it.id] = { y, h }; }
      else if ("make" in it) { it.make(y, x, w); if (it.id) out[it.id] = { y, h }; }
      y += h;
    });
    return out;
  }

  /** Adds a shape. */
  s2(o: SOpts): void {
    const dur = o.dur ?? this.s.motion.dur, ez = o.ease ?? this.ez;
    let tracks: Track[] = o.tracks ?? [];
    const kind = o.enter ?? "fade";
    if (!o.tracks) {
      if (kind === "grow_x") tracks = [{ property: "w", keyframes: [K(0, 0), K(1, o.w)], easing: ez }];
      else if (kind === "grow_x_c") tracks = [{ property: "w", keyframes: [K(0, 0), K(1, o.w)], easing: ez }, { property: "x", keyframes: [K(0, o.w / 2), K(1, 0)], easing: ez }];
      else if (kind === "grow_x_r") tracks = [{ property: "w", keyframes: [K(0, 0), K(1, o.w)], easing: ez }, { property: "x", keyframes: [K(0, o.w), K(1, 0)], easing: ez }];
      else if (kind === "grow_y") tracks = [{ property: "h", keyframes: [K(0, 0), K(1, o.h)], easing: ez }];
      else if (kind === "grow_y_up") tracks = [{ property: "h", keyframes: [K(0, 0), K(1, o.h)], easing: ez }, { property: "y", keyframes: [K(0, o.h), K(1, 0)], easing: ez }];
      else tracks = this.enterTracks(kind as Enter);
      if (o.opacity !== undefined) tracks = tracks.map((t) => (t.property === "opacity" ? { ...t, keyframes: t.keyframes.map((k) => ({ ...k, value: k.value * o.opacity! })) } : t));
      if (o.opacity !== undefined && !tracks.some((t) => t.property === "opacity")) tracks = [...tracks, { property: "opacity", keyframes: [K(0, o.opacity), K(1, o.opacity)], easing: "linear" }];
    }
    const props: Record<string, unknown> = { shape: o.shape, x: Math.round(o.x), y: Math.round(o.y), w: Math.max(1, Math.round(o.w)), h: Math.max(0, Math.round(o.h)), stroke_w: o.stroke_w ?? 0, radius: o.radius ?? 0 };
    if (o.fill) props["fill"] = o.fill;
    if (o.stroke) props["stroke"] = o.stroke;
    this.els.push({ id: o.id, kind: "shape", parent: o.parent ?? null, props, timeline: { start_s: round(o.at), duration_s: dur, tracks }, bindings: {} });
  }

  /** Adds a raw element (chart, mask, group, cursor). */
  raw(e: Draft): void { this.els.push(e); }
  /** A timeline slot. */
  slot(at: number, dur?: number): { start_s: number; duration_s: number } { return { start_s: round(at), duration_s: dur ?? this.s.motion.dur }; }
  track(property: Track["property"], from: number, to: number, easing?: Easing): Track { return { property, keyframes: [K(0, from), K(1, to)], easing: easing ?? this.ez }; }
}

export const round = (v: number) => Math.round(v * 1000) / 1000;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- backdrops
function backdrop(c: Ctx): Draft[] {
  const { f, s } = c, { W, H, short } = f;
  const before = c.els.length;
  const at = 0, calm = Math.max(0.6, s.motion.dur);
  const isRight = s.align === "right";
  switch (s.backdrop) {
    case "band": c.s2({ id: "bd_band", shape: "rect", x: 0, y: Math.round(H * 0.32), w: W, h: Math.round(H * 0.36), fill: "surface", at, dur: calm, enter: "grow_x" }); break;
    case "corner": {
      const z = Math.round(short * 0.14);
      c.s2({ id: "bd_corner", shape: "rect", x: isRight ? 0 : W - z, y: H - z, w: z, h: z, fill: "accent", at, dur: calm, enter: "fade" });
      c.s2({ id: "bd_corner2", shape: "rect", x: isRight ? 0 : W - z * 2, y: H - Math.round(z * 0.4), w: z, h: Math.round(z * 0.4), fill: "accent_2", at: at + 0.1, dur: calm, enter: "fade" });
      break;
    }
    case "grid": {
      const cols = f.wide ? 8 : 5, rows = f.wide ? 4 : f.portrait ? 8 : 5;
      for (let i = 1; i < cols; i++) c.s2({ id: `bd_v${i}`, shape: "rect", x: Math.round((W * i) / cols), y: 0, w: 2, h: H, fill: "muted", at, dur: calm, enter: "fade", opacity: 0.16 });
      for (let i = 1; i < rows; i++) c.s2({ id: `bd_h${i}`, shape: "rect", x: 0, y: Math.round((H * i) / rows), w: W, h: 2, fill: "muted", at, dur: calm, enter: "fade", opacity: 0.16 });
      break;
    }
    case "frame": { const g = Math.round(short * 0.035); c.s2({ id: "bd_frame", shape: "rect", x: g, y: g, w: W - 2 * g, h: H - 2 * g, stroke: "accent", stroke_w: 3, at, dur: calm, enter: "fade", opacity: 0.9 }); break; }
    case "orb": {
      const d = Math.round(short * 1.05);
      c.s2({ id: "bd_orb", shape: "ellipse", x: isRight ? -Math.round(d * 0.45) : W - Math.round(d * 0.55), y: -Math.round(d * 0.3), w: d, h: d, fill: "surface", at, dur: calm * 1.4, enter: "pop" });
      c.s2({ id: "bd_orb2", shape: "ellipse", x: isRight ? W - Math.round(d * 0.2) : -Math.round(d * 0.3), y: H - Math.round(d * 0.28), w: Math.round(d * 0.5), h: Math.round(d * 0.5), fill: "accent_2", at: at + 0.15, dur: calm * 1.4, enter: "pop", opacity: 0.55 });
      break;
    }
    case "stripes": {
      const sh = Math.max(4, Math.round(short * 0.008));
      for (let i = 0; i < 3; i++) c.s2({ id: `bd_s${i}`, shape: "rect", x: isRight ? W - Math.round(W * (0.5 - i * 0.1)) : 0, y: H - Math.round(short * 0.1) + i * sh * 2.5, w: Math.round(W * (0.5 - i * 0.1)), h: sh, fill: i === 0 ? "accent" : "muted", at: at + i * 0.08, dur: calm, enter: isRight ? "grow_x_r" : "grow_x", opacity: i === 0 ? undefined : 0.5 });
      break;
    }
    default: break;
  }
  return c.els.splice(before);
}

function cameraRig(s: Style, D: number): SceneGraphV2["camera"] {
  const tl = (tracks: Track[]) => ({ timeline: { start_s: 0, duration_s: D, tracks: tracks as never } });
  if (s.camera === "push") return tl([{ property: "scale", keyframes: [K(0, 1), K(1, 1.05)], easing: "linear" }]);
  if (s.camera === "pull") return tl([{ property: "scale", keyframes: [K(0, 1.06), K(1, 1)], easing: "ease_out" }]);
  if (s.camera === "drift") return tl([{ property: "x", keyframes: [K(0, 0), K(1, -24)], easing: "linear" }, { property: "y", keyframes: [K(0, 0), K(1, -10)], easing: "linear" }]);
  return undefined;
}

// ---------------------------------------------------------------- assembling a record
/** One scene graph for one aspect ratio. */
export function buildGraph(fam: FamilyDef, s: Style, aspect: Aspect): SceneGraphV2 {
  const f = frameOf(aspect), c = new Ctx(f, s, fam);
  fam.build(c);
  const bd = backdrop(new Ctx(f, s, fam));
  const cam = c.camera ?? cameraRig(s, fam.duration_s);
  return { format: "digikon.scene-graph", format_version: 2, canvas: { width: f.W, height: f.H, fps: FPS }, duration_s: fam.duration_s, elements: [...bd, ...c.els], ...(cam ? { camera: cam } : {}) };
}

export const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function styleOf(fam: FamilyDef, over: Partial<Style> = {}): Style {
  return { palette: PALETTES[0]!, pairing: PAIRINGS[0]!, motion: MOTIONS[0]!, align: "left", flip: false, backdrop: "none", stagger: "word", camera: "none", ...fam.base, ...over };
}

/** The ids of the elements that draw with each token and font role, used for the record's palette and type rules. */
function rolesUsed(graphs: SceneGraphV2[]): { colors: Color[]; roles: Role[] } {
  const colors = new Set<Color>(["background"]), roles = new Set<Role>();
  for (const g of graphs) for (const e of g.elements) {
    const p = e.props as Record<string, unknown>;
    for (const k of ["color", "fill", "stroke"]) if (typeof p[k] === "string" && !(p[k] as string).startsWith("#")) colors.add(p[k] as Color);
    if (e.kind === "text") roles.add((p["font"] as Role | undefined) ?? "body");
  }
  return { colors: [...colors], roles: [...roles] };
}

const sentence = (a: string[]) => a.join(", ");

export function toTemplate(fam: FamilyDef, s: Style, baseStyle: Style, aspects: readonly Aspect[] = ASPECTS): LibraryTemplate {
  const graphs: Partial<Record<Aspect, SceneGraphV2>> = {};
  for (const a of aspects) graphs[a] = buildGraph(fam, s, a);
  const varied: Record<string, string> = {};
  for (const a of AXES) if (axisValue(s, a) !== axisValue(baseStyle, a)) varied[a] = axisValue(s, a);
  const isBase = Object.keys(varied).length === 0;
  const id = isBase ? fam.id : [fam.id, ...AXES.filter((a) => varied[a] !== undefined).map((a) => slugify(a === "flip" ? "flip" : varied[a]!))].join("-");
  const { colors, roles } = rolesUsed(Object.values(graphs) as SceneGraphV2[]);
  const m = s.motion, p = s.palette, pr = s.pairing;
  const layout = [s.align === "center" ? "centred" : `${s.align}-aligned`, s.flip ? "mirrored" : "", s.backdrop !== "none" ? `${s.backdrop} backdrop` : "", s.camera !== "none" ? `camera ${s.camera}` : "", `${s.stagger} stagger`].filter(Boolean).join(", ");
  const retrieval = `${fam.title}. ${fam.retrieval} Look: ${p.mood}. Type: ${pr.words}. Motion: ${m.words}. Layout: ${layout}. Mood: ${sentence(fam.mood)}. Tone: ${sentence(fam.tone)}.`;
  const tpl = {
    format: "digikon.template", format_version: 2, template_id: id, version: "1.0.0", content_hash: "0".repeat(32),
    category: fam.category, family: fam.id, ...(isBase ? {} : { variant_of: fam.id }), variant_axes: varied, archetype: fam.archetype,
    title: isBase ? fam.title : `${fam.title} (${[p.name, pr.name, m.name].join("/")})`, description: `${fam.description} Rendered in ${p.mood}; ${pr.words}; ${m.words}.`,
    tags: { mood: fam.mood, energy: fam.energy, pacing: m.pace, industry: fam.industry ?? [], tone: fam.tone, motion_personality: m.name, type_personality: pr.type_personality },
    needs: { media: fam.needs_media ?? ["none"], text_slots: fam.slots.map((x) => ({ name: x.name, role: x.role, max_chars: x.max_chars, required: x.required ?? true, example: x.example })), aspect_ratios: [...aspects], duration_range: { min_s: round(fam.duration_s * 0.8), max_s: round(fam.duration_s * 1.4) } },
    scene_graph: graphs,
    params: [{ kind: "number", name: "duration_scale", min: 0.8, max: 1.4, default: 1 }],
    palette_rules: { roles_used: colors, min_text_contrast: 4.5, reference_palette: { name: p.name, background: p.background, surface: p.surface, text: p.text, muted: p.muted, accent: p.accent, accent_2: p.accent_2 } },
    type_rules: { roles_used: roles.length ? roles : ["body"], pairing: { name: pr.name, display: pr.display, body: pr.body, mono: pr.mono }, min_px_short_edge_ratio: 0.03 },
    engine_support: { scene_graph_version: 2, renderers: ["remotion"], requires_flag: "SCENE_GRAPH" },
    source: { kind: "authored", origin: "digikon template library, release 1", licence: "Original work of the project, no third-party material; fonts EB Garamond and JetBrains Mono under the SIL Open Font License (see packages/render/fonts).", licence_ok: true },
    evidence: [], status: "draft", retrieval_text: retrieval,
  };
  // The duration range must contain every graph's duration; the graphs all run fam.duration_s, so it does.
  return LibraryTemplate.parse(tpl);
}
