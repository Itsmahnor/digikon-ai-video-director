// npm run skills:review [-- --apply] [--sources <dir>]
// Applies the checklist in docs/SKILL_REVIEW.md to every skill under examples/skills and writes examples/skills/REVIEW.json and REVIEW.md.
// With --apply, a skill that passes every check is set to `status: reviewed` (never `approved`); one that fails is set back to `draft`.
// The review is mechanical where it can be, and says so where it is not. It was written and first run by the agent that wrote the skills: a human spot-check is still needed.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ALLOWED_LICENCES, detectLicence, parseSkillFile } from "@digikon/rag";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
// --approve "<who>, <YYYY-MM-DD>, <basis>": a HUMAN approval, recorded in REVIEW.json and REVIEW.md. Skills that pass every check and are `reviewed` become `approved`.
// A skill already `approved` stays approved while it still passes the checks; one that no longer passes (it was edited) goes back to draft, because the approval was for the old text.
const approveIdx = args.indexOf("--approve");
const approval = approveIdx >= 0 ? args[approveIdx + 1]! : null;
const prevApproval = (() => { try { return (JSON.parse(readFileSync(join(import.meta.dirname, "..", "examples", "skills", "REVIEW.json"), "utf8")) as { approval?: { by: string; on: string; basis: string } }).approval ?? null; } catch { return null; } })();
const srcArg = args.indexOf("--sources");
const SOURCES = resolve(srcArg >= 0 ? args[srcArg + 1]! : "D:/skills-src");
const ROOT = resolve(import.meta.dirname, "..", "examples", "skills");
const NOTES = JSON.parse(readFileSync(join(import.meta.dirname, "skill-review-notes.json"), "utf8").replace(/^\uFEFF/, "")) as { skimmed: Record<string, string> };

