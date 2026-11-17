import type { CompElement } from "./visual.js";
import type { z } from "zod";

/**
 * Building blocks for compositions: the old fixed blocks (message thread, UI window, process flow, chart, kinetic type, cards, end card, callouts, panels, route, timeline,
 * title, quote, closing) re-expressed as plain elements (text and shapes with their own motion). They are not templates the renderer must pick: each returns ordinary
 * composition elements that the Director, or the stub that stands in for it, may use, change or ignore, mixing them with anything else on the frame. Every block lays itself out
 * for landscape and for portrait (the portrait positions go in each element's `portrait` override), and every text it draws is a string the caller passes in, so what is shown
 * stays inside the scene's approved words.
 */
type El = z.input<typeof CompElement>;
type Place = { x: number; y: number; w: number; h?: number; size?: number };
type Motion = NonNullable<Extract<El, { kind: "text" }>["motion"]>;

const BODY = 0.04, SMALL = 0.03, BIG = 0.09;

const text = (id: string, s: string, p: Place & { size: number }, o: { color?: "text" | "muted" | "accent" | "accent_2" | "background"; align?: "left" | "center" | "right"; weight?: "regular" | "bold"; upper?: boolean; font?: "display" | "body" | "mono"; motion?: Motion } = {}): El =>
  ({ id, kind: "text", text: s, at: { x: p.x, y: p.y, w: p.w }, size: p.size, weight: o.weight ?? "bold", align: o.align ?? "left", upper: o.upper ?? false, color: o.color ?? "text", ...(o.font ? { font: o.font } : {}), ...(o.motion ? { motion: o.motion } : {}) });
const box = (id: string, shape: "rect" | "ellipse" | "line", p: Place & { h: number }, o: { fill?: "surface" | "accent" | "accent_2" | "muted" | "text" | "background"; stroke?: "accent" | "muted" | "text"; stroke_w?: number; radius?: number; opacity?: number; motion?: Motion } = {}): El =>
  ({ id, kind: "shape", shape, at: { x: p.x, y: p.y, w: p.w, h: p.h }, ...(o.fill ? { fill: o.fill } : {}), ...(o.stroke ? { stroke: o.stroke } : {}), stroke_w: o.stroke_w ?? 0, radius: o.radius ?? 0, opacity: o.opacity ?? 1, ...(o.motion ? { motion: o.motion } : {}) });
const at = (delay: number, enter: Motion["enter"] = "rise", duration = 0.16): Motion => ({ enter, delay, duration, easing: "ease_out" });

/** Builds a layout for landscape and for portrait with the same element ids, and returns elements whose portrait override carries the portrait position. */
function dual(build: (portrait: boolean) => El[]): El[] {
  const L = build(false), P = new Map(build(true).map((e) => [e.id, e]));
  return L.map((e) => {
    const p = P.get(e.id);
    if (!p) return e;
    const place = (x: El): Place => ({ x: x.at.x, y: x.at.y, w: "w" in x.at ? x.at.w : 0, ...("h" in x.at && x.at.h !== undefined ? { h: x.at.h } : {}), ...(x.kind === "text" ? { size: x.size } : {}) });
    const a = place(e), b = place(p);
    const same = (Object.keys(b) as (keyof Place)[]).every((key) => a[key] === b[key]);
    return same ? e : { ...e, portrait: b } as El;
  });
}

export const messageThread = (messages: readonly { from: "them" | "you"; text: string }[]): El[] => dual((pt) => {
  const n = messages.length, top = 0.14, gap = (0.78 - top) / n, h = Math.min(0.13, gap * 0.82), w = pt ? 0.8 : 0.5;
  return messages.flatMap((m, i) => {
    const x = m.from === "them" ? (pt ? 0.06 : 0.12) : (pt ? 0.94 - w : 0.88 - w), y = top + i * gap;
    return [box(`bubble${i}`, "rect", { x, y, w, h }, { fill: m.from === "them" ? "surface" : "accent", radius: 0.03, motion: at(i * 0.1, m.from === "them" ? "slide_right" : "slide_left") }),
      text(`msg${i}`, m.text, { x: x + 0.02, y: y + h * 0.22, w: w - 0.04, size: pt ? 0.035 : BODY * 0.95 }, { weight: "regular", color: m.from === "them" ? "text" : "background", motion: at(i * 0.1 + 0.03, "fade") })];
  });
});

