import { Asset, AssetNotes, BrandFact, Project, Turn } from "@digikon/contracts";
import type { Retriever } from "@digikon/rag";
import { RecipeLibrary, validateEditPlan } from "@digikon/recipes";
import { buildDirectorGraph, classifyLlmError, type DirectorStateType, type LlmClient, type SkillLibrary } from "@digikon/director";
import { routeRequest } from "@digikon/router";
import { z } from "zod";

// ---------- case files ----------

const DirectorCaseSchema = z.object({
  id: z.string(),
  description: z.string(),
  project: z.object({ brief: z.string(), objective: z.string(), audience: z.string(), platform: z.string(), aspect_ratio: z.enum(["16:9", "9:16", "1:1"]), target_duration: z.number() }),
  assets: z.array(z.unknown()),
  notes: z.array(z.unknown()).optional(),
  facts: z.array(z.string()),
  expect: z.object({
    status: z.enum(["awaiting_approval", "escalated"]),
    min_scenes: z.number().optional(),
    must_use_footage: z.boolean().optional(),
    forbidden_text: z.array(z.string()).optional(),
  }),
});
export type DirectorCase = z.infer<typeof DirectorCaseSchema>;
export const parseDirectorCases = (raw: unknown) => z.array(DirectorCaseSchema).parse(raw);

const RouterCaseSchema = z.object({
  id: z.string(),
  turns: z.array(z.string()),
  assets: z.array(z.unknown()),
  expect: z.object({ status: z.enum(["ready", "needs_input"]), mode: z.string().optional(), forbidden_text: z.array(z.string()).optional() }),
});
export type RouterCase = z.infer<typeof RouterCaseSchema>;
export const parseRouterCases = (raw: unknown) => z.array(RouterCaseSchema).parse(raw);

// ---------- results ----------

export interface Check { name: string; ok: boolean; detail: string }
export interface CaseResult { id: string; kind: "director" | "router"; ok: boolean; checks: Check[]; llm_calls: number; ms: number; error?: string }

const check = (name: string, ok: boolean, detail: string): Check => ({ name, ok, detail });

/** Raised when the model itself is unavailable, so the whole run stops instead of reporting every case as a failure. */
export class ModelUnavailable extends Error {}

function countingClient(llm: LlmClient): { client: LlmClient; calls: () => number } {
  let n = 0;
  return { client: { generate: (req) => { n++; return llm.generate(req); } }, calls: () => n };
}

const wrapModelErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) {
    const known = classifyLlmError(e);
    if (known && ["llm_billing", "llm_auth", "llm_model", "llm_network", "llm_rate_limit", "llm_overloaded"].includes(known.code)) throw new ModelUnavailable(known.message);
    throw e;
  }
};

// ---------- director checks (independent of the pipeline's own validators) ----------

/** Every string the user could read in the plan, lower-cased, for the forbidden-text check. */
function allText(s: DirectorStateType): string {
  const parts: string[] = [];
  const t = s.treatmentDoc;
  if (t) parts.push(t.logline, t.hook, t.tone, t.cta, ...t.beats.flatMap((b) => [b.beat, b.purpose]));
  for (const sc of s.scenePlan?.scenes ?? []) parts.push(sc.purpose, sc.shot.visual_action, sc.overlay?.text ?? "");
  for (const u of s.editPlan?.uses ?? []) parts.push(u.rationale);
  // Claim text is allowed to *exist* as an unsupported claim; only what reaches scenes counts, so claims are excluded here.
  return parts.join("\n").toLowerCase();
}

export function checkFinalState(s: DirectorStateType, c: DirectorCase, library: RecipeLibrary): Check[] {
  const out: Check[] = [check("status", s.status === c.expect.status, `expected ${c.expect.status}, got ${s.status}`)];
  if (s.status !== "awaiting_approval") return out; // the remaining checks describe a finished plan

  const plan = s.scenePlan!, treatment = s.treatmentDoc!, edit = s.editPlan!;
  const project = s.project;
  const total = plan.scenes.reduce((a, x) => a + x.duration_seconds, 0);
  out.push(check("duration", Math.abs(total - project.target_duration) <= 0.5, `${total}s of ${project.target_duration}s`));

  let cursor = 0, contiguous = true;
  for (const sc of [...plan.scenes].sort((a, b) => a.start_time - b.start_time)) { if (Math.abs(sc.start_time - cursor) > 1e-6) contiguous = false; cursor = sc.start_time + sc.duration_seconds; }
  out.push(check("timeline_contiguous", contiguous, contiguous ? "no gaps or overlaps" : "gap or overlap"));

  if (c.expect.min_scenes) out.push(check("min_scenes", plan.scenes.length >= c.expect.min_scenes, `${plan.scenes.length} scenes`));

  const factIds = new Set(s.facts.map((f) => f.fact_id));
  const supported = new Map(treatment.claims.map((cl) => [cl.claim_id, cl.brand_fact_id !== null && factIds.has(cl.brand_fact_id)]));
  const badClaims = plan.scenes.flatMap((sc) => sc.claim_ids.filter((id) => supported.get(id) !== true).map((id) => `${sc.scene_id}:${id}`));
  out.push(check("claims_supported", badClaims.length === 0, badClaims.length ? `unsupported in scenes: ${badClaims.join(", ")}` : "every scene claim has an approved fact"));

  const assetById = new Map(s.assets.map((a) => [a.asset_id, a]));
  const notesById = new Map(s.notes.map((n) => [n.asset_id, n]));
  const footageProblems: string[] = [];
  for (const sc of plan.scenes) for (const id of sc.asset_ids) {
    const a = assetById.get(id);
    if (!a) { footageProblems.push(`${sc.scene_id}: unknown asset ${id}`); continue; }
    if (a.media_type !== "video") continue;
    const segs = notesById.get(id)?.usable_segments ?? [{ start: 0, end: a.duration ?? 0 }];
    const from = sc.source_in_seconds, to = from + sc.duration_seconds;
    if (!segs.some((g) => from >= g.start - 1e-6 && to <= g.end + 1e-6)) footageProblems.push(`${sc.scene_id}: ${from}-${to}s is outside usable footage`);
  }
  out.push(check("footage_valid", footageProblems.length === 0, footageProblems.join("; ") || "every scene uses real, usable footage"));

  if (c.expect.must_use_footage) {
    const used = plan.scenes.some((sc) => sc.asset_ids.some((id) => assetById.get(id)?.media_type === "video"));
    out.push(check("uses_footage", used, used ? "video footage is used" : "supplied footage was ignored"));
  }

  const editIssues = validateEditPlan(edit, plan, library, project, s.assets);
  out.push(check("recipes_valid", editIssues.length === 0, editIssues.map((i) => `${i.use_id}: ${i.code}`).join("; ") || `${edit.uses.length} recipe uses, all valid`));

  const attempts = s.trace.flatMap((l) => [...l.matchAll(/in (\d+) attempt/g)].map((m) => Number(m[1])));
  out.push(check("attempts_within_limit", attempts.every((n) => n <= 2), `attempts per step: ${attempts.join(", ") || "n/a"}`));

  if (c.expect.forbidden_text?.length) {
    const text = allText(s);
    const hit = c.expect.forbidden_text.filter((f) => text.includes(f.toLowerCase()));
    out.push(check("forbidden_text_absent", hit.length === 0, hit.length ? `found: ${hit.join(", ")}` : "none of the forbidden phrases appear in the plan"));
  }
  return out;
}

