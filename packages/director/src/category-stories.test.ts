import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Asset, BrandFact, Project } from "@digikon/contracts";
import { DemoClient } from "./demo-client.js";
import { buildDirectorGraph } from "./graph.js";
import { cfg, deps } from "./fixtures.js";

const goldenBriefsPath = resolve(import.meta.dirname, "../../../evals/golden-briefs.json");
const goldenBriefs = JSON.parse(readFileSync(goldenBriefsPath, "utf8")) as {
  id: string;
  project: {
    brief: string;
    objective: string;
    audience: string;
    platform: string;
    aspect_ratio: "16:9" | "9:16" | "1:1";
    target_duration: number;
    video_category?: "saas" | "ecommerce" | "general-promo";
  };
  assets: unknown[];
  facts: string[];
}[];

describe("D3: category-appropriate stories from chosen video types", () => {
  const saasCase = goldenBriefs.find((b) => b.id === "saas-youtube-wide")!;
  const ecomCase = goldenBriefs.find((b) => b.id === "shoes-tiktok-with-video")!;
  const promoCase = goldenBriefs.find((b) => b.id === "coffee-reels-graphics")!;

  it("found all three category golden briefs in evals/golden-briefs.json", () => {
    expect(saasCase).toBeDefined();
    expect(ecomCase).toBeDefined();
    expect(promoCase).toBeDefined();
  });

  it("produces distinct, category-appropriate treatments and storyboards for all three categories", async () => {
    const runCase = async (c: typeof saasCase) => {
      const llm = new DemoClient({ creative: true });
      const graph = buildDirectorGraph(deps(llm as never));
      const proj = Project.parse({
        project_id: `proj_${c.id}`,
        brand_id: "brand_test",
        owner_id: "user_test",
        brief: c.project.brief,
        objective: c.project.objective,
        audience: c.project.audience,
        platform: c.project.platform as any,
        aspect_ratio: c.project.aspect_ratio,
        target_duration: c.project.target_duration,
        video_category: c.project.video_category ?? null,
      });
      const facts = c.facts.map((text, i) => BrandFact.parse({ fact_id: `F${String(i + 1).padStart(2, "0")}`, text, source: "test" }));
      const assets = c.assets.map((a) => Asset.parse(a));

      const res = await graph.invoke({ project: proj, facts, assets, notes: [] }, cfg(c.id));
      return res;
    };

    const saas = await runCase(saasCase);
    const ecom = await runCase(ecomCase);
    const promo = await runCase(promoCase);

    // Both gates invariant: stops at Gate 1 awaiting approval
    expect(saas.status).toBe("awaiting_approval");
    expect(saas.gate).toBe("storyboard");
    expect(ecom.status).toBe("awaiting_approval");
    expect(ecom.gate).toBe("storyboard");
    if (promo.status === "escalated") {
      console.log("Promo escalated:", JSON.stringify(promo.escalation, null, 2));
    }
    expect(promo.status).toBe("awaiting_approval");
    expect(promo.gate).toBe("storyboard");

    // 1. Chosen video types are category-appropriate
    expect(saas.chosenVideoType).toMatch(/^saas-/);
    expect(ecom.chosenVideoType).toMatch(/^ecom-/);
    expect(promo.chosenVideoType).toMatch(/^promo-/);

    // 2. Treatments are distinct and category-appropriate
    // Different loglines
    expect(saas.treatmentDoc!.logline).toContain("scheduling");
    expect(ecom.treatmentDoc!.logline).toContain("speed");
    expect(promo.treatmentDoc!.logline).toContain("coffee");
    const loglines = new Set([saas.treatmentDoc!.logline, ecom.treatmentDoc!.logline, promo.treatmentDoc!.logline]);
    expect(loglines.size).toBe(3);

    // Different hooks
    expect(saas.treatmentDoc!.hook).toMatch(/calendar|scheduling/i);
    expect(ecom.treatmentDoc!.hook).toMatch(/stride|bounce|shoe/i);
    expect(promo.treatmentDoc!.hook).toMatch(/coffee|roasted/i);

    // Different tones
    expect(saas.treatmentDoc!.tone).toContain("efficient");
    expect(ecom.treatmentDoc!.tone).toContain("athletic");
    expect(promo.treatmentDoc!.tone).toContain("warm");

    // Category-appropriate CTAs
    expect(saas.treatmentDoc!.cta).toMatch(/trial/i);
    expect(ecom.treatmentDoc!.cta).toMatch(/store|shop/i);
    expect(promo.treatmentDoc!.cta).toMatch(/bag|order/i);

    // Different visual systems
    expect(saas.treatmentDoc!.art_direction!.visual_system).toBe("saas_clarity");
    expect(ecom.treatmentDoc!.art_direction!.visual_system).toBe("product_bench");
    expect(promo.treatmentDoc!.art_direction!.visual_system).toBe("cinema");

    // 3. Storyboards reflect category visual blocks and scene purposes
    expect(saas.scenePlan!.scenes.length).toBeGreaterThanOrEqual(3);
    expect(ecom.scenePlan!.scenes.length).toBeGreaterThanOrEqual(3);
    expect(promo.scenePlan!.scenes.length).toBeGreaterThanOrEqual(3);

    // Ecommerce with video clip uses the supplied footage
    const ecomFootageScene = ecom.scenePlan!.scenes.find((s) => s.asset_ids.includes("asset_run"));
    expect(ecomFootageScene).toBeDefined();

    // SaaS uses process flow and trial end card
    const saasEndCard = saas.scenePlan!.scenes.find((s) => s.visual?.block === "end_card");
    expect(saasEndCard).toBeDefined();
    expect((saasEndCard?.visual as any)?.button).toMatch(/trial/i);

    // Promo uses small-batch roast proof and bag order end card
    const promoEndCard = promo.scenePlan!.scenes.find((s) => s.visual?.block === "closing_signature");
    expect(promoEndCard).toBeDefined();
    expect((promoEndCard?.visual as any)?.action).toMatch(/bag/i);

    // 4. Requirements sheet produced at Gate 1 for all 3 categories
    expect(saas.requirementsSheet).toBeDefined();
    expect(ecom.requirementsSheet).toBeDefined();
    expect(promo.requirementsSheet).toBeDefined();
    expect(saas.requirementsSheet?.ready_for_review).toBe(true);
    expect(ecom.requirementsSheet?.ready_for_review).toBe(true);
    expect(promo.requirementsSheet?.ready_for_review).toBe(true);
  });
});
