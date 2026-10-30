import { ESTIMATE_METER, type TextMeter } from "./font-metrics.js";

/**
 * The adaptive layout engine shared by the composed scenes. It knows nothing about any one block: it measures text with the real font, wraps it
 * without changing a word, finds the largest legible size that fits an area, lays cards out in a column, a row or a grid, and says exactly why a
 * layout does not fit. A block planner asks for layouts in order of preference and takes the first that fits; nothing is ever cut or shrunk below the
 * legibility floor, and every attempt is kept so that the reason for a refusal can be shown to the Director.
 */

export interface Rect { x: number; y: number; w: number; h: number }
export interface TextStyle { upper: boolean; bold: boolean }

export const LINE_HEIGHT = 1.2;

/** The legibility floor and the size ladder for a frame, from its SHORT side so that a portrait frame is planned as carefully as a landscape one. */
export function typeScale(width: number, height: number, scaleMult = 1) {
  const short = Math.min(width, height);
  return { short, min: Math.round(short * 0.034), minSmall: Math.round(short * 0.022), body: Math.round(short * 0.042 * scaleMult), small: Math.round(short * 0.026), big: Math.round(short * 0.1 * scaleMult) };
}

/** The graphemes of a string, so that an emoji, a combined accent or a flag is never cut in half. */
export const graphemes = (s: string): string[] => {
  const Seg = (Intl as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  return Seg ? [...new Seg(undefined, { granularity: "grapheme" }).segment(s)].map((x) => x.segment) : Array.from(s);
};

export interface WrapResult { lines: string[]; width: number; broke_word: boolean }

/**
 * Breaks `text` into lines no wider than `maxW` at `px`. Every line break the approved text already has is kept; other breaks fall at spaces.
 * A word wider than a line is placed on a line of its own, and is only broken inside the word when `breakWords` is set (the planner sets it last).
 */
export function wrapMeasured(text: string, meter: TextMeter, px: number, maxW: number, style: TextStyle, breakWords = false): WrapResult {
  const w = (t: string) => meter.width(t, px, style);
  const lines: string[] = [];
  let broke = false;
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    const flush = () => { if (line) { lines.push(line); line = ""; } };
    for (let word of para.split(/\s+/).filter(Boolean)) {
      if (w(word) > maxW && breakWords) {
        flush();
        broke = true;
        let piece = "";
        for (const g of graphemes(word)) { if (piece && w(piece + g) > maxW) { lines.push(piece); piece = ""; } piece += g; }
        line = piece;
        continue;
      }
      const joined = line ? `${line} ${word}` : word;
      if (!line || w(joined) <= maxW) line = joined;
      else { flush(); line = word; }
    }
    flush();
    if (!para.trim()) lines.push("");
  }
  return { lines, width: Math.max(0, ...lines.map(w)), broke_word: broke };
}

export interface FitRequest {
  texts: readonly string[];
  meter: TextMeter;
  style: TextStyle;
  maxW: number;
  maxPx: number;
  minPx: number;
  maxLines: number;
  /** Height one text may use (all its lines); Infinity when the caller checks the height itself. */
  maxH?: number;
  lineHeight?: number;
  breakWords?: boolean;
}
export interface Fit { px: number; lines: string[][]; width: number }
export interface FitFailure { reason: string; needs_px: number | null }

