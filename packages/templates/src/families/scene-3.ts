import type { Ctx, FamilyDef } from "../kit.js";
import { gap, grow, ox, z } from "./common.js";

const ALL = ["palette", "pairing", "motion", "align", "flip", "backdrop", "stagger", "camera"] as const;
const NOALIGN = ["palette", "pairing", "motion", "flip", "backdrop", "camera"] as const;
void gap;

// ============================================================ comparison
const cmpTwoCol: FamilyDef = {
  id: "comparison-two-columns", category: "comparison", archetype: "two_columns", title: "Two columns, two verdicts",
  description: "Two columns divided by a growing line: a muted 'before' with two points and an accent 'after' with two points.",
  retrieval: "Comparison scene with two columns split by a drawn divider: the old approach in muted type with two weaknesses, the new approach in accent with two strengths. Side-by-side before and after.",
  mood: ["decisive", "balanced"], tone: ["clear", "persuasive"], energy: "medium",
  slots: [{ name: "a_title", role: "headline", max_chars: 20, example: "Before" }, { name: "a_1", role: "item", max_chars: 36, example: "Weeks of edits" }, { name: "a_2", role: "item", max_chars: 36, example: "Feedback in ten places" }, { name: "b_title", role: "headline", max_chars: 20, example: "After" }, { name: "b_1", role: "item", max_chars: 36, example: "One approved plan" }, { name: "b_2", role: "item", max_chars: 36, example: "One place for notes" }],
  duration_s: 6, axes: NOALIGN,
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, tpx = z(c, f.wide ? 0.08 : 0.09), ipx = z(c, f.wide ? 0.04 : 0.048);
    const colBlock = (side: "a" | "b", x: number, y: number, w: number, at: number) => {
      const col = side === "a" ? "muted" : "accent";
      c.t({ id: `${side}_title`, slot: `${side}_title`, x, y, w, px: tpx, role: "display", color: col, lh: 1.05, align: "left", at, enter: "rise", stagger: false, maxLines: 1 });
      [1, 2].forEach((n, i) => c.t({ id: `${side}_${n}`, slot: `${side}_${n}`, x, y: y + tpx * 1.35 + i * Math.round(ipx * 2.4), w, px: ipx, role: "body", color: side === "a" ? "muted" : "text", lh: 1.25, align: "left", at: at + 0.3 + i * 0.25, enter: "fade", stagger: false, maxLines: 2 }));
    };
    if (f.wide) {
      const g = z(c, 0.08), cw = Math.round((W - g) / 2), h = Math.round(tpx * 1.35 + ipx * 2.4 * 2), y0 = Math.round((f.H - h) / 2), ax = c.fx(f.m, cw), bx = c.fx(f.m + cw + g, cw);
      colBlock("a", ax, y0, cw, 0.2); colBlock("b", bx, y0, cw, 1.6);
      c.s2({ id: "divider", shape: "rect", x: Math.round(f.W / 2 - 2), y: y0 - z(c, 0.03), w: 4, h: h + z(c, 0.06), fill: "muted", at: 0.8, dur: 0.8, enter: "grow_y", opacity: 0.6 });
    } else {
      const bh = Math.round(tpx * 1.35 + ipx * 2.4 * 2), g = z(c, 0.07), total = 2 * bh + g, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
      const top = c.s.flip ? y0 + bh + g : y0, bot = c.s.flip ? y0 : y0 + bh + g;
      colBlock("a", f.m, top, W, 0.2); colBlock("b", f.m, bot, W, 1.6);
      c.s2({ id: "divider", shape: "rect", x: f.m, y: y0 + bh + Math.round(g / 2) - 2, w: W, h: 4, fill: "muted", at: 0.8, dur: 0.8, enter: "grow_x", opacity: 0.6 });
    }
  },
};

