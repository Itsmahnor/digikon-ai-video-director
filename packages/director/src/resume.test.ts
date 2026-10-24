import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Asset, storyboardHash } from "@digikon/contracts";
import {
  DIRECTOR_GRAPH_VERSION, PersistenceError, RunStore, ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, checkpointOf,
  currentEditPlan, gateDecision, restoreRun, verifyHandoffWithStore, type DirectorStateType,
} from "./index.js";
import { assets, cfg, deps, goodEdit, goodStoryboard, input, root, treatment } from "./fixtures.js";

const ready = { status: "ready", questions: [] };
const skills = new SkillLibrary(root("skills"));
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "resume-test-")); dirs.push(d); return d; };

const SHA = { beans: "a".repeat(64), logo: "b".repeat(64) };
const hashed = [
  Asset.parse({ ...assets[0], metadata: { bytes: 4_000_000, sha256: SHA.beans } }),
  Asset.parse({ ...assets[1], metadata: { bytes: 50_000, sha256: SHA.logo } }),
];
const disk = (sha: Record<string, string> = {}) => ({
  size: (u: string) => ({ "beans.mp4": 4_000_000, "logo.png": 50_000 } as Record<string, number>)[u] ?? null,
  sha256: (u: string) => ({ "beans.mp4": SHA.beans, "logo.png": SHA.logo, ...sha } as Record<string, string>)[u] ?? null,
});
const SESSION = "abcdef012345";
const RUN = `${SESSION}-1`;

/** One "process": a graph with its own memory, writing decisions to the store. */
function processFor(store: RunStore, answers: unknown[]) {
  const d = { ...deps(new ScriptedClient(answers)), approvalLog: store.approvalLog(RUN) };
  const graph = buildDirectorGraph(d);
  const ctx = { recipes: d.recipes, files: disk(), requireContentHash: true };
  return { d, graph, ctx };
}
const save = (store: RunStore, state: DirectorStateType) => store.saveCheckpoint(checkpointOf(state, { session_id: SESSION, run_id: RUN }));
const restore = (store: RunStore, graph: ReturnType<typeof buildDirectorGraph>, ctx: ReturnType<typeof processFor>["ctx"], over: Partial<Parameters<typeof restoreRun>[0]> = {}) =>
  restoreRun({ store, graph, run_id: RUN, session_id: SESSION, ctx, ...over });

/** Before the restart: run to gate 1 (and optionally through it to gate 2) and save the checkpoint. */
async function beforeRestart(dir: string, toGate2: boolean) {
  const store = new RunStore(dir);
  const p = processFor(store, [ready, treatment, goodStoryboard, goodEdit]);
  let s = await p.graph.invoke({ ...input, assets: hashed }, cfg(RUN));
  if (toGate2) s = await p.graph.invoke(approveCurrent(s), cfg(RUN));
  save(store, s as DirectorStateType);
  return s as DirectorStateType;
}
const file = (dir: string) => join(dir, "runs", RUN, "checkpoint.json");

