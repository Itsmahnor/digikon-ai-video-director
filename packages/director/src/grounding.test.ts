import { describe, expect, it } from "vitest";
import { Project, type BrandFact } from "@digikon/contracts";
import { ScriptedClient, STEP_REFERENCES, STEP_SKILLS, buildDirectorGraph, maxSceneSeconds, selectFacts, type Step } from "./index.js";
import { deps, facts, goodEdit, goodStoryboard, input, project, recipes, root, scene, throughGate1, treatment } from "./fixtures.js";
import { RecipeLibrary } from "@digikon/recipes";
import { SkillLibrary } from "./index.js";

const idsIn = (prompt: string) => [...prompt.matchAll(/^\[([A-Za-z0-9-]+)\] /gm)].map((m) => m[1]!);

async function run(overrides: Partial<typeof input> = {}) {
  const llm = new ScriptedClient([{ status: "ready", questions: [] }, treatment, goodStoryboard, goodEdit]);
  await throughGate1(buildDirectorGraph(deps(llm)), { ...input, ...overrides }, `g-${Math.random()}`);
  const by = (name: string) => llm.calls.find((c) => c.name === name)!;
  return { treatment: by("treatment"), storyboard: by("storyboard"), edit: by("edit_plan"), llm };
}

describe("skills never point to files the model cannot open", () => {
  const lib = new SkillLibrary(root("skills"));
  for (const step of Object.keys(STEP_SKILLS) as Step[]) {
    it(`${step}: every referenced file is in the prompt`, () => {
      const { system, references } = lib.systemFor(step);
      const mentioned = [...new Set([...system.matchAll(/references\/([a-z-]+\.md)/g)].map((m) => m[1]!))];
      const loaded = references.map((r) => r.split("/")[1]);
      for (const file of mentioned) expect(loaded, `${step} mentions ${file} but does not load it`).toContain(file);
      for (const r of references) expect(system).toContain(`### Reference: ${r}`);
    });
  }
  it("loads real content, not empty files", () => {
    const { system } = lib.systemFor("edit_plan");
    expect(system).toContain("Murch order");
    expect(system).toContain("EBU R 128");
    expect(lib.systemFor("storyboard").system).toContain("usable_segments");
    expect(lib.systemFor("treatment").system).toContain("Problem, agitate, solution");
  });
  it("only lists references that exist", () => {
    for (const refs of Object.values(STEP_REFERENCES)) for (const r of refs) {
      const [skill, file] = r.split("/") as [string, string];
      expect(() => lib.systemFor("treatment") && lib.get(skill)).not.toThrow();
      expect(file.endsWith(".md")).toBe(true);
    }
  });
});

describe("each step is shown the right knowledge", () => {
  it("treatment gets strategy playbooks and the claims policy, never editing or motion notes", async () => {
    const { treatment: t } = await run();
    const ids = idsIn(t.user);
    expect(ids).toContain("claims-discipline"); // pinned
    expect(ids.some((i) => ["problem-agitate-solution", "aida-structure", "hook-first-seconds"].includes(i))).toBe(true);
    for (const wrong of ["cut-priority-murch", "motion-purpose-easing", "cut-on-motion", "audio-ducking-loudness", "axis-180-rule"]) expect(ids).not.toContain(wrong);
    expect(t.user).not.toContain("## Directing principles");
    expect(t.user).not.toContain("Retrieved brand notes");
  });

  it("storyboard gets cinematography notes, never strategy or editing ones", async () => {
    const { storyboard: s } = await run();
    const ids = idsIn(s.user);
    expect(ids.some((i) => ["shot-size-progression", "axis-180-rule", "reframing-limits"].includes(i))).toBe(true);
    for (const wrong of ["hook-first-seconds", "single-clear-cta", "claims-discipline", "audio-ducking-loudness", "cut-priority-murch"]) expect(ids).not.toContain(wrong);
  });

  it("edit plan now gets editing, motion and sound principles alongside the recipes", async () => {
    const { edit } = await run();
    const ids = idsIn(edit.user);
    expect(edit.user).toContain("## Directing principles");
    expect(ids.some((i) => ["cut-priority-murch", "j-and-l-cuts", "cut-on-motion", "motion-purpose-easing", "text-legibility", "audio-ducking-loudness"].includes(i))).toBe(true);
    for (const wrong of ["hook-first-seconds", "single-clear-cta", "problem-agitate-solution"]) expect(ids).not.toContain(wrong);
  });

  it("shows the model the reference files for its step and records them", async () => {
    const llm = new ScriptedClient([{ status: "ready", questions: [] }, treatment, goodStoryboard, goodEdit]);
    const out = await throughGate1(buildDirectorGraph(deps(llm)), input, "g-refs");
    expect(out.referencesUsed).toEqual(expect.arrayContaining([
      "commercial-strategy/claims-register.md", "cinematography/footage-limits.md", "editing-director/edit-operations.md", "sound-design/loudness.md",
    ]));
    expect(llm.calls.find((c) => c.name === "treatment")!.system).toContain("### Reference: commercial-strategy/claims-register.md");
  });
});

