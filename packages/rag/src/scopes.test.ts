import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RetrievalRecord } from "@digikon/contracts";
import { loadRecipes } from "@digikon/recipes";
import { AGENT_SCOPES, KeywordRetriever, ScopedRetriever, brandFactDocs, eligible, loadKnowledge, recipeDocs, sharedTopics, type Doc } from "./index.js";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const knowledge = loadKnowledge(root("knowledge"));
const docs: Doc[] = [...recipeDocs(loadRecipes(root("recipes"))), ...knowledge, ...brandFactDocs([{ fact_id: "F01", text: "Roasted weekly", source: "label" }], "p1")];
const base = new KeywordRetriever(docs);
const ids = (hits: { doc: Doc }[]) => hits.map((h) => h.doc.id);

describe("agent retrieval scopes", () => {
  it("keeps ad strategy and brand facts away from the Editor, and serves it editing notes", async () => {
    const editor = new ScopedRetriever(base, "editor");
    expect(await editor.retrieve({ text: "hook call to action claims structure", collection: "ad_playbooks", k: 5 })).toEqual([]);
    expect(await editor.retrieve({ text: "roasted weekly", collection: "brand_product_facts", k: 5, filter: { project_id: "p1" } })).toEqual([]);
    expect(await editor.get("claims-discipline", "ad_playbooks")).toBeNull();
    const cuts = await editor.retrieve({ text: "cut transition audio leads picture", collection: "directing_principles", k: 10 });
    expect(cuts.length).toBeGreaterThan(0);
    expect(cuts.every((h) => (h.doc.metadata.topics ?? []).some((t) => AGENT_SCOPES.editor.topics.includes(t)))).toBe(true);
    // Shot-planning notes with no editing topic are Director-only.
    const all = ids(await editor.retrieve({ text: "shot size wide medium close up reframing crop", collection: "directing_principles", k: 20 }));
    expect(all).not.toContain("shot-size-progression");
    expect(all).not.toContain("reframing-limits");
  });

  it("serves the Director its strategy and shooting notes, and narrows a topic request to its scope", async () => {
    const director = new ScopedRetriever(base, "director");
    expect(ids(await director.retrieve({ text: "claims proof approved facts", collection: "ad_playbooks", k: 5 }))).toContain("claims-discipline");
    expect(ids(await director.retrieve({ text: "roasted weekly", collection: "brand_product_facts", k: 5, filter: { project_id: "p1" } }))).toEqual(["F01"]);
    expect(ids(await director.retrieve({ text: "shot size progression", collection: "directing_principles", k: 5, filter: { topics: ["cinematography"] } }))).toContain("shot-size-progression");
    // The editor asking for a Director-only topic gets nothing, rather than the filter being dropped.
    const editor = new ScopedRetriever(base, "editor");
    expect(await editor.retrieve({ text: "shot size progression", collection: "directing_principles", k: 5, filter: { topics: ["cinematography"] } })).toEqual([]);
  });

  it("covers every topic the Director's steps already use, and shares only the editing craft", async () => {
    const steps = ["strategy", "cinematography", "framing", "continuity", "reframing", "quality", "editing", "transitions", "motion", "text", "legibility", "sound", "loudness", "ducking"];
    expect(steps.filter((t) => !AGENT_SCOPES.director.topics.includes(t))).toEqual([]);
    expect(sharedTopics()).not.toContain("strategy");
    expect(sharedTopics()).not.toContain("cinematography");
    expect(sharedTopics()).toContain("editing");
  });

  it("never returns draft recipes or draft notes unless development mode allows it", async () => {
    const editor = new ScopedRetriever(base, "editor");
    expect(await editor.retrieve({ text: "soft dissolve crossfade", collection: "shot_recipes", k: 5, filter: { include_draft: true } })).toEqual([]); // caller cannot opt in
    const dev = new ScopedRetriever(base, "editor", { allowDraft: true });
    expect(ids(await dev.retrieve({ text: "soft dissolve crossfade", collection: "shot_recipes", k: 5, filter: { include_draft: true } }))).toContain("crossfade");

    const draftNote: Doc = { id: "d1", collection: "directing_principles", title: "Draft pacing note", text: "pacing rhythm cut", source: "s", metadata: { topics: ["editing"], status: "draft", grade: "C" } };
    expect(eligible(draftNote, {})).toBe(false);
    expect(eligible(draftNote, { include_draft: true })).toBe(true);
    expect(eligible({ ...draftNote, metadata: { ...draftNote.metadata, status: "reviewed" } }, {})).toBe(true);
    const scoped = new ScopedRetriever(new KeywordRetriever([draftNote]), "editor");
    expect(await scoped.retrieve({ text: "pacing rhythm", collection: "directing_principles", k: 3 })).toEqual([]);
    // Unverified platform specs stay out for both agents.
    const spec: Doc = { id: "ig", collection: "platform_specs", title: "Instagram reels", text: "instagram 9:16", source: "blog", metadata: {} };
    expect(await new ScopedRetriever(new KeywordRetriever([spec]), "editor").retrieve({ text: "instagram", collection: "platform_specs", k: 3 })).toEqual([]);
  });

  it("filters by source quality when asked", () => {
    const note: Doc = { id: "n", collection: "directing_principles", title: "t", text: "cut", source: "s", metadata: { topics: ["editing"], grade: "C" } };
    expect(eligible(note, { min_grade: "B" })).toBe(false);
    expect(eligible({ ...note, metadata: { ...note.metadata, grade: "A" } }, { min_grade: "B" })).toBe(true);
    expect(eligible({ ...note, metadata: { topics: ["editing"] } }, { min_grade: "C" })).toBe(false);
  });

  it("reports missing knowledge instead of returning something unrelated", async () => {
    const editor = new ScopedRetriever(base, "editor");
    const spec = await editor.retrieveOrReport({ text: "tiktok safe area 9:16", collection: "platform_specs", k: 3 });
    expect(spec.hits).toEqual([]);
    expect(spec.missing).toMatch(/No knowledge for "tiktok safe area 9:16" in platform_specs: no eligible document matched/);
    const out = await editor.retrieveOrReport({ text: "claims", collection: "ad_playbooks", k: 3 });
    expect(out.missing).toMatch(/the editor may not read ad_playbooks/);
    const found = await editor.retrieveOrReport({ text: "j cut audio", collection: "directing_principles", k: 3 });
    expect(found.missing).toBeNull();
  });

  it("records every query, the filter applied and the ids returned, so a run can be replayed", async () => {
    const editor = new ScopedRetriever(base, "editor");
    const hits = await editor.retrieve({ text: "j cut audio leads", collection: "directing_principles", k: 3 });
    await editor.retrieve({ text: "claims", collection: "ad_playbooks", k: 3 });
    expect(editor.records).toHaveLength(2);
    expect(editor.records.every((r) => RetrievalRecord.safeParse(r).success)).toBe(true);
    expect(editor.records[0]).toMatchObject({ agent: "editor", collection: "directing_principles", query: "j cut audio leads", returned_ids: ids(hits) });
    expect(editor.records[0]!.filter["topics"]).toEqual([...AGENT_SCOPES.editor.topics]);
    expect(editor.records[1]).toMatchObject({ returned_ids: [], filter: { out_of_scope: true } });
    // Replaying the recorded filter on the plain retriever gives the same ids.
    const r = editor.records[0]!;
    expect(ids(await base.retrieve({ text: r.query, collection: "directing_principles", k: 3, filter: r.filter as never }))).toEqual(r.returned_ids);
  });
});