const cmpVersus: FamilyDef = {
  id: "comparison-versus", category: "comparison", archetype: "versus", title: "A versus B",
  description: "Two contenders either side of a large monospace 'vs', with a one-line verdict beneath.",
  retrieval: "Comparison scene staging two options head to head with a big 'vs' between them and a one-line verdict. Playful, decisive matchup.",
  mood: ["competitive", "playful"], tone: ["bold", "tongue-in-cheek"], energy: "high",
  slots: [{ name: "a", role: "headline", max_chars: 18, example: "Guesswork" }, { name: "vs", role: "label", max_chars: 4, example: "vs" }, { name: "b", role: "headline", max_chars: 18, example: "Evidence" }, { name: "verdict", role: "subline", max_chars: 80, example: "One of these ships on time." }],
  duration_s: 5, axes: NOALIGN,
  build(c) {
    const { f } = c, px = z(c, f.wide ? 0.12 : 0.13), vpx = z(c, 0.07), W = f.W - 2 * f.m;
    if (f.wide) {
      const sw = Math.round(f.W * 0.34), y = Math.round(f.H * 0.4 - px / 2), vw = Math.round(f.W * 0.14);
      c.t({ id: "a", slot: "a", x: c.fx(f.m, sw), y, w: sw, px, role: "display", color: "muted", lh: 1.05, align: c.s.flip ? "left" : "right", at: 0.1, enter: c.s.flip ? "right" : "left", stagger: false, maxLines: 1 });
      c.t({ id: "vs", slot: "vs", x: Math.round((f.W - vw) / 2), y: y + Math.round((px - vpx) / 2), w: vw, px: vpx, role: "mono", color: "accent", lh: 1.05, align: "center", at: 0.9, enter: "pop", stagger: false });
      c.t({ id: "b", slot: "b", x: c.fx(f.W - f.m - sw, sw), y, w: sw, px, role: "display", color: "accent", lh: 1.05, align: c.s.flip ? "right" : "left", at: 1.4, enter: c.s.flip ? "left" : "right", stagger: false, maxLines: 1 });
      c.t({ id: "verdict", slot: "verdict", x: f.m, y: Math.round(f.H * 0.62), w: W, px: z(c, 0.045), role: "body", color: "muted", lh: 1.3, align: "center", at: 2.3, enter: "fade", stagger: false, maxLines: 2 });
    } else {
      const th = px * 1.05, total = th + z(c, 0.04) + vpx * 1.05 + z(c, 0.04) + th + z(c, 0.07) + z(c, 0.045) * 1.3, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
      const top = c.s.flip ? "b" : "a", bot = c.s.flip ? "a" : "b";
      c.t({ id: top, slot: top, x: f.m, y: y0, w: W, px, role: "display", color: top === "a" ? "muted" : "accent", lh: 1.05, align: "center", at: 0.1, enter: "rise", stagger: false, maxLines: 1 });
      c.t({ id: "vs", slot: "vs", x: f.m, y: y0 + th + z(c, 0.04), w: W, px: vpx, role: "mono", color: "accent", lh: 1.05, align: "center", at: 0.9, enter: "pop", stagger: false });
      c.t({ id: bot, slot: bot, x: f.m, y: y0 + th + z(c, 0.08) + vpx * 1.05, w: W, px, role: "display", color: bot === "a" ? "muted" : "accent", lh: 1.05, align: "center", at: 1.4, enter: "rise", stagger: false, maxLines: 1 });
      c.t({ id: "verdict", slot: "verdict", x: f.m, y: y0 + 2 * th + z(c, 0.15) + vpx * 1.05, w: W, px: z(c, 0.045), role: "body", color: "muted", lh: 1.3, align: "center", at: 2.3, enter: "fade", stagger: false, maxLines: 2 });
    }
  },
};

const cmpRows: FamilyDef = {
  id: "comparison-feature-rows", category: "comparison", archetype: "feature_table", title: "Feature rows with yes and no",
  description: "A small comparison table: three criteria rows, two columns, with the winning column marked in the accent colour.",
  retrieval: "Comparison scene as a compact feature table with three criteria and two columns of yes and no answers, the winning column in the accent colour. Fast feature-by-feature comparison.",
  mood: ["tidy", "analytical"], tone: ["objective", "crisp"], energy: "low",
  slots: [{ name: "headline", role: "headline", max_chars: 40, example: "Why teams switch" }, { name: "col_a", role: "label", max_chars: 12, example: "Others" }, { name: "col_b", role: "label", max_chars: 12, example: "Us" }, { name: "r1", role: "item", max_chars: 28, example: "Plan before render" }, { name: "r2", role: "item", max_chars: 28, example: "Evidence per claim" }, { name: "r3", role: "item", max_chars: 28, example: "Two approvals" }],
  duration_s: 6, axes: NOALIGN,
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, 0.075), ipx = z(c, f.wide ? 0.04 : 0.046), rowH = Math.round(ipx * 2.1), cellW = z(c, f.wide ? 0.16 : 0.2), lw = W - 2 * cellW;
    const hh = c.th({ slot: "headline", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h, total = hh + z(c, 0.05) + rowH * 4, y0 = Math.max(f.m, Math.round((f.H - total) / 2)), top = y0 + hh + z(c, 0.05);
    c.t({ id: "headline", slot: "headline", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, align: "left", at: 0.1, enter: "rise", stagger: "auto" });
    const xa = f.m + lw, xb = f.m + lw + cellW;
    c.s2({ id: "win_col", shape: "rect", x: xb, y: top - z(c, 0.01), w: cellW, h: rowH * 4 + z(c, 0.02), fill: "surface", radius: z(c, 0.012), at: 0.6, dur: 0.6, enter: "fade" });
    c.t({ id: "col_a", slot: "col_a", x: xa, y: top + Math.round((rowH - ipx * 1.2) / 2), w: cellW, px: ipx, role: "mono", color: "muted", lh: 1.2, align: "center", at: 0.7, enter: "fade", stagger: false, maxLines: 1 });
    c.t({ id: "col_b", slot: "col_b", x: xb, y: top + Math.round((rowH - ipx * 1.2) / 2), w: cellW, px: ipx, role: "mono", color: "accent", lh: 1.2, align: "center", at: 0.7, enter: "fade", stagger: false, maxLines: 1 });
    [1, 2, 3].forEach((n, i) => {
      const y = top + (i + 1) * rowH, at = 1.2 + i * 0.55, ty = y + Math.round((rowH - ipx * 1.2) / 2);
      c.s2({ id: `rule_${n}`, shape: "rect", x: f.m, y, w: W, h: 2, fill: "muted", at, dur: 0.5, enter: "grow_x", opacity: 0.4 });
      c.t({ id: `r${n}`, slot: `r${n}`, x: f.m, y: ty, w: lw - z(c, 0.02), px: ipx, role: "body", lh: 1.2, align: "left", at: at + 0.1, enter: "left", stagger: false, maxLines: 1 });
      c.t({ id: `a_${n}`, slot: `r${n}`, bind: false, text: i === 2 ? "Some" : "No", x: xa, y: ty, w: cellW, px: ipx, role: "body", color: "muted", lh: 1.2, align: "center", at: at + 0.2, enter: "fade", stagger: false });
      c.t({ id: `b_${n}`, slot: `r${n}`, bind: false, text: "Yes", x: xb, y: ty, w: cellW, px: ipx, role: "body", bold: true, color: "accent", lh: 1.2, align: "center", at: at + 0.3, enter: "pop", stagger: false });
    });
  },
};

