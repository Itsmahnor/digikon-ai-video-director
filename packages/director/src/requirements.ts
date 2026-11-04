import {
  Gate1RequirementsSheet,
  VISUAL_SYSTEMS,
  type Asset,
  type ProjectKit,
  type ScenePlan,
  type Treatment,
} from "@digikon/contracts";

/**
 * Produces the Gate 1 requirements sheet: what the story needs from assets, fonts, and sound
 * before the human reviewer decides on Gate 1 approval.
 */
export function produceGate1Requirements(
  scenePlan: ScenePlan,
  treatment: Treatment,
  assets: readonly Asset[],
  kit?: ProjectKit | null,
): Gate1RequirementsSheet {
  // 1. Assets analysis
  const assetItems: Gate1RequirementsSheet["assets"]["items"] = [];
  let suppliedCount = 0;
  let graphicsCount = 0;
  let externalCount = 0;
  let blockingCount = 0;

  for (const scene of scenePlan.scenes) {
    for (const req of scene.required_assets) {
      if (req.availability === "supplied") suppliedCount++;
      else if (req.availability === "generate_graphics") graphicsCount++;
      else if (req.availability === "needs_external") externalCount++;
      else if (req.availability === "missing_blocking") blockingCount++;

      assetItems.push({
        scene_id: scene.scene_id,
        kind: req.kind,
        need: req.need,
        availability: req.availability,
        placeholder: req.placeholder,
        fallback: req.fallback ?? null,
      });
    }
  }

  // 2. Fonts analysis
  const systemId = treatment.art_direction?.visual_system;
  const sys = systemId ? VISUAL_SYSTEMS[systemId] : null;
  const face = treatment.art_direction?.typography?.face ?? sys?.face ?? "sans";
  const weight = treatment.art_direction?.typography?.weight ?? "bold";
  const scale = treatment.art_direction?.typography?.scale ?? "standard";
  const typographyCase = treatment.art_direction?.typography?.case ?? "sentence";
  const rationale = treatment.art_direction?.typography?.rationale ?? "Selected for readability and tone.";

  const kitFonts = kit?.brand?.fonts?.value ?? [];
  const declaredBrandFonts = Array.isArray(kitFonts) ? (kitFonts as string[]) : [];

  // 3. Sound analysis
  const voScenes: string[] = [];
  let voWords = 0;
  const audioCues: { scene_id: string; cue: string }[] = [];

  for (const scene of scenePlan.scenes) {
    if (scene.voiceover && scene.voiceover.trim()) {
      voScenes.push(scene.scene_id);
      voWords += scene.voiceover.trim().split(/\s+/).length;
    }
    for (const cue of scene.audio_cues) {
      audioCues.push({ scene_id: scene.scene_id, cue });
    }
  }

  const audioSupplied = assets.some((a) => a.media_type === "audio");
  const systemSound = sys?.sound ?? null;

  // 4. Plain-language summary
  const summaryParts: string[] = [];
  summaryParts.push(
    `Assets: ${suppliedCount} supplied, ${graphicsCount} graphics${
      externalCount ? `, ${externalCount} external needed` : ""
    }${blockingCount ? `, ${blockingCount} missing blocking` : ""}.`,
  );
  summaryParts.push(`Typography: ${face} typeface (${weight}, ${scale} scale, ${typographyCase} case).`);
  summaryParts.push(
    `Sound: voiceover in ${voScenes.length} scene(s) (~${voWords} words), ${audioCues.length} audio cue(s)${
      audioSupplied ? ", audio files supplied" : ""
    }.`,
  );

  return Gate1RequirementsSheet.parse({
    format: "digikon.gate1-requirements",
    format_version: 1,
    storyboard_version: scenePlan.version,
    assets: {
      supplied_count: suppliedCount,
      graphics_count: graphicsCount,
      needs_external_count: externalCount,
      missing_blocking_count: blockingCount,
      items: assetItems,
    },
    fonts: {
      face,
      weight,
      scale,
      case: typographyCase,
      rationale,
      declared_brand_fonts: declaredBrandFonts,
    },
    sound: {
      voiceover_scenes: voScenes,
      total_voiceover_words: voWords,
      audio_cues: audioCues,
      system_sound: systemSound,
      audio_supplied: audioSupplied,
    },
    summary: summaryParts.join(" "),
    ready_for_review: blockingCount === 0,
  });
}
