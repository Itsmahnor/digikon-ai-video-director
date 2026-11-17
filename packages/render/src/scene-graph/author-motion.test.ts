import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILDING_BLOCKS as B, SceneGraphV2, SceneVisual, type Composition } from "@digikon/contracts";
import type { z } from "zod";
import { DEFAULT_PALETTE } from "../composition.js";
import { EXAMPLE_VISUALS } from "../composition-examples.js";
import { ESTIMATE_METER } from "../font-metrics.js";
import { authorGraph } from "./author.js";
import { compileScene, sampleScene } from "./compile.js";
import { validateSceneGraph } from "./validate.js";

type Comp = z.infer<typeof Composition>;
const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const comp = (elements: unknown[]) => SceneVisual.parse({ block: "composition", intent: "test layout", camera: "static", reveal: "none", backdrop: "flat", elements }) as Comp;
const frame = { width: 1280, height: 720, fps: 30, duration_s: 4 };
const key = (t: number, value: number, easing?: string) => ({ t, value, ...(easing ? { easing } : {}) });
const headline = (extra: Record<string, unknown> = {}) => ({ id: "h", kind: "text", text: "Hello there", at: { x: 0.1, y: 0.4, w: 0.8 }, size: 0.08, motion: { enter: "fade", delay: 0.1, duration: 0.3 }, ...extra });
const el = (g: ReturnType<typeof authorGraph>, id: string) => g.elements.find((e) => e.id === id)!;
const tr = (g: ReturnType<typeof authorGraph>, id: string, property: string) => el(g, id).timeline.tracks.find((t) => t.property === property);

describe("an old composition compiles to exactly the graph it compiled to before the richer motion fields", () => {
  const golden = JSON.parse(readFileSync(join(root, "tests", "fixtures", "author-graph-golden.json"), "utf8")) as { graphs: Record<string, unknown> };
  const SIZES = [[1280, 720], [720, 1280], [900, 900]] as const;
  const sets: Record<string, () => Comp> = {
    example: () => (EXAMPLE_VISUALS as unknown as Record<string, { visual: Comp }>)["composition"]!.visual,
    messageThread: () => comp(B.messageThread([{ from: "them", text: "Does Tuesday work?" }, { from: "you", text: "Tuesday is fine" }, { from: "them", text: "Or Wednesday?" }])),
    layeredCards: () => comp(B.layeredCards([{ title: "Small batches", detail: "Roasted weekly" }, { title: "Peak flavour" }, { title: "Ships fast", detail: "Within two days" }])),
    endCard: () => comp(B.endCard("Order your first bag", "Morning Roast", "Free shipping this week")),
    processFlow: () => comp(B.processFlow([{ label: "Share times", detail: "Your open slots" }, { label: "Client picks", detail: "One tap" }, { label: "Booked" }])),
    specCallouts: () => comp(B.specCallouts([{ label: "Lightweight foam", detail: "Responsive" }, { label: "Engineered grip" }, { label: "Breathable mesh" }])),
    baseline02: () => {
      const sb = JSON.parse(readFileSync(join(root, "baseline", "02-no-assets-16x9", "storyboard.json"), "utf8").replace(/^﻿/, ""));
      return SceneVisual.parse(sb.scenes.find((s: { visual: { block: string } }) => s.visual.block === "composition").visual) as Comp;
    },
  };
  for (const [name, make] of Object.entries(sets)) for (const [w, h] of SIZES) {
    it(`${name} at ${w}x${h}: same graph, byte for byte`, () => {
      const g = authorGraph(make(), { width: w, height: h, fps: 30, duration_s: 4 });
      expect(JSON.stringify(g)).toBe(JSON.stringify(golden.graphs[`${name}@${w}x${h}`]));
    });
  }
});

