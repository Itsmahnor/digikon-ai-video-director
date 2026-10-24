import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { Asset, editPlanHash, storyboardHash, type ApprovalRecord, type DirectorHandoff } from "@digikon/contracts";
import {
  PersistenceError, RunStore, ScriptedClient, SkillLibrary, approveCurrent, assetFileProblems, buildDirectorGraph, buildHandoff, currentEvidenceHash, gateDecision, verifyHandoffWithStore,
  type DirectorStateType,
} from "./index.js";
import { assets, cfg, deps, goodEdit, goodStoryboard, input, knowledge, root, treatment } from "./fixtures.js";

const ready = { status: "ready", questions: [] };
const skills = new SkillLibrary(root("skills"));
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "store-test-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const SHA = { beans: "a".repeat(64), logo: "b".repeat(64) };
const hashed = [
  Asset.parse({ ...assets[0], metadata: { bytes: 4_000_000, sha256: SHA.beans } }),
  Asset.parse({ ...assets[1], metadata: { bytes: 50_000, sha256: SHA.logo } }),
];
/** Stands in for the disk: sizes and content hashes of the fixture files. */
const disk = (over: { size?: Record<string, number | null>; sha?: Record<string, string> } = {}) => {
  const size: Record<string, number | null> = { "beans.mp4": 4_000_000, "logo.png": 50_000, ...over.size };
  const sha: Record<string, string> = { "beans.mp4": SHA.beans, "logo.png": SHA.logo, ...over.sha };
  const reads: string[] = [];
  return { reads, size: (u: string) => (u in size ? size[u]! : null), sha256: (u: string) => { reads.push(u); return sha[u] ?? null; } };
};

