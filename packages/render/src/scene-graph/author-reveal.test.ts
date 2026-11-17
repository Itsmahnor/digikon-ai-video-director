import { describe, expect, it } from "vitest";
import { SceneGraphV2, SceneVisual, type Composition } from "@digikon/contracts";
import type { z } from "zod";
import { DEFAULT_PALETTE } from "../composition.js";
import { ESTIMATE_METER } from "../font-metrics.js";
import { authorGraph } from "./author.js";
import { compileScene, maskClip, sampleScene } from "./compile.js";
import { validateSceneGraph } from "./validate.js";

type Comp = z.infer<typeof Composition>;
const comp = (elements: unknown[]) => SceneVisual.parse({ block: "composition", intent: "test layout", camera: "static", reveal: "none", backdrop: "flat", elements }) as Comp;
const frame = { width: 1280, height: 720, fps: 30, duration_s: 4 };
const text = (extra: Record<string, unknown> = {}) => ({ id: "t", kind: "text", text: "Hello there", at: { x: 0.1, y: 0.4, w: 0.5 }, size: 0.08, motion: { enter: "none" }, ...extra });
const get = (g: ReturnType<typeof authorGraph>, id: string) => g.elements.find((e) => e.id === id)!;
const props = (g: ReturnType<typeof authorGraph>, id: string) => get(g, id).props as Record<string, number | string>;

describe("a reveal wraps its element in an engine mask", () => {
  const g = authorGraph(comp([text({ reveal: { from: "left", delay: 0.1, duration: 0.25, easing: "bezier_smooth" } })]), frame);
  it("adds a mask named for the element, with a progress track from 0 to 1, and puts the element inside it", () => {
    const m = get(g, "t_mask");
    expect(m.kind).toBe("mask");
    expect(m.parent).toBeNull();
    expect(get(g, "t").parent).toBe("t_mask");
    expect(m.props["reveal"]).toBe("left");
    expect(m.timeline.start_s).toBeCloseTo(0.4, 9);
    expect(m.timeline.duration_s).toBeCloseTo(1, 9);
    expect(m.timeline.tracks).toEqual([{ property: "progress", keyframes: [{ at: 0, value: 0 }, { at: 1, value: 1 }], easing: { bezier: [0.4, 0, 0.2, 1] } }]);
    expect(SceneGraphV2.safeParse(g).success).toBe(true);
  });
  it("the mask box is at least the element's box, and the element's position is taken from the mask's corner", () => {
    const m = props(g, "t_mask"), t = props(g, "t");
    expect(m["x"]).toBeCloseTo(0.1 * 1280, 6);
    expect(m["y"]).toBeCloseTo(0.4 * 720, 6);
    expect(m["w"]).toBeGreaterThanOrEqual(0.5 * 1280 - 1e-6);
    expect(m["h"]).toBeGreaterThanOrEqual(0.08 * 720); // taller than one line of the text
    expect(t["x"]).toBeCloseTo(0, 6);
    expect(t["y"]).toBeCloseTo(0, 6);
  });
  it("the reveal ends fully uncovered: at the last frame the clip shows everything, so nothing is left cropped", () => {
    const c = compileScene(g);
    const progress = (f: number) => sampleScene(c, f).elements.find((e) => e.id === "t_mask")!.progress;
    expect(progress(0)).toBeCloseTo(0, 6);
    expect(progress(c.frames - 1)).toBeCloseTo(1, 6);
    expect(maskClip("left", progress(c.frames - 1))).toBe("inset(0 0% 0 0)");
    expect(maskClip("circle", 1)).toBe("circle(75.00% at 50% 50%)");
  });
  it("passes the same checks: legible, inside the frame, shown long enough", () => {
    expect(validateSceneGraph(g, { palette: DEFAULT_PALETTE, meter: ESTIMATE_METER }).ok).toBe(true);
  });
});

describe("every reveal style", () => {
  for (const from of ["left", "right", "up", "down", "circle"] as const) {
    it(`${from}: the engine clip is partial in the middle and complete at the end`, () => {
      const g = authorGraph(comp([text({ reveal: { from } })]), frame);
      expect(props(g, "t_mask")["reveal"]).toBe(from);
      expect(maskClip(from, 0.5)).not.toBe(maskClip(from, 1));
    });
  }
});

