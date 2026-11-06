import { PreflightResult as PreflightResultSchema, RenderSettings, preflightResultHash, type PreflightResult, type PreflightStatus, type PreflightSceneResult, type Asset } from "@digikon/contracts";
import type { PreflightRequest } from "@digikon/director";
import type { AdapterRegistry } from "./adapter.js";
import type { AssetFileResolver } from "./asset-layers.js";
import type { Engine } from "./capabilities.js";
import { planSceneJob } from "./scene-job.js";

/**
 * The trusted pre-flight. It takes the operations the Editor compiled and, scene by scene, builds the very job final assembly would build (`planSceneJob`) and asks the
 * adapter's own planner (`adapter.check`) whether it can draw it. Nothing is rendered. It is the only producer of a sealed \`PreflightResult\`: the Director cannot mark a
 * plan as having passed, it can only record what this function returns, and render time runs it again.
 *
 * It judges one frame size: layout refusals (text that does not fit, a picture covering the text, as in S06) depend on it. The size is recorded in the result.
 *
 * A passed pre-flight means the adapters' planners accepted each picture scene's job at the reference frame. It does NOT mean the film is renderable: see
 * `RENDER_TIME_VALIDATIONS`, which assembly runs today and the render stage must run again with the real settings before any render is authorised.
 */

/**
 * Checks the pre-flight deliberately does not perform, because they need the real render settings, the finished handoff or the neighbouring scenes. Each one is a mandatory
 * render-time validation (Stage 3.4), not something a passed pre-flight guarantees. They are not duplicated here: assembly (`planAssembly`) already runs them, and sharing
 * that logic would mean copying the renderer's rules into the pre-flight.
 */
export const RENDER_TIME_VALIDATIONS: readonly string[] = [
  "previewCoverage: supplied images and videos actually shown, overlay text present, camera motion, required assets, caption timing (coverage.ts)",
  "transition application: frame budget against both neighbouring scenes at the real fps, xfade mapping, match-cut neighbour requirements (assemble.ts)",
  "whole-frame scene durations at the real fps for every scene, including audio-only and join-only scenes",
  "the planners again at the real width, height, fps, aspect ratio, container and codecs (layout refusals depend on frame size)",
  "asset presence and resolved file paths on disk",
  "the implementation and engine chosen by the renderer equal the approved production plan (selection-integrity.ts)",
  "the operations handed to the renderer equal the compiled plan the Director approved (compiled hash)",
];

export interface PreflightOptions {
  adapters: AdapterRegistry;
  outputRoot: string;
  /** The film's real output settings. When given they replace the reference settings: the planners judge every scene at the frame size, fps and duration that will be rendered. */
  settings?: RenderSettings;
  /** The frame to plan at. Defaults to a standard preview size for the project's aspect ratio. */
  frame?: { width: number; height: number; fps: number };
  /** How the renderer reads a placed picture (for scenes that place pictures with asset_refs). */
  assetFiles?: AssetFileResolver;
}

export const DEFAULT_PREFLIGHT_FRAMES: Readonly<Record<PreflightRequest["aspect_ratio"], { width: number; height: number; fps: number }>> = {
  "16:9": { width: 960, height: 540, fps: 30 },
  "9:16": { width: 540, height: 960, fps: 30 },
  "1:1": { width: 720, height: 720, fps: 30 },
};

/** The reference settings the pre-flight plans every scene job with. Exported so a test can build the job final assembly would build from the same inputs. */
export function preflightSettings(req: Pick<PreflightRequest, "aspect_ratio" | "scenePlan">, frame: { width: number; height: number; fps: number }): RenderSettings {
  const total = req.scenePlan.scenes.reduce((n, s) => n + s.duration_seconds, 0);
  return RenderSettings.parse({
    aspect_ratio: req.aspect_ratio, width: frame.width, height: frame.height, fps: frame.fps, duration_s: total, container: "mp4", video_codec: "h264", audio_codec: null,
    source: { kind: "user_approved", reference: "pre-flight reference frame; the real settings are checked again at render time" },
  });
}

/**
 * Builds a pre-flight result with its hash. It lives here, not in the contracts API: this module is the only one that mints a sealed result, because it is the one that runs
 * the adapters' planners. The schema (`PreflightResult`) still rejects a pass without the evidence of a planner having run, and the Director re-verifies the hash. That is
 * in-process trust by construction, not a signature: code that imports the schema and the hash function could still build one, which a test guards against (see
 * `preflight-boundary.test.ts`).
 */
