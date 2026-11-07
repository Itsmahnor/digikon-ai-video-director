import { describe, expect, it } from "vitest";
import { StoryboardCritique, critiqueIssues, type VisualCritiquePort } from "./critique.js";
import { DemoClient, buildDirectorGraph, type GenerateRequest } from "./index.js";
import { cfg, deps, input } from "./fixtures.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
class Looker extends DemoClient {
  names: string[] = [];
  images: number[] = [];
  constructor(private readonly critique: StoryboardCritique | Error) { super({ creative: true, compose: true }); }
  override async generate<T>(req: GenerateRequest<T>): Promise<T> {
    this.names.push(req.name);
    if (req.name === "storyboard_critique") {
      this.images.push(req.images?.length ?? 0);
      if (this.critique instanceof Error) throw this.critique;
      return req.schema.parse(this.critique);
    }
    return super.generate(req);
  }
}
const port = (fail?: string): VisualCritiquePort & { asked: number } => {
  const p = { asked: 0, async stills(req: Parameters<VisualCritiquePort["stills"]>[0]) {
    p.asked++;
    if (fail) return { stills: [], skipped: [], problem: fail };
    const composed = req.scenes.filter((s) => s.visual?.block === "composition");
    return { stills: composed.map((s) => ({ scene_id: s.scene_id, png: PNG })), skipped: req.scenes.filter((s) => s.visual?.block !== "composition").map((s) => ({ scene_id: s.scene_id, why: "fixed block" })), problem: null };
  } };
  return p;
};
const run = (llm: Looker, p?: VisualCritiquePort) => buildDirectorGraph({ ...deps(llm as never), ...(p ? { critique: p } : {}) }).invoke({ ...input, assets: [], project: { ...input.project, brief: "A 12 second Instagram Reels ad for my small coffee roaster." } } as never, cfg(`crit-${Math.random().toString(36).slice(2, 8)}`)) as Promise<any>;

describe("look-and-fix", () => {
  it("is off without a port: no critique call is made", async () => {
    const llm = new Looker({ verdict: "ok", summary: "fine", problems: [] });
    await run(llm);
    expect(llm.names).not.toContain("storyboard_critique");
  });
  it("one critique call with every still; an ok verdict changes nothing and asks for no revision", async () => {
    const llm = new Looker({ verdict: "ok", summary: "reads as one film", problems: [] });
    const p = port();
    const r = await run(llm, p);
    expect(r.status).toBe("awaiting_approval");
    expect(llm.names.filter((n) => n === "storyboard_critique")).toHaveLength(1);
    expect(llm.images[0]).toBeGreaterThan(0);
    expect(llm.names.filter((n) => n === "storyboard")).toHaveLength(1);
    expect(r.trace.join(" ")).not.toContain("storyboard revised");
  });
  it("problems seen in the stills go to one repair attempt, and a revision that passes the checks is kept", async () => {
    const llm = new Looker({ verdict: "revise", summary: "S02 is cramped", problems: [{ scene_id: "S02", seen: "the headline touches the card", fix: "move the card right by 0.04 and shrink the headline" }] });
    const r = await run(llm, port());
    expect(llm.names.filter((n) => n === "storyboard")).toHaveLength(2);
    expect(llm.names.filter((n) => n === "storyboard_critique")).toHaveLength(1);
    expect(r.trace.join(" ")).toContain("1 problem seen in the stills, storyboard revised");
  });
  it("any failure leaves the first storyboard in place and does not stop the run", async () => {
    for (const [llm, p] of [[new Looker(new Error("model down")), port()], [new Looker({ verdict: "ok", summary: "x", problems: [] }), port("no compatible browser")]] as const) {
      const r = await run(llm, p);
      expect(r.status).toBe("awaiting_approval");
      expect(r.trace.join(" ")).toMatch(/look-and-fix: (look-and-fix skipped: model down|no stills: no compatible browser)/);
    }
  });
});

describe("critique problems", () => {
  it("keeps only scenes that exist and says what was seen and what to change", () => {
    const c = StoryboardCritique.parse({ verdict: "revise", summary: "s", problems: [{ scene_id: "S01", seen: "empty right half", fix: "add a shape" }, { scene_id: "S09", seen: "x", fix: "y" }] });
    expect(critiqueIssues(c, new Set(["S01", "S02"]))).toEqual(["S01: seen in the rendered still: empty right half Change: add a shape"]);
    expect(critiqueIssues({ ...c, verdict: "ok" }, new Set(["S01"]))).toEqual([]);
    expect(critiqueIssues(null, new Set(["S01"]))).toEqual([]);
  });
});