describe("resuming a Director run after a restart", () => {
  it("resumes a run waiting at gate 1 at the same gate, with the same plan, and continues normally", async () => {
    const dir = tmp();
    const before = await beforeRestart(dir, false);
    const after = processFor(new RunStore(dir), [goodEdit]); // a new process: empty memory
    const r = await restore(new RunStore(dir), after.graph, after.ctx);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    expect(r.state).toMatchObject({ status: "awaiting_approval", gate: "storyboard" });
    expect(r.state.scenePlan).toEqual(before.scenePlan);
    expect(storyboardHash(r.state.treatmentDoc!, r.state.scenePlan!)).toBe(storyboardHash(before.treatmentDoc!, before.scenePlan!));
    expect((await after.graph.getState(cfg(RUN))).next).toEqual(["storyboard_gate"]);
    expect(r.state.approvals).toEqual([]);

    // Nothing moves without a decision; the decision works and is stored as approval 1.
    await after.graph.invoke(null, cfg(RUN));
    expect((await after.graph.getState(cfg(RUN))).next).toEqual(["storyboard_gate"]);
    const g2 = await after.graph.invoke(gateDecision("storyboard", 1, "approved"), cfg(RUN));
    expect(g2.gate).toBe("edit_plan");
    expect(new RunStore(dir).loadApprovals(RUN).records).toEqual(g2.approvals);
  });

  it("resumes a run waiting at gate 2, keeps the storyboard approval, and can finish into a verified handoff", async () => {
    const dir = tmp();
    const before = await beforeRestart(dir, true);
    const after = processFor(new RunStore(dir), []);
    const r = await restore(new RunStore(dir), after.graph, after.ctx);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    expect(r.state).toMatchObject({ status: "awaiting_approval", gate: "edit_plan" });
    expect(r.state.editPlan).toEqual(before.editPlan);
    expect(r.state.approvals).toEqual(before.approvals);
    expect(currentEditPlan(r.state)).toEqual(currentEditPlan(before));
    expect((await after.graph.getState(cfg(RUN))).next).toEqual(["edit_plan_gate"]);

    const done = (await after.graph.invoke(approveCurrent(r.state), cfg(RUN))) as DirectorStateType;
    expect(done.status).toBe("approved");
    const h = buildHandoff(done, { ...after.ctx, skills, run_id: RUN, model: "scripted" });
    expect(verifyHandoffWithStore(h, new RunStore(dir), after.ctx)).toEqual([]);
  });

  it("never approves on restore, and refuses decisions for a gate already passed", async () => {
    const dir = tmp();
    await beforeRestart(dir, true);
    const after = processFor(new RunStore(dir), []);
    const r = await restore(new RunStore(dir), after.graph, after.ctx);
    if (!r.ok) throw new Error("expected a restore");
    expect(r.state.approvals.filter((a) => a.stage === "edit_plan")).toEqual([]);
    await after.graph.invoke(gateDecision("storyboard", 1, "approved"), cfg(RUN)); // gate 1 again: refused
    const still = (await after.graph.getState(cfg(RUN))).values as DirectorStateType;
    expect(still.gate).toBe("edit_plan");
    expect(still.approvals).toHaveLength(1);
    expect(new RunStore(dir).loadApprovals(RUN).records).toHaveLength(1);
  });

  it("refuses a checkpoint that is older than the stored approvals, so a passed gate cannot reappear", async () => {
    const dir = tmp();
    const store = new RunStore(dir);
    const p = processFor(store, [ready, treatment, goodStoryboard, goodEdit]);
    const g1 = await p.graph.invoke({ ...input, assets: hashed }, cfg(RUN));
    save(store, g1 as DirectorStateType); // checkpoint at gate 1 ...
    await p.graph.invoke(approveCurrent(g1), cfg(RUN)); // ... then approved, but the new checkpoint was never written
    const r = await restore(new RunStore(dir), processFor(new RunStore(dir), []).graph, p.ctx);
    expect(r).toEqual({ ok: false, missing: false, reasons: ["the checkpoint's approval history does not match the stored approvals (0 in the checkpoint, 1 stored)"] });
  });

  it("fails safely on a missing, malformed, truncated or unsupported checkpoint, and never starts over", async () => {
    const dir = tmp();
    await beforeRestart(dir, false);
    const good = readFileSync(file(dir), "utf8");
    const attempt = async () => { const p = processFor(new RunStore(dir), []); const r = await restore(new RunStore(dir), p.graph, p.ctx); return { r, next: (await p.graph.getState(cfg(RUN))).next }; };

    writeFileSync(file(dir), good.slice(0, good.length / 3));
    let { r, next } = await attempt();
    expect(r).toEqual({ ok: false, missing: false, reasons: ["checkpoint.json is not valid JSON (it may be an interrupted write)"] });
    expect(next).toEqual([]); // nothing was started

    writeFileSync(file(dir), JSON.stringify({ ...JSON.parse(good), format_version: 7 }));
    expect((await attempt()).r).toEqual({ ok: false, missing: false, reasons: ["checkpoint.json has unsupported format digikon.checkpoint version 7"] });
    writeFileSync(file(dir), JSON.stringify({ ...JSON.parse(good), graph_version: "director-graph/1" }));
    expect((await attempt()).r).toEqual({ ok: false, missing: false, reasons: [`checkpoint.json was made by graph version director-graph/1, but this server runs ${DIRECTOR_GRAPH_VERSION}`] });
    writeFileSync(file(dir), JSON.stringify({ ...JSON.parse(good), state: { ...JSON.parse(good).state, gate: "edit_plan" } }));
    ({ r } = await attempt());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons[0]).toMatch(/^checkpoint.json is not a valid Director state \(/);

    rmSync(file(dir));
    expect((await attempt()).r).toEqual({ ok: false, missing: true, reasons: [`there is no saved checkpoint for run ${RUN}`] });
  });

  it("rejects a checkpoint that belongs to a different run or session", async () => {
    const dir = tmp();
    await beforeRestart(dir, false);
    const env = JSON.parse(readFileSync(file(dir), "utf8"));
    writeFileSync(file(dir), JSON.stringify({ ...env, run_id: `${SESSION}-2` }));
    const p = processFor(new RunStore(dir), []);
    expect(await restore(new RunStore(dir), p.graph, p.ctx)).toEqual({ ok: false, missing: false, reasons: [`checkpoint.json belongs to run ${SESSION}-2, not ${RUN}`] });
    writeFileSync(file(dir), JSON.stringify(env));
    expect(await restore(new RunStore(dir), p.graph, p.ctx, { session_id: "ffffffffffff" })).toEqual({ ok: false, missing: false, reasons: [`checkpoint.json belongs to session ${SESSION}, not ffffffffffff`] });
  });

  it("reports a failed checkpoint write as a failure and keeps the last good checkpoint", async () => {
    const dir = tmp();
    const before = await beforeRestart(dir, false);
    const good = readFileSync(file(dir), "utf8");
    const failing = new RunStore(dir, { commit: () => { throw new Error("disk full"); } });
    expect(() => save(failing, { ...before, trace: [...before.trace, "later"] })).toThrow(PersistenceError);
    expect(readFileSync(file(dir), "utf8")).toBe(good);
  });

  it("detects plans, approvals or assets changed after the checkpoint, using the existing checks", async () => {
    const dir = tmp();
    await beforeRestart(dir, true);
    const good = JSON.parse(readFileSync(file(dir), "utf8"));
    const attempt = async (env: unknown, files = disk()) => {
      writeFileSync(file(dir), JSON.stringify(env));
      const p = processFor(new RunStore(dir), []);
      return restore(new RunStore(dir), p.graph, { ...p.ctx, files });
    };
    const plan = structuredClone(good); plan.state.scenePlan.scenes[0].purpose = "never reviewed";
    const r1 = await attempt(plan);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reasons).toContain("the storyboard changed after it was approved (hash mismatch)");

    const approval = structuredClone(good); approval.state.approvals[0].notes = "edited";
    expect(await attempt(approval)).toEqual({ ok: false, missing: false, reasons: ["the checkpoint's approval history does not match the stored approvals"] });

    const fact = structuredClone(good); fact.state.facts[0].text = "Roasted daily";
    const r3 = await attempt(fact);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reasons).toContain("the assets or approved facts changed after the storyboard was approved (evidence hash mismatch)");

    const r4 = await attempt(good, disk({ "beans.mp4": "c".repeat(64) }));
    expect(r4).toEqual({ ok: false, missing: false, reasons: ["asset asset_beans content changed: its SHA-256 is not the one recorded at upload"] });

    expect((await attempt(good)).ok).toBe(true); // the unchanged checkpoint still restores
  });
});
