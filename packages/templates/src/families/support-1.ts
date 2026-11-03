import type { Ctx, FamilyDef } from "../kit.js";
import { z } from "./common.js";

const ALL = ["palette", "pairing", "motion", "align", "flip", "backdrop", "stagger", "camera"] as const;
const SHAPES = ["palette", "motion", "flip", "pairing"] as const;

// ============================================================ kinetic_type
const ktWordPop: FamilyDef = {
  id: "kt-word-pop", category: "kinetic_type", archetype: "word_pop", title: "Words pop in one by one",
  description: "A short sentence set very large, each word popping in on the beat.",
  retrieval: "Kinetic type: a short sentence set very large where each word pops in one after another with a spring. Rhythmic text-only statement.",
  mood: ["rhythmic", "emphatic"], tone: ["declarative", "punchy"], energy: "high",
  slots: [{ name: "text", role: "headline", max_chars: 60, example: "Plan it. Approve it. Render it." }],
  duration_s: 4.5, axes: ALL, base: { stagger: "word" },
  build(c) { c.block([{ id: "text", slot: "text", px: z(c, c.f.wide ? 0.14 : 0.13), role: "display", maxLines: 4, lh: 1.04, at: 0.2, enter: "pop", stagger: "word" }]); },
};
const ktCharCascade: FamilyDef = {
  id: "kt-char-cascade", category: "kinetic_type", archetype: "char_cascade", title: "Characters cascade",
  description: "A short word or phrase whose characters rise into place one by one.",
  retrieval: "Kinetic type: a headline whose individual characters rise into place in a quick cascade. Typewriter-like energy without a cursor.",
  mood: ["lively", "crafted"], tone: ["playful", "precise"], energy: "medium",
  slots: [{ name: "text", role: "headline", max_chars: 30, example: "Made to be approved" }],
  duration_s: 4.5, axes: ALL, base: { stagger: "char" },
  build(c) { c.block([{ id: "text", slot: "text", px: z(c, c.f.wide ? 0.15 : 0.13), role: "display", maxLines: 3, lh: 1.05, at: 0.2, enter: "rise", stagger: "char" }]); },
};
const ktTracking: FamilyDef = {
  id: "kt-tracking-collapse", category: "kinetic_type", archetype: "tracking", title: "Letter-spacing collapses",
  description: "Wide letter-spacing tightens into place while the text fades in, with a small line below.",
  retrieval: "Kinetic type: widely spaced letters pull together into a tight headline while it fades in, with a small supporting line. Calm, cinematic title.",
  mood: ["cinematic", "composed"], tone: ["elegant", "restrained"], energy: "low",
  slots: [{ name: "text", role: "headline", max_chars: 30, example: "A film begins" }, { name: "support", role: "caption", max_chars: 50, example: "Before the first frame", required: false }],
  duration_s: 5, axes: ALL,
  build(c) {
    c.block([
      { id: "text", slot: "text", px: z(c, c.f.wide ? 0.13 : 0.12), role: "display", maxLines: 2, lh: 1.05, at: 0.2, dur: 1.8, enter: "track", stagger: false },
      { id: "support", slot: "support", px: z(c, 0.036), role: "mono", upper: true, color: "muted", lh: 1.2, at: 2.0, enter: "fade", stagger: false, gapBefore: z(c, 0.04) },
    ]);
  },
};
const ktAlternate: FamilyDef = {
  id: "kt-alternating-lines", category: "kinetic_type", archetype: "alternating", title: "Lines enter from alternate sides",
  description: "Three lines of large type, the first from the left, the second from the right, the third from the left.",
  retrieval: "Kinetic type: three lines of large type that slide in from alternating sides, the last in the accent colour. Staccato three-beat statement.",
  mood: ["staccato", "dynamic"], tone: ["bold", "rhythmic"], energy: "high",
  slots: [{ name: "line_1", role: "headline", max_chars: 20, example: "Plan" }, { name: "line_2", role: "headline", max_chars: 20, example: "Approve" }, { name: "line_3", role: "headline", max_chars: 20, example: "Render" }],
  duration_s: 4.5, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, px = z(c, f.wide ? 0.17 : 0.16), W = f.W - 2 * f.m, h = px * 1.1, total = 3 * h, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
    [1, 2, 3].forEach((n, i) => c.t({ id: `line_${n}`, slot: `line_${n}`, x: f.m, y: y0 + i * h, w: W, px, role: "display", color: i === 2 ? "accent" : "text", lh: 1.1, align: (i % 2 === 0) !== c.s.flip ? "left" : "right", at: 0.2 + i * 0.5, enter: (i % 2 === 0) !== c.s.flip ? "left" : "right", stagger: false, maxLines: 1 }));
  },
};
const ktEmphasis: FamilyDef = {
  id: "kt-emphasis-word", category: "kinetic_type", archetype: "emphasis", title: "One word gets the emphasis",
  description: "A lead-in line, one key word set much larger in the accent colour, and a short tail line.",
  retrieval: "Kinetic type: a small lead-in line, one key word blown up in the accent colour and a short tail. Puts the weight of a sentence on a single word.",
  mood: ["emphatic", "focused"], tone: ["pointed", "confident"], energy: "medium",
  slots: [{ name: "lead", role: "subline", max_chars: 40, example: "Your next film is" }, { name: "key", role: "headline", max_chars: 14, example: "approved" }, { name: "tail", role: "subline", max_chars: 40, example: "before it is made." }],
  duration_s: 4.5, axes: ALL,
  build(c) {
    c.block([
      { id: "lead", slot: "lead", px: z(c, 0.06), role: "body", color: "muted", lh: 1.2, maxLines: 2, at: 0.1, enter: "fade", stagger: false },
      { id: "key", slot: "key", px: z(c, c.f.wide ? 0.24 : 0.2), role: "display", color: "accent", lh: 1.02, maxLines: 1, at: 0.6, enter: "pop", stagger: false, gapBefore: z(c, 0.01) },
      { id: "tail", slot: "tail", px: z(c, 0.06), role: "body", lh: 1.2, maxLines: 2, at: 1.6, enter: "fade", stagger: false, gapBefore: z(c, 0.015) },
    ]);
  },
};

