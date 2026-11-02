import { describe, expect, it } from "vitest";
import { VISUAL_SYSTEMS, VISUAL_SYSTEM_IDS, rankVisualBlocks, rankVisualSystems, type ArtDirection, type SceneVisual } from "@digikon/contracts";
import { readFileSync } from "node:fs";
import { compareFilms, diversityReport, type FilmPlan } from "./diversity.js";

const art = (system: ArtDirection["visual_system"], background: string, accent: string, face?: "sans" | "serif" | "mono"): ArtDirection => ({
  audience_response: "x", concept: system === "atelier" ? "Desire built by withholding one amber object" : "Booking stops being a pile of messages", visual_metaphor: null,
  palette: { background, surface: background, text: "#000000", muted: "#555555", accent, accent_2: accent },
  typography: { weight: "bold", scale: "standard", case: "sentence", ...(face ? { face } : {}), rationale: "x" }, ...(system ? { visual_system: system } : {}),
  composition: "x", motion_language: { feel: "precise", easing: "ease_out", description: "x" }, narrative: { opening: "x", development: "x", conclusion: "x" },
});
const scene = (block: string, transition_out = "cut", duration_seconds = 3) => ({ visual: { block, camera: "static", reveal: "none", backdrop: "flat" } as unknown as SceneVisual, transition_out, duration_seconds });
const film = (id: string, category: string, a: ArtDirection, blocks: string[], t = "cut"): FilmPlan => ({ id, category, art: a, scenes: blocks.map((b) => scene(b, t)) });
const OLD = ["message_thread", "ui_demo", "kinetic_type", "end_card"];

describe("the same design with different content is measured as the same design", () => {
  it("two films that only change the words and a colour are not different", () => {
    const r = diversityReport([film("a", "saas", art(undefined, "#ffffff", "#ff0066"), OLD), film("b", "travel", art(undefined, "#ffffff", "#ff3366"), OLD)]);
    expect(r.pairs[0]!.verdict).toBe("same_design");
  });

  it("a luxury film and a SaaS film of different systems, structures and type are different", () => {
    const r = diversityReport([film("lux", "luxury", art("atelier", "#0d0a08", "#c8a35a", "serif"), ["title_plate", "spec_callouts", "quote_statement", "closing_signature"], "dip_to_black"), film("saas", "saas", art("saas_clarity", "#f6f2ea", "#e8590c"), OLD)]);
    expect(r.pairs[0]!.verdict).toBe("different");
  });

  it("compares films and never rewards a film for how many templates it uses", () => {
    const d = compareFilms(film("a", "x", art("saas_clarity", "#ffffff", "#ff0066"), OLD), film("b", "x", art("saas_clarity", "#ffffff", "#ff0066"), OLD));
    expect(Object.values(d).every((v) => v < 0.5)).toBe(true);
  });
});

const briefs = JSON.parse(readFileSync(new URL("../../../evals/creative-diversity.json", import.meta.url), "utf8")) as { id: string; category: string; brief: string; objective: string; audience: string }[];
const top = (id: string) => { const b = briefs.find((x) => x.id === id)!; return rankVisualSystems(`${b.objective} ${b.audience} ${b.brief}`)[0]!.id; };

describe("a brief leads to a way of making the film, from what it says", () => {
  it("every evaluation category reaches a system made for it", () => {
    expect(top("luxury-perfume")).toBe("atelier");
    expect(top("saas-promo")).toBe("saas_clarity");
    expect(top("tech-launch")).toBe("launch_pulse");
    expect(top("fashion-campaign")).toBe("runway");
    expect(top("travel-ad")).toBe("voyage");
    expect(top("edu-explainer")).toBe("classroom");
    expect(top("corporate-film")).toBe("manifesto");
    expect(top("product-demo")).toBe("product_bench");
  });

  it("is deterministic: nothing in the choice is random", () => {
    const text = "A playful launch for a fashion app";
    expect(rankVisualSystems(text)).toEqual(rankVisualSystems(text));
  });

  it("tone can move two briefs of one category to different systems", () => {
    const shortlist = (t: string) => rankVisualSystems(t).filter((r) => r.score > 0).map((r) => r.id);
    expect(shortlist("software for therapists")).toEqual(["saas_clarity"]);
    expect(shortlist("cheeky fun playful app")).toEqual(expect.arrayContaining(["launch_pulse", "runway"])); // the shortlist opens up: the Director decides
  });

  it("every system has a real vocabulary of its own, and no two systems share all of it", () => {
    for (const id of VISUAL_SYSTEM_IDS) expect(VISUAL_SYSTEMS[id].blocks.length).toBeGreaterThanOrEqual(4);
    const keys = VISUAL_SYSTEM_IDS.map((id) => [...VISUAL_SYSTEMS[id].blocks].sort().join());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("block ranking weighs fit, proof, assets and likeness to the film so far", () => {
  const validated = () => "validated" as const;
  it("a block outside the system ranks below the system's own", () => {
    const r = rankVisualBlocks({ system: "atelier", readiness: validated, has_pictures: false, used: [] }, ["message_thread", "title_plate"]);
    expect(r[0]!.block).toBe("title_plate");
  });
  it("a block with no live implementation is not offered at all, and an unvalidated one ranks lower", () => {
    const r = rankVisualBlocks({ system: "atelier", readiness: (b) => (b === "title_plate" ? "registered" : b === "quote_statement" ? "executable" : "validated"), has_pictures: false, used: [] }, ["title_plate", "quote_statement", "spec_callouts"]);
    expect(r.map((x) => x.block)).toEqual(["spec_callouts", "quote_statement"]);
  });
  it("likeness to the previous scene is a cost, so reuse stays possible when nothing else fits", () => {
    const r = rankVisualBlocks({ system: "saas_clarity", readiness: validated, has_pictures: false, used: ["ui_demo"] }, ["ui_demo", "process_flow"]);
    expect(r.map((x) => x.block)).toEqual(["process_flow", "ui_demo"]);
    expect(rankVisualBlocks({ system: "saas_clarity", readiness: validated, has_pictures: false, used: ["ui_demo"] }, ["ui_demo"]).map((x) => x.block)).toEqual(["ui_demo"]);
  });
  it("a supplied picture puts the asset stage first; without one it is not offered", () => {
    expect(rankVisualBlocks({ system: "atelier", readiness: validated, has_pictures: true, used: [] }, ["title_plate", "asset_stage"])[0]!.block).toBe("asset_stage");
    expect(rankVisualBlocks({ system: "atelier", readiness: validated, has_pictures: false, used: [] }, ["asset_stage"])).toEqual([]);
  });
});
