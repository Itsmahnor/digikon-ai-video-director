import { describe, expect, it } from "vitest";
import { DEFAULT_PALETTE as _unused, planCompositionScenes } from "../composition.js";
import { EXAMPLE_ART_DIRECTION, EXAMPLE_VISUALS } from "../composition-examples.js";
import type { EditorOperation, SceneVisual } from "@digikon/contracts";
import { SceneGraphV2, sceneGraphEnabled } from "@digikon/contracts";
import { compileScene, ease, maskClip, sampleScene, sampleTrack } from "./compile.js";
import { activeWindow, closingSignaturePreset, quoteStatementPreset, statRevealScene, titlePlatePreset } from "./presets.js";
import { validateSceneGraph } from "./validate.js";

void _unused;
const FPS = 30;
const PALETTE = EXAMPLE_ART_DIRECTION.palette;

const job = (visual: SceneVisual, overlay: string | null, [width, height]: readonly [number, number], duration_s = 3) => ({
  render_id: "rn_0000000000000000", settings: { aspect_ratio: width > height ? "16:9" : width === height ? "1:1" : "9:16", width, height, fps: FPS, duration_s, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test" } } as never,
  operations: [{ operation_id: "E1", target_scene_id: "S01", operation_type: "render_graphics_scene", parameters: {}, timing: { start_s: 0, duration_s }, asset_ids: [], audio_cues: [], caption: null } as unknown as EditorOperation],
  templates: { E1: "remotion/scene-composition" }, assets: [], clips: [], asset_info: {}, concept_asset_ids: [], scene_visuals: { S01: { visual, overlay_text: overlay, visual_purpose: "x" } }, art_direction: EXAMPLE_ART_DIRECTION, output_path: "/tmp/out/rn_0000000000000000.mp4",
});
const planned = (block: "title_plate" | "quote_statement" | "closing_signature", size: readonly [number, number]) => {
  const ex = EXAMPLE_VISUALS[block];
  const p = planCompositionScenes(job(ex.visual, ex.overlay_text, size), { outputRoot: "/tmp/out" });
  if (!p.ok) throw new Error(p.issues.join("; "));
  return p.scenes[0]!;
};

// The fixed blocks' own formulas, copied from remotion-compositions/Compositions.jsx, as the reference the presets are compared with.
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const outCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const inOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const makeP = (s: { frames: number; motion: { easing: string; speed: number } }, frame: number) => {
  const T = s.frames / FPS, active = Math.max(0.5, Math.min(T * 0.7, T - 1)), a = frame / FPS / active;
  const e = s.motion.easing === "ease_in_out" ? inOutCubic : outCubic;
  return (start: number, dur: number) => e(clamp((a - start) / Math.max(0.01, Math.min(dur * s.motion.speed, 1 - start))));
};
const SIZES = [[960, 540], [540, 960], [720, 720]] as const;
const FRAMES = [0, 4, 9, 15, 22, 40, 60, 89];

describe("the engine is off unless asked", () => {
  it("SCENE_GRAPH defaults to off and only 'on' turns it on", () => {
    expect(sceneGraphEnabled({})).toBe(false);
    expect(sceneGraphEnabled({ SCENE_GRAPH: "off" })).toBe(false);
    expect(sceneGraphEnabled({ SCENE_GRAPH: "1" })).toBe(false);
    expect(sceneGraphEnabled({ SCENE_GRAPH: "on" })).toBe(true);
  });
  it("the version 1 draft graph is untouched and a version 2 graph is a different format version", () => {
    expect(SceneGraphV2.safeParse({ format: "digikon.scene-graph", format_version: 1 }).success).toBe(false);
  });
});

describe("easing and tracks", () => {
  it("named easings match the cubics the fixed blocks use", () => {
    for (const t of [0, 0.2, 0.5, 0.8, 1]) {
      expect(ease("ease_out", t, 30, FPS)).toBeCloseTo(outCubic(t), 9);
      expect(ease("ease_in_out", t, 30, FPS)).toBeCloseTo(inOutCubic(t), 9);
      expect(ease("linear", t, 30, FPS)).toBeCloseTo(t, 9);
    }
  });
  it("a cubic-bezier with the ease-in-out control points is monotone from 0 to 1", () => {
    const e = { bezier: [0.42, 0, 0.58, 1] as [number, number, number, number] };
    let prev = -1;
    for (let i = 0; i <= 10; i++) { const v = ease(e, i / 10, 30, FPS); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
    expect(ease(e, 1, 30, FPS)).toBeCloseTo(1, 6);
  });
  it("a spring overshoots when under-damped, settles on 1, and never overshoots when clamped", () => {
    const loose = { spring: { damping: 6, stiffness: 120, mass: 1, overshoot_clamp: false } };
    const tight = { spring: { damping: 6, stiffness: 120, mass: 1, overshoot_clamp: true } };
    const vals = Array.from({ length: 31 }, (_, i) => ease(loose, i / 30, 30, FPS));
    expect(Math.max(...vals)).toBeGreaterThan(1.02);
    expect(ease(loose, 1, 30, FPS)).toBe(1);
    expect(Math.max(...Array.from({ length: 31 }, (_, i) => ease(tight, i / 30, 30, FPS)))).toBeLessThanOrEqual(1.0001);
  });
  it("a track holds before its first and after its last keyframe and eases each segment with its own curve", () => {
    const tr = { property: "x" as const, easing: "linear" as const, keyframes: [{ at: 0.2, value: 10, easing: "ease_out" as const }, { at: 0.6, value: 50 }, { at: 1, value: 50 }] };
    expect(sampleTrack(tr, 0, 1, FPS)).toBe(10);
    expect(sampleTrack(tr, 0.6, 1, FPS)).toBeCloseTo(50, 6);
    expect(sampleTrack(tr, 0.4, 1, FPS)).toBeCloseTo(10 + 40 * outCubic(0.5), 6);
    expect(sampleTrack(tr, 1, 1, FPS)).toBe(50);
  });
});

describe("stagger, counter, mask and camera", () => {
  const g = statRevealScene({ width: 960, height: 540, headline: "Revenue grew faster than ever", value: 128, suffix: "%", label: "year on year" });
  const c = compileScene(SceneGraphV2.parse(g));
  it("words arrive one after another, from the start", () => {
    const s = sampleScene(c, 8).elements.find((e) => e.id === "headline")!;
    const ops = s.units!.map((u) => u.opacity);
    expect(s.units!.map((u) => u.text).join("")).toBe("Revenue grew faster than ever");
    for (let i = 1; i < ops.length; i++) expect(ops[i]!).toBeLessThanOrEqual(ops[i - 1]! + 1e-9);
    expect(ops[0]).toBeGreaterThan(ops[ops.length - 1]!);
  });
  it("stagger from the end and from the centre change the order, not the count", () => {
    const mk = (from: "end" | "center") => {
      const e = JSON.parse(JSON.stringify(g)) as typeof g;
      e.elements[0]!.stagger = { unit: "char", each_s: 0.02, from };
      e.elements[0]!.props = { ...e.elements[0]!.props, text: "ABCDE" };
      return sampleScene(compileScene(SceneGraphV2.parse(e)), 6).elements[0]!.units!.map((u) => u.opacity);
    };
    const end = mk("end"), centre = mk("center");
    expect(end[4]).toBeGreaterThanOrEqual(end[0]!);
    expect(centre[2]).toBeGreaterThanOrEqual(centre[0]!);
    expect(centre[2]).toBeGreaterThanOrEqual(centre[4]!);
  });
  it("the counter counts from 0 to the value, monotonically, and ends on it", () => {
    const seen = Array.from({ length: c.frames }, (_, f) => Number.parseFloat(sampleScene(c, f).elements.find((e) => e.id === "number")!.text ?? "0"));
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(seen[0]).toBe(0);
    expect(sampleScene(c, c.frames - 1).elements.find((e) => e.id === "number")!.text).toBe("128%");
  });
  it("the mask reveals from nothing to everything and its children are clipped by it", () => {
    expect(maskClip("left", 0)).toBe("inset(0 100% 0 0)");
    expect(maskClip("left", 1)).toBe("inset(0 0% 0 0)");
    expect(maskClip("circle", 1)).toContain("75.00%");
    const p0 = sampleScene(c, 20).elements.find((e) => e.id === "reveal")!.progress;
    const p1 = sampleScene(c, c.frames - 1).elements.find((e) => e.id === "reveal")!.progress;
    expect(p0).toBeLessThan(1); expect(p1).toBe(1);
  });
  it("the camera zooms slowly and sampling is a pure function of the frame", () => {
    expect(sampleScene(c, 0).camera.scale).toBe(1);
    expect(sampleScene(c, c.frames - 1).camera.scale).toBeCloseTo(1.04, 2);
    expect(JSON.stringify(sampleScene(c, 37))).toBe(JSON.stringify(sampleScene(c, 37)));
  });
  it("an element is not drawn before it starts", () => {
    expect(sampleScene(c, 0).elements.find((e) => e.id === "number")!.visible).toBe(false);
    expect(sampleScene(c, 60).elements.find((e) => e.id === "number")!.visible).toBe(true);
  });
});

describe("parity with the fixed blocks (compiled timeline against the block's own formulas)", () => {
  for (const size of SIZES) {
    it(`title_plate at ${size.join("x")}: layout equals the plan; lines arrive at the block's times, eased the same`, () => {
      const s = planned("title_plate", size), g = SceneGraphV2.parse(titlePlatePreset(s, FPS)), c = compileScene(g);
      const head = g.elements.find((e) => e.id === "headline")!.props as { x: number; y: number; font_px: number };
      expect(head.font_px).toBe(s.headline!.font_px);
      expect(head.x).toBe(s.headline!.box.x);
      expect(g.duration_s * FPS).toBe(s.frames);
      for (const f of FRAMES.filter((f) => f < s.frames)) {
        const p = makeP(s, f), st = sampleScene(c, f).elements.find((e) => e.id === "headline")!;
        s.headline!.lines.forEach((_l, i) => {
          const k = p(0.05 + i * 0.1, 0.55), u = st.units![i]!;
          expect(Math.abs(u.opacity - clamp(k * 1.6))).toBeLessThan(0.13);
          expect(u.y).toBeCloseTo((1 - k) * s.headline!.font_px * 0.12, 4);
          expect(u.tracking).toBeCloseTo((1 - k) * 0.09, 6);
        });
      }
      const last = sampleScene(c, s.frames - 1).elements.find((e) => e.id === "headline")!;
      for (const u of last.units!) { expect(u.opacity).toBe(1); expect(u.y).toBeCloseTo(0, 6); }
    });
    it(`quote_statement at ${size.join("x")}`, () => {
      const s = planned("quote_statement", size), c = compileScene(SceneGraphV2.parse(quoteStatementPreset(s, FPS)));
      for (const f of FRAMES.filter((f) => f < s.frames)) {
        const p = makeP(s, f), st = sampleScene(c, f).elements.find((e) => e.id === "quote")!;
        s.headline!.lines.forEach((_l, i) => {
          const k = p(0.08 + i * 0.12, 0.3), u = st.units![i]!;
          expect(Math.abs(u.opacity - clamp(k * 1.5))).toBeLessThan(0.13);
          expect(u.x).toBeCloseTo((1 - k) * s.headline!.font_px * 0.4, 4);
        });
        const by = sampleScene(c, f).elements.find((e) => e.id === "attribution");
        if (by) expect(by.opacity).toBeCloseTo(p(0.65, 0.25), 6);
      }
    });
    it(`closing_signature at ${size.join("x")}`, () => {
      const s = planned("closing_signature", size), c = compileScene(SceneGraphV2.parse(closingSignaturePreset(s, FPS)));
      for (const f of FRAMES.filter((f) => f < s.frames)) {
        const p = makeP(s, f), st = new Map(sampleScene(c, f).elements.map((e) => [e.id, e]));
        if (st.has("wordmark")) { expect(st.get("wordmark")!.opacity).toBeCloseTo(p(0, 0.4), 6); expect(st.get("wordmark")!.tracking).toBeCloseTo(0.14 - 0.1 * p(0, 0.6), 6); }
        expect(st.get("action")!.opacity).toBeCloseTo(p(0.5, 0.3), 6);
        if (st.has("line")) expect(st.get("line")!.opacity).toBeCloseTo(p(0.3, 0.3), 6);
      }
    });
    it(`all three presets at ${size.join("x")} pass the same validation the blocks are planned under`, () => {
      for (const [block, make] of [["title_plate", titlePlatePreset], ["quote_statement", quoteStatementPreset], ["closing_signature", closingSignaturePreset]] as const) {
        const v = validateSceneGraph(make(planned(block, size), FPS), { palette: PALETTE });
        // The planner checks the text colour against the background only. The graph validator also checks every text's own colour, and finds that the
        // example palette's accent (#e8590c) is 3.2:1 on its background: the closing line's action is drawn in it by the fixed block too.
        expect(v.issues.filter((i) => !/^action: text colour #e8590c/.test(i)), `${block} ${size.join("x")}`).toEqual([]);
      }
    });
    it(`with an accent that is legible the closing signature at ${size.join("x")} passes outright`, () => {
      const dark = { ...PALETTE, accent: "#b8430a" };
      expect(validateSceneGraph(closingSignaturePreset(planned("closing_signature", size), FPS), { palette: dark }).issues).toEqual([]);
    });
  }
  it("the active window the presets use is the block's (first 70%, at least 0.5s, end held)", () => {
    expect(activeWindow(90, 30)).toBeCloseTo(2, 9);
    expect(activeWindow(300, 30)).toBeCloseTo(7, 9);
    expect(activeWindow(15, 30)).toBeCloseTo(0.5, 9);
  });
});

describe("the new scene: type + shape + mask reveal + number counter in one", () => {
  for (const size of SIZES) it(`validates at ${size.join("x")} and ends fully shown`, () => {
    const g = statRevealScene({ width: size[0], height: size[1], headline: "Revenue grew faster than ever", value: 128, suffix: "%", label: "year on year" });
    const v = validateSceneGraph(g, { palette: PALETTE });
    expect(v.issues).toEqual([]);
    const kinds = new Set(g.elements.map((e) => e.kind));
    for (const k of ["text", "shape", "mask"]) expect(kinds.has(k as never)).toBe(true);
    expect(g.elements.some((e) => (e.props as { counter?: unknown }).counter)).toBe(true);
  });
  it("is refused when the headline is far too long to fit its box", () => {
    const g = statRevealScene({ width: 540, height: 960, headline: "Supercalifragilisticexpialidocious ".repeat(1) + "x".repeat(60), value: 5, label: "l" });
    expect(validateSceneGraph(g, { palette: PALETTE }).ok).toBe(false);
  });
  it("is refused when the scene is too short to hold the last text for reading", () => {
    const g = statRevealScene({ width: 960, height: 540, headline: "Short", value: 5, label: "l", duration_s: 3 });
    const v = validateSceneGraph(g, { palette: PALETTE });
    expect(v.ok ? "" : v.issues.join(" ")).toMatch(/needs 0\.8s|after the 3s scene/);
  });
});

describe("the validator refuses what a viewer could not read or follow", () => {
  const base = () => JSON.parse(JSON.stringify(statRevealScene({ width: 960, height: 540, headline: "Revenue grew", value: 5, label: "year" })));
  const issues = (g: unknown, extra: Partial<Parameters<typeof validateSceneGraph>[1]> = {}) => validateSceneGraph(g, { palette: PALETTE, ...extra }).issues.join(" | ");
  it("a malformed graph is reported by its path", () => { expect(issues({ format: "digikon.scene-graph" })).toContain("format_version"); });
  it("a parent cycle, a missing parent and a non-group parent are refused", () => {
    const g = base(); g.elements[3].parent = "nope"; expect(issues(g)).toContain("does not exist");
    const h = base(); h.elements[3].parent = "headline"; expect(issues(h)).toContain("not a group or mask");
  });
  it("an element that outlasts the scene is refused", () => { const g = base(); g.elements[6].timeline.duration_s = 9; expect(issues(g)).toContain("after the 4s scene"); });
  it("text below the legibility floor is refused", () => { const g = base(); g.elements[6].props.font_px = 9; expect(issues(g)).toContain("below the"); });
  it("low contrast is refused", () => { const g = base(); g.elements[6].props.color = "#f6f2ea"; expect(issues(g)).toContain("contrast"); });
  it("text outside the safe area is refused", () => { const g = base(); g.elements[6].props.x = 900; expect(issues(g)).toContain("leaves the area"); });
  it("two texts on top of each other are refused", () => { const g = base(); g.elements[6].props.y = g.elements[5].props.y; g.elements[6].props.x = g.elements[5].props.x; expect(issues(g)).toContain("overlaps"); });
  it("a counter or mask with no progress track is refused", () => {
    const g = base(); g.elements[5].timeline.tracks = g.elements[5].timeline.tracks.filter((t: { property: string }) => t.property !== "progress"); expect(issues(g)).toContain("no progress track");
    const m = base(); m.elements[2].timeline.tracks = []; expect(issues(m)).toContain("mask and has no progress");
  });
  it("opacity out of range, keyframes not spanning 0..1 and an impossible speed are refused", () => {
    const g = base(); g.elements[6].timeline.tracks[0].keyframes[1].value = 2; expect(issues(g)).toContain("opacity must stay");
    const k = base(); k.elements[0].timeline.tracks[1].keyframes[1].at = 0.9; expect(issues(k)).toContain("keyframes must run from 0 to 1");
    const v = base(); v.elements[0].timeline.tracks[1].keyframes = [{ at: 0, value: 0 }, { at: 1, value: 99999 }]; expect(issues(v)).toContain("faster than");
  });
  it("an unknown asset is refused when the available assets are given", () => {
    const g = base(); g.elements.push({ id: "pic", kind: "image", parent: null, props: { asset_ref: "asset_9", x: 0, y: 0, w: 100, h: 100 }, timeline: { start_s: 0, duration_s: 1, tracks: [] }, bindings: {} });
    expect(issues(g, { assets: new Set(["asset_1"]) })).toContain("not an available asset");
    expect(issues(g, { assets: new Set(["asset_9"]) })).toBe("");
  });
  it("an out-of-range spring is a contract error", () => {
    const g = base(); g.elements[0].timeline.tracks[1].easing = { spring: { damping: 0, stiffness: 100, mass: 1 } }; expect(validateSceneGraph(g, { palette: PALETTE }).ok).toBe(false);
  });
});