// ============================================================ transitions
const trWipe: FamilyDef = {
  id: "tr-wipe-panel", category: "transitions", archetype: "wipe", title: "Accent wipe",
  description: "An accent panel wipes across the frame and a thin surface panel follows, then both leave.",
  retrieval: "Transition overlay: an accent panel wipes across the whole frame with a thin surface panel trailing, then both exit. A clean hard-edged wipe between scenes.",
  mood: ["clean", "decisive"], tone: ["neutral"], energy: "high",
  slots: [], duration_s: 1.4, axes: ["palette", "motion", "flip"],
  build(c) {
    const { f } = c, dir = c.s.flip ? -1 : 1, mk = (id: string, w: number, col: "accent" | "surface", at: number) => c.s2({ id, shape: "rect", x: 0, y: 0, w, h: f.H, fill: col, at, dur: 1.0, tracks: [{ property: "x", keyframes: [{ at: 0, value: -dir * w }, { at: 0.5, value: 0 }, { at: 1, value: dir * f.W }], easing: "ease_in_out" }] });
    mk("panel_accent", f.W, "accent", 0.0); mk("panel_surface", Math.round(f.W * 0.5), "surface", 0.12);
  },
};
const trIris: FamilyDef = {
  id: "tr-iris-disc", category: "transitions", archetype: "iris", title: "Iris disc",
  description: "A disc grows from the centre until it covers the frame, then shrinks away again.",
  retrieval: "Transition overlay: a round disc grows from the centre to cover the frame and then shrinks away. Iris-style change of scene.",
  mood: ["playful", "retro"], tone: ["neutral"], energy: "medium",
  slots: [], duration_s: 1.6, axes: ["palette", "motion", "pairing"],
  build(c) {
    const { f } = c, d = Math.round(Math.hypot(f.W, f.H) * 1.05);
    c.s2({ id: "disc", shape: "ellipse", x: Math.round((f.W - d) / 2), y: Math.round((f.H - d) / 2), w: d, h: d, fill: "accent", at: 0, dur: 1.5, tracks: [{ property: "scale", keyframes: [{ at: 0, value: 0.02 }, { at: 0.5, value: 1 }, { at: 1, value: 0.02 }], easing: "ease_in_out" }] });
    c.s2({ id: "ring", shape: "ellipse", x: Math.round((f.W - d) / 2), y: Math.round((f.H - d) / 2), w: d, h: d, stroke: "accent_2", stroke_w: 10, at: 0.05, dur: 1.4, tracks: [{ property: "scale", keyframes: [{ at: 0, value: 0.02 }, { at: 0.5, value: 0.97 }, { at: 1, value: 0.02 }], easing: "ease_in_out" }] });
  },
};
const trStripes: FamilyDef = {
  id: "tr-stripe-shutter", category: "transitions", archetype: "stripes", title: "Stripe shutter",
  description: "Five bands slide across one after another, closing the frame and opening it again.",
  retrieval: "Transition overlay: five bands slide across in sequence, covering the frame and then opening again like a shutter. Rhythmic stripe transition.",
  mood: ["rhythmic", "graphic"], tone: ["neutral"], energy: "high",
  slots: [], duration_s: 1.8, axes: ["palette", "motion", "flip"],
  build(c) {
    const { f } = c, n = 5, bh = Math.ceil(f.H / n), dir = c.s.flip ? -1 : 1;
    for (let i = 0; i < n; i++) c.s2({ id: `band_${i}`, shape: "rect", x: 0, y: i * bh, w: f.W, h: bh + 1, fill: i % 2 ? "accent_2" : "accent", at: i * 0.08, dur: 1.2, tracks: [{ property: "x", keyframes: [{ at: 0, value: -dir * f.W * (i % 2 ? -1 : 1) }, { at: 0.5, value: 0 }, { at: 1, value: dir * f.W * (i % 2 ? -1 : 1) }], easing: "ease_in_out" }] });
  },
};
const trPush: FamilyDef = {
  id: "tr-push-slide", category: "transitions", archetype: "push", title: "Push slide",
  description: "Two panels push through the frame together, one pushing the other out.",
  retrieval: "Transition overlay: two panels, an accent one and a surface one, push through the frame together as if one scene pushes the next out. Slide transition.",
  mood: ["smooth", "modern"], tone: ["neutral"], energy: "medium",
  slots: [], duration_s: 1.6, axes: ["palette", "motion", "flip"],
  build(c) {
    const { f } = c, vertical = f.portrait, dir = c.s.flip ? -1 : 1, S = vertical ? f.H : f.W;
    const mk = (id: string, col: "accent" | "surface", offset: number) => c.s2({ id, shape: "rect", x: 0, y: 0, w: f.W, h: f.H, fill: col, at: 0, dur: 1.4, tracks: [{ property: vertical ? "y" : "x", keyframes: [{ at: 0, value: -dir * S + offset }, { at: 1, value: dir * S + offset }], easing: "ease_in_out" }] });
    mk("slab_surface", "surface", -dir * S * 0.0); mk("slab_accent", "accent", -dir * S * 1.0 + dir * S * 0.0);
  },
};

