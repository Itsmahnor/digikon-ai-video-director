import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { RenderSettings, hashCanonical, soundPolicyOf, type CompositionMotionPlan, type Asset, type EditorOperation, type ScenePlan, type Treatment } from "@digikon/contracts";
import { createHash } from "node:crypto";
import type { AdapterRegistry } from "./adapter.js";
import { checkMixedAudio, mixAudio, planAudio, type AudioCapabilities } from "./audio.js";
import type { Engine } from "./capabilities.js";
import { DRAFT_LABEL, DRAFT_PREFIX } from "./draft-label.js";
import { loadFontRecords } from "./fonts.js";
import { validateOutput } from "./output.js";
import { jobFingerprint, planSceneJob } from "./scene-job.js";
import { sceneSound } from "./scene-preview.js";
import type { AssetFileResolver } from "./asset-layers.js";

const run = promisify(execFile);
/** Bump when the burned-in label changes, so earlier cached drafts are drawn again. */
const DRAFT_LABEL_VERSION = 2;

/**
 * A DRAFT preview of one scene, made from a plan that has NOT been approved yet (while the edit plan waits at Gate 2). It is a different path from the production render:
 *  - it only plans and renders one scene's job with the same planner and adapter the final film would use, but into its own folder (`draftDir`), never the production output;
 *  - the file is named `draft-<key>.mp4`, carries a burned-in "DRAFT" label and a sidecar saying so, and `validateOutput` refuses any file with that name, so it cannot be accepted as a render;
 *  - it never reads or writes an approval, a render record or a delivery report, and it satisfies no part of the production gate (the render route still needs both approvals and the hash-bound production record);
 *  - the cache key is a hash of the scene's job, its asset bytes, the fonts and its sound, so an unchanged scene is not drawn again.
 */
export interface DraftRequest {
  scenePlan: ScenePlan;
  assets: readonly Asset[];
  art_direction: Treatment["art_direction"] | null;
  /** The compiled operations of the plan that is waiting for approval, and the implementation each will run. */
  operations: readonly EditorOperation[];
  templates: Readonly<Record<string, string>>;
  aspect_ratio: "16:9" | "9:16" | "1:1";
  /** The edit plan's motion changes for composed scenes (the draft shows the plan as proposed, motion included). */
  composition_motion?: readonly CompositionMotionPlan[];
  /** The project's brief, so the sound rule in it (narration only, no music ...) applies to the draft as it will to the film. */
  brief?: string;
}

/** A frame large enough to judge the scene by, whatever the final output size will be chosen as later. */
export const DRAFT_FRAMES: Readonly<Record<DraftRequest["aspect_ratio"], { width: number; height: number; fps: number }>> = {
  "16:9": { width: 1280, height: 720, fps: 30 },
  "9:16": { width: 720, height: 1280, fps: 30 },
  "1:1": { width: 900, height: 900, fps: 30 },
};

export interface DraftOptions {
  /** Adapters built with an output root INSIDE `draftDir`, never the production output folder. */
  adapters: AdapterRegistry;
  draftDir: string;
  fontFile: string;
  assetFiles?: AssetFileResolver;
  audio?: AudioCapabilities | null;
  ffmpeg?: string;
  signal?: AbortSignal;
}

export type DraftResult =
  | { ok: true; draft: true; label: string; path: string; key: string; cached: boolean; engine: string; notes: string[]; bytes: number; sha256: string; sound: boolean; scene_id: string }
  | { ok: false; reason: string; key: string | null };

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const fileHash = (p: string) => { try { return sha(readFileSync(p)); } catch { return "unreadable"; } };

function planOne(req: DraftRequest, sceneId: string, opts: DraftOptions) {
  const scene = req.scenePlan.scenes.find((s) => s.scene_id === sceneId);
  if (!scene) return { ok: false as const, reason: `there is no scene ${sceneId} in the storyboard` };
  const ops = req.operations.filter((o) => o.target_scene_id === sceneId);
  const visual = ops.filter((o) => o.operation_type !== "concat" && o.operation_type !== "mix_audio");
  const frame = DRAFT_FRAMES[req.aspect_ratio];
  const total = req.scenePlan.scenes.reduce((n, s) => n + s.duration_seconds, 0);
  const settings = RenderSettings.parse({ aspect_ratio: req.aspect_ratio, ...frame, duration_s: total, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "draft preview frame; the real output settings are chosen later" } });
  const handoff = { storyboard: req.scenePlan, treatment: { art_direction: req.art_direction }, assets: req.assets as readonly Asset[], edit_plan: { composition_motion: req.composition_motion } };
  const r = planSceneJob({
    scene, visual,
    info: (o) => {
      const ref = req.templates[o.operation_id] ?? "";
      const t = ref && opts.adapters.supports(ref, o.operation_type) ? opts.adapters.template(ref) : null;
      return { template: ref, renderer: (t?.renderer as Engine | undefined) ?? null, unsupported: `${o.operation_id} (${o.recipe_id}) has no live renderer: ${ref || "(no template)"} is not registered for ${o.operation_type}` };
    },
    adapters: opts.adapters, settings, handoff, assetFiles: opts.assetFiles, outputRoot: join(opts.draftDir, "work"),
  });
  return { ok: true as const, scene, settings, r };
}

