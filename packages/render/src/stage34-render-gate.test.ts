import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RenderSettings, compiledPlanHash, type EditorOperation, type Renderer } from "@digikon/contracts";
import {
  ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, currentEditPlan, currentStoryboard, runEditor, type DirectorStateType, type EditorDeps, type PreflightRequest, type ProductionPort,
} from "@digikon/director";
import {
  AdapterRegistry, CAPABILITY_CATALOG, CapabilityRegistry, createFfmpegAdapter, createRemotionAdapter, declaredImplementations, findRemotionBrowser, implementationsOf, loadCapabilityRegistry,
  loadVisualCapabilities, planAssembly, planRender, renderTimeProblems, replanAtActualSettings, runAdapterPreflight, verifyProductionForRender, type AssemblyPlan, type ProductionGate,
} from "./index.js";
import { cfg, deps, knowledge, learnInput, learnStoryboard, learnTreatment, recipes, root, use } from "../../director/src/fixtures.js";

// Stage 3.4: the renderer executes what Gate 2 approved. Planning only: no FFmpeg binary is used and nothing is rendered.
const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
const hasReal = !!font && !!findRemotionBrowser();
const tmp = mkdtempSync(join(tmpdir(), "stage34-"));
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
const EDIT = { uses: [
  use(1, "S01", "text-fade-up", { delay_s: 0 }), use(2, "S02", "text-word-stagger"), use(3, "S03", "text-fade-up", { delay_s: 0 }), use(4, "S03", "crossfade", { duration_s: 0.6 }), use(5, "S04", "text-fade-up", { delay_s: 0 }),
  use(6, "S05", "text-word-stagger"), use(7, "S05", "crossfade", { duration_s: 0.6 }), use(8, "S06", "text-fade-up", { delay_s: 0 }),
] };
const settings = (over: Record<string, unknown> = {}) => RenderSettings.parse({ aspect_ratio: "16:9", width: 960, height: 540, fps: 30, duration_s: 30, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "stage 3.4 test" }, ...over });

function kit() {
  const composed = CAPABILITY_CATALOG.filter((c) => c.engine === "remotion" && c.family !== "xfade_transition").map((c) => ({ template: c.template, family: c.family as never, type: c.operation_type as never, motion: c.motion ?? "" }));
  const transitions = CAPABILITY_CATALOG.filter((c) => c.engine === "ffmpeg").map((c) => ({ template: c.template, storyboard_transition: c.storyboard_transition, xfade: c.xfade, direction_map: c.direction_map }));
  const adapters = new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot: out, learned: transitions }), createRemotionAdapter({ fontFile: font!, outputRoot: out, learned: composed })]);
  const drift = { mode: "none" as "none" | "metadata" | "engine_lost" };
  const live = () => {
    const snap = CapabilityRegistry.from({ recipes, learned, visual, implementations: implementationsOf(adapters), declared: DECL }).snapshot;
    const engines = adapters.renderers() as Renderer[];
    if (drift.mode === "metadata") return { snapshot: { ...snap, snapshot_hash: "9".repeat(64) }, available_engines: engines };
    if (drift.mode === "engine_lost") return { snapshot: snap, available_engines: engines.filter((e) => e !== "remotion") };
    return { snapshot: snap, available_engines: engines };
  };
  const port: ProductionPort = { capabilities: live, preflight: (req) => runAdapterPreflight(req as PreflightRequest, { adapters, outputRoot: out }) };
  return { adapters, port, drift, live };
}

let k: ReturnType<typeof kit>;
let done: DirectorStateType;
let editorOps: EditorOperation[];
let handoffInput: ReturnType<typeof buildHandoff>;
let editorOutput: unknown;
const refOf = (w: "storyboard" | "edit_plan") => (w === "storyboard" ? currentStoryboard(done)! : currentEditPlan(done)!);
const gateOf = (over: Partial<Parameters<typeof verifyProductionForRender>[0]> = {}): ProductionGate =>
  verifyProductionForRender({
    records: done.approvals, productionPlan: done.productionPlan, compiledPlan: done.compiledPlan,
    refs: { storyboard: refOf("storyboard"), edit_plan: refOf("edit_plan") }, scenePlan: done.scenePlan!, editPlan: done.editPlan!, assets: done.assets, aspect_ratio: done.project.aspect_ratio,
    editorOperations: editorOps, live: k.live(), ...over,
  });
const reasons = (g: ProductionGate) => (g.bound ? g.reasons.join(" ") : "");

beforeAll(async () => {
  if (!hasReal) return;
  k = kit();
  const d = { ...deps(new ScriptedClient([ready, learnTreatment(), withText, EDIT])), production: k.port };
  const graph = buildDirectorGraph(d);
  const g1 = await graph.invoke(learnInput, cfg("s34"));
  const g2 = await graph.invoke(approveCurrent(g1), cfg("s34"));
  done = (await graph.invoke(approveCurrent(g2), cfg("s34"))) as DirectorStateType;
  handoffInput = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: "s34", model: "scripted" });
  const editor: EditorDeps = { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever };
  const run = await runEditor(handoffInput, editor);
  if (!run.ok) throw new Error(`editor rejected: ${run.reasons.join("; ")}`);
  editorOutput = run.output;
  editorOps = run.output.operations;
});

