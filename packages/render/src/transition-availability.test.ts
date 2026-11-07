import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unavailableTransitionIssues } from "@digikon/director";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import { CapabilityRegistry, buildAdapterRegistry, implementationsOf, loadCapabilityRegistry, loadVisualCapabilities } from "./index.js";

// The failure this guards against: a storyboard asked for a wipe, but the wipe's validation record was out of date with the code, so the edit plan could not use it and the run
// stopped at Gate 2 with "no directional-wipe recipe use exists". The storyboard step now refuses a transition the live registry cannot carry out, while it can still change it.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f));
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const recipes = new RecipeLibrary(loadRecipes(join(repo, "recipes")), "draft");

const live = (capabilitiesDir: string) => {
  const built = buildAdapterRegistry({ ffmpegOk: true, fontFile: font!, outputRoot: tmpdir(), capabilitiesDir, recipes });
  const registry = CapabilityRegistry.from({ recipes: recipes.all(), learned: loadCapabilityRegistry(capabilitiesDir, { recipes }), visual: loadVisualCapabilities(capabilitiesDir), implementations: implementationsOf(built.registry), adapter_failures: built.failures });
  return { production: { capabilities: () => ({ snapshot: registry.snapshot, available_engines: built.registry.renderers() }) } };
};
const scene = (id: string, out: string) => ({ scene_id: id, asset_ids: [] as string[], duration_seconds: 5, transition_out: out });
const plan = { scenes: [scene("S01", "cut"), scene("S02", "wipe"), scene("S03", "crossfade"), scene("S04", "cut")] } as never;

describe.skipIf(!hasFfmpeg || !font)("a transition the live registry cannot carry out is caught at the storyboard", () => {
  it("with the shipped, up-to-date records, a wipe and a crossfade pass", () => {
    const issues = unavailableTransitionIssues(live(join(repo, "capabilities")) as never, { aspect_ratio: "9:16" }, [], plan);
    expect(issues.filter((i) => /wipe/.test(i))).toEqual([]);
  });

  it("with no validation record for the wipe, the storyboard is told the wipe cannot be carried out, and what to use instead", () => {
    const empty = mkdtempSync(join(tmpdir(), "caps-"));
    try {
      const issues = unavailableTransitionIssues(live(empty) as never, { aspect_ratio: "9:16" }, [], plan);
      expect(issues).toEqual(expect.arrayContaining([expect.stringContaining("S02: transition_unavailable - a wipe cannot be carried out here right now")]));
      expect(issues.join(" ")).toContain("end the scene with a cut or a crossfade instead");
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });

  it("without production intelligence nothing is checked", () => {
    expect(unavailableTransitionIssues({} as never, { aspect_ratio: "9:16" }, [], plan)).toEqual([]);
  });
});