/** A full run to both approvals with every approval written to `store`, then a handoff. */
async function approvedRun(store: RunStore, run_id: string, opts: { files?: ReturnType<typeof disk> } = {}) {
  const d = { ...deps(new ScriptedClient([ready, treatment, goodStoryboard, goodEdit])), approvalLog: store.approvalLog(run_id) };
  const graph = buildDirectorGraph(d);
  const g1 = await graph.invoke({ ...input, assets: hashed }, cfg(run_id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(run_id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(run_id))) as DirectorStateType;
  const ctx = { recipes: d.recipes, skills, knowledge, run_id, model: "scripted", files: opts.files ?? disk(), requireContentHash: true };
  return { d, graph, done, ctx, handoff: buildHandoff(done, ctx) };
}
const approvalFiles = (rootDir: string, run: string) => readdirSync(join(rootDir, "runs", run, "approvals")).sort();

describe("approval and handoff persistence", () => {
  it("writes each approval as it is made and recovers them, and the handoff, after a restart", async () => {
    const dir = tmp();
    const t = await approvedRun(new RunStore(dir), "run-1");
    expect(approvalFiles(dir, "run-1")).toEqual(["000001.json", "000002.json"]);
    new RunStore(dir).saveHandoff(t.handoff);

    const reopened = new RunStore(dir); // a fresh process: nothing in memory
    const loaded = reopened.loadApprovals("run-1");
    expect(loaded.problems).toEqual([]);
    expect(loaded.records).toEqual(t.done.approvals);
    const h = reopened.loadHandoff("run-1");
    expect(h.problems).toEqual([]);
    expect(h.handoff).toEqual(t.handoff);
    expect(verifyHandoffWithStore(h.handoff!, reopened, t.ctx)).toEqual([]); // the valid, unchanged handoff passes
  });

  it("fails closed when a stored approval is missing", async () => {
    const dir = tmp();
    const t = await approvedRun(new RunStore(dir), "run-2");
    rmSync(join(dir, "runs", "run-2", "approvals", "000002.json"));
    expect(verifyHandoffWithStore(t.handoff, new RunStore(dir), t.ctx)).toEqual(["there is no stored edit-plan approval for run run-2"]);
    rmSync(join(dir, "runs", "run-2"), { recursive: true });
    expect(verifyHandoffWithStore(t.handoff, new RunStore(dir), t.ctx)).toEqual([
      "there is no stored storyboard approval for run run-2", "there is no stored edit-plan approval for run run-2",
    ]);
  });

  it("refuses malformed, truncated, unsupported or inconsistent stored records", async () => {
    const dir = tmp();
    const t = await approvedRun(new RunStore(dir), "run-3");
    const file = join(dir, "runs", "run-3", "approvals", "000002.json");
    const good = readFileSync(file, "utf8");
    const check = () => verifyHandoffWithStore(t.handoff, new RunStore(dir), t.ctx);

    writeFileSync(file, good.slice(0, good.length / 2)); // a write cut off half way
    expect(check()).toEqual(["stored approvals cannot be trusted: 000002.json is not valid JSON (it may be an interrupted write)"]);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(good), format_version: 99 }));
    expect(check()).toEqual(["stored approvals cannot be trusted: 000002.json has unsupported format digikon.approval version 99"]);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(good), run_id: "run-other" }));
    expect(check()).toEqual(["stored approvals cannot be trusted: 000002.json belongs to run run-other, not run-3"]);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(good), record: { ...JSON.parse(good).record, plan_hash: "nope" } }));
    expect(check()[0]).toMatch(/^stored approvals cannot be trusted: 000002.json is not a valid approval record \(plan_hash/);
    writeFileSync(file, good);
    writeFileSync(join(dir, "runs", "run-3", "approvals", "000004.json"), JSON.stringify({ ...JSON.parse(good), seq: 4 }));
    expect(check()).toEqual(["stored approvals cannot be trusted: approval 000003.json is missing (the sequence has a gap)"]);
  });

  it("refuses a handoff whose own hash is valid but whose approvals differ from the stored ones", async () => {
    const dir = tmp();
    const t = await approvedRun(new RunStore(dir), "run-4");
    // Built from a state whose edit-plan approval differs from what the gate stored.
    const forged = structuredClone(t.done);
    forged.approvals = [forged.approvals[0]!, { ...forged.approvals[1]!, decided_at: "2030-01-01T00:00:00.000Z", notes: "rubber stamp" }];
    const h = buildHandoff(forged, t.ctx);
    expect(verifyHandoffWithStore(h, new RunStore(dir), t.ctx)).toEqual(["the handoff's edit-plan approval does not match the stored record (decided_at, notes differ)"]);
    // A stored change request after the approval means the stored state no longer authorises the plan.
    const store = new RunStore(dir);
    store.appendApproval("run-4", { ...t.done.approvals[1]!, decision: "revision_requested", notes: "changed my mind" } as ApprovalRecord);
    expect(verifyHandoffWithStore(t.handoff, store, t.ctx)).toEqual(["the latest stored edit-plan decision for run run-4 is a change request, not an approval"]);
  });

  it("refuses a handoff whose plan or evidence changed after approval, even with every hash recomputed", async () => {
    const dir = tmp();
    const t = await approvedRun(new RunStore(dir), "run-5");
    // A fact edited after approval: the Director itself refuses.
    const fact = structuredClone(t.done);
    fact.facts[0]!.text = "Roasted daily";
    expect(() => buildHandoff(fact, t.ctx)).toThrow(/evidence hash mismatch/);

    // Someone also recomputes the approval hashes in memory so the handoff is internally consistent. The stored records disagree.
    fact.approvals = fact.approvals.map((a) => ({ ...a, evidence_hash: currentEvidenceHash(fact)! }));
    const selfConsistent = buildHandoff(fact, t.ctx);
    expect(verifyHandoffWithStore(selfConsistent, new RunStore(dir), t.ctx)).toEqual([
      "the handoff's storyboard approval does not match the stored record (evidence_hash differs)",
      "the handoff's edit-plan approval does not match the stored record (evidence_hash differs)",
    ]);

    // The same for a plan edited after approval.
    const plan = structuredClone(t.done);
    plan.editPlan!.uses[0]!.rationale = "edited after approval";
    const sb = { version: 1, hash: storyboardHash(plan.treatmentDoc!, plan.scenePlan!) };
    plan.approvals = [plan.approvals[0]!, { ...plan.approvals[1]!, plan_hash: editPlanHash(sb, plan.editPlan!) }];
    expect(verifyHandoffWithStore(buildHandoff(plan, t.ctx), new RunStore(dir), t.ctx)).toEqual(["the handoff's edit-plan approval does not match the stored record (plan_hash differs)"]);
    expect(verifyHandoffWithStore(t.handoff, new RunStore(dir), t.ctx)).toEqual([]); // the original still passes
  });

  it("detects a same-size replacement of an uploaded file through its content hash, reading each file once", async () => {
    const dir = tmp();
    const t = await approvedRun(new RunStore(dir), "run-6");
    const files = disk({ sha: { "beans.mp4": "d".repeat(64) } });
    expect(verifyHandoffWithStore(t.handoff, new RunStore(dir), { ...t.ctx, files })).toEqual([
      "asset asset_beans content changed: its SHA-256 is not the one recorded at upload",
    ]);
    expect(files.reads).toEqual(["beans.mp4", "logo.png"]);
    // Removing the recorded hash from a handoff changes its approved evidence, so that is caught first.
    const unhashed = structuredClone(t.handoff); delete (unhashed.assets[1]!.metadata as Record<string, unknown>)["sha256"];
    expect(verifyHandoffWithStore(unhashed as DirectorHandoff, new RunStore(dir), t.ctx)).toEqual(expect.arrayContaining([
      "the handoff content changed after it was made (content hash mismatch)",
      "the assets or facts in the handoff are not the ones that were approved (evidence hash mismatch)",
    ]));
    // An asset that never had a hash is refused where hashes are required, and passes on size alone where they are not.
    expect(assetFileProblems([unhashed.assets[1]!], disk(), undefined, true)).toEqual(["asset asset_logo has no recorded content hash, so its file cannot be verified"]);
    expect(assetFileProblems([unhashed.assets[1]!], disk(), undefined, false)).toEqual([]);
  });

  it("aborts the decision when its approval cannot be written, leaving nothing approved", async () => {
    const dir = tmp();
    const store = new RunStore(dir, { commit: () => { throw new Error("disk full"); } });
    const d = { ...deps(new ScriptedClient([ready, treatment, goodStoryboard, goodEdit])), approvalLog: store.approvalLog("run-7") };
    const saver = new MemorySaver();
    const graph = buildDirectorGraph(d, saver);
    const g1 = await graph.invoke({ ...input, assets: hashed }, cfg("run-7"));
    await expect(graph.invoke(approveCurrent(g1), cfg("run-7"))).rejects.toThrow(PersistenceError);
    const after = (await graph.getState(cfg("run-7"))).values as DirectorStateType;
    expect(after.approvals).toEqual([]);
    expect(after.gate).toBe("storyboard");
    expect(readdirSync(join(dir, "runs", "run-7", "approvals")).filter((f) => f.endsWith(".json"))).toEqual([]); // no partial record left as valid

    // Once the disk works again, the same decision goes through and is stored.
    const ok = buildDirectorGraph({ ...d, approvalLog: new RunStore(dir).approvalLog("run-7") }, saver);
    const g2 = await ok.invoke(approveCurrent(after), cfg("run-7"));
    expect(g2.gate).toBe("edit_plan");
    expect(new RunStore(dir).loadApprovals("run-7").records).toEqual(g2.approvals);
  });

  it("ignores a leftover temporary file from an interrupted write, and never overwrites a stored record", async () => {
    const dir = tmp();
    const t = await approvedRun(new RunStore(dir), "run-8");
    const approvals = join(dir, "runs", "run-8", "approvals");
    writeFileSync(join(approvals, "000003.json.123.tmp"), readFileSync(join(approvals, "000002.json")));
    const loaded = new RunStore(dir).loadApprovals("run-8");
    expect(loaded.problems).toEqual([]);
    expect(loaded.records).toHaveLength(2);
    expect(() => new RunStore(dir).writeApprovalFile("run-8", 2, t.done.approvals[1]!)).toThrow(PersistenceError);
  });

  it("refuses unsafe run ids and an unsupported stored handoff", async () => {
    const dir = tmp();
    const store = new RunStore(dir);
    expect(() => store.loadApprovals("../escape")).toThrow(PersistenceError);
    const t = await approvedRun(store, "run-9");
    store.saveHandoff(t.handoff);
    const file = join(dir, "runs", "run-9", "handoff.json");
    const env = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...env, handoff: { ...env.handoff, schema_version: "0.9.0" } }));
    const h = store.loadHandoff("run-9");
    expect(h.handoff).toBeNull();
    expect(h.problems[0]).toMatch(/handoff.json is not a valid handoff \(schema_version/);
    expect(store.loadHandoff("run-none")).toEqual({ handoff: null, problems: [] });
  });

  it("keeps the two gates: a change request is stored too, and only the exact current version can be approved", async () => {
    const dir = tmp();
    const store = new RunStore(dir);
    const d = { ...deps(new ScriptedClient([ready, treatment, goodStoryboard, goodStoryboard, goodEdit])), approvalLog: store.approvalLog("run-10") };
    const graph = buildDirectorGraph(d);
    await graph.invoke({ ...input, assets: hashed }, cfg("run-10"));
    await graph.invoke(gateDecision("storyboard", 1, "revision_requested", "shorter"), cfg("run-10"));
    await graph.invoke(gateDecision("storyboard", 1, "approved"), cfg("run-10")); // stale: refused, nothing stored
    expect(store.loadApprovals("run-10").records.map((r) => [r.plan_version, r.decision])).toEqual([[1, "revision_requested"]]);
  });
});