describe.skipIf(!hasReal)("the render-time gate over a real approved run", () => {
  it("the real Editor hands on exactly the operations that were compiled and approved", () => {
    expect(done.status).toBe("approved");
    const g = gateOf();
    expect(reasons(g)).toBe("");
    expect(g).toMatchObject({ bound: true, ok: true });
  });
  it("an operation changed after approval, dropped, or added is refused", () => {
    const changed = editorOps.map((o, i) => (i === 0 ? { ...o, parameters: { ...o.parameters, duration_s: 9 } } : o));
    expect(gateOf({ editorOperations: changed })).toMatchObject({ bound: true, ok: false });
    expect(reasons(gateOf({ editorOperations: changed }))).toMatch(/was changed after approval/);
    expect(reasons(gateOf({ editorOperations: editorOps.slice(1) }))).toMatch(/did not hand it on/);
    expect(reasons(gateOf({ editorOperations: [...editorOps, { ...editorOps[0]!, operation_id: "E99" }] }))).toMatch(/E99 was not part of the approved plan/);
  });
  it("plan or compiled-plan tampering, and a stripped binding, are refused", () => {
    const c = done.compiledPlan!;
    const bad = { ...c, operations: c.operations.map((o, i) => (i === 0 ? { ...o, parameters: { ...o.parameters, duration_s: 9 } } : o)) };
    expect(reasons(gateOf({ compiledPlan: bad }))).toMatch(/compiled plan changed after it was made/);
    const rehashed = { ...bad, compiled_hash: compiledPlanHash(bad) };
    expect(reasons(gateOf({ compiledPlan: rehashed }))).toMatch(/compiled operations changed after approval/);
    const stripped = done.approvals.map((a) => { const { production_binding: _b, ...rest } = a; return rest as typeof a; });
    expect(reasons(gateOf({ records: stripped }))).toMatch(/no production binding/);
    expect(gateOf({ productionPlan: null, compiledPlan: null })).toMatchObject({ bound: true, ok: false });
  });
  it("registry drift is caught again at render time; unrelated metadata is not", () => {
    k.drift.mode = "engine_lost";
    const lost = gateOf();
    k.drift.mode = "metadata";
    const meta = gateOf();
    k.drift.mode = "none";
    expect(lost).toMatchObject({ bound: true, ok: false });
    expect(meta).toMatchObject({ bound: true, ok: true });
    expect(gateOf({ live: null })).toMatchObject({ bound: true, ok: false }); // an unreadable registry fails closed
  });
  it("a run approved without production planning is not bound (legacy compatibility)", () => {
    const legacy = done.approvals.map((a) => { const { production_binding: _b, production_required: _r, ...rest } = a; return rest as typeof a; });
    expect(gateOf({ records: legacy, productionPlan: null, compiledPlan: null })).toEqual({ bound: false });
  });
});

describe.skipIf(!hasReal)("the renderer cannot choose another implementation or engine", () => {
  const input = () => ({ editor_output: editorOutput, handoff: handoffInput, settings: settings(), purpose: "preview" as const });
  const rdeps = () => ({ recipes: deps(new ScriptedClient([])).recipes, adapters: k.adapters, outputRoot: out });
  const selection = () => (gateOf() as Extract<ProductionGate, { bound: true }>).approved_selection;

  it("the approved selection agrees with what the renderer plans: no selection blocker", () => {
    const r = planRender({ ...input(), approved_selection: selection() }, rdeps());
    if (!r.ok) throw new Error(r.reasons.join("; "));
    expect(r.record.blockers.filter((b) => b.startsWith("approved production plan"))).toEqual([]);
  });
  it("a different approved implementation or engine blocks planning with a named reason, and nothing is substituted", () => {
    const sel = selection();
    const wrongRef = sel.map((s, i) => (i === 0 ? { ...s, implementation_ref: "remotion/not-what-was-approved" } : s));
    const r1 = planRender({ ...input(), approved_selection: wrongRef }, rdeps());
    const wrongEngine = sel.map((s, i) => (i === 0 ? { ...s, engine: "ffmpeg" as const } : s));
    const r2 = planRender({ ...input(), approved_selection: wrongEngine }, rdeps());
    for (const [r, what] of [[r1, /was approved to run remotion\/not-what-was-approved/], [r2, /was approved on ffmpeg but the renderer chose/]] as const) {
      if (!r.ok) throw new Error(r.reasons.join("; "));
      expect(r.plan).toBeNull();
      expect(r.record.state).toBe("planning");
      expect(r.record.blockers.join(" ")).toMatch(what);
    }
  });
  it("assembly refuses outright on a selection mismatch", () => {
    const sel = selection().map((s, i) => (i === 0 ? { ...s, implementation_ref: "remotion/other" } : s));
    const a = planAssembly({ ...input(), approved_selection: sel }, { ...rdeps(), fontFile: font! });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reasons.join(" ")).toMatch(/approved production plan/);
    const fine = planAssembly({ ...input(), approved_selection: selection() }, { ...rdeps(), fontFile: font! });
    expect(fine.ok).toBe(true);
  });
  it("without an approved selection (no production planning) planning is exactly as before", () => {
    const r = planRender(input(), rdeps());
    if (!r.ok) throw new Error(r.reasons.join("; "));
    expect(r.record.blockers.filter((b) => b.startsWith("approved production plan"))).toEqual([]);
  });
});