export const uiWindow = (title: string, rows: readonly { label: string; tag?: string }[], confirm?: string): El[] => dual((pt) => {
  const x = pt ? 0.06 : 0.2, w = pt ? 0.88 : 0.6, top = pt ? 0.14 : 0.12, n = rows.length, rh = Math.min(0.1, 0.5 / n);
  return [
    box("window", "rect", { x, y: top, w, h: 0.12 + n * (rh + 0.015) + 0.04 }, { fill: "surface", radius: 0.025, motion: at(0, "scale_in") }),
    text("wtitle", title, { x: x + 0.03, y: top + 0.025, w: w - 0.06, size: SMALL }, { color: "muted", font: "mono", motion: at(0.05, "fade") }),
    ...rows.flatMap((r, i) => [
      box(`row${i}`, "rect", { x: x + 0.025, y: top + 0.11 + i * (rh + 0.015), w: w - 0.05, h: rh }, { fill: "background", radius: 0.015, opacity: 0.55, motion: at(0.08 + i * 0.07, "rise") }),
      text(`rowt${i}`, r.tag ? `${r.label}  ${r.tag}` : r.label, { x: x + 0.045, y: top + 0.11 + i * (rh + 0.015) + rh * 0.28, w: w - 0.09, size: pt ? 0.032 : 0.034 }, { weight: "regular", motion: at(0.1 + i * 0.07, "fade") }),
    ]),
    ...(confirm ? [box("pill", "rect", { x: pt ? 0.2 : 0.38, y: top + 0.17 + n * (rh + 0.015), w: pt ? 0.6 : 0.24, h: 0.08 }, { fill: "accent", radius: 0.04, motion: at(0.6, "scale_in") }), text("pillt", confirm, { x: pt ? 0.2 : 0.38, y: top + 0.19 + n * (rh + 0.015), w: pt ? 0.6 : 0.24, size: SMALL }, { align: "center", color: "background", motion: at(0.62, "fade") })] : []),
  ];
});

export const processFlow = (steps: readonly { label: string; detail?: string }[]): El[] => dual((pt) => {
  const n = steps.length;
  return steps.flatMap((s, i) => {
    const cx = pt ? 0.12 : 0.12 + (i * 0.76) / Math.max(1, n - 1), cy = pt ? 0.16 + (i * 0.66) / Math.max(1, n - 1) : 0.42, d = pt ? 0.09 : 0.1;
    return [
      box(`dot${i}`, "ellipse", { x: cx - d / 2, y: cy - (pt ? d / 2 : d / 2 * 1.78), w: d, h: pt ? d : d * 1.78 }, { fill: "accent", motion: at(i * 0.14, "scale_in") }),
      text(`num${i}`, String(i + 1), { x: cx - d / 2, y: cy - (pt ? 0.025 : 0.04), w: d, size: pt ? 0.045 : 0.06 }, { align: "center", color: "background", font: "mono", motion: at(i * 0.14 + 0.02, "fade") }),
      text(`step${i}`, s.label, { x: pt ? 0.26 : cx - 0.1, y: pt ? cy - 0.03 : 0.54, w: pt ? 0.68 : 0.2, size: pt ? 0.045 : 0.036 }, { align: pt ? "left" : "center", motion: at(i * 0.14 + 0.04, "rise") }),
      ...(s.detail ? [text(`det${i}`, s.detail, { x: pt ? 0.26 : cx - 0.1, y: pt ? cy + 0.025 : 0.65, w: pt ? 0.68 : 0.2, size: SMALL * 0.9 }, { align: pt ? "left" : "center", weight: "regular", color: "muted", motion: at(i * 0.14 + 0.08, "fade") })] : []),
    ];
  });
});

