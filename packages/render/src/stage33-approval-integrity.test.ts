import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as contracts from "@digikon/contracts";
import { ApprovalRecord, compiledPlanHash, productionBindingOf, productionPlanHash, type Renderer } from "@digikon/contracts";
import {
  DIRECTOR_GRAPH_VERSION, PRODUCTION_REASON, PreflightRefusedError, RunStore, ScriptedClient, approveCurrent, attachPreflight, buildDirectorGraph, checkRenderable, checkpointOf, currentEditPlan,
  restoreRun, verifyProductionBinding, verifyProductionIntegrity, type DirectorStateType, type PreflightRequest, type ProductionPort,
} from "@digikon/director";
import {
  AdapterRegistry, CAPABILITY_CATALOG, CapabilityRegistry, createFfmpegAdapter, createRemotionAdapter, declaredImplementations, findRemotionBrowser, implementationsOf,
  loadCapabilityRegistry, loadVisualCapabilities, runAdapterPreflight, sealPreflightResult,
} from "./index.js";
import { cfg, deps, learnInput, learnStoryboard, learnTreatment, recipes, root, use } from "../../director/src/fixtures.js";

// Gate 2 approval integrity (Stage 3.3), through the real adapters' planners where this machine has a font and a Remotion browser. Nothing is rendered.
const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
const hasReal = !!font && !!findRemotionBrowser();
const tmp = mkdtempSync(join(tmpdir(), "stage33-"));
const out = join(tmp, "out");
mkdirSync(out);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const capDir = join(root(""), "capabilities");
const learned = loadCapabilityRegistry(capDir, { dependency: () => null, recipes: { get: (id) => recipes.find((r) => r.recipe_id === id) } });
const visual = loadVisualCapabilities(capDir);
const DECL = declaredImplementations(learned.usable);
const ready = { status: "ready", questions: [] };
const text = (t: string) => ({ text: t, safe_area: "platform_safe" });
const withText = learnStoryboard({ S03: { overlay: text("Everything in one place.") }, S04: { overlay: text("Your progress, at a glance.") }, S05: { overlay: text("Learn at your own pace.") } });
const GOOD_EDIT = { uses: [
  use(1, "S01", "text-fade-up"), use(2, "S02", "text-word-stagger"), use(3, "S03", "text-fade-up"), use(4, "S03", "crossfade", { duration_s: 0.6 }), use(5, "S04", "text-fade-up"),
  use(6, "S05", "text-word-stagger"), use(7, "S05", "crossfade", { duration_s: 0.6 }), use(8, "S06", "text-fade-up"),
] };

/** A port over the real adapters, whose registry the test can change between the moment Gate 2 is shown and the moment the decision arrives. */
function kit() {
  const composed = CAPABILITY_CATALOG.filter((c) => c.engine === "remotion" && c.family !== "xfade_transition").map((c) => ({ template: c.template, family: c.family as never, type: c.operation_type as never, motion: c.motion ?? "" }));
  const transitions = CAPABILITY_CATALOG.filter((c) => c.engine === "ffmpeg").map((c) => ({ template: c.template, storyboard_transition: c.storyboard_transition, xfade: c.xfade, direction_map: c.direction_map }));
  const adapters = new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot: out, learned: transitions }), createRemotionAdapter({ fontFile: font!, outputRoot: out, learned: composed })]);
  const drift = { mode: "none" as "none" | "metadata" | "engine_lost" };
  const port: ProductionPort = {
    capabilities: () => {
      const snap = CapabilityRegistry.from({ recipes, learned, visual, implementations: implementationsOf(adapters), declared: DECL }).snapshot;
      const engines = adapters.renderers() as Renderer[];
      if (drift.mode === "metadata") return { snapshot: { ...snap, snapshot_hash: "9".repeat(64) }, available_engines: engines }; // unrelated registry metadata only
      if (drift.mode === "engine_lost") return { snapshot: snap, available_engines: engines.filter((e) => e !== "remotion") };
      return { snapshot: snap, available_engines: engines };
    },
    preflight: (req) => runAdapterPreflight(req as PreflightRequest, { adapters, outputRoot: out }),
  };
  return { port, drift };
}

const SESSION = "abcdef012345";
let n = 0;
/** One "process": a graph writing its decisions to the store, optionally with a production port. */
function processFor(store: RunStore, run: string, answers: unknown[], port?: ProductionPort) {
  const d = { ...deps(new ScriptedClient(answers)), approvalLog: store.approvalLog(run), ...(port ? { production: port } : {}) };
  return { d, graph: buildDirectorGraph(d), ctx: { recipes: d.recipes } };
}
const newRun = () => `${SESSION}-${++n}`;
const save = (store: RunStore, run: string, s: DirectorStateType) => store.saveCheckpoint(checkpointOf(s, { session_id: SESSION, run_id: run }));
const state = async (g: ReturnType<typeof buildDirectorGraph>, run: string) => (await g.getState(cfg(run))).values as DirectorStateType;

