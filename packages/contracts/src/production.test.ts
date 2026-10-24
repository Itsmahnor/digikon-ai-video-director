import { describe, expect, it } from "vitest";
import { Asset, Project, RUNTIME_TOLERANCE_S, Scene, ScenePlan, assetFeasibility, deriveProductionMethod, validatePlan } from "./index.js";

// The 30-second, 16:9 online-learning explainer from the latest run: six scenes of 4, 5, 4, 6, 6 and 5 seconds, no supplied files.
const project = Project.parse({
  project_id: "learn1", owner_id: "u", brief: "30 second explainer for an online learning platform", objective: "Explain the platform",
  audience: "Students", platform: "YouTube", aspect_ratio: "16:9", target_duration: 30,
});
const shot = { shot_size: "wide", camera_motion: "static", visual_action: "Animated dark desktop view" };
const gfx = (need: string, over: Record<string, unknown> = {}) => ({ need, kind: "graphics", availability: "generate_graphics", ...over });
const mk = (id: string, start: number, dur: number, extra: Record<string, unknown> = {}) =>
  Scene.parse({ scene_id: id, purpose: "p", start_time: start, end_time: start + dur, duration_seconds: dur, shot, transition_out: "cut", required_assets: [gfx("Animated graphics")], ...extra });
const DURATIONS = [4, 5, 4, 6, 6, 5];
const sixScenes = (last = 5) => {
  let t = 0;
  return DURATIONS.map((d, i) => { const dur = i === 5 ? last : d; const s = mk(`S0${i + 1}`, t, dur); t += dur; return s; });
};
const plan = (scenes: Scene[]) => ScenePlan.parse({ project_id: "learn1", version: 1, scenes });
const codes = (scenes: Scene[], assets: Asset[] = [], p = project) => validatePlan(plan(scenes), assets, p).map((i) => i.code);
const clip = Asset.parse({ asset_id: "asset_clip", uri: "clip.mp4", media_type: "video", duration: 20, width: 1920, height: 1080 });
const logo = Asset.parse({ asset_id: "asset_logo", uri: "logo.png", media_type: "image", duration: null, width: 800, height: 800 });

describe("timing contract", () => {
  it("accepts the six-scene, 30-second storyboard with consistent start and end times", () => {
    const scenes = sixScenes();
    expect(scenes).toHaveLength(6);
    expect(scenes.reduce((a, s) => a + s.duration_seconds, 0)).toBe(30);
    expect(scenes.every((s) => s.end_time === s.start_time + s.duration_seconds)).toBe(true);
    expect(scenes.map((s) => s.start_time)).toEqual([0, 4, 9, 13, 19, 25]);
    expect(codes(scenes)).toEqual([]);
  });

  it("rejects non-positive durations when the scene is parsed", () => {
    expect(() => mk("S01", 0, 0)).toThrow();
    expect(() => mk("S01", 0, -3)).toThrow();
  });

  it("rejects overlaps, gaps and scenes listed out of order", () => {
    const overlap = sixScenes(); overlap[2] = mk("S03", 8, 4);
    expect(codes(overlap)).toContain("overlap");
    const gap = sixScenes(); gap[2] = mk("S03", 10, 4);
    expect(codes(gap)).toContain("gap");
    expect(codes([...sixScenes()].reverse())).toContain("out_of_order"); // right times, wrong listing order
  });

  it("holds the total to the requested runtime within rounding only", () => {
    expect(RUNTIME_TOLERANCE_S).toBe(0.05);
    expect(codes(sixScenes(4.9))).toContain("under_duration"); // 29.9 s
    expect(codes(sixScenes(5.2))).toContain("over_duration"); // 30.2 s
    expect(codes(sixScenes(5.04))).toEqual([]); // 30.04 s is rounding
  });

  it("rejects an end time that disagrees with start plus duration", () => {
    const bad = sixScenes(); bad[1] = mk("S02", 4, 5, { end_time: 10 });
    expect(codes(bad)).toContain("timestamp_inconsistent");
  });
});

