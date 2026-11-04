import { describe, expect, it } from "vitest";
import { completeness, emptyKit, provide, skip, type KitField, type ProjectKit } from "@digikon/contracts";

// The wizard's logic lives in a plain browser module with no DOM at import time, so it is tested here in Node.
const W = (await import(new URL("../public/wizard.js", import.meta.url).href)) as any;
const { STEPS, stepStatus, canSkipStep, parseColours, parseList, fileProblem, composePrompt, factsFromKit, firstOpenStep, GUIDELINE_MAX_BYTES } = W;

const step = (id: string) => STEPS.find((s: any) => s.id === id);
const kitWith = (fields: Partial<Record<KitField, unknown>>, category: ProjectKit["video_category"] = null) => Object.entries(fields).reduce((k, [f, v]) => provide(k, f as KitField, v), emptyKit("k", { video_category: category }));
const REQ = { goal: "Get sign-ups", audience: "Freelancers", platform: "LinkedIn" } as const;
const file = (name: string, size = 1000) => ({ name, size });

describe("wizard: steps and skipping", () => {
  it("has the six steps in order", () => expect(STEPS.map((s: any) => s.id)).toEqual(["goal", "audience", "platform", "brand", "website", "assets"]));
  it("goal, audience and platform cannot be skipped; brand, website and assets can", () => {
    const c = completeness(emptyKit("k"));
    for (const id of ["goal", "audience", "platform"]) expect(canSkipStep(step(id), c), id).toBe(false);
    for (const id of ["brand", "website", "assets"]) expect(canSkipStep(step(id), c), id).toBe(true);
  });
  it("a step is open, partial, done or skipped from the kit alone", () => {
    let k = emptyKit("k");
    expect(stepStatus(step("brand"), completeness(k))).toBe("open");
    k = provide(k, "brand.colours", ["#112233"]);
    expect(stepStatus(step("brand"), completeness(k))).toBe("partial");
    for (const f of ["brand.fonts", "brand.logo", "brand.tone"] as KitField[]) k = skip(k, f);
    expect(stepStatus(step("brand"), completeness(k))).toBe("skipped"); // some provided, the rest skipped
    k = ["brand.fonts", "brand.logo", "brand.tone"].reduce((acc, f) => provide(acc, f as KitField, f === "brand.fonts" ? ["Inter"] : "x"), k);
    expect(stepStatus(step("brand"), completeness(k))).toBe("done");
  });
  it("skipping every field of an optional step marks it skipped (no logo, no website, no files)", () => {
    let k = emptyKit("k");
    for (const f of ["brand.colours", "brand.fonts", "brand.logo", "brand.tone", "website", "guideline", "assets"] as KitField[]) k = skip(k, f);
    const c = completeness(k);
    for (const id of ["brand", "website", "assets"]) expect(stepStatus(step(id), c), id).toBe("skipped");
    expect(c.ready).toBe(false); // the required three are still open
  });
  it("the first open step follows the answers, and ends on the last step when everything is answered or skipped", () => {
    expect(firstOpenStep(completeness(emptyKit("k")))).toBe(0);
    expect(firstOpenStep(completeness(kitWith({ goal: "x" })))).toBe(1);
    expect(firstOpenStep(completeness(kitWith(REQ)))).toBe(3);
    let k = kitWith(REQ);
    for (const f of ["brand.colours", "brand.fonts", "brand.logo", "brand.tone", "website", "guideline", "assets"] as KitField[]) k = skip(k, f);
    expect(firstOpenStep(completeness(k))).toBe(STEPS.length - 1);
  });
});

describe("wizard: validating what the user enters", () => {
  it("parses hex colours, expands short ones, removes duplicates and reports what it could not read", () => {
    expect(parseColours("#C8501E, 0a7a5a #fff #C8501E")).toEqual({ colours: ["#c8501e", "#0a7a5a", "#ffffff"], bad: [] });
    expect(parseColours("red #12 #gggggg #112233")).toEqual({ colours: ["#112233"], bad: ["red", "#12", "#gggggg"] });
    expect(parseColours("")).toEqual({ colours: [], bad: [] });
  });
  it("parses lists", () => expect(parseList("Inter, Fraunces\n inter;Inter")).toEqual(["Inter", "Fraunces", "inter"]));
  it("refuses the wrong type or a huge guideline file, with a plain reason", () => {
    expect(fileProblem(file("brand.pdf"), "guideline")).toBeNull();
    expect(fileProblem(file("BRAND.PDF"), "guideline")).toBeNull();
    for (const n of ["brand.docx", "logo.png", "notes.txt", "brand"]) expect(fileProblem(file(n), "guideline"), n).toContain("not a PDF");
    expect(fileProblem(file("brand.pdf", GUIDELINE_MAX_BYTES + 1), "guideline")).toContain("at most 20 MB");
  });
  it("refuses a logo that is not a picture, is empty or is huge", () => {
    for (const n of ["logo.png", "logo.JPG", "logo.webp", "logo.svg"]) expect(fileProblem(file(n), "logo"), n).toBeNull();
    expect(fileProblem(file("logo.pdf"), "logo")).toContain("not a picture");
    expect(fileProblem(file("logo.png", 0), "logo")).toContain("empty");
    expect(fileProblem(file("logo.png", 26 * 1048576), "logo")).toContain("at most 25 MB");
  });
});

describe("wizard: what it hands to the request", () => {
  it("builds the request text from provided answers only, and invents nothing", () => {
    expect(composePrompt(emptyKit("k"))).toBe("");
    expect(composePrompt(kitWith({ goal: "Get sign-ups." }))).toBe("Get sign-ups.");
    const k = kitWith({ ...REQ, "brand.colours": ["#c8501e"], "brand.tone": "warm" });
    expect(composePrompt(k)).toBe("Get sign-ups. Audience: Freelancers. Platform: LinkedIn. Brand: colours #c8501e; tone warm.");
    expect(composePrompt(skip(k, "brand.colours"))).not.toContain("colours");
  });
  it("going back and changing an answer replaces it, and the rest is kept", () => {
    let k = kitWith(REQ);
    k = provide(k, "platform", "TikTok");
    expect(composePrompt(k)).toContain("Platform: TikTok.");
    expect(composePrompt(k)).toContain("Audience: Freelancers.");
    expect(composePrompt(k)).not.toContain("LinkedIn");
    expect(completeness(k).ready).toBe(true);
  });
  it("passes on only facts the user typed or confirmed", () => {
    const facts = [
      { fact_id: "F01", text: "typed", origin: "user", source: "", confirmed: true },
      { fact_id: "F02", text: "found, not confirmed", origin: "website", source: "x", confirmed: false },
      { fact_id: "F03", text: "found and confirmed", origin: "guideline", source: "x", confirmed: true },
    ];
    expect(factsFromKit(provide(emptyKit("k"), "facts", facts))).toEqual(["typed", "found and confirmed"]);
    expect(factsFromKit(emptyKit("k"))).toEqual([]);
  });
});
