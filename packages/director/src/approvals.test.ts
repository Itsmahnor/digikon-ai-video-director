import { describe, expect, it } from "vitest";
import { ApprovalRecord, editPlanHash, storyboardHash } from "@digikon/contracts";
import {
  MAX_REVISIONS, RenderRefusedError, ScriptedClient, StaleApprovalError, approveCurrent, assertRenderable, buildDirectorGraph, checkRenderable,
  gateDecision, requireStoryboardApproval, type DirectorStateType,
} from "./index.js";
import { cfg, deps, goodEdit, goodStoryboard, input, treatment, use } from "./fixtures.js";

const ready = { status: "ready", questions: [] };
const badClaim = { scenes: goodStoryboard.scenes.map((s) => (s.scene_id === "S02" ? { ...s, claim_ids: ["C02"] } : s)) }; // C02 has no approved fact

function setup(answers: unknown[], id: string) {
  const llm = new ScriptedClient(answers);
  const d = deps(llm);
  const graph = buildDirectorGraph(d);
  const run = (cmd: Parameters<typeof graph.invoke>[0]) => graph.invoke(cmd, cfg(id));
  return { llm, graph, run, recipes: d.recipes, ctx: { recipes: d.recipes } };
}
const calls = (llm: ScriptedClient, name: string) => llm.calls.filter((c) => c.name === name);
/** The node that is paused waiting for a decision, if any. */
async function pausedAt(graph: ReturnType<typeof buildDirectorGraph>, id: string): Promise<string[]> {
  return (await graph.getState(cfg(id))).tasks.filter((t) => t.interrupts.length > 0).map((t) => t.name);
}
/** Why the gate refused the last decision it was sent, read from the pause it is waiting in. */
async function refusal(graph: ReturnType<typeof buildDirectorGraph>, id: string): Promise<string | null> {
  const pending = (await graph.getState(cfg(id))).tasks.flatMap((t) => t.interrupts)[0];
  return ((pending?.value as { refused_previous?: string | null } | undefined)?.refused_previous) ?? null;
}

/** Both gates approved at version 1. */
async function approvedRun(id: string) {
  const t = setup([ready, treatment, goodStoryboard, goodEdit], id);
  const g1 = await t.run(input);
  const g2 = await t.run(approveCurrent(g1));
  const done = await t.run(approveCurrent(g2));
  return { ...t, g1, g2, done };
}
const ok = (s: DirectorStateType, ctx: { recipes: never }) => checkRenderable(s, ctx);
const reasonsOf = (s: DirectorStateType, ctx: { recipes: never }) => { const r = ok(s, ctx); return r.ok ? [] : r.reasons; };
const forge = (s: DirectorStateType): ApprovalRecord[] => {
  const sb = { version: s.scenePlan!.version, hash: storyboardHash(s.treatmentDoc!, s.scenePlan!) };
  const now = new Date().toISOString();
  return [
    ApprovalRecord.parse({ stage: "storyboard", plan_version: sb.version, storyboard_version: sb.version, plan_hash: sb.hash, decision: "approved", notes: "", decided_at: now }),
    ApprovalRecord.parse({ stage: "edit_plan", plan_version: s.editPlan!.version, storyboard_version: sb.version, plan_hash: editPlanHash(sb, s.editPlan!), decision: "approved", notes: "", decided_at: now }),
  ];
};

