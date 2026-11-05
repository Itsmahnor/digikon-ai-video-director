import type { z } from "zod";
import { compositionStructureIssues, type Composition } from "./visual.js";

/**
 * Evidence grounding of a composed scene. A composition is free layout, so the guard is on what it says: every word it draws must come from text the reviewer can see and
 * has approved or supplied (the scene's overlay text and voiceover, its claims, the brand facts, the brief, the treatment's own lines), every figure must appear in that text.
 * A model cannot slip a new claim, price or product into a layout.
 */
export interface GroundingContext {
  overlay: string | null;
  voiceover: string | null;
  /** The texts of the claims this scene is tied to. */
  claims: readonly string[];
  /** The approved brand facts. */
  facts: readonly string[];
  brief: string;
  /** The treatment's own lines (logline, hook, call to action). */
  treatment: readonly string[];
}

const words = (s: string): string[] => s.toLowerCase().replace(/[^\p{L}\p{N}%$.,']+/gu, " ").replace(/[.,'](?=\s|$)|(?<=\s)[.,']/g, " ").split(/\s+/).filter(Boolean);
const joined = (s: string) => ` ${words(s).join(" ")} `;
const numbers = (s: string) => (s.match(/\d[\d.,]*/g) ?? []).map((n) => n.replace(/[.,]+$/, ""));
/** Up to this many words may be assembled from the sources' own words (a label or a stacked headline); longer text must be a contiguous run of one source. */
const MAX_ASSEMBLED_WORDS = 6;

export function compositionGroundingIssues(comp: z.infer<typeof Composition>, ctx: GroundingContext): string[] {
  const out = [...compositionStructureIssues(comp)];
  const sources = [ctx.overlay, ctx.voiceover, ...ctx.claims, ...ctx.facts, ctx.brief, ...ctx.treatment].filter((s): s is string => !!s && s.trim().length > 0);
  const hay = sources.map(joined);
  const vocab = new Set(sources.flatMap(words));
  const figures = new Set(sources.flatMap(numbers));
  for (const e of comp.elements) {
    if (e.kind !== "text") continue;
    const w = words(e.text);
    if (!w.length) continue;
    const contiguous = hay.some((h) => h.includes(` ${w.join(" ")} `));
    const assembled = w.length <= MAX_ASSEMBLED_WORDS && w.every((x) => vocab.has(x));
    if (!contiguous && !assembled) out.push(`${e.id}: "${e.text.length > 40 ? `${e.text.slice(0, 39)}...` : e.text}" is not in the scene's approved text, claims, facts or brief; use the scene's own words, or put the line into the overlay text or voiceover so it is approved`);
    for (const n of numbers(e.text)) if (!figures.has(n)) out.push(`${e.id}: the figure ${n} does not appear in the scene's approved text, claims or facts; a figure may only be shown if it does`);
  }
  return out;
}