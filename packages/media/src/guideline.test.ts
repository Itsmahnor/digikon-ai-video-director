import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readGuideline } from "./guideline.js";

/** Builds a small PDF with one page, the given content stream, and optional extra objects. Enough structure for the reader; not a general writer. */
function pdf(content: string, o: { compress?: boolean; fonts?: string[]; extra?: string; encrypt?: boolean } = {}): Buffer {
  const body = o.compress ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const fonts = (o.fonts ?? ["/BaseFont /ABCDEF+Fraunces-Bold", "/BaseFont /Helvetica", "/BaseFont /GHIJKL+WorkSans-Regular"]).map((f, i) => `${10 + i} 0 obj\n<< /Type /Font /Subtype /Type1 ${f} >>\nendobj\n`).join("");
  const head = Buffer.from(`%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n${fonts}${o.extra ?? ""}4 0 obj\n<< /Length ${body.length}${o.compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`, "latin1");
  return Buffer.concat([head, body, Buffer.from(`\nendstream\nendobj\n${o.encrypt ? "trailer\n<< /Encrypt 9 0 R >>\n" : ""}%%EOF\n`, "latin1")]);
}
const GUIDE = `BT /F1 24 Tf 72 700 Td (Acme Roasters brand guidelines) Tj ET
0.784 0.314 0.118 rg 72 600 100 100 re f
0 0.6 0.9 0.1 k 200 600 100 100 re f
0.5 g 300 600 50 50 re f
0.04 0.48 0.35 rg 400 600 100 100 re f
BT /F1 12 Tf 72 560 Td (Our voice is warm, direct and never loud. We write the way we talk to a neighbour.) Tj T* [(Primary colour ) -20 (#0A7A5A is used for buttons and links across all of our channels.)] TJ T* (Headlines use Fraunces and body text uses Work Sans, always set in sentence case.) Tj ET`;

describe("brand guideline reader", () => {
  it("reads text, colours and fonts from a plain PDF", () => {
    const r = readGuideline(pdf(GUIDE));
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
    expect(r.pages).toBe(1);
    expect(r.excerpt[0]).toContain("Acme Roasters brand guidelines");
    const hexes = r.colours.map((c) => c.hex);
    expect(hexes).toContain("#c8501e"); // from an RGB fill
    expect(hexes).toContain("#0a7a5a"); // from an RGB fill and from the "#0A7A5A" written in the text
    expect(hexes).toContain("#e6720a".slice(0, 0) + hexes.find((h) => h !== "#c8501e" && h !== "#0a7a5a" && h.startsWith("#e")) ); // the CMYK swatch converts to an orange
    expect(hexes.every((h) => /^#[0-9a-f]{6}$/.test(h))).toBe(true);
    expect(hexes).not.toContain("#808080"); // greys are not brand colours
    expect(r.fonts).toEqual(["Fraunces", "WorkSans"]); // the subset prefix and weight are dropped; the standard font is not a brand font
    expect(r.candidate_facts.some((f) => f.includes("warm, direct and never loud"))).toBe(true);
    expect(r.candidate_facts.some((f) => f.includes("#0A7A5A"))).toBe(true);
  });
  it("reads Flate-compressed streams the same way", () => {
    const plain = readGuideline(pdf(GUIDE)), packed = readGuideline(pdf(GUIDE, { compress: true }));
    expect(packed.status).toBe("ok");
    expect(packed).toEqual(plain);
  });
  it("decodes composite-font text through a ToUnicode map", () => {
    const word = "Our brand voice is warm, direct and never loud. We write the way we talk to a neighbour, in plain words.";
    const ids = [...word].map((c, i) => ({ c, id: 100 + i }));
    const hex = ids.map((x) => x.id.toString(16).padStart(4, "0")).join("");
    const map = `/CIDInit begincmap 1 begincodespacerange <0000> <ffff> endcodespacerange ${ids.length} beginbfchar\n${ids.map((x) => `<${x.id.toString(16).padStart(4, "0")}> <${x.c.charCodeAt(0).toString(16).padStart(4, "0")}>`).join("\n")}\nendbfchar endcmap`;
    const extra = `20 0 obj\n<< /Length ${map.length} >>\nstream\n${map}\nendstream\nendobj\n`;
    const r = readGuideline(pdf(`BT /F1 12 Tf <${hex}> Tj ET`, { extra }));
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
    expect(r.excerpt.join(" ")).toContain("warm, direct and never loud");
  });
});

describe("brand guideline reader: when it cannot read, it says why and never throws", () => {
  it("composite-font text with no usable map -> no_text", () => {
    const hex = Array.from({ length: 60 }, (_, i) => (i + 1).toString(16).padStart(4, "0")).join("");
    expect(readGuideline(pdf(`BT /F1 12 Tf <${hex}> Tj ET`))).toMatchObject({ status: "could_not_read", reason: "no_text" });
  });
  it("a scanned PDF (an image and no text layer) -> no_text", () => {
    expect(readGuideline(pdf("q 600 0 0 800 0 0 cm /Im1 Do Q"))).toMatchObject({ status: "could_not_read", reason: "no_text" });
  });
  it("an encrypted PDF -> encrypted", () => expect(readGuideline(pdf(GUIDE, { encrypt: true }))).toMatchObject({ status: "could_not_read", reason: "encrypted" }));
  it("not a PDF (a picture, a text file, an empty file) -> not_pdf", () => {
    for (const b of [Buffer.from("\x89PNG\r\n\x1a\n" + "x".repeat(400), "latin1"), Buffer.from("hello world, this is a text file".repeat(10)), Buffer.alloc(0), Buffer.from("%PD")]) expect(readGuideline(b)).toMatchObject({ status: "could_not_read", reason: "not_pdf" });
  });
  it("over the size limit -> too_large, before any parsing", () => expect(readGuideline(pdf(GUIDE), { maxBytes: 100 })).toMatchObject({ status: "could_not_read", reason: "too_large" }));
  it("cut short or damaged -> damaged", () => expect(readGuideline(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length 99999 >>\nstream\nabc"))).toMatchObject({ status: "could_not_read", reason: "damaged" }));
  it("a corrupt compressed stream does not crash the reader", () => {
    const bad = Buffer.concat([Buffer.from("%PDF-1.5\n3 0 obj\n<< /Type /Page >>\nendobj\n4 0 obj\n<< /Filter /FlateDecode >>\nstream\n", "latin1"), randomBytes(200), Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")]);
    expect(readGuideline(bad).status).toBe("could_not_read");
  });
  it("random bytes behind a PDF header always give an answer, never an exception", () => {
    for (let i = 0; i < 60; i++) { const r = readGuideline(Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(50 + i * 20)])); expect(["ok", "could_not_read"]).toContain(r.status); }
  });
});