describe("gate 1: the storyboard", () => {
  it("pauses right after the storyboard and cannot be skipped", async () => {
    const t = setup([ready, treatment, goodStoryboard, goodEdit], "a-skip");
    const g1 = await t.run(input);
    expect(g1).toMatchObject({ status: "awaiting_approval", gate: "storyboard" });
    expect(g1.scenePlan!.version).toBe(1);
    expect(g1.editPlan).toBeNull();
    expect(calls(t.llm, "edit_plan")).toHaveLength(0);
    expect((await t.graph.getState(cfg("a-skip"))).next).toEqual(["storyboard_gate"]);

    // Running again without a decision does not move it on.
    const again = await t.run(null);
    expect((await t.graph.getState(cfg("a-skip"))).next).toEqual(["storyboard_gate"]);
    expect(calls(t.llm, "edit_plan")).toHaveLength(0);
    expect(again.approvals ?? []).toEqual([]);
  });

  it("refuses to make an edit plan for a storyboard that is not approved (the step guards itself)", async () => {
    const t = setup([ready, treatment, goodStoryboard], "a-guard");
    const g1 = await t.run(input);
    expect(() => requireStoryboardApproval(g1)).toThrow(StaleApprovalError);
    // An approval of some other version or other content does not count either.
    const wrongVersion = [{ ...forge({ ...g1, editPlan: { project_id: "p", version: 1, uses: [] } } as DirectorStateType)[0]!, plan_version: 7, storyboard_version: 7 }];
    expect(() => requireStoryboardApproval({ ...g1, approvals: wrongVersion })).toThrow(StaleApprovalError);
    const approved = forge({ ...g1, editPlan: { project_id: "p", version: 1, uses: [] } } as DirectorStateType)[0]!;
    expect(() => requireStoryboardApproval({ ...g1, approvals: [approved] })).not.toThrow();
    expect(() => requireStoryboardApproval({ ...g1, approvals: [approved], scenePlan: { ...g1.scenePlan!, scenes: g1.scenePlan!.scenes.slice(0, 2) } })).toThrow(StaleApprovalError);
  });

  it("records the approval with the stage, version, hash, notes and time, then makes the edit plan", async () => {
    const t = setup([ready, treatment, goodStoryboard, goodEdit], "a-rec");
    const g1 = await t.run(input);
    const g2 = await t.run(gateDecision("storyboard", 1, "approved", "  looks right  "));
    expect(g2).toMatchObject({ status: "awaiting_approval", gate: "edit_plan" });
    expect(g2.editPlan!.version).toBe(1);
    const rec = g2.approvals[0]!;
    expect(rec).toMatchObject({ stage: "storyboard", plan_version: 1, storyboard_version: 1, decision: "approved", notes: "looks right" });
    expect(rec.plan_hash).toBe(storyboardHash(g1.treatmentDoc!, g1.scenePlan!));
    expect(Number.isNaN(Date.parse(rec.decided_at))).toBe(false);
  });
});

