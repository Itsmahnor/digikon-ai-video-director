import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { faceTtf } from "./fonts.js";

export const FACES = ["sans", "serif", "mono"] as const;
const FAMILY = { sans: "DigikonSans", serif: "DigikonSerif", mono: "DigikonMono" } as const;

/** Puts one TrueType file per typeface (and a bold one) beside a render, as font-<face>.ttf and font-<face>-bold.ttf; a face with no file falls back to the machine font. */
export async function copyFaceFonts(dir: string, fallback: string): Promise<void> {
  for (const face of FACES) {
    await copyFile(faceTtf(face) ?? fallback, join(dir, `font-${face}.ttf`));
    await copyFile(faceTtf(face, true) ?? fallback, join(dir, `font-${face}-bold.ttf`));
  }
}

/** @font-face rules for the three faces, for the HTML-based stages (Inter is one variable file, so its weight is a range). */
export const FACE_CSS = FACES.map((f) => f === "sans"
  ? `@font-face{font-family:${FAMILY.sans};src:url(font-sans.ttf);font-weight:100 900}`
  : `@font-face{font-family:${FAMILY[f]};src:url(font-${f}.ttf);font-weight:400}@font-face{font-family:${FAMILY[f]};src:url(font-${f}-bold.ttf);font-weight:700}`).join("\n");

/** One rule per face: a scene is drawn in the face its visual system chose. */
export const FACE_RULES = FACES.map((f) => `.face-${f}{font-family:${FAMILY[f]},DigikonStage,sans-serif}`).join("\n");