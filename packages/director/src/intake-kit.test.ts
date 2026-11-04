import { describe, expect, it } from "vitest";
import { emptyKit, provide, skip } from "@digikon/contracts";
import { IntakeOut, ScriptedClient, buildDirectorGraph, kitIsStarted } from "./index.js";
import { cfg, deps, goodEdit, goodStoryboard, input, treatment } from "./fixtures.js";

const kitRequired = () => ["goal", "audience", "platform"].reduce((k, f) => provide(k, f as "goal", "x"), emptyKit("k"));

describe("intake with typed questions (C6)", () => {
  it("with a started kit, missing required fields become typed questions, with no model call", async () => {
    const llm = new ScriptedClient([]);
    const kit = provide(emptyKit("k"), "goal", "Get sign-ups");
    const out = await buildDirectorGraph(deps(llm)).invoke({ ...input, kit }, cfg("c6-ask"));
    expect(out.status).toBe("needs_clarification");
    const qs = out.intakeResult!.questions;
    expect(qs.map((q: any) => q.id)).toEqual(["q_audience", "q_platform"]); // only what is missing, required only
    expect(qs.every((q: any) => q.field !== null && q.skippable === false && ["text", "choice", "upload"].includes(q.kind))).toBe(true);
    expect(qs[1]).toMatchObject({ kind: "choice" });
    expect(llm.calls).toEqual([]); // plain code decided; no tokens spent
    expect(out.treatmentDoc).toBeUndefined();
  });
  it("with the required fields provided the brief is ready, and the run goes on to Gate 1 exactly as before", async () => {
    const llm = new ScriptedClient([treatment, goodStoryboard, goodEdit]);
    const out = await buildDirectorGraph(deps(llm)).invoke({ ...input, kit: skip(kitRequired(), "brand.logo") }, cfg("c6-ready"));
    expect(out.intakeResult).toMatchObject({ status: "ready", questions: [] });
    expect(llm.calls.map((c) => c.name)).not.toContain("intake_result");
    expect(out.status).toBe("awaiting_approval");
    expect(out.gate).toBe("storyboard"); // the first approval gate is untouched
    expect(out.editPlan).toBeNull();     // and the edit plan still waits for it
  });
  it("without a kit, or with an untouched one, the model-based intake runs as before and its strings become typed text questions", async () => {
    for (const kit of [undefined, emptyKit("k")]) {
      const llm = new ScriptedClient([{ status: "needs_clarification", questions: ["Which product is this for?"] }]);
      const out = await buildDirectorGraph(deps(llm)).invoke({ ...input, ...(kit ? { kit } : {}) }, cfg(`c6-legacy-${kit ? "e" : "n"}`));
      expect(llm.calls.map((c) => c.name)).toEqual(["intake_result"]);
      expect(out.status).toBe("needs_clarification");
      expect(out.intakeResult!.questions[0]).toMatchObject({ id: "q_free_1", field: null, kind: "text", prompt: "Which product is this for?" });
    }
  });
  it("an older saved intake result (questions as strings) still parses", () => {
    expect(IntakeOut.parse({ status: "needs_clarification", questions: ["Where will it be shown?"] }).questions[0]).toMatchObject({ prompt: "Where will it be shown?", field: null });
    expect(IntakeOut.parse({ status: "ready" }).questions).toEqual([]);
  });
  it("a kit counts as started once any field is answered or skipped", () => {
    expect(kitIsStarted(emptyKit("k"))).toBe(false);
    expect(kitIsStarted(skip(emptyKit("k"), "website"))).toBe(true);
    expect(kitIsStarted(null)).toBe(false);
  });
});
