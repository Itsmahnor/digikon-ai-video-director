import { describe, expect, it } from "vitest";
import { SceneGraphV2, SceneVisual, type Composition } from "@digikon/contracts";
import type { z } from "zod";
import { DEFAULT_PALETTE } from "../composition.js";
import { ESTIMATE_METER } from "../font-metrics.js";
import { authorGraph } from "./author.js";
import { compileScene, sampleScene } from "./compile.js";
import { validateSceneGraph } from "./validate.js";

type Comp = z.infer<typeof Composition>;
const comp = (elements: unknown[]) => SceneVisual.parse({ block: "composition", intent: "test layout", camera: "static", reveal: "none", backdrop: "flat", elements }) as Comp;
const frame = { width: 1280, height: 720, fps: 30, duration_s: 4 };
const text = (extra: Record<string, unknown> = {}) => ({ id: "t", kind: "text", text: "Hello", at: { x: 0.1, y: 0.4, w: 0.4 }, size: 0.08, motion: { enter: "fade", delay: 0.1, duration: 0.2 }, ...extra });
const get = (g: ReturnType<typeof authorGraph>, id: string) => g.elements.find((e) => e.id === id)!;
const props = (g: ReturnType<typeof authorGraph>, id: string) => get(g, id).props as Record<string, unknown>;

describe("groups compile to engine groups with positions relative to the group", () => {
  const g = authorGraph(comp([
    { id: "grp", kind: "group", at: { x: 0.5, y: 0.5 } },
    text({ id: "a", parent: "grp", at: { x: 0.5, y: 0.4, w: 0.3 } }),
    { id: "b", kind: "shape", shape: "rect", at: { x: 0.6, y: 0.6, w: 0.1, h: 0.1 }, fill: "accent", parent: "grp" },
  ]), frame);
  it("the group sits at its own place and its children are offset by it, so they draw where the plan put them", () => {
    expect(props(g, "grp")).toEqual({ x: 640, y: 360 });
    expect(get(g, "a").parent).toBe("grp");
    expect(props(g, "a")["x"]).toBeCloseTo(0.5 * 1280 - 640, 6);
    expect(props(g, "a")["y"]).toBeCloseTo(0.4 * 720 - 360, 6);
    expect(props(g, "b")["x"]).toBeCloseTo(0.6 * 1280 - 640, 6);
  });
  it("a group without motion holds still for the whole scene; the graph is valid", () => {
    expect(get(g, "grp").timeline).toMatchObject({ start_s: 0, duration_s: 4, tracks: [] });
    expect(SceneGraphV2.safeParse(g).success).toBe(true);
  });
  it("the same plan in portrait offsets the children by the portrait position of the group", () => {
    const p = authorGraph(comp([
      { id: "grp", kind: "group", at: { x: 0.5, y: 0.5 }, portrait: { y: 0.3 } },
      text({ id: "a", parent: "grp", at: { x: 0.5, y: 0.4, w: 0.3 }, portrait: { y: 0.35 } }),
    ]), { width: 720, height: 1280, fps: 30, duration_s: 4 });
    expect(props(p, "grp")["y"]).toBeCloseTo(0.3 * 1280, 6);
    expect(props(p, "a")["y"]).toBeCloseTo(0.35 * 1280 - 0.3 * 1280, 6);
  });
});

describe("a group moves its children as one", () => {
  it("rotating the group moves a child about the group's position, and the sampled child inherits nothing it should not", () => {
    const g = authorGraph(comp([
      { id: "grp", kind: "group", at: { x: 0.5, y: 0.5 }, tracks: [{ property: "rotate", keys: [{ t: 0, value: 0 }, { t: 1, value: 90 }] }] },
      { id: "dot", kind: "shape", shape: "ellipse", at: { x: 0.6, y: 0.5, w: 0.05, h: 0.05 }, fill: "accent", parent: "grp", motion: { enter: "none" } },
      text({ id: "t" }),
    ]), frame);
    const c = compileScene(g);
    expect(sampleScene(c, 0).elements.find((e) => e.id === "grp")!.rotate).toBeCloseTo(0, 5);
    expect(sampleScene(c, c.frames - 1).elements.find((e) => e.id === "grp")!.rotate).toBeCloseTo(90, 2); // the last frame is one frame short of the exact end
  });
});

