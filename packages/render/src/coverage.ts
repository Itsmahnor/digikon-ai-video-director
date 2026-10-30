import type { DirectorHandoff, EditorOutput, RenderRecord } from "@digikon/contracts";

/** How far a caption's approved start or end may differ from its scene before it counts as differently timed. */
const CAPTION_TOLERANCE_S = 0.05;

export interface SceneCoverage {
  scene_id: string;
  /** True only when everything the approved scene asks for is shown by the render. */
  represented: boolean;
  /** What the render would leave out. Empty when represented. */
  missing: string[];
  /** Things the render shows with a visible label, for example a product screen shown as a concept, and approved details the renderer neither changes nor checks. Not a reason to refuse. */
  labelled: string[];
}

export interface PreviewCoverage {
  /** True only when every approved scene is fully shown. A render of less than this must not be offered as the video. */
  complete: boolean;
  scenes: SceneCoverage[];
}

/** What the renderer behind a plan can show beyond plain graphics. Anything not listed counts as not shown. */
export interface RenderCapabilities {
  /** Templates that show one supplied image. */
  image_templates: readonly string[];
  /** Templates that play one supplied video clip unchanged. */
  video_templates?: readonly string[];
  /** Templates that implement each approved transition, by the storyboard's transition name. */
  transition_templates: Readonly<Record<string, readonly string[]>>;
  /** Templates that carry out each approved camera motion, by the storyboard's name. `param` narrows a template to one parameter value (a pan's direction). */
  camera_templates?: Readonly<Record<string, readonly { template: string; param?: { name: string; value: string } }[]>>;
  /** Templates that show the supplied image of their own operation (a camera move on an image): that image counts as shown. */
  image_via_templates?: readonly string[];
  /** Templates that start their text at the approved `delay_s` themselves, so a delayed caption is carried out and not merely tolerated. */
  caption_timing_templates?: readonly string[];
  /** Templates that draw the scene from its approved visual spec: they draw its text, graphics, UI-style pictures and camera motion themselves. */
  drawn_templates?: readonly string[];
}

/**
 * Compares what the approved plan asks for with what the render can show, scene by scene. A scene that needs footage, a logo or
 * product screen that was not supplied, voiceover, audio or a transition nobody can render is not represented: nothing is
 * dropped silently and nothing is replaced by something invented. Placeholder graphics count as the content they stand in for,
 * so they do not pass. A supplied image is shown only by an operation that carries it.
 */
