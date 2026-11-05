import { describe, expect, it } from "vitest";
import { DemoClient, buildDirectorGraph, type GenerateRequest } from "./index.js";
import { approveCurrent } from "./index.js";
import { cfg, deps, input } from "./fixtures.js";

class Watching extends DemoClient {
  seen: Record<string, string> = {};
  override async generate<T>(req: GenerateRequest<T>): Promise<T> { this.seen[req.name] = req.user; return super.generate(req); }
}

describe("the temporary template picker's pick is a hint to the edit plan only", () => {
  const run = async (id: string, hints?: Record<string, string>) => {
    const llm = new Watching({ creative: true });
    const graph = buildDirectorGraph(deps(llm as never));
    const first = await graph.invoke(input as never, cfg(id));
    if (hints) await graph.updateState(cfg(id), { templateHints: hints });
    const second = await graph.invoke(approveCurrent(first), cfg(id));
    return { llm, first, second };
  };

  it("puts the pick in the edit-plan prompt, after the candidates and labelled a hint, and nowhere else", async () => {
    const { llm, second } = await run("t-hint", { S01: "text-fade-up" });
    expect(second.status).toBe("awaiting_approval");
    expect(second.gate).toBe("edit_plan"); // the gate is untouched
    expect(llm.seen["edit_plan"]).toContain("User template hints (a hint only");
    expect(llm.seen["edit_plan"]).toContain("text-fade-up");
    expect(llm.seen["storyboard"]).not.toContain("User template hints");
  });
  it("without a pick, the prompt has no hint section and the plans are the same", async () => {
    const a = await run("t-nohint");
    expect(a.llm.seen["edit_plan"]).not.toContain("User template hints");
    const b = await run("t-nohint-2", {});
    expect(b.llm.seen["edit_plan"]).not.toContain("User template hints");
    expect(JSON.stringify(b.second.editPlan?.uses)).toBe(JSON.stringify(a.second.editPlan?.uses));
    expect(b.first.scenePlan?.version).toBe(a.first.scenePlan?.version);
  });
});