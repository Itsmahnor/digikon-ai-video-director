import { VISUAL_SYSTEMS, type ArtDirection, type Composition, type Palette, type TypeFace } from "@digikon/contracts";
import type { z } from "zod";
import { ESTIMATE_METER, type TextMeter } from "../font-metrics.js";
import { DEFAULT_PALETTE } from "../composition.js";
import { authorGraph } from "./author.js";
import { validateSceneGraph } from "./validate.js";

/**
 * The storyboard-time check of a composition: it is drawn at a representative frame of the project's aspect ratio and run through the same scene-graph validator the render uses
 * (bounds, legibility, timing, overlap, hold time), so a layout that cannot be drawn is sent back to the Director before Gate 1, with the reasons, and never first discovered at render.
 * Widths are measured generously (the real font is narrower), so a layout that passes here also passes at render.
 */
const FRAMES = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [900, 900] } as const;
const meterFor = (face: TypeFace): TextMeter => (face === "mono" ? { kind: "estimate", width: (t, px) => Array.from(t).length * px * 0.61 } : ESTIMATE_METER);

export function checkComposition(visual: z.infer<typeof Composition>, o: { art_direction: ArtDirection | null; aspect_ratio: keyof typeof FRAMES; duration_seconds: number; fps?: number }): string[] {
  const [width, height] = FRAMES[o.aspect_ratio];
  const palette: Palette = o.art_direction?.palette ?? DEFAULT_PALETTE;
  const system = o.art_direction?.visual_system ? VISUAL_SYSTEMS[o.art_direction.visual_system] : null;
  const face: TypeFace = o.art_direction?.typography.face ?? system?.face ?? "sans";
  const graph = authorGraph(visual, { width, height, fps: o.fps ?? 30, duration_s: o.duration_seconds });
  const verdict = validateSceneGraph(graph, { palette, meter: meterFor(face) });
  return verdict.ok ? [] : verdict.issues;
}