import { BLOCK_FAMILY, contrastRatio, type ArtDirection, type SceneVisual } from "@digikon/contracts";

/**
 * Compares films on the eight things a viewer would call their design, from their approved plans. It measures difference, not quality: two different films can both be poor, and this is
 * why it is read together with rendered frames. Nothing here rewards using many templates: a film is compared with other films, and never scored for variety inside itself.
 */

export interface FilmPlan {
  id: string;
  category: string;
  art: ArtDirection | null;
  scenes: readonly { visual: SceneVisual | null; transition_out: string; duration_seconds: number; shot?: { camera_motion?: string } }[];
}

export const DIMENSIONS = ["creative_strategy", "storyboard_structure", "selected_templates", "scene_composition", "typography", "motion_design", "transitions", "visual_identity"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const jaccardDistance = <T,>(a: readonly T[], b: readonly T[]): number => {
  const x = new Set(a), y = new Set(b), both = [...x].filter((v) => y.has(v)).length, any = new Set([...x, ...y]).size;
  return any ? 1 - both / any : 0;
};
const words = (t: string) => (t.toLowerCase().match(/[a-z]{5,}/g) ?? []);
const blocks = (f: FilmPlan) => f.scenes.map((s) => s.visual?.block ?? "none");
const families = (f: FilmPlan) => blocks(f).map((b) => (b === "none" ? "none" : BLOCK_FAMILY[b]));
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** How far apart two sequences are, as a share of the longer: the order of a film's kinds of picture is its structure. */
function sequenceDistance(a: readonly string[], b: readonly string[]): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return Math.max(a.length, b.length) ? d[a.length]![b.length]! / Math.max(a.length, b.length) : 0;
}

const FACE_OF: Record<string, string> = { atelier: "serif", cinema: "serif", runway: "serif", voyage: "serif", manifesto: "serif", launch_pulse: "mono", product_bench: "mono" };
const faceOf = (art: ArtDirection | null) => art?.typography.face ?? (art?.visual_system ? FACE_OF[art.visual_system] ?? "sans" : "sans");

/** 0 means the same on that dimension, 1 means nothing in common. */
export function compareFilms(a: FilmPlan, b: FilmPlan): Record<Dimension, number> {
  const pa = a.art?.palette, pb = b.art?.palette;
  // the difference of two palettes, as how differently their background and accent read
  const colour = pa && pb ? Math.min(1, (1 - 1 / contrastRatio(pa.background, pb.background)) * 0.6 + (1 - 1 / contrastRatio(pa.accent, pb.accent)) * 0.4 + 0.15 * Number(pa.background.toLowerCase() !== pb.background.toLowerCase())) : 0;
  const type = (x: FilmPlan) => [faceOf(x.art), x.art?.typography.weight ?? "-", x.art?.typography.case ?? "-", x.art?.typography.scale ?? "-"];
  const motion = (x: FilmPlan) => [`feel:${x.art?.motion_language.feel}`, `ease:${x.art?.motion_language.easing}`, ...x.scenes.flatMap((s) => (s.visual ? [`cam:${s.visual.camera}`, `rev:${s.visual.reveal}`] : []))];
  const pace = (x: FilmPlan) => mean(x.scenes.map((s) => s.duration_seconds));
  const strategy = 0.6 * Number((a.art?.visual_system ?? "-") !== (b.art?.visual_system ?? "-")) + 0.4 * jaccardDistance(words(a.art?.concept ?? ""), words(b.art?.concept ?? ""));
  const paceGap = Math.min(1, Math.abs(pace(a) - pace(b)) / Math.max(pace(a), pace(b), 0.01));
  return {
    creative_strategy: strategy,
    storyboard_structure: 0.7 * sequenceDistance(families(a), families(b)) + 0.3 * paceGap,
    selected_templates: jaccardDistance(blocks(a), blocks(b)),
    scene_composition: jaccardDistance(families(a), families(b)) * 0.6 + 0.4 * jaccardDistance(a.scenes.map((s) => s.visual?.backdrop ?? "-"), b.scenes.map((s) => s.visual?.backdrop ?? "-")),
    typography: jaccardDistance(type(a), type(b)),
    motion_design: jaccardDistance(motion(a), motion(b)),
    transitions: jaccardDistance(a.scenes.slice(0, -1).map((s) => s.transition_out), b.scenes.slice(0, -1).map((s) => s.transition_out)),
    visual_identity: colour,
  };
}

/** Two films count as different in kind above this mean distance. A judgement set against the old films, which score far below it; it is reported beside the frames, never alone. */
export const DIFFERENT = 0.5;
/** Two films for one kind of brief need less: they share a purpose, so they should share more. */
export const DIFFERENT_TREATMENT = 0.3;

export interface PairResult { a: string; b: string; same_category: boolean; distance: number; dimensions: Record<Dimension, number>; verdict: "different" | "same_design" }
export interface DiversityReport {
  films: number;
  pairs: PairResult[];
  mean_distance: number;
  across_categories: { mean: number; different: number; total: number };
  within_category: { mean: number; different: number; total: number };
  /** The mean distance on each dimension, across all pairs: which of the eight really vary. */
  by_dimension: Record<Dimension, number>;
  opening_blocks: Record<string, number>;
  closing_blocks: Record<string, number>;
  systems: Record<string, number>;
}

const tally = (xs: readonly string[]) => { const m: Record<string, number> = {}; for (const x of xs) m[x] = (m[x] ?? 0) + 1; return m; };

export function diversityReport(films: readonly FilmPlan[]): DiversityReport {
  const pairs: PairResult[] = [];
  for (let i = 0; i < films.length; i++) for (let j = i + 1; j < films.length; j++) {
    const a = films[i]!, b = films[j]!, dimensions = compareFilms(a, b);
    const distance = mean(DIMENSIONS.map((d) => dimensions[d]));
    const same_category = a.category === b.category;
    pairs.push({ a: a.id, b: b.id, same_category, distance, dimensions, verdict: distance >= (same_category ? DIFFERENT_TREATMENT : DIFFERENT) ? "different" : "same_design" });
  }
  const group = (xs: PairResult[]) => ({ mean: mean(xs.map((p) => p.distance)), different: xs.filter((p) => p.verdict === "different").length, total: xs.length });
  return {
    films: films.length, pairs, mean_distance: mean(pairs.map((p) => p.distance)),
    across_categories: group(pairs.filter((p) => !p.same_category)), within_category: group(pairs.filter((p) => p.same_category)),
    by_dimension: Object.fromEntries(DIMENSIONS.map((d) => [d, mean(pairs.map((p) => p.dimensions[d]))])) as Record<Dimension, number>,
    opening_blocks: tally(films.map((f) => blocks(f)[0] ?? "none")), closing_blocks: tally(films.map((f) => blocks(f)[f.scenes.length - 1] ?? "none")),
    systems: tally(films.map((f) => f.art?.visual_system ?? "none")),
  };
}
