import { describe, expect, it } from "vitest";
import { Claim, Project, Scene, ScenePlan, auditClaims, classifyClaim, validatePlan, type BrandFact } from "./index.js";

const project = Project.parse({
  project_id: "learn1", owner_id: "u", brief: "b", objective: "o", audience: "Students", platform: "YouTube", aspect_ratio: "16:9", target_duration: 10,
});
const facts: BrandFact[] = [{ fact_id: "F01", text: "Courses are self-paced", source: "product sheet" }];
const claim = (over: Record<string, unknown>) => Claim.parse({ claim_id: "C01", text: "Courses are self-paced", brand_fact_id: null, ...over });
const scene = (claim_ids: string[]) =>
  Scene.parse({ scene_id: "S01", purpose: "p", start_time: 0, duration_seconds: 10, shot: { shot_size: "wide", camera_motion: "static", visual_action: "x" }, transition_out: "cut", claim_ids });

describe("claims audit", () => {
  it("classifies a claim backed by an approved fact as supported", () => {
    const c = classifyClaim(claim({ brand_fact_id: "F01" }), facts);
    expect(c.status).toBe("supported");
    expect(c.fact).toEqual(facts[0]);
    expect(c.explanation).toContain("F01");
  });

  it("classifies a proposed feature from the brief as an illustrative concept, never as verified", () => {
    const c = classifyClaim(claim({ text: "The platform offers personalized learning", kind: "illustrative" }), facts);
    expect(c.status).toBe("illustrative");
    expect(c.fact).toBeNull();
    expect(c.explanation).toMatch(/never as a verified product fact/);
  });

  it("classifies a factual claim with no evidence as unsupported, also when its fact id does not exist", () => {
    expect(classifyClaim(claim({ text: "Best coffee in town" }), facts).status).toBe("unsupported");
    const ghost = classifyClaim(claim({ brand_fact_id: "F99" }), facts);
    expect(ghost.status).toBe("unsupported");
    expect(ghost.explanation).toContain("F99 was not supplied");
  });

  it("does not let a verifiable-sounding claim pass as an illustrative concept", () => {
    for (const text of ["Students learn 3x faster", "Trusted by 10,000 learners", "The best learning platform", "Award-winning courses", "Guaranteed results", "Only 5 minutes a day"]) {
      const c = classifyClaim(claim({ text, kind: "illustrative" }), facts);
      expect(c.status, text).toBe("unsupported");
      expect(c.explanation).toMatch(/reads as a verifiable fact/);
    }
  });

  it("keeps every claim in the audit with a safe alternative, and says which scenes use it", () => {
    const claims = [
      claim({ claim_id: "C01", brand_fact_id: "F01" }),
      claim({ claim_id: "C02", text: "Personalized learning", kind: "illustrative", safe_alternative: "Show the interface adapting, without wording." }),
      claim({ claim_id: "C03", text: "Fastest way to learn" }),
    ];
    const audit = auditClaims(claims, [scene(["C01", "C02"])], facts);
    expect(audit.map((e) => [e.claim_id, e.status, e.usable_in_scenes, e.scene_ids])).toEqual([
      ["C01", "supported", true, ["S01"]], ["C02", "illustrative", true, ["S01"]], ["C03", "unsupported", false, []],
    ]);
    expect(audit[0]!.safe_alternative).toBeNull();
    expect(audit[1]!.safe_alternative).toBe("Show the interface adapting, without wording.");
    expect(audit[2]!.safe_alternative).toMatch(/supply an approved fact/); // a default when the model gave none
  });

  it("classifies the three claims of the latest run: unsupported as written, illustrative once marked as concepts", () => {
    const written = ["The platform offers personalized learning", "The platform offers progress tracking", "The platform brings learning resources together in one place"];
    const asRun = written.map((text, i) => claim({ claim_id: `C0${i + 1}`, text }));
    expect(auditClaims(asRun, [], []).map((e) => e.status)).toEqual(["unsupported", "unsupported", "unsupported"]);
    const marked = written.map((text, i) => claim({ claim_id: `C0${i + 1}`, text, kind: "illustrative" }));
    expect(auditClaims(marked, [], []).map((e) => e.status)).toEqual(["illustrative", "illustrative", "illustrative"]);
  });

  it("lets a scene show an illustrative claim but never an unsupported factual one", () => {
    const claims = [claim({ claim_id: "C01", text: "Personalized learning", kind: "illustrative" }), claim({ claim_id: "C02", text: "Best in class" })];
    const issues = (ids: string[]) => validatePlan(ScenePlan.parse({ project_id: "learn1", version: 1, scenes: [scene(ids)] }), [], project, { claims, facts });
    expect(issues(["C01"])).toEqual([]);
    const bad = issues(["C02"]);
    expect(bad.map((i) => i.code)).toEqual(["unsupported_claim"]);
    expect(bad[0]!.message).toContain("unsupported factual claim");
  });
});
