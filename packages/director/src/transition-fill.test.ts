import { describe, expect, it } from "vitest";
import { Project, ScenePlan } from "@digikon/contracts";
import type { Hit, Retriever } from "@digikon/rag";
import { ScriptedClient, approveCurrent, buildDirectorGraph, candidateRecipes } from "./index.js";
import { cfg, deps, goodEdit, goodStoryboard, input, project, scene, treatment, use } from "./fixtures.js";

// A storyboard that ends scene S02 with a wipe (S01 crossfades, as in the shared fixture).
const withWipe = { scenes: goodStoryboard.scenes.map((s) => (s.scene_id === "S02" ? { ...s, transition_out: "wipe" } : s)) };
// What a model does when it forgets the wipe: every other use, no directional-wipe.
const forgetful = { uses: goodEdit.uses };
const gate1Answers = [{ status: "ready", questions: [] }, treatment, withWipe];

describe("a transition the storyboard asks for is never left out of the edit plan", () => {
  it("the model forgets the wipe: the code adds the directional-wipe use with its default settings, and the plan reaches Gate 2", async () => {
    const llm = new ScriptedClient([...gate1Answers, forgetful]);
    const graph = buildDirectorGraph(deps(llm));
    const gate1 = await graph.invoke(input, cfg("tf-fill"));
    expect(gate1.status).toBe("awaiting_approval");
    const gate2 = await graph.invoke(approveCurrent(gate1), cfg("tf-fill"));
    expect(gate2.status).toBe("awaiting_approval");
    expect(gate2.gate).toBe("edit_plan");
    const wipe = gate2.editPlan!.uses.find((u) => u.recipe_id === "directional-wipe");
    expect(wipe).toMatchObject({ scene_id: "S02", params: {} });
    expect(wipe!.rationale).toContain("Added by the system");
    expect(llm.calls.filter((c) => c.name === "edit_plan")).toHaveLength(1); // no repair round was needed
  });

  it("a wipe the model did add is left alone, and the per-film limit of the recipe is respected", async () => {
    const present = { uses: [...goodEdit.uses, use(6, "S02", "directional-wipe", { direction: "right", duration_s: 0.4 })] };
    const llm = new ScriptedClient([...gate1Answers, present]);
    const graph = buildDirectorGraph(deps(llm));
    const gate2 = await graph.invoke(approveCurrent(await graph.invoke(input, cfg("tf-keep"))), cfg("tf-keep"));
    const wipes = gate2.editPlan!.uses.filter((u) => u.recipe_id === "directional-wipe");
    expect(wipes).toHaveLength(1);
    expect(wipes[0]!.params).toEqual({ direction: "right", duration_s: 0.4 });
  });

  it("the recipe is offered as a candidate even when the search by the scene's text does not return it", async () => {
    const nothing: Retriever = { retrieve: async (): Promise<Hit[]> => [], get: async () => null };
    const d = { ...deps(new ScriptedClient([])), retriever: nothing };
    const plan = ScenePlan.parse({ project_id: project.project_id, version: 1, scenes: withWipe.scenes.map((s, i, all) => ({ ...s, start_time: all.slice(0, i).reduce((t, x) => t + x.duration_seconds, 0), end_time: all.slice(0, i + 1).reduce((t, x) => t + x.duration_seconds, 0), production_method: null })) });
    const ids = (await candidateRecipes(d, Project.parse(project), [], plan)).map((r) => r.recipe_id);
    expect(ids).toContain("directional-wipe"); // S02 ends with a wipe
    expect(ids).toContain("crossfade"); // S01 ends with a crossfade
    expect(ids).not.toContain("dip-to-black"); // nothing asks for it
  });
});

void scene;