describe("required assets and feasibility", () => {
  const scenes = [
    mk("S01", 0, 6, { asset_ids: ["asset_clip"], required_assets: [{ need: "Product demo clip", kind: "footage", availability: "supplied", asset_id: "asset_clip" }] }),
    mk("S02", 6, 6, { required_assets: [gfx("Windows piling up on a dark desktop")] }), // graphics-led, nothing supplied
    mk("S03", 12, 6, { required_assets: [gfx("Brand logo card", { kind: "logo", placeholder: true })], unresolved: [{ kind: "placeholder", note: "No logo supplied: a generic wordmark card is shown." }] }),
    mk("S04", 18, 6, { required_assets: [{ need: "A student closing a laptop", kind: "footage", availability: "needs_external", fallback: "End on the logo card alone" }] }),
    mk("S05", 24, 6, { required_assets: [{ need: "Real product dashboard", kind: "ui_screenshot", availability: "missing_blocking" }] }),
  ];
  const report = assetFeasibility(plan(scenes), [clip]);

  it("tells supplied, buildable, external and missing apart", () => {
    expect(report.counts).toEqual({ supplied: 1, generate_graphics: 2, needs_external: 1, missing_blocking: 1 });
    expect(report.items.map((i) => [i.scene_id, i.availability, i.severity])).toEqual([
      ["S01", "supplied", "ok"], ["S02", "generate_graphics", "ok"], ["S03", "generate_graphics", "warning"],
      ["S04", "needs_external", "blocker"], ["S05", "missing_blocking", "blocker"],
    ]);
  });

  it("does not block a graphics-led scene just because no footage was supplied", () => {
    expect(report.blockers.some((b) => b.startsWith("S02"))).toBe(false);
    expect(assetFeasibility(plan(sixScenes()), []).blockers).toEqual([]);
  });

  it("blocks on external or missing material and keeps the fallback in view", () => {
    expect(report.blockers).toHaveLength(2);
    expect(report.blockers[0]).toContain('S04 needs footage "A student closing a laptop" that is not supplied (alternative: End on the logo card alone)');
    expect(report.blockers[1]).toContain("S05 needs ui_screenshot");
  });

  it("labels placeholders for the user instead of passing them off as supplied", () => {
    expect(report.warnings).toEqual([
      'S03: "Brand logo card" is a graphics-only placeholder, not the real thing. It needs your approval and should be replaced by the real asset.',
      "S03: placeholder: No logo supplied: a generic wordmark card is shown.",
    ]);
  });

  it("rejects requirements that claim more than they can deliver", () => {
    const v = (required_assets: unknown[], extra: Record<string, unknown> = {}) =>
      validatePlan(plan([mk("S01", 0, 30, { required_assets, ...extra })]), [clip, logo], project).map((i) => i.code);
    expect(v([gfx("Student footage", { kind: "footage" })])).toContain("footage_cannot_be_generated");
    expect(v([gfx("Narration", { kind: "audio" })])).toContain("footage_cannot_be_generated");
    expect(v([gfx("Brand logo", { kind: "logo" })])).toContain("placeholder_not_labelled");
    expect(v([{ need: "Logo file", kind: "logo", availability: "supplied", asset_id: "nope" }])).toContain("required_asset_invalid");
    expect(v([{ need: "Logo file", kind: "logo", availability: "supplied", asset_id: "asset_clip" }], { asset_ids: ["asset_clip"] })).toContain("required_asset_invalid"); // a video is not a logo
    expect(v([{ need: "Clip", kind: "footage", availability: "supplied", asset_id: "asset_clip" }])).toContain("required_asset_invalid"); // not listed in asset_ids
  });
});

describe("production method", () => {
  const base = { asset_ids: [] as string[], overlay: null, required_assets: [] as Scene["required_assets"] };
  it("is graphics, supplied footage or mixed, from what the scene uses", () => {
    expect(deriveProductionMethod(base)).toBe("graphics");
    expect(deriveProductionMethod({ ...base, asset_ids: ["a"] })).toBe("supplied_footage");
    expect(deriveProductionMethod({ ...base, asset_ids: ["a"], overlay: { text: "Hi", safe_area: "full" } })).toBe("mixed");
    expect(deriveProductionMethod({ ...base, required_assets: [gfx("x"), { need: "clip", kind: "footage", availability: "needs_external", asset_id: null, placeholder: false, fallback: null }] as Scene["required_assets"] })).toBe("mixed");
  });

  it("rejects a declared method that the scene does not support", () => {
    const wrong = mk("S01", 0, 30, { production_method: "supplied_footage" });
    expect(codes([wrong])).toContain("production_method_mismatch");
    expect(codes([mk("S01", 0, 30, { production_method: "graphics" })])).toEqual([]);
  });
});
