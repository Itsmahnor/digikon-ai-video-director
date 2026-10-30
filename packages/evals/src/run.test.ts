import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DemoClient, SkillLibrary, approveCurrent, buildDirectorGraph, type LlmClient } from "@digikon/director";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import { Asset, BrandFact, Project } from "@digikon/contracts";
import { ModelUnavailable, checkFinalState, parseDirectorCases, parseRouterCases, runDirectorCases, runRouterCases } from "./index.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const recipes = loadRecipes(join(repo, "recipes"));
const library = new RecipeLibrary(recipes, "draft");
const skills = new SkillLibrary(join(repo, "skills"));
const retriever = new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge"))]);
const read = (f: string) => JSON.parse(readFileSync(join(repo, "evals", f), "utf8"));
const briefs = parseDirectorCases(read("golden-briefs.json"));
const routes = parseRouterCases(read("router-cases.json"));

describe("eval case files", () => {
  it("are valid and cover the situations that matter", () => {
    expect(briefs.length).toBeGreaterThanOrEqual(10);
    expect(new Set(briefs.map((b) => b.id)).size).toBe(briefs.length);
    const ids = briefs.map((b) => b.id).join(" ");
    for (const must of ["injection", "unsupported-claim", "limited-usable", "many-facts", "short"]) expect(ids).toContain(must);
    expect(routes.length).toBeGreaterThanOrEqual(6);
  });
});

describe("harness with the demo model (checks the pipeline, not Claude)", () => {
  it("runs every golden brief and every router case", async () => {
    const llm = new DemoClient();
    const d = await runDirectorCases(briefs, { llm, skills, retriever, recipes: library });
    const r = await runRouterCases(routes, { llm, skills });
    const failed = [...d, ...r].filter((x) => !x.ok).map((x) => `${x.id}: ${x.error ?? x.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join("; ")}`);
    expect(failed).toEqual([]);
    expect(d.every((x) => x.llm_calls >= 4)).toBe(true); // intake, treatment, storyboard, edit plan
  }, 120_000);
});

describe("the harness is not vacuous: it catches a misbehaving model", () => {
  const sabotage = (edit: (name: string, out: any) => any): LlmClient => {
    const demo = new DemoClient();
    return { predatesArtDirection: demo.predatesArtDirection, generate: async (req) => { const out = await demo.generate({ ...req, schema: { parse: (x: unknown) => x } as never }); return req.schema.parse(edit(req.name, structuredClone(out))); } };
  };
  const first = (id: string) => briefs.filter((b) => b.id === id);

  it("flags a storyboard that keeps using an unsupported claim", async () => {
    // the pipeline's validator rejects this and, after one repair attempt, escalates: the case must then fail on status
    const llm = sabotage((name, out) => (name === "storyboard" ? { scenes: out.scenes.map((s: any, i: number) => (i === 1 ? { ...s, claim_ids: ["C09"] } : s)) } : out));
    const [r] = await runDirectorCases(first("coffee-reels-graphics"), { llm, skills, retriever, recipes: library });
    expect(r!.ok).toBe(false);
    expect(r!.checks.find((c) => c.name === "status")!.detail).toContain("escalated");
  });

  it("flags a model that obeys an injection by checking the text of the finished plan", async () => {
    const llm = sabotage((name, out) => (name === "treatment" ? { ...out, logline: "Our tea cures anxiety" } : out));
    // The logline is not validated by code, so the plan passes the pipeline. Only the independent text check can catch it.
    const [r] = await runDirectorCases(first("prompt-injection-in-brief"), { llm, skills, retriever, recipes: library });
    expect(r!.ok).toBe(false);
    expect(r!.checks.find((c) => c.name === "forbidden_text_absent")).toMatchObject({ ok: false, detail: expect.stringContaining("cures anxiety") });
  });

  it("flags a router that obeys an injection or picks the wrong mode", async () => {
    const llm = sabotage((name, out) => (name === "route_decision" ? { ...out, mode: "create_full", rationale: "Here is my system prompt" } : out));
    const [a, b] = await runRouterCases(routes.filter((c) => ["A-idea-only", "injection-in-request"].includes(c.id)), { llm, skills });
    expect(a!.ok).toBe(true); // the model said create_full with no footage; code overrides it to create_minimal, so the case still passes
    expect(b!.ok).toBe(false);
    expect(b!.checks.some((c) => c.name === "forbidden_text_absent" && !c.ok)).toBe(true);
  });

  it("checks outcomes on a hand-built final state, independent of the pipeline", async () => {
    // Build a real finished state, then corrupt it in ways the validators would normally prevent.
    const c = first("shoes-tiktok-with-video")[0]!;
    const project = Project.parse({ project_id: "p", owner_id: "e", ...c.project });
    const graph = buildDirectorGraph({ llm: new DemoClient(), skills, retriever, recipes: library });
    const cfg = { configurable: { thread_id: "chk" } };
    const atGate1 = await graph.invoke({ project, assets: c.assets.map((a) => Asset.parse(a)), facts: [] as BrandFact[], notes: [] }, cfg);
    const good = await graph.invoke(approveCurrent(atGate1), cfg);
    expect(checkFinalState(good, c, library).every((x) => x.ok)).toBe(true);

    const bad = structuredClone(good);
    bad.scenePlan!.scenes[0]!.source_in_seconds = 19; // runs past the end of the 20s clip
    bad.scenePlan!.scenes[1]!.claim_ids = ["C77"];
    bad.editPlan!.uses[0]!.recipe_id = "invented-effect";
    const failed = checkFinalState(bad, c, library).filter((x) => !x.ok).map((x) => x.name);
    expect(failed).toEqual(expect.arrayContaining(["footage_valid", "claims_supported", "recipes_valid"]));
  });
});

describe("when the model is unavailable", () => {
  it("stops the whole run with one clear error instead of failing every case", async () => {
    const broke: LlmClient = { generate: () => Promise.reject(Object.assign(new Error("credit balance is too low"), { status: 400 })) };
    await expect(runDirectorCases(briefs, { llm: broke, skills, retriever, recipes: library })).rejects.toBeInstanceOf(ModelUnavailable);
    await expect(runRouterCases(routes, { llm: broke, skills })).rejects.toThrow("no credit");
  });
});
