import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashCanonical } from "@digikon/contracts";
import type { AssemblyPlan } from "./assemble.js";
import { checkMixedAudio, mixAudio, type AudioCapabilities, type AudioPlan, type AudioTrack } from "./audio.js";
import { jobFingerprint } from "./scene-job.js";
import { loadFontRecords } from "./fonts.js";
import { validateOutput } from "./output.js";

/**
 * A preview of one scene at the film's final resolution, cached by a hash of everything that shapes its pixels: the scene's render job (operations, templates, settings,
 * visuals), the bytes of the assets it uses, and the fonts. A scene that did not change is not rendered again; a changed scene gets a new key and renders alone.
 */
export type ScenePreviewResult =
  | { ok: true; path: string; key: string; cached: boolean; engine: string; notes: string[]; bytes: number; sha256: string; sound: boolean }
  | { ok: false; reason: string; key: string | null };

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const fileHash = (p: string) => { try { return sha(readFileSync(p)); } catch { return "unreadable"; } };

/** The sound that belongs to one scene, with its times counted from the scene's own start; the music bed (if any) runs under it. */
export function sceneSound(plan: { scenes: readonly { scene_id: string; start_s: number }[]; audio: AudioPlan | null }, sceneId: string): AudioPlan | null {
  const sp = plan.scenes.find((s) => s.scene_id === sceneId);
  if (!plan.audio || !sp) return null;
  const tracks: AudioTrack[] = plan.audio.tracks.flatMap((t): AudioTrack[] => t.kind === "music" ? [t] : t.scene_id !== sceneId ? [] : t.kind === "narration" ? [{ ...t, start_s: Math.max(0, t.start_s - sp.start_s) }] : [{ ...t, at_s: Math.max(0, t.at_s - sp.start_s) }]);
  return tracks.length ? { ...plan.audio, tracks, unresolved: plan.audio.unresolved.filter((u) => u.scene_id === sceneId) } : null;
}

export function scenePreviewKey(plan: AssemblyPlan, sceneId: string, fontFile: string, audio?: AudioCapabilities | null): string | null {
  const sp = plan.scenes.find((s) => s.scene_id === sceneId);
  if (!sp?.job) return null;
  const assets = [...sp.job.assets].sort((a, b) => a.asset_id.localeCompare(b.asset_id)).map((a) => [a.asset_id, fileHash(a.uri)]);
  const fonts = loadFontRecords().map((r) => r.sha256);
  const sound = audio ? sceneSound(plan, sceneId) : null;
  const sounds = sound ? sound.tracks.map((t) => [t, "asset_id" in t ? fileHash(plan.base.record.assets.find((a) => a.asset_id === t.asset_id)?.uri ?? "") : null]) : null;
  return hashCanonical({ stage: "scene_preview", job: jobFingerprint(sp.job), engine: sp.engine, assets, fonts, font: fileHash(fontFile), sound: sounds, tts: sound ? audio!.tts : null });
}

export async function renderScenePreview(plan: AssemblyPlan, sceneId: string, opts: { cacheDir: string; fontFile: string; signal?: AbortSignal; /** When the machine has an audio stage, the scene's own sound (narration, effects, the music bed) is mixed under the preview. */ audio?: AudioCapabilities | null }): Promise<ScenePreviewResult> {
  const sp = plan.scenes.find((s) => s.scene_id === sceneId);
  if (!sp) return { ok: false, reason: `there is no scene ${sceneId} in this plan`, key: null };
  if (!sp.renderable || !sp.job || !sp.adapter) return { ok: false, reason: sp.reason ?? "nothing on this machine can draw this scene yet", key: null };
  const key = scenePreviewKey(plan, sceneId, opts.fontFile, opts.audio)!;
  mkdirSync(opts.cacheDir, { recursive: true });
  const path = join(opts.cacheDir, `${key.slice(0, 32)}.mp4`);
  const meta = `${path}.json`;
  if (existsSync(path) && existsSync(meta) && statSync(path).size > 0) {
    const m = JSON.parse(readFileSync(meta, "utf8")) as { bytes: number; sha256: string };
    if (m.bytes === statSync(path).size) return { ok: true, path, key, cached: true, engine: sp.engine ?? "", notes: [], bytes: m.bytes, sha256: m.sha256, sound: !!(opts.audio && sceneSound(plan, sceneId)) };
  }
  const made = sp.job.output_path;
  try {
    // the adapter only writes the render file the job was planned with (inside its output folder); the finished clip is then moved into the cache
    mkdirSync(dirname(sp.job.output_path), { recursive: true });
    const r = await sp.adapter.render({ ...sp.job, signal: opts.signal ?? new AbortController().signal });
    const v = await validateOutput(made, sp.job.settings, false);
    if (!v.ok) { rmSync(made, { force: true }); return { ok: false, reason: `the scene's clip is not what was approved: ${v.issues.join("; ")}`, key }; }
    const sound = opts.audio ? sceneSound(plan, sceneId) : null;
    const notes: string[] = (r && typeof r === "object" ? r.notes : undefined) ?? [];
    if (sound && opts.audio) {
      // the scene's own sound, laid under the picture the way the finished film is made; what cannot be made is said, never dropped silently
      const work = mkdtempSync(join(dirname(path), "mix-"));
      const files = new Map(plan.base.record.assets.map((a) => [a.asset_id, a.uri]));
      try {
        rmSync(path, { force: true });
        await mixAudio({ plan: sound, video: made, duration_s: sp.duration_s, out: path, work, caps: opts.audio, assetFile: (id) => files.get(id) ?? null, ...(opts.signal ? { signal: opts.signal } : {}) });
        const heard = await checkMixedAudio(path, sound);
        if (!heard.ok) { rmSync(path, { force: true }); rmSync(made, { force: true }); return { ok: false, reason: `the scene's sound: ${heard.problems.join("; ")}`, key }; }
      } finally { rmSync(work, { recursive: true, force: true }); }
      notes.push(...sound.labels);
    } else copyFileSync(made, path);
    for (const u of plan.audio?.unresolved.filter((x) => x.scene_id === sceneId) ?? []) notes.push(`no sound for this scene: ${u.detail}`);
    rmSync(made, { force: true });
    const bytes = statSync(path).size, sha256 = sha(readFileSync(path));
    writeFileSync(meta, JSON.stringify({ bytes, sha256 }));
    return { ok: true, path, key, cached: false, engine: sp.engine ?? "", notes, bytes, sha256, sound: !!sound };
  } catch (e) {
    rmSync(made, { force: true });
    return { ok: false, reason: (e instanceof Error ? e.message : String(e)).slice(0, 400), key };
  }
}