describe("revisions", () => {
  it("sends change notes back to the storyboard step, makes version 2 and returns to gate 1 with no approval", async () => {
    const t = setup([ready, treatment, goodStoryboard, goodStoryboard, goodEdit], "r-sb");
    const g1 = await t.run(input);
    const again = await t.run(gateDecision("storyboard", 1, "revision_requested", "Make the opening shorter"));
    expect(again).toMatchObject({ status: "awaiting_approval", gate: "storyboard", editPlan: null });
    expect(again.scenePlan!.version).toBe(2);
    expect(again.revisions).toEqual({ storyboard: 1, edit_plan: 0 });
    expect(again.approvals).toHaveLength(1);
    expect(again.approvals[0]).toMatchObject({ stage: "storyboard", plan_version: 1, decision: "revision_requested", notes: "Make the opening shorter" });
    const prompt = calls(t.llm, "storyboard")[1]!.user;
    expect(prompt).toContain("Make the opening shorter");
    expect(prompt).toContain("<reviewer_notes>");
    expect(prompt).toContain('"version": 1'); // the previous plan is shown
    expect(calls(t.llm, "edit_plan")).toHaveLength(0); // still no edit plan
    expect(storyboardHash(again.treatmentDoc!, again.scenePlan!)).not.toBe(storyboardHash(g1.treatmentDoc!, g1.scenePlan!)); // a new version is a new hash
    expect(reasonsOf(again as DirectorStateType, t.ctx as never).join(" ")).toContain("has not been approved");
  });

  it("refuses a decision made on the old version after a revision (stale)", async () => {
    const t = setup([ready, treatment, goodStoryboard, goodStoryboard, goodEdit], "r-stale");
    await t.run(input);
    await t.run(gateDecision("storyboard", 1, "revision_requested", "change it"));
    await t.run(gateDecision("storyboard", 1, "approved"));
    expect(await refusal(t.graph, "r-stale")).toMatch(/version 1.*version 2 is waiting/);
    expect(await pausedAt(t.graph, "r-stale")).toEqual(["storyboard_gate"]);
    expect(calls(t.llm, "edit_plan")).toHaveLength(0);
    expect((await t.graph.getState(cfg("r-stale"))).values.approvals).toHaveLength(1); // only the change request; the stale approval left no trace
    // The refusal leaves the gate open, and the correct version can still be approved.
    const g2 = await t.run(gateDecision("storyboard", 2, "approved"));
    expect(g2.gate).toBe("edit_plan");
    expect(g2.approvals.map((a) => [a.plan_version, a.decision])).toEqual([[1, "revision_requested"], [2, "approved"]]);
  });

  it("sends change notes at gate 2 back to the edit-plan step only, keeping the storyboard approval", async () => {
    const t = setup([ready, treatment, goodStoryboard, goodEdit, goodEdit], "r-edit");
    const g1 = await t.run(input);
    const g2 = await t.run(approveCurrent(g1));
    const again = await t.run(gateDecision("edit_plan", 1, "revision_requested", "Use a softer transition"));
    expect(again).toMatchObject({ status: "awaiting_approval", gate: "edit_plan" });
    expect(again.editPlan!.version).toBe(2);
    expect(again.scenePlan!.version).toBe(1);
    expect(again.revisions).toEqual({ storyboard: 0, edit_plan: 1 });
    expect(calls(t.llm, "storyboard")).toHaveLength(1);
    expect(calls(t.llm, "edit_plan")[1]!.user).toContain("Use a softer transition");
    // Storyboard approval still stands; the new edit plan is not approved yet.
    const reasons = reasonsOf(again as DirectorStateType, t.ctx as never);
    expect(reasons).toEqual(["the latest edit-plan decision is a request for changes, not an approval"]);
    expect(g2.editPlan!.version).toBe(1);

    const done = await t.run(approveCurrent(again));
    expect(done.status).toBe("approved");
    const auth = assertRenderable(done as DirectorStateType, t.ctx);
    expect(auth.edit_plan.version).toBe(2);
    expect(auth.storyboard.version).toBe(1);
  });

  it("escalates at the revision limit instead of looping (storyboard)", async () => {
    const t = setup([ready, treatment, goodStoryboard, goodStoryboard, goodStoryboard], "r-limit-sb");
    let s = await t.run(input);
    for (let n = 1; n <= MAX_REVISIONS; n++) {
      s = await t.run(gateDecision("storyboard", n, "revision_requested", `change ${n}`));
      expect(s.gate).toBe("storyboard");
      expect(s.scenePlan!.version).toBe(n + 1);
    }
    const last = await t.run(gateDecision("storyboard", MAX_REVISIONS + 1, "revision_requested", "still not right"));
    expect(last.status).toBe("escalated");
    expect(last.gate).toBeNull();
    expect(last.escalation!.what_failed).toContain(`${MAX_REVISIONS} revisions`);
    expect(last.escalation!.evidence).toContain("still not right");
    expect(calls(t.llm, "storyboard")).toHaveLength(MAX_REVISIONS + 1); // no further attempt
    expect((await t.graph.getState(cfg("r-limit-sb"))).next).toEqual([]); // the graph has ended
    expect(last.approvals.filter((a) => a.decision === "revision_requested")).toHaveLength(MAX_REVISIONS + 1);
    expect(checkRenderable(last as DirectorStateType, t.ctx).ok).toBe(false);
  });

  it("escalates at the revision limit instead of looping (edit plan)", async () => {
    const t = setup([ready, treatment, goodStoryboard, goodEdit, goodEdit, goodEdit], "r-limit-ep");
    let s = await t.run(approveCurrent(await t.run(input)));
    for (let n = 1; n <= MAX_REVISIONS; n++) s = await t.run(gateDecision("edit_plan", n, "revision_requested", `change ${n}`));
    const last = await t.run(gateDecision("edit_plan", MAX_REVISIONS + 1, "revision_requested", "no"));
    expect(last.status).toBe("escalated");
    expect(calls(t.llm, "edit_plan")).toHaveLength(MAX_REVISIONS + 1);
  });

  it("still enforces claim grounding on a revised storyboard", async () => {
    // The revised storyboard uses a claim with no approved fact, twice: code stops it and nothing reaches the gate.
    const t = setup([ready, treatment, goodStoryboard, badClaim, badClaim], "r-claim");
    await t.run(input);
    const out = await t.run(gateDecision("storyboard", 1, "revision_requested", "add the best-in-town claim"));
    expect(out.status).toBe("escalated");
    expect(out.escalation!.evidence.join(" ")).toContain("unsupported_claim");
    expect(out.gate).toBeNull();
    expect(calls(t.llm, "storyboard")).toHaveLength(3); // 1 original + one attempt and one repair
  });

  it("still validates a revised edit plan (unknown recipe is stopped)", async () => {
    const invented = { uses: [use(1, "S01", "spin-3d-bottle")] };
    const t = setup([ready, treatment, goodStoryboard, goodEdit, invented, invented], "r-recipe");
    await t.run(approveCurrent(await t.run(input)));
    const out = await t.run(gateDecision("edit_plan", 1, "revision_requested", "spin the bottle"));
    expect(out.status).toBe("escalated");
    expect(out.escalation!.evidence.join(" ")).toContain("unknown_recipe");
  });
});

