import { describe, expect, it } from "vitest";
import { SkillLibrary, UNKNOWN_SKILL_VERSION, skillRef } from "./index.js";
import { root } from "./fixtures.js";

describe("skill references in the audit record and the handoff", () => {
  const skills = new SkillLibrary(root("skills"));
  it("a skill the library has is recorded with its real version", () => {
    const name = "video-director";
    expect(skillRef(skills, name)).toBe(`${name}@${skills.get(name).version}`);
    expect(skillRef(skills, name)).not.toContain(UNKNOWN_SKILL_VERSION);
  });
  it("a name the library does not have is recorded as unknown, never with an invented version", () => {
    for (const name of ["saas-product-demo", "ecom-unboxing", "no-such-skill"]) {
      const ref = skillRef(skills, name);
      expect(ref).toBe(`${name}@unknown`);
      expect(ref).not.toMatch(/@\d/); // no number that looks like a real version
    }
  });
});
