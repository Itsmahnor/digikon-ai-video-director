import { describe, expect, it } from "vitest";
import { KeywordRetriever, ScopedRetriever, type Doc } from "@digikon/rag";
import { buildSkillQueries, selectSkills } from "./skill-queries.js";
import { categoryForBeat, closeMatches, inspirationFor, type TemplateInspirationPort } from "./inspiration.js";

const skill = (id: string, topic: string, text: string): Doc => ({ id, collection: "skills", title: id.replace(/-/g, " "), text, source: id, metadata: { status: "reviewed", skill_category: "all", skill_topic: topic, skill_scope: "director", topics: [topic, "all"] } });

describe("per-query skills", () => {
  const p = { objective: "drive demo bookings", audience: "agency owners", platform: "linkedin", brief: "We make scheduling software. Show an owner booking a client in ten seconds. End on a clear next step for the viewer to take today." };
  it("expands the brief into several distinct queries and uses the whole brief", () => {
    const q = buildSkillQueries("treatment", p);
    expect(q.length).toBeGreaterThanOrEqual(5);
    expect(new Set(q).size).toBe(q.length);
    expect(q.join(" ")).toContain("clear next step");
    expect(buildSkillQueries("storyboard", { ...p, hook: "Ten seconds to a booked client", beats: [{ purpose: "show the booking" }] }).join("|")).toContain("scene beat: show the booking");
  });
  it("fuses queries, pins must-haves first, limits one topic and gives excerpts beyond the top few", async () => {
    const docs = [
      skill("claims", "claims-safety", "approved facts only"), skill("hook-a", "hook", "hook opening seconds scroll"), skill("hook-b", "hook", "hook opening formula"), skill("hook-c", "hook", "hook opening pattern"),
      skill("cta", "cta-offer", "clear next step call to action offer"), skill("demo", "playbook", `scheduling software demo booking ${"long ".repeat(200)}`), skill("other", "audio", "music loudness"),
    ];
    const scoped = new ScopedRetriever(new KeywordRetriever(docs), "director", { allowDraft: false });
    const sel = await selectSkills(scoped, ["hook opening seconds", "clear next step offer", "scheduling software demo booking"], { category: "all", include_draft: false, pins: ["claims", "does-not-exist"], k: 5, max_per_topic: 1, full_text_for: 1 });
    expect(sel.hits[0]!.doc.id).toBe("claims");
    expect(sel.pinned).toEqual(["claims"]);
    expect(sel.hits.filter((h) => h.doc.metadata.skill_topic === "hook").length).toBe(1);
    expect(sel.queries.length).toBe(3);
    expect(sel.hits.some((h) => h.doc.id === "demo" && h.doc.text.endsWith("…"))).toBe(true);
  });
});

describe("template inspiration", () => {
  it("maps beats to template categories", () => {
    expect(categoryForBeat("open with a bold claim", 0, 5)).toBe("hook");
    expect(categoryForBeat("tell them to sign up today", 4, 5)).toBe("cta_end");
    expect(categoryForBeat("show the dashboard", 2, 5)).toBe("ui_demo");
    expect(categoryForBeat("hmm", 2, 5)).toBeUndefined();
  });
  const mk = (id: string, family: string) => ({ template_id: id, title: id, family, category: "hook", summary: "s", motion: "calm", type: "clean", energy: "low" });
  it("offers a different family per beat and flags a composition too close to a shown template", async () => {
    const calls: { exclude?: string[] }[] = [];
    const port: TemplateInspirationPort = {
      async suggest(q) { calls.push({ exclude: q.exclude_families }); const fam = ["f1", "f2", "f3"].find((f) => !(q.exclude_families ?? []).includes(f)); return fam ? [mk(`t-${fam}`, fam)] : []; },
      async compare(_c, ids) { return ids.map((id) => ({ template_id: id, similarity: id === "t-f1" ? 0.7 : 0.2 })); },
    };
    const r = await inspirationFor(port, "film", { tone: "warm", beats: [{ beat: "a", purpose: "open" }, { beat: "b", purpose: "show the app" }, { beat: "c", purpose: "sign up now" }] });
    expect(r.shown).toEqual(["t-f1", "t-f2", "t-f3"]);
    expect(calls[1]!.exclude).toEqual(["f1"]);
    expect(r.section).toContain("NOT a menu to fill in");
    const close = await closeMatches(port, [{ scene_id: "S01", visual: { block: "composition" } }, { scene_id: "S02", visual: { block: "ui_demo" } }], r.shown);
    expect(close).toEqual([{ scene_id: "S01", template_id: "t-f1", similarity: 0.7 }]);
  });
});

import { COMPOSITION_GUIDE } from "./nodes.js";
describe("composition preference", () => {
  it("tells the Director to compose by default and keep fixed blocks for the cases they fit", () => {
    expect(COMPOSITION_GUIDE).toContain("Compose by default");
    expect(COMPOSITION_GUIDE).toContain("only where it is clearly the right tool");
    expect(COMPOSITION_GUIDE).toContain("must never share one layout");
  });
});
