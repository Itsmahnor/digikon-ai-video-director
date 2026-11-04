import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDataStore } from "./db/store.js";
import { HashEmbedder } from "./embeddings.js";
import { checkLicence, detectLicence, importSkills, parseSkillFile } from "./skills.js";

const MIT_TEXT = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy";
const skillMd = (id: string, body: string, extra = "") => `---\nid: ${id}\ntitle: ${id.replace(/-/g, " ")}\ncategory: saas\ntopic: hook\nfunnel_stage: awareness\nplatform: tiktok, reels\ngrade: a\nstatus: approved\n${extra}---\n${body}\n`;

function folder(manifest: object | null, license: string | null, skills: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  if (manifest) writeFileSync(join(dir, "skills-source.json"), JSON.stringify(manifest));
  if (license) writeFileSync(join(dir, "LICENSE"), license);
  mkdirSync(join(dir, "skills"));
  for (const [n, t] of Object.entries(skills)) writeFileSync(join(dir, "skills", `${n}.md`), t);
  return dir;
}
const manifest = { repo: "acme/skills", url: "https://example.test/acme/skills", licence: "MIT" };

describe("licence gate (B0)", () => {
  it("allows the allow-list, requires attribution for CC-BY, and refuses everything else with a reason", () => {
    expect(checkLicence("MIT", null, null).ok).toBe(true);
    expect(checkLicence("Apache-2.0", null, null).ok).toBe(true);
    expect(checkLicence("CC-BY-4.0", null, null)).toMatchObject({ ok: false, attribution_required: true });
    expect(checkLicence("CC-BY-4.0", null, "Jane Doe, CC BY 4.0")).toMatchObject({ ok: true, attribution_required: true });
    expect(checkLicence("GPL-3.0", null, null)).toMatchObject({ ok: false });
    expect(checkLicence("CC-BY-NC-4.0", null, null).ok).toBe(false);
    expect(checkLicence(null, null, null).reason).toMatch(/no licence/);
  });
  it("reads a LICENSE file, and flags a declared licence that disagrees with it", () => {
    expect(detectLicence(MIT_TEXT)).toBe("MIT");
    expect(detectLicence("Creative Commons Attribution-NonCommercial 4.0")).toBe("CC-BY-restricted");
    expect(checkLicence(null, MIT_TEXT, null)).toMatchObject({ ok: true, licence: "MIT" });
    expect(checkLicence("Apache-2.0", MIT_TEXT, null).ok).toBe(false);
  });
  it("parses frontmatter", () => {
    expect(parseSkillFile(skillMd("a-b", "hello"))).toMatchObject({ meta: { id: "a-b", platform: ["tiktok", "reels"] }, body: "hello" });
    expect(parseSkillFile("no frontmatter")).toBeNull();
  });
});

describe("importSkills", () => {
  const emb = new HashEmbedder();
  it("stores records with their source and licence, and a repeat import changes nothing", async () => {
    const dir = folder(manifest, MIT_TEXT, { a: skillMd("open-on-a-question", "Start with a question the viewer cannot ignore."), b: skillMd("show-the-result-first", "Lead with the end state, then rewind to how it was reached.") });
    const store = new MemoryDataStore();
    const first = await importSkills(store, emb, dir, { today: "2026-11-04" });
    expect(first.added.sort()).toEqual(["open-on-a-question", "show-the-result-first"]);
    const row = (await store.getSkill("open-on-a-question"))!;
    expect((await store.getSkillSource(row.source_id))!.licence).toBe("MIT");
    const second = await importSkills(store, emb, dir, { today: "2026-12-01" });
    expect(second).toMatchObject({ added: [], updated: [], duplicates: [] });
    expect(second.unchanged.length).toBe(2);
    expect(await store.getSkill("open-on-a-question")).toEqual(row);
  });
  it("refuses a source with a disallowed or missing licence and stores nothing", async () => {
    for (const m of [{ ...manifest, licence: "GPL-3.0" }, { repo: "x/y", url: "u" }]) {
      const store = new MemoryDataStore();
      const r = await importSkills(store, emb, folder(m, null, { a: skillMd("one-skill", "text") }));
      expect(r.rejected[0]!.problems[0]).toMatch(/licence gate/);
      expect(await store.listSkills()).toEqual([]);
    }
  });
  it("drops near-duplicates and reports invalid files", async () => {
    const text = "Open on a question the viewer cannot ignore, then answer it in the next beat.";
    const dir = folder(manifest, MIT_TEXT, { a: skillMd("question-open", text), b: skillMd("question-open", "dup id"), c: skillMd("question-open-copy", text), d: "---\nid: Bad Id\n---\nx" });
    const store = new MemoryDataStore();
    const r = await importSkills(store, emb, dir);
    expect(r.added).toEqual(["question-open"]);
    expect(r.duplicates.map((d) => d.id)).toEqual(["question-open-copy"]);
    expect(r.rejected.length).toBe(2);
  });
});
