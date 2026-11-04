import { describe, expect, it } from "vitest";
import { Asset, Gate1RequirementsSheet, Project, Treatment, emptyKit, provide } from "@digikon/contracts";
import { produceGate1Requirements } from "./requirements.js";
import { cfg, deps, goodEdit, goodStoryboard, input, project, treatment } from "./fixtures.js";
import { ScriptedClient, buildDirectorGraph } from "./index.js";

describe("D2: Gate 1 requirements sheet (needs analysis)", () => {
  it("produces a valid Gate1RequirementsSheet covering assets, fonts, and sound", () => {
    const scenePlan = {
      project_id: "p1",
      version: 1,
      scenes: [
        {
          scene_id: "S01",
          purpose: "Hook",
          start_time: 0,
          end_time: 4,
          duration_seconds: 4,
          voiceover: "Fresh coffee roasted in small batches every week.",
          production_method: "supplied_footage" as const,
          required_assets: [
            {
              asset_id: "asset_beans",
              need: "Coffee beans footage",
              kind: "footage" as const,
              availability: "supplied" as const,
              placeholder: false,
              fallback: null,
            },
          ],
          unresolved: [],
          visual_purpose: null,
          visual: null,
          asset_ids: ["asset_beans"],
          source_in_seconds: 0,
          claim_ids: ["C01"],
          shot: { shot_size: "close_up" as const, camera_motion: "slow_push_in" as const, visual_action: "beans pouring" },
          overlay: null,
          audio_cues: ["warm_acoustic_guitar"],
          transition_out: "crossfade" as const,
          constraints: [],
        },
        {
          scene_id: "S02",
          purpose: "Call to action",
          start_time: 4,
          end_time: 7,
          duration_seconds: 3,
          voiceover: null,
          production_method: "graphics" as const,
          required_assets: [
            {
              asset_id: null,
              need: "End card graphic",
              kind: "graphics" as const,
              availability: "generate_graphics" as const,
              placeholder: false,
              fallback: null,
            },
          ],
          unresolved: [],
          visual_purpose: null,
          visual: null,
          asset_ids: [],
          source_in_seconds: 0,
          claim_ids: [],
          shot: { shot_size: "wide" as const, camera_motion: "static" as const, visual_action: "end card" },
          overlay: { text: "Order now", safe_area: "platform_safe" as const },
          audio_cues: ["whoosh_sfx"],
          transition_out: "cut" as const,
          constraints: [],
        },
      ],
    };

    const treat = Treatment.parse({
      ...treatment,
      art_direction: {
        audience_response: "Wants to taste freshly roasted beans.",
        concept: "Craft roasting",
        visual_metaphor: null,
        palette: {
          background: "#ffffff",
          surface: "#f0f0f0",
          text: "#111111",
          muted: "#666666",
          accent: "#c8501e",
          accent_2: "#0a7a5a",
        },
        typography: {
          weight: "bold" as const,
          scale: "standard" as const,
          case: "sentence" as const,
          face: "sans" as const,
          rationale: "Clean modern sans for coffee roastery.",
        },
        visual_system: "saas_clarity" as const,
        composition: "Centered subject",
        motion_language: {
          feel: "calm" as const,
          easing: "ease_out" as const,
          description: "Subtle easing",
        },
        narrative: {
          opening: "Show product",
          development: "Show craft",
          conclusion: "CTA",
        },
      },
    });

    const assets = [
      Asset.parse({
        asset_id: "asset_beans",
        uri: "beans.mp4",
        media_type: "video",
        duration: 20,
        width: 1080,
        height: 1920,
      }),
    ];

    let kit = emptyKit("k1");
    kit = provide(kit, "brand.fonts", ["Inter", "Roboto"]);

    const req = produceGate1Requirements(scenePlan, treat, assets, kit);
    expect(() => Gate1RequirementsSheet.parse(req)).not.toThrow();

    // Check assets
    expect(req.assets.supplied_count).toBe(1);
    expect(req.assets.graphics_count).toBe(1);
    expect(req.assets.needs_external_count).toBe(0);
    expect(req.assets.missing_blocking_count).toBe(0);
    expect(req.assets.items).toHaveLength(2);

    // Check fonts
    expect(req.fonts.face).toBe("sans");
    expect(req.fonts.weight).toBe("bold");
    expect(req.fonts.declared_brand_fonts).toEqual(["Inter", "Roboto"]);

    // Check sound
    expect(req.sound.voiceover_scenes).toEqual(["S01"]);
    expect(req.sound.total_voiceover_words).toBe(8);
    expect(req.sound.audio_cues.map((c) => c.cue)).toEqual(["warm_acoustic_guitar", "whoosh_sfx"]);
    expect(req.sound.audio_supplied).toBe(false);

    expect(req.ready_for_review).toBe(true);
    expect(req.summary).toContain("Assets: 1 supplied, 1 graphics");
  });

  it("marks ready_for_review false when a blocking asset is missing", () => {
    const scenePlan = {
      project_id: "p1",
      version: 1,
      scenes: [
        {
          scene_id: "S01",
          purpose: "Hero",
          start_time: 0,
          end_time: 5,
          duration_seconds: 5,
          voiceover: null,
          production_method: "supplied_footage" as const,
          required_assets: [
            {
              asset_id: null,
              need: "Product hero video",
              kind: "footage" as const,
              availability: "missing_blocking" as const,
              placeholder: false,
              fallback: null,
            },
          ],
          unresolved: [],
          visual_purpose: null,
          visual: null,
          asset_ids: [],
          source_in_seconds: 0,
          claim_ids: [],
          shot: { shot_size: "medium" as const, camera_motion: "static" as const, visual_action: "product shot" },
          overlay: null,
          audio_cues: [],
          transition_out: "cut" as const,
          constraints: [],
        },
      ],
    };

    const req = produceGate1Requirements(scenePlan, Treatment.parse(treatment), []);
    expect(req.assets.missing_blocking_count).toBe(1);
    expect(req.ready_for_review).toBe(false);
  });

  it("Director graph carries requirementsSheet at Gate 1", async () => {
    const llm = new ScriptedClient([{ status: "ready", questions: [] }, treatment, goodStoryboard, goodEdit]);
    const graph = buildDirectorGraph(deps(llm));
    const gate1 = await graph.invoke(input, cfg("t-d2"));

    expect(gate1.status).toBe("awaiting_approval");
    expect(gate1.gate).toBe("storyboard");
    expect(gate1.requirementsSheet).toBeDefined();
    expect(gate1.requirementsSheet?.storyboard_version).toBe(1);
    expect(gate1.requirementsSheet?.assets).toBeDefined();
    expect(gate1.requirementsSheet?.fonts).toBeDefined();
    expect(gate1.requirementsSheet?.sound).toBeDefined();
  });
});
