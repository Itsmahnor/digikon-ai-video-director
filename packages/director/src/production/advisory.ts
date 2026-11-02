import {
  AdvisoryReport, assetFeasibility, queryCapabilities, type CapabilitySnapshot,
  type AdvisoryRequirement, type AdvisoryVerdict, type Asset, type Capability, type Renderer, type Scene, type ScenePlan,
} from "@digikon/contracts";
import { sceneMedia, sceneQuery } from "./plan.js";

/**
 * Advisory feasibility for Gate 1: a pure function of the storyboard, the assets and the registry as it is now. It looks at what the storyboard REQUIRES
 * (a drawn visual, a picture or clip, on-screen text, a graphics-only scene, a transition, audio, supplied material) and says whether any live-resolved
 * capability could carry each requirement out. It names no recipe and no engine, selects nothing and authorizes nothing: choosing the recipe, variant and engine is
 * the production decision plan's job after Gate 1. A registered capability whose implementation is not live-resolved is never counted.
 */

type OperationType = Capability["operations"][number];

export interface AdvisoryInput {
  scenePlan: ScenePlan;
  assets: readonly Asset[];
  aspect_ratio: NonNullable<Capability["aspect_ratios"]>[number];
  available_engines: readonly Renderer[];
}

/** The recipe a storyboard transition becomes. A hard cut draws nothing. Needed only to ask whether that requirement can be met at all. */
const TRANSITION_NEEDS: Record<string, string | null> = { cut: null, match_cut: "match-cut", crossfade: "crossfade", dip_to_black: "dip-to-black", wipe: "directional-wipe" };
const ASSET_STAGE_RECIPES = ["asset-stage-ffmpeg", "asset-stage-hyperframes"];

const req = (kind: AdvisoryRequirement["kind"], description: string, verdict: AdvisoryVerdict, candidate_count: number, reasons: string[], details: string[]): AdvisoryRequirement => ({ kind, description, verdict, candidate_count, reasons, details });

function operationRequirement(snap: CapabilitySnapshot, scene: Scene, i: AdvisoryInput, kind: AdvisoryRequirement["kind"], description: string, op: OperationType): AdvisoryRequirement {
  const r = queryCapabilities(snap, sceneQuery(scene, i.assets, i, op));
  const live = r.candidates.filter((c) => c.capability.variant_of === null);
  if (live.length) {
    const unknown = [...new Set(live.flatMap((c) => c.unknowns))];
    return req(kind, description, unknown.length && live.every((c) => c.unknowns.length) ? "uncertain" : "producible", live.length,
      [], [`${live.length} live-resolved capabilit${live.length === 1 ? "y" : "ies"} could carry this out; none is selected yet`, ...(unknown.length ? [`not recorded by the registry: ${unknown.join(", ")}`] : [])]);
  }
  const why = [...new Set(r.rejected.filter((x) => x.rejections.length).flatMap((x) => x.rejections.map((y) => y.code)))].sort();
  return req(kind, description, "not_producible", 0, why, [`no live-resolved capability implements ${op} for ${sceneMedia(scene, i.assets).join("/")} media at ${scene.duration_seconds}s in ${i.aspect_ratio} on ${i.available_engines.join(", ") || "any available engine"}`]);
}

function visualRequirement(snap: CapabilitySnapshot, scene: Scene, i: AdvisoryInput): AdvisoryRequirement {
  const block = scene.visual!.block;
  const live = (c: Capability | undefined) => !!c && c.status !== "registered" && c.status !== "deprecated" && !!c.engine && i.available_engines.includes(c.engine);
  if (block === "asset_stage") {
    const n = ASSET_STAGE_RECIPES.map((id) => snap.capabilities.find((c) => c.recipe_id === id && c.variant_of === null)).filter(live).length;
    return n ? req("visual_block", "the asset_stage visual", "producible", n, [], [`${n} live-resolved asset-stage capabilit${n === 1 ? "y" : "ies"}; none is selected yet`])
      : req("visual_block", "the asset_stage visual", "not_producible", 0, ["VISUAL_BLOCK_NOT_EXECUTABLE"], ["no asset-stage capability is live-resolved on an available engine"]);
  }
  const entry = snap.capabilities.find((c) => c.capability_id === `remotion:scene-composition:${block}`);
  if (live(entry)) {
    const stale = entry!.verification.historical_evidence !== "current";
    return req("visual_block", `the ${block} visual`, stale ? "uncertain" : "producible", 1, stale ? ["HISTORICAL_EVIDENCE_" + entry!.verification.historical_evidence.toUpperCase()] : [],
      [`the ${block} visual block is live-resolved (${entry!.status})`, stale ? `its validation record is ${entry!.verification.historical_evidence}: it can be tried, but nothing here shows it still works` : "its validation record is current for the code it was validated against", "no current render has verified it"]);
  }
  return req("visual_block", `the ${block} visual`, "not_producible", 0, ["VISUAL_BLOCK_NOT_EXECUTABLE"], [entry ? `the ${block} visual block is ${entry.status}${entry.engine && !i.available_engines.includes(entry.engine) ? "; its engine is not available here" : ""}` : `no capability is registered for the ${block} visual`]);
}