async function toGate2(port: ProductionPort | undefined) {
  const dir = mkdtempSync(join(tmp, "run-"));
  const store = new RunStore(dir), run = newRun();
  const p = processFor(store, run, [ready, learnTreatment(), withText, GOOD_EDIT], port);
  const g1 = await p.graph.invoke(learnInput, cfg(run));
  const g2 = await p.graph.invoke(approveCurrent(g1), cfg(run)) as DirectorStateType;
  return { dir, store, run, p, g2 };
}
async function approved(port: ProductionPort | undefined) {
  const r = await toGate2(port);
  const done = await r.p.graph.invoke(approveCurrent(r.g2), cfg(r.run)) as DirectorStateType;
  return { ...r, done };
}

describe.skipIf(!hasReal)("Gate 2 approval binds the production implementation", () => {
  it("records production_required at Gate 1 and a production binding at Gate 2, without changing plan_hash", async () => {
    const { port } = kit();
    const { done, store, run } = await approved(port);
    const [sb, ep] = done.approvals;
    expect(sb).toMatchObject({ stage: "storyboard", decision: "approved", production_required: true });
    expect(ep!.production_required).toBeUndefined();
    expect(ep!.plan_hash).toBe(currentEditPlan(done)!.hash); // the Director edit-plan hash keeps its meaning
    const binding = productionBindingOf(done.productionPlan!, done.compiledPlan!);
    expect(ep!.production_binding).toEqual(binding);
    expect(binding.edit_plan_hash).toBe(ep!.plan_hash);
    expect(store.loadApprovals(run).records).toEqual(done.approvals); // what is on disk is what the graph holds
    expect(checkRenderable(done, { recipes: deps(new ScriptedClient([])).recipes })).toMatchObject({ ok: true });
  });

  it("is append-only: every decision is a new numbered file and an existing one is never replaced", async () => {
    const { port } = kit();
    const { store, run, dir } = await approved(port);
    const files = readdirSync(join(dir, "runs", run, "approvals")).sort();
    expect(files).toEqual(["000001.json", "000002.json"]);
    const rec = store.loadApprovals(run).records[1]!;
    expect(() => store.writeApprovalFile(run, 2, rec)).toThrow(/never overwritten/);
    expect(store.loadApprovals(run).records).toHaveLength(2);
  });

  it("the binding does not depend on creation times or unrelated registry metadata", async () => {
    const { port } = kit();
    const { done } = await approved(port);
    const plan = { ...done.productionPlan!, created_at: "2030-01-01T00:00:00.000Z", registry: { ...done.productionPlan!.registry, snapshot_hash: "8".repeat(64) } };
    const compiled = { ...done.compiledPlan!, created_at: "2030-01-01T00:00:00.000Z" };
    expect(productionBindingOf(plan, compiled).binding_hash).toBe(productionBindingOf(done.productionPlan!, done.compiledPlan!).binding_hash);
  });
});

