import { inflateSync } from "node:zlib";

/**
 * Reads a brand guideline PDF for the guided intake: text, colours and font names. It is a small reader written for this job, not a general PDF engine. It handles
 * uncompressed and Flate-compressed content streams, literal and hex text strings, ToUnicode maps for composite fonts, and RGB, CMYK and grey colour operators.
 * What it cannot read (encrypted files, scanned pages with no text layer, fonts with no usable map, damaged files) comes back as `could_not_read` with a reason,
 * never as an exception and never as a guess, so the wizard can ask the user to type the details in. Nothing it returns is a fact until the user confirms it.
 */
export type GuidelineProblem = "not_pdf" | "too_large" | "encrypted" | "no_text" | "damaged";
export interface GuidelineCouldNotRead { status: "could_not_read"; reason: GuidelineProblem; detail: string }
export interface GuidelineReading {
  status: "ok";
  pages: number;
  /** Most used non-neutral colours as lower-case #rrggbb, with how often each appeared. */
  colours: { hex: string; count: number }[];
  fonts: string[];
  excerpt: string[];
  candidate_facts: string[];
  text_chars: number;
}
export type GuidelineResult = GuidelineReading | GuidelineCouldNotRead;
export const MAX_GUIDELINE_BYTES = 20 * 1024 * 1024;

const STANDARD_FONTS = /^(helvetica|times|courier|symbol|zapfdingbats|arial|timesnewroman|couriernew)/i;
const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, "0");
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const neutral = (h: string) => { const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return Math.max(...v) - Math.min(...v) <= 14; };

/** Decodes every stream in the file that can be decoded; others are skipped. */
function streams(buf: Buffer): string[] {
  const s = buf.toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const dictStart = s.lastIndexOf("<<", m.index);
    const dict = dictStart >= 0 ? s.slice(dictStart, m.index) : "";
    const raw = buf.subarray(start, end);
    try {
      if (/\/FlateDecode/.test(dict)) out.push(inflateSync(raw.subarray(0, raw.length)).toString("latin1"));
      else if (!/\/Filter/.test(dict)) out.push(raw.toString("latin1"));
    } catch { try { out.push(inflateSync(raw.subarray(0, Math.max(0, raw.length - 1))).toString("latin1")); } catch { /* an undecodable stream is skipped */ } }
    re.lastIndex = end + 9;
  }
  return out;
}

function unescapeLiteral(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) => (/^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e));
}

/** ToUnicode maps (beginbfchar / beginbfrange) from every font in the file, merged. Good for files that use one or two fonts, which guideline documents usually do. */
function toUnicodeMap(all: string[]): Map<number, string> {
  const map = new Map<number, string>();
  const u16 = (h: string) => { let o = ""; for (let i = 0; i + 4 <= h.length; i += 4) o += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return o; };
  for (const st of all) {
    if (!st.includes("beginbf")) continue;
    for (const blk of st.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const m of blk[1]!.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) map.set(parseInt(m[1]!, 16), u16(m[2]!));
    for (const blk of st.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const m of blk[1]!.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
      const a = parseInt(m[1]!, 16), b = parseInt(m[2]!, 16), base = u16(m[3]!);
      for (let c = a; c <= b && c - a < 512; c++) map.set(c, base.length ? base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - a)) : "");
    }
  }
  return map;
}

function textOf(content: string, cmap: Map<number, string>): string {
  const parts: string[] = [];
  for (const bt of content.matchAll(/BT([\s\S]*?)ET/g)) {
    let line = "";
    const body = bt[1]!;
    for (const tok of body.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|(\((?:[^()\\]|\\.|\((?:[^()\\]|\\.)*\))*\)|<[0-9a-fA-F\s]*>)\s*(?:Tj|'|")|\bT\*|\bTd\b|\bTD\b|\bTm\b/g)) {
      const piece = tok[1] ?? tok[2];
      if (piece === undefined) { line += " "; continue; }
      for (const s of piece.matchAll(/\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]*>/g)) {
        const t = s[0]!;
        if (t.startsWith("(")) line += unescapeLiteral(t.slice(1, -1));
        else {
          const h = t.slice(1, -1).replace(/\s/g, "");
          if (cmap.size) { for (let i = 0; i + 4 <= h.length; i += 4) line += cmap.get(parseInt(h.slice(i, i + 4), 16)) ?? ""; if (h.length % 4 === 2) line += cmap.get(parseInt(h.slice(-2), 16)) ?? ""; }
          else for (let i = 0; i + 2 <= h.length; i += 2) { const c = parseInt(h.slice(i, i + 2), 16); line += c >= 32 && c < 127 ? String.fromCharCode(c) : ""; }
        }
      }
      line += " ";
    }
    parts.push(line.replace(/\s+/g, " ").trim());
  }
  return parts.filter(Boolean).join("\n");
}

