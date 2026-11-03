import type { FamilyDef } from "../kit.js";
import { gap, grow, ox, side, z } from "./common.js";

const AX_TEXT = ["palette", "pairing", "motion", "align", "flip", "backdrop", "stagger", "camera"] as const;

// ============================================================ hook
const hookBoldClaim: FamilyDef = {
  id: "hook-bold-claim", category: "hook", archetype: "bold_claim", title: "Bold claim opener",
  description: "A large headline stacked under a small eyebrow, an accent rule that draws in, and one supporting line. Opens a film on a single strong claim.",
  retrieval: "Opening hook scene with one bold claim as a huge headline, an eyebrow label and a supporting line. Stops the scroll in the first seconds. Text-only, no footage needed.",
  mood: ["confident", "direct"], tone: ["assertive", "plain-spoken"], energy: "high",
  slots: [{ name: "eyebrow", role: "label", max_chars: 40, example: "The 60 second pitch" }, { name: "headline", role: "headline", max_chars: 80, example: "Most videos lose you in three seconds" }, { name: "subline", role: "subline", max_chars: 120, example: "Here is how to keep every viewer to the end." }],
  duration_s: 4.5, axes: AX_TEXT,
  build(c) {
    c.block([
      { id: "eyebrow", slot: "eyebrow", px: z(c, 0.032), role: "mono", upper: true, color: "accent", lh: 1.2, at: 0.1, enter: "fade", stagger: false },
      { id: "headline", slot: "headline", px: z(c, c.f.wide ? 0.105 : 0.1), role: "display", maxLines: c.f.wide ? 3 : 5, lh: 1.04, at: 0.3, enter: "rise", stagger: "auto", gapBefore: z(c, 0.03) },
      { h: z(c, 0.01), gapBefore: z(c, 0.035), make: (y, x, w) => c.s2({ id: "rule", shape: "rect", x: ox(c, x, w, z(c, 0.26)), y, w: z(c, 0.26), h: Math.max(4, z(c, 0.009)), fill: "accent", at: 1.2, dur: 0.7, enter: grow(c) }) },
      { id: "subline", slot: "subline", px: z(c, 0.04), role: "body", color: "muted", maxLines: 3, lh: 1.3, at: 1.5, enter: "fade", stagger: false, gapBefore: z(c, 0.035) },
    ]);
  },
};

const hookQuestion: FamilyDef = {
  id: "hook-question-mark", category: "hook", archetype: "question", title: "Question with giant mark",
  description: "A giant question mark beside or above a short question and one answer-teasing line. Opens on curiosity.",
  retrieval: "Opening hook scene that asks the viewer a question. A giant question mark glyph pops in, the question sets word by word, a teaser line follows. Curiosity gap opener.",
  mood: ["curious", "playful"], tone: ["inviting", "provocative"], energy: "medium",
  slots: [{ name: "mark", role: "label", max_chars: 2, example: "?" }, { name: "question", role: "headline", max_chars: 70, example: "What if your ad was done before lunch?" }, { name: "teaser", role: "subline", max_chars: 100, example: "It takes one brief and one approval." }],
  duration_s: 4.5, axes: AX_TEXT,
  build(c) {
    const { f } = c;
    const markPx = z(c, f.wide ? 0.52 : f.square ? 0.34 : 0.5);
    if (f.wide) {
      const tw = Math.round(f.W * 0.52), mw = Math.round(f.W * 0.26);
      c.t({ id: "mark", slot: "mark", x: c.fx(f.W - f.m - mw, mw), y: Math.round((f.H - markPx * 0.82) / 2), w: mw, px: markPx, role: "display", color: "accent", lh: 0.82, align: "center", at: 0.05, enter: "pop", stagger: false });
      c.block([
        { id: "question", slot: "question", px: z(c, 0.095), role: "display", maxLines: 4, lh: 1.06, at: 0.4, enter: "rise", stagger: "auto" },
        { id: "teaser", slot: "teaser", px: z(c, 0.04), role: "body", color: "muted", maxLines: 3, lh: 1.3, at: 1.4, enter: "fade", stagger: false, gapBefore: z(c, 0.04) },
      ], { x: c.fx(f.m, tw), w: tw });
    } else {
      c.t({ id: "mark", slot: "mark", x: f.m, y: Math.round(f.H * 0.08), w: f.W - 2 * f.m, px: markPx, role: "display", color: "accent", lh: 0.82, align: "center", at: 0.05, enter: "pop", stagger: false });
      c.block([
        { id: "question", slot: "question", px: z(c, 0.095), role: "display", maxLines: f.square ? 3 : 5, lh: 1.06, at: 0.4, enter: "rise", stagger: "auto" },
        { id: "teaser", slot: "teaser", px: z(c, 0.04), role: "body", color: "muted", maxLines: 3, lh: 1.3, at: 1.4, enter: "fade", stagger: false, gapBefore: z(c, 0.03) },
      ], { top: Math.round(f.H * 0.08 + markPx * 0.82 + z(c, 0.02)) });
    }
  },
};