describe("keyframed tracks compile into the v2 engine's tracks", () => {
  it("x and y are shares of the frame and become pixels; scale, rotate and opacity pass through", () => {
    const g = authorGraph(comp([headline({ tracks: [{ property: "x", keys: [key(0, -0.25), key(1, 0)] }, { property: "y", keys: [key(0, 0.1), key(1, 0)] }, { property: "rotate", keys: [key(0, -15), key(1, 0)] }, { property: "scale", keys: [key(0, 0.8), key(1, 1)] }] })]), frame);
    expect(tr(g, "h", "x")!.keyframes.map((k) => k.value)).toEqual([-320, 0]);
    expect(tr(g, "h", "y")!.keyframes.map((k) => k.value)).toEqual([72, 0]);
    expect(tr(g, "h", "rotate")!.keyframes.map((k) => k.value)).toEqual([-15, 0]);
    expect(tr(g, "h", "scale")!.keyframes.map((k) => k.value)).toEqual([0.8, 1]);
    expect(SceneGraphV2.safeParse(g).success).toBe(true);
  });

  it("every named easing becomes an engine easing, and a key without one uses the track default", () => {
    const g = authorGraph(comp([headline({ tracks: [{ property: "rotate", keys: [key(0, -30, "spring_bouncy"), key(0.4, 8, "bezier_overshoot"), key(0.7, -3, "bezier_anticipate"), key(1, 0)] }] })]), frame);
    const ks = tr(g, "h", "rotate")!.keyframes;
    expect(ks[0]!.easing).toEqual({ spring: { damping: 9, stiffness: 150, mass: 1, overshoot_clamp: false } });
    expect(ks[1]!.easing).toEqual({ bezier: [0.34, 1.56, 0.64, 1] });
    expect(ks[2]!.easing).toEqual({ bezier: [0.36, 0, 0.66, -0.56] });
    expect(ks[3]!.easing).toBeUndefined();
    expect(SceneGraphV2.safeParse(g).success).toBe(true); // bezier values are inside the engine's limits
  });

  it("keys that do not start at 0 or end at 1 are held to the ends", () => {
    const g = authorGraph(comp([headline({ tracks: [{ property: "scale", keys: [key(0.2, 0.9), key(0.6, 1.1)] }] })]), frame);
    expect(tr(g, "h", "scale")!.keyframes.map((k) => [k.at, k.value])).toEqual([[0, 0.9], [0.2, 0.9], [0.6, 1.1], [1, 1.1]]);
  });

  it("a track replaces the entrance's track for that property and the entrance keeps the others", () => {
    const g = authorGraph(comp([headline({ motion: { enter: "rise", delay: 0.1, duration: 0.3 }, tracks: [{ property: "y", keys: [key(0, 0.2), key(1, 0)] }] })]), frame);
    const props = el(g, "h").timeline.tracks.map((t) => t.property).sort();
    expect(props).toEqual(["opacity", "y"]); // rise gives opacity and y; the Director's y replaces the entrance's y
    expect(tr(g, "h", "y")!.keyframes.map((k) => k.value)).toEqual([144, 0]);
  });

  it("a pivot is carried on the element for the drawing code, and absent when not asked for", () => {
    const g = authorGraph(comp([headline({ pivot: { x: 0, y: 0.5 } }), { ...headline({ id: "plain" }), at: { x: 0.1, y: 0.6, w: 0.8 } }]), frame);
    expect(el(g, "h").props).toMatchObject({ pivot_x: 0, pivot_y: 0.5 });
    expect("pivot_x" in el(g, "plain").props).toBe(false);
  });

  it("the sampled scene follows the keys: a rotation passes through its middle value", () => {
    const g = authorGraph(comp([headline({ motion: { enter: "none", delay: 0, duration: 0.5 }, tracks: [{ property: "rotate", keys: [key(0, -40, "ease_in_out"), key(1, 0)] }, { property: "opacity", keys: [key(0, 1), key(1, 1)] }] })]), frame);
    const c = compileScene(g);
    const at = (f: number) => sampleScene(c, f).elements.find((e) => e.id === "h")!.rotate;
    expect(at(0)).toBeCloseTo(-40, 5);
    expect(at(30)).toBeCloseTo(-20, 0); // halfway through the window of 2 s (frame 30 of a 4 s scene at 30 fps), ease_in_out is at its midpoint
    expect(at(60)).toBeCloseTo(0, 5);
  });

  it("the same checks apply: text that is never fully shown, or runs out of the frame, is refused", () => {
    const meter = ESTIMATE_METER;
    const ok = authorGraph(comp([headline({ tracks: [{ property: "opacity", keys: [key(0, 0), key(1, 1)] }] })]), frame);
    expect(validateSceneGraph(ok, { palette: DEFAULT_PALETTE, meter }).ok).toBe(true);
    const dim = authorGraph(comp([headline({ tracks: [{ property: "opacity", keys: [key(0, 0), key(1, 0.5)] }] })]), frame);
    expect(validateSceneGraph(dim, { palette: DEFAULT_PALETTE, meter }).ok).toBe(false); // never fully shown
    const off = authorGraph(comp([headline({ tracks: [{ property: "x", keys: [key(0, 0), key(1, 1.2)] }] })]), frame);
    const v = validateSceneGraph(off, { palette: DEFAULT_PALETTE, meter });
    expect(v.ok).toBe(false); // ends outside the frame
  });
});
