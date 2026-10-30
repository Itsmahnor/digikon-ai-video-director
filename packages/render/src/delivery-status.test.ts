import { describe, expect, it } from "vitest";
import { decideDelivery, type DecisionInput } from "./delivery-status.js";

const scene = (id: string, over: Partial<DecisionInput["scenes"][number]> = {}) => ({ scene_id: id, rendered: true, engine_content_checked: true, end_to_end_checked: true, unmet: [] as string[], ...over });
const good = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  file_valid: true, scenes: [scene("S01"), scene("S02")], omitted: [], transitions_not_applied: [], audio_required: false,
  visual: { critical_major: [], not_checked: [] }, plan_problems: [], recipes: { draft: false, preview_only: false, blockers: [] }, ...over,
});

describe("the one delivery decision", () => {
  it("is final only when all six criteria are met and the file is valid", () => {
    const d = decideDelivery(good());
    expect(d).toMatchObject({ status: "final_delivery_ready", final: true, complete: true, blockers: [] });
    expect(d.criteria.map((c) => c.id)).toEqual(["scene_render", "required_operations", "content_validation", "visual_validation", "plan_compliance", "recipe_review"]);
    expect(d.criteria.every((c) => c.ok === true)).toBe(true);
  });
  it("is a complete preview, never final, while recipes are drafts", () => {
    const d = decideDelivery(good({ recipes: { draft: true, preview_only: true, blockers: [] } }));
    expect(d).toMatchObject({ status: "complete_preview", final: false, complete: true });
    expect(d.blockers.join(" ")).toContain("still a draft");
    expect(d.label).toMatch(/^COMPLETE PREVIEW/);
  });
  it("is an incomplete preview when a scene was not rendered, whatever else passed", () => {
    const d = decideDelivery(good({ scenes: [scene("S01"), scene("S02", { rendered: false, engine_content_checked: false })] }));
    expect(d).toMatchObject({ status: "incomplete_preview", final: false, complete: false });
    expect(d.blockers.join(" ")).toMatch(/S02 was not rendered/);
    expect(d.label).toMatch(/^INCOMPLETE PREVIEW/);
  });
  it("is incomplete when an approved transition or operation is missing, each named once", () => {
    const d = decideDelivery(good({ omitted: [{ operation_id: "E07", scene_id: "S04", recipe_id: "scene-composition", reason: "x" }], transitions_not_applied: [{ after_scene: "S02", template: "ffmpeg/match-cut", reason: "the pictures do not match" }] }));
    expect(d.status).toBe("incomplete_preview");
    expect(d.criteria.find((c) => c.id === "required_operations")!.ok).toBe(false);
    expect(d.blockers.filter((b) => b.includes("match-cut"))).toHaveLength(1);
  });
  it("does not call a film final when visual validation did not run, and says so", () => {
    const d = decideDelivery(good({ visual: null }));
    expect(d.status).toBe("complete_preview");
    expect(d.criteria.find((c) => c.id === "visual_validation")).toMatchObject({ ok: null });
    expect(d.blockers.join(" ")).toMatch(/visual validation has not been run/);
  });
  it("a critical visual problem or an unverified scene keeps a complete film from final", () => {
    expect(decideDelivery(good({ visual: { critical_major: ["visual S03: text clipped"], not_checked: [] } })).status).toBe("complete_preview");
    expect(decideDelivery(good({ scenes: [scene("S01"), scene("S02", { engine_content_checked: false })] })).criteria.find((c) => c.id === "content_validation")!.ok).toBe(false);
  });
  it("a plan difference makes it incomplete: a technically valid MP4 is not the approved video", () => {
    const d = decideDelivery(good({ plan_problems: ["S03: planned 6s for 5s, rendered 6s for 6s"] }));
    expect(d.status).toBe("incomplete_preview");
    expect(d.file_valid).toBe(true);
  });
  it("a file that failed technical validation is never final", () => {
    const d = decideDelivery(good({ file_valid: false }));
    expect(d.final).toBe(false);
    expect(d.blockers[0]).toMatch(/technical validation/);
  });
  it("a production render with open production blockers stays blocked, and lists them", () => {
    const d = decideDelivery(good({ recipes: { draft: false, preview_only: false, blockers: ["E01: recipe is not reviewed"] } }));
    expect(d.status).toBe("complete_preview");
    expect(d.blockers).toContain("E01: recipe is not reviewed");
  });
});
