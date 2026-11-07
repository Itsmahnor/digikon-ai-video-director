import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PRODUCTION_REASON } from "@digikon/director";
import { PLAIN_CANNOT_PRODUCE, PLAIN_PLAN_CHANGED, plainEscalation, plainReasons, publicApprovals } from "./public-view.js";

describe("what the user sees of the production integrity checks", () => {
  it("shows no binding, hash or production flag on approvals", () => {
    const rec = { stage: "edit_plan", plan_version: 1, storyboard_version: 1, plan_hash: "a".repeat(64), decision: "approved", notes: "", decided_at: "2026-11-01T00:00:00.000Z", production_required: true, production_binding: { binding_hash: "b".repeat(64) } } as never;
    const shown = JSON.stringify(publicApprovals([rec]));
    expect(shown).not.toMatch(/production|binding|bbbb/);
    expect(shown).toContain("plan_hash"); // the existing approval fields are unchanged
  });
  it("turns production reasons into one ordinary sentence and leaves other reasons alone", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = plainReasons([`${PRODUCTION_REASON}: the compiled operations changed after approval`, `${PRODUCTION_REASON}: the pre-flight result belongs to a different selection`, "the storyboard has not been approved"]);
    spy.mockRestore();
    expect(out).toEqual(["the storyboard has not been approved", expect.stringMatching(/reviewed again/)]);
    expect(out.join(" ")).not.toMatch(/compiled|pre-flight|selection|hash|capabilit|engine|operations/i);
    expect(plainReasons(["x"])).toEqual(["x"]);
  });
  it("every route that returns reasons or approvals goes through these helpers", () => {
    const app = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
    expect(app).toMatch(/approvals: publicApprovals\(/);
    expect(app).toMatch(/reasons: plainReasons\(check\.reasons\)/);
    expect(app).toMatch(/reasons: plainReasons\(err\.reasons\)|plainReasons\(err\.reasons\)/);
    expect(app).toMatch(/plainReasons\(r\.reasons\)/);
    expect(app).toMatch(/approvals: publicApprovals\(record\.approvals\)/);
  });
});

describe("escalations and refusals shown to the user", () => {
  const TECH = /capabilit|engine|hash|binding|pre-?flight|planner|adapter|selection|compiled|remotion|ffmpeg|template|production -|approved production plan/i;
  const esc = (evidence: string[]) => ({ what_failed: "edit plan still failed validation after 2 attempts.", evidence, what_was_tried: ["generated and repaired the edit plan (2 attempts)"], options_left: ["adjust the brief or assets and rerun"], decision_needed: "How should the remaining edit plan problems be resolved?" });
  it("hides production blocker lines, keeps creative ones and says one plain sentence", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const shown = plainEscalation(esc(["S02: the overlay text is longer than the scene allows", "production - S03 (U04): crossfade is blocked [ADAPTER_REFUSES]: remotion adapter refuses", "production - S01: no executable use produces the scene's picture [NO_CAPABILITY]"]))!;
    expect(spy).toHaveBeenCalled(); // the detail goes to the server log
    spy.mockRestore();
    expect(shown.evidence).toHaveLength(2);
    expect(shown.evidence[0]).toContain("overlay text is longer");
    expect(shown.evidence.join(" ")).not.toMatch(TECH);
    expect(shown.decision_needed).toBe("How should the remaining edit plan problems be resolved?");
  });
  it("leaves an escalation with no production lines exactly as it was, and null stays null", () => {
    const e = esc(["S02: the overlay text is longer than the scene allows"]);
    expect(plainEscalation(e)).toBe(e);
    expect(plainEscalation(null)).toBeNull();
    expect(plainEscalation(undefined)).toBeNull();
  });
  it("render-time selection blockers and integrity reasons are reduced to ordinary words", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = plainReasons(["approved production plan: E01 was approved to run remotion/text-fade-up but the renderer chose hyperframes/x", "asset asset_1 is not on disk (C:/x.png)"]);
    spy.mockRestore();
    expect(out[0]).toBe("asset asset_1 is not on disk (C:/x.png)");
    expect(out.join(" ")).not.toMatch(/remotion|hyperframes|approved production plan/);
  });
  it("the render refusals are plain", () => {
    expect(PLAIN_PLAN_CHANGED).not.toMatch(TECH);
    expect(PLAIN_CANNOT_PRODUCE).not.toMatch(TECH);
  });
  it("the run stream sends only the summary: interrupt payloads (which carry the plans) are skipped", () => {
    const app = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
    expect(app).toMatch(/node === "__interrupt__"\) continue/);
    expect(app).toMatch(/escalation: plainEscalation\(/);
    expect(app).toMatch(/reasons: plainReasons\(p\.assembly\.reasons/); // the assembly view repeats the render-time selection blockers
  });
});

describe("what the user sees when the plan cannot be produced", () => {
  const esc = (evidence: string[]) => ({ what_failed: "edit plan still failed validation after 2 attempts.", evidence, what_was_tried: ["x"], options_left: ["y"], decision_needed: "z" });
  it("says in plain words that a voice-over does not fit its scene, and names the scene, the words and the seconds", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = plainEscalation(esc(["production - S03: its voiceover has 24 words, which does not fit 8s when spoken clearly; shorten it or lengthen the scene", "production - the renderer's pre-flight was not run because an earlier step is blocked"]) as never)!;
    spy.mockRestore();
    expect(out.evidence).toEqual(["S03: the voice-over has 24 words, but the scene is only 8 seconds long. Shorten the voice-over or make the scene longer."]);
  });
  it("keeps the general sentence for production lines it does not recognise, and never names a company", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = plainEscalation(esc(["production - S02: some engine detail", "S01: a creative problem"]) as never)!;
    spy.mockRestore();
    expect(out.evidence).toContain("S01: a creative problem");
    expect(out.evidence.join(" ")).toContain("what is available on this computer right now");
    expect(JSON.stringify(out) + PLAIN_CANNOT_PRODUCE).not.toMatch(/DigiKon/i);
  });
});