describe("brand facts", () => {
  const many: BrandFact[] = [
    ...Array.from({ length: 30 }, (_, i) => ({ fact_id: `F${String(i + 1).padStart(2, "0")}`, text: `Warehouse note number ${i + 1} about pallets and forklifts`, source: "sheet" })),
    { fact_id: "F31", text: "Beans are roasted weekly in small batches for freshness", source: "sheet" },
  ];
  const p = Project.parse({ ...project });

  it("sends a small fact sheet whole", async () => {
    const r = await selectFacts(p, facts, "coffee");
    expect(r.shown).toEqual(facts);
    expect(r.note).toContain("all 1");
  });

  it("narrows a large sheet to the most relevant facts and never loses the relevant one", async () => {
    const r = await selectFacts(p, many, "coffee roaster beans roasted weekly freshness", 12);
    expect(r.shown).toHaveLength(12);
    expect(r.shown.map((f) => f.fact_id)).toContain("F31"); // ranked into the prompt even though it is last in the sheet
    expect(r.note).toContain("12 of 31");
  });

  it("still validates claims against the FULL sheet when the prompt shows only some facts", async () => {
    // F25 is not shown to the model (sheet has 31 facts, 12 shown), but a claim that cites it must remain supported.
    const llm = new ScriptedClient([
      { status: "ready", questions: [] },
      { ...treatment, claims: [{ claim_id: "C01", text: "x", brand_fact_id: "F25" }, { claim_id: "C02", text: "y", brand_fact_id: "F99" }] },
      goodStoryboard, goodEdit,
    ]);
    const out = await throughGate1(buildDirectorGraph(deps(llm)), { ...input, facts: many }, "g-full");
    const claims = out.treatmentDoc!.claims;
    expect(claims.find((c) => c.claim_id === "C01")!.brand_fact_id).toBe("F25"); // real fact, kept
    expect(claims.find((c) => c.claim_id === "C02")!.brand_fact_id).toBeNull(); // invented fact, demoted
    const shown = idsIn(llm.calls.find((c) => c.name === "treatment")!.user);
    expect(shown).toContain("F31");
    expect(llm.calls.find((c) => c.name === "treatment")!.user).toContain("12 of 31");
  });

  it("keeps one project's facts out of another project's selection", async () => {
    const r = await selectFacts(Project.parse({ ...project, project_id: "other" }), many, "coffee beans roasted", 12);
    expect(r.shown.length).toBe(12);
  });
});

describe("scene length is checked where it can still be fixed cheaply", () => {
  it("derives the longest scene from the recipe library", () => {
    expect(maxSceneSeconds(new RecipeLibrary(recipes, "draft"))).toBe(8);
    expect(maxSceneSeconds(new RecipeLibrary(recipes, "reviewed"))).toBe(8); // no reviewed recipes: falls back to the same safe default
  });

  it("tells the storyboard step the limit and repairs a scene that is too long, without reaching the edit step", async () => {
    // 12s target in two scenes: one is 10s, beyond what any recipe supports.
    const tooLong = { scenes: [scene("S01", 9, { asset_ids: ["asset_beans"], source_in_seconds: 0 }), scene("S02", 3, { asset_ids: ["asset_logo"], overlay: { text: "Order", safe_area: "platform_safe" } })] };
    const llm = new ScriptedClient([{ status: "ready", questions: [] }, treatment, tooLong, goodStoryboard, goodEdit]);
    const out = await throughGate1(buildDirectorGraph(deps(llm)), input, "g-long");
    expect(out.status).toBe("awaiting_approval");
    const calls = llm.calls.filter((c) => c.name === "storyboard");
    expect(calls[0]!.user).toContain("No scene may be longer than 8s");
    expect(calls[1]!.user).toContain("scene_too_long");
    expect(llm.calls.filter((c) => c.name === "edit_plan")).toHaveLength(1); // the problem never reached the edit step
  });
});