export function previewCoverage(handoff: DirectorHandoff, output: EditorOutput, record: Pick<RenderRecord, "operations">, caps: RenderCapabilities = { image_templates: [], transition_templates: {} }): PreviewCoverage {
  const supported = new Map(record.operations.filter((o) => o.renderer !== null).map((o) => [o.operation_id, o]));
  const assets = new Map(handoff.assets.map((a) => [a.asset_id, a]));
  const scenes = handoff.storyboard.scenes;
  const result = scenes.map((s, i): SceneCoverage => {
    const missing: string[] = [], labelled: string[] = [];
    const ops = output.operations.filter((o) => o.target_scene_id === s.scene_id);
    const sceneOps = ops.filter((o) => o.operation_type !== "concat");
    if (!sceneOps.length) missing.push("no operation covers this scene");
    for (const o of ops) if (!supported.has(o.operation_id)) missing.push(`${o.operation_id} (${o.recipe_id}) has no renderer that can run it`);
    const shown = sceneOps.filter((o) => supported.has(o.operation_id));
    // A scene drawn from its approved visual spec: the template draws the scene's text, its UI-style pictures and its camera itself.
    const drawn = !!s.visual && shown.some((o) => (caps.drawn_templates ?? []).includes(supported.get(o.operation_id)!.implementation_ref));
    if (s.overlay && !drawn && !shown.some((o) => o.caption)) missing.push("the scene's text is not shown by any operation");
    // Renderers show a caption for the whole scene, from its first frame. A caption approved for other times is not carried out, so it is reported.
    for (const o of shown) {
      if (!o.caption) continue;
      const end = s.start_time + s.duration_seconds;
      const ref = supported.get(o.operation_id)!.implementation_ref;
      const delay = (caps.caption_timing_templates ?? []).includes(ref) && typeof o.parameters["delay_s"] === "number" ? (o.parameters["delay_s"] as number) : 0;
      if (Math.abs(o.caption.start_s - (s.start_time + delay)) > CAPTION_TOLERANCE_S || Math.abs(o.caption.end_s - end) > CAPTION_TOLERANCE_S) {
        missing.push(`${o.operation_id}: its text is timed ${o.caption.start_s}s to ${o.caption.end_s}s, but the renderer shows text for the whole scene (${s.start_time}s to ${end}s) and has no caption timing`);
      }
    }
    // What the renderer does about the approved text placement is stated, never implied.
    if (drawn) labelled.push(`drawn from the approved visual spec (${s.visual!.block.replaceAll("_", " ")}) in the film's approved palette; pictures of a product, a chart or a thread are concept illustrations, never real captures or measured data`);
    else if (s.overlay) labelled.push(`text is centred and kept inside the middle 84% of the frame width; the approved ${s.overlay.safe_area === "platform_safe" ? "platform safe area" : "full-frame"} setting is not checked against any platform specification (none is verified in this project)`);
    labelled.push(`the approved shot size (${s.shot.shot_size.replaceAll("_", " ")}) and visual action ("${s.shot.visual_action.length > 60 ? `${s.shot.visual_action.slice(0, 59)}â€¦` : s.shot.visual_action}") describe the content; the renderer does not change or check them`);

    const shownImages = new Set(shown.filter((o) => caps.image_templates.includes(supported.get(o.operation_id)!.implementation_ref) || (caps.image_via_templates ?? []).includes(supported.get(o.operation_id)!.implementation_ref)).flatMap((o) => o.asset_ids));
    const videoOps = new Map(shown.filter((o) => (caps.video_templates ?? []).includes(supported.get(o.operation_id)!.implementation_ref)).flatMap((o) => o.asset_ids.map((id) => [id, o] as const)));
    for (const id of s.asset_ids) {
      const a = assets.get(id);
      if (!a) missing.push(`it uses ${id}, which is not in the approved assets`);
      else if (a.media_type === "video" && videoOps.has(id)) {
        if (a.audio_tracks > 0 && videoOps.get(id)!.parameters["source_audio"] !== "drop") missing.push(`its clip (${id}) has an audio track, audio cannot be produced yet, and the plan does not say to drop it (source_audio)`);
      } else if (a.media_type !== "image") missing.push(`it uses supplied ${a.media_type} (${id}), which this renderer cannot show yet`);
      else if (!shownImages.has(id)) missing.push(`its supplied image (${id}) is not shown by any operation`);
    }
    // Supplied media is played or shown unchanged. A camera move in the approved shot is not carried out, so it is not silently dropped.
    const motion = s.shot.camera_motion;
    const drawnMotion = drawn ? ({ static: "static", push_in: "slow_push_in", pull_out: "pull_out", pan_left: "pan_left", pan_right: "pan_right" } as Record<string, string>)[s.visual!.camera] : null;
    const moved = motion !== "static" && (drawnMotion === motion || (caps.camera_templates?.[motion] ?? []).some((c) => shown.some((o) => supported.get(o.operation_id)!.implementation_ref === c.template && (!c.param || o.parameters[c.param.name] === c.param.value))));
    if (motion !== "static" && !moved) missing.push(`the approved shot calls for camera motion (${s.shot.camera_motion.replaceAll("_", " ")}), but no renderer here has a camera-move template, so ${s.asset_ids.length ? "supplied media is shown unchanged" : "the scene would be shown static"}`);
    for (const r of s.required_assets) {
      if (r.kind === "graphics") continue;
      // a product screen, logo or picture that was not supplied is drawn as a labelled concept (a typeset wordmark for a logo) when the scene has a visual spec
      if (drawn && r.availability === "generate_graphics" && (r.kind === "ui_screenshot" || r.kind === "logo" || r.kind === "image")) { labelled.push(`${r.kind === "logo" ? "the brand mark is a typeset wordmark, not a logo" : r.kind === "ui_screenshot" ? "the product screen is a drawn concept illustration, not the real product" : "the picture is drawn graphics"} ("${r.need.slice(0, 60)}")`); continue; }
      const label = r.kind === "ui_screenshot" ? "a product screen" : r.kind === "logo" ? "a logo" : r.kind === "footage" ? "footage" : r.kind === "audio" ? "audio" : "an image";
      if (r.kind === "footage" && r.availability === "supplied" && r.asset_id && !r.placeholder && videoOps.has(r.asset_id)) continue;
      if (r.availability === "supplied" && r.asset_id && !r.placeholder && shownImages.has(r.asset_id)) {
        if (r.kind === "ui_screenshot" && assets.get(r.asset_id)?.genuine_product_ui !== true) labelled.push(`${r.asset_id} is shown as a concept, not as the real product (it was not declared a genuine capture)`);
      } else missing.push(`it needs ${label} ("${r.need}"${r.placeholder ? ", currently a placeholder" : r.availability !== "supplied" ? `, ${r.availability.replaceAll("_", " ")}` : ""}) that this renderer cannot show`);
    }
    if (s.voiceover) missing.push("it has voiceover, which cannot be produced yet");
    if (s.audio_cues.length) missing.push(`it has audio cues (${s.audio_cues.join("; ")}), which cannot be produced yet`);
    if (i < scenes.length - 1 && s.transition_out !== "cut") {
      const wanted = caps.transition_templates[s.transition_out] ?? [];
      const done = ops.some((o) => o.operation_type === "concat" && supported.has(o.operation_id) && wanted.includes(supported.get(o.operation_id)!.implementation_ref));
      if (!done) missing.push(`its ${s.transition_out.replaceAll("_", " ")} transition is not rendered (a hard cut would be used)`);
    }
    return { scene_id: s.scene_id, represented: missing.length === 0, missing, labelled };
  });
  return { complete: result.every((x) => x.represented), scenes: result };
}


