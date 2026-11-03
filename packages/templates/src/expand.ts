import { createHash } from "node:crypto";
import { AXES, BACKDROPS, CAMERAS, MOTIONS, PAIRINGS, PALETTES, axisValue, styleOf, type Axis, type FamilyDef, type Style } from "./kit.js";

/**
 * Deterministic variant expansion. A family declares which style axes it can vary; the expander walks a seeded sequence (seeded by the family id, so
 * the same family always yields the same candidates) and changes one to three axes at a time from the base style. It generates candidates only:
 * whether a candidate becomes a template is decided later by validation and by the dedupe thresholds.
 */

export const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const seedOf = (s: string) => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16);

const VALUES: Record<Axis, (s: Style) => Partial<Style>[]> = {
  palette: () => PALETTES.map((palette) => ({ palette })),
  pairing: () => PAIRINGS.map((pairing) => ({ pairing })),
  motion: () => MOTIONS.map((motion) => ({ motion })),
  align: () => (["left", "center", "right"] as const).map((align) => ({ align })),
  flip: () => [{ flip: false }, { flip: true }],
  backdrop: () => BACKDROPS.map((backdrop) => ({ backdrop })),
  stagger: () => (["line", "word", "char"] as const).map((stagger) => ({ stagger })),
  camera: () => CAMERAS.map((camera) => ({ camera })),
};

export const styleKey = (s: Style): string => AXES.map((a) => axisValue(s, a)).join("|");

/** Up to `count` distinct styles other than the base, each differing from it in one to three of the family's axes. */
export function candidateStyles(fam: FamilyDef, count: number): Style[] {
  const base = styleOf(fam), rnd = mulberry32(seedOf(fam.id));
  const seen = new Set([styleKey(base)]), out: Style[] = [];
  const axes = [...fam.axes];
  for (let tries = 0; out.length < count && tries < count * 60; tries++) {
    const k = rnd() < 0.5 ? 1 : rnd() < 0.7 ? 2 : 3;
    const chosen = [...axes].sort(() => rnd() - 0.5).slice(0, Math.min(k, axes.length));
    let s = { ...base };
    for (const a of chosen) {
      const options = VALUES[a](base).filter((o) => axisValue({ ...base, ...o }, a) !== axisValue(base, a));
      if (options.length) s = { ...s, ...options[Math.floor(rnd() * options.length)]! };
    }
    const key = styleKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
