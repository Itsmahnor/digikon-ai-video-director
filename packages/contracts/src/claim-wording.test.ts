import { describe, expect, it } from "vitest";
import { claimWordingIssues } from "./validate.js";
import { creativeIssues, type ArtDirection } from "./visual.js";
import type { Claim } from "./director.js";

const claim = (id: string, text: string, safe = "Ask it as a question."): Claim => ({ claim_id: id, text, brand_fact_id: null, kind: "factual", safe_alternative: safe });
const scene = (id: string, text: string, claim_ids: string[] = []) => ({ scene_id: id, overlay: { text }, claim_ids });
// the three claims of the GoHighLevel treatment
const CLAIMS = [claim("C01", "GoHighLevel brings several business tools together in one place."), claim("C02", "Using GoHighLevel saves time or reduces manual work."), claim("C03", "GoHighLevel helps businesses grow, win more leads or follow up automatically.")];

describe("what a film says on screen is checked against what it can support", () => {
  it("the GoHighLevel film's own lines pass: a question, a name and an invitation assert nothing", () => {
    expect(claimWordingIssues([scene("S01", "Too many tabs. Too many follow-ups?"), scene("S02", "Meet GoHighLevel"), scene("S03", "Imagine less juggling and more growing."), scene("S04", "Ready to take a look?")], CLAIMS, [])).toEqual([]);
  });

  it("a scene that repeats an unsupported claim without naming it goes back, with its safe alternative", () => {
    const [i] = claimWordingIssues([scene("S01", "GoHighLevel brings business tools together in one place")], CLAIMS, []);
    expect(i).toMatchObject({ code: "asserts_unsupported_claim", scene_id: "S01" });
    expect(i!.message).toContain("Ask it as a question.");
  });

  it("a stated result needs a claim behind the scene, or qualifying wording", () => {
    expect(claimWordingIssues([scene("S01", "Save ten hours a week")], [], []).map((i) => i.code)).toEqual(["unsubstantiated_wording"]);
    expect(claimWordingIssues([scene("S01", "Designed to save you time")], [], [])).toEqual([]);
    expect(claimWordingIssues([scene("S01", "Save ten hours a week", ["C01"])], [], [])).toEqual([]);
  });

  it("ordinary copy is left alone: this is not a ban on verbs", () => {
    expect(claimWordingIssues([scene("S01", "The Long Evening"), scene("S02", "Three days on the Atlantic coast")], CLAIMS, [])).toEqual([]);
  });
});

const ART = (visual_system?: ArtDirection["visual_system"]) => ({ visual_system, palette: {} }) as unknown as ArtDirection;
const drawn = (id: string, block: string, purpose = id) => ({ scene_id: id, visual_purpose: purpose, visual: { block, camera: "static", reveal: "none", backdrop: "flat", ...(block === "title_plate" ? { eyebrow: null, subline: null, plate: "bare" } : {}), ...(block === "message_thread" ? { messages: [], mode: "stack" } : {}) } as never, overlay: { text: "x" }, claim_ids: [], asset_ids: [] });

describe("a film stays inside its visual system", () => {
  it("a picture from another system is sent back, naming what the system uses", () => {
    const issues = creativeIssues([drawn("S01", "message_thread"), drawn("S02", "title_plate")], ART("atelier"));
    expect(issues.find((i) => i.code === "off_system_block")).toMatchObject({ scene_id: "S01" });
  });
  it("a narrow vocabulary is allowed to repeat: half a film, not a third", () => {
    const film = [drawn("S01", "title_plate"), drawn("S02", "quote_statement"), drawn("S03", "title_plate"), drawn("S04", "closing_signature")];
    expect(creativeIssues(film, ART("atelier")).map((i) => i.code)).toEqual([]);
  });
  it("a film from before systems existed is judged by the rules it was made under", () => {
    const film = [drawn("S01", "message_thread"), drawn("S02", "kinetic_type"), drawn("S03", "message_thread"), drawn("S04", "kinetic_type"), drawn("S05", "message_thread")];
    expect(creativeIssues(film, ART()).map((i) => i.code)).toContain("block_overused");
  });
});
