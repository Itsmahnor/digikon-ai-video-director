import { describe, expect, it } from "vitest";
import { Asset, Project, QAFinding, Scene, ScenePlan, validatePlan } from "./index.js";

const project = Project.parse({
  project_id: "p1", owner_id: "u1", brief: "b", objective: "o", audience: "a",
  platform: "instagram", aspect_ratio: "9:16", target_duration: 8,
});
const assets = [
  Asset.parse({ asset_id: "asset_014", uri: "x.mp4", media_type: "video", duration: 6, width: 1080, height: 1920 }),
];
const scene = (id: string, start: number, dur: number, assetIds = ["asset_014"]) =>
  Scene.parse({
    scene_id: id, purpose: "p", start_time: start, duration_seconds: dur, asset_ids: assetIds,
    shot: { shot_size: "macro_close_up", camera_motion: "slow_push_in", visual_action: "reveal grain" },
    transition_out: "cut",
  });
const plan = (...scenes: ReturnType<typeof scene>[]) => ScenePlan.parse({ project_id: "p1", version: 1, scenes });

describe("validatePlan", () => {
  it("accepts a contiguous valid plan", () => {
    expect(validatePlan(plan(scene("S01", 0, 4), scene("S02", 4, 4)), assets, project)).toEqual([]);
  });
  it("flags unknown assets", () => {
    const i = validatePlan(plan(scene("S01", 0, 4, ["nope"])), assets, project);
    expect(i.map((x) => x.code)).toContain("unknown_asset");
  });
  it("flags overlaps and gaps", () => {
    expect(validatePlan(plan(scene("S01", 0, 4), scene("S02", 3, 4)), assets, project).map((x) => x.code)).toContain("overlap");
    expect(validatePlan(plan(scene("S01", 0, 3), scene("S02", 4, 3)), assets, project).map((x) => x.code)).toContain("gap");
  });
  it("flags scene longer than source clip", () => {
    expect(validatePlan(plan(scene("S01", 0, 7)), assets, project).map((x) => x.code)).toContain("asset_bounds");
  });
  it("flags timeline over target duration", () => {
    expect(validatePlan(plan(scene("S01", 0, 5), scene("S02", 5, 5)), assets, project).map((x) => x.code)).toContain("over_duration");
  });
  it("rejects bad enums and bad scene ids at parse time", () => {
    expect(() => Scene.parse({ ...scene("S01", 0, 1), transition_out: "explode" })).toThrow();
    expect(() => scene("scene1", 0, 1)).toThrow();
  });
  it("requires evidence on QA findings", () => {
    expect(() => QAFinding.parse({
      finding_id: "f1", scene_id: null, severity: "major", category: "visual",
      evidence_ref: "", description: "d",
    })).toThrow();
  });
});
