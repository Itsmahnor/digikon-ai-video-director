import { describe, expect, it } from "vitest";
import { ScriptedClient, buildDirectorGraph } from "./index.js";
import { deps, goodEdit, goodStoryboard, input, throughGate1, treatment } from "./fixtures.js";

describe("unsupplied footage and music are not listed as production blockers when graphics will do", () => {
  it("the storyboard prompt tells the model to plan the graphics treatment, and to plan no music, unless the brief insists", async () => {
    const llm = new ScriptedClient([{ status: "ready", questions: [] }, treatment, goodStoryboard, goodEdit]);
    await throughGate1(buildDirectorGraph(deps(llm)), input, `sp-${Math.random()}`);
    const user = llm.calls.find((c) => c.name === "storyboard")!.user;
    expect(user).toContain("it blocks production until the user supplies it");
    expect(user).toContain("plan the graphics treatment itself");
    expect(user).toContain("plan no music or sound unless the brief asks for it");
  });
});