describe("gate 2: the edit plan", () => {
  it("refuses a decision for the wrong stage, version or storyboard, and leaves the gate open", async () => {
    const t = setup([ready, treatment, goodStoryboard, goodEdit], "g2-stale");
    const g2 = await t.run(approveCurrent(await t.run(input)));
    expect(g2.gate).toBe("edit_plan");
    await t.run(gateDecision("storyboard", 1, "approved"));
    expect(await refusal(t.graph, "g2-stale")).toMatch(/storyboard, but the edit plan is waiting/);
    await t.run(gateDecision("edit_plan", 9, "approved"));
    expect(await refusal(t.graph, "g2-stale")).toMatch(/edit plan version 9.*version 1 is waiting/);
    await t.run(gateDecision("edit_plan", 1, "approved", "", 99));
    expect(await refusal(t.graph, "g2-stale")).toMatch(/storyboard version 99/);
    const still = await t.graph.getState(cfg("g2-stale"));
    expect(await pausedAt(t.graph, "g2-stale")).toEqual(["edit_plan_gate"]);
    expect(still.values.approvals).toHaveLength(1); // nothing extra was recorded by the refusals
    expect(still.values.status).toBe("awaiting_approval");

    const done = await t.run(gateDecision("edit_plan", 1, "approved", "", 1));
    expect(done.status).toBe("approved");
    expect(done.approvals).toHaveLength(2);
    expect(done.approvals[1]).toMatchObject({ stage: "edit_plan", plan_version: 1, storyboard_version: 1, decision: "approved" });
    expect(done.approvals[1]!.plan_hash).toBe(editPlanHash({ version: 1, hash: storyboardHash(done.treatmentDoc!, done.scenePlan!) }, done.editPlan!));
  });

  it("is approved, but that alone does not make anything renderable: the guard decides", async () => {
    const t = await approvedRun("g2-guard");
    expect(t.done.status).toBe("approved");
    expect(checkRenderable({ ...t.done, approvals: [] } as DirectorStateType, t.ctx).ok).toBe(false);
  });
});

