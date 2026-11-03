import { describe, expect, it } from "vitest";
import { KeywordRetriever } from "./keyword.js";
import { recipeDocs } from "./docs.js";

const recipe = (id: string) => ({ recipe_id: id, title: "fade to black", purpose: "fade to black before the final scene", intents: ["fade to black"], type: "transition", constraints: { energy: "low", min_duration_s: 1, max_duration_s: 2 }, status: "approved", compatibility: { aspect_ratios: ["16:9"], media_types: ["image"] }, source: { origin: "o", license: "l" }, version: "1" }) as never;
const q = { text: "fade to black before the final scene", collection: "shot_recipes" as const, k: 5, filter: { include_draft: true } };
const scores = async (opts: Parameters<typeof recipeDocs>[1]) => {
  const hits = await new KeywordRetriever(recipeDocs([recipe("alpha"), recipe("beta"), recipe("gamma")], opts)).retrieve(q);
  return Object.fromEntries(hits.map((h) => [h.doc.id, h.score]));
};

describe("the ranking boost follows validation once validation is known", () => {
  it("without a validated set, every implemented recipe is boosted over an unimplemented one (unchanged behaviour)", async () => {
    const s = await scores({ implemented: new Set(["alpha", "beta"]) });
    expect(s["alpha"]).toBeCloseTo(s["beta"]!);
    expect(s["alpha"]).toBeGreaterThan(s["gamma"]!);
  });
  it("with a validated set, only validated recipes are boosted; implemented-but-unproven rank level with, not above, nothing", async () => {
    const s = await scores({ implemented: new Set(["alpha", "beta"]), validated: new Set(["alpha"]) });
    expect(s["alpha"]).toBeGreaterThan(s["beta"]!);
    expect(s["beta"]).toBeLessThan(s["alpha"]!);
  });
  it("metadata records validation only when it is known, and never for an unimplemented recipe", () => {
    const d = (o: Parameters<typeof recipeDocs>[1]) => recipeDocs([recipe("alpha"), recipe("gamma")], o).map((x) => x.metadata.recipe_validated);
    expect(d({ implemented: new Set(["alpha"]) })).toEqual([undefined, undefined]);
    expect(d({ implemented: new Set(["alpha"]), validated: new Set(["alpha", "gamma"]) })).toEqual([true, false]);
  });
  it("implemented_only still keeps every implemented recipe, validated or not", async () => {
    const hits = await new KeywordRetriever(recipeDocs([recipe("alpha"), recipe("beta"), recipe("gamma")], { implemented: new Set(["alpha", "beta"]), validated: new Set(["alpha"]) })).retrieve({ ...q, filter: { include_draft: true, implemented_only: true } });
    expect(hits.map((h) => h.doc.id).sort()).toEqual(["alpha", "beta"]);
  });
});