/** The largest size from `maxPx` down to `minPx` at which every text wraps within `maxW`, `maxLines` and `maxH`; otherwise why not. */
export function fitText(r: FitRequest): Fit | FitFailure {
  const lh = r.lineHeight ?? LINE_HEIGHT, maxH = r.maxH ?? Infinity;
  let last: FitFailure = { reason: "there is no text", needs_px: null };
  for (let px = Math.floor(r.maxPx); px >= r.minPx; px--) {
    const wraps = r.texts.map((t) => wrapMeasured(t, r.meter, px, r.maxW, r.style, false));
    const longest = Math.max(0, ...wraps.map((x) => x.lines.length));
    const tooWide = wraps.find((x) => x.width > r.maxW + 0.5);
    if (!tooWide && longest <= r.maxLines && longest * px * lh <= maxH) return { px, lines: wraps.map((x) => x.lines), width: Math.max(0, ...wraps.map((x) => x.width)) };
    last = tooWide ? { reason: `a word is wider than the ${Math.round(r.maxW)}px available`, needs_px: null } : { reason: longest > r.maxLines ? `it needs ${longest} lines and ${r.maxLines} are allowed` : `it needs ${Math.round(longest * px * lh)}px of height and ${Math.round(maxH)}px is available`, needs_px: Math.round(longest * px * lh) };
  }
  if (r.breakWords) {
    const px = r.minPx;
    const wraps = r.texts.map((t) => wrapMeasured(t, r.meter, px, r.maxW, r.style, true));
    const longest = Math.max(0, ...wraps.map((x) => x.lines.length));
    if (longest <= r.maxLines && longest * px * lh <= maxH) return { px, lines: wraps.map((x) => x.lines), width: Math.max(0, ...wraps.map((x) => x.width)) };
    last = { reason: `at ${px}px it needs ${longest} lines (${Math.round(longest * px * lh)}px) in ${Math.round(r.maxW)}px`, needs_px: Math.round(longest * px * lh) };
  }
  return last;
}
export const fits = (x: Fit | FitFailure): x is Fit => "px" in x;

// ---------------------------------------------------------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------------------------------------------------------

export interface Areas { headline: Rect | null; content: Rect; portrait: boolean; wide: boolean; variant: "side" | "top" | "full" }

const margin = (w: number, h: number) => Math.round(Math.min(w, h) * 0.07);

/**
 * The available areas of a frame. The first is the house layout: a headline column beside the picture in a wide frame, a band above it otherwise.
 * `variant: "top"` puts the headline in a band above the picture even in a wide frame, which gives a wide, short picture the full width.
 */
export function layoutAreas(width: number, height: number, hasHeadline: boolean, variant: "side" | "top" = "side"): Areas {
  const portrait = height >= width, wide = width / height >= 1.5;
  const m = margin(width, height);
  if (!hasHeadline) return { headline: null, content: { x: wide ? Math.round(width * 0.14) : m, y: m, w: wide ? Math.round(width * 0.72) : width - 2 * m, h: height - 2 * m }, portrait, wide, variant: "full" };
  if (wide && variant === "side") return { headline: { x: m, y: m, w: Math.round(width * 0.34), h: height - 2 * m }, content: { x: Math.round(width * 0.44), y: m, w: Math.round(width * 0.5), h: height - 2 * m }, portrait, wide, variant: "side" };
  const hh = Math.round(height * (portrait ? 0.2 : wide ? 0.22 : 0.24)), gap = Math.round(m * 0.6);
  return { headline: { x: m, y: m, w: width - 2 * m, h: hh }, content: { x: m, y: m + hh + gap, w: width - 2 * m, h: height - 2 * m - hh - gap }, portrait, wide, variant: "top" };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Cards in a grid
// ---------------------------------------------------------------------------------------------------------------------------

export interface GridShape { cols: number; rows: number; cell: { w: number; h: number }; gap: { x: number; y: number } }

/** Every way to lay `n` equal cells out in reading order inside `box`, from a single column to a single row. */
export function gridShapes(n: number, box: Rect, gapShare = 0.045): GridShape[] {
  const out: GridShape[] = [];
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    // a ragged last row is not wanted: skip shapes that leave more than one empty cell
    if (rows * cols - n > 1 && cols > 1) continue;
    const gx = Math.round(Math.min(box.w, box.h) * gapShare * (cols > 1 ? 1.4 : 1)), gy = Math.round(Math.min(box.w, box.h) * gapShare);
    out.push({ cols, rows, cell: { w: Math.floor((box.w - gx * (cols - 1)) / cols), h: Math.floor((box.h - gy * (rows - 1)) / rows) }, gap: { x: gx, y: gy } });
  }
  return out;
}

export const cellRect = (g: GridShape, box: Rect, i: number): Rect => {
  const r = Math.floor(i / g.cols), c = i % g.cols;
  return { x: box.x + c * (g.cell.w + g.gap.x), y: box.y + r * (g.cell.h + g.gap.y), w: g.cell.w, h: g.cell.h };
};

