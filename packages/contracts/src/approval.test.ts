import { describe, expect, it } from "vitest";
import { ApprovalRecord, ApprovalSubmission, canonicalJson, editPlanHash, hashCanonical, sha256Hex, storyboardHash } from "./approval.js";
import { EditPlan, Treatment } from "./director.js";
import { ScenePlan } from "./schemas.js";

const hash = "a".repeat(64);
const record = (over: Record<string, unknown> = {}) => ({
  stage: "storyboard", plan_version: 1, storyboard_version: 1, plan_hash: hash, decision: "approved", notes: "", decided_at: "2026-10-22T10:00:00.000Z", ...over,
});

describe("canonical JSON and hashing", () => {
  it("gives the same text whatever order the keys were built in", () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 1 }));
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
  it("keeps array order, drops undefined properties and rejects values JSON cannot hold", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
  it("produces a real SHA-256 (known test vector)", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hashCanonical({ a: 1 })).toBe(sha256Hex('{"a":1}'));
  });

  const treatment = Treatment.parse({ logline: "l", hook: "h", tone: "t", beats: [{ beat: "b", purpose: "p", approx_seconds: 3 }], cta: "c", claims: [] });
  const scene = { scene_id: "S01", purpose: "p", start_time: 0, duration_seconds: 3, shot: { shot_size: "close_up", camera_motion: "static", visual_action: "x" }, transition_out: "cut" };
  const plan = (v: number, purpose = "p") => ScenePlan.parse({ project_id: "p", version: v, scenes: [{ ...scene, purpose }] });

  it("changes the storyboard hash when anything in the plan changes, including the version alone", () => {
    const base = storyboardHash(treatment, plan(1));
    expect(storyboardHash(treatment, plan(1))).toBe(base);
    expect(storyboardHash(treatment, plan(2))).not.toBe(base);
    expect(storyboardHash(treatment, plan(1, "different"))).not.toBe(base);
    expect(storyboardHash({ ...treatment, cta: "other" }, plan(1))).not.toBe(base);
  });

  it("binds the edit-plan hash to the storyboard it was built on", () => {
    const edit = EditPlan.parse({ project_id: "p", version: 1, uses: [] });
    const sb = { version: 1, hash: storyboardHash(treatment, plan(1)) };
    const h = editPlanHash(sb, edit);
    expect(editPlanHash(sb, edit)).toBe(h);
    expect(editPlanHash({ ...sb, version: 2 }, edit)).not.toBe(h);
    expect(editPlanHash({ ...sb, hash: storyboardHash(treatment, plan(1, "other")) }, edit)).not.toBe(h);
    expect(editPlanHash(sb, { ...edit, version: 2 })).not.toBe(h);
  });
});

describe("approval contracts", () => {
  it("accepts a well-formed record and rejects a bad hash, a missing timestamp or an unknown stage", () => {
    expect(ApprovalRecord.safeParse(record()).success).toBe(true);
    expect(ApprovalRecord.safeParse(record({ plan_hash: "xyz" })).success).toBe(false);
    expect(ApprovalRecord.safeParse(record({ plan_hash: "A".repeat(64) })).success).toBe(false);
    expect(ApprovalRecord.safeParse(record({ decided_at: "yesterday" })).success).toBe(false);
    expect(ApprovalRecord.safeParse(record({ stage: "render" })).success).toBe(false);
  });
  it("needs notes on a change request, and a storyboard record must carry its own version", () => {
    expect(ApprovalRecord.safeParse(record({ decision: "revision_requested", notes: "  " })).success).toBe(false);
    expect(ApprovalRecord.safeParse(record({ decision: "revision_requested", notes: "shorter hook" })).success).toBe(true);
    expect(ApprovalRecord.safeParse(record({ plan_version: 2, storyboard_version: 1 })).success).toBe(false);
    expect(ApprovalRecord.safeParse(record({ stage: "edit_plan", plan_version: 1, storyboard_version: 3 })).success).toBe(true);
  });
  it("requires the stage and plan version in a submission, and notes for a change request", () => {
    expect(ApprovalSubmission.safeParse({ decision: "approved" }).success).toBe(false);
    expect(ApprovalSubmission.safeParse({ stage: "storyboard", decision: "approved" }).success).toBe(false);
    expect(ApprovalSubmission.safeParse({ stage: "storyboard", plan_version: 1, decision: "approved" }).success).toBe(true);
    expect(ApprovalSubmission.safeParse({ stage: "storyboard", plan_version: 1, decision: "revision_requested" }).success).toBe(false);
    expect(ApprovalSubmission.safeParse({ stage: "storyboard", plan_version: 1, decision: "revision_requested", notes: "x" }).success).toBe(true);
    expect(ApprovalSubmission.safeParse({ stage: "storyboard", plan_version: 0, decision: "approved" }).success).toBe(false);
  });
});
