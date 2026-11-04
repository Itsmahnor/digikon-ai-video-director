import { describe, expect, it } from "vitest";
import { KIT_FIELDS, KIT_VERSION, ProjectKit, Project, approvedFacts, confirmField, emptyKit, getField, provide, skip, unconfirmed, unset, type KitField } from "./index.js";

const SAMPLE: Record<KitField, unknown> = {
  goal: "Get trial sign-ups", audience: "Freelancers", platform: "LinkedIn", "brand.colours": ["#1a2b3c", "#ffffff"], "brand.fonts": ["Inter"], "brand.logo": "asset_logo",
  "brand.tone": "warm, direct", website: "https://example.com", guideline: "asset_guideline", assets: ["asset_a", "asset_b"],
  facts: [{ fact_id: "F01", text: "Beans are roasted weekly", origin: "user", source: "", confirmed: true }],
};
const kit = () => emptyKit("k1");

describe("project kit: every field has three states", () => {
  it("a new kit has every field missing, no values, and parses", () => {
    const k = kit();
    expect(k).toMatchObject({ format: "digikon.project-kit", version: KIT_VERSION, project_id: null, brand_id: null, video_category: null });
    for (const f of KIT_FIELDS) expect(getField(k, f), f).toMatchObject({ state: "missing", value: null, source: null, confirmed: false });
    expect(ProjectKit.safeParse(k).success).toBe(true);
  });
  for (const f of KIT_FIELDS) {
    it(`${f}: provided, skipped, missing and back again`, () => {
      const p = provide(kit(), f, SAMPLE[f]);
      expect(getField(p, f)).toMatchObject({ state: "provided", source: "user", confirmed: true });
      expect(getField(p, f).value).toEqual(SAMPLE[f]);
      const s = skip(p, f); // skipping replaces a provided value: the value is gone
      expect(getField(s, f)).toMatchObject({ state: "skipped", value: null, source: null });
      const m = unset(s, f);
      expect(getField(m, f)).toMatchObject({ state: "missing", value: null });
      // skipping an untouched field, too
      expect(getField(skip(kit(), f), f).state).toBe("skipped");
      // other fields are untouched
      for (const other of KIT_FIELDS.filter((x) => x !== f)) expect(getField(p, other).state, other).toBe("missing");
    });
    it(`${f}: a half-set field cannot be built`, () => {
      const base = structuredClone(kit()) as any;
      const set = (v: unknown) => { const c = structuredClone(base); if (f.startsWith("brand.")) c.brand[f.slice(6)] = v; else c[f] = v; return ProjectKit.safeParse(c); };
      expect(set({ state: "provided", value: null, source: "user" }).success, "provided with no value").toBe(false);
      expect(set({ state: "provided", value: SAMPLE[f] }).success, "provided with no source").toBe(false);
      expect(set({ state: "skipped", value: SAMPLE[f], source: null }).success, "skipped with a value").toBe(false);
      expect(set({ state: "missing", value: SAMPLE[f], source: null }).success, "missing with a value").toBe(false);
      expect(set({ state: "skipped", value: null, source: "user" }).success, "skipped with a source").toBe(false);
    });
  }
  it("rejects empty text and empty lists as provided values", () => {
    for (const [f, v] of [["goal", "   "], ["brand.colours", []], ["assets", []], ["facts", []]] as [KitField, unknown][]) expect(() => provide(kit(), f, v), f).toThrow();
  });
  it("colours must be lower-case #rrggbb; at most 12", () => {
    expect(() => provide(kit(), "brand.colours", ["red"])).toThrow();
    expect(() => provide(kit(), "brand.colours", ["#FFF"])).toThrow();
    expect(() => provide(kit(), "brand.colours", ["#ABCDEF"])).toThrow();
    expect(() => provide(kit(), "brand.colours", Array.from({ length: 13 }, (_, i) => `#0000${(i + 10).toString(16)}`))).toThrow();
    expect(getField(provide(kit(), "brand.colours", ["#abcdef"]), "brand.colours").state).toBe("provided");
  });
  it("the website must be a URL", () => {
    expect(() => provide(kit(), "website", "not a url")).toThrow();
    expect(getField(provide(kit(), "website", "https://example.com/about"), "website").state).toBe("provided");
  });
  it("is versioned and strict: another version or an unknown key is refused", () => {
    expect(ProjectKit.safeParse({ ...kit(), version: 2 }).success).toBe(false);
    expect(ProjectKit.safeParse({ ...kit(), surprise: 1 }).success).toBe(false);
    expect(ProjectKit.safeParse({ ...kit(), video_category: "gaming" }).success).toBe(false);
  });
  it("round-trips through JSON unchanged", () => {
    let k = provide(kit(), "goal", "x"); k = skip(k, "website"); k = provide(k, "brand.colours", ["#112233"]);
    expect(ProjectKit.parse(JSON.parse(JSON.stringify(k)))).toEqual(k);
  });
});

describe("project kit: values that were not typed by the user are not approved until confirmed", () => {
  it("a value from a website or a guideline starts unconfirmed and shows up for confirmation", () => {
    let k = provide(kit(), "brand.colours", ["#112233"], "website");
    k = provide(k, "brand.fonts", ["Inter"], "guideline");
    expect(getField(k, "brand.colours")).toMatchObject({ source: "website", confirmed: false });
    expect(unconfirmed(k).map((u) => `${u.field}:${u.origin}`).sort()).toEqual(["brand.colours:website", "brand.fonts:guideline"]);
    k = confirmField(k, "brand.colours");
    expect(unconfirmed(k).map((u) => u.field)).toEqual(["brand.fonts"]);
  });
  it("only user-entered or confirmed facts are approved brand facts", () => {
    const facts = [
      { fact_id: "F01", text: "typed by the user", origin: "user", source: "", confirmed: true },
      { fact_id: "F02", text: "found on the website", origin: "website", source: "https://example.com", confirmed: false },
      { fact_id: "F03", text: "found and confirmed", origin: "website", source: "https://example.com", confirmed: true },
      { fact_id: "F04", text: "from the guideline, unconfirmed", origin: "guideline", source: "brand.pdf", confirmed: false },
    ];
    const k = provide(kit(), "facts", facts, "user");
    expect(approvedFacts(k).map((f) => f.fact_id)).toEqual(["F01", "F03"]);
    expect(approvedFacts(k).find((f) => f.fact_id === "F03")!.source).toContain("website");
    expect(approvedFacts(kit())).toEqual([]);
    expect(approvedFacts(skip(kit(), "facts"))).toEqual([]);
    expect(unconfirmed(k).some((u) => u.field === "facts")).toBe(true);
  });
  it("confirming a field with no value is an error", () => {
    expect(() => confirmField(kit(), "goal")).toThrow();
    expect(() => confirmField(skip(kit(), "goal"), "goal")).toThrow();
  });
});

describe("project kit links to the project", () => {
  it("carries the saved brand id and the video category, matching the Project fields", () => {
    const k = emptyKit("k2", { project_id: "proj_1", brand_id: "brand_acme", video_category: "ecommerce" });
    expect(k).toMatchObject({ project_id: "proj_1", brand_id: "brand_acme", video_category: "ecommerce" });
    const p = Project.parse({ project_id: k.project_id, owner_id: "u", brief: "b", objective: "o", audience: "a", platform: "p", aspect_ratio: "9:16", target_duration: 10, brand_id: k.brand_id, video_category: k.video_category });
    expect(p.brand_id).toBe("brand_acme");
    expect(p.video_category).toBe("ecommerce");
  });
});