// ---------------------------------------------------------------------------------------------------------------------------
// Overflow detection
// ---------------------------------------------------------------------------------------------------------------------------

export interface Placed { name: string; rect: Rect }

/** Everything drawn must sit inside the frame's safe margin and nothing may overlap another thing. Returns plain sentences. */
export function detectOverflow(items: readonly Placed[], bounds: Rect, opts: { overlapOk?: (a: string, b: string) => boolean } = {}): string[] {
  const issues: string[] = [];
  const eps = 0.75;
  for (const it of items) {
    const r = it.rect;
    if (r.x < bounds.x - eps || r.y < bounds.y - eps || r.x + r.w > bounds.x + bounds.w + eps || r.y + r.h > bounds.y + bounds.h + eps) issues.push(`${it.name} leaves the area (${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)} in ${Math.round(bounds.w)}x${Math.round(bounds.h)})`);
  }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i]!, b = items[j]!;
    if (opts.overlapOk?.(a.name, b.name)) continue;
    const ox = Math.min(a.rect.x + a.rect.w, b.rect.x + b.rect.w) - Math.max(a.rect.x, b.rect.x), oy = Math.min(a.rect.y + a.rect.h, b.rect.y + b.rect.h) - Math.max(a.rect.y, b.rect.y);
    if (ox > eps && oy > eps) issues.push(`${a.name} overlaps ${b.name}`);
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Steps (process flow): column, row, grid, then progressive pages
// ---------------------------------------------------------------------------------------------------------------------------

export interface StepIn { label: string; detail: string | null }
export interface StepsLayout {
  strategy: "column" | "row" | "grid" | "pages";
  cols: number;
  rows: number;
  cell: { w: number; h: number };
  gap: { x: number; y: number };
  /** The height each card is drawn at (never more than the cell), and where the block of cards starts. */
  node_h: number;
  origin: { x: number; y: number };
  pad: number;
  badge: number;
  font_px: number;
  detail_px: number;
  labels: string[][];
  details: string[][];
  /** Step indexes shown together, in order. One page unless the strategy is `pages`. */
  pages: number[][];
  /** The content box the pages are laid out in. */
  box: Rect;
}
export interface Attempt { strategy: string; ok: boolean; font_px: number | null; note: string }

export interface StepsRequest { steps: readonly StepIn[]; box: Rect; meter: TextMeter; style: TextStyle; maxPx: number; minPx: number; minDetailPx: number; maxDetailPx: number; durationS: number }

const MIN_PAGE_DWELL_S = 2;

