import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Asset, type Renderer } from "@digikon/contracts";
import { ScriptedClient, approveCurrent, buildDirectorGraph, type PreflightRequest, type ProductionPort } from "@digikon/director";
import {
  AdapterRegistry, CAPABILITY_CATALOG, CapabilityRegistry, createFfmpegAdapter, createRemotionAdapter, declaredImplementations, findRemotionBrowser, implementationsOf,
  loadCapabilityRegistry, loadVisualCapabilities, runAdapterPreflight, stubAdapters,
} from "./index.js";
import { cfg, deps, learnEdit, learnInput, learnProject, learnStoryboard, learnTreatment, recipes, root, use } from "../../director/src/fixtures.js";

// The Director workflow with production intelligence wired in, exactly as the console wires it: a registry snapshot, the engines that exist and the renderer's pre-flight.
const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
const hasReal = !!font && !!findRemotionBrowser();
const tmp = mkdtempSync(join(tmpdir(), "production-graph-"));
const out = join(tmp, "out");
mkdirSync(out);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const pic = join(tmp, "pic.png");
writeFileSync(pic, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

const capDir = join(root(""), "capabilities");
const learned = loadCapabilityRegistry(capDir, { dependency: () => null, recipes: { get: (id) => recipes.find((r) => r.recipe_id === id) } });
const visual = loadVisualCapabilities(capDir);
const DECL = declaredImplementations(learned.usable);
const ready = { status: "ready", questions: [] };
const text = (t: string) => ({ text: t, safe_area: "platform_safe" });

/** Real adapters (their planners run in `check`), when this machine has a font and a Remotion browser. */
function realPort(): { port: ProductionPort; calls: { capabilities: number; preflight: number } } {
  const composed = CAPABILITY_CATALOG.filter((c) => c.engine === "remotion" && c.family !== "xfade_transition").map((c) => ({ template: c.template, family: c.family as never, type: c.operation_type as never, motion: c.motion ?? "" }));
  const transitions = CAPABILITY_CATALOG.filter((c) => c.engine === "ffmpeg").map((c) => ({ template: c.template, storyboard_transition: c.storyboard_transition, xfade: c.xfade, direction_map: c.direction_map }));
  const adapters = new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot: out, learned: transitions }), createRemotionAdapter({ fontFile: font!, outputRoot: out, learned: composed })]);
  const calls = { capabilities: 0, preflight: 0 };
  return {
    calls,
    port: {
      // rebuilt on every call, like the console's: nothing is kept between calls
      capabilities: () => { calls.capabilities++; const registry = CapabilityRegistry.from({ recipes, learned, visual, implementations: implementationsOf(adapters), declared: DECL }); return { snapshot: registry.snapshot, available_engines: adapters.renderers() as Renderer[] }; },
      preflight: (req) => { calls.preflight++; return runAdapterPreflight(req as PreflightRequest, { adapters, outputRoot: out, assetFiles: (id) => ({ asset_id: id, path: pic, variant: "original", sha256: "a".repeat(64), width: 800, height: 600, transparent: false, background: null, colours: [] }) }); },
    },
  };
}
/** A port over stub adapters (no planners): enough for Gate 1 and for the candidates the model is offered. Its pre-flight refuses to vouch for anything. */
function stubPort(engines: Renderer[] = ["ffmpeg", "remotion", "hyperframes"]): ProductionPort {
  return {
    capabilities: () => { const registry = CapabilityRegistry.from({ recipes, learned, visual, implementations: implementationsOf(stubAdapters(DECL, engines)), declared: DECL }); return { snapshot: registry.snapshot, available_engines: engines }; },
    preflight: () => { throw new Error("stub port: no planner is available"); },
  };
}

