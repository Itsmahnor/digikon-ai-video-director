import { describe, expect, it } from "vitest";
import { ScriptedClient, buildDirectorGraph } from "./index.js";
import { deps, goodEdit, goodStoryboard, input, throughGate1, treatment } from "./fixtures.js";

const hit = { template_id: "hook-x", title: "Bold stat hook", category: "hook", family: "stat", note: "high energy. Big number slams in" };

describe("template inspiration in the storyboard prompt", () => {
  it("shows retrieved templates as data when a template search is supplied", async () => {
    const llm = new ScriptedClient([{ status: "ready", questions: [] }, treatment, goodStoryboard, goodEdit]);
    let asked: { text: string; k: number } | null = null;
    await throughGate1(buildDirectorGraph({ ...deps(llm), templates: async (q) => { asked = q; return [hit]; } }), input, `ti-${Math.random()}`);
    const user = llm.calls.find((c) => c.name === "storyboard")!.user;
    expect(user).toContain("Template inspiration");
    expect(user).toContain("Bold stat hook");
    expect(asked!.k).toBe(5);
  });

  it("is left out when there is no search, and a failing search never blocks the storyboard", async () => {
    for (const templates of [undefined, async () => { throw new Error("db down"); }]) {
      const llm = new ScriptedClient([{ status: "ready", questions: [] }, treatment, goodStoryboard, goodEdit]);
      await throughGate1(buildDirectorGraph({ ...deps(llm), ...(templates ? { templates } : {}) }), input, `ti-${Math.random()}`);
      expect(llm.calls.find((c) => c.name === "storyboard")!.user).not.toContain("Template inspiration");
    }
  });
});