export function draftKey(req: DraftRequest, sceneId: string, opts: Pick<DraftOptions, "adapters" | "draftDir" | "fontFile" | "assetFiles" | "audio">): string | null {
  const p = planOne(req, sceneId, opts as DraftOptions);
  if (!p.ok || !p.r.ok) return null;
  const job = p.r.job;
  const assets = [...job.assets].sort((a, b) => a.asset_id.localeCompare(b.asset_id)).map((a) => [a.asset_id, fileHash(a.uri)]);
  const audioPlan = opts.audio ? planAudio({ scenes: req.scenePlan.scenes, assets: req.assets, feel: req.art_direction?.motion_language.feel ?? null, policy: soundPolicyOf(req.brief) }, opts.audio) : null;
  const sound = audioPlan ? sceneSound({ scenes: req.scenePlan.scenes.map((s) => ({ scene_id: s.scene_id, start_s: s.start_time })), audio: audioPlan }, sceneId) : null;
  const sounds = sound ? sound.tracks.map((t) => [t, "asset_id" in t ? fileHash(req.assets.find((a) => a.asset_id === t.asset_id)?.uri ?? "") : null]) : null;
  return hashCanonical({ stage: "draft_scene_preview", label: DRAFT_LABEL_VERSION, job: jobFingerprint(job), engine: p.r.engine, assets, fonts: loadFontRecords().map((r) => r.sha256), font: fileHash(opts.fontFile), sound: sounds, tts: sound ? opts.audio!.tts : null });
}

export async function renderDraftScene(req: DraftRequest, sceneId: string, opts: DraftOptions): Promise<DraftResult> {
  const p = planOne(req, sceneId, opts);
  if (!p.ok) return { ok: false, reason: p.reason, key: null };
  if (!p.r.ok) return { ok: false, reason: p.r.reason, key: null };
  const { job, adapter, engine } = p.r;
  const key = draftKey(req, sceneId, opts)!;
  mkdirSync(opts.draftDir, { recursive: true });
  const path = join(opts.draftDir, `${DRAFT_PREFIX}${key.slice(0, 32)}.mp4`), meta = `${path}.json`;
  const audioPlan = opts.audio ? planAudio({ scenes: req.scenePlan.scenes, assets: req.assets, feel: req.art_direction?.motion_language.feel ?? null, policy: soundPolicyOf(req.brief) }, opts.audio) : null;
  const sound = audioPlan ? sceneSound({ scenes: req.scenePlan.scenes.map((s) => ({ scene_id: s.scene_id, start_s: s.start_time })), audio: audioPlan }, sceneId) : null;
  if (existsSync(path) && existsSync(meta)) {
    const m = JSON.parse(readFileSync(meta, "utf8")) as { bytes: number; sha256: string };
    if (m.bytes === statSync(path).size) return { ok: true, draft: true, label: DRAFT_LABEL, path, key, cached: true, engine, notes: [], bytes: m.bytes, sha256: m.sha256, sound: !!sound, scene_id: sceneId };
  }
  const made = job.output_path;
  const work = mkdtempSync(join(opts.draftDir, "work-"));
  const ff = opts.ffmpeg ?? "ffmpeg";
  try {
    mkdirSync(dirname(made), { recursive: true });
    const r = await adapter.render({ ...job, signal: opts.signal ?? new AbortController().signal });
    const v = await validateOutput(made, job.settings, false);
    if (!v.ok) return { ok: false, reason: `the scene's draft clip is not what was planned: ${v.issues.join("; ")}`, key };
    const notes: string[] = (r && typeof r === "object" ? r.notes : undefined) ?? [];
    let picture = made;
    if (sound && opts.audio) {
      const mixed = join(work, "mixed.mp4");
      const files = new Map(req.assets.map((a) => [a.asset_id, a.uri]));
      await mixAudio({ plan: sound, video: made, duration_s: p.scene.duration_seconds, out: mixed, work, caps: opts.audio, assetFile: (id) => files.get(id) ?? null, ffmpeg: ff, ...(opts.signal ? { signal: opts.signal } : {}) });
      const heard = await checkMixedAudio(mixed, sound, ff);
      if (!heard.ok) return { ok: false, reason: `the scene's sound: ${heard.problems.join("; ")}`, key };
      picture = mixed;
      notes.push(...sound.labels);
    }
    for (const u of audioPlan?.unresolved.filter((x) => x.scene_id === sceneId) ?? []) notes.push(`no sound for this scene: ${u.detail}`);
    // the label is part of the picture: a draft cannot be shown, copied or sent on without it
    copyFileSync(opts.fontFile, join(work, "font.ttf"));
    writeFileSync(join(work, "label.txt"), DRAFT_LABEL, "utf8");
    copyFileSync(picture, join(work, "in.mp4"));
    // sized so the whole label fits the frame width in portrait as well as landscape
    const size = Math.max(12, Math.floor(Math.min(job.settings.width / 34, job.settings.height / 20)));
    await run(ff, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-i", "in.mp4", "-vf", `drawtext=fontfile=font.ttf:textfile=label.txt:expansion=none:fontcolor=white:fontsize=${size}:box=1:boxcolor=red@0.75:boxborderw=${Math.round(size / 3)}:x=${Math.round(size / 2)}:y=${Math.round(size / 2)},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", "out.mp4"], { cwd: work, timeout: 120_000, windowsHide: true });
    copyFileSync(join(work, "out.mp4"), path);
    const bytes = statSync(path).size, sha256 = sha(readFileSync(path));
    writeFileSync(meta, JSON.stringify({ draft: true, final: false, label: DRAFT_LABEL, scene_id: sceneId, key, bytes, sha256 }));
    return { ok: true, draft: true, label: DRAFT_LABEL, path, key, cached: false, engine, notes, bytes, sha256, sound: !!sound, scene_id: sceneId };
  } catch (e) {
    return { ok: false, reason: ((e as { stderr?: string }).stderr || (e instanceof Error ? e.message : String(e))).trim().slice(0, 400), key };
  } finally {
    rmSync(made, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}