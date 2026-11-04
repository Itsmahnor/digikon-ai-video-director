// npm run tree            regenerates docs/PROJECT_TREE.md from `git ls-files` (tracked files only: no node_modules, build output, storage or secrets)
// npm run tree -- --check  prints problems (a directory with no annotation) and exits 1; the same check runs in scripts/tree.test.ts
// Annotations are in ANNOTATIONS below. Add a line when you add a top-level directory, a package or an app; the check fails until you do.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type Status = "done" | "partial" | "base" | "planned";
export interface Annotation { path: string; steps: string; status: Status; note: string }

/**
 * Which plan step each directory belongs to and where it stands. `base` means it predates Phases A to G (the Phase 1 foundation the plan builds on).
 * Longest matching prefix wins; a directory with no entry of its own shows its nearest annotated parent.
 */
export const ANNOTATIONS: Annotation[] = [
  { path: "apps", steps: "base, B3, C2-C6, D1", status: "done", note: "The console: server, routes and browser UI" },
  { path: "apps/console", steps: "base, B3, C2-C6, D1", status: "done", note: "Hono server + plain-JS UI (no build step)" },
  { path: "apps/console/public", steps: "C4, C6, D1", status: "done", note: "UI: guided-intake wizard (C4), typed question card (C6), video-type card (D1)" },
  { path: "apps/console/src", steps: "B3, C2-C6, D1", status: "done", note: "Routes; kit-routes.ts holds the kit, website, guideline and question routes" },
  { path: "capabilities", steps: "base", status: "base", note: "Capability registry: what each renderer can really do, with validation evidence" },
  { path: "db", steps: "A1, A2, B1", status: "done", note: "SQL migrations" },
  { path: "db/migrations", steps: "A1, A2, B1", status: "done", note: "0001 pgvector foundation (base), 0002 skills (A2), 0003 skill scope and topic (B1)" },
  { path: "docs", steps: "base, B3, C, handoff", status: "done", note: "Design notes, the handoff guide, the plan text, skills and review docs" },
  { path: "docs/assets", steps: "base", status: "base", note: "Evidence for the asset-handling milestone" },
  { path: "docs/quality", steps: "base", status: "base", note: "Rendered quality evidence (before/after, blocks, regression)" },
  { path: "docs/templates", steps: "G (releases 2-3 planned)", status: "partial", note: "Template library release 1 reports" },
  { path: "evals", steps: "B3", status: "done", note: "Retrieval and skills benchmarks, golden briefs, router cases" },
  { path: "evals/baselines", steps: "B3", status: "done", note: "Generated benchmark reports (BM25 vs hybrid, with and without the off-topic floor)" },
  { path: "examples", steps: "A3, B2", status: "done", note: "Sample inputs and the shipped skills" },
  { path: "examples/coffee-ad", steps: "base", status: "base", note: "Sample brief" },
  { path: "examples/skills", steps: "B2, B-review", status: "done", note: "117 skills in one folder per source, REVIEW.md / REVIEW.json (111 approved, 6 draft)" },
  { path: "examples/skills-sample", steps: "A3", status: "done", note: "Two-skill sample for the importer" },
  { path: "knowledge", steps: "base", status: "base", note: "Directing, ad-playbook and platform-spec notes the retriever reads" },
  { path: "packages", steps: "base, A-D", status: "done", note: "Workspace packages" },
  { path: "packages/contracts", steps: "A2, B1, C1, C5, C6, D1, D2", status: "done", note: "Schemas: SkillRecord, ProjectKit, completeness, typed questions, video types, Gate 1 requirements" },
  { path: "packages/director", steps: "B3, C6, D1, D2, D3", status: "partial", note: "Director graph and nodes, Editor agent; D3 (story from the chosen type) is in progress" },
  { path: "packages/evals", steps: "B3", status: "done", note: "Benchmark runners (eval:skills, eval:skills:db, eval:hybrid)" },
  { path: "packages/media", steps: "base, C2, C3", status: "done", note: "Asset analysis; website reader (C2) and guideline PDF reader (C3)" },
  { path: "packages/qa", steps: "base", status: "base", note: "Video QA checks" },
  { path: "packages/rag", steps: "A2-A4, B3", status: "done", note: "Retrievers, skills importer, off-topic floor, database-backed retriever, stores" },
  { path: "packages/recipes", steps: "base", status: "base", note: "Recipe library" },
  { path: "packages/render", steps: "base, E (planned)", status: "partial", note: "Renderers (FFmpeg, Remotion, HyperFrames); E1 fonts, E2 per-scene previews and E3 UI previews are planned" },
  { path: "packages/router", steps: "base", status: "base", note: "Request router" },
  { path: "packages/speech", steps: "base", status: "base", note: "Speech recognition" },
  { path: "packages/templates", steps: "base, G (releases 2-3 planned)", status: "partial", note: "Template library tooling and release 1" },
  { path: "recipes", steps: "base", status: "base", note: "Edit recipes the Director chooses from" },
  { path: "scripts", steps: "A3, B3, B-review, tree", status: "done", note: "CLIs: db, skills import, skills:review, skills:demo, tree, templates" },
  { path: "skills", steps: "base, E5 (planned)", status: "partial", note: "Director and Editor SKILL.md files (the Editor skills get an llm in E5)" },
  { path: "templates", steps: "base, G (releases 2-3 planned)", status: "partial", note: "476 template records (library release 1)" },
];