/** Lays the steps out in the best arrangement that is legible; with all attempts when none is. */
export function layoutSteps(r: StepsRequest): { ok: true; layout: StepsLayout; attempts: Attempt[] } | { ok: false; attempts: Attempt[] } {
  const attempts: Attempt[] = [];
  const n = r.steps.length;
  const tryShape = (g: GridShape, indexes: number[], box: Rect, strategy: StepsLayout["strategy"]): StepsLayout | null => {
    const label = `${strategy} ${g.cols}x${g.rows}`;
    // the largest type for this shape: badge on the left, text on the right; pad and badge grow with the type
    let best: StepsLayout | null = null, note = "";
    for (let f = Math.floor(r.maxPx); f >= r.minPx; f--) {
      const pad = Math.round(f * 0.6), badge = Math.round(f * 1.5), innerW = g.cell.w - 2 * pad - badge - Math.round(f * 0.6);
      const df = Math.max(r.minDetailPx, Math.min(r.maxDetailPx, Math.round(f * 0.62)));
      if (innerW < f * 2) { note = `a ${Math.round(g.cell.w)}px card leaves ${Math.round(innerW)}px for the text`; continue; }
      const labels: string[][] = [], details: string[][] = [];
      let tallest = 0, wide = false;
      for (const i of indexes) {
        const st = r.steps[i]!;
        const lw = wrapMeasured(st.label, r.meter, f, innerW, r.style), dw = st.detail ? wrapMeasured(st.detail, r.meter, df, innerW, { ...r.style, bold: false }) : null;
        if (lw.width > innerW + 0.5 || (dw && dw.width > innerW + 0.5)) wide = true;
        labels.push(lw.lines); details.push(dw ? dw.lines : []);
        tallest = Math.max(tallest, lw.lines.length * f * 1.15 + (dw ? df * 0.3 + dw.lines.length * df * 1.2 : 0));
      }
      const need = Math.max(badge, tallest) + 2 * pad;
      if (wide) { note = `a word does not fit ${Math.round(innerW)}px at ${f}px`; continue; }
      if (need > g.cell.h) { note = `a card needs ${Math.round(need)}px of height and has ${Math.round(g.cell.h)}px (${f}px type)`; continue; }
      const nodeH = Math.min(g.cell.h, Math.round(Math.max(need, f * 3.2)));
      const origin = { x: box.x + (box.w - (g.cols * g.cell.w + (g.cols - 1) * g.gap.x)) / 2, y: box.y + (box.h - (g.rows * nodeH + (g.rows - 1) * g.gap.y)) / 2 };
      best = { strategy, cols: g.cols, rows: g.rows, cell: g.cell, gap: g.gap, node_h: nodeH, origin, pad, badge, font_px: f, detail_px: df, labels, details, pages: [indexes], box };
      break;
    }
    attempts.push({ strategy: label, ok: !!best, font_px: best?.font_px ?? null, note: best ? `fits at ${best.font_px}px` : note || "does not fit" });
    return best;
  };

  // 1. all steps on one page, in every grid shape; the best is the one that allows the largest type, then the fewest columns (the plainest reading order)
  const all = Array.from({ length: n }, (_, i) => i);
  const wholes = gridShapes(n, r.box).map((g) => tryShape(g, all, r.box, g.cols === 1 ? "column" : g.rows === 1 ? "row" : "grid")).filter((x): x is StepsLayout => !!x);
  if (wholes.length) {
    wholes.sort((a, b) => b.font_px - a.font_px || a.cols - b.cols);
    // a size within 2px of the best is as readable; prefer the plainer order (column, then row) over a grid at that size
    const top = wholes[0]!.font_px;
    const pick = wholes.filter((w) => w.font_px >= top - 2).sort((a, b) => (a.strategy === "column" ? 0 : a.strategy === "row" ? 1 : 2) - (b.strategy === "column" ? 0 : b.strategy === "row" ? 1 : 2) || b.font_px - a.font_px)[0]!;
    return { ok: true, layout: pick, attempts };
  }

  // 2. progressive pages: the same steps in the same order, a few at a time, each page held for a legible time inside the approved duration
  for (let per = n - 1; per >= 1; per--) {
    const pageCount = Math.ceil(n / per);
    if (r.durationS / pageCount < MIN_PAGE_DWELL_S) { attempts.push({ strategy: `pages of ${per}`, ok: false, font_px: null, note: `${pageCount} pages would each be shown for ${(r.durationS / pageCount).toFixed(1)}s (at least ${MIN_PAGE_DWELL_S}s is needed)` }); continue; }
    const pages: number[][] = [];
    for (let i = 0; i < n; i += per) pages.push(all.slice(i, i + per));
    // the cell is sized for one page, and the type is chosen so that the tallest step of ANY page fits it
    const fitted = gridShapes(per, r.box).map((s) => tryShape(s, all, r.box, "pages")).filter((x): x is StepsLayout => !!x);
    if (fitted.length) {
      const f = fitted.sort((a, b) => b.font_px - a.font_px || a.cols - b.cols)[0]!;
      return { ok: true, layout: { ...f, strategy: "pages", pages }, attempts };
    }
  }
  return { ok: false, attempts };
}

// ---------------------------------------------------------------------------------------------------------------------------
// A window with a title, a sidebar and rows (product UI demo)
// ---------------------------------------------------------------------------------------------------------------------------

