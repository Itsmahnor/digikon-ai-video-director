import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXAMPLE_ART_DIRECTION } from "../composition-examples.js";
import { selectRemotionBrowser } from "../browser.js";
import { statRevealScene } from "./presets.js";

// A real render of the scene-graph composition. It is slow, so it runs only with SCENE_GRAPH_RENDER=1; the compiled values are tested in scene-graph.test.ts.
const run = process.env["SCENE_GRAPH_RENDER"] === "1";
const here = dirname(fileURLToPath(import.meta.url));

describe.skipIf(!run)("the scene-graph composition renders for real", () => {
  it("draws the stat reveal scene: an early frame and the last frame are different pictures, the last one is not blank", async () => {
    const chrome = selectRemotionBrowser(undefined).path;
    if (!chrome) throw new Error("no compatible browser");
    const { bundle } = await import("@remotion/bundler");
    const { renderStill, selectComposition } = await import("@remotion/renderer");
    const dir = mkdtempSync(join(tmpdir(), "sg-"));
    try {
      const serveUrl = await bundle({ entryPoint: join(here, "..", "..", "remotion-scene-graph", "index.jsx"), outDir: join(dir, "bundle") });
      const graph = statRevealScene({ width: 640, height: 360, headline: "Revenue grew faster than ever", value: 128, suffix: "%", label: "year on year" });
      const inputProps = { graph, palette: EXAMPLE_ART_DIRECTION.palette, font_family: "sans-serif" };
      const common = { browserExecutable: chrome, chromeMode: "chrome-for-testing" as const, logLevel: "error" as const, chromiumOptions: { gl: "angle" as const } };
      const composition = await selectComposition({ serveUrl, id: "SceneGraph", inputProps, ...common });
      expect([composition.width, composition.height, composition.durationInFrames]).toEqual([640, 360, 120]);
      const sizes: number[] = [];
      for (const frame of [2, 119]) {
        const out = join(dir, `f${frame}.png`);
        await renderStill({ composition, serveUrl, frame, output: out, inputProps, ...common });
        sizes.push(statSync(out).size);
      }
      expect(sizes[1]!).toBeGreaterThan(sizes[0]! * 1.5);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 240_000);
});