export const barChart = (title: string, points: readonly { label: string; value: number }[]): El[] => dual((pt) => {
  const n = points.length, x0 = 0.1, W = 0.8, bw = W / n, base = pt ? 0.78 : 0.78, maxH = pt ? 0.46 : 0.5;
  return [
    text("ctitle", title, { x: 0.08, y: 0.08, w: 0.84, size: pt ? 0.05 : 0.055 }, { motion: at(0, "rise") }),
    ...points.flatMap((p, i) => {
      const h = (p.value / 100) * maxH;
      return [
        box(`bar${i}`, "rect", { x: x0 + i * bw + bw * 0.12, y: base - h, w: bw * 0.76, h }, { fill: i === points.length - 1 ? "accent" : "accent_2", radius: 0.006, motion: at(0.1 + i * 0.08, "rise", 0.2) }),
        text(`blabel${i}`, p.label, { x: x0 + i * bw, y: base + 0.02, w: bw, size: pt ? 0.026 : 0.028 }, { align: "center", weight: "regular", color: "muted", motion: at(0.2 + i * 0.08, "fade") }),
      ];
    }),
    text("illustrative", "Illustrative data", { x: 0.08, y: 0.9, w: 0.4, size: 0.024 }, { weight: "regular", color: "muted", font: "mono", motion: at(0.3, "fade") }),
  ];
});

export const kineticHeadline = (s: string, accentWord?: string): El[] => dual((pt) => [
  text("kinetic", s, { x: pt ? 0.07 : 0.08, y: pt ? 0.3 : 0.3, w: pt ? 0.86 : 0.84, size: pt ? 0.11 : 0.1 }, { motion: { enter: "rise", delay: 0, duration: 0.25, easing: "spring", stagger: { unit: "word", each: 0.06 } } }),
  ...(accentWord ? [box("underline", "rect", { x: pt ? 0.07 : 0.08, y: pt ? 0.7 : 0.72, w: 0.18, h: 0.012 }, { fill: "accent", motion: at(0.5, "wipe") })] : []),
]);

export const layeredCards = (cards: readonly { title: string; detail?: string }[]): El[] => dual((pt) => {
  const n = cards.length, w = pt ? 0.8 : 0.5, h = pt ? 0.2 : 0.26;
  return cards.flatMap((c, i) => {
    const x = (pt ? 0.1 : 0.12) + (pt ? 0 : i * (0.76 - w) / Math.max(1, n - 1)), y = (pt ? 0.12 : 0.18) + i * (pt ? 0.19 : 0.17);
    return [
      box(`card${i}`, "rect", { x, y, w, h }, { fill: "surface", stroke: "accent", stroke_w: 0.003, radius: 0.025, motion: at(i * 0.14, "rise") }),
      text(`ctitle${i}`, c.title, { x: x + 0.03, y: y + 0.035, w: w - 0.06, size: pt ? 0.05 : 0.045 }, { motion: at(i * 0.14 + 0.05, "fade") }),
      ...(c.detail ? [text(`cdet${i}`, c.detail, { x: x + 0.03, y: y + (pt ? 0.105 : 0.12), w: w - 0.06, size: SMALL }, { weight: "regular", color: "muted", motion: at(i * 0.14 + 0.08, "fade") })] : []),
    ];
  });
});

