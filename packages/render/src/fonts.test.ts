import { describe, expect, it } from "vitest";
import { faceFiles, faceTtf, loadFontRecords, verifyFontRecords } from "./fonts.js";

describe("shipped typefaces", () => {
  it("every font file is present, matches its recorded hash and has its OFL licence text", () => {
    expect(verifyFontRecords()).toEqual([]);
  });
  it("all records are OFL-1.1 and name a source", () => {
    for (const r of loadFontRecords()) { expect(r.licence).toBe("OFL-1.1"); expect(r.source).toMatch(/^https:\/\//); }
  });
  it("gives a regular and a bold file for every face, as woff2 for browsers and ttf for FFmpeg and measuring", () => {
    expect(faceFiles()).toEqual({ serif: ["EBGaramond-400.woff2", "EBGaramond-700.woff2"], mono: ["JetBrainsMono-400.woff2", "JetBrainsMono-700.woff2"] });
    expect(faceFiles(undefined, "ttf")).toEqual({ sans: ["InterVariable.ttf", "InterVariable.ttf"], serif: ["EBGaramond-400.ttf", "EBGaramond-700.ttf"], mono: ["JetBrainsMono-400.ttf", "JetBrainsMono-700.ttf"] });
    for (const face of ["sans", "serif", "mono"] as const) expect(faceTtf(face)).toMatch(/\.ttf$/);
  });
});