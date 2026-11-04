import { describe, expect, it } from "vitest";
import { AnswerRefused, Question, QuestionList, applyAnswer, completeness, emptyKit, getField, provide, questionsFor, skip, textQuestion, type KitField } from "./index.js";

const ids = (qs: { id: string }[]) => qs.map((q) => q.id);
const ans = (kit: ReturnType<typeof emptyKit>, question_id: string, value?: string | string[]) => applyAnswer(kit, { question_id, action: "answer", ...(value !== undefined ? { value } : {}) });
const sk = (kit: ReturnType<typeof emptyKit>, question_id: string) => applyAnswer(kit, { question_id, action: "skip" });

describe("typed questions: what is asked", () => {
  it("an empty kit asks the three required questions first, then the recommended ones, never the optional ones", () => {
    const qs = questionsFor(emptyKit("k"));
    expect(ids(qs).slice(0, 3)).toEqual(["q_goal", "q_audience", "q_platform"]);
    expect(qs.slice(0, 3).every((q) => q.level === "required" && !q.skippable)).toBe(true);
    expect(qs.slice(3).every((q) => q.level === "recommended" && q.skippable)).toBe(true);
    for (const optional of ["q_brand_fonts", "q_website", "q_guideline"]) expect(ids(qs)).not.toContain(optional);
    for (const q of qs) expect(Question.safeParse(q).success).toBe(true);
  });
  it("each question has the right kind: text, choice with options, or upload with what it accepts", () => {
    const by = Object.fromEntries(questionsFor(emptyKit("k", { video_category: "saas" })).map((q) => [q.id, q]));
    expect(by["q_goal"]).toMatchObject({ kind: "text", field: "goal" });
    expect(by["q_platform"]).toMatchObject({ kind: "choice" });
    expect(by["q_platform"]!.options.length).toBeGreaterThan(3);
    expect(by["q_brand_logo"]).toMatchObject({ kind: "upload", accept: "image", skippable: true });
    expect(by["q_assets"]).toMatchObject({ kind: "upload", accept: "any" });
    expect(by["q_website"]).toMatchObject({ kind: "text" }); // recommended for a SaaS video
  });
  it("asks only what is missing: provided and skipped fields are not asked again", () => {
    let k = emptyKit("k");
    k = provide(k, "goal", "Sign-ups"); k = provide(k, "audience", "Freelancers"); k = skip(k, "brand.logo");
    const qs = ids(questionsFor(k));
    expect(qs).not.toContain("q_goal"); expect(qs).not.toContain("q_audience"); expect(qs).not.toContain("q_brand_logo");
    expect(qs[0]).toBe("q_platform");
  });
  it("a skipped required field is asked again, because it cannot be skipped", () => {
    const k = skip(emptyKit("k"), "goal");
    expect(ids(questionsFor(k))[0]).toBe("q_goal");
  });
  it("nothing is left to ask once the required fields are provided and the rest answered or skipped", () => {
    let k = emptyKit("k");
    for (const f of ["goal", "audience", "platform"] as KitField[]) k = provide(k, f, "x");
    for (const f of ["brand.colours", "brand.logo", "brand.tone", "assets", "facts"] as KitField[]) k = skip(k, f);
    expect(questionsFor(k)).toEqual([]);
    expect(completeness(k).ready).toBe(true);
  });
  it("can be limited to the required questions", () => {
    expect(ids(questionsFor(emptyKit("k"), { levels: ["required"] }))).toEqual(["q_goal", "q_audience", "q_platform"]);
  });
});

describe("typed questions: applying answers", () => {
  it("text, choice and upload answers fill the right fields", () => {
    let k = emptyKit("k");
    k = ans(k, "q_goal", "  Get sign-ups  "); k = ans(k, "q_audience", "Freelancers"); k = ans(k, "q_platform", "LinkedIn");
    k = ans(k, "q_brand_logo", ["asset_logo"]); k = ans(k, "q_assets", ["asset_a", "asset_b"]);
    expect(getField(k, "goal").value).toBe("Get sign-ups");
    expect(getField(k, "platform")).toMatchObject({ value: "LinkedIn", source: "user" });
    expect(getField(k, "brand.logo")).toMatchObject({ value: "asset_logo", source: "upload" });
    expect(getField(k, "assets").value).toEqual(["asset_a", "asset_b"]);
    expect(completeness(k).ready).toBe(true);
  });
  it("colours are normalised and bad ones refused with the offending value named", () => {
    expect(getField(ans(emptyKit("k"), "q_brand_colours", "#C8501E, 0a7a5a #fff"), "brand.colours").value).toEqual(["#c8501e", "#0a7a5a", "#ffffff"]);
    expect(() => ans(emptyKit("k"), "q_brand_colours", "red #12")).toThrow(/red/);
  });
  it("facts typed one per line are the user's own and approved; fonts are split", () => {
    const k = ans(emptyKit("k"), "q_facts", "Beans are roasted weekly.\n\nShips in two days.");
    expect((getField(k, "facts").value as { origin: string; confirmed: boolean }[]).every((f) => f.origin === "user" && f.confirmed)).toBe(true);
    expect(getField(ans(emptyKit("k"), "q_brand_fonts", "Inter, Fraunces; Inter"), "brand.fonts").value).toEqual(["Inter", "Fraunces"]);
  });
  it("Skip works for optional and recommended questions and is refused for required ones", () => {
    expect(getField(sk(emptyKit("k"), "q_brand_logo"), "brand.logo").state).toBe("skipped");
    for (const id of ["q_goal", "q_audience", "q_platform"]) expect(() => sk(emptyKit("k"), id), id).toThrow(AnswerRefused);
  });
  it("an empty answer, an unknown question and an invalid value are refused, and the kit is unchanged", () => {
    const k = emptyKit("k");
    expect(() => ans(k, "q_goal", "   ")).toThrow(AnswerRefused);
    expect(() => ans(k, "q_goal")).toThrow(AnswerRefused);
    expect(() => ans(k, "q_goal", [])).toThrow(AnswerRefused);
    expect(() => ans(k, "q_nope", "x")).toThrow(AnswerRefused);
    expect(() => ans(k, "q_website", "not a url")).toThrow();
    expect(getField(k, "goal").state).toBe("missing");
  });
  it("an answer can be changed later", () => {
    let k = ans(emptyKit("k"), "q_platform", "TikTok");
    k = ans(k, "q_platform", "YouTube");
    expect(getField(k, "platform").value).toBe("YouTube");
  });
});

describe("typed questions: older free-text questions", () => {
  it("plain strings become text questions tied to no field, and typed questions pass through", () => {
    const list = QuestionList.parse(["Which product is this for?", questionsFor(emptyKit("k"))[0]]);
    expect(list[0]).toMatchObject({ id: "q_free_1", field: null, kind: "text", prompt: "Which product is this for?", skippable: false });
    expect(list[1]!.id).toBe("q_goal");
    expect(QuestionList.parse([])).toEqual([]);
    expect(textQuestion("   ").prompt).toBe("Can you tell me more?");
  });
  it("a free-text question cannot be answered into the kit", () => {
    expect(() => ans(emptyKit("k"), "q_free_1", "x")).toThrow(AnswerRefused);
  });
});