export interface DirectorRunDeps { llm: LlmClient; skills: SkillLibrary; retriever: Retriever; recipes: RecipeLibrary }

export async function runDirectorCases(cases: DirectorCase[], deps: DirectorRunDeps): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const started = Date.now();
    const { client, calls } = countingClient(deps.llm);
    try {
      const project = Project.parse({ project_id: `eval_${c.id}`, owner_id: "eval", ...c.project });
      const assets = c.assets.map((a) => Asset.parse(a));
      const notes = (c.notes ?? []).map((n) => AssetNotes.parse(n));
      const facts = c.facts.map((text, i) => BrandFact.parse({ fact_id: `F${String(i + 1).padStart(2, "0")}`, text, source: "eval" }));
      const graph = buildDirectorGraph({ llm: client, skills: deps.skills, retriever: deps.retriever, recipes: deps.recipes });
      const state = await wrapModelErrors(() => graph.invoke({ project, assets, facts, notes }, { configurable: { thread_id: `eval-${c.id}-${Date.now()}` } }));
      const checks = checkFinalState(state, c, deps.recipes);
      results.push({ id: c.id, kind: "director", ok: checks.every((x) => x.ok), checks, llm_calls: calls(), ms: Date.now() - started });
    } catch (e) {
      if (e instanceof ModelUnavailable) throw e;
      results.push({ id: c.id, kind: "director", ok: false, checks: [], llm_calls: calls(), ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

// ---------- router checks ----------

export async function runRouterCases(cases: RouterCase[], deps: { llm: LlmClient; skills: SkillLibrary }): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const started = Date.now();
    const { client, calls } = countingClient(deps.llm);
    try {
      const turns = c.turns.map((text) => Turn.parse({ role: "user", text }));
      const r = await wrapModelErrors(() => routeRequest({ llm: client, skills: deps.skills }, { project_id: `eval_${c.id}`, owner_id: "eval", turns, assets: c.assets.map((a) => Asset.parse(a)) }));
      const checks = [check("status", r.status === c.expect.status, `expected ${c.expect.status}, got ${r.status}`)];
      if (c.expect.mode && r.status === "ready") checks.push(check("mode", r.request.mode === c.expect.mode, `expected ${c.expect.mode}, got ${r.request.mode}`));
      if (c.expect.forbidden_text?.length) {
        const text = (r.status === "ready" ? JSON.stringify({ ...r.request, project: r.request.project ? { ...r.request.project, brief: "" } : null }) + r.rationale : r.questions.join(" ")).toLowerCase();
        const hit = c.expect.forbidden_text.filter((f) => text.includes(f.toLowerCase()));
        checks.push(check("forbidden_text_absent", hit.length === 0, hit.length ? `found: ${hit.join(", ")}` : "clean"));
      }
      results.push({ id: c.id, kind: "router", ok: checks.every((x) => x.ok), checks, llm_calls: calls(), ms: Date.now() - started });
    } catch (e) {
      if (e instanceof ModelUnavailable) throw e;
      results.push({ id: c.id, kind: "router", ok: false, checks: [], llm_calls: calls(), ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

// ---------- report ----------

export function formatReport(results: CaseResult[], mode: string): string {
  const lines: string[] = [`Eval run: ${mode}`, ""];
  for (const r of results) {
    lines.push(`${r.ok ? "PASS" : "FAIL"}  ${r.kind.padEnd(8)} ${r.id.padEnd(30)} ${String(r.llm_calls).padStart(2)} model calls  ${r.ms} ms`);
    if (r.error) lines.push(`      error: ${r.error}`);
    for (const c of r.checks) if (!c.ok) lines.push(`      x ${c.name}: ${c.detail}`);
  }
  const passed = results.filter((r) => r.ok).length;
  lines.push("", `${passed}/${results.length} cases passed`);
  return lines.join("\n");
}