const cmpWipe: FamilyDef = {
  id: "comparison-wipe-swap", category: "comparison", archetype: "wipe_swap", title: "Wipe from old to new",
  description: "The old statement is shown, then a wipe reveals the new statement over it in the accent colour.",
  retrieval: "Comparison scene that swaps one statement for another with a wipe: the old way is shown first, then a panel wipes across and the new way takes its place. Replacement, upgrade, change.",
  mood: ["transformative", "crisp"], tone: ["confident", "clean"], energy: "medium",
  slots: [{ name: "old_label", role: "label", max_chars: 20, example: "Then" }, { name: "old_text", role: "headline", max_chars: 40, example: "Hours of manual edits" }, { name: "new_label", role: "label", max_chars: 20, example: "Now" }, { name: "new_text", role: "headline", max_chars: 40, example: "A plan that checks itself" }],
  duration_s: 6, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, px = z(c, f.wide ? 0.085 : 0.085), lpx = z(c, 0.034), g = z(c, 0.05), pad = z(c, 0.035), lg = z(c, 0.02);
    const h1 = c.th({ slot: "old_text", w: W, px, role: "display", maxLines: 2, lh: 1.08 }).h, h2 = c.th({ slot: "new_text", w: W, px, role: "display", maxLines: 2, lh: 1.08 }).h;
    const oldH = lpx * 1.2 + lg + h1, panelH = Math.round(pad * 2 + lpx * 1.2 + lg + h2), total = oldH + g + panelH, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
    c.t({ id: "old_label", slot: "old_label", x: f.m, y: y0, w: W, px: lpx, role: "mono", upper: true, color: "muted", lh: 1.2, align: "left", at: 0.1, enter: "fade", stagger: false });
    c.t({ id: "old_text", slot: "old_text", x: f.m, y: y0 + lpx * 1.2 + lg, w: W, px, role: "display", color: "muted", maxLines: 2, lh: 1.08, align: "left", at: 0.2, enter: "rise", stagger: false });
    const py = Math.round(y0 + oldH + g);
    c.raw({ id: "swap", kind: "mask", parent: null, props: { reveal: c.s.flip ? "right" : "left", x: 0, y: py, w: f.W, h: panelH }, timeline: { start_s: 2.2, duration_s: 1.0, tracks: [{ property: "progress", keyframes: [{ at: 0, value: 0 }, { at: 1, value: 1 }], easing: c.ez }] }, bindings: {} });
    c.s2({ id: "swap_bg", parent: "swap", shape: "rect", x: 0, y: 0, w: f.W, h: panelH, fill: "surface", at: 2.2, tracks: [] });
    c.t({ id: "new_label", slot: "new_label", parent: "swap", x: f.m, y: pad, w: W, px: lpx, role: "mono", upper: true, color: "accent", lh: 1.2, align: "left", at: 2.2, enter: "none", stagger: false });
    c.t({ id: "new_text", slot: "new_text", parent: "swap", x: f.m, y: pad + lpx * 1.2 + lg, w: W, px, role: "display", color: "text", maxLines: 2, lh: 1.08, align: "left", at: 2.2, enter: "none", stagger: false });
  },
};
// ============================================================ social_proof
const socQuote: FamilyDef = {
  id: "social-quote-card", category: "social_proof", archetype: "quote", title: "Customer quote",
  description: "A large opening quotation mark, the quote set in display type, and an attribution with name and role.",
  retrieval: "Social proof scene with a customer quote: a big opening quotation mark, the quote line by line, then the name and role of the person who said it. Testimonial.",
  mood: ["warm", "trustworthy"], tone: ["personal", "sincere"], energy: "low",
  slots: [{ name: "quote", role: "headline", max_chars: 120, example: "We went from a week of edits to an afternoon of approvals." }, { name: "name", role: "name", max_chars: 28, example: "Dana Whitfield" }, { name: "role", role: "caption", max_chars: 40, example: "Head of Marketing, Northwind" }],
  duration_s: 6, axes: ALL,
  build(c) {
    c.block([
      { id: "mark", slot: "quote", bind: false, text: "“", px: z(c, 0.26), role: "display", color: "accent", lh: 0.7, at: 0.1, enter: "pop", stagger: false },
      { id: "quote", slot: "quote", px: z(c, c.f.wide ? 0.07 : 0.072), role: "display", bold: false, maxLines: 5, lh: 1.2, at: 0.5, enter: "rise", stagger: "line", gapBefore: z(c, 0.01) },
      { h: z(c, 0.004), gapBefore: z(c, 0.04), make: (y, x, w) => c.s2({ id: "rule", shape: "rect", x: ox(c, x, w, z(c, 0.1)), y, w: z(c, 0.1), h: 4, fill: "accent", at: 2.4, dur: 0.5, enter: grow(c) }) },
      { id: "name", slot: "name", px: z(c, 0.045), role: "body", bold: true, lh: 1.2, at: 2.7, enter: "fade", stagger: false, gapBefore: z(c, 0.03) },
      { id: "role", slot: "role", px: z(c, 0.034), role: "body", color: "muted", lh: 1.25, at: 2.9, enter: "fade", stagger: false, gapBefore: z(c, 0.008) },
    ]);
  },
};

