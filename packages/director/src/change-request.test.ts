import { describe, expect, it } from "vitest";
import { classifyChange } from "./change-request.js";

describe("change requests are routed by what they change", () => {
  it.each([
    "Make the title bigger", "Use a warmer colour palette", "Slow down the transition between scenes 2 and 3", "The camera zoom is too fast", "Change the font to something lighter", "Lower the music volume",
  ])("a look change goes to the Editor and reopens gate 2 only: %s", (text) => {
    expect(classifyChange(text)).toMatchObject({ route: "editor", reopens: "edit_plan", question: null });
  });
  it.each([
    "Change the headline so it mentions the new offer", "Remove the claim about delivery", "Add a scene about the customer's story", "Swap the order of scenes 2 and 3", "Rewrite the voiceover",
  ])("a story change goes to the Director and reopens gate 1: %s", (text) => {
    expect(classifyChange(text)).toMatchObject({ route: "director", reopens: "storyboard", question: null });
  });
  it("asks one question when the request is both, neither, or empty, and never guesses", () => {
    for (const text of ["Change the headline and make it bigger", "Make it better", "Hmm", ""]) {
      const r = classifyChange(text);
      expect(r).toMatchObject({ route: "ask", reopens: null });
      expect(r.question).toMatch(/\?$/);
    }
  });
  it("a look change names the unchanged storyboard in its reason", () => {
    expect(classifyChange("Make the logo size bigger").reason).toContain("approved storyboard stays as it is");
  });
});