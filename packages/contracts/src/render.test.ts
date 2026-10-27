import { describe, expect, it } from "vitest";
import { RENDER_SCHEMA_VERSION, RenderRecord, RenderSettings } from "./index.js";

const settings = { aspect_ratio: "16:9", width: 640, height: 360, fps: 30, duration_s: 30, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test fixture" } };
const sha = "a".repeat(64);
const output = { path: "x.mp4", bytes: 10, sha256: sha, container: "mp4", width: 640, height: 360, fps: 30, duration_s: 30, video_codec: "h264", audio_codec: null, audio_tracks: 0, validated_at: "2026-10-26T00:00:00.000Z", checks: ["size=640x360"] };
const record = (over: Record<string, unknown>) => ({
  schema_version: RENDER_SCHEMA_VERSION, render_id: "rn_0123456789abcdef", purpose: "preview", handoff_id: "ho_0123456789abcdef", handoff_content_hash: sha,
  approved: { storyboard: { version: 1, hash: sha }, edit_plan: { version: 1, hash: sha } }, state: "executable", settings, operations: [], assets: [], audio_required: false,
  blockers: [], errors: [], output: null, notes: [], created_at: "2026-10-26T00:00:00.000Z", started_at: null, finished_at: null, ...over,
});
const issues = (r: unknown) => { const p = RenderRecord.safeParse(r); return p.success ? [] : p.error.issues.map((i) => i.message); };

describe("RenderSettings", () => {
  it("accepts complete settings", () => expect(RenderSettings.safeParse(settings).success).toBe(true));
  it("has no defaults: every field is required", () => {
    for (const k of Object.keys(settings)) expect(RenderSettings.safeParse({ ...settings, [k]: undefined }).success, k).toBe(false);
  });
  it("rejects a size that is not the aspect ratio, odd sizes for h264, and containers that cannot carry the codec", () => {
    expect(RenderSettings.safeParse({ ...settings, width: 640, height: 480 }).success).toBe(false);
    expect(RenderSettings.safeParse({ ...settings, width: 641, height: 361 }).success).toBe(false);
    expect(RenderSettings.safeParse({ ...settings, container: "webm" }).success).toBe(false);
    expect(RenderSettings.safeParse({ ...settings, audio_codec: "opus" }).success).toBe(false);
    expect(RenderSettings.safeParse({ ...settings, container: "webm", video_codec: "vp9", audio_codec: "opus" }).success).toBe(true);
  });
  it("must say where the settings came from", () => {
    expect(RenderSettings.safeParse({ ...settings, source: { kind: "guess", reference: "x" } }).success).toBe(false);
    expect(RenderSettings.safeParse({ ...settings, source: { kind: "user_approved", reference: "" } }).success).toBe(false);
  });
});

describe("RenderRecord", () => {
  it("accepts a consistent record in each state", () => {
    expect(issues(record({}))).toEqual([]);
    expect(issues(record({ state: "planning", blockers: ["x"], settings: null }))).toEqual([]);
    expect(issues(record({ state: "rendering", started_at: "2026-10-26T00:00:00.000Z" }))).toEqual([]);
    expect(issues(record({ state: "failed", errors: [{ stage: "adapter", message: "boom" }], finished_at: "2026-10-26T00:00:00.000Z" }))).toEqual([]);
    expect(issues(record({ state: "rendered", output, finished_at: "2026-10-26T00:00:00.000Z" }))).toEqual([]);
  });
  it("cannot say rendered without a validated output, or with errors", () => {
    expect(issues(record({ state: "rendered", finished_at: "2026-10-26T00:00:00.000Z" }))).toContain("rendered needs a validated output file");
    expect(issues(record({ state: "rendered", output, errors: [{ stage: "adapter", message: "x" }], finished_at: "2026-10-26T00:00:00.000Z" }))).toContain("a rendered record cannot carry errors");
  });
  it("cannot carry an output unless rendered, and cannot be failed without a reason", () => {
    for (const state of ["planning", "executable", "failed"]) expect(issues(record({ state, output, blockers: state === "planning" ? ["x"] : [], errors: state === "failed" ? [{ stage: "adapter", message: "x" }] : [], finished_at: "2026-10-26T00:00:00.000Z" }))).toContain("only a rendered record may carry an output file");
    expect(issues(record({ state: "failed", finished_at: "2026-10-26T00:00:00.000Z" }))).toContain("failed needs at least one error");
  });
  it("keeps planning and blockers together, and needs settings to leave planning", () => {
    expect(issues(record({ state: "planning", settings: null }))).toContain("planning needs at least one blocker");
    expect(issues(record({ state: "executable", blockers: ["missing"] }))).toContain("a render with blockers cannot be executable, running or rendered");
    expect(issues(record({ state: "executable", settings: null }))).toContain("a render without valid settings cannot leave planning");
  });
  it("requires the output to match the settings and to carry audio when the plan has audio", () => {
    const done = { state: "rendered", finished_at: "2026-10-26T00:00:00.000Z" };
    expect(issues(record({ ...done, output: { ...output, width: 320, height: 180 } }))).toContain("the output frame size is not the settings' size");
    expect(issues(record({ ...done, output: { ...output, video_codec: "vp9" } }))).toContain("the output container or codecs are not the settings'");
    expect(issues(record({ ...done, audio_required: true, settings: { ...settings, audio_codec: "aac" }, output: { ...output, audio_codec: "aac", audio_tracks: 0 } }))).toContain("the plan includes audio but the output has no audio track");
  });
});
