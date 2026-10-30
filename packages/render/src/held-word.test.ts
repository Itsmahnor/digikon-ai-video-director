import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SceneVisual, creativeIssues } from "@digikon/contracts";
import type { EditorOperation } from "@digikon/contracts";
import { COMPOSITION_TEMPLATE, planCompositionScenes } from "./composition.js";
import { EXAMPLE_ART_DIRECTION } from "./composition-examples.js";
import { loadFontMeter, ESTIMATE_METER } from "./font-metrics.js";
import type { RenderJob } from "./adapter.js";

// Planning only: nothing is rendered here. Whether the rendered frames satisfy the assembler's match-cut check is decided when the film is rendered.
const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
const meter = font ? loadFontMeter(font) : ESTIMATE_METER;
const tmp = mkdtempSync(join(tmpdir(), "held-test-"));
const outputRoot = join(tmp, "out");
mkdirSync(outputRoot);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const S02 = { overlay: "YOUR TECHNOLOGY SHOULD TOO.", visual: { block: "kinetic_type", style: "mask_rise", emphasis_word: 1, camera: "static", reveal: "wipe_up", backdrop: "flat" } };
const s03 = (held: unknown) => ({ overlay: "TECHNOLOGY. AUTOMATION. GROWTH.", visual: { block: "layered_cards", cards: [{ title: "TECHNOLOGY", detail: "Automation" }, { title: "DIGIKON SOLUTIONS", detail: "Typeset wordmark (concept)" }], depth: "strong", camera: "pull_out", reveal: "iris", backdrop: "gradient", ...(held ? { held } : {}) } });
const HELD = { card: 0, from_scene: "S02", word_index: 1 };

function job(w: number, h: number, scenes: Record<string, { overlay: string; visual: unknown }>, only: string, start = 3, dur = 5): Omit<RenderJob, "signal"> {
  const id = `rn_${Math.random().toString(16).slice(2).padEnd(16, "0").slice(0, 16)}`;
  const op = { operation_id: "E01", target_scene_id: only, operation_type: "render_graphics_scene", parameters: {}, timing: { start_s: 0, duration_s: dur }, asset_ids: [], audio_cues: [], caption: null } as unknown as EditorOperation;
  return {
    render_id: id, settings: { aspect_ratio: "16:9", width: w, height: h, fps: 30, duration_s: dur, container: "mp4", video_codec: "h264", audio_codec: null, source: { type: "user_approved", reference: "test" } } as never,
    operations: [op], templates: { E01: COMPOSITION_TEMPLATE }, assets: [], clips: [], asset_info: {}, concept_asset_ids: [],
    scene_visuals: Object.fromEntries(Object.entries(scenes).map(([k, s]) => [k, { visual: structuredClone(s.visual) as never, overlay_text: s.overlay, visual_purpose: "p" }])), art_direction: EXAMPLE_ART_DIRECTION as never, output_path: join(outputRoot, `${id}.mp4`),
  };
  void start;
}
const plan = (w: number, h: number, held: unknown, from = "S03") => {
  const p = planCompositionScenes(job(w, h, { S02, S03: s03(held) }, from), { outputRoot, meter });
  return p;
};

