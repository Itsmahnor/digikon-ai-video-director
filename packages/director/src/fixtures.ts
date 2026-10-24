// Shared fixtures for the Director tests: a small coffee-roaster brief with scripted model answers.
import { fileURLToPath } from "node:url";
import { Asset, Project, type BrandFact } from "@digikon/contracts";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import { ScriptedClient, SkillLibrary, approveCurrent, type buildDirectorGraph, type Deps } from "./index.js";

export const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
export const recipes = loadRecipes(root("recipes"));
export const knowledge = loadKnowledge(root("knowledge"));

export const project = Project.parse({
  project_id: "coffee1", owner_id: "u1", brief: "15 second Instagram ad for a small-batch coffee roaster.",
  objective: "Drive first orders", audience: "Home coffee drinkers", platform: "instagram", aspect_ratio: "9:16", target_duration: 12,
});
export const assets = [
  Asset.parse({ asset_id: "asset_beans", uri: "beans.mp4", media_type: "video", duration: 20, width: 1080, height: 1920, metadata: { bytes: 4_000_000 } }),
  Asset.parse({ asset_id: "asset_logo", uri: "logo.png", media_type: "image", duration: null, width: 800, height: 800, metadata: { bytes: 50_000 } }),
];
export const facts: BrandFact[] = [{ fact_id: "F01", text: "Beans are roasted weekly in small batches", source: "brand sheet" }];

export const treatment = {
  logline: "Fresh roast, weekly", hook: "Beans pouring into a grinder", tone: "warm",
  beats: [
    { beat: "hook", purpose: "show beans", approx_seconds: 4 },
    { beat: "detail", purpose: "show roast", approx_seconds: 5 },
    { beat: "cta", purpose: "ask for order", approx_seconds: 3 },
  ],
  cta: "Order your first bag",
  claims: [
    { claim_id: "C01", text: "Roasted weekly in small batches", brand_fact_id: "F01" },
    { claim_id: "C02", text: "Best coffee in town", brand_fact_id: null },
    { claim_id: "C03", text: "Award winning", brand_fact_id: "F99" }, // fact does not exist: code must demote it
  ],
};
export const shot = { shot_size: "close_up", camera_motion: "slow_push_in", visual_action: "beans pouring" };
export const scene = (id: string, dur: number, extra: Record<string, unknown>) => ({
  scene_id: id, purpose: "p", duration_seconds: dur, shot, transition_out: "cut", ...extra,
});
export const goodStoryboard = {
  scenes: [
    scene("S01", 4, { asset_ids: ["asset_beans"], source_in_seconds: 0, transition_out: "crossfade" }),
    scene("S02", 5, { asset_ids: ["asset_beans"], source_in_seconds: 5, claim_ids: ["C01"] }),
    scene("S03", 3, { asset_ids: ["asset_logo"], overlay: { text: "Order your first bag", safe_area: "platform_safe" } }),
  ],
};
export const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, number | string> = {}) => ({
  use_id: `U0${n}`, scene_id, recipe_id, params, rationale: "fits the beat",
});
export const goodEdit = {
  uses: [
    use(1, "S01", "slow-push-in", { scale_end: 1.1 }),
    use(2, "S01", "crossfade", { duration_s: 0.6 }),
    use(3, "S02", "pan-reframe"),
    use(4, "S03", "end-card-cta", { hold_s: 2.5 }),
    use(5, "S03", "loudness-normalise"),
  ],
};