describe("assertRenderable", () => {
  it("passes for valid approvals of the exact current versions and reports what it authorised", async () => {
    const t = await approvedRun("rd-ok");
    const auth = assertRenderable(t.done as DirectorStateType, t.ctx);
    expect(auth.storyboard).toEqual({ version: 1, hash: storyboardHash(t.done.treatmentDoc!, t.done.scenePlan!) });
    expect(auth.edit_plan.version).toBe(1);
  });

  it("refuses with clear reasons when approvals are missing", async () => {
    const t = await approvedRun("rd-missing");
    const none = reasonsOf({ ...t.done, approvals: [] } as DirectorStateType, t.ctx as never);
    expect(none).toEqual(["the storyboard has not been approved", "the edit plan has not been approved"]);
    const onlyFirst = reasonsOf({ ...t.done, approvals: [t.done.approvals[0]!] } as DirectorStateType, t.ctx as never);
    expect(onlyFirst).toEqual(["the edit plan has not been approved"]);
    expect(() => assertRenderable({ ...t.done, approvals: [] } as DirectorStateType, t.ctx)).toThrow(RenderRefusedError);
    try { assertRenderable({ ...t.done, approvals: [] } as DirectorStateType, t.ctx); } catch (e) { expect((e as RenderRefusedError).reasons).toHaveLength(2); }
  });

  it("refuses at gate 1 and gate 2 states: nothing is renderable before both approvals exist", async () => {
    const t = setup([ready, treatment, goodStoryboard, goodEdit], "rd-early");
    const g1 = await t.run(input);
    expect(checkRenderable(g1 as DirectorStateType, t.ctx)).toMatchObject({ ok: false });
    const g2 = await t.run(approveCurrent(g1));
    expect(reasonsOf(g2 as DirectorStateType, t.ctx as never)).toEqual(["the edit plan has not been approved"]);
  });

  it("refuses when the approved storyboard was edited afterwards (hash mismatch) or its version moved on", async () => {
    const t = await approvedRun("rd-edit");
    const edited = structuredClone(t.done) as DirectorStateType;
    edited.scenePlan!.scenes[0]!.purpose = "something the reviewer never saw";
    const r1 = reasonsOf(edited, t.ctx as never);
    expect(r1).toContain("the storyboard changed after it was approved (hash mismatch)");
    expect(r1.some((x) => x.includes("edit plan, or the storyboard it was built on, changed"))).toBe(true);

    const bumped = structuredClone(t.done) as DirectorStateType;
    bumped.scenePlan = { ...bumped.scenePlan!, version: 2 };
    const r2 = reasonsOf(bumped, t.ctx as never);
    expect(r2).toContain("the approval is for storyboard version 1, but the current storyboard is version 2");
  });

  it("refuses when the approved edit plan was edited afterwards, or approved on a different storyboard version", async () => {
    const t = await approvedRun("rd-edit2");
    const edited = structuredClone(t.done) as DirectorStateType;
    edited.editPlan!.uses[0]!.rationale = "changed after approval";
    expect(reasonsOf(edited, t.ctx as never)).toEqual(["the edit plan, or the storyboard it was built on, changed after approval (hash mismatch)"]);

    const other = structuredClone(t.done) as DirectorStateType;
    other.approvals = [other.approvals[0]!, { ...other.approvals[1]!, storyboard_version: 2 }];
    expect(reasonsOf(other, t.ctx as never)).toEqual(["the edit plan was approved on storyboard version 2, but the current storyboard is version 1"]);
  });

  it("refuses malformed or hash-invalid records, change requests and the wrong order", async () => {
    const t = await approvedRun("rd-bad");
    const [a, b] = t.done.approvals as [ApprovalRecord, ApprovalRecord];
    const badHash = reasonsOf({ ...t.done, approvals: [{ ...a, plan_hash: "not-a-hash" }, b] } as DirectorStateType, t.ctx as never);
    expect(badHash.some((x) => x.startsWith("approval record 1 is malformed"))).toBe(true);
    expect(badHash).toContain("the storyboard has not been approved");
    const wrongHash = reasonsOf({ ...t.done, approvals: [{ ...a, plan_hash: "0".repeat(64) }, b] } as DirectorStateType, t.ctx as never);
    expect(wrongHash).toContain("the storyboard changed after it was approved (hash mismatch)");
    const lastWasRevision = reasonsOf({ ...t.done, approvals: [a, b, { ...b, decision: "revision_requested", notes: "no" }] } as DirectorStateType, t.ctx as never);
    expect(lastWasRevision).toEqual(["the latest edit-plan decision is a request for changes, not an approval"]);
    const reversed = reasonsOf({ ...t.done, approvals: [b, a] } as DirectorStateType, t.ctx as never);
    expect(reversed).toEqual(["the edit plan was approved before the storyboard"]);
    expect(reasonsOf({ ...t.done, approvals: ["approved", null, 42] } as unknown as DirectorStateType, t.ctx as never).filter((x) => x.includes("malformed"))).toHaveLength(3);
  });

  it("still refuses an invalid plan even when its approvals are forged with matching hashes", async () => {
    const t = await approvedRun("rd-valid");
    // An unsupported claim in a scene, with approvals recomputed to match: hashes agree, validation does not.
    const claim = structuredClone(t.done) as DirectorStateType;
    claim.scenePlan!.scenes[1]!.claim_ids = ["C02"];
    claim.approvals = forge(claim);
    const r1 = reasonsOf(claim, t.ctx as never);
    expect(r1).toHaveLength(1);
    expect(r1[0]).toContain("storyboard is not valid");
    expect(r1[0]).toContain("unsupported_claim");

    const recipe = structuredClone(t.done) as DirectorStateType;
    recipe.editPlan!.uses[0]!.recipe_id = "invented-effect";
    recipe.approvals = forge(recipe);
    const r2 = reasonsOf(recipe, t.ctx as never);
    expect(r2.some((x) => x.startsWith("edit plan is not valid") && x.includes("unknown_recipe"))).toBe(true);

    // Control: the same forging on an untouched plan passes, so the refusals above come from validation, not from the forging.
    const clean = structuredClone(t.done) as DirectorStateType;
    clean.approvals = forge(clean);
    expect(checkRenderable(clean, t.ctx).ok).toBe(true);
  });
});
