import { describe, expect, it } from "vitest";
import { SceneVisual, compositionPictureIssues, compositionStructureIssues, type Composition } from "./index.js";
import type { z } from "zod";

type Comp = z.infer<typeof Composition>;
const text = (extra: Record<string, unknown> = {}) => ({ id: "t", kind: "text", text: "Hello there", at: { x: 0.1, y: 0.4, w: 0.8 }, size: 0.08, ...extra });
const group = (extra: Record<string, unknown> = {}) => ({ id: "g", kind: "group", at: { x: 0.5, y: 0.5 }, ...extra });
const image = (extra: Record<string, unknown> = {}) => ({ id: "pic", kind: "image", asset_ref: "asset_aaaa1111", at: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, ...extra });
const shape = (extra: Record<string, unknown> = {}) => ({ id: "s", kind: "shape", shape: "rect", at: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, fill: "accent", ...extra });
const parse = (elements: unknown[]) => SceneVisual.safeParse({ block: "composition", intent: "test layout", elements });
const ok = (elements: unknown[]) => parse(elements).success;
const issues = (elements: unknown[]) => compositionStructureIssues(SceneVisual.parse({ block: "composition", intent: "x", elements }) as Comp);

describe("groups", () => {
  it("accepts a group with no motion, with an entrance, with tracks and with staggered children", () => {
    expect(ok([group(), text({ parent: "g" })])).toBe(true);
    expect(ok([group({ motion: { enter: "fade", delay: 0.1, duration: 0.3 } }), text({ parent: "g" })])).toBe(true);
    expect(ok([group({ tracks: [{ property: "rotate", keys: [{ t: 0, value: -30 }, { t: 1, value: 0 }] }] }), text({ parent: "g" })])).toBe(true);
    expect(ok([group({ stagger_children: { each: 0.05, from: "center" } }), text({ parent: "g" })])).toBe(true);
  });
  it("holds the stagger inside its range and refuses a pivot on a group (its position is its pivot)", () => {
    expect(ok([group({ stagger_children: { each: 0.2 } }), text()])).toBe(false);
    expect(ok([group({ stagger_children: { each: 0.001 } }), text()])).toBe(false);
    expect(ok([group({ stagger_children: { each: 0.05, from: "middle" } }), text()])).toBe(false);
  });
  it("a child must name a group that exists; groups do not nest; at most 12 children", () => {
    expect(issues([text({ parent: "nope" })])).toEqual(["t: its parent nope is not an element of this scene"]);
    expect(issues([shape({ id: "box" }), text({ parent: "box" })])).toEqual(["t: its parent box is a shape; only a group can hold elements"]);
    const many = Array.from({ length: 13 }, (_, i) => text({ id: `t${i}`, parent: "g" }));
    expect(issues([group(), ...many])).toEqual(["group g holds 13 elements; at most 12"]);
    expect(issues([group(), text({ parent: "g" })])).toEqual([]);
  });
});

describe("images name a picture the scene already carries", () => {
  it("parses with or without a fit, and only contain or cover", () => {
    expect(ok([text(), image()])).toBe(true);
    expect(ok([text(), image({ fit: "contain" })])).toBe(true);
    expect(ok([text(), image({ fit: "cover" })])).toBe(true);
    expect(ok([text(), image({ fit: "crop" })])).toBe(false);
    expect(ok([text(), image({ asset_ref: "" })])).toBe(false);
  });
  it("an image that is not in the scene's asset_refs is refused; a logo is never cropped", () => {
    const v = SceneVisual.parse({ block: "composition", intent: "x", elements: [text(), image(), image({ id: "logo", asset_ref: "asset_bbbb2222", fit: "cover" })] }) as Comp;
    expect(compositionPictureIssues(v, [])).toEqual([
      "pic: asset_aaaa1111 is not one of this scene's pictures; place it in the scene's asset_refs first",
      "logo: asset_bbbb2222 is not one of this scene's pictures; place it in the scene's asset_refs first",
    ]);
    expect(compositionPictureIssues(v, [{ asset_id: "asset_aaaa1111", role: "hero" }, { asset_id: "asset_bbbb2222", role: "logo" }])).toEqual(["logo: asset_bbbb2222 is a logo, so it is shown whole (fit contain), never cropped"]);
    expect(compositionPictureIssues(v, [{ asset_id: "asset_aaaa1111", role: "hero" }, { asset_id: "asset_bbbb2222", role: "hero" }])).toEqual([]);
  });
  it("at most four pictures in one scene", () => {
    const five = Array.from({ length: 5 }, (_, i) => image({ id: `p${i}` }));
    expect(issues([text(), ...five])).toEqual(["5 picture elements; at most 4 in one scene"]);
  });
});

describe("gradient, glow and blend", () => {
  it("a gradient takes two or three palette stops in order", () => {
    expect(ok([text(), shape({ gradient: { type: "linear", angle: 90, stops: [{ at: 0, color: "accent" }, { at: 1, color: "background", alpha: 0 }] } })])).toBe(true);
    expect(ok([text(), shape({ gradient: { type: "linear", angle: 0, stops: [{ at: 0, color: "accent" }, { at: 0.5, color: "accent_2" }, { at: 1, color: "surface" }] } })])).toBe(true);
    const g = (stops: unknown[], angle = 0, type = "linear") => ok([text(), shape({ gradient: { type, angle, stops } })]);
    expect([g([{ at: 0, color: "accent" }]), g(Array(4).fill(0).map((_, i) => ({ at: i / 4, color: "accent" }))), g([{ at: 0.6, color: "accent" }, { at: 0.2, color: "muted" }]), g([{ at: 0, color: "#ff0000" }, { at: 1, color: "accent" }]), g([{ at: 0, color: "accent" }, { at: 1, color: "muted" }], 361), g([{ at: 0, color: "accent" }, { at: 1, color: "muted" }], 0, "radial")]).toEqual(Array(6).fill(false));
  });
  it("a glow and a blend are small, named things", () => {
    expect(ok([text(), shape({ glow: { color: "accent", radius: 0.03, strength: 0.6 }, blend: "screen" })])).toBe(true);
    expect(ok([text(), shape({ blend: "add" })])).toBe(true);
    for (const bad of [{ glow: { color: "accent", radius: 0.5, strength: 0.6 } }, { glow: { color: "accent", radius: 0.03, strength: 2 } }, { glow: { color: "#ffffff", radius: 0.03, strength: 0.6 } }, { blend: "multiply" }]) expect(ok([text(), shape(bad)])).toBe(false);
  });
});

describe("old plans are untouched by the new kinds and fields", () => {
  it("a text and a shape with none of the new fields parse to JSON with no new keys", () => {
    const out = SceneVisual.parse({ block: "composition", intent: "x", elements: [text(), shape()] }) as Comp;
    const keys = out.elements.flatMap((e) => Object.keys(e));
    for (const k of ["tracks", "pivot", "parent", "gradient", "glow", "blend", "stagger_children", "asset_ref"]) expect(keys, k).not.toContain(k);
  });
});
