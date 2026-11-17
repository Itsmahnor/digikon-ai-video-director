import { describe, expect, it } from "vitest";
import { COMP_EASINGS, SceneVisual, compositionStructureIssues, type Composition } from "./index.js";
import type { z } from "zod";

const text = (extra: Record<string, unknown> = {}) => ({ id: "t", kind: "text", text: "Hello there", at: { x: 0.1, y: 0.4, w: 0.8 }, size: 0.08, ...extra });
const comp = (elements: unknown[]) => ({ block: "composition", intent: "test layout", elements });
const parse = (elements: unknown[]) => SceneVisual.safeParse(comp(elements));
const key = (t: number, value: number, easing?: string) => ({ t, value, ...(easing ? { easing } : {}) });
const track = (property: string, keys: unknown[]) => ({ property, keys });

describe("richer motion is optional and leaves old plans exactly as they were", () => {
  it("a composition without the new fields parses to JSON with no new keys", () => {
    const old = comp([text(), { id: "s", kind: "shape", shape: "rect", at: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, fill: "accent" }]);
    const out = SceneVisual.parse(old) as z.infer<typeof Composition>;
    for (const e of out.elements) { expect("tracks" in e).toBe(false); expect("pivot" in e).toBe(false); }
    expect(JSON.stringify(SceneVisual.parse(out))).toBe(JSON.stringify(out)); // parse is a fixed point
  });

  it("accepts tracks and a pivot on text and on shapes", () => {
    const r = parse([text({ tracks: [track("rotate", [key(0, -20), key(0.6, 5, "spring"), key(1, 0, "bezier_smooth")]), track("opacity", [key(0, 0), key(0.3, 1)])], pivot: { x: 0, y: 0.5 } }),
      { id: "s", kind: "shape", shape: "rect", at: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, fill: "accent", tracks: [track("x", [key(0, -0.3), key(1, 0)]), track("scale", [key(0, 0.5), key(1, 1, "spring_bouncy")])] }]);
    expect(r.success).toBe(true);
  });

  it("the easing list is fixed: every named easing works, a formula or an unknown name does not", () => {
    for (const e of COMP_EASINGS) expect(parse([text({ tracks: [track("scale", [key(0, 0.8, e), key(1, 1)])] })]).success, e).toBe(true);
    expect(parse([text({ tracks: [track("scale", [key(0, 0.8, "elastic"), key(1, 1)])] })]).success).toBe(false);
    expect(parse([text({ tracks: [track("scale", [{ t: 0, value: 0.8, easing: { bezier: [0.1, 0.2, 0.3, 0.4] } }, key(1, 1)])] })]).success).toBe(false);
  });

  it("holds every value inside its property's range", () => {
    const bad = (property: string, v: number) => parse([text({ tracks: [track(property, [key(0, 0.5), key(1, v)])] })]).success;
    expect([bad("rotate", 361), bad("rotate", -361), bad("scale", 4.5), bad("scale", 0), bad("opacity", 1.2), bad("opacity", -0.1), bad("x", 1.6), bad("y", -1.6)]).toEqual(Array(8).fill(false));
    expect([bad("rotate", 360), bad("scale", 4), bad("opacity", 1), bad("x", 1.5), bad("y", -1.5)]).toEqual(Array(5).fill(true));
  });

  it("limits the number of tracks, keys and the pivot, and rejects an unknown property", () => {
    const k2 = [key(0, 0), key(1, 1)];
    expect(parse([text({ tracks: ["x", "y", "scale", "rotate", "opacity"].map((p) => track(p, p === "opacity" ? k2 : [key(0, 0.5), key(1, 0.6)])) })]).success).toBe(true);
    expect(parse([text({ tracks: Array(6).fill(0).map(() => track("x", [key(0, 0), key(1, 0.1)])) })]).success).toBe(false); // more than 5
    expect(parse([text({ tracks: [track("x", [key(0, 0)])] })]).success).toBe(false); // one key
    expect(parse([text({ tracks: [track("x", Array.from({ length: 9 }, (_, i) => key(i / 8, i / 20)))] })]).success).toBe(false); // nine keys
    expect(parse([text({ tracks: [track("w", k2)] })]).success).toBe(false); // not an animatable property
    expect(parse([text({ pivot: { x: 1.1, y: 0.5 } })]).success).toBe(false);
    expect(parse([text({ pivot: { x: 0.5, y: -0.1 } })]).success).toBe(false);
  });

  it("keys must be in time order, each after the one before", () => {
    expect(parse([text({ tracks: [track("x", [key(0.5, 0), key(0.2, 0.1)])] })]).success).toBe(false);
    expect(parse([text({ tracks: [track("x", [key(0.5, 0), key(0.5, 0.1)])] })]).success).toBe(false);
  });

  it("two tracks for one property on one element are a structure issue", () => {
    const v = SceneVisual.parse(comp([text({ tracks: [track("x", [key(0, 0), key(1, 0.1)]), track("x", [key(0, 0), key(1, -0.1)])] })])) as z.infer<typeof Composition>;
    expect(compositionStructureIssues(v)).toEqual(["t: two tracks animate x; use one track per property"]);
  });
});
