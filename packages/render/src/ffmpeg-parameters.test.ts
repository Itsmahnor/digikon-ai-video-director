import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EditorOperation, RenderSettings } from "@digikon/contracts";
import { CAPABILITY_CATALOG, planScenes } from "./index.js";
import { recipes } from "../../director/src/fixtures.js";

// Parameter parity between the FFmpeg adapter and the authoritative recipes, through the adapter's real planner (nothing is rendered).
const dir = join(tmpdir(), "ffmpeg-parameters-test");
mkdirSync(join(dir, "out"), { recursive: true });
const FPS = 30;
const settings = RenderSettings.parse({ aspect_ratio: "16:9", width: 320, height: 180, fps: FPS, duration_s: 8, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "ffmpeg parameter test" } });
const learned = CAPABILITY_CATALOG.filter((c) => c.engine === "ffmpeg").map((c) => ({ template: c.template, storyboard_transition: c.storyboard_transition, xfade: c.xfade, direction_map: c.direction_map }));
const recipe = (id: string) => recipes.find((r) => r.recipe_id === id)!;
const numberParam = (id: string, name: string) => { const p = recipe(id).parameters.find((x) => x.name === name)!; if (p.kind !== "number") throw new Error("fixture"); return p; };

const op = (o: { id: string; scene: string; type: "render_graphics_scene" | "concat" | "trim_clip"; parameters: Record<string, unknown>; start: number; dur: number; recipe: string; caption?: boolean; assets?: string[] }) => EditorOperation.parse({
  operation_id: o.id, target_scene_id: o.scene, operation_type: o.type, parameters: o.parameters, preconditions: [], expected_result: "test", validation_status: "unvalidated",
  source_use_id: `U${o.id.slice(1)}`, recipe_id: o.recipe, recipe_version: "0.1.0", asset_ids: o.assets ?? [], timing: { start_s: o.start, duration_s: o.dur },
  caption: o.caption ? { text: "A caption", start_s: o.start, end_s: o.start + o.dur } : null, audio_cues: [],
});
const issues = (operations: ReturnType<typeof op>[], templates: Record<string, string>, extra: Record<string, unknown> = {}) => {
  const p = planScenes({ render_id: "rn_0123456789abcdef", settings, operations, templates, assets: [], clips: [], asset_info: {}, concept_asset_ids: [], output_path: join(dir, "out", "rn_0123456789abcdef.mp4"), ...extra } as never, { outputRoot: join(dir, "out"), learned });
  return p.ok ? [] : p.issues;
};

/** Two text-card scenes joined by one transition of the given template and duration. */
function transition(recipeId: string, parameters: Record<string, unknown>) {
  const r = recipe(recipeId);
  const raw = parameters["duration_s"], d = typeof raw === "number" ? raw : 0.5; // the operation's own timing stays valid when the parameter is the thing under test
  return issues(
    [
      op({ id: "E01", scene: "S01", type: "render_graphics_scene", parameters: { fade_in_s: 0.5, background: "navy" }, start: 0, dur: 4, recipe: "text-card-fade", caption: true }),
      op({ id: "E02", scene: "S01", type: "concat", parameters, start: 4 - d, dur: d, recipe: recipeId }),
      op({ id: "E03", scene: "S02", type: "render_graphics_scene", parameters: { fade_in_s: 0.5, background: "forest" }, start: 4, dur: 4, recipe: "text-card-fade", caption: true }),
    ],
    { E01: "ffmpeg/text-card", E02: r.implementation_ref, E03: "ffmpeg/text-card" },
  ).filter((i) => i.includes("duration_s"));
}
const frame = 1 / FPS;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

