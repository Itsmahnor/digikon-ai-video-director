import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BrandFact, Recipe } from "@digikon/contracts";
import { COLLECTIONS, type Collection, type Doc } from "./types.js";

/** Minimal frontmatter: `key: value` lines between two `---` fences. Lists are comma-separated. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error("missing frontmatter");
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2]!.trim() };
}

/** Loads knowledge/<collection>/*.md. Each file needs id, title, source and grade in its frontmatter. */
export function loadKnowledge(dir: string): Doc[] {
  const docs: Doc[] = [];
  const ids = new Set<string>();
  for (const col of readdirSync(dir)) {
    const colDir = join(dir, col);
    if (!statSync(colDir).isDirectory()) continue;
    if (!(COLLECTIONS as readonly string[]).includes(col)) throw new Error(`unknown collection folder "${col}"`);
    for (const file of readdirSync(colDir)) {
      if (!file.endsWith(".md") || file.toLowerCase() === "readme.md") continue;
      const path = join(colDir, file);
      const { meta, body } = parseFrontmatter(readFileSync(path, "utf8"));
      for (const key of ["id", "title", "source", "grade"]) {
        if (!meta[key]) throw new Error(`${path}: frontmatter needs "${key}"`);
      }
      if (!["A", "B", "C"].includes(meta.grade!)) throw new Error(`${path}: grade must be A, B or C`);
      if (ids.has(meta.id!)) throw new Error(`duplicate knowledge id ${meta.id}`);
      ids.add(meta.id!);
      docs.push({
        id: meta.id!,
        collection: col as Collection,
        title: meta.title!,
        text: body,
        source: meta.source!,
        metadata: {
          grade: meta.grade as "A" | "B" | "C",
          verified: meta.verified === "true",
          topics: meta.topics ? meta.topics.split(",").map((s) => s.trim()) : [],
        },
      });
    }
  }
  return docs;
}

/** One recipe is one chunk. The parameter table is shown after selection, so the indexed text is intent-focused. */
export function recipeDocs(recipes: Recipe[]): Doc[] {
  return recipes.map((r) => ({
    id: r.recipe_id,
    collection: "shot_recipes" as const,
    title: r.title,
    text: `${r.purpose} Used for: ${r.intents.join("; ")}. Type: ${r.type}. Energy: ${r.constraints.energy}.`,
    source: `recipe ${r.recipe_id}@${r.version} (${r.source.origin}, ${r.source.license})`,
    metadata: {
      recipe_type: r.type,
      recipe_status: r.status,
      recipe_aspect_ratios: r.compatibility.aspect_ratios,
      recipe_media_types: r.compatibility.media_types,
      recipe_min_duration_s: r.constraints.min_duration_s,
      recipe_max_duration_s: r.constraints.max_duration_s,
      recipe_energy: r.constraints.energy,
    },
  }));
}

export function brandFactDocs(facts: BrandFact[], projectId: string): Doc[] {
  return facts.map((f) => ({
    id: f.fact_id,
    collection: "brand_product_facts" as const,
    title: f.fact_id,
    text: f.text,
    source: f.source,
    metadata: { project_id: projectId },
  }));
}