export function sealPreflightResult(body: { status: PreflightStatus; frame: { width: number; height: number; fps: number }; bound_selection_hash: string; bound_compiled_hash: string; scenes: PreflightSceneResult[] }): PreflightResult {
  return PreflightResultSchema.parse({ ...body, result_hash: preflightResultHash(body) });
}

export function runAdapterPreflight(req: PreflightRequest, opts: PreflightOptions): PreflightResult {
  const frame = opts.settings ? { width: opts.settings.width, height: opts.settings.height, fps: opts.settings.fps } : opts.frame ?? DEFAULT_PREFLIGHT_FRAMES[req.aspect_ratio];
  const settings = opts.settings ?? preflightSettings(req, frame);
  const handoff = { storyboard: req.scenePlan, treatment: { art_direction: req.art_direction }, assets: req.assets as readonly Asset[], edit_plan: { composition_motion: req.composition_motion } };
  const scenes: PreflightSceneResult[] = [];

  for (const scene of [...req.scenePlan.scenes].sort((a, b) => a.start_time - b.start_time)) {
    const ops = req.operations.filter((o) => o.target_scene_id === scene.scene_id);
    const visual = ops.filter((o) => o.operation_type !== "concat" && o.operation_type !== "mix_audio");
    const refs = [...new Set(visual.map((o) => req.templates[o.operation_id] ?? "").filter(Boolean))].sort();
    const frames = Math.round(scene.duration_seconds * frame.fps);
    if (visual.length && (frames < 1 || Math.abs(frames / frame.fps - scene.duration_seconds) > 1e-6)) {
      scenes.push({ scene_id: scene.scene_id, status: "failed", kind: "refused", engine: null, planner: null, template_refs: refs, job_fingerprint: null, diagnostics: [`${scene.duration_seconds}s is not a whole number of frames at ${frame.fps} fps`] });
      continue;
    }
    const r = planSceneJob({
      scene, visual,
      info: (o) => {
        const ref = req.templates[o.operation_id] ?? "";
        const t = ref && opts.adapters.supports(ref, o.operation_type) ? opts.adapters.template(ref) : null;
        return { template: ref, renderer: (t?.renderer as Engine | undefined) ?? null, unsupported: `${o.operation_id} (${o.recipe_id}) has no live renderer: ${ref || "(no template)"} is not registered for ${o.operation_type}` };
      },
      adapters: opts.adapters, settings, handoff, assetFiles: opts.assetFiles, outputRoot: opts.outputRoot,
    });
    if (r.ok) {
      // an adapter that offers no check cannot vouch for a scene, so it cannot pass one
      if (!r.adapter.check) scenes.push({ scene_id: scene.scene_id, status: "failed", kind: "refused", engine: r.engine, planner: null, template_refs: refs, job_fingerprint: r.fingerprint, diagnostics: [`the ${r.engine} adapter offers no pre-flight check, so this scene cannot be vouched for`] });
      else scenes.push({ scene_id: scene.scene_id, status: "passed", kind: "ok", engine: r.engine, planner: `${r.engine} adapter.check`, template_refs: refs, job_fingerprint: r.fingerprint, diagnostics: [] });
    } else if (r.kind === "no_operation") {
      scenes.push({ scene_id: scene.scene_id, status: "not_applicable", kind: "no_operation", engine: null, planner: null, template_refs: refs, job_fingerprint: null, diagnostics: [r.reason] });
    } else {
      scenes.push({ scene_id: scene.scene_id, status: "failed", kind: r.kind, engine: r.engine, planner: r.kind === "refused" ? `${r.engine} adapter.check` : null, template_refs: refs, job_fingerprint: r.fingerprint, diagnostics: r.issues.length ? r.issues : [r.reason] });
    }
  }
  if (!scenes.some((s) => s.status === "passed" || s.status === "failed")) throw new Error("the pre-flight found no scene with a picture to plan");
  return sealPreflightResult({ status: scenes.some((s) => s.status === "failed") ? "failed" : "passed", frame, bound_selection_hash: req.selection_hash, bound_compiled_hash: req.compiled_hash, scenes });
}