/** Where the plan and the repository differ, and why. Static: update it when a decision changes. */
export const PLAN_VS_REALITY: { topic: string; plan: string; reality: string; why: string }[] = [
  { topic: "Skills schema", plan: "category, funnel stage, platform, grade, licence, source, status", reality: "category is the video category (saas, ecommerce, general-promo, all); added `topic` and `scope` (director, editor, both); migration 0003", why: "The Director retrieves by video category and a category query must never return another category; Editor-only skills needed a marker" },
  { topic: "Skill status", plan: "draft or reviewed", reality: "draft, reviewed, approved, retired; `approved` is a human act recorded in examples/skills/REVIEW.json", why: "Review was done by the agent that wrote the skills, so a human approval step was added; Digikon approved 111 on 2026-11-04" },
  { topic: "Postgres", plan: "Docker `pgvector/pgvector:pg16` on 5432", reality: "Native PostgreSQL 16.15 on localhost:5433 with pgvector 0.8.7 built from source; docker-compose.yml is kept but unused", why: "Docker cannot start (virtualization is off in BIOS)" },
  { topic: "Tests without a server", plan: "A real database", reality: "In-process PGlite when DATABASE_URL is unset (labelled in the test output); the same suite also passes on the real server", why: "Fast, no install needed for contributors" },
  { topic: "Retrieval default", plan: "BM25 baseline; hybrid if it beats it", reality: "Hybrid ranking with an off-topic floor (nothing is returned when no distinctive word matches); BM25 with the same floor when there is no database", why: "Chosen from the benchmark; the floor is a keyword-coverage rule and answers most, not all, off-topic queries" },
  { topic: "PDF reading (C3)", plan: "PDF text and colour extraction", reality: "A small purpose-built reader in packages/media/src/guideline.ts", why: "No PDF library was installed and nothing was installed without approval; scanned or encrypted files fall back to asking" },
  { topic: "Wizard browser tests (C4)", plan: "A browser test (Playwright)", reality: "Wizard logic is unit-tested; edge cases were checked in the built-in browser", why: "Playwright is not installed on this machine" },
  { topic: "Video-type catalog (D1)", plan: "Types proposed using the skills", reality: "A hard-coded catalog in packages/director/src/video-types.ts that mirrors the playbook skills; examples still contain invented figures", why: "Open follow-up in HANDOFF.md (the file has another session's uncommitted edits)" },
  { topic: "Plan files", plan: "architecture/UPDATED_PLAN.md and IMPLEMENTATION_STEPS.md", reality: "Not in the repo; the plan text received is in docs/PLAN_PHASES_A-C.md and docs/PLAN_PHASES_D-G.md", why: "The files were never provided" },
  { topic: "Extra documents", plan: "-", reality: "docs/HANDOFF.md, docs/SKILLS.md, docs/SKILL_REVIEW.md, docs/PROJECT_TREE.md (this file)", why: "So another session can continue without context" },
  { topic: "Sessions", plan: "One session at a time", reality: "On 2026-11-04 two sessions edited the same working tree", why: "See HANDOFF.md, section 8" },
];

/** Files the plan says will exist; the tree shows whether they do yet. */
export const PLANNED_FILES: { step: string; file: string }[] = [
  { step: "E2", file: "packages/render/src/scene-job.ts" },
  { step: "E2", file: "packages/render/src/assemble.ts" },
  { step: "F2", file: "packages/director/src/gateway.ts" },
  { step: "D1", file: "packages/director/src/video-types.ts" },
  { step: "D2", file: "packages/director/src/requirements.ts" },
  { step: "C6", file: "packages/contracts/src/questions.ts" },
  { step: "C2", file: "packages/media/src/website.ts" },
  { step: "C3", file: "packages/media/src/guideline.ts" },
  { step: "E1", file: "packages/render/fonts" },
  { step: "F3", file: "evals/baselines" },
];

const gitFiles = (): string[] => execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);