describe("a group staggers its children", () => {
  const kids = ["k1", "k2", "k3", "k4"].map((id, i) => text({ id, parent: "grp", text: `Item ${i + 1}`, at: { x: 0.1 + i * 0.2, y: 0.4, w: 0.18 }, size: 0.04, motion: { enter: "fade", delay: 0.1, duration: 0.15 } }));
  const starts = (from?: string) => {
    const g = authorGraph(comp([{ id: "grp", kind: "group", at: { x: 0, y: 0 }, stagger_children: { each: 0.05, ...(from ? { from } : {}) } }, ...kids]), frame);
    return ["k1", "k2", "k3", "k4"].map((id) => get(g, id).timeline.start_s);
  };
  it("from the start, each child is each-of-the-scene later than the one before (0.05 of 4 s = 0.2 s)", () => {
    const s = starts();
    expect(s.map((v, i) => v - s[0]! - i * 0.2).every((d) => Math.abs(d) < 1e-9)).toBe(true);
  });
  it("from the end the order reverses; from the centre the middle children go first", () => {
    const e = starts("end"), c = starts("center");
    expect(e[3]!).toBeLessThan(e[0]!);
    expect(Math.min(c[1]!, c[2]!)).toBeLessThan(Math.min(c[0]!, c[3]!) + 1e-9);
    expect(Math.max(c[0]!, c[3]!)).toBeGreaterThan(Math.max(c[1]!, c[2]!) - 1e-9);
  });
  it("children outside any stagger keep their own delay", () => {
    const g = authorGraph(comp([text()]), frame);
    expect(get(g, "t").timeline.start_s).toBeCloseTo(0.4, 9);
  });
});

describe("images", () => {
  it("compile to engine image elements in pixels, shown whole unless cover is asked for", () => {
    const g = authorGraph(comp([text(), { id: "pic", kind: "image", asset_ref: "asset_aaaa1111", at: { x: 0.55, y: 0.1, w: 0.3, h: 0.5 } }, { id: "bg", kind: "image", asset_ref: "asset_bbbb2222", at: { x: 0, y: 0, w: 0.3, h: 0.3 }, fit: "cover" }]), frame);
    expect(props(g, "pic")).toMatchObject({ asset_ref: "asset_aaaa1111", x: 704, y: 72, w: 384, h: 360, fit: "contain" });
    expect(props(g, "bg")["fit"]).toBe("cover");
    expect(get(g, "pic").kind).toBe("image");
  });
  it("the engine validator accepts only pictures it is told exist", () => {
    const g = authorGraph(comp([text(), { id: "pic", kind: "image", asset_ref: "asset_aaaa1111", at: { x: 0.55, y: 0.1, w: 0.3, h: 0.5 } }]), frame);
    expect(validateSceneGraph(g, { palette: DEFAULT_PALETTE, meter: ESTIMATE_METER, assets: new Set(["asset_aaaa1111"]) }).ok).toBe(true);
    const bad = validateSceneGraph(g, { palette: DEFAULT_PALETTE, meter: ESTIMATE_METER, assets: new Set(["something_else"]) });
    expect(bad.ok).toBe(false);
  });
});

describe("gradient, glow and blend", () => {
  const beam = { id: "beam", kind: "shape", shape: "rect", at: { x: 0.3, y: 0.2, w: 0.4, h: 0.05 }, gradient: { type: "linear", angle: 0, stops: [{ at: 0, color: "accent", alpha: 0 }, { at: 0.5, color: "accent_2" }, { at: 1, color: "accent", alpha: 0 }] }, glow: { color: "accent", radius: 0.04, strength: 0.5 }, blend: "screen" };
  const g = authorGraph(comp([text(), beam]), frame);
  it("carries them for the drawing code, with the glow radius in pixels of the shorter side", () => {
    expect(props(g, "beam")["gradient"]).toEqual({ type: "linear", angle: 0, stops: [{ at: 0, color: "accent", alpha: 0 }, { at: 0.5, color: "accent_2" }, { at: 1, color: "accent", alpha: 0 }] });
    expect(props(g, "beam")["glow"]).toEqual({ color: "accent", radius: 0.04 * 720, strength: 0.5 });
    expect(props(g, "beam")["blend"]).toBe("screen");
  });
  it("keeps the first stop as the solid fill, so a drawer without gradients still shows the shape", () => {
    expect(props(g, "beam")["fill"]).toBe("accent");
    const flat = authorGraph(comp([text(), { ...beam, id: "flat", fill: "surface" }]), frame);
    expect(props(flat, "flat")["fill"]).toBe("surface"); // an explicit fill is left alone
  });
  it("the graph is valid and passes the same legibility checks", () => {
    expect(SceneGraphV2.safeParse(g).success).toBe(true);
    expect(validateSceneGraph(g, { palette: DEFAULT_PALETTE, meter: ESTIMATE_METER }).ok).toBe(true);
  });
  it("a plain shape has none of these keys", () => {
    const plain = authorGraph(comp([text(), { id: "p", kind: "shape", shape: "rect", at: { x: 0.3, y: 0.2, w: 0.4, h: 0.05 }, fill: "accent" }]), frame);
    for (const k of ["gradient", "glow", "blend"]) expect(k in props(plain, "p")).toBe(false);
  });
});
