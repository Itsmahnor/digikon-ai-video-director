import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LibraryTemplate, Palette, TEMPLATE_CATEGORIES, SCENE_CATEGORIES, SUPPORT_CATEGORIES } from "@digikon/contracts";
import { HashEmbedder, MemoryDataStore } from "@digikon/rag";
import { DEDUPE, candidateOf, compare, dedupe, isDuplicate } from "./dedupe.js";
import { candidateStyles, styleKey } from "./expand.js";
import { ALL_FAMILIES } from "./families/index.js";
import { categoryRows } from "./categories.js";
import { ingestLibrary } from "./ingest.js";
import { PALETTES, styleOf, toTemplate, ASPECTS } from "./kit.js";
import { loadLibrary, structuralFeatures, templateHash, validateTemplate, withHash, writeTemplate } from "./library.js";
import { decide, readReviews, reviewQueue } from "./review.js";
import { searchTemplates } from "./search.js";
import { formatStats, libraryStats } from "./stats.js";
import { LOOK_MODEL, LOOK_MODEL_VERSION } from "./look.js";
import { saveLooks } from "./looks.js";
import { RENDER_REV } from "./preview.js";

const base = (id: string) => { const f = ALL_FAMILIES.find((x) => x.id === id)!; return withHash(toTemplate(f, styleOf(f), styleOf(f))); };

describe("the contract", () => {
  it("has 12 scene and 6 supporting categories", () => {
    expect(SCENE_CATEGORIES).toHaveLength(12);
    expect(SUPPORT_CATEGORIES).toHaveLength(6);
    expect(TEMPLATE_CATEGORIES).toHaveLength(18);
  });
  it("accepts a built template and rejects broken ones", () => {
    const t = base("hook-bold-claim");
    expect(LibraryTemplate.safeParse(t).success).toBe(true);
    const unbound = structuredClone(t); unbound.needs.text_slots.push({ name: "extra", role: "item", max_chars: 10, required: true, example: "x" });
    expect(LibraryTemplate.safeParse(unbound).success).toBe(false);
    const noAspect = structuredClone(t); delete (noAspect.scene_graph as Record<string, unknown>)["9:16"];
    expect(LibraryTemplate.safeParse(noAspect).success).toBe(false);
    const selfVariant = { ...structuredClone(t), variant_of: t.template_id };
    expect(LibraryTemplate.safeParse(selfVariant).success).toBe(false);
    const reviewedNoEvidence = { ...structuredClone(t), status: "reviewed" as const };
    expect(LibraryTemplate.safeParse(reviewedNoEvidence).success).toBe(false);
    const unlicensed = { ...structuredClone(t), status: "reviewed" as const, evidence: [{ kind: "validation" as const, ref: "x" }], source: { ...t.source, licence_ok: false } };
    expect(LibraryTemplate.safeParse(unlicensed).success).toBe(false);
  });
  it("the content hash ignores status and evidence but sees the design", () => {
    const t = base("hook-bold-claim");
    expect(templateHash({ ...t, status: "reviewed", evidence: [{ kind: "review", ref: "r" }] })).toBe(t.content_hash);
    expect(templateHash({ ...t, title: "Another title" })).not.toBe(t.content_hash);
  });
});

describe("the authored families", () => {
  it("every reference palette satisfies the palette contract", () => {
    for (const p of PALETTES) expect(Palette.safeParse(p).success, p.name).toBe(true);
  });
  it("covers all 18 categories", () => {
    expect(new Set(ALL_FAMILIES.map((f) => f.category))).toEqual(new Set(TEMPLATE_CATEGORIES));
    expect(new Set(ALL_FAMILIES.map((f) => f.id)).size).toBe(ALL_FAMILIES.length);
  });
  it("every base family builds and is valid at 16:9, 9:16 and 1:1", () => {
    for (const f of ALL_FAMILIES) {
      const v = validateTemplate(base(f.id));
      expect(v.map((x) => x.aspect).sort(), f.id).toEqual([...ASPECTS].sort());
      expect(v.filter((x) => !x.ok).map((x) => `${f.id} ${x.aspect}: ${x.issues.join("; ")}`)).toEqual([]);
    }
  });
  it("variant expansion is deterministic, distinct and never repeats the base", () => {
    const f = ALL_FAMILIES.find((x) => x.id === "kt-word-pop")!;
    const a = candidateStyles(f, 12), b = candidateStyles(f, 12);
    expect(a.map(styleKey)).toEqual(b.map(styleKey));
    expect(new Set(a.map(styleKey)).size).toBe(a.length);
    expect(a.map(styleKey)).not.toContain(styleKey(styleOf(f)));
    const ids = a.map((s) => toTemplate(f, s, styleOf(f)).template_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of a) expect(LibraryTemplate.safeParse(toTemplate(f, s, styleOf(f))).success).toBe(true);
  });
  it("the validator catches a text that cannot be read", () => {
    const t = structuredClone(base("hook-bold-claim"));
    const g = t.scene_graph["16:9"]!;
    const head = g.elements.find((e) => e.id === "headline")!;
    (head.props as Record<string, unknown>)["font_px"] = 12;
    const v = validateTemplate(withHash(t));
    expect(v.find((x) => x.aspect === "16:9")!.ok).toBe(false);
  });
});