export interface WindowRowIn { label: string; tag: string | null }
export interface WindowLayout {
  font_px: number; title_px: number; small_px: number; confirm_px: number;
  win: Rect; title_h: number; title_lines: string[];
  side_w: number; side_mode: "left" | "tabs" | "none"; side_lines: string[][]; side_rects: Rect[];
  cols: number; row_lines: string[][]; row_rects: Rect[]; tag_w: number[];
  confirm: null | { lines: string[]; rect: Rect };
  /** Everything drawn, for the overflow check. */
  placed: Placed[];
}
export interface WindowRequest { title: string; sidebar: readonly string[]; rows: readonly WindowRowIn[]; confirm: string | null; box: Rect; meter: TextMeter; style: TextStyle; maxPx: number; minPx: number; minSmallPx: number; maxSmallPx: number }

/** Vertical spacing, from comfortable to compact; the type is never shrunk to make room until the spacing has been tightened. */
const DENSITIES = [{ name: "comfortable", row: 1.7, gap: 0.4, title: 2, pad: 0.8 }, { name: "compact", row: 1.45, gap: 0.3, title: 1.7, pad: 0.6 }, { name: "tight", row: 1.3, gap: 0.2, title: 1.5, pad: 0.3 }] as const;

/** Lays the window out at the largest legible type: labels and titles wrap, the sidebar widens, rows go into two columns if that is what it takes. */
export function layoutWindow(r: WindowRequest): { ok: true; layout: WindowLayout; attempts: Attempt[] } | { ok: false; attempts: Attempt[] } {
  const attempts: Attempt[] = [];
  const { box, meter, style } = r;
  const fitted: WindowLayout[] = [];
  for (let f = Math.floor(r.maxPx); f >= r.minPx; f--) {
    let best = { stage: 0, msg: "" };
    const miss = (stage: number, msg: string) => { if (stage >= best.stage) best = { stage, msg }; };
    for (const dens of DENSITIES) for (const cols of [1, 2]) for (const sideShare of r.sidebar.length ? [0.24, 0.3, 0.36, "tabs" as const] : [0]) {
      const tabs = sideShare === "tabs", share = tabs ? 0 : sideShare;
      const label = `window ${dens.name}, ${cols} column${cols > 1 ? "s" : ""}${tabs ? ", sidebar as tabs" : share ? `, sidebar ${Math.round(share * 100)}%` : ""}`;
      const tf = Math.max(r.minSmallPx, Math.round(f * 0.92)), sf = Math.max(r.minSmallPx, Math.min(r.maxSmallPx, Math.round(f * 0.62))), cf = Math.max(r.minSmallPx, Math.round(f * 0.95));
      const w = box.w, side = Math.round(w * share);
      // title: beside three window dots
      const dots = f * (0.55 + 0.45) * 3 + f * 0.6, titleW = w - dots - f * 2;
      const tw = wrapMeasured(r.title, meter, tf, titleW, { ...style, bold: false });
      if (tw.width > titleW + 0.5) { miss(1, `the window title does not fit ${Math.round(titleW)}px at ${tf}px`); continue; }
      const titleH = Math.max(f * dens.title, tw.lines.length * tf * 1.2 + f * 0.9);
      // sidebar items (up to two lines each)
      const sideInner = side - f * 1.2 - f * 0.8;
      let sideLines: string[][] = [], sideH = 0;
      let tabsH = 0;
      if (tabs) {
        const widths = r.sidebar.map((s) => meter.width(s, sf, style) + f * 0.8);
        const total = widths.reduce((a, b) => a + b, 0) + f * 0.25 * (widths.length - 1);
        if (total > w - f * 1.2) { miss(2, `the sidebar items as tabs need ${Math.round(total)}px of width and the window has ${Math.round(w - f * 1.2)}px`); continue; }
        sideLines = r.sidebar.map((s) => [s]);
        tabsH = sf * 1.2 + f * 0.7 + f * 0.3;
      } else if (side) {
        const sw = r.sidebar.map((s) => wrapMeasured(s, meter, sf, sideInner, style));
        if (sw.some((x) => x.width > sideInner + 0.5 || x.lines.length > 2)) { miss(2, `a sidebar item does not fit ${Math.round(sideInner)}px at ${sf}px`); continue; }
        sideLines = sw.map((x) => x.lines);
        sideH = sw.reduce((a, x) => a + x.lines.length * sf * 1.2 + f * 0.7 + f * 0.25, 0) + f * 1.4;
      }
      // rows
      const rowsX = side + f * 0.8, rowsW = w - side - f * 1.6, gapX = f * 0.5, colW = (rowsW - gapX * (cols - 1)) / cols;
      const tagW = r.rows.map((row) => (row.tag ? meter.width(row.tag, sf, { ...style, bold: false }) : 0));
      const rowLines: string[][] = [];
      let bad = false;
      for (const [i, row] of r.rows.entries()) {
        const avail = colW - f * 1.6 - (f * 0.6 + f * 0.7) - (tagW[i]! ? tagW[i]! + f * 0.5 : 0);
        const wr = wrapMeasured(row.label, meter, f, avail, style);
        if (avail < f * 3 || wr.width > avail + 0.5 || wr.lines.length > 3) { bad = true; miss(3, `a row label does not fit ${Math.round(avail)}px at ${f}px (${wr.lines.length} lines, ${cols} column${cols > 1 ? "s" : ""})`); break; }
        rowLines.push(wr.lines);
      }
      if (bad) continue;
      const rowH = rowLines.map((l) => Math.max(f * dens.row, l.length * f * 1.2 + f * dens.pad));
      const rowGap = f * dens.gap, gridRows = Math.ceil(r.rows.length / cols);
      const gridH = Array.from({ length: gridRows }, (_, gr) => Math.max(...rowH.slice(gr * cols, gr * cols + cols)));
      const rowsH = gridH.reduce((a, b) => a + b, 0) + rowGap * (gridRows - 1);
      // confirm pill
      let confirm: WindowLayout["confirm"] = null, pillH = 0;
      if (r.confirm) {
        const maxPill = w * 0.9 - f * 2.2 - cf * 1.5;
        const cw = wrapMeasured(r.confirm, meter, cf, maxPill, { ...style, bold: true });
        if (cw.width > maxPill + 0.5) { miss(4, `the confirmation does not fit ${Math.round(maxPill)}px at ${cf}px`); continue; }
        const pw = cw.width + f * 2.2 + cf * 1.5, ph = cw.lines.length * cf * 1.2 + f * 1.0;
        confirm = { lines: cw.lines, rect: { x: 0, y: 0, w: pw, h: ph } };
        pillH = ph + f * 0.45;
      }
      const contentH = Math.max(titleH + tabsH + f * 0.3 + rowsH + f * 0.9, titleH + sideH);
      if (contentH + pillH > box.h) { miss(5, `the window needs ${Math.round(contentH + pillH)}px of height and has ${Math.round(box.h)}px (${f}px type, ${dens.name} spacing, ${cols} column${cols > 1 ? "s" : ""})`); continue; }
      // place
      const winH = contentH, y0 = box.y + (box.h - winH - pillH) / 2;
      const win: Rect = { x: box.x, y: y0, w, h: winH };
      const rowsTop = y0 + titleH + tabsH + f * 0.3;
      const rowRects: Rect[] = [];
      let yy = rowsTop;
      for (let gr = 0; gr < gridRows; gr++) {
        for (let c = 0; c < cols; c++) { const i = gr * cols + c; if (i < r.rows.length) rowRects.push({ x: box.x + rowsX + c * (colW + gapX), y: yy, w: colW, h: gridH[gr]! }); }
        yy += gridH[gr]! + rowGap;
      }
      const sideRects: Rect[] = [];
      let sy = y0 + titleH + f * 0.7;
      if (tabs) {
        let sx = box.x + f * 0.6;
        for (const ls of sideLines) { const tw2 = meter.width(ls[0]!, sf, style) + f * 0.8; sideRects.push({ x: sx, y: y0 + titleH + f * 0.15, w: tw2, h: sf * 1.2 + f * 0.7 }); sx += tw2 + f * 0.25; }
      } else for (const ls of sideLines) { const h = ls.length * sf * 1.2 + f * 0.7; sideRects.push({ x: box.x + f * 0.6, y: sy, w: side - f * 1.2, h }); sy += h + f * 0.25; }
      if (confirm) { confirm.rect = { ...confirm.rect, x: box.x + w / 2 - confirm.rect.w / 2, y: win.y + win.h + f * 0.45 }; }
      const placed: Placed[] = [
        { name: "the window", rect: win },
        ...rowRects.map((rect, i) => ({ name: `row ${i + 1}`, rect })),
        ...sideRects.map((rect, i) => ({ name: `sidebar item ${i + 1}`, rect })),
        ...(confirm ? [{ name: "the confirmation", rect: confirm.rect }] : []),
      ];
      // the window contains its rows and sidebar by design; only rows against rows, and a sidebar item against a row, would be a fault
      const issues = detectOverflow(placed, box, { overlapOk: (a, b) => a === "the window" || b === "the window" });
      if (issues.length) { miss(6, issues[0]!); continue; }
      fitted.push({ font_px: f, title_px: tf, small_px: sf, confirm_px: cf, win, title_h: titleH, title_lines: tw.lines, side_w: side, side_mode: tabs ? "tabs" : side ? "left" : "none", side_lines: sideLines, side_rects: sideRects, cols, row_lines: rowLines, row_rects: rowRects, tag_w: tagW, confirm, placed });
      attempts.push({ strategy: label, ok: true, font_px: f, note: `fits at ${f}px` });
    }
    if (fitted.length) break;
    if (f === r.minPx || f % 6 === 0) attempts.push({ strategy: `window at ${f}px`, ok: false, font_px: null, note: best.msg || "does not fit" });
  }
  if (!fitted.length) return { ok: false, attempts };
  // the plainest arrangement at the largest size: one column, the narrowest sidebar
  const top = fitted[0]!.font_px;
  const pick = fitted.filter((x) => x.font_px === top)[0]!; // candidates were tried plainest first: comfortable, one column, narrowest sidebar
  return { ok: true, layout: pick, attempts };
}

