import { describe, expect, it } from "vitest";
import { SkillRecord } from "@digikon/contracts";
import { MemoryDataStore, MissingLicenceError, type SkillRow, type SkillSourceRow } from "./store.js";

const src = (over: Partial<SkillSourceRow> = {}): SkillSourceRow => ({ id: "s1", repo: "acme/skills", url: "https://example.test/acme/skills", licence: "MIT", attribution: null, checked_on: "2026-11-04", ...over });
const skill = (id: string, over: Partial<SkillRow> = {}): SkillRow => ({ id, category: "saas", topic: "hook", scope: "both", funnel_stage: "awareness", platform: ["tiktok"], grade: "a", status: "approved", title: id, body: "text", content_hash: "h", source_id: "s1", ...over });

describe("skills tables: nothing is stored without a licence", () => {
  it("rejects a source with no licence, and a skill whose source is unknown", async () => {
    const s = new MemoryDataStore();
    await expect(s.upsertSkillSource(src({ licence: "  " }))).rejects.toBeInstanceOf(MissingLicenceError);
    await expect(s.upsertSkill(skill("a"))).rejects.toBeInstanceOf(MissingLicenceError);
    expect(await s.listSkills()).toEqual([]);
  });
  it("rejects a library asset with no licence or source", async () => {
    const s = new MemoryDataStore();
    await expect(s.upsertLibraryAsset({ id: "f", kind: "font", file: "f.ttf", licence: "", source: "x" })).rejects.toBeInstanceOf(MissingLicenceError);
    await expect(s.upsertLibraryAsset({ id: "f", kind: "font", file: "f.ttf", licence: "OFL-1.1", source: "" })).rejects.toBeInstanceOf(MissingLicenceError);
    await s.upsertLibraryAsset({ id: "f", kind: "font", file: "f.ttf", licence: "OFL-1.1", source: "fonts.example" });
    expect((await s.listLibraryAssets("font")).length).toBe(1);
  });
  it("the contract refuses a SkillRecord with no licence", () => {
    const ok = { id: "a", title: "A", category: "saas", topic: "hook", funnel_stage: "awareness", grade: "a", body: "x", source: { repo: "r", url: "u", licence: "MIT", checked_on: "2026-11-04" } };
    expect(SkillRecord.safeParse(ok).success).toBe(true);
    expect(SkillRecord.safeParse({ ...ok, source: { ...ok.source, licence: "" } }).success).toBe(false);
    expect(SkillRecord.safeParse({ ...ok, source: undefined }).success).toBe(false);
    expect(SkillRecord.safeParse({ ...ok, category: "hook" }).success).toBe(false); // a concept is not a video category
  });
  it("stores, filters and searches licensed skills", async () => {
    const s = new MemoryDataStore();
    await s.upsertSkillSource(src());
    await s.upsertSkill(skill("a")); await s.upsertSkill(skill("b", { category: "ecommerce", platform: ["youtube"] }));
    expect((await s.listSkills({ category: "saas" })).map((x) => x.id)).toEqual(["a"]);
    expect((await s.listSkills({ platform: "youtube" })).map((x) => x.id)).toEqual(["b"]);
    await s.upsertSkillEmbedding({ skill_id: "a", model: "m", model_version: "1", vector: [1, 0] });
    await s.upsertSkillEmbedding({ skill_id: "b", model: "m", model_version: "1", vector: [0, 1] });
    expect((await s.nearestSkills({ model: "m", model_version: "1", vector: [1, 0], k: 1 }))[0]!.skill_id).toBe("a");
  });
});
