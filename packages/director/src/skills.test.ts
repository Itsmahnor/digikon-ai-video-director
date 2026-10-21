import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STEP_SKILLS, SkillLibrary, loadReference } from "./index.js";

const dir = fileURLToPath(new URL("../../../skills", import.meta.url));
const SEVEN = ["video-director", "commercial-strategy", "cinematography", "editing-director", "motion-graphics", "sound-design", "video-qa"];

describe("skill files", () => {
  const lib = new SkillLibrary(dir);
  it.each(SEVEN)("%s loads, is versioned and has evals", (name) => {
    const s = lib.get(name);
    expect(s.description.length).toBeGreaterThan(20);
    expect(s.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(s.body).toContain("## Never");
    expect(existsSync(join(dir, name, "evals", "cases.md"))).toBe(true);
    expect(s.body.split("\n").length).toBeLessThan(120); // skills stay short; detail lives in references/
  });
  it("loads a reference on request", () => {
    expect(loadReference(lib.get("video-qa"), "rubric.md")).toContain("Product fidelity");
  });
  it("routes only the skills named for each step, and never loads video-qa at plan time", () => {
    const all = Object.values(STEP_SKILLS).flat();
    expect(all).not.toContain("video-qa");
    const { skills } = lib.systemFor("edit_plan");
    expect(skills).toEqual(["video-director", "editing-director", "motion-graphics", "sound-design"]);
    expect(lib.systemFor("treatment").system).not.toContain("# sound-design");
  });
});
