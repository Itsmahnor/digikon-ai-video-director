import { describe, expect, it } from "vitest";
import { ScriptedClient, buildDirectorGraph } from "./index.js";
import { STEP_REFERENCES, STEP_SKILLS } from "./skills.js";
import { cfg, deps, input, shot, throughGate1, treatment, use } from "./fixtures.js";
import { SkillLibrary } from "./index.js";
import { root } from "./fixtures.js";

const art = {
  audience_response: "Home coffee drinkers should feel the pleasure of a fresh cup and order a first bag.",
  concept: "A week of roasting compressed into one pour.", visual_metaphor: null,
  palette: { background: "#f6f2ea", surface: "#ffffff", text: "#1b2230", muted: "#5d6678", accent: "#b8430a", accent_2: "#2b8a6e" },
  typography: { weight: "bold", scale: "standard", case: "sentence", rationale: "warm and direct" }, composition: "headline left, picture right",
  motion_language: { feel: "precise", easing: "ease_out", description: "eases out, then holds" }, narrative: { opening: "a", development: "b", conclusion: "c" },
};
const withArt = { ...treatment, art_direction: art };
const gfx = { need: "Animated graphics", kind: "graphics", availability: "generate_graphics" };
const scene = (id: string, dur: number, purpose: string, visual: unknown, extra: Record<string, unknown> = {}) => ({
  scene_id: id, purpose: "p", visual_purpose: purpose, visual, duration_seconds: dur, asset_ids: [], required_assets: [gfx], shot: { ...shot, camera_motion: "static" }, transition_out: "cut", ...extra,
});
const chat = { block: "message_thread", messages: [{ from: "them", text: "Is it fresh?" }, { from: "you", text: "Roasted this week" }] };
const flow = { block: "process_flow", steps: [{ label: "Roast" }, { label: "Pack" }, { label: "Ship" }] };
const end = { block: "end_card", button: "Order your first bag", wordmark: null, subline: null };
const text = { text: "Order your first bag", safe_area: "platform_safe" };
const good = { scenes: [scene("S01", 4, "Open on the question", chat), scene("S02", 5, "Show how it gets to you", flow), scene("S03", 3, "Close on one action", end, { overlay: text })] };
const strict = (llm: ScriptedClient) => ({ ...deps(llm), requireArtDirection: true });

describe("creative direction in the Director", () => {
  it("asks for art direction at the treatment and for a visual per scene at the storyboard, and loads the skill and reference for both", () => {
    expect(STEP_SKILLS.treatment).toContain("creative-direction");
    expect(STEP_SKILLS.storyboard).toContain("creative-direction");
    expect(STEP_SKILLS.edit_plan).not.toContain("creative-direction");
    expect(STEP_REFERENCES.storyboard).toContain("creative-direction/visual-blocks.md");
    const lib = new SkillLibrary(root("skills"));
    expect(lib.systemFor("storyboard").system).toContain("message_thread");
    expect(lib.systemFor("treatment").system).toContain("Viewer response");
  });

  it("refuses a treatment without art direction when a real model is used, and accepts one with it", async () => {
    const missing = new ScriptedClient([{ status: "ready", questions: [] }, treatment]);
    await expect(throughGate1(buildDirectorGraph(strict(missing)), input, "t-noart")).rejects.toThrow(/art_direction/);
    const ok = new ScriptedClient([{ status: "ready", questions: [] }, withArt, good, { uses: [] }]);
    const out = await throughGate1(buildDirectorGraph(strict(ok)), input, "t-art");
    expect(out.status).toBe("awaiting_approval");
    expect(out.treatmentDoc!.art_direction!.palette.accent).toBe("#b8430a");
    const sb = ok.calls.find((c) => c.name === "storyboard")!.user;
    expect(sb).toContain("visual_purpose");
    expect(sb).toContain("art_direction");
  });

  it("sends a storyboard back when scenes have no visual, repeat a block or share a purpose, and shows the model the exact problems", async () => {
    const bare = { scenes: good.scenes.map((s) => ({ ...s, visual: null, visual_purpose: null })) };
    const llm = new ScriptedClient([{ status: "ready", questions: [] }, withArt, bare, good, { uses: [] }]);
    const out = await throughGate1(buildDirectorGraph(strict(llm)), input, "t-bare");
    expect(out.status).toBe("awaiting_approval");
    const retry = llm.calls.filter((c) => c.name === "storyboard")[1]!.user;
    expect(retry).toContain("no_visual");
    expect(retry).toContain("no_visual_purpose");
    const again = { scenes: [scene("S01", 4, "Same", chat), scene("S02", 5, "Same", chat), scene("S03", 3, "Close", end, { overlay: text })] };
    const llm2 = new ScriptedClient([{ status: "ready", questions: [] }, withArt, again, good, { uses: [] }]);
    await throughGate1(buildDirectorGraph(strict(llm2)), input, "t-repeat");
    const r2 = llm2.calls.filter((c) => c.name === "storyboard")[1]!.user;
    expect(r2).toContain("repeated_block");
    expect(r2).toContain("duplicate_visual_purpose");
  });

  it("escalates instead of approving when the storyboard stays plain after repair", async () => {
    const bare = { scenes: good.scenes.map((s) => ({ ...s, visual: null, visual_purpose: null })) };
    const llm = new ScriptedClient([{ status: "ready", questions: [] }, withArt, bare, bare]);
    const out = await throughGate1(buildDirectorGraph(strict(llm)), input, "t-esc");
    expect(out.status).toBe("escalated");
    expect(out.escalation!.evidence.join(" ")).toContain("no_visual");
  });

  it("requires the shot's camera to match the visual's", async () => {
    const bad = { scenes: [{ ...good.scenes[0]!, visual: { ...chat, camera: "push_in" } }, good.scenes[1]!, good.scenes[2]!] };
    const llm = new ScriptedClient([{ status: "ready", questions: [] }, withArt, bad, good, { uses: [] }]);
    await throughGate1(buildDirectorGraph(strict(llm)), input, "t-cam");
    expect(llm.calls.filter((c) => c.name === "storyboard")[1]!.user).toContain("camera_mismatch");
  });

  it("gives every drawn scene exactly one scene-composition use, adding the parameterless one itself, and refuses a text recipe on top of it", async () => {
    const llm = new ScriptedClient([{ status: "ready", questions: [] }, withArt, good, { uses: [use(1, "S01", "text-fade-up", { delay_s: 0.5 })] }, { uses: [] }]);
    const s2 = await throughGate1(buildDirectorGraph(strict(llm)), input, "t-edit");
    expect(s2.status).toBe("awaiting_approval");
    expect(s2.gate).toBe("edit_plan");
    expect(llm.calls.filter((c) => c.name === "edit_plan")[1]!.user).toContain("cannot be combined with scene-composition");
    const uses = s2.editPlan!.uses;
    for (const id of ["S01", "S02", "S03"]) expect(uses.filter((u) => u.scene_id === id && u.recipe_id === "scene-composition")).toHaveLength(1);
    expect(uses.filter((u) => u.recipe_id === "text-fade-up")).toHaveLength(0);
  });
});