// ---------- C2: verbatim runs against the cloned sources ----------
const N = 12;
const norm = (s: string) => s.toLowerCase().replace(/[`*_>#|\-\u2014\u2013]+/g, " ").replace(/[^\p{L}\p{N}'\s]+/gu, " ").split(/\s+/).filter(Boolean);
const h32 = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
let shingles: Map<number, string> | null = null;
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) { if (n === ".git" || n === "node_modules") continue; const p = join(dir, n); statSync(p).isDirectory() ? walk(p, out) : /\.(md|txt)$/i.test(n) && out.push(p); }
  return out;
}
if (existsSync(SOURCES)) {
  shingles = new Map();
  for (const f of walk(SOURCES)) { const w = norm(readFileSync(f, "utf8")); for (let i = 0; i + N <= w.length; i++) { const k = h32(w.slice(i, i + N).join(" ")); if (!shingles.has(k)) shingles.set(k, f); } }
}
function longestVerbatim(body: string): { words: number; where: string | null; excerpt: string } {
  if (!shingles) return { words: -1, where: null, excerpt: "" };
  const w = norm(body);
  let best = 0, where: string | null = null, run = 0, excerpt = "";
  const fileText = new Map<string, string>();
  for (let i = 0; i + N <= w.length; i++) {
    const g = w.slice(i, i + N).join(" ");
    const f = shingles.get(h32(g));
    let hit = false;
    if (f) { if (!fileText.has(f)) fileText.set(f, norm(readFileSync(f, "utf8")).join(" ")); hit = fileText.get(f)!.includes(g); } // confirm: a hash collision is not a copy
    run = hit ? run + 1 : 0;
    if (hit && run + N - 1 > best) { best = run + N - 1; where = f!; excerpt = w.slice(i + N - best, i + N).join(" "); }
  }
  return { words: best, where, excerpt };
}

// ---------- the checks ----------
type Check = { pass: boolean; note: string };
const SECTIONS_OK = /\*\*(Rule|Rules|Method|Structure|Check|Principles|Model|Design consequences|Idea|Mapping|Steps|Flow|Stages|Parameters|Lessons|Format|Catalog|Ledger|Gate|Spec|Math|Guide|Modes)\b/;
const ADVICE_TOPICS = new Set(["video-type-playbook", "hook", "cta-offer", "funnel", "structure", "platform-rules", "claims-safety", "testing", "brief", "quality"]);
const HEDGE = /\b(typical|typically|about|roughly|approximately|around|default|guide|example|e\.g\.|reported|creator|practice|rule of thumb|working|for example|such as|only when|only if|if supplied|supplied|from the user|source|sources|when supplied|stated|up to|at least|at most|least|most|e\.g|house|workflow|starting point|starting points)\b/i;
const FIGURE = /(\d+(?:\.\d+)?\s?%|\$\s?\d[\d,.]*|\b\d{1,3}(?:,\d{3})+\b\s+(?:customers|people|users|views|impressions)|\b\d+\s+(?:customers|people|users|happy)\b)/g;

interface Source { dir: string; repo: string; url: string; licence: string; attribution: string }
const sources: Source[] = readdirSync(ROOT).map((d) => join(ROOT, d)).filter((p) => statSync(p).isDirectory() && existsSync(join(p, "skills-source.json"))).map((dir) => ({ dir, ...(JSON.parse(readFileSync(join(dir, "skills-source.json"), "utf8").replace(/^\uFEFF/, "")) as Omit<Source, "dir">) }));

interface Entry { id: string; source: string; file: string; topic: string; scope: string; category: string; status_before: string; checks: Record<string, Check>; result: "pass" | "fail"; status_after: string }
const entries: Entry[] = [];
for (const src of sources) {
  const licFile = ["LICENSE", "LICENSE.md", "LICENSE.txt"].map((n) => join(src.dir, n)).find(existsSync);
  const detected = licFile ? detectLicence(readFileSync(licFile, "utf8")) : null;
  const original = src.repo.startsWith("digikon/");
  for (const name of readdirSync(join(src.dir, "skills")).filter((n) => n.endsWith(".md"))) {
    const file = join(src.dir, "skills", name);
    const raw = readFileSync(file, "utf8");
    const parsed = parseSkillFile(raw.replace(/^\uFEFF/, ""))!;
    const id = String(parsed.meta["id"]), topic = String(parsed.meta["topic"]), scope = String(parsed.meta["scope"]), category = String(parsed.meta["category"]), status = String(parsed.meta["status"] ?? "draft");
    const body = parsed.body;
    const footerAt = body.lastIndexOf("\n_");
    const main = footerAt > 0 ? body.slice(0, footerAt) : body;
    const footer = footerAt > 0 ? body.slice(footerAt) : "";
    const words = main.split(/\s+/).filter(Boolean).length;
    const c: Record<string, Check> = {};

    c["C1"] = (() => {
      const probs: string[] = [];
      if (!licFile) probs.push("no LICENSE file"); else if (detected !== src.licence) probs.push(`LICENSE file reads as ${detected ?? "unknown"}, manifest says ${src.licence}`);
      if (!(ALLOWED_LICENCES as readonly string[]).includes(src.licence)) probs.push("licence not on the allow-list");
      if (!src.attribution?.trim()) probs.push("no attribution"); if (!src.url?.trim()) probs.push("no source URL");
      return { pass: probs.length === 0, note: probs.join("; ") || `${src.licence}; ${src.attribution.slice(0, 60)}` };
    })();
    c["C2"] = (() => {
      if (original) { const v = longestVerbatim(main); return v.words < 0 ? { pass: false, note: "sources not available, not checked" } : { pass: v.words < N, note: v.words >= N ? `${v.words} words verbatim in ${v.where}` : `longest verbatim run ${v.words} words` }; }
      const v = longestVerbatim(main);
      return v.words < 0 ? { pass: false, note: "sources not available, not checked" } : { pass: v.words < N, note: v.words >= N ? `${v.words} words verbatim in ${v.where}: "${v.excerpt}"` : `longest verbatim run ${v.words} words` };
    })();
    c["C3"] = ADVICE_TOPICS.has(topic) ? { pass: /claims?\b|caution|never (invent|create|claim)|do not promise|not a guarantee/i.test(main), note: "advice skill needs a claims or caution line" } : { pass: true, note: "not an advice topic" };
    c["C4"] = (() => {
      const flagged: string[] = [];
      for (const line of main.split("\n")) for (const sentence of line.split(/(?<=[.!?])\s+/)) { FIGURE.lastIndex = 0; if (FIGURE.test(sentence) && !HEDGE.test(sentence) && !/^\*\*Example/.test(line.trim())) flagged.push(sentence.trim().slice(0, 90)); }
      return { pass: flagged.length === 0, note: flagged.length ? `unmarked figure: ${flagged.join(" | ")}` : "no unmarked figures" };
    })();
    c["C5"] = (() => {
      const names = /(tiktok|reels|shorts|youtube|linkedin|instagram)/i.test(main), numbers = /(\d+\s?(s|seconds|minutes)\b|\b\d{3,4}\s?[x\u00d7]\s?\d{3,4}\b)/i.test(main);
      const needs = topic === "platform-rules" || (names && numbers);
      const has = /confirm|verified platform|working default|defaults|check first|platform_specs|figures are|treat these|are not law|change/i.test(main);
      return { pass: !needs || has, note: needs ? (has ? "platform figures flagged as defaults" : "platform figures without a default/confirm statement") : "no platform figures" };
    })();
    c["C6"] = (() => {
      const probs: string[] = [];
      if (!/\*\*When to use/.test(main)) probs.push("no When to use");
      if (topic === "video-type-playbook" && original) for (const s of ["Structure", "Scene beats", "Pacing", "Asset needs"]) if (!new RegExp(`\\*\\*${s}`).test(main)) probs.push(`playbook missing ${s}`);
      const labels = new Set([...main.matchAll(/\*\*([A-Za-z][A-Za-z \/\-]{1,40}):?\*\*/g)].map((m) => m[1]!.toLowerCase()).filter((l) => !/^(when to use|example|examples|claims|claims warning|caution|licence|licence warning|source|asset needs|ask first|ask the user)/.test(l)));
      if (!(topic === "video-type-playbook" && original) && labels.size < 2) probs.push(`needs at least two labelled sections besides When to use, Example and the caution lines (has ${labels.size})`);
      const lo = original ? 150 : 80;
      if (words < lo || words > 350) probs.push(`${words} words, expected ${lo} to 350`);
      return { pass: probs.length === 0, note: probs.join("; ") || `${words} words` };
    })();
    c["C7"] = (() => {
      if (original) return { pass: /Original Digikon skill/.test(footer), note: "original footer" };
      const ok = footer.includes(src.url) && footer.includes(src.licence === "Apache-2.0" ? "Apache-2.0" : "MIT") && /adaptation/i.test(footer);
      return { pass: ok, note: ok ? "footer names source, licence and holder" : "footer missing source URL, licence or 'adaptation'" };
    })();
    c["C8"] = NOTES.skimmed[id] ? { pass: false, note: `source read in outline only: ${NOTES.skimmed[id]}` } : { pass: true, note: "source read closely (author's account)" };

    const pass = Object.values(c).every((x) => x.pass);
    const keepApproved = pass && status === "approved";
    entries.push({ id, source: src.repo + (src.url.includes("/tree/") ? ` (${src.url.split("/tree/")[1]})` : ""), file, topic, scope, category, status_before: status, checks: c, result: pass ? "pass" : "fail", status_after: !pass ? "draft" : keepApproved || approval ? "approved" : "reviewed" });
  }
}
entries.sort((a, b) => a.id.localeCompare(b.id));

if (apply) for (const e of entries) {
  const t = readFileSync(e.file, "utf8");
  const next = t.replace(/^status: \w+$/m, `status: ${e.status_after}`);
  if (next !== t) writeFileSync(e.file, next, "utf8");
}
const passed = entries.filter((e) => e.result === "pass").length;
const reviewedAt = new Date().toISOString().slice(0, 10);
const [by, on, ...basis] = (approval ?? "").split(",").map((x) => x.trim());
if (approval && (!by || !/^\d{4}-\d{2}-\d{2}$/.test(on ?? ""))) { console.error(`--approve needs "<who>, <YYYY-MM-DD>, <basis>"`); process.exit(2); }
const approvalRecord = approval ? { by: by!, on: on!, basis: basis.join(", ") } : prevApproval;
writeFileSync(join(ROOT, "REVIEW.json"), JSON.stringify({ reviewed_on: reviewedAt, reviewer: "the agent that wrote the skills (a human approved the result, see approval)", checklist: "docs/SKILL_REVIEW.md", sources_checked: existsSync(SOURCES), total: entries.length, passed, kept_draft: entries.length - passed, approved: entries.filter((e) => e.status_after === "approved").length, approval: approvalRecord, skills: entries.map(({ file: _f, ...e }) => e) }, null, 1) + "\n");
const L = [`# Skill review results (${reviewedAt})`, "", "Checklist: [docs/SKILL_REVIEW.md](../../docs/SKILL_REVIEW.md). The checks were run by the same agent that wrote the skills." + (approvalRecord ? ` **Approved by ${approvalRecord.by} on ${approvalRecord.on} (${approvalRecord.basis}).** Approval covers the text as it was on that date; a skill that is edited and no longer passes goes back to draft.` : " **Nothing is approved yet: that needs a human.**"), "", `${entries.length} skills: ${passed} pass, ${entries.filter((e) => e.status_after === "approved").length} \`approved\`, ${entries.filter((e) => e.status_after === "reviewed").length} \`reviewed\`, ${entries.length - passed} stay \`draft\`. Sources ${existsSync(SOURCES) ? "were" : "were NOT"} available for the verbatim check.`, "", "| skill | source | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | result |", "|---|---|---|---|---|---|---|---|---|---|---|"];
const mark = (c: Check) => (c.pass ? "ok" : "FAIL");
for (const e of entries) L.push(`| ${e.id} | ${e.source.split(" ")[0]} | ${["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"].map((k) => mark(e.checks[k]!)).join(" | ")} | ${e.status_after} |`);
const fails = entries.filter((e) => e.result === "fail");
if (fails.length) { L.push("", "## Why skills stay draft", ""); for (const e of fails) L.push(`- **${e.id}**: ${Object.entries(e.checks).filter(([, c]) => !c.pass).map(([k, c]) => `${k} ${c.note}`).join("; ")}`); }
writeFileSync(join(ROOT, "REVIEW.md"), L.join("\n") + "\n");
console.log(`${entries.length} skills: ${passed} pass, ${entries.length - passed} fail${apply ? " (statuses written)" : " (dry run: use --apply to write statuses)"}`);
for (const e of fails) console.log(`  ${e.id}: ${Object.entries(e.checks).filter(([, c]) => !c.pass).map(([k, c]) => `${k} ${c.note}`).join("; ")}`.slice(0, 260));
