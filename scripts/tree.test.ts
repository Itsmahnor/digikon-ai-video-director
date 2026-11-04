import { describe, expect, it } from "vitest";
import { ANNOTATIONS, PLANNED_FILES, annotationFor, directoryCounts, problems, render } from "./tree.mts";

describe("project tree document", () => {
  it("every top-level directory, package and app is annotated, and no annotation points at nothing", () => {
    expect(problems()).toEqual([]);
  });
  it("annotation statuses and steps are filled in", () => {
    for (const a of ANNOTATIONS) { expect(["done", "partial", "base", "planned"]).toContain(a.status); expect(a.steps.length, a.path).toBeGreaterThan(0); expect(a.note.length, a.path).toBeGreaterThan(0); }
  });
  it("renders the tree, the plan-vs-reality table and the planned files", () => {
    const md = render();
    expect(md).toContain("## Plan vs reality");
    expect(md).toContain("|-- rag/");
    expect(md).toContain("Retrievers, skills importer");
    expect(md).toContain("| C6 | `packages/contracts/src/questions.ts` |");
    expect(md).not.toMatch(/-- node_modules\//); // tracked files only: no dependencies
    expect(md).not.toMatch(/-- \.env\s/);        // and no secrets file (only .env.example is tracked)
    expect(PLANNED_FILES.length).toBeGreaterThan(5);
  });
  it("counts tracked files per directory and finds the nearest annotation", () => {
    const c = directoryCounts(["a/b/c.txt", "a/b/d.txt", "a/e.txt", "top.txt"], 3);
    expect([...c]).toEqual([["a", 3], ["a/b", 2]]);
    expect(annotationFor("packages/rag/src/db")?.path).toBe("packages/rag");
    expect(annotationFor("nothing/here")).toBeNull();
  });
});

