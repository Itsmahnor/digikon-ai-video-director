import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fontMeterFromBuffer, loadFontMeter, type TextMeter } from "./font-metrics.js";

/** Licence records for the typefaces that ship with the renderer (packages/render/fonts/fonts.json). */
export const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fonts");

export interface FontRecord { file: string; family: string; face: "sans" | "serif" | "mono"; weight: 400 | 700; format: "woff2" | "ttf" | "otf"; licence: "OFL-1.1"; licence_file: string; source: string; sha256: string }

export function loadFontRecords(dir = FONTS_DIR): FontRecord[] {
  return (JSON.parse(readFileSync(join(dir, "fonts.json"), "utf8")) as { fonts: FontRecord[] }).fonts;
}

/** Problems with the shipped fonts: a missing file or licence text, or a file that is not the one that was licensed. Empty when all is in order. */
export function verifyFontRecords(dir = FONTS_DIR): string[] {
  const out: string[] = [];
  for (const r of loadFontRecords(dir)) {
    if (!existsSync(join(dir, r.file))) { out.push(`${r.file}: file missing`); continue; }
    if (!existsSync(join(dir, r.licence_file))) out.push(`${r.file}: licence text ${r.licence_file} missing`);
    if (createHash("sha256").update(readFileSync(join(dir, r.file))).digest("hex") !== r.sha256) out.push(`${r.file}: does not match its recorded hash`);
  }
  return out;
}

/** [regular, bold] file names per face in the given format, for the faces that have files. */
export function faceFiles(dir = FONTS_DIR, format: FontRecord["format"] = "woff2"): Partial<Record<"sans" | "serif" | "mono", [string, string]>> {
  const out: Partial<Record<"sans" | "serif" | "mono", [string, string]>> = {};
  for (const face of ["sans", "serif", "mono"] as const) {
    const rs = loadFontRecords(dir).filter((r) => r.face === face && r.format === format);
    const regular = rs.find((r) => r.weight === 400), bold = rs.find((r) => r.weight === 700);
    if (regular && bold) out[face] = [regular.file, bold.file];
  }
  return out;
}

/** The TrueType file for a face (regular or bold) as an absolute path, for FFmpeg drawtext and font measuring. */
export function faceTtf(face: "sans" | "serif" | "mono", bold = false, dir = FONTS_DIR): string | null {
  const f = faceFiles(dir, "ttf")[face];
  return f ? join(dir, f[bold ? 1 : 0]) : null;
}

/** Measures text in the sans face that is drawn (Inter) from its own file; with no shipped file it measures the machine font the renderer was given. */
export function sansMeter(machineFont: string, dir = FONTS_DIR): TextMeter {
  const file = faceTtf("sans", false, dir);
  return (file ? fontMeterFromBuffer(readFileSync(file)) : null) ?? loadFontMeter(machineFont);
}