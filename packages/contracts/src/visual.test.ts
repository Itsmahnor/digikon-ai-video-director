import { describe, expect, it } from "vitest";
import { ArtDirection, Palette, SceneVisual, Scene, Treatment, contrastRatio, creativeIssues, visualTexts } from "./index.js";

const palette = { background: "#f6f2ea", surface: "#ffffff", text: "#1b2230", muted: "#5d6678", accent: "#e8590c", accent_2: "#2b8a6e" };
const art = {
  audience_response: "Relief", concept: "One calm slot", visual_metaphor: null, palette,
  typography: { weight: "bold", scale: "standard", case: "sentence", rationale: "friendly" }, composition: "left column",
  motion_language: { feel: "precise", easing: "ease_out", description: "eases out" }, narrative: { opening: "a", development: "b", conclusion: "c" },
};
const kinetic = { block: "kinetic_type", style: "word_pop", emphasis_word: null };
const chat = { block: "message_thread", messages: [{ from: "them", text: "Hi" }, { from: "you", text: "Hello" }] };
const flow = { block: "process_flow", steps: [{ label: "One" }, { label: "Two" }] };
const sc = (id: string, visual: unknown, over: Record<string, unknown> = {}) => ({ scene_id: id, visual_purpose: `purpose ${id}`, visual: visual ? SceneVisual.parse(visual) : null, overlay: { text: "Words" }, claim_ids: [], asset_ids: [], ...over });

describe("art direction", () => {
  it("accepts a legible palette and measures contrast the standard way", () => {
    expect(Palette.safeParse(palette).success).toBe(true);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });
  it("refuses text that cannot be read on its background, or a lost accent", () => {
    const low = Palette.safeParse({ ...palette, text: "#cccccc" });
    expect(low.success).toBe(false);
    expect(JSON.stringify(low)).toContain("legible");
    expect(Palette.safeParse({ ...palette, accent: "#f7f3eb" }).success).toBe(false);
    expect(Palette.safeParse({ ...palette, accent: "red" }).success).toBe(false);
  });
  it("is optional on a treatment, so an older treatment still loads, and is validated when present", () => {
    const base = { logline: "l", hook: "h", tone: "t", beats: [{ beat: "b", purpose: "p", approx_seconds: 5 }], cta: "c" };
    expect(Treatment.parse(base).art_direction).toBeNull();
    expect(Treatment.parse({ ...base, art_direction: art }).art_direction?.palette.accent).toBe("#e8590c");
    expect(Treatment.safeParse({ ...base, art_direction: { ...art, palette: { ...palette, text: "#eeeeee" } } }).success).toBe(false);
    expect(ArtDirection.safeParse({ ...art, typography: { ...art.typography, scale: "huge" } }).success).toBe(false);
  });
});

describe("scene visuals", () => {
  it("parses each block with its defaults", () => {
    expect(SceneVisual.parse(chat)).toMatchObject({ mode: "stack", camera: "static", reveal: "none", backdrop: "flat" });
    expect(SceneVisual.parse(flow).block).toBe("process_flow");
  });
  it("bounds every list and string, and refuses control characters and markup", () => {
    expect(SceneVisual.safeParse({ ...chat, messages: [{ from: "them", text: "only one" }] }).success).toBe(false);
    expect(SceneVisual.safeParse({ ...chat, messages: Array.from({ length: 7 }, () => ({ from: "you", text: "x" })) }).success).toBe(false);
    expect(SceneVisual.safeParse({ ...chat, messages: [{ from: "them", text: "a".repeat(49) }, { from: "you", text: "b" }] }).success).toBe(false);
    expect(SceneVisual.safeParse({ ...chat, messages: [{ from: "them", text: "bad\u0007bell" }, { from: "you", text: "b" }] }).success).toBe(false);
    expect(SceneVisual.safeParse({ ...chat, messages: [{ from: "them", text: "<img src=x onerror=1>" }, { from: "you", text: "b" }] }).success).toBe(false);
    expect(SceneVisual.safeParse({ block: "data_chart", chart: "bars", title: "t", points: [{ label: "a", value: 120 }, { label: "b", value: 1 }, { label: "c", value: 2 }] }).success).toBe(false);
    expect(SceneVisual.safeParse({ block: "teleporter" }).success).toBe(false);
  });
  it("lists every string a visual draws", () => {
    expect(visualTexts(SceneVisual.parse(chat))).toEqual(["Hi", "Hello"]);
    expect(visualTexts(SceneVisual.parse(kinetic))).toEqual([]);
  });
  it("is optional on a scene, so a scene without one still loads", () => {
    const s = Scene.parse({ scene_id: "S01", purpose: "p", start_time: 0, duration_seconds: 3, shot: { shot_size: "wide", camera_motion: "static", visual_action: "x" }, transition_out: "cut" });
    expect(s.visual).toBeNull();
    expect(s.visual_purpose).toBeNull();
  });
});