// ============================================================ backgrounds
const bgGrid: FamilyDef = {
  id: "bg-grid-drift", category: "backgrounds", archetype: "grid", title: "Drifting grid",
  description: "Thin grid lines drift slowly with a few accent dots at the crossings.",
  retrieval: "Animated background: a fine grid of lines drifting slowly with a few accent dots at the crossings. Technical, calm backdrop for text scenes.",
  mood: ["technical", "calm"], tone: ["neutral"], energy: "low",
  slots: [], duration_s: 6, axes: SHAPES,
  build(c) {
    const { f } = c, cols = f.wide ? 12 : 8, step = Math.round(f.W / cols), rows = Math.ceil(f.H / step) + 1;
    for (let i = 0; i <= cols + 1; i++) c.s2({ id: `v${i}`, shape: "rect", x: i * step, y: 0, w: 2, h: f.H, fill: "muted", at: 0, dur: 6, tracks: [{ property: "x", keyframes: [{ at: 0, value: c.s.flip ? step : 0 }, { at: 1, value: c.s.flip ? 0 : step }], easing: "linear" }, { property: "opacity", keyframes: [{ at: 0, value: 0.2 }, { at: 1, value: 0.2 }], easing: "linear" }] });
    for (let j = 0; j <= rows; j++) c.s2({ id: `h${j}`, shape: "rect", x: 0, y: j * step, w: f.W, h: 2, fill: "muted", at: 0, dur: 6, tracks: [{ property: "y", keyframes: [{ at: 0, value: 0 }, { at: 1, value: -step }], easing: "linear" }, { property: "opacity", keyframes: [{ at: 0, value: 0.2 }, { at: 1, value: 0.2 }], easing: "linear" }] });
    [[2, 1], [cols - 3, 2], [5, Math.min(rows - 2, 4)]].forEach(([i, j], k) => c.s2({ id: `dot_${k}`, shape: "ellipse", x: i! * step - 7, y: j! * step - 7, w: 16, h: 16, fill: k === 1 ? "accent_2" : "accent", at: 0.5 + k * 0.4, dur: 0.6, enter: "pop" }));
  },
};
const bgOrbs: FamilyDef = {
  id: "bg-soft-orbs", category: "backgrounds", archetype: "orbs", title: "Soft drifting orbs",
  description: "Four large discs in surface and accent tones drift and breathe slowly.",
  retrieval: "Animated background: four large soft discs in surface and accent tones that drift and breathe slowly. Friendly, ambient backdrop.",
  mood: ["ambient", "friendly"], tone: ["neutral"], energy: "low",
  slots: [], duration_s: 6, axes: SHAPES,
  build(c) {
    const { f } = c, s = f.short, spec: [number, number, number, "surface" | "accent" | "accent_2", number][] = [[0.15, 0.2, 0.7, "surface", 1], [0.7, 0.15, 0.5, "accent", 0.5], [0.55, 0.65, 0.75, "surface", 1], [0.1, 0.7, 0.4, "accent_2", 0.5]];
    spec.forEach(([fx, fy, k, col, op], i) => {
      const d = Math.round(s * k), x = Math.round(f.W * (c.s.flip ? 1 - fx : fx) - d / 2), y = Math.round(f.H * fy - d / 2), dx = (i % 2 ? -1 : 1) * Math.round(s * 0.06), dy = (i < 2 ? 1 : -1) * Math.round(s * 0.05);
      c.s2({ id: `orb_${i}`, shape: "ellipse", x, y, w: d, h: d, fill: col, at: 0, dur: 6, tracks: [{ property: "x", keyframes: [{ at: 0, value: 0 }, { at: 1, value: dx }], easing: "ease_in_out" }, { property: "y", keyframes: [{ at: 0, value: 0 }, { at: 1, value: dy }], easing: "ease_in_out" }, { property: "scale", keyframes: [{ at: 0, value: 0.92 }, { at: 0.5, value: 1.06 }, { at: 1, value: 0.96 }], easing: "ease_in_out" }, { property: "opacity", keyframes: [{ at: 0, value: 0 }, { at: 0.1, value: op }, { at: 1, value: op }], easing: "linear" }] });
    });
  },
};
const bgBands: FamilyDef = {
  id: "bg-scrolling-bands", category: "backgrounds", archetype: "bands", title: "Scrolling bands",
  description: "Horizontal bands of different weights slide in opposite directions, like a ticker without text.",
  retrieval: "Animated background: horizontal bands of different thickness sliding in opposite directions, like a ticker without words. Energetic, graphic backdrop.",
  mood: ["energetic", "graphic"], tone: ["neutral"], energy: "high",
  slots: [], duration_s: 6, axes: SHAPES,
  build(c) {
    const { f } = c, n = f.portrait ? 9 : 6, bh = Math.round(f.H / (n * 1.6));
    for (let i = 0; i < n; i++) {
      const y = Math.round(((i + 0.5) * f.H) / n - bh / 2), w = Math.round(f.W * 0.7), dir = (i % 2 ? -1 : 1) * (c.s.flip ? -1 : 1);
      c.s2({ id: `band_${i}`, shape: "rect", x: Math.round(f.W * 0.15), y, w, h: bh, fill: i % 3 === 0 ? "accent" : i % 3 === 1 ? "surface" : "accent_2", radius: Math.round(bh / 2), at: 0, dur: 6, tracks: [{ property: "x", keyframes: [{ at: 0, value: -dir * f.W * 0.25 }, { at: 1, value: dir * f.W * 0.25 }], easing: "linear" }, { property: "opacity", keyframes: [{ at: 0, value: 0 }, { at: 0.1, value: i % 3 === 1 ? 1 : 0.55 }, { at: 1, value: i % 3 === 1 ? 1 : 0.55 }], easing: "linear" }] });
    }
  },
};
const bgBars: FamilyDef = {
  id: "bg-rising-columns", category: "backgrounds", archetype: "columns", title: "Rising columns",
  description: "A row of columns grows from the bottom edge at different speeds, like a quiet equaliser.",
  retrieval: "Animated background: a row of columns rising from the bottom edge at different speeds, like a quiet equaliser. Rhythmic backdrop for data or music scenes.",
  mood: ["rhythmic", "growing"], tone: ["neutral"], energy: "medium",
  slots: [], duration_s: 6, axes: SHAPES,
  build(c) {
    const { f } = c, n = f.wide ? 14 : 9, g = Math.round(f.W * 0.012), bw = Math.round((f.W - (n + 1) * g) / n), heights = [0.3, 0.55, 0.4, 0.75, 0.5, 0.65, 0.35, 0.8, 0.45, 0.6, 0.38, 0.7, 0.5, 0.42];
    for (let i = 0; i < n; i++) {
      const idx = c.s.flip ? n - 1 - i : i, h = Math.round(f.H * 0.55 * heights[idx % heights.length]!);
      c.s2({ id: `col_${i}`, shape: "rect", x: g + i * (bw + g), y: f.H - h, w: bw, h, fill: i % 4 === 0 ? "accent" : "surface", radius: Math.round(bw * 0.15), at: i * 0.1, dur: 2.2, enter: "grow_y_up", opacity: i % 4 === 0 ? 0.7 : undefined });
    }
  },
};
const bgRings: FamilyDef = {
  id: "bg-expanding-rings", category: "backgrounds", archetype: "rings", title: "Expanding rings",
  description: "Concentric rings expand from the centre and fade, over and over.",
  retrieval: "Animated background: concentric rings expanding from the centre and fading, repeating through the scene. Calm radar-like backdrop.",
  mood: ["hypnotic", "calm"], tone: ["neutral"], energy: "low",
  slots: [], duration_s: 6, axes: SHAPES,
  build(c) {
    const { f } = c, d = Math.round(Math.hypot(f.W, f.H) * 0.9);
    for (let i = 0; i < 4; i++) c.s2({ id: `ring_${i}`, shape: "ellipse", x: Math.round((f.W - d) / 2), y: Math.round((f.H - d) / 2), w: d, h: d, stroke: i % 2 ? "accent_2" : "accent", stroke_w: 6, at: i * 0.8, dur: 3.4, tracks: [{ property: "scale", keyframes: [{ at: 0, value: 0.05 }, { at: 1, value: 1 }], easing: "ease_out" }, { property: "opacity", keyframes: [{ at: 0, value: 0.9 }, { at: 1, value: 0 }], easing: "linear" }] });
    c.s2({ id: "core", shape: "ellipse", x: Math.round(f.W / 2 - f.short * 0.03), y: Math.round(f.H / 2 - f.short * 0.03), w: Math.round(f.short * 0.06), h: Math.round(f.short * 0.06), fill: "accent", at: 0, dur: 0.6, enter: "pop" });
  },
};