/** Directories with the number of tracked files below them. */
export function directoryCounts(files: readonly string[], depth = 3): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.split("/");
    for (let d = 1; d <= Math.min(depth, parts.length - 1); d++) { const dir = parts.slice(0, d).join("/"); counts.set(dir, (counts.get(dir) ?? 0) + 1); }
  }
  return counts;
}

export const annotationFor = (dir: string): Annotation | null => ANNOTATIONS.filter((a) => dir === a.path || dir.startsWith(a.path + "/")).sort((a, b) => b.path.length - a.path.length)[0] ?? null;

/** Problems that would let the tree rot: a top-level directory, a package or an app with no annotation of its own. */
export function problems(files: readonly string[] = gitFiles()): string[] {
  const out: string[] = [];
  const dirs = [...directoryCounts(files, 2).keys()];
  for (const d of dirs) {
    const parts = d.split("/");
    const needsOwn = parts.length === 1 || (parts.length === 2 && ["packages", "apps"].includes(parts[0]!));
    if (needsOwn && !ANNOTATIONS.some((a) => a.path === d)) out.push(`${d}: add an entry to ANNOTATIONS in scripts/tree.mts`);
  }
  for (const a of ANNOTATIONS) if (!dirs.includes(a.path) && !files.some((f) => f.startsWith(a.path + "/"))) out.push(`${a.path}: annotated but no tracked files there any more; remove the entry`);
  return out;
}

const MARK: Record<Status, string> = { done: "done", partial: "partial", base: "base", planned: "planned" };

export function render(files: readonly string[] = gitFiles()): string {
  const counts = directoryCounts(files, 3);
  // Sort by path segments, so a directory is followed by its own children ("skills/" before "skills-sample/" would otherwise split them).
  const dirs = [...counts.keys()].sort((a, b) => { const x = a.split("/"), y = b.split("/"); for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = x[i]!.localeCompare(y[i]!); if (c) return c; } return x.length - y.length; });
  const rootFiles = files.filter((f) => !f.includes("/"));
  const lines: string[] = [];
  const pad = (s: string, n: number) => (s.length >= n ? s + "  " : s + " ".repeat(n - s.length));
  lines.push(".");
  for (const f of rootFiles) lines.push(`|-- ${f}`);
  for (const d of dirs) {
    const parts = d.split("/"), indent = "|   ".repeat(parts.length - 1), a = ANNOTATIONS.find((x) => x.path === d);
    const label = `${indent}|-- ${parts[parts.length - 1]}/`;
    const note = a ? `[${a.steps === a.status ? MARK[a.status] : `${MARK[a.status]}; ${a.steps}`}] ${a.note}` : "";
    lines.push(`${pad(label, 46)}${String(counts.get(d)).padStart(4)} files  ${note}`.trimEnd());
  }
  const exists = (p: string) => existsSync(join(ROOT, p));
  const out: string[] = [
    "# Project tree, plan steps and plan vs reality",
    "",
    "_Generated by `npm run tree` from `git ls-files` (tracked files only). Do not edit by hand: change `scripts/tree.mts` and regenerate. A test fails if a top-level directory, package or app has no annotation._",
    "",
    "Status: **done** = built and tested; **partial** = some of it built, the rest planned or in progress; **base** = predates Phases A to G (the foundation the plan builds on); **planned** = not started. Step names are from `docs/PLAN_PHASES_A-C.md` and `docs/PLAN_PHASES_D-G.md`.",
    "",
    "## Tree (depth 3, with the number of tracked files below each directory)",
    "",
    "```text",
    ...lines,
    "```",
    "",
    "## Plan vs reality",
    "",
    "| Topic | The plan said | What the repository has | Why |",
    "|---|---|---|---|",
    ...PLAN_VS_REALITY.map((r) => `| ${r.topic} | ${r.plan} | ${r.reality} | ${r.why} |`),
    "",
    "## Files the plan names, and whether they exist yet",
    "",
    "| Step | Path | Exists now |",
    "|---|---|---|",
    ...PLANNED_FILES.map((p) => `| ${p.step} | \`${p.file}\` | ${exists(p.file) ? "yes" : "no (planned)"} |`),
    "",
    "Phases not started in code: E1 to E7 (fonts, per-scene previews, preview UI, template picker, Editor model, change requests, audio), F1 to F3, G. See `docs/PLAN_PHASES_D-G.md`.",
    "",
  ];
  return out.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const p = problems();
  if (process.argv.includes("--check")) { for (const x of p) console.error(x); process.exit(p.length ? 1 : 0); }
  for (const x of p) console.warn(`warning: ${x}`);
  writeFileSync(join(ROOT, "docs", "PROJECT_TREE.md"), render(), "utf8");
  console.log(`wrote docs/PROJECT_TREE.md${p.length ? ` (${p.length} annotation problem(s), see warnings)` : ""}`);
}