export const endCard = (button: string, wordmark?: string, subline?: string): El[] => dual((pt) => [
  ...(wordmark ? [text("wordmark", wordmark, { x: 0.1, y: pt ? 0.24 : 0.2, w: 0.8, size: pt ? 0.08 : 0.07 }, { align: "center", motion: at(0, "fade") })] : []),
  box("button", "rect", { x: pt ? 0.14 : 0.3, y: pt ? 0.42 : 0.4, w: pt ? 0.72 : 0.4, h: pt ? 0.1 : 0.14 }, { fill: "accent", radius: 0.03, motion: at(0.12, "scale_in") }),
  text("buttont", button, { x: pt ? 0.14 : 0.3, y: pt ? 0.45 : 0.44, w: pt ? 0.72 : 0.4, size: pt ? 0.05 : 0.05 }, { align: "center", color: "background", motion: at(0.2, "fade") }),
  ...(subline ? [text("subline", subline, { x: 0.1, y: pt ? 0.58 : 0.6, w: 0.8, size: SMALL }, { align: "center", weight: "regular", color: "muted", motion: at(0.3, "fade") })] : []),
]);

export const specCallouts = (notes: readonly { label: string; detail?: string }[]): El[] => dual((pt) => {
  const n = notes.length, d = pt ? 0.44 : 0.3;
  return [
    box("form", "ellipse", { x: 0.5 - d / 2, y: pt ? 0.14 : 0.5 - (d * 1.78) / 2, w: d, h: pt ? d * 0.56 : d * 1.78 }, { fill: "surface", stroke: "accent", stroke_w: 0.004, motion: at(0, "scale_in", 0.24) }),
    ...notes.flatMap((nt, i) => {
      const left = pt ? true : i % 2 === 0, row = pt ? i : Math.floor(i / 2), rows = pt ? n : Math.ceil(n / 2);
      const y = pt ? 0.42 + row * (0.5 / rows) : 0.22 + row * (0.56 / Math.max(1, rows)), x = pt ? 0.1 : left ? 0.06 : 0.66, w = pt ? 0.8 : 0.28;
      return [
        box(`lead${i}`, "line", { x: pt ? 0.1 : left ? 0.34 : 0.5, y: y + 0.02, w: pt ? 0.04 : 0.16, h: 0 }, { stroke: "muted", stroke_w: 0.002, motion: at(0.2 + i * 0.1, "wipe") }),
        text(`note${i}`, nt.label, { x: x + (pt ? 0.07 : 0), y, w: w - (pt ? 0.07 : 0), size: pt ? 0.04 : 0.036 }, { align: pt ? "left" : left ? "right" : "left", motion: at(0.24 + i * 0.1, "fade") }),
        ...(nt.detail ? [text(`ndet${i}`, nt.detail, { x: x + (pt ? 0.07 : 0), y: y + (pt ? 0.05 : 0.055), w: w - (pt ? 0.07 : 0), size: SMALL * 0.9 }, { align: pt ? "left" : left ? "right" : "left", weight: "regular", color: "muted", motion: at(0.28 + i * 0.1, "fade") })] : []),
      ];
    }),
  ];
});

export const splitPanels = (panels: readonly { word: string; note?: string }[]): El[] => dual((pt) => {
  const n = panels.length, fills = ["surface", "accent", "accent_2", "muted"] as const;
  return panels.flatMap((p, i) => {
    // inset from the frame edge: a panel that touches it reads as clipped to the renderer's own check
    const w = pt ? 0.9 : 0.9 / n, h = pt ? 0.88 / n : 0.88, x = pt ? 0.05 : 0.05 + i * w, y = 0.06 + (pt ? i * h : 0);
    const dark = fills[i % 4] === "surface";
    return [
      box(`panel${i}`, "rect", { x, y, w, h }, { fill: fills[i % 4], motion: at(i * 0.1, pt ? "slide_left" : "rise", 0.2) }),
      text(`pword${i}`, p.word, { x: x + 0.03, y: y + h * (pt ? 0.24 : 0.36), w: w - 0.06, size: pt ? 0.075 : Math.min(0.1, 0.8 / n * 0.4) }, { align: "center", color: dark ? "text" : "background", motion: at(i * 0.1 + 0.08, "fade") }),
      ...(p.note ? [text(`pnote${i}`, p.note, { x: x + 0.03, y: y + h * (pt ? 0.66 : 0.62), w: w - 0.06, size: SMALL * 0.9 }, { align: "center", weight: "regular", color: dark ? "muted" : "background", motion: at(i * 0.1 + 0.12, "fade") })] : []),
    ];
  });
});

