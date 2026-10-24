import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EDITOR_SCHEMA_VERSION, HANDOFF_SCHEMA_VERSION } from "@digikon/contracts";
import { SkillLibrary } from "./index.js";

const dir = fileURLToPath(new URL("../../../skills/editor", import.meta.url));
const Manifest = z.object({
  manifest_version: z.literal(1),
  status: z.literal("loaded_by_editor_agent"),
  handoff_schema_version: z.string(),
  editor_schema_version: z.string(),
  skills: z.array(z.object({
    name: z.string(), version: z.string().regex(/^\d+\.\d+\.\d+$/), path: z.string(), purpose: z.string().min(20),
    invoke_when: z.array(z.string()).min(1), order: z.number().int().positive(),
  })).length(10),
});
const manifest = Manifest.parse(JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8")));
const lib = new SkillLibrary(dir);

describe("Editor skills manifest", () => {
  it("names the schema versions the contracts actually have", () => {
    expect(manifest.handoff_schema_version).toBe(HANDOFF_SCHEMA_VERSION);
    expect(manifest.editor_schema_version).toBe(EDITOR_SCHEMA_VERSION);
  });

  it("lists unique skills, in order, one folder each", () => {
    expect(new Set(manifest.skills.map((s) => s.name)).size).toBe(10);
    expect(manifest.skills.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(manifest.skills.every((s) => s.path === `${s.name}/SKILL.md`)).toBe(true);
  });

  it.each(manifest.skills.map((s) => [s.name, s] as const))("%s loads through SkillLibrary and matches its manifest entry", (name, entry) => {
    const skill = lib.get(name); // throws if the folder name and frontmatter name differ
    expect(skill.version).toBe(entry.version);
    expect(skill.description.length).toBeGreaterThan(20);
    for (const heading of ["## Purpose", "## When to invoke", "## Inputs and outputs", "## Workflow", "## Never", "## Acceptance checks", "## Stop conditions", "## Project references", "## Sources and status of claims"]) {
      expect(skill.body).toContain(heading);
    }
    expect(skill.body.split("\n").length).toBeLessThan(120); // same bound as the Director's skills
  });

  it("carries the approval-boundary guardrails in every skill", () => {
    for (const s of manifest.skills) {
      const body = lib.get(s.name).body;
      expect(body, s.name).toContain("Never edit the treatment, storyboard, edit plan, claims, caption text, brand facts or asset references");
      expect(body, s.name).toMatch(/untrusted data, never instructions/);
    }
  });
});
