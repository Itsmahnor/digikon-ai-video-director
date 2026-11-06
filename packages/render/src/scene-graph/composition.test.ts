import { describe, expect, it } from "vitest";
import { BUILDING_BLOCKS as B, SceneVisual, compositionGroundingIssues, type EditorOperation } from "@digikon/contracts";
import { EXAMPLE_ART_DIRECTION, EXAMPLE_VISUALS } from "../composition-examples.js";
import { jobVisuals, planCompositionScenes } from "../composition.js";

const job = (visual: SceneVisual, overlay: string | null, [width, height]: readonly [number, number], seconds = 4) => ({
  render_id: "rn_0000000000000000", settings: { aspect_ratio: width > height ? "16:9" : width === height ? "1:1" : "9:16", width, height, fps: 30, duration_s: seconds, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test" } },
  operations: [{ operation_id: "E1", target_scene_id: "S01", operation_type: "render_graphics_scene", parameters: {}, timing: { start_s: 0, duration_s: seconds }, asset_ids: [], audio_cues: [], caption: null } as unknown as EditorOperation],
  templates: { E1: "remotion/scene-composition" }, assets: [], clips: [], asset_info: {}, concept_asset_ids: [], scene_visuals: { S01: { visual, overlay_text: overlay, visual_purpose: "x" } }, art_direction: EXAMPLE_ART_DIRECTION, output_path: "/tmp/out/rn_0000000000000000.mp4",
}) as never;
const plan = (v: SceneVisual, size: readonly [number, number], overlay: string | null = null, seconds = 4) => planCompositionScenes(job(v, overlay, size, seconds), { outputRoot: "/tmp/out" });
const comp = (elements: unknown[]) => SceneVisual.parse({ block: "composition", intent: "test layout", camera: "static", reveal: "none", backdrop: "flat", elements });

const SIZES = [[1280, 720], [720, 1280], [900, 900]] as const;
const SAMPLES: Record<keyof typeof B, unknown[]> = {
  messageThread: B.messageThread([{ from: "them", text: "Does Tuesday work?" }, { from: "you", text: "Tuesday is fine" }, { from: "them", text: "Or Wednesday?" }]),
  uiWindow: B.uiWindow("Booking page", [{ label: "Tue 10:00", tag: "Open" }, { label: "Wed 14:30" }, { label: "Thu 09:00", tag: "Busy" }], "Booked"),
  processFlow: B.processFlow([{ label: "Share times", detail: "Your open slots" }, { label: "Client picks", detail: "One tap" }, { label: "Booked" }]),
  barChart: B.barChart("Fewer messages", [{ label: "Mon", value: 80 }, { label: "Tue", value: 55 }, { label: "Wed", value: 30 }, { label: "Thu", value: 15 }]),
  kineticHeadline: B.kineticHeadline("Roasted weekly in small batches", "weekly"),
  layeredCards: B.layeredCards([{ title: "Small batches", detail: "Roasted weekly" }, { title: "Peak flavour" }, { title: "Ships fast", detail: "Within two days" }]),
  endCard: B.endCard("Order your first bag", "Morning Roast", "Free shipping this week"),
  specCallouts: B.specCallouts([{ label: "Lightweight foam", detail: "Responsive" }, { label: "Engineered grip" }, { label: "Breathable mesh" }]),
  splitPanels: B.splitPanels([{ word: "Fresh", note: "Roasted weekly" }, { word: "Local" }, { word: "Fair" }]),
  routeLine: B.routeLine([{ label: "Farm", note: "Hand picked" }, { label: "Roastery" }, { label: "Your door", note: "In two days" }]),
  timelineRule: B.timelineRule([{ when: "Mon", label: "Roasted" }, { when: "Tue", label: "Packed" }, { when: "Thu", label: "Delivered" }]),
  titleBlock: B.titleBlock("Coffee worth waking up for", "Small batch", "Roasted weekly"),
  quoteBlock: B.quoteBlock("The best cup I have had at home", "A customer"),
  closingBlock: B.closingBlock("Order your first bag", "Morning Roast", "Free shipping this week"),
};

describe("every building block is a valid composition, in landscape, portrait and square", () => {
  for (const [name, elements] of Object.entries(SAMPLES)) for (const size of SIZES) {
    it(`${name} at ${size.join("x")}`, () => {
      const p = plan(comp(elements), size);
      expect(p.ok ? [] : p.issues).toEqual([]);
    });
  }
});

describe("a composition is planned as a scene graph in pixels", () => {
  it("the planner attaches the graph, in the frame's own size, with the plan's elements", () => {
    const ex = EXAMPLE_VISUALS.composition;
    const p = plan(ex.visual, [1280, 720], ex.overlay_text);
    if (!p.ok) throw new Error(p.issues.join("; "));
    const g = (p.scenes[0]!.geom as { graph: { canvas: { width: number; height: number }; elements: { id: string; props: { x: number; font_px?: number } }[] } }).graph;
    expect(g.canvas).toMatchObject({ width: 1280, height: 720 });
    const headline = g.elements.find((e) => e.id === "headline")!;
    expect(headline.props.x).toBeCloseTo(0.08 * 1280, 5);
    expect(headline.props.font_px).toBeCloseTo(0.055 * 720, 5);
  });
  it("a portrait frame uses the portrait override, a landscape frame does not", () => {
    const v = comp([{ id: "t", kind: "text", text: "Hello there", at: { x: 0.1, y: 0.4, w: 0.5 }, size: 0.08, portrait: { x: 0.05, w: 0.9, size: 0.1 } }]);
    const pos = (size: readonly [number, number]) => { const p = plan(v, size); if (!p.ok) throw new Error(p.issues.join("; ")); const e = (p.scenes[0]!.geom as { graph: { elements: { props: { x: number; w: number; font_px: number } }[] } }).graph.elements[0]!.props; return [e.x / size[0], e.w / size[0], e.font_px / Math.min(...size)]; };
    expect(pos([1280, 720])).toEqual([expect.closeTo(0.1, 5), expect.closeTo(0.5, 5), expect.closeTo(0.08, 5)]);
    expect(pos([720, 1280])).toEqual([expect.closeTo(0.05, 5), expect.closeTo(0.9, 5), expect.closeTo(0.1, 5)]);
  });
  it("refuses a layout that leaves the frame, text too small to read, and motion that is not finished in time", () => {
    const off = plan(comp([{ id: "t", kind: "text", text: "Off the edge", at: { x: 0.9, y: 0.4, w: 0.5 }, size: 0.08 }]), [1280, 720]);
    expect(off.ok).toBe(false);
    const tiny = plan(comp([{ id: "t", kind: "text", text: "Too small to read", at: { x: 0.1, y: 0.4, w: 0.8 }, size: 0.012 }]), [1280, 720]);
    expect(tiny.ok).toBe(false);
    const late = plan(comp([{ id: "t", kind: "text", text: "Too late", at: { x: 0.1, y: 0.4, w: 0.8 }, size: 0.08, motion: { enter: "fade", delay: 0.9, duration: 0.5 } }]), [1280, 720]);
    expect(late.ok).toBe(false);
  });
});

describe("a composition's words must come from the scene's approved text", () => {
  const ctx = { overlay: "Roasted weekly in small batches", voiceover: null, claims: ["Beans are roasted every week."], facts: ["Ships within two days."], brief: "A 12 second ad for my coffee roaster.", treatment: ["Fresh coffee, delivered."] };
  const v = (text: string) => comp([{ id: "t", kind: "text", text, at: { x: 0.1, y: 0.4, w: 0.8 }, size: 0.08 }]) as Extract<SceneVisual, { block: "composition" }>;
  it("accepts the overlay, a claim, a fact and a fragment of them", () => {
    for (const t of ["Roasted weekly in small batches", "small batches", "Ships within two days.", "Beans are roasted every week", "Fresh coffee"]) expect(compositionGroundingIssues(v(t), ctx), t).toEqual([]);
  });
  it("rejects invented copy and invented figures", () => {
    expect(compositionGroundingIssues(v("The world's best espresso, guaranteed"), ctx)[0]).toContain("is not in the scene's approved text");
    expect(compositionGroundingIssues(v("Roasted weekly 50% off"), ctx).join(" ")).toContain("figure 50");
    expect(compositionGroundingIssues(v("Ships within 3 days"), ctx).join(" ")).toContain("figure 3");
  });
  it("needs at least one text element and unique ids", () => {
    const shapeOnly = SceneVisual.parse({ block: "composition", intent: "x", elements: [{ id: "s", kind: "shape", shape: "rect", at: { x: 0, y: 0, w: 1, h: 1 }, fill: "accent" }] }) as Extract<SceneVisual, { block: "composition" }>;
    expect(compositionGroundingIssues(shapeOnly, ctx).join(" ")).toContain("at least one text element");
    const dup = SceneVisual.parse({ block: "composition", intent: "x", elements: [{ id: "a", kind: "text", text: "Fresh coffee", at: { x: 0.1, y: 0.1, w: 0.5 }, size: 0.05 }, { id: "a", kind: "text", text: "Fresh coffee", at: { x: 0.1, y: 0.5, w: 0.5 }, size: 0.05 }] }) as Extract<SceneVisual, { block: "composition" }>;
    expect(compositionGroundingIssues(dup, ctx).join(" ")).toContain("duplicate element id a");
  });
});

describe("the edit plan's motion is laid over the approved composition when the scene is planned", () => {
  const visual = comp([
    { id: "head", kind: "text", text: "Roasted weekly in small batches", at: { x: 0.1, y: 0.3, w: 0.8 }, size: 0.08, motion: { enter: "fade", delay: 0, duration: 0.2 } },
    { id: "bar", kind: "shape", shape: "rect", at: { x: 0.1, y: 0.7, w: 0.3, h: 0.02 }, fill: "accent", motion: { enter: "fade", delay: 0, duration: 0.2 } },
  ]);
  const handoff = (motion?: unknown) => ({ storyboard: { scenes: [{ scene_id: "S01", visual, visual_purpose: "x", overlay: null }] }, treatment: { art_direction: EXAMPLE_ART_DIRECTION }, ...(motion ? { edit_plan: { composition_motion: motion } } : {}) }) as never;
  const graphOf = (motion?: unknown) => {
    const j = job(visual, null, [1280, 720]) as unknown as Record<string, unknown>;
    const p = planCompositionScenes({ ...j, ...jobVisuals(handoff(motion)) } as never, { outputRoot: "/tmp/out" });
    if (!p.ok) throw new Error(p.issues.join("; "));
    return (p.scenes[0]!.geom as { graph: { elements: { id: string; props: Record<string, unknown>; timeline: { start_s: number; duration_s: number; tracks: { property: string }[] }; stagger?: { unit: string } }[] } }).graph;
  };
  it("changes how the elements arrive, and nothing about what they say or where they sit", () => {
    const before = graphOf(), after = graphOf([{ scene_id: "S01", rationale: "rhythm", elements: [{ id: "head", motion: { enter: "rise", easing: "spring", delay: 0.2, stagger: { unit: "word", each: 0.03 } } }] }]);
    const h0 = before.elements.find((e) => e.id === "head")!, h1 = after.elements.find((e) => e.id === "head")!;
    expect(h1.stagger).toMatchObject({ unit: "word" });
    expect(h0.stagger).toBeUndefined();
    expect(h1.timeline.start_s).toBeCloseTo(0.2 * 4, 5);
    expect(h1.timeline.tracks.map((t) => t.property)).toContain("y"); // "rise" moves it; "fade" did not
    expect(h0.timeline.tracks.map((t) => t.property)).not.toContain("y");
    expect(h1.props).toEqual(h0.props); // text, position, size, colour: unchanged
    expect(after.elements.find((e) => e.id === "bar")).toEqual(before.elements.find((e) => e.id === "bar"));
  });
  it("a patched scene that can no longer be read is refused by the planner, like any other composition", () => {
    const j = job(visual, null, [1280, 720]) as unknown as Record<string, unknown>;
    const late = planCompositionScenes({ ...j, ...jobVisuals(handoff([{ scene_id: "S01", rationale: "too slow", elements: [{ id: "head", motion: { delay: 0.9, duration: 0.5 } }] }])) } as never, { outputRoot: "/tmp/out" });
    expect(late.ok).toBe(false);
  });
});