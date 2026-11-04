import { describe, expect, it } from "vitest";
import { Project } from "@digikon/contracts";
import { KeywordRetriever, loadSkillDocs, recipeDocs, type Doc } from "@digikon/rag";
import { ScriptedClient, storyboardNode, treatmentNode } from "./index.js";
import { assets, deps, facts, knowledge, project, recipes, root, treatment, goodStoryboard } from "./fixtures.js";

/** Skills reach the Director through its own scope and the project's video category; the ids used are recorded as citations. */
const skillDocs = loadSkillDocs(root("examples/skills"));
const byId = new Map(skillDocs.map((d) => [d.id, d]));
const withSkills = (llm: ScriptedClient, includeDraft: boolean) => ({ ...deps(llm), retriever: new KeywordRetriever([...recipeDocs(recipes), ...knowledge, ...skillDocs]), ...(includeDraft ? { skillsIncludeDraft: true } : {}) });
const asCategory = (c: "saas" | "ecommerce" | "general-promo" | null) => Project.parse({ ...project, video_category: c });
const skillCites = (cites: string[]) => cites.filter((c) => byId.has(c));

describe("skills in the Director", () => {
  it("retrieves no skill by default, because every shipped skill is a draft, and adds nothing to the prompt", async () => {
    const llm = new ScriptedClient([treatment]);
    const r = await treatmentNode(withSkills(llm, false), asCategory("saas"), facts);
    expect(skillCites(r.citations)).toEqual([]);
    expect(llm.calls[0]!.user).not.toContain("Production skills");
  });

  it("with drafts allowed, treatment cites skills of the project''s category and the cross-cutting ones, in Director scope, and shows them to the model", async () => {
    for (const [cat, other] of [["saas", ["ecommerce", "general-promo"]], ["ecommerce", ["saas", "general-promo"]], ["general-promo", ["saas", "ecommerce"]]] as const) {
      const llm = new ScriptedClient([treatment]);
      const r = await treatmentNode(withSkills(llm, true), asCategory(cat), facts);
      const used = skillCites(r.citations);
      expect(used.length, cat).toBeGreaterThan(0);
      for (const id of used) {
        const m = (byId.get(id) as Doc).metadata;
        expect([cat, "all"], `${cat}: ${id}`).toContain(m.skill_category);
        expect(other).not.toContain(m.skill_category);
        expect(m.skill_scope, id).not.toBe("editor"); // Editor-only skills never reach the Director
      }
      expect(llm.calls[0]!.user).toContain("Production skills");
    }
  });

  it("a project with no stated category reads only the cross-cutting skills", async () => {
    const r = await treatmentNode(withSkills(new ScriptedClient([treatment]), true), asCategory(null), facts);
    for (const id of skillCites(r.citations)) expect(byId.get(id)!.metadata.skill_category).toBe("all");
  });

  it("the storyboard step also cites category skills and never an Editor-only one", async () => {
    const llm = new ScriptedClient([treatment, goodStoryboard]);
    const d = withSkills(llm, true), p = asCategory("saas");
    const t = await treatmentNode(d, p, facts);
    const r = await storyboardNode(d, p, assets, [], t.treatment, facts);
    expect(llm.calls.filter((c) => c.name === "storyboard")[0]!.user).toContain("Production skills");
    for (const id of skillCites(r.citations)) { const m = byId.get(id)!.metadata; expect(["saas", "all"]).toContain(m.skill_category); expect(m.skill_scope).not.toBe("editor"); }
  });
});