export const routeLine = (stops: readonly { label: string; note?: string }[]): El[] => dual((pt) => {
  const n = stops.length;
  return [
    box("route", "line", { x: pt ? 0.2 : 0.1, y: pt ? 0.1 : 0.5, w: pt ? 0 : 0.8, h: pt ? 0.8 : 0 }, { stroke: "accent", stroke_w: 0.004, motion: at(0, "wipe", 0.4) }),
    ...stops.flatMap((s, i) => {
      const cx = pt ? 0.2 : 0.1 + (i * 0.8) / Math.max(1, n - 1), cy = pt ? 0.14 + (i * 0.7) / Math.max(1, n - 1) : 0.5;
      return [
        box(`stop${i}`, "ellipse", { x: cx - 0.02, y: cy - (pt ? 0.02 : 0.036), w: 0.04, h: pt ? 0.04 : 0.072 }, { fill: "accent_2", motion: at(0.1 + i * 0.12, "scale_in") }),
        text(`slabel${i}`, s.label, { x: pt ? 0.3 : cx - 0.1, y: pt ? cy - 0.03 : (i % 2 ? 0.6 : 0.3), w: pt ? 0.62 : 0.2, size: pt ? 0.045 : 0.034 }, { align: pt ? "left" : "center", motion: at(0.14 + i * 0.12, "fade") }),
        ...(s.note ? [text(`snote${i}`, s.note, { x: pt ? 0.3 : cx - 0.1, y: pt ? cy + 0.03 : (i % 2 ? 0.67 : 0.37), w: pt ? 0.62 : 0.2, size: SMALL * 0.9 }, { align: pt ? "left" : "center", weight: "regular", color: "muted", motion: at(0.18 + i * 0.12, "fade") })] : []),
      ];
    }),
  ];
});

export const timelineRule = (marks: readonly { when: string; label: string }[]): El[] => dual((pt) => {
  const n = marks.length;
  return [
    box("rule", "line", { x: pt ? 0.2 : 0.08, y: pt ? 0.12 : 0.5, w: pt ? 0 : 0.84, h: pt ? 0.76 : 0 }, { stroke: "muted", stroke_w: 0.003, motion: at(0, "wipe", 0.35) }),
    ...marks.flatMap((m, i) => {
      const cx = pt ? 0.2 : 0.12 + (i * 0.76) / Math.max(1, n - 1), cy = pt ? 0.16 + (i * 0.68) / Math.max(1, n - 1) : 0.5;
      return [
        box(`tick${i}`, "ellipse", { x: cx - 0.014, y: cy - (pt ? 0.014 : 0.025), w: 0.028, h: pt ? 0.028 : 0.05 }, { fill: "accent", motion: at(0.1 + i * 0.12, "scale_in") }),
        text(`when${i}`, m.when, { x: pt ? 0.28 : cx - 0.1, y: pt ? cy - 0.04 : (i % 2 ? 0.58 : 0.34), w: pt ? 0.64 : 0.2, size: pt ? 0.032 : 0.03 }, { align: pt ? "left" : "center", color: "accent", font: "mono", motion: at(0.12 + i * 0.12, "fade") }),
        text(`what${i}`, m.label, { x: pt ? 0.28 : cx - 0.1, y: pt ? cy : (i % 2 ? 0.64 : 0.4), w: pt ? 0.64 : 0.2, size: pt ? 0.045 : 0.034 }, { align: pt ? "left" : "center", motion: at(0.16 + i * 0.12, "rise") }),
      ];
    }),
  ];
});