const hookNumber: FamilyDef = {
  id: "hook-number-shock", category: "hook", archetype: "shock_number", title: "Shock number opener",
  description: "A very large number counts up from zero over a headline, with a short qualifier below. Opens on a surprising figure.",
  retrieval: "Opening hook scene built on one shocking statistic. A huge percentage counts up, then a headline explains it. Data-led attention grabber.",
  mood: ["urgent", "factual"], tone: ["authoritative", "stark"], energy: "high",
  slots: [{ name: "figure", role: "number", max_chars: 4, example: "87" }, { name: "headline", role: "headline", max_chars: 70, example: "of viewers decide in the first three seconds" }, { name: "source", role: "caption", max_chars: 60, example: "Platform study, 2025", required: false }],
  duration_s: 4.5, axes: AX_TEXT,
  build(c) {
    c.block([
      { id: "figure", slot: "figure", px: z(c, c.f.wide ? 0.3 : 0.28), role: "display", color: "accent", lh: 1, counter: { to: 87, suffix: "%" }, at: 0.2, dur: 1.4, stagger: false },
      { id: "headline", slot: "headline", px: z(c, 0.06), role: "display", maxLines: 3, lh: 1.12, at: 1.2, enter: "rise", stagger: "auto", gapBefore: z(c, 0.03) },
      { id: "source", slot: "source", px: z(c, 0.03), role: "mono", color: "muted", lh: 1.2, at: 1.9, enter: "fade", stagger: false, gapBefore: z(c, 0.04) },
    ]);
  },
};

const hookContrast: FamilyDef = {
  id: "hook-old-vs-new", category: "hook", archetype: "contrast", title: "Old way, new way",
  description: "The old way is set in muted type and struck through; the new way arrives in the accent colour. Opens on a before/after claim.",
  retrieval: "Opening hook scene contrasting the old way with the new way. The old statement is struck out by a line, the new statement pops in the accent colour. Change-of-approach opener.",
  mood: ["decisive", "fresh"], tone: ["confident", "slightly cheeky"], energy: "high",
  slots: [{ name: "old_label", role: "label", max_chars: 24, example: "The old way" }, { name: "old_way", role: "headline", max_chars: 50, example: "Weeks of edits" }, { name: "new_label", role: "label", max_chars: 24, example: "The new way" }, { name: "new_way", role: "headline", max_chars: 50, example: "One approved plan" }],
  duration_s: 5, axes: AX_TEXT,
  build(c) {
    const px = z(c, c.f.wide ? 0.11 : 0.1), w = c.cw;
    const o = c.th({ slot: "old_way", w, px, role: "display", maxLines: 2, lh: 1.05 });
    const x = c.ax(w);
    c.block([
      { id: "old_label", slot: "old_label", px: z(c, 0.03), role: "mono", upper: true, color: "muted", lh: 1.2, at: 0.1, enter: "fade", stagger: false },
      { id: "old_way", slot: "old_way", px, role: "display", color: "muted", maxLines: 2, lh: 1.05, at: 0.25, enter: "rise", stagger: false, gapBefore: z(c, 0.015) },
      { h: 0, gapBefore: 0, make: () => undefined },
      { id: "new_label", slot: "new_label", px: z(c, 0.03), role: "mono", upper: true, color: "accent", lh: 1.2, at: 2.0, enter: "fade", stagger: false, gapBefore: z(c, 0.07) },
      { id: "new_way", slot: "new_way", px, role: "display", color: "accent", maxLines: 2, lh: 1.05, at: 2.15, enter: "pop", stagger: false, gapBefore: z(c, 0.015) },
    ], { x, w });
    // the strike sweeps across the old line after it has been read
    const ow = c.measure(c.slotText["old_way"]!, o.px, w, { bold: true }).width;
    const stackH = c.th({ slot: "old_label", w, px: z(c, 0.03), role: "mono", lh: 1.2 }).h + z(c, 0.015) + o.h + z(c, 0.07) + c.th({ slot: "new_label", w, px: z(c, 0.03), role: "mono", lh: 1.2 }).h + z(c, 0.015) + c.th({ slot: "new_way", w, px, role: "display", maxLines: 2, lh: 1.05 }).h;
    const y0 = Math.max(c.f.m, (c.f.H - stackH) / 2) + c.th({ slot: "old_label", w, px: z(c, 0.03), role: "mono", lh: 1.2 }).h + z(c, 0.015);
    const sx = c.s.align === "left" ? x : c.s.align === "right" ? x + w - ow : x + (w - ow) / 2;
    c.s2({ id: "strike", shape: "rect", x: sx - 8, y: y0 + o.h / (2 * o.lines) - 3, w: ow + 16, h: 6, fill: "accent", at: 1.3, dur: 0.6, enter: "grow_x" });
  },
};

