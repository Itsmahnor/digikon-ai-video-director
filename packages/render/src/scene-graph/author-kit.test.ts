import { describe, expect, it } from "vitest";
import { Composition } from "@digikon/contracts";
import { DEFAULT_PALETTE } from "../composition.js";
import { ESTIMATE_METER } from "../font-metrics.js";
import { authorGraph } from "./author.js";
import { validateSceneGraph } from "./validate.js";

const mo = (enter = "fade", easing = "ease_out", extra: object = {}) => ({ enter, delay: 0, duration: 0.3, easing, ...extra });
const comp = Composition.parse({
  block: "composition", intent: "kit", camera: "static", reveal: "none", backdrop: "flat",
  elements: [
    { id: "rule", kind: "mask", reveal: "left", at: { x: 0.06, y: 0.5, w: 0.4, h: 0.012 }, motion: mo("fade", "soft") },
    { id: "bar", kind: "shape", parent: "rule", shape: "rect", at: { x: 0.06, y: 0.5, w: 0.4, h: 0.012 }, fill: "accent", motion: mo("none") },
    { id: "head", kind: "text", text: "Plan first, then render", at: { x: 0.06, y: 0.14, w: 0.44 }, size: 0.085, motion: mo("tracking_in", "snappy") },
    { id: "card", kind: "group", at: { x: 0.56, y: 0.16 }, motion: mo("rotate_in", "back_out") },
    { id: "lab", kind: "text", parent: "card", text: "Storyboard", at: { x: 0.6, y: 0.22, w: 0.28 }, size: 0.045, motion: mo("pop", "bouncy", { stagger: { unit: "char", each: 0.01, from: "center" } }) },
  ],
});
const g = authorGraph(comp, { width: 960, height: 540, fps: 30, duration_s: 4, meter: ESTIMATE_METER });
const el = (id: string) => g.elements.find((e) => e.id === id)!;

describe("the wider kit becomes a scene graph the renderers already draw", () => {
  it("places children relative to their group or mask, and keeps the written order", () => {
    expect(el("card")).toMatchObject({ kind: "group", props: { x: 0.56 * 960, y: 0.16 * 540 } });
    const lab = el("lab"), pos = lab.props as { x: number; y: number };
    expect(lab.parent).toBe("card");
    expect(pos.x).toBeCloseTo((0.6 - 0.56) * 960, 6);
    expect(pos.y).toBeCloseTo((0.22 - 0.16) * 540, 6);
    expect(el("bar")).toMatchObject({ parent: "rule" });
    expect((el("bar").props as { x: number; y: number }).x).toBeCloseTo(0, 6);
    expect(g.elements.map((e) => e.id)).toEqual(["rule", "bar", "head", "card", "lab"]);
  });
  it("turns each new arrival and easing into keyframes", () => {
    const props = (id: string) => el(id).timeline.tracks.map((t) => t.property);
    expect(props("rule")).toEqual(["progress"]);
    expect(el("rule")).toMatchObject({ kind: "mask", props: { reveal: "left" } });
    expect(props("head")).toEqual(["opacity", "tracking"]);
    expect(props("card")).toEqual(expect.arrayContaining(["opacity", "rotate", "y"]));
    expect(props("lab")).toEqual(["opacity", "scale"]);
    expect(el("head").timeline.tracks[1]!.easing).toEqual({ bezier: [0.2, 0.9, 0.1, 1] });
    expect(el("card").timeline.tracks.find((t) => t.property === "rotate")!.easing).toEqual({ bezier: [0.34, 1.56, 0.64, 1] });
    expect(el("lab")).toMatchObject({ stagger: { unit: "char", from: "center" } });
  });
  it("passes the same validator as every other scene graph", () => {
    expect(validateSceneGraph(g, { palette: DEFAULT_PALETTE, meter: ESTIMATE_METER })).toMatchObject({ ok: true });
  });
});
