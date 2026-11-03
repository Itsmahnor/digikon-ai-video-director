import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Recipe, Scene, SceneGraph, TemplateRecord } from "./index.js";

const baseScene = { scene_id: "S01", purpose: "p", start_time: 0, duration_seconds: 4, transition_out: "cut", shot: { shot_size: "wide", camera_motion: "static", visual_action: "a" } };

describe("scene archetype and needs (additive, optional)", () => {
  it("a scene without them parses exactly as before: no new keys appear, so approval hashes cannot move", () => {
    const parsed = Scene.parse(baseScene);
    expect("scene_archetype" in parsed).toBe(false);
    expect("needs" in parsed).toBe(false);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(Scene.parse(JSON.parse(JSON.stringify(parsed)))));
  });
  it("accepts an archetype and needs, and fills the need defaults", () => {
    const s = Scene.parse({ ...baseScene, scene_archetype: "stat_reveal", needs: [{ kind: "show_data", description: "show that 8 of 10 agree" }] });
    expect(s.scene_archetype).toBe("stat_reveal");
    expect(s.needs![0]).toMatchObject({ claim_id: null, priority: "primary" });
  });
  it("refuses a bad archetype, an unknown need kind, an empty description and too many needs", () => {
    expect(Scene.safeParse({ ...baseScene, scene_archetype: "Stat Reveal" }).success).toBe(false);
    expect(Scene.safeParse({ ...baseScene, needs: [{ kind: "sparkle", description: "x" }] }).success).toBe(false);
    expect(Scene.safeParse({ ...baseScene, needs: [{ kind: "show_data", description: " " }] }).success).toBe(false);
    expect(Scene.safeParse({ ...baseScene, needs: Array.from({ length: 9 }, () => ({ kind: "show_data", description: "x" })) }).success).toBe(false);
  });
});

describe("recipe family, variant_of, archetype and tags (additive, optional)", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith(".json") ? [p] : []; });
  const dir = resolve(import.meta.dirname, "..", "..", "..", "recipes");
  it("every shipped recipe still parses and gains no new keys", () => {
    const all = files(dir);
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) {
      const raw = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
      const r = Recipe.parse(raw);
      for (const k of ["family", "variant_of", "archetype", "tags"]) expect(k in r, `${f} ${k}`).toBe(false);
    }
  });
  it("accepts the new fields on a recipe and refuses malformed ones", () => {
    const raw = JSON.parse(readFileSync(files(dir)[0]!, "utf8")) as Record<string, unknown>;
    const r = Recipe.parse({ ...raw, family: "dip-family", variant_of: "dip-to-black", archetype: "scene_break", tags: ["calm", "dark"] });
    expect(r).toMatchObject({ family: "dip-family", variant_of: "dip-to-black", archetype: "scene_break", tags: ["calm", "dark"] });
    expect(Recipe.safeParse({ ...raw, family: "Not Valid" }).success).toBe(false);
    expect(Recipe.safeParse({ ...raw, tags: [""] }).success).toBe(false);
  });
});

const graph = () => ({
  format: "digikon.scene-graph", format_version: 1, canvas: { width: 1920, height: 1080, fps: 30 }, duration_s: 4,
  nodes: [
    { node_id: "root", kind: "group" },
    { node_id: "title", kind: "text", parent_id: "root", bindings: { text: "headline" } },
  ],
  animations: [{ target: "title", property: "opacity", keyframes: [{ t_s: 0, value: 0 }, { t_s: 1, value: 1, easing: "ease_out" }] }],
});

describe("SceneGraph (draft)", () => {
  it("accepts a valid graph and fills defaults", () => {
    const g = SceneGraph.parse(graph());
    expect(g.nodes[0]).toMatchObject({ parent_id: null, props: {}, bindings: {} });
    expect(g.animations[0]!.keyframes[0]!.easing).toBe("ease_in_out");
  });
  const bad = (mut: (g: ReturnType<typeof graph>) => void) => { const g = graph(); mut(g); return SceneGraph.safeParse(g); };
  it("refuses duplicate nodes, a missing or non-group parent, and a parent cycle", () => {
    expect(bad((g) => { g.nodes.push({ node_id: "title", kind: "text" } as never); }).success).toBe(false);
    expect(bad((g) => { (g.nodes[1] as { parent_id: string }).parent_id = "ghost"; }).success).toBe(false);
    expect(bad((g) => { g.nodes.push({ node_id: "label", kind: "text", parent_id: "title" } as never); }).success).toBe(false);
    expect(bad((g) => { (g.nodes[0] as { parent_id?: string }).parent_id = "g2"; g.nodes.push({ node_id: "g2", kind: "group", parent_id: "root" } as never); }).success).toBe(false);
  });
  it("refuses animations on a missing node, past the end of the scene, or out of order", () => {
    expect(bad((g) => { g.animations[0]!.target = "ghost"; }).success).toBe(false);
    expect(bad((g) => { g.animations[0]!.keyframes[1]!.t_s = 9; }).success).toBe(false);
    expect(bad((g) => { g.animations[0]!.keyframes = [{ t_s: 2, value: 1 }, { t_s: 1, value: 0 }] as never; }).success).toBe(false);
    expect(bad((g) => { g.animations[0]!.keyframes = [{ t_s: 0, value: 1 }] as never; }).success).toBe(false);
  });
});

describe("TemplateRecord (draft)", () => {
  const rec = () => ({
    format: "digikon.template", format_version: 1, template_id: "stat-reveal-bars", version: "0.1.0", category: "data", title: "Stat reveal", description: "Bars grow to show a figure.",
    serves_needs: ["show_data"], energy: "medium", aspect_ratios: ["16:9"], renderers: ["remotion"],
    parameters: [{ kind: "string", name: "headline", max_length: 40, default: "8 of 10" }],
    scene_graph: graph(), source: { origin: "original", license: "proprietary" },
  });
  it("accepts a valid draft and defaults it to draft status", () => {
    const t = TemplateRecord.parse(rec());
    expect(t.status).toBe("draft");
    expect(t.tags).toEqual([]);
  });
  it("refuses a binding to an undeclared parameter, a self-variant, and no served need", () => {
    expect(TemplateRecord.safeParse({ ...rec(), parameters: [] }).success).toBe(false);
    expect(TemplateRecord.safeParse({ ...rec(), variant_of: "stat-reveal-bars" }).success).toBe(false);
    expect(TemplateRecord.safeParse({ ...rec(), serves_needs: [] }).success).toBe(false);
    expect(TemplateRecord.safeParse({ ...rec(), serves_needs: ["sparkle"] }).success).toBe(false);
  });
  it("refuses code smuggled in as an unknown field's effect: unknown keys are dropped, not kept", () => {
    const t = TemplateRecord.parse({ ...rec(), script: "alert(1)" });
    expect("script" in t).toBe(false);
  });
});