export function deps(llm: ScriptedClient, status: "draft" | "reviewed" = "draft"): Deps {
  const docs = [...recipeDocs(recipes), ...knowledge];
  return { llm, skills: new SkillLibrary(root("skills")), retriever: new KeywordRetriever(docs), recipes: new RecipeLibrary(recipes, status) };
}
// ---- The six-scene, 30-second, 16:9 online-learning explainer from a real run: no supplied files, graphics only. ----
export const learnProject = Project.parse({
  project_id: "learn1", owner_id: "console-user", brief: "30 second SaaS explainer for an online learning platform.", objective: "Explain the platform",
  audience: "Students", platform: "YouTube", aspect_ratio: "16:9", target_duration: 30,
});
export const learnInput = { project: learnProject, assets: [], facts: [] };
const concept = (id: string, text: string) => ({ claim_id: id, text, brand_fact_id: null, kind: "illustrative", safe_alternative: "Show it on screen without wording." });
export const learnClaims = [concept("C01", "The platform offers personalized learning"), concept("C02", "The platform offers progress tracking"), concept("C03", "The platform brings resources together")];
export const learnTreatment = (claims: unknown[] = learnClaims) => ({
  logline: "One calm place to learn", hook: "Too many tabs", tone: "modern",
  beats: [4, 5, 4, 6, 6, 5].map((s, i) => ({ beat: `Beat ${i + 1}`, purpose: "p", approx_seconds: s })), cta: "Start learning", claims,
});
const gfx = (need: string, over: Record<string, unknown> = {}) => ({ need, kind: "graphics", availability: "generate_graphics", ...over });
const scn = (id: string, dur: number, extra: Record<string, unknown> = {}) => ({
  scene_id: id, purpose: "p", duration_seconds: dur, asset_ids: [], required_assets: [gfx("Animated graphics")], transition_out: "cut",
  shot: { shot_size: "wide", camera_motion: "static", visual_action: "Animated desktop view" }, ...extra,
});
const text = (t: string) => ({ text: t, safe_area: "platform_safe" });
export const learnStoryboard = (over: Record<string, Record<string, unknown>> = {}) => ({
  scenes: [
    scn("S01", 4, { overlay: text("Too many tabs."), ...over["S01"] }),
    scn("S02", 5, { overlay: text("Where was I?"), ...over["S02"] }),
    scn("S03", 4, { transition_out: "crossfade", claim_ids: ["C03"], required_assets: [gfx("Brand logo card", { kind: "logo", placeholder: true })], unresolved: [{ kind: "placeholder", note: "No logo supplied: a generic wordmark card is shown." }], ...over["S03"] }),
    scn("S04", 6, { claim_ids: ["C01"], required_assets: [gfx("Learning dashboard (graphics only)", { kind: "ui_screenshot", placeholder: true })], unresolved: [{ kind: "placeholder", note: "No product screens supplied: an illustrative dashboard is shown." }], ...over["S04"] }),
    scn("S05", 6, { transition_out: "crossfade", claim_ids: ["C02"], ...over["S05"] }),
    scn("S06", 5, { transition_out: "dip_to_black", overlay: text("Start learning - link below."), ...over["S06"] }),
  ],
});
const useOf = (n: number, scene_id: string, recipe_id: string) => ({ use_id: `U0${n}`, scene_id, recipe_id, params: {}, rationale: "fits the beat" });
export const learnEdit = { uses: [useOf(1, "S01", "text-fade-up"), useOf(2, "S02", "text-word-stagger"), useOf(3, "S03", "crossfade"), useOf(4, "S05", "crossfade"), useOf(5, "S06", "end-card-cta"), useOf(6, "S06", "loudness-normalise")] };

/** An execution report for tests that only care about the contract: no renderer, so nothing can run. */
export const noExecution = (operations: { operation_id: string }[]) => ({
  rendered: false, executable: false, production_executable: false,
  operations: operations.map((o) => ({ operation_id: o.operation_id, renderer: null, executable: false, production_executable: false, blockers: ["no renderer is available"] })),
  missing_inputs: [] as string[], notes: [] as string[],
});
export const cfg = (id: string) => ({ configurable: { thread_id: id } });
/** Runs to the storyboard gate, approves exactly that version, and returns the state waiting at the edit-plan gate (or wherever it stopped). */
export async function throughGate1(graph: ReturnType<typeof buildDirectorGraph>, inp: Record<string, unknown>, id: string) {
  const first = await graph.invoke(inp as never, cfg(id));
  return first.status === "awaiting_approval" && first.gate === "storyboard" ? graph.invoke(approveCurrent(first), cfg(id)) : first;
}
export const input = { project, assets, facts };