export const titleBlock = (title: string, eyebrow?: string, subline?: string): El[] => dual((pt) => [
  ...(eyebrow ? [text("eyebrow", eyebrow, { x: 0.08, y: pt ? 0.3 : 0.28, w: 0.84, size: SMALL }, { align: "center", color: "accent", font: "mono", upper: true, motion: at(0, "fade") })] : []),
  text("title", title, { x: 0.08, y: pt ? 0.38 : 0.36, w: 0.84, size: pt ? 0.1 : 0.09 }, { align: "center", motion: at(0.08, "rise", 0.25) }),
  box("rule", "line", { x: 0.4, y: pt ? 0.62 : 0.64, w: 0.2, h: 0 }, { stroke: "accent", stroke_w: 0.003, motion: at(0.3, "wipe") }),
  box("band", "rect", { x: 0.1, y: pt ? 0.84 : 0.86, w: 0.8, h: 0.012 }, { fill: "accent_2", motion: at(0.35, "wipe") }),
  ...(subline ? [text("subline", subline, { x: 0.1, y: pt ? 0.66 : 0.68, w: 0.8, size: BODY * 0.85 }, { align: "center", weight: "regular", color: "muted", motion: at(0.38, "fade") })] : []),
]);

export const quoteBlock = (quote: string, by?: string): El[] => dual((pt) => [
  box("bar", "rect", { x: 0.06, y: pt ? 0.34 : 0.32, w: 0.008, h: pt ? 0.34 : 0.4 }, { fill: "accent", motion: at(0.05, "wipe") }),
  text("mark", "\u201C", { x: 0.08, y: pt ? 0.1 : 0.08, w: 0.2, size: 0.14 }, { color: "accent", font: "display", motion: at(0, "fade") }),
  text("quote", quote, { x: 0.1, y: pt ? 0.36 : 0.32, w: 0.8, size: pt ? 0.075 : 0.07 }, { weight: "regular", font: "display", motion: at(0.1, "rise", 0.25) }),
  ...(by ? [text("by", by, { x: 0.1, y: pt ? 0.78 : 0.78, w: 0.8, size: SMALL }, { color: "muted", font: "mono", motion: at(0.45, "fade") })] : []),
]);

export const closingBlock = (action: string, wordmark?: string, subline?: string): El[] => dual((pt) => [
  ...(wordmark ? [text("wordmark", wordmark, { x: 0.1, y: pt ? 0.3 : 0.28, w: 0.8, size: pt ? 0.07 : 0.06 }, { align: "center", font: "display", motion: at(0, "fade") })] : []),
  box("rule", "line", { x: 0.42, y: pt ? 0.44 : 0.44, w: 0.16, h: 0 }, { stroke: "accent", stroke_w: 0.003, motion: at(0.15, "wipe") }),
  text("action", action, { x: 0.1, y: pt ? 0.48 : 0.48, w: 0.8, size: pt ? 0.07 : 0.065 }, { align: "center", motion: at(0.25, "rise") }),
  box("band", "rect", { x: 0.1, y: pt ? 0.8 : 0.82, w: 0.8, h: 0.012 }, { fill: "accent", motion: at(0.3, "wipe") }),
  ...(subline ? [text("subline", subline, { x: 0.1, y: pt ? 0.7 : 0.64, w: 0.8, size: SMALL }, { align: "center", weight: "regular", color: "muted", motion: at(0.4, "fade") })] : []),
]);

/** All the building blocks, by name, for the Director's prompt and for tests. */
export const BUILDING_BLOCKS = { messageThread, uiWindow, processFlow, barChart, kineticHeadline, layeredCards, endCard, specCallouts, splitPanels, routeLine, timelineRule, titleBlock, quoteBlock, closingBlock } as const;