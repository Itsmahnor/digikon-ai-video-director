import { describe, expect, it } from "vitest";
import { EditPlan, applyCompositionMotion, editPlanHash, storyboardHash } from "@digikon/contracts";
import { DemoClient, approveCurrent, buildDirectorGraph, compositionMotionProblems, type GenerateRequest } from "./index.js";
import { cfg, deps, input } from "./fixtures.js";

const brief = "A 12 second YouTube ad for my small coffee roaster, beans roasted weekly.";
const toGate2 = async (id: string, llm: DemoClient) => {
  const g = buildDirectorGraph(deps(llm as never));
  const gate1: any = await g.invoke({ ...input, assets: [], project: { ...input.project, brief } } as never, cfg(id));
  const gate2: any = await g.invoke(approveCurrent(gate1), cfg(id));
  return { gate1, gate2, g };
};

describe("the Editor owns how composed scenes move, through the edit plan", () => {
  it("the edit plan carries motion changes for composed scenes, and the approved storyboard is untouched", async () => {
    const { gate1, gate2 } = await toGate2("motion-ok", new DemoClient({ creative: true, compose: true }));
    expect(gate2.status).toBe("awaiting_approval");
    expect(gate2.gate).toBe("edit_plan");
    const motion = gate2.editPlan.composition_motion as { scene_id: string; elements: { id: string; motion: Record<string, unknown> }[] }[];
    expect(motion.length).toBeGreaterThan(0);
    // motion only, on composed scenes and elements that exist
    for (const m of motion) {
      const scene = gate2.scenePlan.scenes.find((s: any) => s.scene_id === m.scene_id);
      expect(scene.visual.block).toBe("composition");
      for (const e of m.elements) { expect(scene.visual.elements.some((x: any) => x.id === e.id)).toBe(true); expect(Object.keys(e.motion).every((k) => ["enter", "delay", "duration", "easing", "stagger"].includes(k))).toBe(true); }
    }
    // Gate 1's storyboard is exactly what Gate 2 sits on: same plan, same hash
    expect(gate2.scenePlan).toEqual(gate1.scenePlan);
    const sbHash = storyboardHash(gate2.treatmentDoc, gate2.scenePlan);
    expect(sbHash).toBe(storyboardHash(gate1.treatmentDoc, gate1.scenePlan));
    // the motion is part of what Gate 2 approves: without it the edit plan would hash differently
    const sb = { version: gate2.scenePlan.version, hash: sbHash };
    const { composition_motion: _m, ...without } = gate2.editPlan;
    expect(editPlanHash(sb, gate2.editPlan)).not.toBe(editPlanHash(sb, EditPlan.parse(without)));
  });

  it("the patched composition keeps every word, position and size the storyboard approved", async () => {
    const { gate2 } = await toGate2("motion-same", new DemoClient({ creative: true, compose: true }));
    for (const m of gate2.editPlan.composition_motion) {
      const scene = gate2.scenePlan.scenes.find((s: any) => s.scene_id === m.scene_id);
      const patched = applyCompositionMotion(scene.visual, [m]);
      const strip = (v: any) => v.elements.map((e: any) => { const { motion: _x, ...rest } = e; return rest; });
      expect(strip(patched)).toEqual(strip(scene.visual));
    }
  });

  it("a plan that names an element the composition does not have is sent back, and when it stays wrong the run escalates", async () => {
    class Ghost extends DemoClient {
      override async generate<T>(req: GenerateRequest<T>): Promise<T> {
        const out = (await super.generate(req)) as any;
        if (req.name !== "edit_plan" || !out.composition_motion) return out;
        return req.schema.parse({ ...out, composition_motion: out.composition_motion.map((m: any) => ({ ...m, elements: [{ id: "ghost", motion: { enter: "fade" } }] })) });
      }
    }
    const { gate2 } = await toGate2("motion-ghost", new Ghost({ creative: true, compose: true }));
    expect(gate2.status).toBe("escalated");
    expect(gate2.gate ?? null).toBeNull();
    expect(JSON.stringify(gate2.escalation)).toContain("composition_motion");
    expect(JSON.stringify(gate2.escalation)).toContain("element ghost, which the composition does not have");
  });

  it("a patched composition is re-checked: if it no longer passes the renderer's checks, the plan is refused", () => {
    const scenes = { scenes: [{ scene_id: "S01", duration_seconds: 4, visual: { block: "composition", intent: "x", camera: "static", reveal: "none", backdrop: "flat", elements: [{ id: "h", kind: "text", text: "Hi", size: 0.08, at: { x: 0.1, y: 0.3, w: 0.8 }, motion: { enter: "fade", delay: 0, duration: 0.2 } }] } }] } as never;
    const edit = EditPlan.parse({ project_id: "p", version: 1, uses: [], composition_motion: [{ scene_id: "S01", rationale: "slow", elements: [{ id: "h", motion: { delay: 0.8 } }] }] });
    const seen: string[] = [];
    const port = { composition: (req: { visual: { elements: { motion: { delay: number } }[] } }) => { seen.push(String(req.visual.elements[0]!.motion.delay)); return req.visual.elements[0]!.motion.delay > 0.6 ? ["h finishes at 3.6s, after it can be read"] : []; } };
    const problems = compositionMotionProblems(edit, scenes, { production: port } as never, { aspect_ratio: "16:9" });
    expect(seen).toEqual(["0.8"]); // the patch was applied before the check
    expect(problems).toEqual(["composition_motion - S01: h finishes at 3.6s, after it can be read"]);
    expect(compositionMotionProblems(EditPlan.parse({ ...edit, composition_motion: [{ scene_id: "S01", rationale: "ok", elements: [{ id: "h", motion: { delay: 0.1 } }] }] }), scenes, { production: port } as never, { aspect_ratio: "16:9" })).toEqual([]);
  });
});