describe("a region widens the box but never shrinks it below the element", () => {
  it("a larger region is used", () => {
    const g = authorGraph(comp([text({ reveal: { from: "right", region: { x: 0, y: 0.3, w: 1, h: 0.4 } } })]), frame);
    expect(props(g, "t_mask")).toMatchObject({ x: 0, w: 1280 });
    expect(props(g, "t")["x"]).toBeCloseTo(0.1 * 1280, 6);
  });
  it("a region smaller than the text is widened to hold it, so the text is never cropped", () => {
    const g = authorGraph(comp([text({ reveal: { from: "left", region: { x: 0.2, y: 0.45, w: 0.05, h: 0.01 } } })]), frame);
    const m = props(g, "t_mask");
    expect(m["x"]).toBeLessThanOrEqual(0.1 * 1280 + 1e-6);
    expect((m["x"] as number) + (m["w"] as number)).toBeGreaterThanOrEqual(0.6 * 1280 - 1e-6);
    expect(m["h"]).toBeGreaterThanOrEqual(0.08 * 720);
  });
});

describe("a shape with a glow is revealed with its light", () => {
  it("the mask grows by twice the glow radius on every side", () => {
    const shape = { id: "s", kind: "shape", shape: "rect", at: { x: 0.3, y: 0.3, w: 0.2, h: 0.1 }, fill: "accent", motion: { enter: "none" } };
    const plain = authorGraph(comp([text(), { ...shape, reveal: { from: "left" } }]), frame);
    const glowing = authorGraph(comp([text(), { ...shape, glow: { color: "accent", radius: 0.02, strength: 0.5 }, reveal: { from: "left" } }]), frame);
    const grow = 0.02 * 720 * 2;
    expect((props(glowing, "s_mask")["w"] as number) - (props(plain, "s_mask")["w"] as number)).toBeCloseTo(2 * grow, 6);
    expect((props(plain, "s_mask")["x"] as number) - (props(glowing, "s_mask")["x"] as number)).toBeCloseTo(grow, 6);
  });
});

describe("a reveal inside a group and a reveal of a group", () => {
  it("an element in a group gets a mask in that group, positioned from the group's corner", () => {
    const g = authorGraph(comp([
      { id: "grp", kind: "group", at: { x: 0.5, y: 0.5 } },
      text({ id: "a", parent: "grp", at: { x: 0.55, y: 0.5, w: 0.3 }, reveal: { from: "up" } }),
    ]), frame);
    expect(get(g, "a_mask").parent).toBe("grp");
    expect(get(g, "a").parent).toBe("a_mask");
    expect(props(g, "a_mask")["x"]).toBeCloseTo(0.55 * 1280 - 640, 6);
    expect(props(g, "a_mask")["y"]).toBeCloseTo(0.5 * 720 - 360, 6);
    expect(SceneGraphV2.safeParse(g).success).toBe(true);
  });
  it("a group's reveal clips its region, and its children keep their positions relative to the group", () => {
    const g = authorGraph(comp([
      { id: "grp", kind: "group", at: { x: 0.3, y: 0.3 }, reveal: { from: "circle", region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } } },
      text({ id: "a", parent: "grp", at: { x: 0.3, y: 0.4, w: 0.3 } }),
    ]), frame);
    expect(get(g, "grp").parent).toBe("grp_mask");
    expect(props(g, "grp_mask")).toMatchObject({ x: 0.25 * 1280, y: 0.25 * 720, w: 0.5 * 1280, h: 0.5 * 720 });
    expect(props(g, "grp")["x"]).toBeCloseTo(0.3 * 1280 - 0.25 * 1280, 6); // the group is placed from the mask's corner
    expect(props(g, "a")["x"]).toBeCloseTo(0.3 * 1280 - 0.3 * 1280, 6); // the child is still relative to the group
    expect(SceneGraphV2.safeParse(g).success).toBe(true);
  });
});
