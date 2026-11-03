import type { Ctx, FamilyDef } from "../kit.js";
import { grow, ox, z } from "./common.js";

const ALL = ["palette", "pairing", "motion", "align", "flip", "backdrop", "stagger", "camera"] as const;
const NOALIGN = ["palette", "pairing", "motion", "flip", "backdrop", "camera"] as const;

/** A faux application window: a surface panel, a title bar with three dots and a hairline under it. Returns the content area. */
function appWindow(c: Ctx, p: { x: number; y: number; w: number; h: number; at: number; id?: string }) {
  const id = p.id ?? "win", bar = z(c, 0.05), r = z(c, 0.018);
  c.s2({ id: `${id}_body`, shape: "rect", x: p.x, y: p.y, w: p.w, h: p.h, fill: "surface", stroke: "muted", stroke_w: 2, radius: r, at: p.at, dur: 0.7, enter: "pop" });
  [0, 1, 2].forEach((i) => c.s2({ id: `${id}_dot${i}`, shape: "ellipse", x: p.x + r + i * z(c, 0.026), y: p.y + Math.round(bar * 0.35), w: z(c, 0.016), h: z(c, 0.016), fill: i === 0 ? "accent" : "muted", at: p.at + 0.1, dur: 0.3, enter: "fade", opacity: i === 0 ? 1 : 0.6 }));
  c.s2({ id: `${id}_rule`, shape: "rect", x: p.x, y: p.y + bar, w: p.w, h: 2, fill: "muted", at: p.at + 0.1, dur: 0.3, enter: "fade", opacity: 0.35 });
  return { x: p.x + r, y: p.y + bar + r, w: p.w - 2 * r, h: p.h - bar - 2 * r };
}
const rows = (c: Ctx, a: { x: number; y: number; w: number; h: number }, n: number, at: number, id = "row") => {
  const rh = Math.max(8, Math.round(c.f.short * 0.016)), step = Math.min(rh * 3.2, a.h / (n + 1));
  for (let i = 0; i < n; i++) c.s2({ id: `${id}${i}`, shape: "rect", x: a.x, y: a.y + i * step, w: Math.round(a.w * [0.9, 0.7, 0.8, 0.55, 0.85][i % 5]!), h: rh, fill: "muted", radius: Math.round(rh / 2), at: at + i * 0.12, dur: 0.5, enter: "grow_x", opacity: 0.4 });
};

// ============================================================ ui_demo
const uiClick: FamilyDef = {
  id: "ui-click-flow", category: "ui_demo", archetype: "cursor_click", title: "Cursor clicks the button",
  description: "A faux app window with placeholder rows; a cursor glides to an accent button, which presses, under a headline and a caption.",
  retrieval: "UI demo scene: an app window drawn from shapes with placeholder content rows, a cursor moves to a primary button and clicks it. Shows an action being taken in a product without real screenshots.",
  mood: ["clear", "demonstrative"], tone: ["instructional", "calm"], industry: ["software", "saas"], energy: "medium",
  slots: [{ name: "headline", role: "headline", max_chars: 60, example: "Approve in one click" }, { name: "button", role: "label", max_chars: 16, example: "Approve plan" }, { name: "caption", role: "caption", max_chars: 90, example: "Nothing renders until you say so." }],
  duration_s: 6, axes: NOALIGN,
  build(c) {
    const { f } = c, w = f.wide ? Math.round(f.W * 0.6) : f.W - 2 * f.m, h = f.wide ? Math.round(f.H * 0.5) : Math.round(f.H * (f.portrait ? 0.34 : 0.38));
    const hpx = z(c, f.wide ? 0.07 : 0.075), cpx = z(c, 0.036), hh = c.th({ slot: "headline", w: w, px: hpx, role: "display", maxLines: 2, lh: 1.1 }).h, ch = c.th({ slot: "caption", w, px: cpx, role: "body", maxLines: 2, lh: 1.3 }).h;
    const gap = z(c, 0.035), total = hh + gap + h + gap + ch, y0 = Math.max(f.m, Math.round((f.H - total) / 2)), x = c.fx(Math.round((f.W - w) / 2), w);
    c.t({ id: "headline", slot: "headline", x, y: y0, w, px: hpx, role: "display", maxLines: 2, lh: 1.1, align: "center", at: 0.1, enter: "rise", stagger: "auto" });
    const wy = y0 + hh + gap, area = appWindow(c, { x, y: wy, w, h, at: 0.5 });
    rows(c, { ...area, h: area.h * 0.55 }, 3, 1.0);
    const bw = z(c, 0.26), bh = z(c, 0.075), bx = Math.round(x + w - bw - z(c, 0.03)), by = Math.round(wy + h - bh - z(c, 0.03));
    c.s2({ id: "button", shape: "rect", x: bx, y: by, w: bw, h: bh, fill: "accent", radius: Math.round(bh / 2), at: 1.4, dur: 0.5, tracks: [{ property: "opacity", keyframes: [{ at: 0, value: 0 }, { at: 1, value: 1 }], easing: "ease_out" }, { property: "scale", keyframes: [{ at: 0, value: 0.9 }, { at: 1, value: 1 }], easing: c.ez }] });
    c.t({ id: "button_label", slot: "button", x: bx, y: by + Math.round((bh - z(c, 0.036) * 1.2) / 2), w: bw, px: z(c, 0.036), role: "body", bold: true, color: "background", lh: 1.2, align: "center", at: 1.4, enter: "fade", stagger: false });
    const cx = bx + Math.round(bw * 0.62), cy = by + Math.round(bh * 0.6);
    c.raw({ id: "cursor", kind: "cursor", parent: null, props: { x: cx, y: cy, size: z(c, 0.04), color: "text" }, timeline: { start_s: 2.0, duration_s: 1.6, tracks: [{ property: "x", keyframes: [{ at: 0, value: -w * 0.4 }, { at: 1, value: 0 }], easing: "ease_in_out" }, { property: "y", keyframes: [{ at: 0, value: -h * 0.3 }, { at: 1, value: 0 }], easing: "ease_in_out" }, { property: "opacity", keyframes: [{ at: 0, value: 0 }, { at: 0.15, value: 1 }, { at: 1, value: 1 }], easing: "linear" }] }, bindings: {} });
    c.s2({ id: "ripple", shape: "ellipse", x: cx - z(c, 0.03), y: cy - z(c, 0.03), w: z(c, 0.06), h: z(c, 0.06), stroke: "accent_2", stroke_w: 4, at: 3.7, dur: 0.6, tracks: [{ property: "scale", keyframes: [{ at: 0, value: 0.4 }, { at: 1, value: 2.2 }], easing: "ease_out" }, { property: "opacity", keyframes: [{ at: 0, value: 0.9 }, { at: 1, value: 0 }], easing: "linear" }] });
    c.t({ id: "caption", slot: "caption", x, y: wy + h + gap, w, px: cpx, role: "body", color: "muted", maxLines: 2, lh: 1.3, align: "center", at: 3.9, enter: "fade", stagger: false });
  },
};