function transitionRequirement(snap: CapabilitySnapshot, scene: Scene, i: AdvisoryInput): AdvisoryRequirement | null {
  const recipe = TRANSITION_NEEDS[scene.transition_out];
  if (!recipe) return null;
  const caps = snap.capabilities.filter((c) => c.recipe_id === recipe && c.variant_of === null);
  const ok = caps.filter((c) => c.status !== "registered" && c.status !== "deprecated" && c.engine && i.available_engines.includes(c.engine));
  return ok.length ? req("transition", `a ${scene.transition_out} transition after ${scene.scene_id}`, "producible", ok.length, [], ["a live-resolved capability can draw this transition; none is selected yet"])
    : req("transition", `a ${scene.transition_out} transition after ${scene.scene_id}`, "not_producible", 0, ["TRANSITION_NOT_EXECUTABLE"], ["no live-resolved capability draws this transition"]);
}

const worst = (rs: AdvisoryRequirement[]): AdvisoryVerdict => (rs.some((r) => r.verdict === "not_producible") ? "not_producible" : rs.some((r) => r.verdict === "uncertain") ? "uncertain" : "producible");

export function adviseFeasibility(snap: CapabilitySnapshot, i: AdvisoryInput): AdvisoryReport {
  const last = i.scenePlan.scenes[i.scenePlan.scenes.length - 1]?.scene_id;
  const external = assetFeasibility(i.scenePlan, i.assets).items.filter((x) => x.severity === "blocker");
  const warnings: string[] = [], limitations: string[] = [];
  const scenes = i.scenePlan.scenes.map((scene) => {
    const rs: AdvisoryRequirement[] = [];
    if (scene.visual) rs.push(visualRequirement(snap, scene, i));
    else {
      const hasMedia = scene.asset_ids.length > 0;
      rs.push(operationRequirement(snap, scene, i, hasMedia ? "scene_picture" : "graphics_scene", hasMedia ? `${sceneMedia(scene, i.assets).join("/")} shown in ${scene.scene_id}` : `a graphics-only ${scene.scene_id}`, hasMedia ? "trim_clip" : "render_graphics_scene"));
      if (scene.overlay) rs.push(operationRequirement(snap, scene, i, "on_screen_text", `on-screen text in ${scene.scene_id}`, "overlay_text"));
    }
    if (scene.scene_id !== last) { const t = transitionRequirement(snap, scene, i); if (t) rs.push(t); }
    for (const x of external.filter((e) => e.scene_id === scene.scene_id)) rs.push(req("external_asset", x.need, "not_producible", 0, ["EXTERNAL_ASSET_MISSING"], [x.message]));
    if (scene.voiceover || scene.audio_cues.length || scene.asset_ids.some((id) => i.assets.find((a) => a.asset_id === id)?.media_type === "audio")) {
      rs.push(req("audio", `audio in ${scene.scene_id}`, "uncertain", 0, ["AUDIO_NOT_PRODUCED"], ["audio (voiceover, music or effects) is not produced by this system yet"]));
      limitations.push(`${scene.scene_id}: audio is not produced yet`);
    }
    for (const r of rs) if (r.verdict === "not_producible") warnings.push(`${scene.scene_id}: ${r.description} cannot be produced now (${r.reasons.join(", ") || "no candidate"}). Consider changing the storyboard before approving it.`);
    return { scene_id: scene.scene_id, verdict: worst(rs), requirements: rs };
  });
  const count = (v: AdvisoryVerdict) => scenes.flatMap((s) => s.requirements).filter((r) => r.verdict === v).length;
  if (i.available_engines.length === 0) limitations.push("no rendering engine is available on this machine, so nothing can be produced here");
  return AdvisoryReport.parse({ mode: "advisory", snapshot_hash: snap.snapshot_hash, scenes, summary: { producible: count("producible"), uncertain: count("uncertain"), not_producible: count("not_producible") }, warnings, limitations: [...new Set(limitations)] });
}
