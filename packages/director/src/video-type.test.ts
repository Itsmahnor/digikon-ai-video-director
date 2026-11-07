import { describe, expect, it } from "vitest";
import { Project, VideoTypeProposal } from "@digikon/contracts";
import {
  CATEGORY_VIDEO_TYPES,
  proposeVideoTypes,
  videoTypeNode,
} from "./video-types.js";
import {
  ScriptedClient,
  approveCurrent,
  buildDirectorGraph,
  buildRunRecord,
} from "./index.js";
import { cfg, deps, goodEdit, goodStoryboard, input, project, treatment } from "./fixtures.js";

describe("D1: video type proposals and selection", () => {
  it("proposes 3 valid video types per category with one-line description and reference example", () => {
    for (const cat of ["saas", "ecommerce", "general-promo"] as const) {
      const proposals = proposeVideoTypes(cat);
      expect(proposals.length).toBe(3);
      for (const p of proposals) {
        expect(() => VideoTypeProposal.parse(p)).not.toThrow();
        expect(p.category).toBe(cat);
        expect(p.description.length).toBeGreaterThan(15);
        expect(p.example.length).toBeGreaterThan(10);
      }
      expect(proposals.filter((p) => p.recommended).length).toBe(1);
    }
  });

  it("defaults to general-promo when category is not set", () => {
    const proposals = proposeVideoTypes(null);
    expect(proposals.length).toBe(3);
    expect(proposals[0]!.category).toBe("general-promo");
  });

  it("ranks recommendations based on keywords in the brief", () => {
    const saasLaunch = proposeVideoTypes("saas", "A 30s video announcing our new feature release");
    expect(saasLaunch[0]!.id).toBe("saas-feature-launch");
    expect(saasLaunch[0]!.recommended).toBe(true);

    const saasDemo = proposeVideoTypes("saas", "A 60s product demo showing our app workflow and screens");
    expect(saasDemo[0]!.id).toBe("saas-product-demo");
    expect(saasDemo[0]!.recommended).toBe(true);

    const ecomUnbox = proposeVideoTypes("ecommerce", "Unboxing the new premium package box");
    expect(ecomUnbox[0]!.id).toBe("ecom-unboxing");
    expect(ecomUnbox[0]!.recommended).toBe(true);

    const promoStory = proposeVideoTypes("general-promo", "The origin story and journey of our brand founder");
    expect(promoStory[0]!.id).toBe("promo-brand-story");
    expect(promoStory[0]!.recommended).toBe(true);
  });

  it("videoTypeNode respects user choice and falls back to recommended proposal", async () => {
    const p = Project.parse({ ...project, video_category: "saas" });

    // Fallback when no type chosen
    const auto = await videoTypeNode(p);
    expect(auto.chosen).toBe("saas-product-demo");
    expect(auto.proposals.length).toBe(3);
    expect(auto.skills).toContain("saas-product-demo");
    expect(auto.trace[0]).toContain("video_type_step: proposed");

    // Explicit user choice
    const explicit = await videoTypeNode(p, "saas-explainer-60s");
    expect(explicit.chosen).toBe("saas-explainer-60s");
    expect(explicit.skills).toContain("saas-explainer-60s");

    // Project field choice
    const withField = Project.parse({ ...project, video_category: "saas", video_type: "saas-feature-launch" });
    const fromProj = await videoTypeNode(withField);
    expect(fromProj.chosen).toBe("saas-feature-launch");
  });

  it("Director graph executes video_type_step before treatment and records choice in audit", async () => {
    const llm = new ScriptedClient([{ status: "ready", questions: [] }, treatment, goodStoryboard, goodEdit]);
    const d = deps(llm);
    const graph = buildDirectorGraph(d);

    const saasProject = Project.parse({
      ...project,
      video_category: "saas",
      video_type: "saas-feature-launch",
    });

    const gate1 = await graph.invoke({ ...input, project: saasProject }, cfg("t-video-type"));
    expect(gate1.status).toBe("awaiting_approval");
    expect(gate1.gate).toBe("storyboard");

    // State carries proposals and choice
    expect(gate1.chosenVideoType).toBe("saas-feature-launch");
    expect(gate1.proposedVideoTypes.length).toBe(3);
    expect(gate1.trace).toEqual(expect.arrayContaining([expect.stringContaining("video_type_step: proposed")]));
    expect(gate1.skillsUsed).toContain("saas-feature-launch");

    // Audit record contains video_type and proposed_video_types
    const record = buildRunRecord(gate1, { model: "test-model", skills: d.skills, library: d.recipes });
    expect(record.video_type).toBe("saas-feature-launch");
    expect(record.proposed_video_types.length).toBe(3);
  });
});

import { categoryOfVideoType } from "./video-types.js";
describe("proposals follow the category of the chosen type", () => {
  it("offers SaaS types when a SaaS type was chosen, even if the category said something else", async () => {
    const out = await videoTypeNode({ video_category: "general-promo", video_type: "saas-product-demo", brief: "An SEO automation tool for agencies." } as never);
    expect(out.chosen).toBe("saas-product-demo");
    expect(out.proposals.map((p) => p.id)).toContain("saas-product-demo");
    expect(out.proposals.every((p) => p.category === "saas")).toBe(true);
  });
  it("knows the category of a type, and of nothing else", () => {
    expect(categoryOfVideoType("ecom-product-showcase")).toBe("ecommerce");
    expect(categoryOfVideoType("nope")).toBeNull();
    expect(categoryOfVideoType(null)).toBeNull();
  });
});
