import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtDirection, Composition } from "@digikon/contracts";
import type { z } from "zod";
import { selectRemotionBrowser } from "./browser.js";
import { DEFAULT_PALETTE } from "./composition.js";
import { ESTIMATE_METER } from "./font-metrics.js";
import { authorGraph } from "./scene-graph/author.js";

/**
 * One still of each composed scene, drawn locally from the storyboard as the Director wrote it (no model, no network). It is what a person would look at before approving: the
 * fully arrived frame at the film's aspect ratio. It is for looking at layout, not a render of the film (fonts are a plain sans, fixed blocks are not drawn), and nothing here
 * touches an approval or a render record.
 */
const FRAMES = { "16:9": [960, 540], "9:16": [540, 960], "1:1": [720, 720] } as const;
const here = dirname(fileURLToPath(import.meta.url));

export interface StillRequest {
  scenes: readonly { scene_id: string; duration_seconds: number; visual: { block: string } | null }[];
  aspect_ratio: keyof typeof FRAMES;
  art_direction: ArtDirection | null;
}
export interface Still { scene_id: string; png: Buffer }
export interface StillsResult { stills: Still[]; skipped: { scene_id: string; why: string }[]; problem: string | null }

export async function renderComposedStills(req: StillRequest, o: { browser?: string | null } = {}): Promise<StillsResult> {
  const composed = req.scenes.filter((s) => s.visual?.block === "composition");
  const skipped = req.scenes.filter((s) => s.visual?.block !== "composition").map((s) => ({ scene_id: s.scene_id, why: "a fixed block, not a composition: not drawn here" }));
  if (!composed.length) return { stills: [], skipped, problem: null };
  const chrome = o.browser ?? selectRemotionBrowser(undefined).path;
  if (!chrome) return { stills: [], skipped, problem: "no compatible browser (set DIGIKON_CHROME_PATH)" };
  const dir = mkdtempSync(join(tmpdir(), "stills-"));
  try {
    const { bundle } = await import("@remotion/bundler");
    const { renderStill, selectComposition } = await import("@remotion/renderer");
    const serveUrl = await bundle({ entryPoint: join(here, "..", "remotion-scene-graph", "index.jsx"), outDir: join(dir, "bundle") });
    const [width, height] = FRAMES[req.aspect_ratio];
    const palette = req.art_direction?.palette ?? DEFAULT_PALETTE;
    const common = { browserExecutable: chrome, chromeMode: "chrome-for-testing" as const, logLevel: "error" as const, chromiumOptions: { gl: "angle" as const } };
    const stills: Still[] = [];
    for (const s of composed) {
      const graph = authorGraph(s.visual as unknown as z.infer<typeof Composition>, { width, height, fps: 30, duration_s: s.duration_seconds, meter: ESTIMATE_METER });
      const inputProps = { graph, palette, font_family: "sans-serif" };
      const composition = await selectComposition({ serveUrl, id: "SceneGraph", inputProps, ...common });
      const out = join(dir, `${s.scene_id}.png`);
      await renderStill({ composition, serveUrl, frame: Math.max(0, composition.durationInFrames - 2), output: out, inputProps, ...common });
      stills.push({ scene_id: s.scene_id, png: readFileSync(out) });
    }
    return { stills, skipped, problem: null };
  } catch (e) {
    return { stills: [], skipped, problem: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