/** Where step i is drawn: its page's grid, in reading order. */
export function stepRect(l: StepsLayout, i: number): Rect {
  const page = l.pages.find((p) => p.includes(i)) ?? l.pages[0]!, k = Math.max(0, page.indexOf(i));
  const r = Math.floor(k / l.cols), c = k % l.cols;
  return { x: l.origin.x + c * (l.cell.w + l.gap.x), y: l.origin.y + r * (l.node_h + l.gap.y), w: l.cell.w, h: l.node_h };
}

/** The reason a set of attempts failed, as one sentence with the numbers. */
export const describeAttempts = (attempts: readonly Attempt[]): string => attempts.filter((a) => !a.ok).slice(0, 6).map((a) => `${a.strategy}: ${a.note}`).join("; ");

/** What the Director needs to know before it writes a visual: the real limits of a frame. */
export function layoutConstraints(width: number, height: number): { frame: string; min_text_px: number; min_detail_px: number; content_area_px: { w: number; h: number }; content_area_with_headline_px: { w: number; h: number }; guidance: string[] } {
  const t = typeScale(width, height);
  const full = layoutAreas(width, height, false).content, withH = layoutAreas(width, height, true).content, top = layoutAreas(width, height, true, "top").content;
  const best = withH.w * withH.h >= top.w * top.h ? withH : top;
  return {
    frame: `${width}x${height}`, min_text_px: t.min, min_detail_px: t.minSmall,
    content_area_px: { w: full.w, h: full.h }, content_area_with_headline_px: { w: best.w, h: best.h },
    guidance: [
      `Text is never drawn below ${t.min}px (${t.minSmall}px for small print) in this frame; the renderer wraps long wording, switches between column, row and grid, and pages steps within the approved duration, but it never cuts words.`,
      "Keep step and row labels under about 40 characters; wording is kept exactly as approved.",
      "A process flow of up to about 8 short steps fits one page; more steps are shown in pages and need at least 2 seconds per page.",
    ],
  };
}

export { ESTIMATE_METER };