// ============================================================ camera_moves
const camScene = (c: Ctx, extra?: (c: Ctx) => void) => {
  const { f } = c, w = f.wide ? Math.round(f.W * 0.58) : Math.round(f.W * 0.78), x = Math.round((f.W - w) / 2), cardH = z(c, f.wide ? 0.2 : 0.2);
  const hh = c.th({ slot: "headline", w, px: z(c, f.wide ? 0.085 : 0.085), role: "display", maxLines: 3, lh: 1.08 }).h, sub = c.th({ slot: "subline", w, px: z(c, 0.04), role: "body", maxLines: 2, lh: 1.3 }).h;
  const total = hh + z(c, 0.03) + sub + z(c, 0.06) + cardH, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
  c.t({ id: "headline", slot: "headline", x, y: y0, w, px: z(c, f.wide ? 0.085 : 0.085), role: "display", maxLines: 3, lh: 1.08, align: "center", at: 0.2, enter: "rise", stagger: "auto" });
  c.t({ id: "subline", slot: "subline", x, y: y0 + hh + z(c, 0.03), w, px: z(c, 0.04), role: "body", color: "muted", maxLines: 2, lh: 1.3, align: "center", at: 0.9, enter: "fade", stagger: false });
  const cy = y0 + hh + z(c, 0.03) + sub + z(c, 0.06);
  c.s2({ id: "card", shape: "rect", x, y: cy, w, h: cardH, fill: "surface", stroke: "muted", stroke_w: 2, radius: z(c, 0.02), at: 0.6, dur: 0.7, enter: "pop" });
  c.s2({ id: "card_dot", shape: "ellipse", x: x + z(c, 0.03), y: cy + Math.round(cardH / 2 - z(c, 0.03)), w: z(c, 0.06), h: z(c, 0.06), fill: "accent", at: 1.0, dur: 0.5, enter: "pop" });
  c.s2({ id: "card_l1", shape: "rect", x: x + z(c, 0.12), y: cy + Math.round(cardH * 0.34), w: Math.round(w * 0.55), h: z(c, 0.018), fill: "muted", radius: 6, at: 1.1, dur: 0.6, enter: "grow_x", opacity: 0.5 });
  c.s2({ id: "card_l2", shape: "rect", x: x + z(c, 0.12), y: cy + Math.round(cardH * 0.56), w: Math.round(w * 0.38), h: z(c, 0.018), fill: "muted", radius: 6, at: 1.2, dur: 0.6, enter: "grow_x", opacity: 0.35 });
  extra?.(c);
};
const camSlots = [{ name: "headline", role: "headline" as const, max_chars: 50, example: "Every detail in view" }, { name: "subline", role: "subline" as const, max_chars: 80, example: "The camera does the pointing." }];
const camTpl = (id: string, title: string, retrieval: string, desc: string, mood: string[], tone: string[], energy: "low" | "medium" | "high", dur: number, rig: (c: Ctx) => NonNullable<Ctx["camera"]>): FamilyDef => ({
  id, category: "camera_moves", archetype: id.replace(/^cam-/, "").replace(/-/g, "_"), title, description: desc, retrieval, mood, tone, energy, slots: camSlots, duration_s: dur, axes: ["palette", "pairing", "motion", "flip", "backdrop"],
  build(c) { camScene(c); c.camera = rig(c); },
});
const T = (properties: { property: "x" | "y" | "scale" | "rotate"; keyframes: { at: number; value: number }[]; easing: "linear" | "ease_in_out" | "ease_out" }[], D: number) => ({ timeline: { start_s: 0, duration_s: D, tracks: properties as never } });
const camFamilies: FamilyDef[] = [
  camTpl("cam-push-in", "Slow push-in", "Camera move: a slow push-in on a headline and card that settles with a gentle zoom. Builds focus and intimacy.", "The camera pushes slowly toward a headline and a card, ending 15 percent closer.", ["focused", "intimate"], ["calm"], "low", 5, (c) => T([{ property: "scale", keyframes: [{ at: 0, value: 1 }, { at: 1, value: 1.15 }], easing: "ease_in_out" }], c.D)),
  camTpl("cam-pull-back", "Pull-back reveal", "Camera move: starts close and pulls back to reveal the whole headline and card. Reveals context.", "The camera starts 20 percent in and eases back to the full frame.", ["revealing", "open"], ["measured"], "low", 5, (c) => T([{ property: "scale", keyframes: [{ at: 0, value: 1.2 }, { at: 1, value: 1 }], easing: "ease_out" }], c.D)),
  camTpl("cam-pan-drift", "Sideways drift", "Camera move: a steady sideways drift across a headline and card with a hint of zoom. Documentary feel.", "The camera drifts sideways while zooming a touch.", ["documentary", "steady"], ["observational"], "low", 5.5, (c) => T([{ property: "x", keyframes: [{ at: 0, value: c.s.flip ? -70 : 70 }, { at: 1, value: c.s.flip ? 70 : -70 }], easing: "linear" }, { property: "scale", keyframes: [{ at: 0, value: 1.06 }, { at: 1, value: 1.1 }], easing: "linear" }], c.D)),
  camTpl("cam-tilt-rise", "Tilt up", "Camera move: the camera tilts upward from the card to the headline. Lifting, hopeful reveal.", "The camera starts low and rises along the content.", ["hopeful", "lifting"], ["gentle"], "medium", 5, (c) => T([{ property: "y", keyframes: [{ at: 0, value: c.s.flip ? -90 : 90 }, { at: 1, value: c.s.flip ? 40 : -40 }], easing: "ease_in_out" }, { property: "scale", keyframes: [{ at: 0, value: 1.1 }, { at: 1, value: 1.1 }], easing: "linear" }], c.D)),
  camTpl("cam-roll-settle", "Roll and settle", "Camera move: a slight roll that settles level while the camera eases in. Energetic, handheld-like arrival.", "The camera starts rolled by four degrees and levels out while easing in.", ["energetic", "handheld"], ["lively"], "high", 4.5, (c) => T([{ property: "rotate", keyframes: [{ at: 0, value: c.s.flip ? -4 : 4 }, { at: 1, value: 0 }], easing: "ease_out" }, { property: "scale", keyframes: [{ at: 0, value: 1.12 }, { at: 1, value: 1 }], easing: "ease_out" }], c.D)),
  camTpl("cam-orbit-float", "Floating orbit", "Camera move: a floating, slightly circular drift with a slow zoom. Dreamy, premium.", "The camera drifts in a shallow arc with a slow zoom.", ["dreamy", "premium"], ["elegant"], "low", 6, (c) => T([{ property: "x", keyframes: [{ at: 0, value: -40 }, { at: 0.5, value: 20 }, { at: 1, value: 40 }], easing: "ease_in_out" }, { property: "y", keyframes: [{ at: 0, value: 30 }, { at: 0.5, value: -20 }, { at: 1, value: 10 }], easing: "ease_in_out" }, { property: "scale", keyframes: [{ at: 0, value: 1.04 }, { at: 1, value: 1.12 }], easing: "linear" }], c.D)),
];