describe.skipIf(!hasReal)("tampering with the plans after approval is detected", () => {
  const ctx = { recipes: deps(new ScriptedClient([])).recipes };
  const reasonsOf = (s: Partial<DirectorStateType> & Record<string, unknown>, base: DirectorStateType) => {
    const r = checkRenderable({ ...base, ...s } as DirectorStateType, ctx);
    return r.ok ? [] : r.reasons.filter((x) => x.startsWith(PRODUCTION_REASON));
  };
  const rehashPlan = (p: contracts.ProductionDecisionPlan) => ({ ...p, plan_hash: productionPlanHash(p) });
  const rehashCompiled = (c: contracts.CompiledEditPlan) => ({ ...c, compiled_hash: compiledPlanHash(c) });

  it("an untouched approved run has no production reasons", async () => {
    const { done } = await approved(kit().port);
    expect(reasonsOf({}, done)).toEqual([]);
  });
  it("a changed compiled operation, even with its hash recomputed, no longer matches the approval", async () => {
    const { done } = await approved(kit().port);
    const c = done.compiledPlan!;
    const tampered = rehashCompiled({ ...c, operations: c.operations.map((o, i) => (i === 0 ? { ...o, parameters: { ...o.parameters, duration_s: 9 } } : o)) });
    expect(reasonsOf({ compiledPlan: tampered }, done).join(" ")).toMatch(/compiled operations changed after approval/);
    expect(reasonsOf({ compiledPlan: { ...c, operations: tampered.operations } }, done).join(" ")).toMatch(/compiled plan changed after it was made/); // hash not recomputed
  });
  it("a changed production decision, even with the plan hash recomputed, no longer matches the approval", async () => {
    const { done } = await approved(kit().port);
    const p = done.productionPlan!;
    const tampered = rehashPlan({ ...p, decisions: p.decisions.map((d, i) => (i === 0 ? { ...d, implementation_ref: "remotion/other" } : d)) });
    const r = reasonsOf({ productionPlan: tampered }, done).join(" ");
    expect(r).toMatch(/production decisions changed after approval/);
    expect(r).toMatch(/different production selection/); // the compiled plan names the old selection
  });
  it("a hand-set summary, edited pre-flight diagnostics or a swapped pre-flight are all caught", async () => {
    const { done } = await approved(kit().port);
    const p = done.productionPlan!;
    expect(reasonsOf({ productionPlan: rehashPlan({ ...p, summary: { ...p.summary, blocked: 2 } }) }, done).join(" ")).toMatch(/summary counts/);
    const edited = { ...p, preflight: { ...p.preflight, scenes: p.preflight.scenes.map((s, i) => (i === 0 ? { ...s, diagnostics: ["note"] } : s)) } };
    expect(reasonsOf({ productionPlan: rehashPlan(edited as never) }, done).join(" ")).toMatch(/production plan preflight|does not match its hash|malformed|Invalid|pre-flight/i);
  });
  it("a pre-flight produced over different compiled operations is refused", async () => {
    const { done } = await approved(kit().port);
    const p = done.productionPlan!, c = done.compiledPlan!;
    const pf = p.preflight;
    const other = sealPreflightResult({ status: "passed", frame: pf.frame!, bound_selection_hash: pf.bound_selection_hash!, bound_compiled_hash: "1".repeat(64), scenes: pf.scenes });
    const forged = rehashPlan({ ...p, preflight: other });
    expect(verifyProductionIntegrity(forged, c, { storyboard: p.storyboard, edit_plan: p.edit_plan }).join(" ")).toMatch(/over different compiled operations/);
    expect(() => attachPreflight({ ...p, preflight: contracts.NOT_RUN_PREFLIGHT }, other, c.compiled_hash)).toThrow(PreflightRefusedError);
    expect(() => attachPreflight({ ...p, preflight: contracts.NOT_RUN_PREFLIGHT }, other, c.compiled_hash)).toThrow(/different compiled operations/);
  });
  it("a production-required run without plans, or without a binding on its approval, fails closed", async () => {
    const { done } = await approved(kit().port);
    expect(reasonsOf({ productionPlan: null, compiledPlan: null }, done).join(" ")).toMatch(/plans are missing/);
    const stripped = done.approvals.map((a) => { const { production_binding: _b, ...rest } = a; return ApprovalRecord.parse(rest); });
    expect(reasonsOf({ approvals: stripped }, done).join(" ")).toMatch(/no production binding/);
  });
  it("a binding that names a different edit plan than the approval is refused", async () => {
    const { done } = await approved(kit().port);
    const rec = done.approvals[1]!;
    expect(verifyProductionBinding({ plan_hash: "c".repeat(64), production_binding: rec.production_binding }, done.productionPlan, done.compiledPlan).join(" ")).toMatch(/different edit plan/);
  });
  it("legacy runs without production planning are accepted as before", async () => {
    const { done } = await approved(undefined);
    expect(done.productionPlan ?? null).toBeNull();
    expect(done.approvals.some((a) => a.production_required || a.production_binding)).toBe(false);
    expect(checkRenderable(done, ctx)).toMatchObject({ ok: true });
  });
});

