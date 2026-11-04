import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SkillRecord } from "@digikon/contracts";
import { contentHash } from "./templates.js";
import { cosine, type DataStore, type SkillRow, type SkillSourceRow } from "./db/store.js";
import type { Embedder } from "./embeddings.js";
import type { Doc } from "./types.js";

/**
 * Importing skills from a folder (or a local clone of a repo): read -> licence gate -> normalise -> near-duplicate removal -> embed -> store.
 * The licence gate (step B0) runs before anything is read into a record: a source whose licence is not on the allow-list is refused whole, with the reason.
 * Layout: `skills-source.json` ({repo, url, licence?, attribution?}), an optional LICENSE file, and `*.md` skills with a `---` frontmatter block.
 */

export const ALLOWED_LICENCES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0", "CC-BY-4.0"] as const;
export type AllowedLicence = (typeof ALLOWED_LICENCES)[number];
export const NEAR_DUPLICATE_THRESHOLD = 0.95;

const ALIASES: Record<string, AllowedLicence> = {
  "mit": "MIT", "apache-2.0": "Apache-2.0", "apache 2.0": "Apache-2.0", "apache-2": "Apache-2.0", "bsd-2-clause": "BSD-2-Clause", "bsd-3-clause": "BSD-3-Clause", "bsd": "BSD-3-Clause",
  "cc0": "CC0-1.0", "cc0-1.0": "CC0-1.0", "cc-by-4.0": "CC-BY-4.0", "cc-by": "CC-BY-4.0",
};

/** Names a licence from LICENSE file text; null when it is not recognisable. Order matters: NC/ND/SA variants must not be read as plain CC-BY. */
export function detectLicence(text: string): string | null {
  const t = text.toLowerCase();
  if (/creative commons/.test(t) && /(noncommercial|non-commercial|noderivs|no derivatives|sharealike|share alike)/.test(t)) return "CC-BY-restricted";
  if (/cc0|public domain dedication/.test(t)) return "CC0-1.0";
  if (/creative commons attribution 4\.0|cc-by-4\.0/.test(t)) return "CC-BY-4.0";
  if (/apache license/.test(t) && /version 2\.0/.test(t)) return "Apache-2.0";
  if (/permission is hereby granted, free of charge/.test(t)) return "MIT";
  if (/redistribution and use in source and binary forms/.test(t)) return /neither the name|endorse or promote/.test(t) ? "BSD-3-Clause" : "BSD-2-Clause";
  return null;
}

export interface LicenceVerdict { ok: boolean; licence: string | null; attribution_required: boolean; reason: string }

export function checkLicence(declared: string | null | undefined, fileText: string | null, attribution: string | null | undefined): LicenceVerdict {
  const detected = fileText ? detectLicence(fileText) : null;
  const named = declared ? (ALIASES[declared.trim().toLowerCase()] ?? declared.trim()) : null;
  if (named && detected && detected !== named && ALIASES[detected.toLowerCase()] !== named) {
    return { ok: false, licence: named, attribution_required: false, reason: `declared licence ${named} disagrees with the LICENSE file (${detected}); settle it before importing` };
  }
  const licence = named ?? detected;
  if (!licence) return { ok: false, licence: null, attribution_required: false, reason: "no licence declared and none recognised in a LICENSE file" };
  if (!(ALLOWED_LICENCES as readonly string[]).includes(licence)) return { ok: false, licence, attribution_required: false, reason: `licence ${licence} is not on the allow-list (${ALLOWED_LICENCES.join(", ")})` };
  const needsAttribution = licence === "CC-BY-4.0";
  if (needsAttribution && !(attribution && attribution.trim())) return { ok: false, licence, attribution_required: true, reason: "CC-BY needs an attribution line (set `attribution` in skills-source.json) and none was given" };
  return { ok: true, licence, attribution_required: needsAttribution, reason: "allowed" };
}

export interface ParsedSkillFile { meta: Record<string, string | string[]>; body: string }

/** `key: value` lines between two `---` lines; `platform: a, b` becomes a list. */
export function parseSkillFile(text: string): ParsedSkillFile | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const meta: Record<string, string | string[]> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!] = kv[1] === "platform" ? kv[2]!.split(",").map((s) => s.trim()).filter(Boolean) : kv[2]!.trim();
  }
  return { meta, body: m[2]!.trim() };
}

/** A stored skill as a retrievable document. Retired skills are not retrievable; approved ones count as reviewed. */
export function skillDoc(row: SkillRow): Doc | null {
  if (row.status === "retired") return null;
  return {
    id: row.id, collection: "skills", title: row.title, text: `${row.title}. ${typeof row.body === "string" ? row.body : JSON.stringify(row.body)}`,
    source: `skill ${row.id} (source ${row.source_id})`,
    metadata: { status: row.status === "draft" ? "draft" : "reviewed", skill_category: row.category, skill_topic: row.topic, skill_scope: row.scope, skill_funnel_stage: row.funnel_stage, skill_platforms: row.platform, skill_grade: row.grade, topics: [row.topic, row.category, row.funnel_stage] },
  };
}

export interface ImportResult {
  source_id: string | null;
  licence: LicenceVerdict | null;
  added: string[]; updated: string[]; unchanged: string[];
  duplicates: { id: string; of: string; similarity: number }[];
  rejected: { file: string; problems: string[] }[];
}

