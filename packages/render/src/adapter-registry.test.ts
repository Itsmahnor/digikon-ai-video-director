import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RecipeLibrary } from "../../recipes/src/library.js";
import { recipes, root } from "../../director/src/fixtures.js";
import { AdapterRegistry, NO_ADAPTERS, buildAdapterRegistry, createFfmpegAdapter, createHyperframesStageAdapter, createRemotionAdapter, loadCapabilityRegistry, type RenderAdapter } from "./index.js";

const FONT = "C:/Windows/Fonts/arial.ttf";
const haveFont = existsSync(FONT);
const capabilitiesDir = join(root(""), "capabilities");
const library = new RecipeLibrary(recipes, "draft");

/** The console's `registryFor` as it was before `buildAdapterRegistry` replaced its body, kept here so the move is checked, not trusted. */
function previousRegistryFor(ctx: { ffmpegOk: boolean; renderFont: string | null }, out: string) {
  if (!ctx.ffmpegOk || !ctx.renderFont) return { registry: NO_ADAPTERS, available: false };
  const adapters: RenderAdapter[] = [];
  const reg = loadCapabilityRegistry(capabilitiesDir, { recipes: library });
  const learned = reg.transitions("ffmpeg"), remotionLearned = reg.composed("remotion"), hyperframesLearned = reg.composed("hyperframes");
  for (const make of [(o: { fontFile: string; outputRoot: string }) => createFfmpegAdapter({ ...o, learned }), (o: { fontFile: string; outputRoot: string }) => createRemotionAdapter({ ...o, learned: remotionLearned }), (o: { fontFile: string; outputRoot: string }) => createHyperframesStageAdapter({ ...o, learned: hyperframesLearned })]) { try { adapters.push(make({ fontFile: ctx.renderFont, outputRoot: out })); } catch { /* not available here */ } }
  return adapters.length ? { registry: new AdapterRegistry(adapters), available: true } : { registry: NO_ADAPTERS, available: false };
}

describe("buildAdapterRegistry is the console's registryFor, moved", () => {
  const cases: [string, boolean, string | null][] = [["FFmpeg and a font present", true, FONT], ["no font", true, null], ["FFmpeg missing", false, FONT]];
  for (const [label, ok, font] of cases) {
    it.skipIf(font === FONT && !haveFont)(`builds the same adapters: ${label}`, () => {
      const before = previousRegistryFor({ ffmpegOk: ok, renderFont: font }, tmpdir());
      const after = buildAdapterRegistry({ ffmpegOk: ok, fontFile: font, outputRoot: tmpdir(), capabilitiesDir, recipes: library });
      expect(after.available).toBe(before.available);
      expect(after.registry.templateRefs().sort()).toEqual(before.registry.templateRefs().sort());
      expect(after.registry.renderers().sort()).toEqual(before.registry.renderers().sort());
      for (const ref of before.registry.templateRefs()) expect(after.registry.adapterFor(ref)!.templates[ref]).toEqual(before.registry.adapterFor(ref)!.templates[ref]);
    });
  }
  it("names why an engine is missing instead of dropping it silently", () => {
    const r = buildAdapterRegistry({ ffmpegOk: false, fontFile: FONT, outputRoot: tmpdir(), capabilitiesDir, recipes: library });
    expect(r.failures.map((f) => f.engine)).toEqual(["ffmpeg", "remotion", "hyperframes"]);
    expect(r.failures.every((f) => f.reason.length > 0)).toBe(true);
  });
});