describe.skipIf(!hasReal)("a stale Gate 2 decision is never applied", () => {
  it("capability drift between display and decision: nothing is approved, the user is told in ordinary words, no technical detail", async () => {
    const { port, drift } = kit();
    const { p, run, g2, store } = await toGate2(port);
    expect(g2.status).toBe("awaiting_approval");
    drift.mode = "engine_lost";
    const after = await p.graph.invoke(approveCurrent(g2), cfg(run)) as DirectorStateType;
    expect(after.status).toBe("escalated");
    expect(after.approvals.filter((a) => a.stage === "edit_plan")).toEqual([]); // the stale decision was not recorded
    expect(store.loadApprovals(run).records.filter((a) => a.stage === "edit_plan")).toEqual([]);
    const said = JSON.stringify(after.escalation);
    expect(said).not.toMatch(/capabilit|engine|hash|binding|pre-flight|preflight|remotion|ffmpeg|selection|compiled/i);
    expect(after.escalation!.decision_needed).toMatch(/change the plan|different material/);
  });
  it("plans that no longer hold together are prepared again from the approved plans before the decision, and the tampered ones are never approved", async () => {
    const { port } = kit();
    const { p, run, g2 } = await toGate2(port);
    const broken = { ...g2.compiledPlan!, operations: g2.compiledPlan!.operations.map((o, i) => (i === 0 ? { ...o, parameters: { ...o.parameters, duration_s: 9 } } : o)) }; // hash left as it was
    await p.graph.updateState(cfg(run), { compiledPlan: broken });
    const after = await p.graph.invoke(approveCurrent(g2), cfg(run)) as DirectorStateType;
    expect(after.status).toBe("approved");
    expect(after.compiledPlan!.compiled_hash).toBe(g2.compiledPlan!.compiled_hash); // the intact compiled plan, prepared again
    expect(after.compiledPlan!.operations).toEqual(g2.compiledPlan!.operations);
    expect(checkRenderable(after, { recipes: deps(new ScriptedClient([])).recipes })).toMatchObject({ ok: true });
  });
  it("a change only in unrelated registry metadata does not stop the approval", async () => {
    const { port, drift } = kit();
    const { p, run, g2 } = await toGate2(port);
    drift.mode = "metadata";
    const after = await p.graph.invoke(approveCurrent(g2), cfg(run)) as DirectorStateType;
    expect(after.status).toBe("approved");
    expect(after.approvals[1]!.production_binding).toBeDefined();
  });
  it("a run that needs production planning cannot be approved by a process that has no production service", async () => {
    const { port } = kit();
    const { g2, store, run } = await toGate2(port);
    const bare = processFor(store, run, []); // same run, no port
    const s = await bare.graph.invoke(null, cfg(run)).catch(() => null);
    void s; void g2;
    // a gate built without the port, over a state whose storyboard approval says production is required
    const g = buildDirectorGraph({ ...bare.d });
    await g.updateState(cfg("nop-1"), { ...g2, pendingRevision: null }, "edit_plan");
    const r = await g.invoke(null, cfg("nop-1")) as DirectorStateType;
    expect(r.status).toBe("escalated");
    expect(r.approvals.filter((a) => a.stage === "edit_plan")).toEqual([]);
    expect(JSON.stringify(r.escalation)).not.toMatch(/capabilit|engine|hash|binding|pre-flight|compiled/i);
  });
});