function colours(content: string): string[] {
  const out: string[] = [];
  const n = "(-?\\d*\\.?\\d+)";
  for (const m of content.matchAll(new RegExp(`${n}\\s+${n}\\s+${n}\\s+(?:rg|RG)\\b`, "g"))) out.push(toHex(+m[1]!, +m[2]!, +m[3]!));
  for (const m of content.matchAll(new RegExp(`${n}\\s+${n}\\s+${n}\\s+${n}\\s+(?:k|K)\\b`, "g"))) { const [c, mm, y, k] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!]; out.push(toHex((1 - c) * (1 - k), (1 - mm) * (1 - k), (1 - y) * (1 - k))); }
  return out;
}

export function readGuideline(buf: Buffer, opts: { maxBytes?: number } = {}): GuidelineResult {
  const max = opts.maxBytes ?? MAX_GUIDELINE_BYTES;
  if (buf.length > max) return { status: "could_not_read", reason: "too_large", detail: `the file is larger than ${Math.round(max / 1048576)} MB` };
  if (buf.length < 8 || buf.subarray(0, 1024).toString("latin1").indexOf("%PDF-") < 0) return { status: "could_not_read", reason: "not_pdf", detail: "that file is not a PDF" };
  const raw = buf.toString("latin1");
  if (/\/Encrypt\b/.test(raw)) return { status: "could_not_read", reason: "encrypted", detail: "the PDF is password-protected or encrypted" };
  if (!/%%EOF/.test(raw.slice(-2048)) && !/\/Type\s*\/Page\b/.test(raw)) return { status: "could_not_read", reason: "damaged", detail: "the PDF looks damaged or cut short" };
  let decoded: string[];
  try { decoded = streams(buf); } catch { return { status: "could_not_read", reason: "damaged", detail: "the PDF could not be decoded" }; }
  const everything = [raw, ...decoded];
  const cmap = toUnicodeMap(decoded);
  const text = decoded.map((c) => textOf(c, cmap)).filter(Boolean).join("\n");
  const readable = text.replace(/\s/g, "");
  if (readable.length < 80 || (readable.match(/[A-Za-z]/g)?.length ?? 0) / readable.length < 0.5) return { status: "could_not_read", reason: "no_text", detail: "no readable text was found (it may be scanned pages or use fonts that cannot be decoded)" };

  const counts = new Map<string, number>();
  for (const c of decoded) for (const h of colours(c)) counts.set(h, (counts.get(h) ?? 0) + 1);
  for (const m of text.matchAll(/#([0-9a-fA-F]{6})\b/g)) counts.set(`#${m[1]!.toLowerCase()}`, (counts.get(`#${m[1]!.toLowerCase()}`) ?? 0) + 3);
  for (const m of text.matchAll(/\bRGB[:\s]+(\d{1,3})[\s,/]+(\d{1,3})[\s,/]+(\d{1,3})\b/gi)) { const h = toHex(+m[1]! / 255, +m[2]! / 255, +m[3]! / 255); counts.set(h, (counts.get(h) ?? 0) + 3); }
  const cols = [...counts].filter(([h]) => !neutral(h)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([hex, count]) => ({ hex, count }));

  const fonts = new Map<string, number>();
  for (const st of everything) for (const m of st.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([A-Za-z0-9_-]+)/g)) {
    const name = m[1]!.replace(/-(Bold|Italic|Regular|Medium|Light|Semibold|Black|Oblique|BoldItalic).*$/i, "").replace(/(Bold|Italic|Regular)$/i, "");
    if (name && !STANDARD_FONTS.test(name)) fonts.set(name, (fonts.get(name) ?? 0) + 1);
  }
  const lines = text.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 1);
  const sentences = text.replace(/\n+/g, " ").split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length >= 25 && x.length <= 200);
  return {
    status: "ok", pages: (raw.match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length || 1, colours: cols,
    fonts: [...fonts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([n]) => n),
    excerpt: lines.slice(0, 6), candidate_facts: [...new Set(sentences)].slice(0, 8), text_chars: readable.length,
  };
}