// ============================================================ charts
const chBars: FamilyDef = {
  id: "chart-bars-rise", category: "charts", archetype: "bars", title: "Bars rise",
  description: "A row of bars grows from the baseline with a title and a caption.",
  retrieval: "Chart: a row of vertical bars growing from the baseline, a title above and a caption below naming what is measured. Simple trend or ranking.",
  mood: ["clear", "positive"], tone: ["analytical"], energy: "medium",
  slots: [{ name: "title", role: "headline", max_chars: 44, example: "Films delivered per quarter" }, { name: "caption", role: "caption", max_chars: 60, example: "Last six quarters" }],
  duration_s: 5.5, axes: ["palette", "pairing", "motion", "align", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, 0.07), hh = c.th({ slot: "title", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h, ch = Math.round(f.H * (f.wide ? 0.42 : 0.34)), cpx = z(c, 0.034);
    const total = hh + z(c, 0.05) + ch + z(c, 0.03) + cpx * 1.3, y0 = Math.max(f.m, Math.round((f.H - total) / 2)), cy = y0 + hh + z(c, 0.05);
    c.t({ id: "title", slot: "title", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, align: c.s.align, at: 0.1, enter: "rise", stagger: "auto" });
    c.raw({ id: "bars", kind: "chart", parent: null, props: { chart: "bar", values: c.s.flip ? [8, 7, 6, 5, 3, 2] : [2, 3, 5, 6, 7, 8], x: f.m, y: cy, w: W, h: ch, color: "accent" }, timeline: { start_s: 0.6, duration_s: 2.4, tracks: [{ property: "progress", keyframes: [{ at: 0, value: 0 }, { at: 1, value: 1 }], easing: c.ez }, { property: "opacity", keyframes: [{ at: 0, value: 0 }, { at: 0.1, value: 1 }, { at: 1, value: 1 }], easing: "linear" }] }, bindings: {} });
    c.s2({ id: "axis", shape: "rect", x: f.m, y: cy + ch + 2, w: W, h: 3, fill: "muted", at: 0.5, dur: 0.6, enter: "grow_x", opacity: 0.7 });
    c.t({ id: "caption", slot: "caption", x: f.m, y: cy + ch + z(c, 0.03), w: W, px: cpx, role: "body", color: "muted", lh: 1.3, align: c.s.align, at: 2.8, enter: "fade", stagger: false, maxLines: 1 });
  },
};
const chHighlight: FamilyDef = {
  id: "chart-last-bar-highlight", category: "charts", archetype: "highlight_bar", title: "Last bar highlighted",
  description: "Five muted bars grow, and the last one turns accent with its value counting up above it.",
  retrieval: "Chart: five bars grow from the baseline, the last in the accent colour with its value counting up above it. Draws attention to the latest figure.",
  mood: ["focused", "optimistic"], tone: ["analytical", "proud"], energy: "medium",
  slots: [{ name: "title", role: "headline", max_chars: 40, example: "Latest quarter" }, { name: "value", role: "number", max_chars: 4, example: "94" }],
  duration_s: 5.5, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, 0.07), g = z(c, 0.025), n = 5, bw = Math.round((W - (n - 1) * g) / n), ch = Math.round(f.H * (f.wide ? 0.4 : 0.32)), npx = z(c, 0.07);
    const hh = c.th({ slot: "title", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h, total = hh + z(c, 0.04) + npx * 1.1 + ch, y0 = Math.max(f.m, Math.round((f.H - total) / 2)), base = y0 + total, vals = [0.4, 0.55, 0.5, 0.7, 1];
    c.t({ id: "title", slot: "title", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
    vals.forEach((v, i) => {
      const idx = c.s.flip ? n - 1 - i : i, h = Math.round(ch * v), x = f.m + idx * (bw + g), last = i === n - 1;
      c.s2({ id: `bar_${i}`, shape: "rect", x, y: base - h, w: bw, h, fill: last ? "accent" : "muted", radius: Math.round(bw * 0.08), at: 0.6 + i * 0.25, dur: 0.9, enter: "grow_y_up", opacity: last ? undefined : 0.55 });
    });
    const lx = f.m + (c.s.flip ? 0 : n - 1) * (bw + g);
    c.t({ id: "value", slot: "value", x: lx, y: base - ch - Math.round(npx * 1.15), w: bw, px: npx, role: "display", color: "accent", lh: 1, align: "center", counter: { to: 94 }, at: 1.8, dur: 1.2, stagger: false });
  },
};
const chHbars: FamilyDef = {
  id: "chart-labelled-hbars", category: "charts", archetype: "hbars", title: "Labelled horizontal bars",
  description: "Four labelled horizontal bars grow to different lengths, the longest in the accent colour.",
  retrieval: "Chart: four horizontal bars with labels on the left and values on the right, the longest in the accent colour. Ranking and comparison of categories.",
  mood: ["tidy", "readable"], tone: ["analytical"], energy: "low",
  slots: [{ name: "title", role: "headline", max_chars: 40, example: "Where the time goes" }, { name: "k1", role: "label", max_chars: 16, example: "Rework" }, { name: "k2", role: "label", max_chars: 16, example: "Waiting" }, { name: "k3", role: "label", max_chars: 16, example: "Meetings" }, { name: "k4", role: "label", max_chars: 16, example: "Making" }],
  duration_s: 6, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, 0.07), lw = z(c, f.wide ? 0.2 : 0.24), vw = z(c, 0.12), bh = z(c, 0.06), rh = Math.round(bh * 1.7), lpx = z(c, 0.04), vals = [78, 52, 34, 21];
    const hh = c.th({ slot: "title", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h, total = hh + z(c, 0.05) + 4 * rh, y0 = Math.max(f.m, Math.round((f.H - total) / 2)), bw = W - lw - vw - z(c, 0.04);
    c.t({ id: "title", slot: "title", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
    vals.forEach((v, i) => {
      const y = y0 + hh + z(c, 0.05) + i * rh, at = 0.7 + i * 0.3, w = Math.round(bw * (v / 100));
      c.t({ id: `k${i + 1}`, slot: `k${i + 1}`, x: f.m, y: y + Math.round((bh - lpx * 1.2) / 2), w: lw, px: lpx, role: "body", bold: true, lh: 1.2, align: "left", at, enter: "fade", stagger: false, maxLines: 1 });
      c.s2({ id: `hb_${i}`, shape: "rect", x: f.m + lw + z(c, 0.02), y, w, h: bh, fill: i === 0 ? "accent" : "muted", radius: Math.round(bh * 0.25), at: at + 0.1, dur: 1.1, enter: "grow_x", opacity: i === 0 ? undefined : 0.55 });
      c.t({ id: `val_${i}`, slot: `k${i + 1}`, bind: false, text: `${v}%`, x: f.W - f.m - vw, y: y + Math.round((bh - lpx * 1.2) / 2), w: vw, px: lpx, role: "mono", color: i === 0 ? "accent" : "muted", lh: 1.2, align: "right", at: at + 0.9, enter: "fade", stagger: false });
    });
  },
};
const chCompare: FamilyDef = {
  id: "chart-paired-columns", category: "charts", archetype: "paired_columns", title: "Paired columns with legend",
  description: "Three pairs of columns, one accent and one second-accent, with a two-item legend beneath.",
  retrieval: "Chart: three pairs of columns comparing two series, one in the accent colour and one in the second accent, with a legend beneath. Side-by-side comparison across periods.",
  mood: ["comparative", "clear"], tone: ["analytical"], energy: "medium",
  slots: [{ name: "title", role: "headline", max_chars: 40, example: "Plan versus actual" }, { name: "series_a", role: "label", max_chars: 18, example: "Planned" }, { name: "series_b", role: "label", max_chars: 18, example: "Delivered" }],
  duration_s: 6, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, 0.07), ch = Math.round(f.H * (f.wide ? 0.38 : 0.3)), lpx = z(c, 0.036), pairs = [[0.5, 0.45], [0.65, 0.7], [0.8, 0.95]];
    const hh = c.th({ slot: "title", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h, total = hh + z(c, 0.05) + ch + z(c, 0.04) + lpx * 1.3, y0 = Math.max(f.m, Math.round((f.H - total) / 2)), base = y0 + hh + z(c, 0.05) + ch;
    const gp = z(c, 0.05), pw = Math.round((W - 2 * gp) / 3), bw = Math.round(pw / 2 - z(c, 0.006));
    c.t({ id: "title", slot: "title", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
    pairs.forEach(([a, b], i) => {
      const x0 = f.m + (c.s.flip ? 2 - i : i) * (pw + gp);
      [[a!, "accent", 0], [b!, "accent_2", 1]].forEach(([v, col, k]) => c.s2({ id: `col_${i}_${k}`, shape: "rect", x: x0 + (k as number) * (bw + z(c, 0.012)), y: base - Math.round(ch * (v as number)), w: bw, h: Math.round(ch * (v as number)), fill: col as "accent" | "accent_2", radius: Math.round(bw * 0.08), at: 0.6 + i * 0.35 + (k as number) * 0.15, dur: 0.9, enter: "grow_y_up" }));
    });
    c.s2({ id: "base", shape: "rect", x: f.m, y: base + 2, w: W, h: 3, fill: "muted", at: 0.5, dur: 0.6, enter: "grow_x", opacity: 0.7 });
    const ly = base + z(c, 0.04), sw = z(c, 0.03), lw = Math.round(W * 0.3);
    [["series_a", "accent", 0], ["series_b", "accent_2", 1]].forEach(([slot, col, k]) => {
      const x = f.m + (k as number) * lw;
      c.s2({ id: `key_${k}`, shape: "rect", x, y: ly + Math.round((lpx * 1.2 - sw) / 2), w: sw, h: sw, fill: col as "accent" | "accent_2", radius: 4, at: 2.8, dur: 0.4, enter: "fade" });
      c.t({ id: String(slot), slot: String(slot), x: x + sw + z(c, 0.015), y: ly, w: lw - sw - z(c, 0.02), px: lpx, role: "body", lh: 1.2, align: "left", at: 2.9, enter: "fade", stagger: false, maxLines: 1 });
    });
  },
};
const chProgress: FamilyDef = {
  id: "chart-progress-meters", category: "charts", archetype: "meters", title: "Progress meters",
  description: "Three labelled meters fill to different levels with their percentage counting up.",
  retrieval: "Chart: three labelled progress meters that fill to different levels while the percentage counts up. Completion, adoption or satisfaction levels.",
  mood: ["satisfying", "clean"], tone: ["analytical", "upbeat"], energy: "medium",
  slots: [{ name: "title", role: "headline", max_chars: 40, example: "Adoption by team" }, { name: "m1", role: "label", max_chars: 18, example: "Design" }, { name: "m2", role: "label", max_chars: 18, example: "Marketing" }, { name: "m3", role: "label", max_chars: 18, example: "Support" }],
  duration_s: 6, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, 0.07), lpx = z(c, 0.04), rh = z(c, 0.14), th = z(c, 0.03), vals = [92, 71, 48], hh = c.th({ slot: "title", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h;
    const total = hh + z(c, 0.05) + 3 * rh, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
    c.t({ id: "title", slot: "title", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
    vals.forEach((v, i) => {
      const y = y0 + hh + z(c, 0.05) + i * rh, at = 0.7 + i * 0.35, vw = z(c, 0.14), w = Math.round(W * (v / 100));
      c.t({ id: `m${i + 1}`, slot: `m${i + 1}`, x: f.m, y, w: W - vw, px: lpx, role: "body", bold: true, lh: 1.2, align: "left", at, enter: "fade", stagger: false, maxLines: 1 });
      c.t({ id: `pct_${i}`, slot: `m${i + 1}`, bind: false, text: `${v}%`, x: f.W - f.m - vw, y, w: vw, px: lpx, role: "mono", color: i === 0 ? "accent" : "text", lh: 1.2, align: "right", counter: { to: v, suffix: "%" }, at: at + 0.1, dur: 1.4, stagger: false });
      c.s2({ id: `track_${i}`, shape: "rect", x: f.m, y: y + Math.round(lpx * 1.5), w: W, h: th, fill: "surface", radius: Math.round(th / 2), at, dur: 0.4, enter: "fade" });
      c.s2({ id: `fill_${i}`, shape: "rect", x: c.s.flip ? f.m + W - w : f.m, y: y + Math.round(lpx * 1.5), w, h: th, fill: i === 0 ? "accent" : "accent_2", radius: Math.round(th / 2), at: at + 0.1, dur: 1.4, enter: c.s.flip ? "grow_x_r" : "grow_x" });
    });
  },
};

// ============================================================ lower_thirds_captions
const ltName: FamilyDef = {
  id: "lt-name-bar", category: "lower_thirds_captions", archetype: "name_bar", title: "Name and role bar",
  description: "An accent bar draws up the left, then a name and role slide in beside it at the lower left.",
  retrieval: "Lower third: an accent bar draws, then a speaker's name and role slide in beside it at the lower left of the frame. Introduces a person on screen.",
  mood: ["professional", "tidy"], tone: ["neutral"], industry: ["interview", "corporate"], energy: "low",
  slots: [{ name: "name", role: "name", max_chars: 28, example: "Dana Whitfield" }, { name: "role", role: "caption", max_chars: 44, example: "Head of Marketing" }],
  duration_s: 5, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, npx = z(c, 0.05), rpx = z(c, 0.034), w = f.wide ? Math.round(f.W * 0.4) : f.W - 2 * f.m, h = Math.round(npx * 1.2 + rpx * 1.3 + z(c, 0.012)), y = f.H - f.m - z(c, 0.06) - h, bar = z(c, 0.012);
    const x = c.s.flip ? f.W - f.m - w : f.m, tx = c.s.flip ? x : x + bar + z(c, 0.025), tw = w - bar - z(c, 0.025), al = c.s.flip ? "right" : "left";
    c.s2({ id: "bar", shape: "rect", x: c.s.flip ? x + w - bar : x, y, w: bar, h, fill: "accent", at: 0.2, dur: 0.6, enter: "grow_y" });
    c.t({ id: "name", slot: "name", x: tx, y, w: tw, px: npx, role: "display", lh: 1.2, align: al, at: 0.6, enter: c.s.flip ? "right" : "left", stagger: false, maxLines: 1 });
    c.t({ id: "role", slot: "role", x: tx, y: y + Math.round(npx * 1.2 + z(c, 0.012)), w: tw, px: rpx, role: "body", color: "muted", lh: 1.3, align: al, at: 0.85, enter: "fade", stagger: false, maxLines: 1 });
  },
};
const ltCaption: FamilyDef = {
  id: "lt-caption-box", category: "lower_thirds_captions", archetype: "caption_box", title: "Caption in a box",
  description: "A surface box rises at the bottom and the caption words appear in it one by one.",
  retrieval: "Caption: a surface box rises at the bottom of the frame and the spoken words appear in it one by one. Readable captions for speech, with a box for contrast.",
  mood: ["readable", "plain"], tone: ["neutral"], industry: ["social", "interview"], energy: "low",
  slots: [{ name: "caption", role: "caption", max_chars: 90, example: "Nothing renders until you approve the plan." }],
  duration_s: 5, axes: ["palette", "pairing", "motion", "stagger", "backdrop", "camera"], base: { stagger: "word" },
  build(c) {
    const { f } = c, w = f.wide ? Math.round(f.W * 0.62) : f.W - 2 * f.m, px = z(c, f.wide ? 0.048 : 0.052), pad = z(c, 0.03), th = c.th({ slot: "caption", w: w - 2 * pad, px, role: "body", bold: true, maxLines: 3, lh: 1.25 }), bh = Math.round(th.h + 2 * pad), x = Math.round((f.W - w) / 2), y = f.H - f.m - z(c, 0.05) - bh;
    c.s2({ id: "box", shape: "rect", x, y, w, h: bh, fill: "surface", stroke: "muted", stroke_w: 2, radius: z(c, 0.02), at: 0.2, dur: 0.6, enter: "rise" });
    c.t({ id: "caption", slot: "caption", x: x + pad, y: y + pad, w: w - 2 * pad, px, role: "body", bold: true, lh: 1.25, align: "center", at: 0.6, enter: "fade", stagger: "word", maxLines: 3 });
  },
};
const ltLine: FamilyDef = {
  id: "lt-minimal-line", category: "lower_thirds_captions", archetype: "minimal_line", title: "Minimal line title",
  description: "A hairline draws across the lower third, with a title above it and a line of detail below.",
  retrieval: "Lower third: a hairline draws across the lower part of the frame with a title above it and a line of detail below. Understated location, topic or chapter label.",
  mood: ["minimal", "editorial"], tone: ["quiet"], industry: ["documentary", "travel"], energy: "low",
  slots: [{ name: "title", role: "headline", max_chars: 36, example: "Lisbon, Portugal" }, { name: "detail", role: "caption", max_chars: 50, example: "Where the first film was made" }],
  duration_s: 5, axes: ["palette", "pairing", "motion", "align", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, w = f.wide ? Math.round(f.W * 0.5) : f.W - 2 * f.m, tpx = z(c, 0.052), dpx = z(c, 0.034), x = c.ax(w), h = Math.round(tpx * 1.2 + z(c, 0.02) + 3 + z(c, 0.02) + dpx * 1.3), y = f.H - f.m - z(c, 0.06) - h;
    c.t({ id: "title", slot: "title", x, y, w, px: tpx, role: "display", lh: 1.2, at: 0.5, enter: "rise", stagger: false, maxLines: 1 });
    c.s2({ id: "line", shape: "rect", x: ox2(c, x, w, w), y: y + Math.round(tpx * 1.2 + z(c, 0.02)), w, h: 3, fill: "accent", at: 0.2, dur: 0.8, enter: c.s.align === "right" ? "grow_x_r" : c.s.align === "center" ? "grow_x_c" : "grow_x" });
    c.t({ id: "detail", slot: "detail", x, y: y + Math.round(tpx * 1.2 + z(c, 0.04) + 3), w, px: dpx, role: "body", color: "muted", lh: 1.3, at: 1.0, enter: "fade", stagger: false, maxLines: 1 });
  },
};
const ox2 = (_c: Ctx, x: number, _w: number, _rw: number) => x;
const ltChip: FamilyDef = {
  id: "lt-tag-chip", category: "lower_thirds_captions", archetype: "tag_chip", title: "Tag chip with title",
  description: "A small accent chip with a short tag pops in above a title at the lower left.",
  retrieval: "Lower third: a small accent chip carrying a short tag such as LIVE or NEW pops in above a title line at the lower left. Labels the kind of content on screen.",
  mood: ["news", "snappy"], tone: ["factual"], industry: ["news", "social"], energy: "medium",
  slots: [{ name: "tag", role: "label", max_chars: 10, example: "NEW" }, { name: "title", role: "headline", max_chars: 50, example: "The two-approval workflow" }],
  duration_s: 5, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, w = f.wide ? Math.round(f.W * 0.55) : f.W - 2 * f.m, tpx = z(c, 0.034), cw = z(c, 0.14), ch = Math.round(tpx * 1.9), px = z(c, 0.056), th = c.th({ slot: "title", w, px, role: "display", maxLines: 2, lh: 1.12 }).h, y = f.H - f.m - z(c, 0.06) - th - z(c, 0.02) - ch, x = c.s.flip ? f.W - f.m - w : f.m, al = c.s.flip ? "right" : "left";
    c.s2({ id: "chip", shape: "rect", x: c.s.flip ? x + w - cw : x, y, w: cw, h: ch, fill: "accent", radius: Math.round(ch / 2), at: 0.2, dur: 0.5, enter: "pop" });
    c.t({ id: "tag", slot: "tag", x: c.s.flip ? x + w - cw : x, y: y + Math.round((ch - tpx * 1.2) / 2), w: cw, px: tpx, role: "mono", upper: true, color: "background", lh: 1.2, align: "center", at: 0.3, enter: "fade", stagger: false, maxLines: 1 });
    c.t({ id: "title", slot: "title", x, y: y + ch + z(c, 0.02), w, px, role: "display", lh: 1.12, align: al, at: 0.6, enter: c.s.flip ? "right" : "left", stagger: false, maxLines: 2 });
  },
};
const ltCorner: FamilyDef = {
  id: "lt-corner-stack", category: "lower_thirds_captions", archetype: "corner_stack", title: "Corner stack",
  description: "A two-line monospace stack in the top corner, such as a place and a date, that types in.",
  retrieval: "Lower third or corner label: a two-line monospace stack in the top corner, such as a place and a date, that types in character by character. Location and date stamp.",
  mood: ["documentary", "technical"], tone: ["matter-of-fact"], industry: ["documentary", "travel", "journalism"], energy: "low",
  slots: [{ name: "line_1", role: "label", max_chars: 28, example: "Lisbon, Portugal" }, { name: "line_2", role: "caption", max_chars: 28, example: "14 March 2025" }],
  duration_s: 4.5, axes: ["palette", "motion", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, w = f.wide ? Math.round(f.W * 0.34) : f.W - 2 * f.m, p1 = z(c, 0.042), p2 = z(c, 0.034), x = c.s.flip ? f.W - f.m - w : f.m, al = c.s.flip ? "right" : "left";
    c.s2({ id: "tick", shape: "rect", x: c.s.flip ? x + w - z(c, 0.08) : x, y: f.m, w: z(c, 0.08), h: 4, fill: "accent", at: 0.1, dur: 0.5, enter: c.s.flip ? "grow_x_r" : "grow_x" });
    c.t({ id: "line_1", slot: "line_1", x, y: f.m + z(c, 0.025), w, px: p1, role: "mono", bold: true, lh: 1.25, align: al, at: 0.4, enter: "fade", stagger: "char", maxLines: 1 });
    c.t({ id: "line_2", slot: "line_2", x, y: f.m + z(c, 0.025) + Math.round(p1 * 1.4), w, px: p2, role: "mono", color: "muted", lh: 1.25, align: al, at: 1.0, enter: "fade", stagger: "char", maxLines: 1 });
  },
};

export const SUPPORT_1_FAMILIES: FamilyDef[] = [ktWordPop, ktCharCascade, ktTracking, ktAlternate, ktEmphasis, trWipe, trIris, trStripes, trPush, bgGrid, bgOrbs, bgBands, bgBars, bgRings, ...camFamilies, chBars, chHighlight, chHbars, chCompare, chProgress, ltName, ltCaption, ltLine, ltChip, ltCorner];