describe("distinctness", () => {
  const unit = (n: number, i: number) => Array.from({ length: n }, (_, k) => (k === i ? 1 : 0));
  it("is a duplicate only when structure and look agree, or the look alone is near-identical", () => {
    expect(isDuplicate({ struct: 0.9, look: 0.95 })).toBe(true);
    expect(isDuplicate({ struct: 0.9, look: 0.8 })).toBe(false);
    expect(isDuplicate({ struct: 0.3, look: 0.95 })).toBe(false);
    expect(isDuplicate({ struct: 0.3, look: 0.99 })).toBe(true);
  });
  it("keeps a base over its own near-identical variants and reports what it duplicates", () => {
    const f = ALL_FAMILIES.find((x) => x.id === "hook-bold-claim")!, s = styleOf(f);
    const b = withHash(toTemplate(f, s, s)), v = withHash(toTemplate(f, { ...s, palette: PALETTES[1]! }, s));
    const same = unit(4, 0);
    const out = dedupe([candidateOf(v, same), candidateOf(b, same)]);
    expect(out.find((d) => d.id === b.template_id)!.accepted).toBe(true);
    const dv = out.find((d) => d.id === v.template_id)!;
    expect(dv.accepted).toBe(false);
    expect(dv.duplicate_of).toBe(b.template_id);
    const far = dedupe([candidateOf(v, unit(4, 1)), candidateOf(b, same)]);
    expect(far.every((d) => d.accepted)).toBe(true);
  });
  it("two different families are structurally far apart", () => {
    const a = candidateOf(base("hook-bold-claim"), unit(4, 0)), b = candidateOf(base("cta-big-address"), unit(4, 0));
    expect(compare(a, b).struct).toBeLessThan(DEDUPE.struct_dup);
    expect(structuralFeatures(base("hook-bold-claim")).size).toBeGreaterThan(10);
  });
});

