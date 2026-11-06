import { describe, expect, it } from "vitest";
import { CompositionMotionPlan, EditPlan, MotionPatch, SceneVisual, applyCompositionMotion, compositionMotionIssues, editPlanHash } from "./index.js";

const comp = SceneVisual.parse({
  block: "composition", intent: "test layout", camera: "static", reveal: "none", backdrop: "flat",
  elements: [
    { id: "head", kind: "text", text: "Roasted weekly", at: { x: 0.1, y: 0.3, w: 0.8 }, size: 0.08, motion: { enter: "fade", delay: 0, duration: 0.2 } },
    { id: "bar", kind: "shape", shape: "rect", at: { x: 0.1, y: 0.7, w: 0.3, h: 0.02 }, fill: "accent" },
  ],
}) as Extract<SceneVisual, { block: "composition" }>;
const scenes = [{ scene_id: "S01", visual: comp }, { scene_id: "S02", visual: { block: "kinetic_type" } }];
const plan = (elements: unknown[], scene_id = "S01") => CompositionMotionPlan.parse({ scene_id, rationale: "rhythm", elements });

describe("the Editor's motion patch is motion only", () => {
  it("cannot carry copy, layout, colour, shape or a picture", () => {
    for (const bad of [{ text: "New words" }, { at: { x: 0 } }, { size: 0.2 }, { color: "accent" }, { fill: "accent" }, { asset_id: "asset_xxxx" }]) expect(MotionPatch.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(MotionPatch.safeParse({ enter: "rise", delay: 0.1, duration: 0.3, easing: "spring", stagger: { unit: "word", each: 0.03 } }).success).toBe(true);
  });
  it("an applied patch changes the named elements' motion and nothing else", () => {
    const out = applyCompositionMotion(comp, [plan([{ id: "head", motion: { enter: "rise", easing: "spring", stagger: { unit: "word", each: 0.03 } } }])]);
    const head = out.elements.find((e) => e.id === "head")!, before = comp.elements.find((e) => e.id === "head")!;
    expect(head.motion).toMatchObject({ enter: "rise", easing: "spring", delay: 0, duration: 0.2, stagger: { unit: "word", each: 0.03 } });
    expect({ ...head, motion: null }).toEqual({ ...before, motion: null }); // text, place, size, colour: the same
    expect(out.elements.find((e) => e.id === "bar")).toEqual(comp.elements.find((e) => e.id === "bar"));
    expect(comp.elements[0]!.motion).toMatchObject({ enter: "fade" }); // the approved composition itself is not mutated
    expect(applyCompositionMotion(comp, [])).toBe(comp);
  });
  it("a null stagger removes one, and a shape never gets one", () => {
    const withStagger = applyCompositionMotion(comp, [plan([{ id: "head", motion: { stagger: { unit: "char", each: 0.01 } } }])]);
    expect((withStagger.elements[0] as { motion: { stagger?: unknown } }).motion.stagger).toBeDefined();
    const cleared = applyCompositionMotion(withStagger, [plan([{ id: "head", motion: { stagger: null } }])]);
    expect((cleared.elements[0] as { motion: { stagger?: unknown } }).motion.stagger).toBeUndefined();
  });
  it("reports a scene that is not composed, an element that is not there, a stagger on a shape and repeats", () => {
    expect(compositionMotionIssues([plan([{ id: "head", motion: { enter: "rise" } }])], scenes)).toEqual([]);
    const issues = compositionMotionIssues([plan([{ id: "nope", motion: { enter: "rise" } }, { id: "bar", motion: { stagger: { unit: "word", each: 0.02 } } }, { id: "head", motion: {} }, { id: "head", motion: {} }]), plan([{ id: "x", motion: {} }], "S02"), plan([{ id: "head", motion: {} }], "S09")], scenes).join(" | ");
    expect(issues).toContain("element nope, which the composition does not have");
    expect(issues).toContain("bar is not text, so it cannot stagger");
    expect(issues).toContain("element head twice");
    expect(issues).toContain("S02: composition_motion names a scene that is not a composition");
    expect(issues).toContain("S09: composition_motion names a scene that is not a composition");
  });
});

describe("the edit plan carries the motion, and Gate 2 approves it", () => {
  const sb = { version: 1, hash: "a".repeat(64) };
  const base = { project_id: "p", version: 1, uses: [] as never[] };
  it("an edit plan with no motion keeps the same hash as before the field existed", () => {
    const plain = EditPlan.parse(base);
    expect("composition_motion" in plain).toBe(false);
    expect(editPlanHash(sb, plain)).toBe(editPlanHash(sb, EditPlan.parse({ ...base })));
  });
  it("motion changes the edit plan's hash, and the storyboard's hash is untouched", () => {
    const a = EditPlan.parse(base), b = EditPlan.parse({ ...base, composition_motion: [plan([{ id: "head", motion: { enter: "rise" } }])] });
    expect(editPlanHash(sb, a)).not.toBe(editPlanHash(sb, b));
    expect(sb.hash).toBe("a".repeat(64));
  });
});