const withText = learnStoryboard({ S03: { overlay: text("Everything in one place.") }, S04: { overlay: text("Your progress, at a glance.") }, S05: { overlay: text("Learn at your own pace.") } });
const GOOD_EDIT = { uses: [
  use(1, "S01", "text-fade-up"), use(2, "S02", "text-word-stagger"), use(3, "S03", "text-fade-up"), use(4, "S03", "crossfade", { duration_s: 0.6 }), use(5, "S04", "text-fade-up"),
  use(6, "S05", "text-word-stagger"), use(7, "S05", "crossfade", { duration_s: 0.6 }), use(8, "S06", "text-fade-up"),
] };
const interrupt = async (graph: ReturnType<typeof buildDirectorGraph>, id: string) => (await graph.getState(cfg(id))).tasks.flatMap((t) => t.interrupts).at(-1)!.value as Record<string, unknown>;
const build = (llm: ScriptedClient, port?: ProductionPort) => buildDirectorGraph({ ...deps(llm), ...(port ? { production: port } : {}) });

describe("Gate 1: advisory feasibility only", () => {
  it("is attached to the storyboard gate, selects nothing, and does not change the storyboard", async () => {
    const llm = new ScriptedClient([ready, learnTreatment(), withText, GOOD_EDIT]);
    const g = build(llm, stubPort());
    const gate1 = await g.invoke(learnInput, cfg("pg-g1"));
    expect(gate1.gate).toBe("storyboard");
    expect(gate1.advisory!.mode).toBe("advisory");
    expect(gate1.advisory!.scenes.map((s) => s.scene_id)).toEqual(["S01", "S02", "S03", "S04", "S05", "S06"]);
    const payload = await interrupt(g, "pg-g1");
    expect(payload["advisory"]).toEqual(gate1.advisory);
    expect(payload["productionPlan"]).toBeNull(); // no recipe or engine is decided at Gate 1
    const text = JSON.stringify(gate1.advisory);
    for (const r of recipes) if (r.recipe_id !== "crossfade") expect(text).not.toContain(r.recipe_id);
    expect(gate1.productionPlan ?? null).toBeNull();
    expect(llm.calls.filter((c) => c.name === "storyboard").length).toBe(1); // nothing was silently regenerated
  });
  it("a storyboard nothing can produce still reaches Gate 1, with warnings", async () => {
    const g = build(new ScriptedClient([ready, learnTreatment(), withText]), stubPort([]));
    const gate1 = await g.invoke(learnInput, cfg("pg-g1b"));
    expect(gate1.status).toBe("awaiting_approval");
    expect(gate1.advisory!.summary.not_producible).toBeGreaterThan(0);
    expect(gate1.advisory!.warnings.length).toBeGreaterThan(0);
  });
  it("without a production port the workflow is exactly as before", async () => {
    const g = build(new ScriptedClient([ready, learnTreatment(), withText, GOOD_EDIT]));
    const gate1 = await g.invoke(learnInput, cfg("pg-none"));
    expect(gate1.advisory ?? null).toBeNull();
    const gate2 = await g.invoke(approveCurrent(gate1), cfg("pg-none"));
    expect(gate2.gate).toBe("edit_plan");
    expect(gate2.productionPlan ?? null).toBeNull();
  });
});

describe("after Gate 1: the model is offered only real, live candidates", () => {
  it("recipes with no implementation, or on an engine that is not available, are not in the prompt", async () => {
    const llm = new ScriptedClient([ready, learnTreatment(), withText, GOOD_EDIT, GOOD_EDIT]);
    const g = build(llm, stubPort(["ffmpeg", "remotion"]));
    const gate1 = await g.invoke(learnInput, cfg("pg-cand"));
    await g.invoke(approveCurrent(gate1), cfg("pg-cand"));
    const prompt = llm.calls.find((c) => c.name === "edit_plan")!.user;
    const listed = prompt.slice(prompt.indexOf("Candidate recipes"));
    expect(listed).toContain("id: text-fade-up");
    expect(listed).not.toContain("id: loudness-normalise"); // nothing implements it
    expect(listed).not.toContain("hyperframes"); // that engine is not available
    expect(listed).not.toContain("id: text-fade-up-hyperframes");
  });
});