describe("the library on disk, stats, review, ingest and search", () => {
  const root = mkdtempSync(join(tmpdir(), "tplib-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const ids = ["hook-bold-claim", "hook-number-shock", "problem-pain-list", "cta-button-pulse"];
  for (const id of ids) writeTemplate(base(id), root);
  const looks = new Map(ids.map((id, i) => [id, Array.from({ length: 6 }, (_, k) => (k === i ? 1 : 0))]));

  it("writes and reloads templates, and reports an unreadable file", () => {
    const l = loadLibrary(root);
    expect(l.filter((x) => x.record)).toHaveLength(4);
    expect(l.find((x) => x.record?.template_id === "hook-bold-claim")!.record!.content_hash).toBe(base("hook-bold-claim").content_hash);
    expect(JSON.parse(readFileSync(l[0]!.file, "utf8")).format).toBe("digikon.template");
  });

  const looksFile = join(root, "looks.json");
  saveLooks({ model: LOOK_MODEL, version: LOOK_MODEL_VERSION, rev: RENDER_REV, vectors: Object.fromEntries(ids.map((id) => [id, { hash: base(id).content_hash, v: looks.get(id)! }])) }, looksFile);

  it("stats counts valid and distinct templates per category against 100, and needs look vectors", async () => {
    await expect(libraryStats({ root, render: false, looksFile: join(root, "missing.json") })).rejects.toThrow(/look vector/);
    const s = await libraryStats({ root, render: false, looksFile });
    const row = (c: string) => s.rows.find((r) => r.category === c)!;
    expect(s.rows).toHaveLength(18);
    expect(row("hook")).toMatchObject({ files: 2, families: 2, variants: 0, valid: 2, distinct: 2, target: 100 });
    expect(row("cta_end")).toMatchObject({ files: 1, distinct: 1 });
    expect(row("ui_demo")).toMatchObject({ files: 0, distinct: 0 });
    expect(formatStats(s.rows)).toMatch(/TOTAL/);
  });

  it("review: the queue lists draft candidates with neighbours; approval records a reason and marks the file reviewed; a rejection is not counted", async () => {
    const q = await reviewQueue({ root, looksFile });
    expect(q).toHaveLength(4);
    expect(q.find((x) => x.template.template_id === "hook-bold-claim")!.neighbours[0]!.id).toBe("hook-number-shock");
    expect(() => decide("hook-bold-claim", "approved", "  ", "tester", root)).toThrow(/reason/);
    const e = decide("hook-bold-claim", "approved", "reads well at all three sizes", "tester", root);
    expect(e.verdict).toBe("approved");
    expect(readReviews(root)).toHaveLength(1);
    const t = loadLibrary(root).find((x) => x.record?.template_id === "hook-bold-claim")!.record!;
    expect(t.status).toBe("reviewed");
    expect(t.evidence.some((x) => x.kind === "review")).toBe(true);
    expect(t.content_hash).toBe(base("hook-bold-claim").content_hash);
    expect(() => decide("nope", "rejected", "x", "t", root)).toThrow(/no template/);
    decide("cta-button-pulse", "rejected", "too close to another closing scene", "tester", root);
    expect((await reviewQueue({ root, looksFile })).map((x) => x.template.template_id).sort()).toEqual(["hook-number-shock", "problem-pain-list"]);
    const s = await libraryStats({ root, render: false, looksFile });
    expect(s.rows.find((r) => r.category === "cta_end")).toMatchObject({ files: 1, rejected: 1, distinct: 0 });
  });
  it("ingest seeds the 18 categories and is idempotent; search filters, ranks and avoids repeats", async () => {
    const store = new MemoryDataStore(), emb = new HashEmbedder(256);
    const recs = loadLibrary(root).map((x) => x.record!);
    const s1 = await ingestLibrary(store, emb, recs, looks, { reviewRoot: root });
    expect(s1.categories).toBe(categoryRows().length);
    expect((await store.listCategories()).filter((c) => c.parent_id !== null)).toHaveLength(18);
    expect(s1.added).toBe(4);
    expect(s1.reviews).toBe(2);
    const s2 = await ingestLibrary(store, emb, recs, looks, { reviewRoot: root });
    expect(s2.unchanged).toBe(4);
    expect(s2.added + s2.updated).toBe(0);

    const all = { status: ["draft", "reviewed"] as ("draft" | "reviewed")[] };
    const hooks = await searchTemplates(store, emb, { text: "opening hook with a bold claim headline", category: "hook", ...all });
    expect(hooks.every((h) => h.category === "hook")).toBe(true);
    expect(hooks[0]!.template_id).toBe("hook-bold-claim");
    expect((await searchTemplates(store, emb, { text: "closing call to action button", ...all, category: "cta_end" })).map((h) => h.template_id)).toEqual(["cta-button-pulse"]);
    // default status is reviewed only
    expect((await searchTemplates(store, emb, { text: "scene" })).map((h) => h.template_id)).toEqual(["hook-bold-claim"]);
    // proven-only: reviewed + review evidence + valid at all aspects (+ uses when asked)
    expect((await searchTemplates(store, emb, { text: "opening hook", proven_only: true, ...all })).map((h) => h.template_id)).toEqual(["hook-bold-claim"]);
    expect(await searchTemplates(store, emb, { text: "opening hook", proven_only: true, min_uses: 1, ...all })).toEqual([]);
    // aspect filter
    expect((await searchTemplates(store, emb, { text: "hook", aspect: "9:16", ...all })).length).toBeGreaterThan(0);
    // no-repeat: what the film already used is ranked lower
    const before = await searchTemplates(store, emb, { text: "opening hook with a bold claim headline", category: "hook", film_id: "f1", ...all });
    await store.logTemplateUsage({ template_id: "hook-bold-claim", film_id: "f1", scene_id: "S01", outcome: {} });
    const after = await searchTemplates(store, emb, { text: "opening hook with a bold claim headline", category: "hook", film_id: "f1", ...all });
    expect(before[0]!.template_id).toBe("hook-bold-claim");
    expect(after[0]!.template_id).toBe("hook-number-shock");
    expect(after.find((h) => h.template_id === "hook-bold-claim")!.why.join(" ")).toMatch(/already used/);
    // used elsewhere but not in this film: only a gentle penalty, still found
    expect((await searchTemplates(store, emb, { text: "bold claim", category: "hook", film_id: "other", ...all })).some((h) => h.template_id === "hook-bold-claim")).toBe(true);
    // proven with min_uses once it has been used
    expect((await searchTemplates(store, emb, { text: "opening hook", proven_only: true, min_uses: 1, ...all })).map((h) => h.template_id)).toEqual(["hook-bold-claim"]);
    // a retired or filtered-out template is never returned
    expect((await searchTemplates(store, emb, { text: "button", category: "hook", ...all })).map((h) => h.category)).not.toContain("cta_end");
  });
});