const uiNotify: FamilyDef = {
  id: "ui-notification-stack", category: "ui_demo", archetype: "notifications", title: "Notification stack",
  description: "Three notification cards slide in one after another beside or under a headline.",
  retrieval: "UI demo scene with three notification cards, each with a title and a line of detail, sliding in one after another. Shows updates, alerts or messages arriving in a product.",
  mood: ["lively", "modern"], tone: ["friendly", "informative"], industry: ["software", "saas", "apps"], energy: "medium",
  slots: [{ name: "headline", role: "headline", max_chars: 50, example: "Everyone stays in the loop" }, { name: "n1_title", role: "item", max_chars: 28, example: "Plan approved" }, { name: "n1_body", role: "caption", max_chars: 44, example: "Scene 1 to 6 locked" }, { name: "n2_title", role: "item", max_chars: 28, example: "Edit plan ready" }, { name: "n2_body", role: "caption", max_chars: 44, example: "Checked against the plan" }, { name: "n3_title", role: "item", max_chars: 28, example: "Render started" }, { name: "n3_body", role: "caption", max_chars: 44, example: "Preview in about two minutes" }],
  duration_s: 6, axes: NOALIGN,
  build(c) {
    const { f } = c, cardH = z(c, 0.15), g = z(c, 0.03), colW = f.wide ? Math.round(f.W * 0.4) : f.W - 2 * f.m;
    const stackH = 3 * cardH + 2 * g, hpx = z(c, f.wide ? 0.085 : 0.08);
    let cx: number, cy: number;
    if (f.wide) {
      const hw = Math.round(f.W * 0.38);
      c.t({ id: "headline", slot: "headline", x: c.fx(f.m, hw), y: Math.round((f.H - c.th({ slot: "headline", w: hw, px: hpx, role: "display", maxLines: 4, lh: 1.08 }).h) / 2), w: hw, px: hpx, role: "display", maxLines: 4, lh: 1.08, align: c.s.flip ? "right" : "left", at: 0.1, enter: "rise", stagger: "auto" });
      cx = c.fx(f.W - f.m - colW, colW); cy = Math.round((f.H - stackH) / 2);
    } else {
      const hh = c.th({ slot: "headline", w: colW, px: hpx, role: "display", maxLines: 3, lh: 1.08 }).h;
      const top = Math.max(f.m, Math.round((f.H - (hh + g * 2 + stackH)) / 2));
      c.t({ id: "headline", slot: "headline", x: f.m, y: top, w: colW, px: hpx, role: "display", maxLines: 3, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
      cx = f.m; cy = top + hh + g * 2;
    }
    [1, 2, 3].forEach((n, i) => {
      const y = cy + i * (cardH + g), at = 0.9 + i * 0.7, pad = z(c, 0.03);
      c.s2({ id: `card_${n}`, shape: "rect", x: cx, y, w: colW, h: cardH, fill: "surface", stroke: "muted", stroke_w: 2, radius: z(c, 0.02), at, dur: 0.6, enter: c.s.flip ? "left" : "right" });
      c.s2({ id: `dot_${n}`, shape: "ellipse", x: cx + pad, y: y + Math.round(cardH / 2 - z(c, 0.014)), w: z(c, 0.028), h: z(c, 0.028), fill: i === 1 ? "accent_2" : "accent", at: at + 0.1, dur: 0.4, enter: "pop" });
      const tx = cx + pad * 2 + z(c, 0.028), tw = colW - pad * 3 - z(c, 0.028), tpx = z(c, 0.04), bpx = z(c, 0.03);
      c.t({ id: `n${n}_title`, slot: `n${n}_title`, x: tx, y: y + Math.round(cardH * 0.2), w: tw, px: tpx, role: "body", bold: true, lh: 1.15, align: "left", at: at + 0.1, enter: "fade", stagger: false, maxLines: 1 });
      c.t({ id: `n${n}_body`, slot: `n${n}_body`, x: tx, y: y + Math.round(cardH * 0.2) + Math.round(tpx * 1.3), w: tw, px: bpx, role: "body", color: "muted", lh: 1.2, align: "left", at: at + 0.2, enter: "fade", stagger: false, maxLines: 1 });
    });
  },
};

const uiZoom: FamilyDef = {
  id: "ui-callout-zoom", category: "ui_demo", archetype: "zoom_callout", title: "Zoom to a callout",
  description: "An app window with placeholder rows; a ring marks one row, the camera eases in and a callout label names it.",
  retrieval: "UI demo scene that points at one part of an interface: a ring circles a row in an app window, the camera pushes in slowly and a callout names the feature. Draws the eye to one detail.",
  mood: ["focused", "precise"], tone: ["explanatory", "calm"], industry: ["software", "saas"], energy: "low",
  slots: [{ name: "headline", role: "headline", max_chars: 50, example: "See every change" }, { name: "callout", role: "label", max_chars: 30, example: "Live approval status" }],
  duration_s: 6, axes: ["palette", "pairing", "motion", "flip", "backdrop"],
  build(c) {
    const { f } = c, w = f.wide ? Math.round(f.W * 0.56) : f.W - 2 * f.m - z(c, 0.06), h = f.wide ? Math.round(f.H * 0.46) : Math.round(f.H * (f.portrait ? 0.3 : 0.36));
    const hpx = z(c, f.wide ? 0.07 : 0.072), hh = c.th({ slot: "headline", w: w, px: hpx, role: "display", maxLines: 2, lh: 1.1 }).h, g = z(c, 0.05), cl = z(c, 0.08);
    const total = hh + g + h + g + cl, y0 = Math.max(f.m, Math.round((f.H - total) / 2)), x = Math.round((f.W - w) / 2);
    c.t({ id: "headline", slot: "headline", x, y: y0, w, px: hpx, role: "display", maxLines: 2, lh: 1.1, align: "center", at: 0.1, enter: "rise", stagger: "auto" });
    const wy = y0 + hh + g, area = appWindow(c, { x, y: wy, w, h, at: 0.4 });
    rows(c, area, 4, 0.9);
    const ringY = area.y + Math.round(Math.min(area.h / 5, z(c, 0.016) * 3.2) * 2) - z(c, 0.02), ringH = z(c, 0.056);
    c.s2({ id: "ring", shape: "rect", x: area.x - z(c, 0.012), y: ringY, w: Math.round(area.w * 0.8), h: ringH, stroke: "accent", stroke_w: 5, radius: Math.round(ringH / 2), at: 1.8, dur: 0.7, enter: "grow_x" });
    const lw = Math.round(w * 0.7);
    c.s2({ id: "callout_bg", shape: "rect", x: Math.round((f.W - lw) / 2), y: wy + h + g, w: lw, h: cl, fill: "accent", radius: Math.round(cl / 2), at: 2.5, dur: 0.5, enter: "pop" });
    c.t({ id: "callout", slot: "callout", x: Math.round((f.W - lw) / 2), y: wy + h + g + Math.round((cl - z(c, 0.04) * 1.2) / 2), w: lw, px: z(c, 0.04), role: "body", bold: true, color: "background", lh: 1.2, align: "center", at: 2.6, enter: "fade", stagger: false });
    c.camera = { timeline: { start_s: 0.8, duration_s: 4.6, tracks: [{ property: "scale", keyframes: [{ at: 0, value: 1 }, { at: 1, value: 1.12 }], easing: "ease_in_out" }] } };
  },
};

// ============================================================ feature_highlight
const featTrio: FamilyDef = {
  id: "feature-trio", category: "feature_highlight", archetype: "three_features", title: "Three features",
  description: "A headline over three features, each with an accent marker, a short title and one line of body.",
  retrieval: "Feature highlight scene listing three features under one headline, each with a marker, a title and a line of detail. Columns on wide frames, rows on tall ones.",
  mood: ["organised", "capable"], tone: ["informative", "upbeat"], energy: "medium",
  slots: [{ name: "headline", role: "headline", max_chars: 50, example: "Built for the way you work" }, { name: "f1_title", role: "item", max_chars: 22, example: "Plan first" }, { name: "f1_body", role: "caption", max_chars: 60, example: "See every scene before it is made." }, { name: "f2_title", role: "item", max_chars: 22, example: "Approve twice" }, { name: "f2_body", role: "caption", max_chars: 60, example: "Two gates keep you in control." }, { name: "f3_title", role: "item", max_chars: 22, example: "Render once" }, { name: "f3_body", role: "caption", max_chars: 60, example: "No surprises in the final film." }],
  duration_s: 6, axes: ALL,
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, f.wide ? 0.075 : 0.08), tpx = z(c, f.wide ? 0.042 : 0.048), bpx = z(c, f.wide ? 0.03 : 0.034);
    const hh = c.th({ slot: "headline", w: c.cw, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h;
    if (f.wide) {
      const g = z(c, 0.04), colW = Math.round((W - 2 * g) / 3), colH = z(c, 0.06) + z(c, 0.03) + tpx * 1.2 + bpx * 1.3 * 3, total = hh + z(c, 0.06) + colH, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
      c.t({ id: "headline", slot: "headline", x: c.ax(c.cw), y: y0, w: c.cw, px: hpx, role: "display", maxLines: 2, lh: 1.08, at: 0.1, enter: "rise", stagger: "auto" });
      [1, 2, 3].forEach((n, i) => {
        const x = c.fx(f.m + i * (colW + g), colW), y = y0 + hh + z(c, 0.06), at = 0.9 + i * 0.5;
        c.s2({ id: `m_${n}`, shape: "ellipse", x, y, w: z(c, 0.06), h: z(c, 0.06), fill: i === 1 ? "accent_2" : "accent", at, dur: 0.5, enter: "pop" });
        c.t({ id: `f${n}_title`, slot: `f${n}_title`, x, y: y + z(c, 0.09), w: colW, px: tpx, role: "display", lh: 1.15, align: "left", at: at + 0.1, enter: "rise", stagger: false, maxLines: 2 });
        c.t({ id: `f${n}_body`, slot: `f${n}_body`, x, y: y + z(c, 0.09) + Math.round(tpx * 1.2 * 1.1), w: colW, px: bpx, role: "body", color: "muted", lh: 1.3, align: "left", at: at + 0.2, enter: "fade", stagger: false, maxLines: 3 });
      });
    } else {
      const rowH = z(c, 0.2), g = z(c, 0.03), total = hh + z(c, 0.05) + 3 * rowH + 2 * g, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
      c.t({ id: "headline", slot: "headline", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 3, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
      [1, 2, 3].forEach((n, i) => {
        const y = y0 + hh + z(c, 0.05) + i * (rowH + g), at = 0.9 + i * 0.5, mk = z(c, 0.07), tx = f.m + mk + z(c, 0.035), tw = W - mk - z(c, 0.035);
        c.s2({ id: `m_${n}`, shape: "ellipse", x: f.m, y: y + Math.round(rowH / 2 - mk / 2), w: mk, h: mk, fill: i === 1 ? "accent_2" : "accent", at, dur: 0.5, enter: "pop" });
        c.t({ id: `f${n}_title`, slot: `f${n}_title`, x: tx, y, w: tw, px: tpx, role: "display", lh: 1.15, align: "left", at: at + 0.1, enter: "rise", stagger: false, maxLines: 1 });
        c.t({ id: `f${n}_body`, slot: `f${n}_body`, x: tx, y: y + Math.round(tpx * 1.3), w: tw, px: bpx, role: "body", color: "muted", lh: 1.3, align: "left", at: at + 0.2, enter: "fade", stagger: false, maxLines: 3 });
      });
    }
  },
};

const featSpot: FamilyDef = {
  id: "feature-spotlight", category: "feature_highlight", archetype: "spotlight", title: "Feature spotlight",
  description: "One feature set large beside concentric rings that pulse out, with a short benefit line.",
  retrieval: "Feature highlight scene that spotlights a single feature: the feature name large on one side, concentric rings pulsing on the other, a one-line benefit beneath. One idea, one feature.",
  mood: ["focused", "confident"], tone: ["declarative", "bright"], energy: "medium",
  slots: [{ name: "eyebrow", role: "label", max_chars: 30, example: "Feature" }, { name: "feature", role: "headline", max_chars: 40, example: "Evidence-grounded storyboards" }, { name: "benefit", role: "subline", max_chars: 100, example: "Every claim traces back to a source you gave us." }],
  duration_s: 5.5, axes: ["palette", "pairing", "motion", "flip", "backdrop", "stagger", "camera"],
  build(c) {
    const { f } = c, d = z(c, f.wide ? 0.62 : f.square ? 0.34 : 0.5);
    const tw = f.wide ? Math.round(f.W * 0.5) : f.W - 2 * f.m;
    const items = [
      { id: "eyebrow", slot: "eyebrow", px: z(c, 0.034), role: "mono" as const, upper: true, color: "accent" as const, lh: 1.2, at: 0.1, enter: "fade" as const, stagger: false as const, align: "left" as const },
      { id: "feature", slot: "feature", px: z(c, f.wide ? 0.09 : 0.085), role: "display" as const, maxLines: 4, lh: 1.06, at: 0.3, enter: "rise" as const, stagger: "auto" as const, gapBefore: z(c, 0.02), align: "left" as const },
      { id: "benefit", slot: "benefit", px: z(c, 0.04), role: "body" as const, color: "muted" as const, maxLines: 3, lh: 1.3, at: 1.5, enter: "fade" as const, stagger: false as const, gapBefore: z(c, 0.035), align: "left" as const },
    ];
    let rx: number, ry: number;
    if (f.wide) { rx = c.fx(f.W - f.m - d, d); ry = Math.round((f.H - d) / 2); c.block(items, { x: c.fx(f.m, tw), w: tw }); }
    else { rx = Math.round((f.W - d) / 2); ry = Math.round(f.H * 0.06); c.block(items, { x: f.m, w: tw, top: ry + d + z(c, 0.05) }); }
    [1, 0.72, 0.44].forEach((k, i) => c.s2({ id: `ring_${i}`, shape: "ellipse", x: rx + Math.round((d * (1 - k)) / 2), y: ry + Math.round((d * (1 - k)) / 2), w: Math.round(d * k), h: Math.round(d * k), ...(i === 2 ? { fill: "accent" as const } : { stroke: i === 0 ? "muted" as const : "accent" as const, stroke_w: i === 0 ? 2 : 4, fill: undefined }), at: 0.2 + i * 0.25, dur: 0.9, enter: "pop" }));
  },
};

const featNumbered: FamilyDef = {
  id: "feature-numbered-list", category: "feature_highlight", archetype: "numbered_list", title: "Numbered feature list",
  description: "Large monospace numerals beside three feature lines, separated by hairlines that draw in.",
  retrieval: "Feature highlight scene as a numbered list: 01, 02, 03 in large monospace numerals next to three short feature lines, with hairline dividers. Editorial, orderly.",
  mood: ["orderly", "editorial"], tone: ["crisp", "measured"], energy: "low",
  slots: [{ name: "headline", role: "headline", max_chars: 44, example: "What you get" }, { name: "item_1", role: "item", max_chars: 44, example: "A plan you can read in a minute" }, { name: "item_2", role: "item", max_chars: 44, example: "Evidence behind every claim" }, { name: "item_3", role: "item", max_chars: 44, example: "One render, no rework" }],
  duration_s: 5.5, axes: ["palette", "pairing", "motion", "flip", "backdrop", "stagger", "camera"],
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, 0.07), npx = z(c, f.wide ? 0.08 : 0.09), ipx = z(c, f.wide ? 0.042 : 0.044), rowH = Math.round(npx * 1.35);
    const nw = Math.round(npx * 1.7), x = f.m, hh = c.th({ slot: "headline", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.1 }).h;
    const total = hh + z(c, 0.05) + 3 * rowH, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
    c.t({ id: "headline", slot: "headline", x, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.1, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
    [1, 2, 3].forEach((n, i) => {
      const y = y0 + hh + z(c, 0.05) + i * rowH, at = 0.8 + i * 0.5;
      c.s2({ id: `rule_${n}`, shape: "rect", x: c.fx(x, W), y, w: W, h: 2, fill: "muted", at, dur: 0.6, enter: c.s.flip ? "grow_x_r" : "grow_x", opacity: 0.5 });
      c.t({ id: `num_${n}`, slot: `item_${n}`, bind: false, text: `0${n}`, x: c.s.flip ? x + W - nw : x, y: y + Math.round((rowH - npx) / 2), w: nw, px: npx, role: "mono", color: "accent", lh: 1, align: "left", at: at + 0.1, enter: "fade", stagger: false });
      c.t({ id: `item_${n}`, slot: `item_${n}`, x: c.s.flip ? x : x + nw + z(c, 0.03), y: y + Math.round((rowH - ipx * 1.2) / 2), w: W - nw - z(c, 0.03), px: ipx, role: "body", lh: 1.2, align: "left", at: at + 0.2, enter: c.s.flip ? "right" : "left", stagger: false, maxLines: 1 });
    });
  },
};

const featCard: FamilyDef = {
  id: "feature-card-callout", category: "feature_highlight", archetype: "card_callout", title: "Card with a callout line",
  description: "A faux product card on one side; an accent line draws out to a label and a short description on the other.",
  retrieval: "Feature highlight scene: a product card drawn from shapes, an accent leader line grows from it to a feature label and description. Annotates one capability of the product.",
  mood: ["explanatory", "tidy"], tone: ["helpful", "precise"], industry: ["software", "hardware", "saas"], energy: "low",
  slots: [{ name: "label", role: "label", max_chars: 26, example: "Smart scheduling" }, { name: "headline", role: "headline", max_chars: 50, example: "It books the slot for you" }, { name: "detail", role: "subline", max_chars: 100, example: "Conflicts are checked before anything is sent." }],
  duration_s: 5.5, axes: NOALIGN,
  build(c) {
    const { f } = c, cw = f.wide ? Math.round(f.W * 0.36) : f.W - 2 * f.m, ch = f.wide ? Math.round(f.H * 0.5) : Math.round(f.H * (f.portrait ? 0.28 : 0.3));
    const tw = f.wide ? Math.round(f.W * 0.34) : f.W - 2 * f.m;
    let cx: number, cy: number, tx: number, ty: number;
    const tpx = z(c, f.wide ? 0.065 : 0.07), th = c.th({ slot: "headline", w: tw, px: tpx, role: "display", maxLines: 3, lh: 1.1 }).h, lbl = z(c, 0.034) * 1.2, dh = c.th({ slot: "detail", w: tw, px: z(c, 0.036), role: "body", maxLines: 3, lh: 1.3 }).h, blockH = lbl + z(c, 0.015) + th + z(c, 0.025) + dh;
    if (f.wide) { cx = c.fx(f.m + z(c, 0.02), cw); cy = Math.round((f.H - ch) / 2); tx = c.fx(f.W - f.m - tw, tw); ty = Math.round((f.H - blockH) / 2); }
    else { cx = f.m; cy = Math.round(f.H * 0.08); tx = f.m; ty = cy + ch + z(c, 0.12); }
    const r = z(c, 0.022);
    c.s2({ id: "card", shape: "rect", x: cx, y: cy, w: cw, h: ch, fill: "surface", stroke: "muted", stroke_w: 2, radius: r, at: 0.2, dur: 0.7, enter: "pop" });
    c.s2({ id: "card_img", shape: "rect", x: cx + r, y: cy + r, w: cw - 2 * r, h: Math.round(ch * 0.45), fill: "accent_2", radius: Math.round(r * 0.6), at: 0.5, dur: 0.6, enter: "fade", opacity: 0.55 });
    rows(c, { x: cx + r, y: cy + r + Math.round(ch * 0.45) + r, w: cw - 2 * r, h: ch * 0.4 }, 3, 0.9, "crow");
    const hot = { x: cx + Math.round(cw * 0.7), y: cy + Math.round(ch * 0.8) };
    c.s2({ id: "hot", shape: "ellipse", x: hot.x, y: hot.y, w: z(c, 0.04), h: z(c, 0.04), fill: "accent", at: 1.4, dur: 0.4, enter: "pop" });
    if (f.wide) c.s2({ id: "leader", shape: "rect", x: c.s.flip ? tx + tw + z(c, 0.01) : hot.x + z(c, 0.04), y: hot.y + z(c, 0.019), w: Math.max(10, Math.abs(c.s.flip ? hot.x - (tx + tw) - z(c, 0.05) : tx - hot.x - z(c, 0.05))), h: 3, fill: "accent", at: 1.8, dur: 0.7, enter: c.s.flip ? "grow_x_r" : "grow_x" });
    else c.s2({ id: "leader", shape: "rect", x: hot.x + z(c, 0.019), y: hot.y + z(c, 0.04), w: 3, h: Math.max(10, ty - hot.y - z(c, 0.08)), fill: "accent", at: 1.8, dur: 0.7, enter: "grow_y" });
    c.block([
      { id: "label", slot: "label", px: z(c, 0.034), role: "mono", upper: true, color: "accent", lh: 1.2, at: 2.3, enter: "fade", stagger: false, align: "left" },
      { id: "headline", slot: "headline", px: tpx, role: "display", maxLines: 3, lh: 1.1, at: 2.45, enter: "rise", stagger: "auto", gapBefore: z(c, 0.015), align: "left" },
      { id: "detail", slot: "detail", px: z(c, 0.036), role: "body", color: "muted", maxLines: 3, lh: 1.3, at: 3.2, enter: "fade", stagger: false, gapBefore: z(c, 0.025), align: "left" },
    ], { x: tx, w: tw, top: ty });
  },
};

// ============================================================ process
const numberDisc = (c: Ctx, id: string, n: number, x: number, y: number, d: number, at: number) => {
  c.s2({ id: `${id}_disc`, shape: "ellipse", x, y, w: d, h: d, fill: "accent", at, dur: 0.5, enter: "pop" });
  c.t({ id: `${id}_n`, slot: "headline", bind: false, text: String(n), x, y: y + Math.round((d - d * 0.5 * 1.1) / 2), w: d, px: Math.round(d * 0.5), role: "display", bold: true, color: "background", lh: 1.1, align: "center", at: at + 0.05, enter: "fade", stagger: false });
};

const procSteps: FamilyDef = {
  id: "process-three-steps", category: "process", archetype: "three_steps", title: "Three numbered steps",
  description: "Three numbered discs joined by a line that draws, each with a label and a line of detail.",
  retrieval: "Process scene showing how something works in three numbered steps joined by a drawing line, each with a label and a short detail. Left to right on wide frames, top to bottom on tall ones.",
  mood: ["clear", "methodical"], tone: ["instructional", "reassuring"], energy: "medium",
  slots: [{ name: "headline", role: "headline", max_chars: 40, example: "How it works" }, { name: "s1_label", role: "item", max_chars: 20, example: "Brief" }, { name: "s1_detail", role: "caption", max_chars: 50, example: "Tell us what you need." }, { name: "s2_label", role: "item", max_chars: 20, example: "Approve" }, { name: "s2_detail", role: "caption", max_chars: 50, example: "Check the plan." }, { name: "s3_label", role: "item", max_chars: 20, example: "Render" }, { name: "s3_detail", role: "caption", max_chars: 50, example: "Get the film." }],
  duration_s: 6, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera", "stagger"],
  build(c) {
    const { f } = c, d = z(c, f.wide ? 0.11 : 0.12), W = f.W - 2 * f.m, hpx = z(c, 0.075), lpx = z(c, f.wide ? 0.045 : 0.05), dpx = z(c, f.wide ? 0.03 : 0.034);
    const hh = c.th({ slot: "headline", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h;
    if (f.wide) {
      const g = z(c, 0.03), colW = Math.round((W - 2 * g) / 3), total = hh + z(c, 0.07) + d + z(c, 0.03) + lpx * 1.2 + dpx * 1.3 * 3, y0 = Math.max(f.m, Math.round((f.H - total) / 2)), dy = y0 + hh + z(c, 0.07);
      c.t({ id: "headline", slot: "headline", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
      c.s2({ id: "line", shape: "rect", x: c.fx(f.m + d, W - d), y: dy + Math.round(d / 2) - 2, w: W - d, h: 4, fill: "muted", at: 0.9, dur: 2.4, enter: c.s.flip ? "grow_x_r" : "grow_x", ease: "ease_in_out", opacity: 0.6 });
      [1, 2, 3].forEach((n, i) => {
        const x = c.fx(f.m + i * (colW + g), colW), at = 0.9 + i * 0.9;
        numberDisc(c, `s${n}`, n, c.s.flip ? x + colW - d : x, dy, d, at);
        c.t({ id: `s${n}_label`, slot: `s${n}_label`, x, y: dy + d + z(c, 0.03), w: colW, px: lpx, role: "display", lh: 1.15, align: c.s.flip ? "right" : "left", at: at + 0.15, enter: "rise", stagger: false, maxLines: 1 });
        c.t({ id: `s${n}_detail`, slot: `s${n}_detail`, x, y: dy + d + z(c, 0.03) + Math.round(lpx * 1.25), w: colW, px: dpx, role: "body", color: "muted", lh: 1.3, align: c.s.flip ? "right" : "left", at: at + 0.3, enter: "fade", stagger: false, maxLines: 3 });
      });
    } else {
      const rowH = z(c, 0.2), total = hh + z(c, 0.05) + 3 * rowH, y0 = Math.max(f.m, Math.round((f.H - total) / 2)), top = y0 + hh + z(c, 0.05);
      c.t({ id: "headline", slot: "headline", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 3, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
      c.s2({ id: "line", shape: "rect", x: f.m + Math.round(d / 2) - 2, y: top + d, w: 4, h: 2 * rowH - d, fill: "muted", at: 0.9, dur: 2.4, enter: "grow_y", ease: "ease_in_out", opacity: 0.6 });
      [1, 2, 3].forEach((n, i) => {
        const y = top + i * rowH, at = 0.9 + i * 0.9, tx = f.m + d + z(c, 0.04), tw = W - d - z(c, 0.04);
        numberDisc(c, `s${n}`, n, f.m, y, d, at);
        c.t({ id: `s${n}_label`, slot: `s${n}_label`, x: tx, y: y + 2, w: tw, px: lpx, role: "display", lh: 1.15, align: "left", at: at + 0.15, enter: "rise", stagger: false, maxLines: 1 });
        c.t({ id: `s${n}_detail`, slot: `s${n}_detail`, x: tx, y: y + Math.round(lpx * 1.3), w: tw, px: dpx, role: "body", color: "muted", lh: 1.3, align: "left", at: at + 0.3, enter: "fade", stagger: false, maxLines: 2 });
      });
    }
  },
};

const procTimeline: FamilyDef = {
  id: "process-progress-timeline", category: "process", archetype: "timeline", title: "Progress timeline",
  description: "A progress bar fills across four milestones, each lighting up as the bar reaches it.",
  retrieval: "Process scene as a progress timeline: a bar fills along four milestones that light up one by one, each with a short label. Shows stages of a project or journey.",
  mood: ["progressive", "steady"], tone: ["reassuring", "orderly"], energy: "low",
  slots: [{ name: "headline", role: "headline", max_chars: 44, example: "From brief to film" }, { name: "m1", role: "item", max_chars: 16, example: "Brief" }, { name: "m2", role: "item", max_chars: 16, example: "Storyboard" }, { name: "m3", role: "item", max_chars: 16, example: "Edit plan" }, { name: "m4", role: "item", max_chars: 16, example: "Render" }],
  duration_s: 6.5, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera", "stagger"],
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, 0.075), lpx = z(c, f.wide ? 0.04 : 0.05), dot = z(c, 0.04), hh = c.th({ slot: "headline", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h;
    if (f.wide) {
      const total = hh + z(c, 0.1) + dot + z(c, 0.03) + lpx * 1.2, y0 = Math.max(f.m, Math.round((f.H - total) / 2)), ty = y0 + hh + z(c, 0.1);
      c.t({ id: "headline", slot: "headline", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
      c.s2({ id: "track", shape: "rect", x: f.m, y: ty + Math.round(dot / 2) - 3, w: W, h: 6, fill: "surface", radius: 3, at: 0.6, dur: 0.5, enter: "fade" });
      c.s2({ id: "fill", shape: "rect", x: c.fx(f.m, W), y: ty + Math.round(dot / 2) - 3, w: W, h: 6, fill: "accent", radius: 3, at: 1.0, dur: 3.6, enter: c.s.flip ? "grow_x_r" : "grow_x", ease: "linear" });
      [0, 1, 2, 3].forEach((i) => {
        const cx = f.m + Math.round((W - dot) * (i / 3)), x = c.fx(cx, dot), at = 1.0 + 3.6 * (i / 3);
        c.s2({ id: `dot_${i}`, shape: "ellipse", x, y: ty, w: dot, h: dot, fill: "accent", at: Math.max(0.6, at - 0.1), dur: 0.4, enter: "pop" });
        const lw = z(c, 0.22), lx = Math.min(f.W - f.m - lw, Math.max(f.m, x + Math.round(dot / 2 - lw / 2)));
        c.t({ id: `m${i + 1}`, slot: `m${i + 1}`, x: lx, y: ty + dot + z(c, 0.03), w: lw, px: lpx, role: "body", bold: true, lh: 1.2, align: "center", at: at + 0.1, enter: "rise", stagger: false, maxLines: 1 });
      });
    } else {
      const g = z(c, 0.12), total = hh + z(c, 0.05) + 3 * g + dot, y0 = Math.max(f.m, Math.round((f.H - total) / 2)), top = y0 + hh + z(c, 0.05);
      c.t({ id: "headline", slot: "headline", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 3, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
      c.s2({ id: "track", shape: "rect", x: f.m + Math.round(dot / 2) - 3, y: top, w: 6, h: 3 * g + dot, fill: "surface", radius: 3, at: 0.6, dur: 0.5, enter: "fade" });
      c.s2({ id: "fill", shape: "rect", x: f.m + Math.round(dot / 2) - 3, y: top, w: 6, h: 3 * g + dot, fill: "accent", radius: 3, at: 1.0, dur: 3.6, enter: "grow_y", ease: "linear" });
      [0, 1, 2, 3].forEach((i) => {
        const y = top + i * g, at = 1.0 + 3.6 * (i / 3);
        c.s2({ id: `dot_${i}`, shape: "ellipse", x: f.m, y, w: dot, h: dot, fill: "accent", at: Math.max(0.6, at - 0.1), dur: 0.4, enter: "pop" });
        c.t({ id: `m${i + 1}`, slot: `m${i + 1}`, x: f.m + dot + z(c, 0.04), y: y + Math.round((dot - lpx * 1.2) / 2), w: W - dot - z(c, 0.04), px: lpx, role: "body", bold: true, lh: 1.2, align: "left", at: at + 0.1, enter: "right", stagger: false, maxLines: 1 });
      });
    }
  },
};

const procChecklist: FamilyDef = {
  id: "process-checklist", category: "process", archetype: "checklist", title: "Checklist that completes",
  description: "Four checklist rows whose boxes fill one by one while a progress bar grows beneath.",
  retrieval: "Process scene as a checklist: four items whose check boxes fill in turn, a progress bar grows underneath. Shows requirements being met or tasks completed.",
  mood: ["satisfying", "tidy"], tone: ["reassuring", "plain"], energy: "medium",
  slots: [{ name: "headline", role: "headline", max_chars: 40, example: "Ready to render" }, { name: "c1", role: "item", max_chars: 36, example: "Storyboard approved" }, { name: "c2", role: "item", max_chars: 36, example: "Edit plan validated" }, { name: "c3", role: "item", max_chars: 36, example: "Assets checked" }, { name: "c4", role: "item", max_chars: 36, example: "Audio cleared" }],
  duration_s: 6, axes: ["palette", "pairing", "motion", "align", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, W = c.cw, x = c.ax(W), hpx = z(c, 0.08), ipx = z(c, f.wide ? 0.05 : 0.054), box = Math.round(ipx * 1.05), rowH = Math.round(ipx * 1.9);
    const hh = c.th({ slot: "headline", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h, total = hh + z(c, 0.05) + 4 * rowH + z(c, 0.03) + 10, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
    c.t({ id: "headline", slot: "headline", x, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, at: 0.1, enter: "rise", stagger: "auto" });
    [1, 2, 3, 4].forEach((n, i) => {
      const y = y0 + hh + z(c, 0.05) + i * rowH, at = 0.9 + i * 0.7, bx = c.s.flip ? x + W - box : x;
      c.s2({ id: `box_${n}`, shape: "rect", x: bx, y: y + Math.round((rowH - box) / 2) - 4, w: box, h: box, stroke: "muted", stroke_w: 3, radius: Math.round(box * 0.2), at: 0.5, dur: 0.4, enter: "fade" });
      c.s2({ id: `tick_${n}`, shape: "rect", x: bx + 6, y: y + Math.round((rowH - box) / 2) + 2, w: box - 12, h: box - 12, fill: "accent", radius: Math.round(box * 0.12), at, dur: 0.4, enter: "pop" });
      c.t({ id: `c${n}`, slot: `c${n}`, x: c.s.flip ? x : x + box + z(c, 0.035), y: y + Math.round((rowH - ipx * 1.2) / 2) - 4, w: W - box - z(c, 0.035), px: ipx, role: "body", lh: 1.2, align: c.s.flip ? "right" : "left", at: at + 0.1, enter: c.s.flip ? "right" : "left", stagger: false, maxLines: 1 });
    });
    const py = y0 + hh + z(c, 0.05) + 4 * rowH + z(c, 0.02);
    c.s2({ id: "progress_track", shape: "rect", x, y: py, w: W, h: 10, fill: "surface", radius: 5, at: 0.5, dur: 0.4, enter: "fade" });
    c.s2({ id: "progress", shape: "rect", x: c.fx(x, W), y: py, w: W, h: 10, fill: "accent_2", radius: 5, at: 0.9, dur: 2.8, enter: c.s.flip ? "grow_x_r" : "grow_x", ease: "linear" });
  },
};

const procStairs: FamilyDef = {
  id: "process-staircase", category: "process", archetype: "staircase", title: "Rising staircase",
  description: "Four blocks rise like steps from the baseline, each labelled, with the last in the accent colour.",
  retrieval: "Process scene as a staircase of four rising blocks, each labelled with a stage, the last one highlighted. Shows growth or maturity in stages.",
  mood: ["ambitious", "building"], tone: ["motivating", "clean"], energy: "medium",
  slots: [{ name: "headline", role: "headline", max_chars: 44, example: "Four steps to launch" }, { name: "s1", role: "item", max_chars: 14, example: "Plan" }, { name: "s2", role: "item", max_chars: 14, example: "Build" }, { name: "s3", role: "item", max_chars: 14, example: "Review" }, { name: "s4", role: "item", max_chars: 14, example: "Launch" }],
  duration_s: 6, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera", "stagger"],
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, 0.075), g = z(c, 0.02), bw = Math.round((W - 3 * g) / 4), lpx = z(c, f.wide ? 0.04 : 0.042);
    const hh = c.th({ slot: "headline", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h, baseY = f.H - f.m - z(c, 0.02), maxH = Math.round(Math.min(f.H * 0.46, baseY - (f.m + hh + z(c, 0.06))));
    c.t({ id: "headline", slot: "headline", x: f.m, y: f.m, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
    [1, 2, 3, 4].forEach((n, i) => {
      const hgt = Math.round(maxH * (0.34 + i * 0.22)), idx = c.s.flip ? 3 - i : i, x = f.m + idx * (bw + g), y = baseY - hgt, at = 0.8 + i * 0.55;
      c.s2({ id: `step_${n}`, shape: "rect", x, y, w: bw, h: hgt, fill: i === 3 ? "accent" : "surface", stroke: i === 3 ? undefined : "muted", stroke_w: i === 3 ? 0 : 2, radius: z(c, 0.012), at, dur: 0.8, enter: "grow_y_up" });
      c.t({ id: `s${n}`, slot: `s${n}`, x, y: y + z(c, 0.025), w: bw, px: lpx, role: "body", bold: true, color: i === 3 ? "background" : "text", lh: 1.2, align: "center", at: at + 0.5, enter: "fade", stagger: false, maxLines: 1 });
    });
  },
};

// ============================================================ data_proof
const dataHero: FamilyDef = {
  id: "data-hero-stat", category: "data_proof", archetype: "hero_stat", title: "Hero statistic",
  description: "A small label, one large counted-up statistic with a unit, a descriptor line and a source note.",
  retrieval: "Data proof scene with one hero statistic: a label, a very large number that counts up with its unit, a line explaining what it measures and a source note. The single number that backs the claim.",
  mood: ["credible", "clear"], tone: ["factual", "authoritative"], energy: "medium",
  slots: [{ name: "label", role: "label", max_chars: 32, example: "Average time saved" }, { name: "figure", role: "number", max_chars: 5, example: "62" }, { name: "descriptor", role: "subline", max_chars: 90, example: "per film, from brief to approved plan" }, { name: "source", role: "caption", max_chars: 60, example: "Internal benchmark, 2025", required: false }],
  duration_s: 5, axes: ALL,
  build(c) {
    c.block([
      { id: "label", slot: "label", px: z(c, 0.036), role: "mono", upper: true, color: "muted", lh: 1.2, at: 0.1, enter: "fade", stagger: false },
      { id: "figure", slot: "figure", px: z(c, c.f.wide ? 0.34 : 0.3), role: "display", color: "accent", lh: 1, counter: { to: 62, suffix: "%" }, at: 0.3, dur: 1.6, stagger: false, gapBefore: z(c, 0.01) },
      { h: z(c, 0.012), gapBefore: z(c, 0.015), make: (y, x, w) => c.s2({ id: "bar", shape: "rect", x: ox(c, x, w, z(c, 0.2)), y, w: z(c, 0.2), h: 6, fill: "text", at: 1.2, dur: 0.7, enter: grow(c) }) },
      { id: "descriptor", slot: "descriptor", px: z(c, 0.048), role: "body", maxLines: 2, lh: 1.25, at: 1.7, enter: "rise", stagger: false, gapBefore: z(c, 0.03) },
      { id: "source", slot: "source", px: z(c, 0.03), role: "mono", color: "muted", lh: 1.2, at: 2.2, enter: "fade", stagger: false, gapBefore: z(c, 0.03) },
    ]);
  },
};

const dataTrio: FamilyDef = {
  id: "data-stat-trio", category: "data_proof", archetype: "stat_trio", title: "Three statistics",
  description: "Three statistics side by side (or stacked) that count up together, each with a short label.",
  retrieval: "Data proof scene with three statistics, each a counted-up number with a label, in a row on wide frames and a stack on tall ones. A dashboard of proof points.",
  mood: ["impressive", "dense"], tone: ["factual", "proud"], energy: "high",
  slots: [{ name: "headline", role: "headline", max_chars: 44, example: "The numbers so far" }, { name: "v1", role: "number", max_chars: 5, example: "120" }, { name: "l1", role: "label", max_chars: 28, example: "films planned" }, { name: "v2", role: "number", max_chars: 5, example: "98" }, { name: "l2", role: "label", max_chars: 28, example: "percent approved first time" }, { name: "v3", role: "number", max_chars: 5, example: "4" }, { name: "l3", role: "label", max_chars: 28, example: "minutes to a plan" }],
  duration_s: 6, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, 0.07), hh = c.th({ slot: "headline", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h, vals = [120, 98, 4], sfx = ["", "%", " min"];
    if (f.wide) {
      const g = z(c, 0.04), colW = Math.round((W - 2 * g) / 3), npx = z(c, 0.14), lpx = z(c, 0.034), total = hh + z(c, 0.06) + npx + lpx * 1.3 * 2, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
      c.t({ id: "headline", slot: "headline", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
      [1, 2, 3].forEach((n, i) => {
        const x = c.fx(f.m + i * (colW + g), colW), y = y0 + hh + z(c, 0.06), at = 0.6 + i * 0.25;
        c.t({ id: `v${n}`, slot: `v${n}`, x, y, w: colW, px: npx, role: "display", color: i === 1 ? "accent_2" : "accent", lh: 1, align: "left", counter: { to: vals[i]!, suffix: sfx[i] }, at, dur: 1.6, stagger: false });
        c.t({ id: `l${n}`, slot: `l${n}`, x, y: y + npx * 1.1, w: colW, px: lpx, role: "body", color: "muted", lh: 1.3, align: "left", at: at + 1.0, enter: "fade", stagger: false, maxLines: 2 });
      });
    } else {
      const rowH = z(c, f.portrait ? 0.24 : 0.2), npx = z(c, f.portrait ? 0.15 : 0.12), lpx = z(c, 0.036), total = hh + z(c, 0.05) + 3 * rowH, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
      c.t({ id: "headline", slot: "headline", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 3, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
      [1, 2, 3].forEach((n, i) => {
        const y = y0 + hh + z(c, 0.05) + i * rowH, at = 0.6 + i * 0.25;
        c.t({ id: `v${n}`, slot: `v${n}`, x: f.m, y, w: W, px: npx, role: "display", color: i === 1 ? "accent_2" : "accent", lh: 1, align: "left", counter: { to: vals[i]!, suffix: sfx[i] }, at, dur: 1.6, stagger: false });
        c.t({ id: `l${n}`, slot: `l${n}`, x: f.m, y: y + npx * 1.05, w: W, px: lpx, role: "body", color: "muted", lh: 1.3, align: "left", at: at + 1.0, enter: "fade", stagger: false, maxLines: 1 });
      });
    }
  },
};

const dataBars: FamilyDef = {
  id: "data-bar-proof", category: "data_proof", archetype: "bar_proof", title: "Bar chart with a claim",
  description: "A headline claim above a growing bar chart with a caption naming what the bars measure.",
  retrieval: "Data proof scene pairing a headline claim with a growing bar chart and a caption of what the bars measure. Shows a trend that supports the claim.",
  mood: ["analytical", "optimistic"], tone: ["evidence-led", "calm"], energy: "medium",
  slots: [{ name: "headline", role: "headline", max_chars: 50, example: "Approvals are getting faster" }, { name: "caption", role: "caption", max_chars: 70, example: "Median hours from brief to approval, by quarter" }],
  duration_s: 6, axes: ["palette", "pairing", "motion", "align", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, 0.075), hh = c.th({ slot: "headline", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h, cpx = z(c, 0.034), ch = Math.round(f.H * (f.wide ? 0.4 : f.portrait ? 0.34 : 0.34));
    const total = hh + z(c, 0.05) + ch + z(c, 0.03) + cpx * 1.3, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
    c.t({ id: "headline", slot: "headline", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, at: 0.1, enter: "rise", stagger: "auto", align: c.s.align });
    const cy = y0 + hh + z(c, 0.05);
    c.raw({ id: "bars", kind: "chart", parent: null, props: { chart: "bar", values: c.s.flip ? [9, 7, 6, 4, 3] : [3, 4, 6, 7, 9], x: f.m, y: cy, w: W, h: ch, color: "accent" }, timeline: { start_s: 0.8, duration_s: 2.2, tracks: [{ property: "progress", keyframes: [{ at: 0, value: 0 }, { at: 1, value: 1 }], easing: c.ez }, { property: "opacity", keyframes: [{ at: 0, value: 0 }, { at: 0.1, value: 1 }, { at: 1, value: 1 }], easing: "linear" }] }, bindings: {} });
    c.s2({ id: "axis", shape: "rect", x: f.m, y: cy + ch + 2, w: W, h: 3, fill: "muted", at: 0.6, dur: 0.6, enter: "grow_x", opacity: 0.7 });
    c.t({ id: "caption", slot: "caption", x: f.m, y: cy + ch + z(c, 0.03), w: W, px: cpx, role: "body", color: "muted", lh: 1.3, at: 3.0, enter: "fade", stagger: false, maxLines: 2, align: c.s.align });
  },
};

const dataDelta: FamilyDef = {
  id: "data-before-after-delta", category: "data_proof", archetype: "delta", title: "Before and after with a delta",
  description: "Two bars, a long muted 'before' and a short accent 'after', with the change counted up beside them.",
  retrieval: "Data proof scene comparing a before and an after as two horizontal bars with the percentage change counting up. Shows an improvement as a delta.",
  mood: ["triumphant", "clear"], tone: ["factual", "proud"], energy: "high",
  slots: [{ name: "headline", role: "headline", max_chars: 44, example: "Rework, cut by more than half" }, { name: "before", role: "label", max_chars: 20, example: "Before" }, { name: "after", role: "label", max_chars: 20, example: "After" }, { name: "delta", role: "number", max_chars: 5, example: "58" }],
  duration_s: 6, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, 0.075), hh = c.th({ slot: "headline", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h, lpx = z(c, 0.04), bh = z(c, 0.07), lw = z(c, 0.2), npx = z(c, f.wide ? 0.18 : 0.16);
    const total = hh + z(c, 0.06) + 2 * (bh + z(c, 0.035)) + z(c, 0.04) + npx, y0 = Math.max(f.m, Math.round((f.H - total) / 2)), by = y0 + hh + z(c, 0.06), bw = W - lw - z(c, 0.03);
    c.t({ id: "headline", slot: "headline", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
    [["before", 1, "muted", 0.8], ["after", 0.42, "accent", 1.5]].forEach(([id, share, col, at], i) => {
      const y = by + i * (bh + z(c, 0.035)), w = Math.round(bw * (share as number));
      c.t({ id: String(id), slot: String(id), x: f.m, y: y + Math.round((bh - lpx * 1.2) / 2), w: lw, px: lpx, role: "body", bold: true, lh: 1.2, align: "left", at: (at as number) - 0.2, enter: "fade", stagger: false, maxLines: 1 });
      c.s2({ id: `${id}_bar`, shape: "rect", x: f.m + lw + z(c, 0.03), y, w, h: bh, fill: col as "muted" | "accent", radius: Math.round(bh * 0.2), at: at as number, dur: 1.2, enter: "grow_x", opacity: i === 0 ? 0.55 : undefined });
    });
    c.t({ id: "delta", slot: "delta", x: f.m + lw + z(c, 0.03), y: by + 2 * (bh + z(c, 0.035)) + z(c, 0.01), w: bw, px: npx, role: "display", color: "accent_2", lh: 1, align: "left", counter: { to: 58, prefix: "-", suffix: "%" }, at: 2.4, dur: 1.5, stagger: false });
  },
};

export const SCENE_2_FAMILIES: FamilyDef[] = [uiClick, uiNotify, uiZoom, featTrio, featSpot, featNumbered, featCard, procSteps, procTimeline, procChecklist, procStairs, dataHero, dataTrio, dataBars, dataDelta];