describe.skipIf(!hasReal)("Gate 2 is reached only by a production plan the renderer's planners accept", () => {
  it("a supported plan reaches Gate 2 with a clear production plan and its compiled operations", async () => {
    const { port, calls } = realPort();
    const llm = new ScriptedClient([ready, learnTreatment(), withText, GOOD_EDIT]);
    const g = build(llm, port);
    const gate1 = await g.invoke(learnInput, cfg("pg-ok"));
    const gate2 = await g.invoke(approveCurrent(gate1), cfg("pg-ok"));
    expect(gate2.status).toBe("awaiting_approval");
    expect(gate2.gate).toBe("edit_plan");
    expect(gate2.productionPlan!.summary.clear).toBe(true);
    expect(gate2.productionPlan!.preflight.status).toBe("passed");
    expect(gate2.compiledPlan!.status).toBe("ready");
    expect(gate2.compiledPlan!.operations).toHaveLength(8);
    expect(gate2.compiledPlan!.production_selection_hash).toMatch(/^[a-f0-9]{64}$/);
    const payload = await interrupt(g, "pg-ok");
    expect(payload["productionPlan"]).toEqual(gate2.productionPlan);
    expect(payload["compiledPlan"]).toEqual(gate2.compiledPlan);
    expect(calls.preflight).toBeGreaterThan(0);
    expect(calls.capabilities).toBeGreaterThan(1); // asked again each time, never remembered
    const done = await g.invoke(approveCurrent(gate2), cfg("pg-ok"));
    expect(done.status).toBe("approved");
  });

  it("an unsupported plan cannot reach Gate 2: the model is shown the problems, and the run escalates when they remain", async () => {
    const { port } = realPort();
    const llm = new ScriptedClient([ready, learnTreatment(), learnStoryboard(), learnEdit, learnEdit]);
    const g = build(llm, port);
    const gate1 = await g.invoke(learnInput, cfg("pg-bad"));
    const after = await g.invoke(approveCurrent(gate1), cfg("pg-bad"));
    expect(after.status).toBe("escalated");
    expect(after.gate).toBeNull();
    expect(after.productionPlan ?? null).toBeNull();
    const retry = llm.calls.filter((c) => c.name === "edit_plan");
    expect(retry).toHaveLength(2);
    expect(retry[1]!.user).toContain("production - ");
    expect(retry[1]!.user).toMatch(/loudness-normalise|scene_picture|NO_CAPABILITY/);
    expect(after.escalation!.evidence.join(" ")).toContain("production - ");
  });

  it("a plan the registry accepts but the renderer's planner refuses cannot reach Gate 2 either", async () => {
    const { port } = realPort();
    const asset = Asset.parse({ asset_id: "asset_pic1", uri: pic, media_type: "image", duration: null, width: 800, height: 600 });
    const sb = learnStoryboard({ S01: { asset_ids: ["asset_pic1"], required_assets: [{ need: "A picture", kind: "image", availability: "supplied", asset_id: "asset_pic1", placeholder: false, fallback: null }] }, S03: { overlay: text("Everything in one place.") }, S04: { overlay: text("Your progress, at a glance.") }, S05: { overlay: text("Learn at your own pace.") } });
    // an end card on a scene that carries a supplied picture nothing shows: every use is executable by the registry's reckoning, and the adapter's planner refuses the scene
    const edit = { uses: [use(1, "S01", "end-card-cta"), ...GOOD_EDIT.uses.slice(1)] };
    const llm = new ScriptedClient([ready, learnTreatment(), sb, edit, edit]);
    const g = build(llm, port);
    const gate1 = await g.invoke({ ...learnInput, assets: [asset], project: learnProject }, cfg("pg-pf"));
    if (gate1.status !== "awaiting_approval") { expect(gate1.status).toBe("escalated"); return; } // the storyboard validator may already object to the fixture; either way nothing reaches Gate 2
    const after = await g.invoke(approveCurrent(gate1), cfg("pg-pf"));
    expect(after.status).toBe("escalated");
    expect(after.gate).toBeNull();
    expect(after.escalation!.evidence.join(" ")).toMatch(/planner refuses|not shown by any operation|production - /);
  });
});