describe("FFmpeg transition durations equal their recipes", () => {
  const cases: [string, Record<string, unknown>][] = [["crossfade", {}], ["dip-to-black", {}], ["directional-wipe", { direction: "left" }]];
  for (const [id, extra] of cases) {
    const p = numberParam(id, "duration_s");
    describe(`${id} (${p.min} to ${p.max} s)`, () => {
      it("accepts the recipe's minimum, maximum and default", () => {
        for (const d of [p.min, p.max, p.default]) expect(transition(id, { ...extra, duration_s: d }), `${d}s`).toEqual([]);
      });
      it("refuses one frame below the minimum and one frame above the maximum, naming the range", () => {
        for (const d of [round(p.min - frame), round(p.max + frame)]) {
          const got = transition(id, { ...extra, duration_s: d });
          expect(got.length, `${d}s`).toBe(1);
          expect(got[0]).toContain(`from ${p.min} to ${p.max}`);
        }
      });
      it("refuses a missing or non-numeric duration", () => {
        expect(transition(id, { ...extra, duration_s: "0.5" }).length).toBe(1);
      });
    });
  }
  it("pins the two ranges the audit found wrong", () => {
    expect(transition("dip-to-black", { duration_s: 0.2 })[0]).toContain("from 0.3 to 1.5"); // was accepted
    expect(transition("dip-to-black", { duration_s: 0.3 })).toEqual([]);
    expect(transition("directional-wipe", { direction: "left", duration_s: 1.5 })[0]).toContain("from 0.2 to 1"); // was accepted
    expect(transition("directional-wipe", { direction: "left", duration_s: 1 })).toEqual([]);
  });
});

describe("clip-play and clip-play-caption: fade_in_s belongs to the caption recipe only", () => {
  const clipJob = (recipeId: string, parameters: Record<string, unknown>, caption: boolean) => issues(
    [op({ id: "E01", scene: "S01", type: "trim_clip", parameters, start: 0, dur: 4, recipe: recipeId, caption, assets: ["V1"] })],
    { E01: "ffmpeg/clip-play" },
    { assets: [{ asset_id: "V1", media_type: "video", uri: join(dir, "clip.mp4") }], clips: [{ operation_id: "E01", asset_id: "V1", source_in_s: 0 }], asset_info: { V1: { duration: 10, width: 320, height: 180, audio_tracks: 0 } } },
  ).filter((i) => i.includes("fade_in_s") || i.includes("unknown parameter"));
  writeFileSync(join(dir, "clip.mp4"), "x");
  const base = { fit: "contain", background: "charcoal", source_audio: "drop" };

  it("the recipes: only the caption recipe defines fade_in_s", () => {
    expect(recipe("clip-play").parameters.map((p) => p.name)).not.toContain("fade_in_s");
    expect(recipe("clip-play-caption").parameters.map((p) => p.name)).toContain("fade_in_s");
    expect(recipe("clip-play-caption").validation_rules.some((r) => r.kind === "requires_overlay_text")).toBe(true);
    expect(recipe("clip-play").validation_rules.some((r) => r.kind === "requires_overlay_text")).toBe(false);
  });
  it("a plain clip (no caption) needs no fade_in_s", () => {
    expect(clipJob("clip-play", base, false)).toEqual([]);
  });
  it("a captioned clip needs fade_in_s, and it must be in range", () => {
    expect(clipJob("clip-play-caption", { ...base, fade_in_s: 0.5 }, true)).toEqual([]);
    expect(clipJob("clip-play-caption", base, true).join(" ")).toContain("fade_in_s must be a number from 0.2 to 2");
    expect(clipJob("clip-play-caption", { ...base, fade_in_s: 2.5 }, true).join(" ")).toContain("fade_in_s must be a number from 0.2 to 2");
  });
  it("the adapter requires fade_in_s exactly when an operation carries a caption", () => {
    expect(clipJob("clip-play", base, true).join(" ")).toContain("fade_in_s"); // a caption on the plain recipe would need a parameter that recipe lacks
    expect(clipJob("clip-play-caption", { ...base, fade_in_s: 0.5 }, false)).toEqual([]); // no caption: the parameter is accepted and unused
  });
});
