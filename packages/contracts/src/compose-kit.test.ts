import { describe, expect, it } from "vitest";
import { Composition, compositionQualityIssues, compositionStructureIssues, creativeIssues, type SceneVisual } from "./visual.js";

const mo = (enter = "fade") => ({ enter, delay: 0, duration: 0.2, easing: "ease_out" });
const text = (id: string, x: number, y: number, extra: object = {}) => ({ id, kind: "text", text: "word", at: { x, y, w: 0.3 }, size: 0.06, motion: mo(), ...extra });
const comp = (elements: object[]): Extract<SceneVisual, { block: "composition" }> => Composition.parse({ block: "composition", intent: "i", camera: "static", reveal: "none", backdrop: "flat", elements });
const scene = (id: string, visual: SceneVisual, d = 4) => ({ scene_id: id, visual, duration_seconds: d, visual_purpose: id, overlay: { text: "x" }, claim_ids: [], asset_ids: [] });

describe("the wider composition kit", () => {
  it("accepts the new entrances, easings, stagger origin, groups and masks", () => {
    const c = comp([
      { id: "g", kind: "group", at: { x: 0.5, y: 0.2 }, motion: mo("rotate_in") },
      text("a", 0.52, 0.22, { parent: "g", motion: { enter: "pop", delay: 0, duration: 0.2, easing: "bouncy", stagger: { unit: "word", each: 0.02, from: "center" } } }),
      { id: "m", kind: "mask", reveal: "circle", at: { x: 0.1, y: 0.5, w: 0.3, h: 0.2 }, motion: mo("fade") },
      { id: "b", kind: "shape", parent: "m", shape: "ellipse", at: { x: 0.1, y: 0.5, w: 0.3, h: 0.2 }, fill: "accent", motion: mo("zoom_out") },
    ]);
    expect(compositionStructureIssues(c)).toEqual([]);
  });
  it("sends back a parent that is missing, listed after its child, or a container with no children", () => {
    expect(compositionStructureIssues(comp([text("a", 0.1, 0.1, { parent: "ghost" })]))).toEqual([expect.stringContaining("parent ghost is not a group or mask")]);
    expect(compositionStructureIssues(comp([text("a", 0.1, 0.1, { parent: "g" }), { id: "g", kind: "group", at: { x: 0, y: 0 }, motion: mo() }]))).toEqual([expect.stringContaining("must be listed before it")]);
    expect(compositionStructureIssues(comp([text("a", 0.1, 0.1), { id: "g", kind: "group", at: { x: 0, y: 0 }, motion: mo() }]))).toEqual([expect.stringContaining("no children")]);
  });
});

describe("taste checks for composed scenes", () => {
  const left = comp([text("t", 0.05, 0.1), { id: "s", kind: "shape", shape: "rect", at: { x: 0.05, y: 0.6, w: 0.3, h: 0.2 }, fill: "accent", motion: mo() }]);
  const right = comp([text("t", 0.6, 0.7, { motion: mo("pop") }), { id: "s", kind: "shape", shape: "rect", at: { x: 0.6, y: 0.1, w: 0.3, h: 0.2 }, fill: "accent", motion: mo("wipe") }]);
  it("flags three neighbouring scenes with one skeleton, too few kinds of entrance, and a flat rhythm", () => {
    const issues = compositionQualityIssues([scene("S01", left), scene("S02", left), scene("S03", left), scene("S04", left)]).map((i) => i.code);
    expect(issues).toEqual(expect.arrayContaining(["repeated_skeleton", "few_arrivals", "flat_rhythm"]));
  });
  it("lets a varied film through", () => {
    const withEnter = (c: typeof left, e: string) => ({ ...c, elements: c.elements.map((el) => ({ ...el, motion: { ...el.motion, enter: e } })) }) as typeof left;
    const film = [scene("S01", withEnter(left, "rise"), 3), scene("S02", right, 5), scene("S03", withEnter(left, "tracking_in"), 4), scene("S04", right, 6)];
    expect(compositionQualityIssues(film)).toEqual([]);
  });
  it("is part of the creative checks once the treatment has art direction", () => {
    const art = { visual_system: null } as never;
    const flat = creativeIssues([scene("S01", left), scene("S02", left), scene("S03", left), scene("S04", left)], art).map((i) => i.code);
    expect(flat).toContain("repeated_skeleton");
  });
});

import { maxNarrationWords, narrationFitIssues, NARRATION_WORDS_PER_SECOND } from "./sound-policy.js";
describe("a voice-over has to fit its scene", () => {
  it("allows 2.8 words a second, and says how many words a scene can hold", () => {
    expect(NARRATION_WORDS_PER_SECOND).toBe(2.8);
    expect([4, 6, 8, 10].map(maxNarrationWords)).toEqual([11, 16, 22, 28]);
  });
  it("sends back 24 words in an 8 second scene, and accepts 22", () => {
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    expect(narrationFitIssues([{ scene_id: "S03", duration_seconds: 8, voiceover: words(24) }])).toEqual([expect.stringContaining("S03: voiceover_too_long - the voiceover has 24 words, but a 8s scene holds at most 22 words")]);
    expect(narrationFitIssues([{ scene_id: "S03", duration_seconds: 8, voiceover: words(22) }, { scene_id: "S04", duration_seconds: 4, voiceover: null }])).toEqual([]);
  });
});