const socRating: FamilyDef = {
  id: "social-rating-dots", category: "social_proof", archetype: "rating", title: "Rating with five dots",
  description: "A large rating that counts up, five dots filling in beneath it and a line on how many reviews it comes from.",
  retrieval: "Social proof scene showing a rating: a big score counting up to 4.9, five dots that fill one by one and a line saying how many reviews it is based on. Review score.",
  mood: ["positive", "reassuring"], tone: ["proud", "simple"], energy: "medium",
  slots: [{ name: "score", role: "number", max_chars: 4, example: "4.9" }, { name: "label", role: "subline", max_chars: 60, example: "average rating" }, { name: "reviews", role: "caption", max_chars: 60, example: "from 2,400 reviews" }],
  duration_s: 5, axes: ALL,
  build(c) {
    const d = z(c, 0.07), g = z(c, 0.02), rowW = 5 * d + 4 * g;
    c.block([
      { id: "score", slot: "score", px: z(c, c.f.wide ? 0.3 : 0.28), role: "display", color: "accent", lh: 1, counter: { to: 4.9, decimals: 1 }, at: 0.2, dur: 1.4, stagger: false },
      { h: d, gapBefore: z(c, 0.02), make: (y, x, w) => { const x0 = ox(c, x, w, rowW); for (let i = 0; i < 5; i++) c.s2({ id: `dot_${i}`, shape: "ellipse", x: x0 + i * (d + g), y, w: d, h: d, fill: "accent", at: 1.0 + i * 0.22, dur: 0.4, enter: "pop" }); } },
      { id: "label", slot: "label", px: z(c, 0.05), role: "body", lh: 1.2, at: 2.2, enter: "rise", stagger: false, gapBefore: z(c, 0.035), maxLines: 2 },
      { id: "reviews", slot: "reviews", px: z(c, 0.034), role: "mono", color: "muted", lh: 1.2, at: 2.5, enter: "fade", stagger: false, gapBefore: z(c, 0.015) },
    ]);
  },
};

