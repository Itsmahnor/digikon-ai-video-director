import { describe, expect, it } from "vitest";
import { COMP_REVEALS, SceneVisual, compositionStructureIssues, type Composition } from "./index.js";
import type { z } from "zod";

type Comp = z.infer<typeof Composition>;
const text = (extra: Record<string, unknown> = {}) => ({ id: "t", kind: "text", text: "Hello there", at: { x: 0.1, y: 0.4, w: 0.5 }, size: 0.08, ...extra });
const ok = (elements: unknown[]) => SceneVisual.safeParse({ block: "composition", intent: "x", elements }).success;
const issues = (elements: unknown[]) => compositionStructureIssues(SceneVisual.parse({ block: "composition", intent: "x", elements }) as Comp);
const region = { x: 0.05, y: 0.3, w: 0.7, h: 0.3 };

describe("reveal masks", () => {
  it("every reveal the engine can draw is accepted on text, shapes, pictures and groups", () => {
    for (const from of COMP_REVEALS) {
      expect(ok([text({ reveal: { from } })]), from).toBe(true);
      expect(ok([text(), { id: "s", kind: "shape", shape: "rect", at: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, fill: "accent", reveal: { from } }]), from).toBe(true);
      expect(ok([text(), { id: "p", kind: "image", asset_ref: "asset_aaaa1111", at: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, reveal: { from } }]), from).toBe(true);
      expect(ok([text({ parent: "g" }), { id: "g", kind: "group", at: { x: 0.5, y: 0.5 }, reveal: { from, region } }]), from).toBe(true);
    }
  });
  it("only the five engine reveals; the timing, easing and region stay inside their limits", () => {
    expect(ok([text({ reveal: { from: "diagonal" } })])).toBe(false);
    expect(ok([text({ reveal: { from: "left", delay: 0.95 } })])).toBe(false);
    expect(ok([text({ reveal: { from: "left", duration: 0.01 } })])).toBe(false);
    expect(ok([text({ reveal: { from: "left", easing: "elastic" } })])).toBe(false);
    expect(ok([text({ reveal: { from: "left", easing: "spring", delay: 0.1, duration: 0.4 } })])).toBe(true);
    expect(ok([text({ reveal: { from: "left", region: { x: 0, y: 0, w: 0, h: 0.3 } } })])).toBe(false);
    expect(ok([text({ reveal: { from: "left", region: { x: 0, y: 0, w: 1.5, h: 0.3 } } })])).toBe(false);
  });
  it("a group needs a region for its reveal, and an id may not collide with the one kept for a mask", () => {
    expect(issues([text({ parent: "g" }), { id: "g", kind: "group", at: { x: 0.5, y: 0.5 }, reveal: { from: "left" } }])).toEqual(["g: a group has no box of its own, so its reveal needs a region"]);
    expect(issues([text({ parent: "g" }), { id: "g", kind: "group", at: { x: 0.5, y: 0.5 }, reveal: { from: "left", region } }])).toEqual([]);
    expect(issues([text({ reveal: { from: "left" } }), { id: "t_mask", kind: "shape", shape: "rect", at: { x: 0, y: 0, w: 0.1, h: 0.1 }, fill: "accent" }])).toEqual(["t: the id t_mask is kept for its reveal; rename that element"]);
  });
  it("an element without a reveal has no reveal key", () => {
    const v = SceneVisual.parse({ block: "composition", intent: "x", elements: [text()] }) as Comp;
    expect("reveal" in v.elements[0]!).toBe(false);
  });
});
