import { describe, expect, it } from "vitest";
import { VISUAL_SYSTEMS, type ArtDirection, type EditorOperation, type SceneVisual } from "@digikon/contracts";
import { EXAMPLE_ART_DIRECTION, EXAMPLE_VISUALS } from "./composition-examples.js";
import { planCompositionScenes } from "./composition.js";

const NEW = ["title_plate", "quote_statement", "spec_callouts", "split_panels", "route_map", "timeline_path", "closing_signature"] as const;
const job = (visual: SceneVisual, overlay: string | null, [width, height]: readonly [number, number], art: ArtDirection = EXAMPLE_ART_DIRECTION) => ({
  render_id: "rn_0000000000000000", settings: { aspect_ratio: width > height ? "16:9" : width === height ? "1:1" : "9:16", width, height, fps: 30, duration_s: 3, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test" } } as never,
  operations: [{ operation_id: "E1", target_scene_id: "S01", operation_type: "render_graphics_scene", parameters: {}, timing: { start_s: 0, duration_s: 3 }, asset_ids: [], audio_cues: [], caption: null } as unknown as EditorOperation],
  templates: { E1: "remotion/scene-composition" }, assets: [], clips: [], asset_info: {}, concept_asset_ids: [], scene_visuals: { S01: { visual, overlay_text: overlay, visual_purpose: "x" } }, art_direction: art, output_path: "/tmp/out/rn_0000000000000000.mp4",
});
const plan = (j: ReturnType<typeof job>) => planCompositionScenes(j, { outputRoot: "/tmp/out" });

describe("the newer blocks are planned to the same standard as the first seven", () => {
  for (const block of NEW) for (const size of [[960, 540], [540, 960], [720, 720]] as const) {
    it(`${block} fits at ${size.join("x")}`, () => {
      const ex = EXAMPLE_VISUALS[block];
      const p = plan(job(ex.visual, ex.overlay_text, size));
      expect(p.ok ? [] : p.issues).toEqual([]);
    });
  }

  it("a long title is set smaller and stays inside the frame", () => {
    const ex = EXAMPLE_VISUALS.title_plate;
    const p = plan(job(ex.visual, "word ".repeat(23).trim(), [540, 960]));
    if (!p.ok) throw new Error(p.issues.join("; "));
    const s = p.scenes[0]!, top = (s.geom as { top: number }).top;
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + s.headline!.lines.length * s.headline!.font_px * 1.14).toBeLessThanOrEqual(960);
  });

  it("a title plate with no words is refused: it sets the overlay text", () => {
    const p = plan(job(EXAMPLE_VISUALS.title_plate.visual, null, [960, 540]));
    expect(p.ok ? [] : p.issues.join(" ")).toContain("no");
    expect(p.ok).toBe(false);
  });
});

describe("a visual system reaches the picture", () => {
  it("sets the typeface, the finish and the headline style the film chose", () => {
    const ex = EXAMPLE_VISUALS.title_plate;
    const p = plan(job(ex.visual, ex.overlay_text, [960, 540], { ...EXAMPLE_ART_DIRECTION, visual_system: "cinema" }));
    if (!p.ok) throw new Error(p.issues.join("; "));
    expect(p.scenes[0]).toMatchObject({ type: { face: "serif" }, finish: VISUAL_SYSTEMS.cinema.finish, headline_style: "plain" });
  });

  it("typography.face overrides the system, and a film with no system is drawn as before", () => {
    const ex = EXAMPLE_VISUALS.kinetic_type;
    const a = plan(job(ex.visual, ex.overlay_text, [960, 540], { ...EXAMPLE_ART_DIRECTION, visual_system: "cinema", typography: { ...EXAMPLE_ART_DIRECTION.typography, face: "mono" } }));
    const b = plan(job(ex.visual, ex.overlay_text, [960, 540]));
    if (!a.ok || !b.ok) throw new Error("plan failed");
    expect(a.scenes[0]!.type.face).toBe("mono");
    expect(b.scenes[0]).toMatchObject({ type: { face: "sans" }, finish: "none", headline_style: "rule" });
  });
});