describe.skipIf(!hasReal)("checkpoint restoration", () => {
  const files = (dir: string, run: string) => join(dir, "runs", run, "checkpoint.json");
  const restore = (dir: string, run: string, answers: unknown[] = []) => {
    const store = new RunStore(dir);
    const p = processFor(store, run, answers, kit().port);
    return restoreRun({ store, graph: p.graph, session_id: SESSION, run_id: run, ctx: p.ctx });
  };

  it("a valid Gate 2 checkpoint restores with both plans, and a valid approved checkpoint restores", async () => {
    const { dir, store, run, g2 } = await toGate2(kit().port);
    save(store, run, g2);
    const r = await restore(dir, run);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    expect(r.state).toMatchObject({ status: "awaiting_approval", gate: "edit_plan" });
    expect(r.state.productionPlan!.plan_hash).toBe(g2.productionPlan!.plan_hash);
    expect(r.state.compiledPlan!.compiled_hash).toBe(g2.compiledPlan!.compiled_hash);

    const a = await approved(kit().port);
    save(a.store, a.run, a.done);
    const r2 = await restore(a.dir, a.run);
    if (!r2.ok) throw new Error(r2.reasons.join("; "));
    expect(r2.state.status).toBe("approved");
  });

  it("a Gate 1 checkpoint needs no production plans", async () => {
    const dir = mkdtempSync(join(tmp, "run-"));
    const store = new RunStore(dir), run = newRun();
    const p = processFor(store, run, [ready, learnTreatment(), withText, GOOD_EDIT], kit().port);
    const g1 = await p.graph.invoke(learnInput, cfg(run)) as DirectorStateType;
    expect(g1.gate).toBe("storyboard");
    save(store, run, g1);
    const r = await restore(dir, run, [GOOD_EDIT]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    expect(r.state.productionPlan ?? null).toBeNull();
  });

  const tamper = (dir: string, run: string, edit: (cp: any) => void) => {
    const f = files(dir, run);
    const cp = JSON.parse(readFileSync(f, "utf8"));
    edit(cp);
    writeFileSync(f, JSON.stringify(cp));
  };
  it("a changed compiled operation, production decision or summary in the checkpoint is refused", async () => {
    for (const edit of [
      (cp: any) => { cp.state.compiledPlan.operations[0].parameters.duration_s = 9; },
      (cp: any) => { cp.state.productionPlan.decisions[0].implementation_ref = "remotion/other"; },
      (cp: any) => { cp.state.productionPlan.summary.blocked = 3; },
    ]) {
      const { dir, store, run, g2 } = await toGate2(kit().port);
      save(store, run, g2);
      tamper(dir, run, edit);
      const r = await restore(dir, run);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons.join(" ")).toMatch(new RegExp(`${PRODUCTION_REASON}|production|plan`, "i"));
    }
  });
  it("a production-required Gate 2 checkpoint with its plans removed is refused (fail closed)", async () => {
    const { dir, store, run, g2 } = await toGate2(kit().port);
    save(store, run, g2);
    tamper(dir, run, (cp) => { cp.state.productionPlan = null; cp.state.compiledPlan = null; });
    const r = await restore(dir, run);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toContain(`${PRODUCTION_REASON}: the production plans are missing`);
  });
  it("an approved production run whose stored approval lost its binding is refused", async () => {
    const a = await approved(kit().port);
    save(a.store, a.run, a.done);
    // the checkpoint and the stored approval file are both edited to drop the binding: the plans alone cannot make it acceptable
    const dirApprovals = join(a.dir, "runs", a.run, "approvals");
    const f2 = join(dirApprovals, "000002.json");
    const env = JSON.parse(readFileSync(f2, "utf8"));
    delete env.record.production_binding;
    writeFileSync(f2, JSON.stringify(env));
    tamper(a.dir, a.run, (cp) => { delete cp.state.approvals[1].production_binding; });
    const r = await restore(a.dir, a.run);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toContain("no production binding");
  });
  it("a legacy checkpoint (no production fields, no flag) still restores at Gate 2", async () => {
    const { dir, store, run, g2 } = await toGate2(undefined);
    expect(g2.productionPlan ?? null).toBeNull();
    save(store, run, g2);
    const store2 = new RunStore(dir);
    const p = processFor(store2, run, []); // no port, as before
    const r = await restoreRun({ store: store2, graph: p.graph, session_id: SESSION, run_id: run, ctx: p.ctx });
    if (!r.ok) throw new Error(r.reasons.join("; "));
    expect(r.state.gate).toBe("edit_plan");
  });
});

describe("no-port workflows are unchanged", () => {
  it("a graph built without a port records no production fields and needs no plans", async () => {
    const { done } = await approved(undefined);
    expect(done.approvals.map((a) => [a.stage, a.production_required, a.production_binding])).toEqual([["storyboard", undefined, undefined], ["edit_plan", undefined, undefined]]);
    expect(done.status).toBe("approved");
  });
  it("the checkpoint format and graph version are unchanged", () => {
    expect(DIRECTOR_GRAPH_VERSION).toBe("director-graph/5");
  });
});

// ---------- the sealing boundary and workflow consistency (source-level guards) ----------
const repo = join(root(""));
const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name === "dist" ? [] : e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
describe("the pre-flight sealing boundary", () => {
  it("is not part of the public contracts API", () => {
    expect("sealPreflightResult" in contracts).toBe(false);
    expect("preflightResultHash" in contracts).toBe(true); // verification stays available to those that check results
  });
  it("only the render pre-flight module (and tests) builds a sealed result", () => {
    const users = [...sourceFiles(join(repo, "packages")), ...sourceFiles(join(repo, "apps"))]
      .filter((f) => !f.endsWith(".test.ts") && /sealPreflightResult/.test(readFileSync(f, "utf8")))
      .map((f) => relative(repo, f).replaceAll("\\", "/"));
    expect(users.sort()).toEqual(["packages/render/src/preflight.ts"]);
  });
});
describe("every workflow records its production status", () => {
  it("each console graph is built with the production port when one exists, and the CLI builds none", () => {
    const app = readFileSync(join(repo, "apps/console/src/app.ts"), "utf8");
    const calls = app.split("buildDirectorGraph(").slice(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c.slice(0, 400)).toMatch(/production: productionPortFor\(/);
    const cli = readFileSync(join(repo, "packages/director/src/cli.ts"), "utf8");
    expect(cli).not.toMatch(/production:/); // the CLI has no ProductionPort, so none of its runs is production-required
  });
});
