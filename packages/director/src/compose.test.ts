import { describe, expect, it } from "vitest";
import { compositionGroundingIssues } from "@digikon/contracts";
import { DemoClient, buildDirectorGraph, type GenerateRequest } from "./index.js";
import { cfg, deps, input } from "./fixtures.js";

const briefs = {
  saas: "A 12 second YouTube explainer for my scheduling software, so teams stop going back and forth over calendar invites.",
  coffee: "A 12 second Instagram Reels ad for my small coffee roaster, beans roasted weekly.",
};
const run = async (id: string, brief: string, llm: DemoClient) => {
  const g = buildDirectorGraph(deps(llm as never));
  return g.invoke({ ...input, assets: [], project: { ...input.project, brief } } as never, cfg(id)); // no supplied footage: every scene is drawn
};
/** What a layout is, without its words: which elements, where, how big, how they arrive. */
const signature = (v: { elements: { id: string; kind: string; at: { x: number; y: number; w: number }; motion?: { enter?: string } }[] }) =>
  v.elements.map((e) => `${e.id}:${e.kind}@${e.at.x.toFixed(2)},${e.at.y.toFixed(2)},${e.at.w.toFixed(2)}:${e.motion?.enter ?? "fade"}`).join("|");

describe("the Director composes scenes instead of choosing blocks, and the plan carries what it composed", () => {
  it("two different briefs reach Gate 1 with compositions that have different layouts", async () => {
    const a = await run("comp-saas", briefs.saas, new DemoClient({ creative: true, compose: true }));
    const b = await run("comp-coffee", briefs.coffee, new DemoClient({ creative: true, compose: true }));
    for (const r of [a, b]) { expect(r.status).toBe("awaiting_approval"); expect(r.gate).toBe("storyboard"); }
    const layouts = (r: typeof a) => r.scenePlan!.scenes.map((s: any) => (s.visual?.block === "composition" ? signature(s.visual) : null));
    const la = layouts(a), lb = layouts(b);
    expect(la.every((x: string | null) => x !== null) && lb.every((x: string | null) => x !== null), "every drawn scene is a composition").toBe(true);
    expect(la).not.toEqual(lb);
    expect(la.filter((x: string | null, i: number) => x !== lb[i]).length).toBeGreaterThanOrEqual(2);
    // and inside one film no two scenes share a layout
    for (const l of [la, lb]) expect(new Set(l).size).toBe(l.length);
  });

  it("every word a composition draws comes from the scene's approved text, the treatment or the brief", async () => {
    const r = await run("comp-ground", briefs.coffee, new DemoClient({ creative: true, compose: true }));
    const t = r.treatmentDoc!;
    for (const s of r.scenePlan!.scenes as any[]) {
      if (s.visual?.block !== "composition") continue;
      const issues = compositionGroundingIssues(s.visual, { overlay: s.overlay?.text ?? null, voiceover: s.voiceover ?? null, claims: [], facts: [], brief: briefs.coffee, treatment: [t.logline, t.hook, t.cta] });
      expect(issues, s.scene_id).toEqual([]);
    }
  });

  it("a composition with invented copy is sent back, and when it stays invented the run escalates instead of reaching Gate 1", async () => {
    class Inventor extends DemoClient {
      override async generate<T>(req: GenerateRequest<T>): Promise<T> {
        const out = (await super.generate(req)) as any;
        if (req.name !== "storyboard") return out;
        const scenes = out.scenes.map((s: any, i: number) => i === 1 ? { ...s, visual: { block: "composition", intent: "invented", camera: "static", reveal: "none", backdrop: "flat", elements: [{ id: "t", kind: "text", text: "The world's best espresso, 50% off today", at: { x: 0.1, y: 0.4, w: 0.8 }, size: 0.07 }] } } : s);
        return req.schema.parse({ ...out, scenes });
      }
    }
    const r = await run("comp-invent", briefs.coffee, new Inventor({ creative: true }));
    expect(r.status).toBe("escalated");
    expect(r.gate ?? null).toBeNull();
    expect(JSON.stringify(r.escalation)).toMatch(/composition - t: .* is not in the scene's approved text/);
    expect(JSON.stringify(r.escalation)).toContain("the figure 50");
  });

  it("the fixed blocks still work, and a film may mix them with compositions", async () => {
    class Mixed extends DemoClient {
      override async generate<T>(req: GenerateRequest<T>): Promise<T> {
        const out = (await super.generate(req)) as any;
        if (req.name !== "storyboard") return out;
        const scenes = out.scenes.map((s: any, i: number) => i === 1 ? { ...s, visual: { block: "composition", intent: "a line on its own", camera: s.visual?.camera ?? "static", reveal: "none", backdrop: "flat", elements: [{ id: "t", kind: "text", text: "Roasted weekly", at: { x: 0.1, y: 0.4, w: 0.8 }, size: 0.08 }] } } : s);
        return req.schema.parse({ ...out, scenes });
      }
    }
    const r = await run("comp-mixed", briefs.coffee, new Mixed({ creative: true }));
    expect(r.status).toBe("awaiting_approval");
    const blocks = (r.scenePlan!.scenes as any[]).map((s) => s.visual?.block);
    expect(blocks[1]).toBe("composition");
    expect(blocks.filter((b: string) => b !== "composition").length).toBeGreaterThan(0);
  });
});