describe("creative checks", () => {
  it("do not judge a plan whose treatment has no art direction", () => {
    expect(creativeIssues([sc("S01", null, { visual_purpose: null })], null)).toEqual([]);
  });
  it("accept a varied film with a purpose for every scene", () => {
    expect(creativeIssues([sc("S01", chat), sc("S02", flow), sc("S03", kinetic)], ArtDirection.parse(art))).toEqual([]);
  });
  it("refuse a repeated block next to itself, a repeated purpose, and a missing purpose or visual", () => {
    const a = ArtDirection.parse(art);
    expect(creativeIssues([sc("S01", chat), sc("S02", chat)], a).map((i) => i.code)).toContain("repeated_block");
    expect(creativeIssues([sc("S01", chat, { visual_purpose: "Show the pain" }), sc("S02", flow, { visual_purpose: "show the pain!" })], a).map((i) => i.code)).toContain("duplicate_visual_purpose");
    expect(creativeIssues([sc("S01", chat, { visual_purpose: null })], a).map((i) => i.code)).toContain("no_visual_purpose");
    expect(creativeIssues([sc("S01", null)], a).map((i) => i.code)).toContain("no_visual");
  });
  it("let a scene built from supplied media stand without a visual, but not carry both", () => {
    const a = ArtDirection.parse(art);
    expect(creativeIssues([sc("S01", null, { asset_ids: ["asset_x"] })], a)).toEqual([]);
    expect(creativeIssues([sc("S01", chat, { asset_ids: ["asset_x"] })], a).map((i) => i.code)).toContain("visual_with_assets");
  });
  it("stop one block carrying more than a third of a film", () => {
    const a = ArtDirection.parse(art);
    const scenes = [sc("S01", chat), sc("S02", flow), sc("S03", chat), sc("S04", flow), sc("S05", chat), sc("S06", kinetic)];
    expect(creativeIssues(scenes, a).map((i) => i.code)).toContain("block_overused");
  });
  it("treat a % or currency sign in drawn text as a claim that needs support", () => {
    const a = ArtDirection.parse(art);
    const money = { ...chat, messages: [{ from: "them", text: "Only $5 a month" }, { from: "you", text: "ok" }] };
    expect(creativeIssues([sc("S01", money)], a).map((i) => i.code)).toContain("figure_without_claim");
    expect(creativeIssues([sc("S01", money, { claim_ids: ["C01"] })], a).map((i) => i.code)).not.toContain("figure_without_claim");
  });
  it("need overlay text for kinetic type, and a real row or point for a cursor or highlight", () => {
    const a = ArtDirection.parse(art);
    expect(creativeIssues([sc("S01", kinetic, { overlay: null })], a).map((i) => i.code)).toContain("kinetic_without_text");
    const ui = { block: "ui_demo", window_title: "w", rows: [{ label: "a" }, { label: "b" }], cursor_target: 4 };
    expect(creativeIssues([sc("S01", ui)], a).map((i) => i.code)).toContain("cursor_out_of_range");
    const chart = { block: "data_chart", chart: "line", title: "t", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }, { label: "c", value: 3 }], highlight_index: 5 };
    expect(creativeIssues([sc("S01", chart)], a).map((i) => i.code)).toContain("highlight_out_of_range");
  });
});