const skillText = (r: SkillRecord): string => [r.title, r.topic.replace(/[-_]/g, " "), r.category.replace(/-/g, " "), r.funnel_stage.replace(/-/g, " "), r.platform.join(" "), r.body].join(". ");

const stripBom = (s: string): string => s.replace(/^\uFEFF/, "");

function walk(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === ".git" || n === "node_modules" ? [] : walk(p)) : [p]; });
}

export async function importSkills(store: DataStore, embedder: Embedder, dir: string, opts: { today?: string; dryRun?: boolean } = {}): Promise<ImportResult> {
  const res: ImportResult = { source_id: null, licence: null, added: [], updated: [], unchanged: [], duplicates: [], rejected: [] };
  const manifestPath = join(dir, "skills-source.json");
  if (!existsSync(manifestPath)) { res.rejected.push({ file: "skills-source.json", problems: ["missing: say which repo this is (repo, url, licence)"] }); return res; }
  let manifest: { repo?: string; url?: string; licence?: string; attribution?: string };
  try { manifest = JSON.parse(stripBom(readFileSync(manifestPath, "utf8"))); } catch { res.rejected.push({ file: "skills-source.json", problems: ["not readable JSON"] }); return res; }
  const licFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE"].map((n) => join(dir, n)).find(existsSync);
  const verdict = checkLicence(manifest.licence, licFile ? readFileSync(licFile, "utf8") : null, manifest.attribution);
  res.licence = verdict;
  if (!verdict.ok || !manifest.repo || !manifest.url) {
    res.rejected.push({ file: "(whole source)", problems: [verdict.ok ? "skills-source.json needs repo and url" : `licence gate: ${verdict.reason}`] });
    return res;
  }
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const source: SkillSourceRow = { id: createHash("sha256").update(manifest.repo).digest("hex").slice(0, 16), repo: manifest.repo, url: manifest.url, licence: verdict.licence!, attribution: manifest.attribution?.trim() || null, checked_on: today };
  res.source_id = source.id;

  const records: { file: string; record: SkillRecord }[] = [];
  const seenIds = new Set<string>();
  for (const path of walk(dir).filter((p) => p.endsWith(".md") && !/^licen[cs]e/i.test(p.split(/[\\/]/).pop()!))) {
    const file = path.slice(dir.length + 1).replace(/\\/g, "/");
    const parsed = parseSkillFile(stripBom(readFileSync(path, "utf8")));
    if (!parsed) { res.rejected.push({ file, problems: ["no frontmatter block"] }); continue; }
    const r = SkillRecord.safeParse({ ...parsed.meta, body: parsed.body, source: { repo: source.repo, url: source.url, licence: source.licence, attribution: source.attribution, checked_on: today } });
    if (!r.success) { res.rejected.push({ file, problems: r.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`) }); continue; }
    if (seenIds.has(r.data.id)) { res.rejected.push({ file, problems: [`duplicate skill id ${r.data.id} in this import`] }); continue; }
    seenIds.add(r.data.id);
    records.push({ file, record: r.data });
  }
  if (opts.dryRun) { res.added = records.map((r) => r.record.id); return res; }

  await store.upsertSkillSource(source);
  const kept = new Map<string, number[]>();
  for (const { record } of records) {
    // Hash covers everything but the check date, so a repeat import on another day changes nothing.
    const hash = contentHash({ ...record, source: { ...record.source, checked_on: "" } });
    const before = await store.getSkill(record.id);
    const [vector] = await embedder.embed([skillText(record)]);
    const embedded = (await store.nearestSkills({ model: embedder.model, model_version: embedder.version, vector: vector!, k: 5000 })).some((n) => n.skill_id === record.id);
    if (before && before.content_hash === hash && before.source_id === source.id && embedded) { res.unchanged.push(record.id); kept.set(record.id, vector!); continue; }
    let dup: { of: string; similarity: number } | null = null;
    for (const [id, v] of kept) { const s = cosine(v, vector!); if (s >= NEAR_DUPLICATE_THRESHOLD && (!dup || s > dup.similarity)) dup = { of: id, similarity: s }; }
    if (!dup) for (const n of await store.nearestSkills({ model: embedder.model, model_version: embedder.version, vector: vector!, k: 3 })) {
      if (n.skill_id !== record.id && n.score >= NEAR_DUPLICATE_THRESHOLD && (!dup || n.score > dup.similarity)) dup = { of: n.skill_id, similarity: n.score };
    }
    if (dup) { res.duplicates.push({ id: record.id, of: dup.of, similarity: Number(dup.similarity.toFixed(4)) }); continue; }
    const row: SkillRow = { id: record.id, category: record.category, topic: record.topic, scope: record.scope, funnel_stage: record.funnel_stage, platform: record.platform, grade: record.grade, status: record.status, title: record.title, body: record.body, content_hash: hash, source_id: source.id };
    await store.upsertSkill(row);
    await store.upsertSkillEmbedding({ skill_id: record.id, model: embedder.model, model_version: embedder.version, vector: vector! });
    kept.set(record.id, vector!);
    (before ? res.updated : res.added).push(record.id);
  }
  return res;
}
