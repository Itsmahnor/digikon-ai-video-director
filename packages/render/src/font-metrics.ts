import { readFileSync } from "node:fs";

/**
 * Text measurement from the real font file. The layout engine asks a `TextMeter` how wide a string is at a size; a meter built from the font's own
 * advance widths gives the width the browser will draw, and the estimating meter is the conservative fallback when no font can be read.
 * Only TrueType/OpenType outlines are read (cmap formats 4 and 12, hmtx); kerning and ligatures are not applied, so widths are padded slightly.
 */

export interface TextMeter {
  readonly kind: "font" | "estimate";
  /** Width in pixels of one line of `text` at `px`. `upper` measures the text as drawn upper case; `bold` allows for synthetic bold. */
  width(text: string, px: number, style?: { upper?: boolean; bold?: boolean }): number;
}

const BOLD_PAD = 1.06; // a font file with one weight is emboldened by the browser, which widens each glyph
const KERN_PAD = 1.015;

/** The fallback: an average glyph width, generous so that text is shrunk before it can clip. */
export const ESTIMATE_METER: TextMeter = {
  kind: "estimate",
  width: (text, px, s) => Array.from(text).length * px * 0.56 * (s?.upper ? 1.12 : 1) * (s?.bold ? BOLD_PAD : 1),
};

export function fontMeterFromBuffer(buf: Buffer): TextMeter | null {
  try {
    const u16 = (o: number) => buf.readUInt16BE(o), u32 = (o: number) => buf.readUInt32BE(o);
    let base = 0;
    if (buf.toString("latin1", 0, 4) === "ttcf") base = u32(12);
    const numTables = u16(base + 4);
    const tables = new Map<string, number>();
    for (let i = 0; i < numTables; i++) { const o = base + 12 + i * 16; tables.set(buf.toString("latin1", o, o + 4), u32(o + 8)); }
    const head = tables.get("head"), hhea = tables.get("hhea"), maxp = tables.get("maxp"), hmtx = tables.get("hmtx"), cmap = tables.get("cmap");
    if (head === undefined || hhea === undefined || maxp === undefined || hmtx === undefined || cmap === undefined) return null;
    const unitsPerEm = u16(head + 18), numHMetrics = u16(hhea + 34), numGlyphs = u16(maxp + 4);
    if (!unitsPerEm || !numHMetrics) return null;
    const advance = (gid: number) => u16(hmtx + Math.min(gid, numHMetrics - 1) * 4);

    // pick a Unicode cmap subtable: format 12 (full range) preferred, else format 4 (BMP)
    const nSub = u16(cmap + 2);
    let sub12 = -1, sub4 = -1;
    for (let i = 0; i < nSub; i++) {
      const pid = u16(cmap + 4 + i * 8), eid = u16(cmap + 6 + i * 8), off = cmap + u32(cmap + 8 + i * 8);
      const fmt = u16(off);
      const unicode = pid === 0 || (pid === 3 && (eid === 1 || eid === 10));
      if (!unicode) continue;
      if (fmt === 12) sub12 = off; else if (fmt === 4 && sub4 < 0) sub4 = off;
    }
    const glyphOf = (cp: number): number => {
      if (sub12 >= 0) {
        const n = u32(sub12 + 12);
        let lo = 0, hi = n - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1, g = sub12 + 16 + mid * 12, start = u32(g), end = u32(g + 4);
          if (cp < start) hi = mid - 1; else if (cp > end) lo = mid + 1; else return u32(g + 8) + (cp - start);
        }
        return 0;
      }
      if (sub4 >= 0 && cp <= 0xffff) {
        const segX2 = u16(sub4 + 6), ends = sub4 + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
        for (let s = 0; s < segX2; s += 2) {
          if (cp > u16(ends + s)) continue;
          const start = u16(starts + s);
          if (cp < start) return 0;
          const ro = u16(ranges + s), delta = u16(deltas + s);
          if (ro === 0) return (cp + delta) & 0xffff;
          const g = u16(ranges + s + ro + (cp - start) * 2);
          return g === 0 ? 0 : (g + delta) & 0xffff;
        }
      }
      return 0;
    };
    if (sub12 < 0 && sub4 < 0) return null;
    const cache = new Map<number, number>();
    const em = (cp: number): number => {
      let w = cache.get(cp);
      if (w === undefined) {
        const gid = glyphOf(cp);
        // a character the font lacks is drawn from a fallback font by the browser: assume an average-width glyph
        w = gid > 0 && gid < numGlyphs ? advance(gid) / unitsPerEm : 0.6;
        cache.set(cp, w);
      }
      return w;
    };
    return {
      kind: "font",
      width(text, px, s) {
        const t = s?.upper ? text.toUpperCase() : text;
        let sum = 0;
        for (const ch of t) sum += em(ch.codePointAt(0)!);
        return sum * px * KERN_PAD * (s?.bold ? BOLD_PAD : 1);
      },
    };
  } catch { return null; }
}

/** A meter from a font file path, or the estimating meter when the file cannot be read. */
export function loadFontMeter(file: string): TextMeter {
  try { return fontMeterFromBuffer(readFileSync(file)) ?? ESTIMATE_METER; } catch { return ESTIMATE_METER; }
}
