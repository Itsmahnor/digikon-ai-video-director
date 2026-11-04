import { describe, expect, it } from "vitest";
import { KIT_FIELDS, completeness, emptyKit, levelOf, provide, skip, type KitField, type ProjectKit } from "./index.js";

const fill = (k: ProjectKit, fields: KitField[]) => fields.reduce((acc, f) => provide(acc, f, f === "brand.colours" ? ["#112233"] : f === "brand.fonts" ? ["Inter"] : f === "assets" ? ["a1"] : f === "facts" ? [{ fact_id: "F01", text: "t", origin: "user", source: "", confirmed: true }] : f === "website" ? "https://example.com" : "text"), k);
const REQUIRED: KitField[] = ["goal", "audience", "platform"];

describe("kit completeness", () => {
  it("goal, audience and platform are required in every category; required fields cannot be skipped", () => {
    for (const cat of [null, "saas", "ecommerce", "general-promo"] as const) {
      const c = completeness(emptyKit("k", { video_category: cat }));
      for (const f of REQUIRED) { const i = c.items.find((x) => x.field === f)!; expect([i.level, i.can_skip, i.satisfied], `${cat}/${f}`).toEqual(["required", false, false]); }
    }
  });
  it("an empty kit is not ready and asks for the required fields first, then the recommended ones, never the optional", () => {
    const c = completeness(emptyKit("k"));
    expect(c.ready).toBe(false);
    expect(c.next.slice(0, 3)).toEqual(REQUIRED);
    expect(c.next.slice(3)).toEqual(["brand.colours", "brand.logo", "brand.tone", "assets", "facts"]);
    for (const f of ["brand.fonts", "website", "guideline"] as KitField[]) expect(c.next).not.toContain(f);
  });
  it("is ready once the three required fields are provided, whatever else was skipped or left open", () => {
    let k = fill(emptyKit("k"), REQUIRED);
    expect(completeness(k).ready).toBe(true);
    for (const f of KIT_FIELDS.filter((x) => !REQUIRED.includes(x))) k = skip(k, f);
    const c = completeness(k);
    expect(c.ready).toBe(true);
    expect(c.next).toEqual([]); // skipped means decided: nothing left to ask
    expect(c.items.filter((i) => i.level !== "required").every((i) => i.satisfied)).toBe(true);
  });
  it("a skipped required field is not satisfied and keeps the kit not ready", () => {
    const k = skip(fill(emptyKit("k"), ["goal", "audience"]), "platform");
    const c = completeness(k);
    expect(c.ready).toBe(false);
    expect(c.items.find((i) => i.field === "platform")).toMatchObject({ state: "skipped", satisfied: false });
    expect(c.next).toContain("platform");
  });
  it("the video category changes what is recommended", () => {
    expect(levelOf("website", null)).toBe("optional");
    expect(levelOf("website", "saas")).toBe("recommended");
    expect(levelOf("website", "general-promo")).toBe("optional");
    expect(levelOf("assets", "ecommerce")).toBe("recommended");
    expect(completeness(emptyKit("k", { video_category: "saas" })).next).toContain("website");
    expect(completeness(emptyKit("k", { video_category: "general-promo" })).next).not.toContain("website");
  });
  it("flags values from a website or file that still need the user's confirmation", () => {
    let k = fill(emptyKit("k"), REQUIRED);
    k = provide(k, "brand.colours", ["#112233"], "website");
    expect(completeness(k).items.find((i) => i.field === "brand.colours")).toMatchObject({ state: "provided", needs_confirmation: true });
    expect(completeness(fill(emptyKit("k"), ["brand.colours"])).items.find((i) => i.field === "brand.colours")!.needs_confirmation).toBe(false);
  });
  it("counts provided, skipped and missing per level, and is deterministic", () => {
    let k = fill(emptyKit("k", { video_category: "ecommerce" }), ["goal", "assets"]);
    k = skip(k, "brand.logo");
    const c = completeness(k);
    expect(c.counts.required).toEqual({ provided: 1, skipped: 0, missing: 2 });
    expect(c.counts.recommended.provided + c.counts.recommended.skipped + c.counts.recommended.missing).toBe(KIT_FIELDS.filter((f) => levelOf(f, "ecommerce") === "recommended").length);
    expect(completeness(k)).toEqual(c);
  });
});