describe("a held word for a match cut (planning)", () => {
  it("is part of the storyboard contract, optional, and absent in existing plans", () => {
    expect(SceneVisual.parse(s03(null).visual)).not.toHaveProperty("held");
    expect(SceneVisual.parse(s03(HELD).visual)).toMatchObject({ held: HELD });
    expect(SceneVisual.safeParse(s03({ card: 9, from_scene: "S02", word_index: 1 }).visual).success).toBe(false);
  });

  for (const [w, h] of [[1280, 720], [1920, 1080], [854, 480], [720, 1280]] as const) {
    it(`holds the word exactly where the previous scene lays it out, at ${w}x${h}`, () => {
      const prev = planCompositionScenes(job(w, h, { S02, S03: s03(HELD) }, "S02"), { outputRoot, meter });
      const next = plan(w, h, HELD);
      if (!prev.ok || !next.ok) throw new Error(JSON.stringify(!prev.ok ? prev.issues : !next.ok ? next.issues : []));
      const k = prev.scenes[0]!.headline!, held = next.scenes[0]!.held!;
      expect(held.font_px).toBe(k.font_px);
      expect(held.text.replace(/\W/g, "").toUpperCase()).toBe("TECHNOLOGY");
      // the bar is the previous scene's bar: same left edge, height and vertical position
      const blockH = k.lines.length * k.font_px * 1.12;
      expect(held.bar.h).toBeCloseTo(blockH, 6);
      expect(held.bar.y).toBeCloseTo(k.box.y + (k.box.h - blockH) / 2, 6);
      expect(held.bar.x).toBe(k.box.x);
      // the word sits on the line of the previous scene's text that holds it, inside the text column
      const row = k.lines.findIndex((l) => /TECHNOLOGY/i.test(l));
      expect(held.y).toBeCloseTo(held.bar.y + row * k.font_px * 1.12, 6);
      expect(held.x).toBeGreaterThanOrEqual(k.box.x + k.font_px * 0.4);
      expect(held.hold_frames).toBe(9);
      expect(held.move_frames).toBe(24);
    });
  }

  it("keeps the scene's own content, duration and cards", () => {
    const next = plan(1280, 720, HELD);
    if (!next.ok) throw new Error(next.issues.join("; "));
    expect(next.scenes[0]!.frames).toBe(150);
    expect(next.scenes[0]!.visual).toMatchObject({ block: "layered_cards", reveal: "iris", cards: [{ title: "TECHNOLOGY" }, { title: "DIGIKON SOLUTIONS" }] });
  });

  it("refuses, naming why, when the word cannot be carried", () => {
    expect(JSON.stringify((plan(1280, 720, { ...HELD, card: 1 }) as { issues?: string[] }).issues)).toMatch(/not the title of card 1/);
    expect(JSON.stringify((plan(1280, 720, { ...HELD, word_index: 9 }) as { issues?: string[] }).issues)).toMatch(/does not exist/);
    expect(JSON.stringify((plan(1280, 720, { ...HELD, from_scene: "S07" }) as { issues?: string[] }).issues)).toMatch(/no kinetic type text to hold/);
    const short = planCompositionScenes(job(1280, 720, { S02, S03: s03(HELD) }, "S03", 3, 2), { outputRoot, meter });
    expect(short.ok).toBe(false);
  });
});

describe("the storyboard checks for a held word", () => {
  const sc = (id: string, visual: unknown, text: string | null) => ({ scene_id: id, visual_purpose: `purpose ${id}`, visual: SceneVisual.parse(visual), overlay: text ? { text } : null, claim_ids: [] as string[], asset_ids: [] as string[] });
  const ok = [sc("S02", S02.visual, S02.overlay), sc("S03", s03(HELD).visual, "TECHNOLOGY. AUTOMATION. GROWTH.")];
  const codes = (scenes: typeof ok) => creativeIssues(scenes, EXAMPLE_ART_DIRECTION as never).map((i) => i.code);
  it("accepts the same word, emphasised, in the scene straight before", () => { expect(codes(ok)).toEqual([]); });
  it("refuses a word that is not the card title, a source that is not straight before, and a word drawn in the normal colour", () => {
    expect(codes([ok[0]!, sc("S03", s03({ ...HELD, card: 1 }).visual, "x")])).toContain("held_word_mismatch");
    expect(codes([sc("S01", S02.visual, "ONE TWO"), ...ok])).not.toContain("held_source");
    expect(codes([ok[0]!, sc("S03", s03({ ...HELD, from_scene: "S01" }).visual, "x")])).toContain("held_source");
    expect(codes([sc("S02", { ...S02.visual, emphasis_word: 0 }, S02.overlay), ok[1]!])).toContain("held_not_emphasised");
  });
});