// ============================================================ problem
const problemPainList: FamilyDef = {
  id: "problem-pain-list", category: "problem", archetype: "pain_list", title: "Pain points list",
  description: "A headline and three short pain points, each marked with a cross that lands as the line slides in.",
  retrieval: "Problem scene listing three pain points under a headline, each with a red-style cross mark that lands one after another. Names what is wrong before the solution.",
  mood: ["frustrated", "honest"], tone: ["empathetic", "direct"], energy: "medium",
  slots: [{ name: "headline", role: "headline", max_chars: 60, example: "Sound familiar?" }, { name: "pain_1", role: "item", max_chars: 48, example: "Edits that never end" }, { name: "pain_2", role: "item", max_chars: 48, example: "Feedback lost in chat" }, { name: "pain_3", role: "item", max_chars: 48, example: "Deadlines that slip" }],
  duration_s: 5, axes: AX_TEXT,
  build(c) {
    const { f } = c, w = c.cw, x = c.ax(w), ipx = z(c, f.wide ? 0.058 : 0.056), markW = z(c, 0.07), hpx = z(c, 0.08);
    const hh = c.th({ slot: "headline", w, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h, ih = ipx * 1.2, g = z(c, 0.035);
    const total = hh + z(c, 0.05) + 3 * ih + 2 * g;
    const y0 = Math.max(f.m, (f.H - total) / 2);
    c.t({ id: "headline", slot: "headline", x, y: y0, w, px: hpx, role: "display", maxLines: 2, lh: 1.08, at: 0.1, enter: "rise", stagger: "auto" });
    [1, 2, 3].forEach((n, i) => {
      const y = y0 + hh + z(c, 0.05) + i * (ih + g), at = 0.9 + i * 0.55;
      const left = c.s.align === "right" ? x + w - markW : x;
      const tx = c.s.align === "right" ? x : x + markW;
      c.t({ id: `mark_${n}`, slot: `pain_${n}`, bind: false, text: "x", x: left, y, w: markW, px: ipx, role: "mono", color: "accent", lh: 1.2, align: "left", at, enter: "pop", stagger: false });
      c.t({ id: `pain_${n}`, slot: `pain_${n}`, x: tx, y, w: w - markW, px: ipx, role: "body", bold: false, lh: 1.2, at: at + 0.05, enter: side(c), stagger: false, maxLines: 1, align: c.s.align === "center" ? "left" : c.s.align });
    });
  },
};

const problemStrike: FamilyDef = {
  id: "problem-crossed-out", category: "problem", archetype: "crossed_out", title: "Crossed-out assumption",
  description: "A common assumption is struck through by a sweeping line, with a muted comment beneath. Names a myth to retire.",
  retrieval: "Problem scene that crosses out a common assumption or myth: the statement is set big, a line sweeps through it, a short muted comment follows. Myth-busting problem statement.",
  mood: ["skeptical", "sharp"], tone: ["challenging", "dry"], energy: "medium",
  slots: [{ name: "myth", role: "headline", max_chars: 56, example: "More footage means a better film" }, { name: "comment", role: "subline", max_chars: 110, example: "It means more to cut, check and explain." }],
  duration_s: 4.5, axes: AX_TEXT,
  build(c) {
    const w = c.cw, x = c.ax(w), px = z(c, c.f.wide ? 0.09 : 0.085);
    const th = c.th({ slot: "myth", w, px, role: "display", maxLines: 3, lh: 1.1 });
    const cm = c.th({ slot: "comment", w, px: z(c, 0.04), role: "body", maxLines: 3, lh: 1.3 });
    const total = th.h + z(c, 0.05) + cm.h, y0 = Math.max(c.f.m, (c.f.H - total) / 2);
    c.t({ id: "myth", slot: "myth", x, y: y0, w, px, role: "display", maxLines: 3, lh: 1.1, color: "text", at: 0.1, enter: "rise", stagger: false });
    const lw = c.measure(c.slotText["myth"]!, th.px, w, { bold: true }).width;
    const sx = c.s.align === "left" ? x : c.s.align === "right" ? x + w - lw : x + (w - lw) / 2;
    for (let i = 0; i < th.lines; i++) c.s2({ id: `strike_${i}`, shape: "rect", x: sx - 10, y: y0 + th.px * 1.1 * (i + 0.5) - 4, w: lw + 20, h: 8, fill: "accent", at: 1.0 + i * 0.25, dur: 0.5, enter: "grow_x" });
    c.t({ id: "comment", slot: "comment", x, y: y0 + th.h + z(c, 0.05), w, px: z(c, 0.04), role: "body", color: "muted", maxLines: 3, lh: 1.3, at: 2.1, enter: "fade", stagger: false });
  },
};

const problemCost: FamilyDef = {
  id: "problem-cost-stat", category: "problem", archetype: "cost_of_problem", title: "Cost of the problem",
  description: "A muted label, a large figure counting up in the accent colour and a sentence on what it costs. Quantifies the problem.",
  retrieval: "Problem scene that puts a number on the cost of the problem: a big counted-up figure with a label above and an explanation below. Quantified pain.",
  mood: ["sobering", "serious"], tone: ["matter-of-fact", "weighty"], energy: "low",
  slots: [{ name: "label", role: "label", max_chars: 36, example: "Lost every month" }, { name: "figure", role: "number", max_chars: 6, example: "40" }, { name: "explain", role: "subline", max_chars: 110, example: "hours spent on rework nobody planned for." }],
  duration_s: 5, axes: AX_TEXT,
  build(c) {
    c.block([
      { id: "label", slot: "label", px: z(c, 0.034), role: "mono", upper: true, color: "muted", lh: 1.2, at: 0.1, enter: "fade", stagger: false },
      { id: "figure", slot: "figure", px: z(c, c.f.wide ? 0.3 : 0.27), role: "display", color: "accent", lh: 1, counter: { to: 40, suffix: " h" }, at: 0.4, dur: 1.5, stagger: false, gapBefore: z(c, 0.01) },
      { id: "explain", slot: "explain", px: z(c, 0.05), role: "body", maxLines: 3, lh: 1.25, at: 1.8, enter: "rise", stagger: false, gapBefore: z(c, 0.03) },
    ]);
  },
};

const problemTangle: FamilyDef = {
  id: "problem-tool-tangle", category: "problem", archetype: "tangle", title: "Tangle of tools",
  description: "Four tool names tilt and drift around a plain headline to show a tangled workflow.",
  retrieval: "Problem scene showing a messy, tangled workflow: several tool names as tilted chips scattered around a headline. Too many tools, scattered work.",
  mood: ["chaotic", "overloaded"], tone: ["wry", "relatable"], energy: "medium",
  slots: [{ name: "headline", role: "headline", max_chars: 56, example: "Five tools for one video" }, { name: "tool_1", role: "item", max_chars: 14, example: "Docs" }, { name: "tool_2", role: "item", max_chars: 14, example: "Chat" }, { name: "tool_3", role: "item", max_chars: 14, example: "Drive" }, { name: "tool_4", role: "item", max_chars: 14, example: "Email" }],
  duration_s: 5, axes: AX_TEXT,
  build(c) {
    const { f } = c, w = c.cw, x = c.ax(w), hpx = z(c, 0.09);
    const hh = c.th({ slot: "headline", w, px: hpx, role: "display", maxLines: 2, lh: 1.08 }).h;
    const y0 = Math.round(f.H * (f.wide ? 0.4 : 0.42) - hh / 2);
    c.t({ id: "headline", slot: "headline", x, y: y0, w, px: hpx, role: "display", maxLines: 2, lh: 1.08, at: 0.1, enter: "rise", stagger: "auto" });
    const cw = z(c, 0.2), ch = z(c, 0.075), pad = f.m;
    const spots = f.wide ? [[pad, f.H * 0.08], [f.W - pad - cw, f.H * 0.12], [pad + cw * 0.3, f.H * 0.78], [f.W - pad - cw * 1.3, f.H * 0.74]] : [[pad, f.H * 0.06], [f.W - pad - cw, f.H * 0.1], [pad, f.H * 0.8], [f.W - pad - cw, f.H * 0.84]];
    const rots = [-6, 5, -4, 7];
    spots.forEach(([sx, sy], i) => {
      const n = i + 1, gx = c.fx(sx!, cw);
      c.raw({ id: `chip_${n}`, kind: "group", parent: null, props: { x: Math.round(gx), y: Math.round(sy!) }, timeline: { start_s: 0.7 + i * 0.3, duration_s: c.s.motion.dur + 0.4, tracks: [{ property: "rotate", keyframes: [{ at: 0, value: 0 }, { at: 1, value: rots[i]! }], easing: c.ez }, { property: "opacity", keyframes: [{ at: 0, value: 0 }, { at: 0.5, value: 1 }, { at: 1, value: 1 }], easing: "ease_out" }, { property: "scale", keyframes: [{ at: 0, value: 0.6 }, { at: 1, value: 1 }], easing: c.ez }] }, bindings: {} });
      c.s2({ id: `chipbg_${n}`, shape: "rect", parent: `chip_${n}`, x: 0, y: 0, w: cw, h: ch, fill: "surface", radius: Math.round(ch * 0.3), at: 0.7 + i * 0.3, tracks: [] });
      c.t({ id: `tool_${n}`, slot: `tool_${n}`, parent: `chip_${n}`, x: 0, y: Math.round((ch - z(c, 0.04) * 1.2) / 2), w: cw, px: z(c, 0.04), role: "mono", lh: 1.2, align: "center", at: 0.7 + i * 0.3, enter: "none", stagger: false });
    });
  },
};

// ============================================================ solution_reveal
const solMaskReveal: FamilyDef = {
  id: "solution-wipe-reveal", category: "solution_reveal", archetype: "wipe_reveal", title: "Wipe-reveal name",
  description: "The product or idea name is revealed by a wipe, with an accent bar under it and a one-line promise.",
  retrieval: "Solution reveal scene: the product or solution name is uncovered by a clean wipe, an accent bar draws under it, then a one-line promise appears. The moment the answer arrives.",
  mood: ["relief", "bright"], tone: ["assured", "clean"], energy: "medium",
  slots: [{ name: "intro", role: "label", max_chars: 30, example: "Meet" }, { name: "name", role: "headline", max_chars: 28, example: "Digikon Director" }, { name: "promise", role: "subline", max_chars: 100, example: "Plan it, approve it, render it." }],
  duration_s: 5, axes: AX_TEXT,
  build(c) {
    const w = c.cw, x = c.ax(w), px = z(c, c.f.wide ? 0.13 : 0.12);
    const nm = c.th({ slot: "name", w, px, role: "display", maxLines: 2, lh: 1.05 });
    const intro = c.th({ slot: "intro", w, px: z(c, 0.036), role: "mono", lh: 1.2 }).h, pr = c.th({ slot: "promise", w, px: z(c, 0.045), role: "body", maxLines: 2, lh: 1.3 }).h;
    const total = intro + z(c, 0.02) + nm.h + z(c, 0.03) + 8 + z(c, 0.03) + pr, y0 = Math.max(c.f.m, (c.f.H - total) / 2);
    c.t({ id: "intro", slot: "intro", x, y: y0, w, px: z(c, 0.036), role: "mono", upper: true, color: "accent", lh: 1.2, at: 0.1, enter: "fade", stagger: false });
    const ny = y0 + intro + z(c, 0.02);
    const nameW = Math.min(w, Math.ceil(c.measure(c.slotText["name"]!, nm.px, w, { bold: true }).width) + 24);
    const mx = c.s.align === "left" ? x : c.s.align === "right" ? x + w - nameW : x + (w - nameW) / 2;
    c.raw({ id: "reveal", kind: "mask", parent: null, props: { reveal: c.s.align === "right" ? "right" : "left", x: Math.round(mx), y: Math.round(ny - 4), w: nameW, h: Math.round(nm.h + 8) }, timeline: { start_s: 0.5, duration_s: 0.9, tracks: [{ property: "progress", keyframes: [{ at: 0, value: 0 }, { at: 1, value: 1 }], easing: c.ez }] }, bindings: {} });
    c.t({ id: "name", slot: "name", parent: "reveal", x: c.s.align === "right" ? 0 : 0, y: 4, w: nameW, px: nm.px, role: "display", lh: 1.05, align: "left", at: 0.5, enter: "none", stagger: false, maxLines: 2 });
    c.s2({ id: "bar", shape: "rect", x: ox(c, x, w, z(c, 0.3)), y: ny + nm.h + z(c, 0.03), w: z(c, 0.3), h: 8, fill: "accent", at: 1.5, dur: 0.6, enter: grow(c) });
    c.t({ id: "promise", slot: "promise", x, y: ny + nm.h + z(c, 0.06) + 8, w, px: z(c, 0.045), role: "body", color: "muted", maxLines: 2, lh: 1.3, at: 1.9, enter: "fade", stagger: false });
  },
};

const solPop: FamilyDef = {
  id: "solution-name-pop", category: "solution_reveal", archetype: "name_pop", title: "Springing name",
  description: "A small intro line, the solution name popping in at large size and a tagline that fades in below.",
  retrieval: "Solution reveal scene where the name pops in large with a spring, after a small lead-in line, followed by a tagline. Energetic product reveal.",
  mood: ["excited", "optimistic"], tone: ["upbeat", "warm"], energy: "high",
  slots: [{ name: "intro", role: "label", max_chars: 30, example: "Introducing" }, { name: "name", role: "headline", max_chars: 28, example: "The Director" }, { name: "tagline", role: "subline", max_chars: 90, example: "Your video, planned before it is made." }],
  duration_s: 4.5, axes: AX_TEXT,
  build(c) {
    c.block([
      { id: "intro", slot: "intro", px: z(c, 0.042), role: "body", color: "muted", lh: 1.2, at: 0.1, enter: "fade", stagger: false },
      { id: "name", slot: "name", px: z(c, c.f.wide ? 0.16 : 0.14), role: "display", color: "accent", maxLines: 2, lh: 1.02, at: 0.5, enter: "pop", stagger: false, gapBefore: z(c, 0.015) },
      { id: "tagline", slot: "tagline", px: z(c, 0.05), role: "body", maxLines: 2, lh: 1.25, at: 1.5, enter: "rise", stagger: false, gapBefore: z(c, 0.035) },
    ]);
  },
};

const solFromTo: FamilyDef = {
  id: "solution-from-to", category: "solution_reveal", archetype: "transformation", title: "From-to transformation",
  description: "A muted 'from' word on one side, an arrow that draws, and an accent 'to' word on the other. Shows a problem turning into an outcome.",
  retrieval: "Solution reveal scene as a transformation: a muted starting state, an arrow line that draws across, and an accent end state. From chaos to clarity.",
  mood: ["resolving", "hopeful"], tone: ["clear", "reassuring"], energy: "medium",
  slots: [{ name: "from_word", role: "headline", max_chars: 16, example: "Chaos" }, { name: "to_word", role: "headline", max_chars: 16, example: "Clarity" }, { name: "caption", role: "caption", max_chars: 90, example: "One plan every tool can follow." }],
  duration_s: 5, axes: ["palette", "pairing", "motion", "flip", "backdrop", "camera"],
  build(c) {
    const { f } = c, px = z(c, f.wide ? 0.12 : 0.11);
    if (f.wide) {
      const colW = Math.round(f.W * 0.3), y = Math.round(f.H * 0.42 - px / 2);
      c.t({ id: "from_word", slot: "from_word", x: c.fx(f.m, colW), y, w: colW, px, role: "display", color: "muted", lh: 1.05, align: c.s.flip ? "right" : "left", at: 0.1, enter: "rise", stagger: false });
      c.t({ id: "to_word", slot: "to_word", x: c.fx(f.W - f.m - colW, colW), y, w: colW, px, role: "display", color: "accent", lh: 1.05, align: c.s.flip ? "left" : "right", at: 1.5, enter: "pop", stagger: false });
      const ax0 = f.m + colW + z(c, 0.04), aw = f.W - 2 * (f.m + colW + z(c, 0.04));
      c.s2({ id: "arrow", shape: "rect", x: c.fx(ax0, aw), y: y + Math.round(px * 0.5), w: aw, h: 6, fill: "text", at: 0.8, dur: 0.7, enter: c.s.flip ? "grow_x_r" : "grow_x" });
      c.t({ id: "caption", slot: "caption", x: c.ax(c.cw), y: Math.round(f.H * 0.62), w: c.cw, px: z(c, 0.042), role: "body", color: "muted", maxLines: 2, lh: 1.3, align: "center", at: 2.2, enter: "fade", stagger: false });
    } else {
      const w = f.W - 2 * f.m, y0 = Math.round(f.H * 0.28);
      c.t({ id: "from_word", slot: "from_word", x: f.m, y: y0, w, px, role: "display", color: "muted", lh: 1.05, align: "center", at: 0.1, enter: "rise", stagger: false });
      c.s2({ id: "arrow", shape: "rect", x: Math.round(f.W / 2 - 3), y: y0 + Math.round(px * 1.4), w: 6, h: Math.round(f.H * 0.12), fill: "text", at: 0.8, dur: 0.7, enter: "grow_y" });
      c.t({ id: "to_word", slot: "to_word", x: f.m, y: y0 + Math.round(px * 1.4 + f.H * 0.12 + z(c, 0.03)), w, px, role: "display", color: "accent", lh: 1.05, align: "center", at: 1.5, enter: "pop", stagger: false });
      c.t({ id: "caption", slot: "caption", x: f.m, y: Math.round(f.H * 0.72), w, px: z(c, 0.042), role: "body", color: "muted", maxLines: 3, lh: 1.3, align: "center", at: 2.2, enter: "fade", stagger: false });
    }
  },
};

const solCurtain: FamilyDef = {
  id: "solution-curtain-open", category: "solution_reveal", archetype: "curtain", title: "Curtain opens on the answer",
  description: "Two surface panels slide apart to uncover a headline, then a supporting line follows.",
  retrieval: "Solution reveal scene where two panels slide apart like a curtain to uncover the answer headline, then a supporting line fades in. Theatrical reveal.",
  mood: ["dramatic", "polished"], tone: ["theatrical", "confident"], energy: "medium",
  slots: [{ name: "headline", role: "headline", max_chars: 56, example: "There is a simpler way" }, { name: "subline", role: "subline", max_chars: 100, example: "Plan first. Approve. Then render." }],
  duration_s: 5, axes: ["palette", "pairing", "motion", "align", "backdrop", "stagger", "camera"],
  build(c) {
    const { f } = c, w = c.cw, x = c.ax(w);
    c.block([
      { id: "headline", slot: "headline", px: z(c, c.f.wide ? 0.11 : 0.1), role: "display", maxLines: 3, lh: 1.06, at: 0.3, enter: "zoom", stagger: false },
      { id: "subline", slot: "subline", px: z(c, 0.045), role: "body", color: "muted", maxLines: 2, lh: 1.3, at: 1.7, enter: "fade", stagger: false, gapBefore: z(c, 0.035) },
    ], { x, w });
    const half = Math.ceil(f.W / 2);
    const slide = (id: string, px0: number, to: number) => c.s2({ id, shape: "rect", x: px0, y: 0, w: half, h: f.H, fill: "surface", at: 0.5, dur: 1.0, tracks: [{ property: "x", keyframes: [{ at: 0, value: 0 }, { at: 1, value: to }], easing: c.ez }, { property: "opacity", keyframes: [{ at: 0, value: 1 }, { at: 0.85, value: 1 }, { at: 1, value: 0 }], easing: "linear" }] });
    slide("panel_l", 0, -half); slide("panel_r", half, half);
    void gap;
  },
};

export const SCENE_1_FAMILIES: FamilyDef[] = [hookBoldClaim, hookQuestion, hookNumber, hookContrast, problemPainList, problemStrike, problemCost, problemTangle, solMaskReveal, solPop, solFromTo, solCurtain];