describe.skipIf(!hasReal)("the approved operations are planned again at the real output settings", () => {
  const replan = (s: ReturnType<typeof settings>) => replanAtActualSettings({
    plan: done.productionPlan, compiled: done.compiledPlan, storyboard: done.scenePlan!, assets: done.assets, art_direction: done.treatmentDoc!.art_direction ?? null,
    aspect_ratio: done.project.aspect_ratio, settings: s, adapters: k.adapters, outputRoot: out,
  });
  it("passes at a normal frame size", () => {
    expect(replan(settings())).toEqual([]);
  });
  it("is judged at the settings given, not the reference frame: the planners see a different job at a different size", () => {
    const req = (): PreflightRequest => ({
      scenePlan: done.scenePlan!, assets: done.assets, art_direction: done.treatmentDoc!.art_direction ?? null, operations: done.compiledPlan!.operations,
      templates: Object.fromEntries(done.compiledPlan!.operations.flatMap((o) => { const d = done.productionPlan!.decisions.find((x) => x.use_id === o.source_use_id); return d?.implementation_ref ? [[o.operation_id, d.implementation_ref]] : []; })),
      aspect_ratio: "16:9", selection_hash: "a".repeat(64), compiled_hash: done.compiledPlan!.compiled_hash,
    });
    const at = (w: number, h: number) => runAdapterPreflight(req(), { adapters: k.adapters, outputRoot: out, settings: settings({ width: w, height: h }) });
    const small = at(640, 360), big = at(1280, 720), reference = runAdapterPreflight(req(), { adapters: k.adapters, outputRoot: out });
    expect(small.frame).toEqual({ width: 640, height: 360, fps: 30 });
    expect(big.frame).toEqual({ width: 1280, height: 720, fps: 30 });
    expect(reference.frame).toEqual({ width: 960, height: 540, fps: 30 });
    const fp = (r: typeof small) => r.scenes.filter((x) => x.job_fingerprint).map((x) => x.job_fingerprint);
    expect(fp(small)).not.toEqual(fp(big)); // the job the planners judged changed with the real settings
  });
  it("missing plans are reported, not skipped", () => {
    expect(replanAtActualSettings({ plan: null, compiled: null, storyboard: done.scenePlan!, assets: [], art_direction: null, aspect_ratio: "16:9", settings: settings(), adapters: k.adapters, outputRoot: out })).toEqual(["the production plans are missing or malformed"]);
  });
});

describe("render-time findings of final assembly stop a bound render", () => {
  const plan = (over: Partial<Pick<AssemblyPlan, "scenes" | "transitions">>) => ({ scenes: [], transitions: [], ...over }) as unknown as AssemblyPlan;
  it("an unrenderable scene (it would become a placeholder) and an unapplied join are problems", () => {
    const p = plan({
      scenes: [{ scene_id: "S01", renderable: true, reason: null }, { scene_id: "S02", renderable: false, reason: "a supplied picture is not shown" }] as never,
      transitions: [{ after_scene: "S01", applied: false, reason: "longer than half of S01" }, { after_scene: "S02", applied: true, reason: "" }] as never,
    });
    expect(renderTimeProblems(p)).toEqual(["S02 cannot be rendered at the real settings: a supplied picture is not shown", "the join after S01 cannot be applied: longer than half of S01"]);
  });
  it("a fully renderable plan has none", () => {
    expect(renderTimeProblems(plan({ scenes: [{ scene_id: "S01", renderable: true, reason: null }] as never }))).toEqual([]);
  });
});

describe("the console enforces the gate on every render path", () => {
  const app = readFileSync(join(root(""), "apps/console/src/app.ts"), "utf8");
  it("passes the approved selection into all three planning calls and refuses before and after learning", () => {
    for (const call of ['purpose: "preview", approved_selection }, base', 'purpose: "production", approved_selection }, base', 'purpose: "preview", approved_selection }, assembleDeps']) expect(app).toContain(call);
    expect(app).toMatch(/refusedFirst/);
    expect(app).toMatch(/refusedAfter/);
    expect(app).toMatch(/eligible = .*gate\.bound/);
  });
});