const socLogos: FamilyDef = {
  id: "social-trusted-by", category: "social_proof", archetype: "logo_wall", title: "Trusted-by name wall",
  description: "A short line, then six customer names as chips in a grid that pop in one after another.",
  retrieval: "Social proof scene listing who relies on it: a trusted-by line and six customer names as chips in a grid. Placeholder names stand in for logos.",
  mood: ["established", "credible"], tone: ["understated", "assured"], energy: "low",
  slots: [{ name: "headline", role: "headline", max_chars: 44, example: "Trusted by teams at" }, ...[1, 2, 3, 4, 5, 6].map((n) => ({ name: `n${n}`, role: "item" as const, max_chars: 16, example: ["Northwind", "Contoso", "Fabrikam", "Adventure", "Litware", "Tailspin"][n - 1]! }))],
  duration_s: 6, axes: ["palette", "pairing", "motion", "align", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, hpx = z(c, 0.07), cols = f.wide ? 3 : 2, rows = 6 / cols, g = z(c, 0.025), cw = Math.round((W - (cols - 1) * g) / cols), ch = z(c, 0.12), hh = c.th({ slot: "headline", w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h;
    const total = hh + z(c, 0.05) + rows * ch + (rows - 1) * g, y0 = Math.max(f.m, Math.round((f.H - total) / 2));
    c.t({ id: "headline", slot: "headline", x: f.m, y: y0, w: W, px: hpx, role: "display", maxLines: 2, lh: 1.08, align: c.s.align, at: 0.1, enter: "rise", stagger: "auto" });
    for (let i = 0; i < 6; i++) {
      const col = i % cols, row = Math.floor(i / cols), x = f.m + (c.s.flip ? cols - 1 - col : col) * (cw + g), y = y0 + hh + z(c, 0.05) + row * (ch + g), at = 0.9 + i * 0.25, npx = z(c, 0.042);
      c.s2({ id: `chip_${i}`, shape: "rect", x, y, w: cw, h: ch, fill: "surface", stroke: "muted", stroke_w: 2, radius: z(c, 0.014), at, dur: 0.5, enter: "pop" });
      c.t({ id: `n${i + 1}`, slot: `n${i + 1}`, x, y: y + Math.round((ch - npx * 1.2) / 2), w: cw, px: npx, role: "body", bold: true, lh: 1.2, align: "center", at: at + 0.1, enter: "fade", stagger: false, maxLines: 1 });
    }
  },
};

const socTwo: FamilyDef = {
  id: "social-two-voices", category: "social_proof", archetype: "two_quotes", title: "Two short voices",
  description: "Two short quotes, each with a name, side by side or stacked, arriving one after the other.",
  retrieval: "Social proof scene with two short customer quotes and names, side by side on wide frames and stacked on tall ones. Several voices agreeing.",
  mood: ["chorus", "approachable"], tone: ["warm", "informal"], energy: "medium",
  slots: [{ name: "q1", role: "headline", max_chars: 80, example: "It paid for itself in the first film." }, { name: "by1", role: "name", max_chars: 28, example: "Priya, Studio Lead" }, { name: "q2", role: "headline", max_chars: 80, example: "Finally, everyone sees the same plan." }, { name: "by2", role: "name", max_chars: 28, example: "Marcus, Producer" }],
  duration_s: 6, axes: NOALIGN,
  build(c) {
    const { f } = c, W = f.W - 2 * f.m, qpx = z(c, f.wide ? 0.056 : 0.058), bpx = z(c, 0.034);
    const place = (n: 1 | 2, x: number, y: number, w: number, at: number) => {
      c.s2({ id: `bar_${n}`, shape: "rect", x, y, w: 6, h: Math.round(qpx * 1.25 * 3 + bpx * 2), fill: n === 1 ? "accent" : "accent_2", at, dur: 0.6, enter: "grow_y" });
      c.t({ id: `q${n}`, slot: `q${n}`, x: x + z(c, 0.035), y, w: w - z(c, 0.035), px: qpx, role: "display", bold: false, maxLines: 3, lh: 1.25, align: "left", at: at + 0.1, enter: "rise", stagger: false });
      c.t({ id: `by${n}`, slot: `by${n}`, x: x + z(c, 0.035), y: y + Math.round(qpx * 1.25 * 3 + bpx * 0.8), w: w - z(c, 0.035), px: bpx, role: "body", color: "muted", lh: 1.2, align: "left", at: at + 0.6, enter: "fade", stagger: false, maxLines: 1 });
    };
    const bh = Math.round(qpx * 1.25 * 3 + bpx * 2);
    if (f.wide) { const g = z(c, 0.07), cw = Math.round((W - g) / 2), y = Math.round((f.H - bh) / 2); place(1, c.fx(f.m, cw), y, cw, 0.2); place(2, c.fx(f.m + cw + g, cw), y, cw, 1.8); }
    else { const g = z(c, 0.08), y0 = Math.max(f.m, Math.round((f.H - (2 * bh + g)) / 2)); place(1, f.m, c.s.flip ? y0 + bh + g : y0, W, 0.2); place(2, f.m, c.s.flip ? y0 : y0 + bh + g, W, 1.8); }
  },
};

// ============================================================ brand_moment
const brandWordmark: FamilyDef = {
  id: "brand-wordmark-rule", category: "brand_moment", archetype: "wordmark", title: "Wordmark with rule",
  description: "A wordmark whose letters spread in from wide tracking, an accent rule and a one-line tagline.",
  retrieval: "Brand moment scene: the wordmark settles in from wide letter-spacing, an accent rule draws beneath and a tagline appears. Signs a film or a section with the brand.",
  mood: ["calm", "assured"], tone: ["refined", "quiet"], energy: "low",
  slots: [{ name: "wordmark", role: "headline", max_chars: 24, example: "DIGIKON" }, { name: "tagline", role: "subline", max_chars: 70, example: "Plan it. Approve it. Render it." }],
  duration_s: 5, axes: ALL,
  build(c) {
    c.block([
      { id: "wordmark", slot: "wordmark", px: z(c, c.f.wide ? 0.15 : 0.13), role: "display", upper: true, lh: 1.05, maxLines: 2, at: 0.2, dur: 1.4, enter: "track", stagger: false },
      { h: z(c, 0.004), gapBefore: z(c, 0.03), make: (y, x, w) => c.s2({ id: "rule", shape: "rect", x: ox(c, x, w, z(c, 0.22)), y, w: z(c, 0.22), h: 5, fill: "accent", at: 1.3, dur: 0.7, enter: grow(c) }) },
      { id: "tagline", slot: "tagline", px: z(c, 0.045), role: "body", color: "muted", lh: 1.3, maxLines: 2, at: 1.9, enter: "fade", stagger: false, gapBefore: z(c, 0.035) },
    ]);
  },
};

const brandBurst: FamilyDef = {
  id: "brand-disc-burst", category: "brand_moment", archetype: "disc", title: "Wordmark on a bursting disc",
  description: "An accent disc springs out and the wordmark sits inside it in the background colour, with a tagline below.",
  retrieval: "Brand moment scene: a solid accent disc bursts out with a spring and the wordmark sits inside it, tagline beneath. Bold, badge-like brand sign-off.",
  mood: ["bold", "celebratory"], tone: ["proud", "energetic"], energy: "high",
  slots: [{ name: "wordmark", role: "headline", max_chars: 14, example: "Digikon" }, { name: "tagline", role: "subline", max_chars: 60, example: "Video, planned." }],
  duration_s: 4.5, axes: NOALIGN,
  build(c) {
    const { f } = c, d = Math.round(f.short * (f.wide ? 0.62 : f.square ? 0.6 : 0.78)), cx = Math.round((f.W - d) / 2), tpx = z(c, 0.045), th = c.th({ slot: "tagline", w: f.W - 2 * f.m, px: tpx, role: "body", maxLines: 2, lh: 1.3 }).h;
    const total = d + z(c, 0.05) + th, cy = Math.max(f.m, Math.round((f.H - total) / 2));
    c.s2({ id: "disc", shape: "ellipse", x: cx, y: cy, w: d, h: d, fill: "accent", at: 0.1, dur: 0.9, enter: "pop" });
    const px = c.fit(c.slotText["wordmark"]!, z(c, f.wide ? 0.13 : 0.12), Math.round(d * 0.78), 1, { bold: true });
    c.t({ id: "wordmark", slot: "wordmark", x: cx + Math.round(d * 0.11), y: cy + Math.round((d - px * 1.1) / 2), w: Math.round(d * 0.78), px, role: "display", color: "background", lh: 1.1, align: "center", at: 0.6, enter: "zoom", stagger: false, maxLines: 1 });
    c.t({ id: "tagline", slot: "tagline", x: f.m, y: cy + d + z(c, 0.05), w: f.W - 2 * f.m, px: tpx, role: "body", color: "muted", maxLines: 2, lh: 1.3, align: "center", at: 1.5, enter: "fade", stagger: false });
  },
};

const brandSign: FamilyDef = {
  id: "brand-corner-sign-off", category: "brand_moment", archetype: "sign_off", title: "Corner sign-off with big initial",
  description: "A very large muted initial fills the frame while the wordmark and tagline settle into the lower corner.",
  retrieval: "Brand moment scene as a sign-off: an oversized, quiet initial letter behind, with the wordmark and tagline settling in the lower corner. Editorial brand signature.",
  mood: ["editorial", "composed"], tone: ["understated", "stylish"], energy: "low",
  slots: [{ name: "initial", role: "label", max_chars: 2, example: "D" }, { name: "wordmark", role: "headline", max_chars: 20, example: "Digikon" }, { name: "tagline", role: "subline", max_chars: 60, example: "Plan first. Render once." }],
  duration_s: 5, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, big = Math.min(600, z(c, f.wide ? 0.9 : 0.8)), w = f.W - 2 * f.m, side = (a: "left" | "right") => (c.s.flip ? (a === "left" ? "right" : "left") : a);
    c.t({ id: "initial", slot: "initial", x: f.m, y: Math.max(f.m, Math.round(f.H * (f.wide ? 0.05 : 0.08))), w: Math.round(f.W * (f.wide ? 0.5 : 0.8)), px: big, role: "display", color: "muted", lh: 0.9, align: side("left"), at: 0.1, dur: 1.2, enter: "fade", stagger: false });
    const tpx = z(c, 0.05), wpx = z(c, f.wide ? 0.11 : 0.1), th = tpx * 1.3, wh = wpx * 1.05;
    const y = f.H - f.m - th - z(c, 0.02) - wh;
    c.t({ id: "wordmark", slot: "wordmark", x: f.m, y, w, px: wpx, role: "display", lh: 1.05, align: side("left"), at: 0.8, enter: "rise", stagger: false, maxLines: 1 });
    c.t({ id: "tagline", slot: "tagline", x: f.m, y: y + wh + z(c, 0.02), w, px: tpx, role: "body", color: "muted", lh: 1.3, align: side("left"), at: 1.5, enter: "fade", stagger: false, maxLines: 1 });
    c.s2({ id: "accent_bar", shape: "rect", x: c.s.flip ? f.W - f.m - z(c, 0.1) : f.m, y: y - z(c, 0.03), w: z(c, 0.1), h: 6, fill: "accent", at: 1.0, dur: 0.6, enter: c.s.flip ? "grow_x_r" : "grow_x" });
  },
};

// ============================================================ transition_beat
const beatWord: FamilyDef = {
  id: "beat-single-word", category: "transition_beat", archetype: "single_word", title: "Single word beat",
  description: "One word pops in large with an accent bar sweeping under it. A beat between two ideas.",
  retrieval: "Transition beat scene: a single large word pops in with an accent bar sweeping beneath. A short punctuation between two parts of a film.",
  mood: ["punchy", "minimal"], tone: ["emphatic", "dry"], energy: "high",
  slots: [{ name: "word", role: "headline", max_chars: 16, example: "Instead." }],
  duration_s: 3.2, axes: ALL,
  build(c) {
    c.block([
      { id: "word", slot: "word", px: z(c, c.f.wide ? 0.2 : 0.18), role: "display", lh: 1.05, maxLines: 1, at: 0.1, enter: "pop", stagger: false },
      { h: z(c, 0.006), gapBefore: z(c, 0.02), make: (y, x, w) => c.s2({ id: "bar", shape: "rect", x: ox(c, x, w, z(c, 0.3)), y, w: z(c, 0.3), h: 8, fill: "accent", at: 0.7, dur: 0.6, enter: grow(c) }) },
    ]);
  },
};

const beatChapter: FamilyDef = {
  id: "beat-chapter-card", category: "transition_beat", archetype: "chapter", title: "Chapter card",
  description: "A large monospace chapter number, a hairline that draws and the chapter title.",
  retrieval: "Transition beat scene as a chapter card: a big monospace number like 02, a hairline drawing across and the chapter title. Marks the start of the next section.",
  mood: ["structured", "calm"], tone: ["editorial", "measured"], energy: "low",
  slots: [{ name: "number", role: "label", max_chars: 3, example: "02" }, { name: "title", role: "headline", max_chars: 40, example: "How it works" }],
  duration_s: 3.6, axes: ALL,
  build(c) {
    c.block([
      { id: "number", slot: "number", px: z(c, c.f.wide ? 0.22 : 0.2), role: "mono", color: "accent", lh: 1, maxLines: 1, at: 0.1, enter: "fade", stagger: false },
      { h: 4, gapBefore: z(c, 0.015), make: (y, x, w) => c.s2({ id: "rule", shape: "rect", x, y, w, h: 3, fill: "muted", at: 0.5, dur: 0.8, enter: c.s.align === "right" ? "grow_x_r" : c.s.align === "center" ? "grow_x_c" : "grow_x", opacity: 0.7 }) },
      { id: "title", slot: "title", px: z(c, c.f.wide ? 0.09 : 0.085), role: "display", maxLines: 2, lh: 1.08, at: 0.9, enter: "rise", stagger: "auto", gapBefore: z(c, 0.025) },
    ]);
  },
};

const beatPanel: FamilyDef = {
  id: "beat-panel-sweep", category: "transition_beat", archetype: "panel_sweep", title: "Panel sweeps to the next title",
  description: "An accent panel crosses the frame and leaves a title and subtitle behind.",
  retrieval: "Transition beat scene where an accent panel sweeps across the frame and exits, uncovering the next title and a subtitle. Hard-edged change of topic.",
  mood: ["decisive", "kinetic"], tone: ["assertive", "tidy"], energy: "high",
  slots: [{ name: "title", role: "headline", max_chars: 40, example: "Now, the proof" }, { name: "subtitle", role: "subline", max_chars: 70, example: "Three numbers from real films." }],
  duration_s: 4, axes: ["palette", "pairing", "motion", "align", "flip", "backdrop", "stagger"],
  build(c) {
    const { f } = c;
    c.block([
      { id: "title", slot: "title", px: z(c, f.wide ? 0.11 : 0.1), role: "display", maxLines: 3, lh: 1.06, at: 0.9, enter: "rise", stagger: "auto" },
      { id: "subtitle", slot: "subtitle", px: z(c, 0.042), role: "body", color: "muted", maxLines: 2, lh: 1.3, at: 1.6, enter: "fade", stagger: false, gapBefore: z(c, 0.03) },
    ]);
    const dir = c.s.flip ? -1 : 1;
    c.s2({ id: "panel", shape: "rect", x: 0, y: 0, w: f.W, h: f.H, fill: "accent", at: 0.1, dur: 1.1, tracks: [{ property: "x", keyframes: [{ at: 0, value: -dir * f.W }, { at: 0.5, value: 0 }, { at: 1, value: dir * f.W }], easing: "ease_in_out" }] });
  },
};

// ============================================================ cta_end
const ctaButton: FamilyDef = {
  id: "cta-button-pulse", category: "cta_end", archetype: "button", title: "Headline and button",
  description: "A closing headline, a pill button that pulses once it lands and a web address beneath.",
  retrieval: "Call-to-action closing scene: a closing headline, a rounded pill button that pulses to draw the eye and a web address underneath. One clear action to take.",
  mood: ["inviting", "clear"], tone: ["friendly", "direct"], energy: "high",
  slots: [{ name: "headline", role: "headline", max_chars: 50, example: "Ready to see your plan?" }, { name: "button", role: "label", max_chars: 20, example: "Start free" }, { name: "url", role: "caption", max_chars: 40, example: "digikon.example/start" }],
  duration_s: 5, axes: ["palette", "pairing", "motion", "align", "flip", "backdrop", "stagger", "camera"],
  build(c) {
    const { f } = c, w = c.cw, bpx = z(c, 0.05), bw = Math.round(Math.min(w, z(c, 0.42))), bh = Math.round(bpx * 2.1);
    c.block([
      { id: "headline", slot: "headline", px: z(c, f.wide ? 0.105 : 0.1), role: "display", maxLines: 3, lh: 1.06, at: 0.1, enter: "rise", stagger: "auto" },
      { h: bh, gapBefore: z(c, 0.05), make: (y, x, ww) => {
        const bx = ox(c, x, ww, bw);
        c.s2({ id: "button", shape: "rect", x: bx, y, w: bw, h: bh, fill: "accent", radius: Math.round(bh / 2), at: 1.0, dur: 0.6, tracks: [{ property: "opacity", keyframes: [{ at: 0, value: 0 }, { at: 0.3, value: 1 }, { at: 1, value: 1 }], easing: "ease_out" }, { property: "scale", keyframes: [{ at: 0, value: 0.7 }, { at: 0.5, value: 1.06 }, { at: 1, value: 1 }], easing: c.ez }] });
        c.t({ id: "button_label", slot: "button", x: bx, y: y + Math.round((bh - bpx * 1.2) / 2), w: bw, px: bpx, role: "body", bold: true, color: "background", lh: 1.2, align: "center", at: 1.1, enter: "fade", stagger: false, maxLines: 1 });
      } },
      { id: "url", slot: "url", px: z(c, 0.036), role: "mono", color: "muted", lh: 1.2, at: 1.8, enter: "fade", stagger: false, gapBefore: z(c, 0.04) },
    ]);
  },
};

const ctaUrl: FamilyDef = {
  id: "cta-big-address", category: "cta_end", archetype: "address", title: "Big web address",
  description: "A short lead-in, the address or handle set very large, and an accent arrow line pointing at it.",
  retrieval: "Call-to-action closing scene with the web address or handle set very large, a short lead-in above and an accent arrow line. Where to go next.",
  mood: ["direct", "memorable"], tone: ["confident", "casual"], energy: "medium",
  slots: [{ name: "lead", role: "label", max_chars: 30, example: "Find us at" }, { name: "address", role: "headline", max_chars: 30, example: "digikon.example" }, { name: "note", role: "caption", max_chars: 60, example: "Your first plan is free", required: false }],
  duration_s: 4.5, axes: ALL,
  build(c) {
    c.block([
      { id: "lead", slot: "lead", px: z(c, 0.042), role: "body", color: "muted", lh: 1.2, at: 0.1, enter: "fade", stagger: false },
      { id: "address", slot: "address", px: z(c, c.f.wide ? 0.13 : 0.11), role: "display", color: "accent", maxLines: 2, lh: 1.05, at: 0.4, enter: "zoom", stagger: false, gapBefore: z(c, 0.015) },
      { h: 6, gapBefore: z(c, 0.025), make: (y, x, w) => c.s2({ id: "arrow", shape: "rect", x: ox(c, x, w, z(c, 0.34)), y, w: z(c, 0.34), h: 6, fill: "text", at: 1.2, dur: 0.7, enter: grow(c) }) },
      { id: "note", slot: "note", px: z(c, 0.038), role: "body", lh: 1.25, at: 1.9, enter: "fade", stagger: false, gapBefore: z(c, 0.03) },
    ]);
  },
};

const ctaClosing: FamilyDef = {
  id: "cta-closing-line", category: "cta_end", archetype: "closing_line", title: "Closing line and action",
  description: "A short closing line, the action in the accent colour, and a quiet sign-off name beneath.",
  retrieval: "Call-to-action closing scene as a calm sign-off: one closing line, the action to take in the accent colour and the sender's name underneath. Gentle ending without a button.",
  mood: ["warm", "gentle"], tone: ["personal", "unhurried"], energy: "low",
  slots: [{ name: "line", role: "headline", max_chars: 60, example: "Make the next film the easy one." }, { name: "action", role: "subline", max_chars: 40, example: "Book a walkthrough" }, { name: "signoff", role: "caption", max_chars: 40, example: "The Digikon team" }],
  duration_s: 5, axes: ALL,
  build(c) {
    c.block([
      { id: "line", slot: "line", px: z(c, c.f.wide ? 0.09 : 0.085), role: "display", maxLines: 3, lh: 1.1, at: 0.1, enter: "rise", stagger: "auto" },
      { id: "action", slot: "action", px: z(c, 0.06), role: "body", bold: true, color: "accent", maxLines: 2, lh: 1.2, at: 1.5, enter: "rise", stagger: false, gapBefore: z(c, 0.045) },
      { id: "signoff", slot: "signoff", px: z(c, 0.034), role: "mono", color: "muted", lh: 1.2, at: 2.2, enter: "fade", stagger: false, gapBefore: z(c, 0.06) },
    ]);
  },
};

const ctaBadge: FamilyDef = {
  id: "cta-offer-badge", category: "cta_end", archetype: "badge", title: "Offer badge",
  description: "A round accent badge with the offer inside springs in beside a headline and an action line.",
  retrieval: "Call-to-action closing scene with an offer badge: a round accent badge carrying the offer springs in next to a headline and an action line. Promotion, free trial, limited offer.",
  mood: ["promotional", "lively"], tone: ["enthusiastic", "straightforward"], energy: "high",
  slots: [{ name: "badge", role: "label", max_chars: 10, example: "FREE" }, { name: "headline", role: "headline", max_chars: 50, example: "Try your first film on us" }, { name: "action", role: "subline", max_chars: 50, example: "Start today at digikon.example" }],
  duration_s: 5, axes: NOALIGN,
  build(c) {
    const { f } = c, d = Math.round(f.short * (f.wide ? 0.42 : 0.5));
    const bpx = c.fit(c.slotText["badge"]!, z(c, 0.14), Math.round(d * 0.74), 1, { bold: true, upper: true });
    const items = [
      { id: "headline", slot: "headline", px: z(c, f.wide ? 0.085 : 0.08), role: "display" as const, maxLines: 3, lh: 1.08, at: 0.5, enter: "rise" as const, stagger: "auto" as const, align: "left" as const },
      { id: "action", slot: "action", px: z(c, 0.042), role: "body" as const, color: "muted" as const, maxLines: 2, lh: 1.3, at: 1.6, enter: "fade" as const, stagger: false as const, gapBefore: z(c, 0.035), align: "left" as const },
    ];
    let bx: number, by: number;
    if (f.wide) { const tw = Math.round(f.W * 0.44); bx = c.fx(f.W - f.m - d, d); by = Math.round((f.H - d) / 2); c.block(items, { x: c.fx(f.m, tw), w: tw }); }
    else { bx = Math.round((f.W - d) / 2); by = Math.round(f.H * 0.08); c.block(items, { x: f.m, w: f.W - 2 * f.m, top: by + d + z(c, 0.05) }); }
    c.s2({ id: "badge_disc", shape: "ellipse", x: bx, y: by, w: d, h: d, fill: "accent", at: 0.1, dur: 0.9, tracks: [{ property: "opacity", keyframes: [{ at: 0, value: 0 }, { at: 0.3, value: 1 }, { at: 1, value: 1 }], easing: "ease_out" }, { property: "scale", keyframes: [{ at: 0, value: 0.5 }, { at: 1, value: 1 }], easing: c.ez }, { property: "rotate", keyframes: [{ at: 0, value: -12 }, { at: 1, value: 0 }], easing: c.ez }] });
    c.t({ id: "badge", slot: "badge", x: bx + Math.round(d * 0.13), y: by + Math.round((d - bpx * 1.1) / 2), w: Math.round(d * 0.74), px: bpx, role: "display", color: "background", upper: true, lh: 1.1, align: "center", at: 0.5, enter: "pop", stagger: false, maxLines: 1 });
  },
};

export const SCENE_3_FAMILIES: FamilyDef[] = [cmpTwoCol, cmpVersus, cmpRows, cmpWipe, socQuote, socRating, socLogos, socTwo, brandWordmark, brandBurst, brandSign, beatWord, beatChapter, beatPanel, ctaButton, ctaUrl, ctaClosing, ctaBadge];
void (null as unknown as Ctx);
