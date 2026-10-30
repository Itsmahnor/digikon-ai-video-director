import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { DirectorHandoff, EditorOutput, RenderRecord, RenderSettings, type EditorOperation, type RenderOutput } from "@digikon/contracts";
import { diagnoseOperations, type Engine, type OperationStatus } from "./capabilities.js";
import { previewCoverage, type RenderCapabilities } from "./coverage.js";
import { ffmpegCapabilities } from "./ffmpeg.js";
import type { RenderAdapter, RenderJob } from "./adapter.js";
import { jobVisuals } from "./composition.js";
import { validateOutput } from "./output.js";
import { planRender, type RenderDeps, type RenderInput } from "./render.js";
import { RENDERER_CAPABILITIES } from "./select.js";
import { rawFrame } from "./verify.js";

const run = promisify(execFile);

/**
 * Per-scene rendering and assembly. Each approved scene is rendered by the engine that can carry out all of its operations, as a clip with the
 * approved size and frame rate; FFmpeg joins the clips in the approved order, applies the approved transitions and encodes the final file once.
 * A scene nothing can render is not dropped: it becomes a labelled placeholder of the same length, the film is reported as a PARTIAL preview, and
 * every omitted operation is listed with its reason. A partial preview is a different kind of result from a rendered record and can never be
 * mistaken for a deliverable: final delivery needs every approved operation present and every check passed.
 */

export type DeliveryKind = "complete" | "partial" | "nothing";

const SceneOp = z.object({ operation_id: z.string(), recipe_id: z.string(), template: z.string(), operation_type: z.string(), status: z.enum(["validated_available", "learning_required", "learning_in_progress", "validation_failed", "blocked_with_reason", "rendered_and_verified"]), engine: z.enum(["ffmpeg", "remotion", "hyperframes"]).nullable(), reason: z.string() });
export const DeliveryReport = z.object({
  format: z.literal("digikon.delivery-report"),
  format_version: z.literal(1),
  delivery_id: z.string().regex(/^dl_[a-f0-9]{16}$/),
  render_id: z.string().regex(/^rn_[a-f0-9]{16}$/),
  kind: z.enum(["complete", "partial", "nothing"]),
  /** A preview is never a final deliverable while any recipe is a draft. */
  purpose: z.enum(["preview", "production"]),
  handoff_content_hash: z.string(),
  /** Each stage a result passes through, separately. None implies another. */
  states: z.object({
    plan_created: z.boolean(), plan_approved: z.boolean(),
    scenes_total: z.number().int(), scenes_rendered: z.number().int(), scenes_content_validated: z.number().int(),
    final_video_validated: z.boolean(), final_delivery_ready: z.boolean(),
  }),
  final_delivery_blockers: z.array(z.string()),
  label: z.string(),
  scenes: z.array(z.object({
    scene_id: z.string(), start_s: z.number(), duration_s: z.number(), frames: z.number().int(),
    status: z.enum(["rendered_and_verified", "rendered_unverified", "placeholder"]),
    engine: z.enum(["ffmpeg", "remotion", "hyperframes"]).nullable(),
    operations: z.array(SceneOp),
    /** What the scene still lacks: audio, a transition, anything approved that this scene does not show. */
    unmet: z.array(z.string()),
    omitted_reason: z.string().nullable(),
    content: z.object({ engine_checked: z.boolean(), end_to_end_checked: z.boolean(), checks: z.array(z.string()), limitations: z.array(z.string()) }),
    clip_sha256: z.string().nullable(),
  })),
  transitions: z.array(z.object({ after_scene: z.string(), operation_id: z.string(), template: z.string(), status: z.enum(["applied", "omitted"]), reason: z.string() })),
  omitted_operations: z.array(z.object({ operation_id: z.string(), scene_id: z.string(), recipe_id: z.string(), status: z.string(), reason: z.string() })),
  engines_used: z.array(z.enum(["ffmpeg", "remotion", "hyperframes"])),
  assembly: z.object({ tool: z.literal("ffmpeg"), ffmpeg_version: z.string(), lossy_encodes: z.number().int(), known_differences: z.array(z.string()) }),
  output: z.object({ path: z.string(), bytes: z.number(), sha256: z.string(), width: z.number(), height: z.number(), fps: z.number(), duration_s: z.number(), frames: z.number().int(), video_codec: z.string(), audio_tracks: z.number().int() }).nullable(),
  limitations: z.array(z.string()),
  created_at: z.string().datetime(),
});
export type DeliveryReport = z.infer<typeof DeliveryReport>;

export interface AssembleDeps extends RenderDeps {
  fontFile: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  workRoot?: string;
}

interface SceneOpState { operation_id: string; recipe_id: string; template: string; operation_type: string; status: OperationStatus; engine: Engine | null; reason: string }
interface ScenePlan {
  scene_id: string; index: number; start_s: number; duration_s: number; frames: number; from_frame: number;
  renderable: boolean; engine: Engine | null; adapter: RenderAdapter | null; job: Omit<RenderJob, "signal"> | null;
  operations: SceneOpState[]; unmet: string[]; reason: string | null;
}
interface TransitionPlan { after_scene: string; operation_id: string; template: string; xfade: string | null; frames: number; applied: boolean; reason: string }

export interface AssemblyPlan {
  render_id: string;
  purpose: "preview" | "production";
  settings: RenderSettings;
  handoff: DirectorHandoff;
  editor_output: EditorOutput;
  base: Extract<ReturnType<typeof planRender>, { ok: true }>;
  scenes: ScenePlan[];
  transitions: TransitionPlan[];
  omitted: { operation_id: string; scene_id: string; recipe_id: string; status: string; reason: string }[];
  /** Requirements nothing here can carry out for any scene (audio): they keep the film from being complete. */
  complete: boolean;
}

export type AssemblePlanResult = { ok: false; stage: "input" | "handoff" | "editor_output" | "settings"; reasons: string[] } | { ok: true; plan: AssemblyPlan };

/** The blockers that stop everything, as opposed to those that only stop one scene. */
const GLOBAL_BLOCKER = /^(no output settings|output settings|asset .* is not on disk|handoff is not production-ready)/;

/** The xfade transition an FFmpeg template stands for, from the built-in crossfade or a learned record. */
function xfadeFor(template: string, params: Record<string, unknown>, learned: readonly { template: string; xfade: string | null; direction_map: Record<string, string> | null }[]): string | null {
  if (template === "ffmpeg/xfade-fade") return "fade";
  const l = learned.find((x) => x.template === template);
  if (!l) return null;
  if (l.xfade) return l.xfade;
  const d = params["direction"];
  return typeof d === "string" && l.direction_map && Object.hasOwn(l.direction_map, d) ? l.direction_map[d]! : null;
}

/**
 * Decides, scene by scene, what can be rendered and by which engine, and what cannot and why. The approvals, the handoff and the settings are
 * checked by `planRender` first; a failure there stops everything. Otherwise an unsupported operation only stops its own scene.
 */
export function planAssembly(input: RenderInput, deps: AssembleDeps): AssemblePlanResult {
  const base = planRender({ ...input, purpose: input.purpose ?? "preview" }, deps);
  if (!base.ok) return { ok: false, stage: base.stage, reasons: base.reasons };
  const globals = base.record.blockers.filter((b) => GLOBAL_BLOCKER.test(b));
  if (globals.length || !base.record.settings) return { ok: false, stage: "settings", reasons: globals.length ? globals : ["no valid output settings"] };
  const h = DirectorHandoff.parse(input.handoff), out = EditorOutput.parse(input.editor_output);
  const settings = base.record.settings;
  const fps = settings.fps;
  const registry = deps.capabilities;
  const learnedT = registry ? registry.transitions("ffmpeg") : [];
  const assemblerCaps = ffmpegCapabilities(learnedT);
  const recOps = new Map(base.record.operations.map((o) => [o.operation_id, o]));
  const diag = new Map(base.diagnosis.map((d) => [d.operation_id, d]));
  const scenes: ScenePlan[] = [];
  let from = 0;
  const ordered = [...h.storyboard.scenes].sort((a, b) => a.start_time - b.start_time);
  for (const [index, s] of ordered.entries()) {
    const frames = Math.round(s.duration_seconds * fps);
    if (frames < 1 || Math.abs(frames / fps - s.duration_seconds) > 1e-6) return { ok: false, stage: "settings", reasons: [`scene ${s.scene_id} lasts ${s.duration_seconds}s, which is not a whole number of frames at ${fps} fps`] };
    const ops = out.operations.filter((o) => o.target_scene_id === s.scene_id);
    const visual = ops.filter((o) => o.operation_type !== "concat" && o.operation_type !== "mix_audio");
    const states: SceneOpState[] = ops.map((o) => {
      const d = diag.get(o.operation_id), r = recOps.get(o.operation_id);
      if (o.operation_type === "concat" && r?.implementation_ref === "ffmpeg/concat-cut") return { operation_id: o.operation_id, recipe_id: o.recipe_id, template: r.implementation_ref, operation_type: o.operation_type, status: "validated_available" as OperationStatus, engine: "ffmpeg" as Engine, reason: "a hard cut is the assembler's default join" };
      return { operation_id: o.operation_id, recipe_id: o.recipe_id, template: r?.implementation_ref ?? "", operation_type: o.operation_type, status: d?.status ?? "blocked_with_reason", engine: (r?.renderer as Engine | null) ?? null, reason: d?.reason ?? "no diagnosis" };
    });
    const sp: ScenePlan = { scene_id: s.scene_id, index, start_s: s.start_time, duration_s: s.duration_seconds, frames, from_frame: from, renderable: false, engine: null, adapter: null, job: null, operations: states, unmet: [], reason: null };
    from += frames;
    for (const o of ops.filter((x) => x.operation_type === "mix_audio")) sp.unmet.push(`audio: ${o.recipe_id} (${o.operation_id}) cannot be produced yet; audio is not part of this phase`);
    const unsupported = visual.filter((o) => recOps.get(o.operation_id)?.renderer == null);
    const engines = new Set(visual.map((o) => recOps.get(o.operation_id)?.renderer).filter((x): x is Engine => !!x));
    if (!visual.length) sp.reason = "no operation produces this scene's picture";
    else if (unsupported.length) sp.reason = unsupported.map((o) => `${o.operation_id} (${o.recipe_id}) is ${diag.get(o.operation_id)?.status ?? "unsupported"}: ${diag.get(o.operation_id)?.reason ?? "no renderer can run it"}`).join("; ");
    else if (engines.size > 1) sp.reason = `its operations need more than one engine (${[...engines].join(", ")}) inside one scene, and layering across engines is not supported`;
    else {
      const engine = [...engines][0]!;
      const adapter = deps.adapters.adapterFor(recOps.get(visual[0]!.operation_id)!.implementation_ref);
      if (!adapter) sp.reason = `no ${engine} adapter is registered for ${recOps.get(visual[0]!.operation_id)!.implementation_ref}`;
      else {
        const shift = (o: EditorOperation): EditorOperation => ({ ...o, timing: { start_s: Math.max(0, o.timing.start_s - s.start_time), duration_s: o.timing.duration_s }, ...(o.caption ? { caption: { ...o.caption, start_s: Math.max(0, o.caption.start_s - s.start_time), end_s: o.caption.end_s - s.start_time } } : {}) });
        const render_id = `rn_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const used = new Set(visual.flatMap((o) => o.asset_ids));
        const job: Omit<RenderJob, "signal"> = {
          render_id, settings: RenderSettings.parse({ ...settings, duration_s: s.duration_seconds }), operations: visual.map(shift),
          templates: Object.fromEntries(visual.map((o) => [o.operation_id, recOps.get(o.operation_id)!.implementation_ref])),
          assets: base.plan?.job.assets.filter((a) => used.has(a.asset_id)) ?? h.assets.filter((a) => used.has(a.asset_id)).map((a) => ({ asset_id: a.asset_id, media_type: a.media_type, uri: a.uri })),
          clips: [], asset_info: Object.fromEntries(h.assets.filter((a) => used.has(a.asset_id)).map((a) => [a.asset_id, { duration: a.duration, width: a.width, height: a.height, audio_tracks: a.audio_tracks }])),
          concept_asset_ids: base.plan?.job.concept_asset_ids.filter((id) => used.has(id)) ?? [], ...jobVisuals(h), output_path: join(deps.outputRoot, "clips", `${render_id}.mp4`),
        };
        const issues = adapter.check?.(job) ?? [];
        if (issues.length) sp.reason = `the ${engine} adapter refuses this scene: ${issues.join("; ")}`;
        else { sp.renderable = true; sp.engine = engine; sp.adapter = adapter; sp.job = job; }
      }
    }
    scenes.push(sp);
  }

  // Coverage per scene, against the engine that renders it and the assembler's transitions. Missing audio, voiceover and transitions leave a rendered
  // scene incomplete; a missing picture requirement means the scene cannot honestly be shown.
  const covBy = new Map<string, ReturnType<typeof previewCoverage>>();
  for (const e of new Set(scenes.map((x) => x.engine).filter((x): x is Engine => !!x))) {
    const caps: RenderCapabilities = { ...((deps.adapters.adapterFor(scenes.find((x) => x.engine === e)!.operations.find((o) => o.engine === e)!.template)?.capabilities) ?? RENDERER_CAPABILITIES[e]), transition_templates: assemblerCaps.transition_templates };
    covBy.set(e, previewCoverage(h, out, base.record, caps));
  }
  for (const sp of scenes) {
    if (!sp.renderable || !sp.engine) continue;
    const cov = covBy.get(sp.engine)!.scenes.find((x) => x.scene_id === sp.scene_id);
    for (const m of cov?.missing ?? []) {
      if (/\(hard-cut\) has no renderer/.test(m)) continue; // a hard cut is the assembler's default join, handled with the transitions
      // audio, voiceover and a missing transition leave a rendered scene incomplete; so does an approved camera move nobody can carry out: the scene is still shown (as a still card, labelled), not dropped
      if (/audio|voiceover|transition is not rendered|the approved shot calls for camera motion/.test(m)) { if (!sp.unmet.includes(m)) sp.unmet.push(m); }
      else { sp.renderable = false; sp.reason = `${sp.reason ? `${sp.reason}; ` : ""}${m}`; }
    }
  }

  // Transitions: between neighbouring scenes, by the assembler.
  const transitions: TransitionPlan[] = [];
  for (const o of out.operations.filter((x) => x.operation_type === "concat")) {
    const i = scenes.findIndex((s) => s.scene_id === o.target_scene_id);
    const r = recOps.get(o.operation_id);
    const t = r?.implementation_ref ?? "";
    const xf = r?.renderer === "ffmpeg" ? xfadeFor(t, o.parameters, learnedT) : null;
    const d = typeof o.parameters["duration_s"] === "number" ? (o.parameters["duration_s"] as number) : 0;
    const cf = Math.round(d * fps);
    let reason = "";
    // A hard cut is no operation at all: the assembler joins scenes with a cut unless a transition is approved.
    if (t === "ffmpeg/concat-cut") { transitions.push({ after_scene: o.target_scene_id, operation_id: o.operation_id, template: t, xfade: null, frames: 0, applied: true, reason: "a hard cut is the assembler's default join: the next scene starts on the next frame" }); continue; }
    if (i < 0 || i === scenes.length - 1) reason = "it has no following scene to blend into";
    else if (!xf) reason = `${t || "its template"} has no validated FFmpeg implementation (${diag.get(o.operation_id)?.status ?? "unsupported"}): ${diag.get(o.operation_id)?.reason ?? ""}`.trim();
    else if (!scenes[i]!.renderable || !scenes[i + 1]!.renderable) reason = "a neighbouring scene is not rendered, so a hard cut is used there";
    else if (cf < 1 || Math.abs(cf / fps - d) > 1e-6 || cf > Math.floor(scenes[i]!.frames / 2) || cf > scenes[i + 1]!.frames) reason = `${d}s is not a whole number of frames, or is longer than half of ${scenes[i]!.scene_id} or longer than the next scene`;
    transitions.push({ after_scene: o.target_scene_id, operation_id: o.operation_id, template: t, xfade: xf, frames: cf, applied: !reason, reason: reason || "applied by the FFmpeg assembler" });
  }
  // A scene's approved transition that no operation provides is already in its coverage as "unmet"; one an operation provides but cannot be applied is too.
  for (const t of transitions.filter((x) => !x.applied)) { const sp = scenes.find((s) => s.scene_id === t.after_scene); const msg = `its transition (${t.operation_id}) is not applied: ${t.reason}`; if (sp && !sp.unmet.includes(msg)) sp.unmet.push(msg); }

  const omitted: AssemblyPlan["omitted"] = [];
  for (const sp of scenes) for (const o of sp.operations) if (!sp.renderable && o.operation_type !== "mix_audio" && o.operation_type !== "concat") omitted.push({ operation_id: o.operation_id, scene_id: sp.scene_id, recipe_id: o.recipe_id, status: o.status, reason: sp.reason ?? o.reason });
  for (const sp of scenes) for (const o of sp.operations.filter((x) => x.operation_type === "mix_audio")) omitted.push({ operation_id: o.operation_id, scene_id: sp.scene_id, recipe_id: o.recipe_id, status: "blocked_with_reason", reason: "audio is not part of this phase and cannot be produced" });
  for (const t of transitions.filter((x) => !x.applied)) omitted.push({ operation_id: t.operation_id, scene_id: t.after_scene, recipe_id: t.template, status: "blocked_with_reason", reason: t.reason });
  const complete = scenes.length > 0 && scenes.every((s) => s.renderable && s.unmet.length === 0) && omitted.length === 0 && !base.record.audio_required;
  return { ok: true, plan: { render_id: base.record.render_id, purpose: base.record.purpose, settings, handoff: h, editor_output: out, base, scenes, transitions, omitted, complete } };
}

// ------------------------------------------------------------------------------------------------------------------------------------
// Rendering and assembly
// ------------------------------------------------------------------------------------------------------------------------------------

async function frameCount(path: string, ffprobe: string): Promise<number> {
  const { stdout } = await run(ffprobe, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", path], { timeout: 120_000, windowsHide: true });
  return Number(stdout.trim().split(/[,\s]/)[0]);
}

/** A labelled stand-in for a scene nothing could render: the same length and size, saying plainly that the scene is missing and why. */
async function renderSlate(sp: ScenePlan, reason: string, deps: AssembleDeps, settings: RenderSettings, outPath: string, work: string): Promise<void> {
  const ffmpeg = deps.ffmpegPath ?? "ffmpeg";
  const clean = (t: string) => t.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  await writeFile(join(work, `slate-${sp.scene_id}.txt`), `INCOMPLETE PREVIEW\n${sp.scene_id} NOT RENDERED\n${clean(reason).slice(0, 110)}`, "utf8");
  const fs = Math.max(10, Math.round(settings.height / 14));
  await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x5a1e1e:s=${settings.width}x${settings.height}:r=${settings.fps}:d=${(sp.frames / settings.fps).toFixed(6)}`,
    "-vf", `drawtext=fontfile=font.ttf:textfile=slate-${sp.scene_id}.txt:expansion=none:fontcolor=white:fontsize=${fs}:x=(w-text_w)/2:y=(h-text_h)/2:text_align=center,format=yuv420p`,
    "-frames:v", String(sp.frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "1", outPath], { cwd: work, windowsHide: true });
}

function assembleGraph(scenes: readonly ScenePlan[], transitions: readonly TransitionPlan[], fps: number): string {
  const chains: string[] = [];
  scenes.forEach((s, i) => chains.push(`[${i}:v]fps=${fps},setpts=PTS-STARTPTS,scale=in_range=auto:out_range=limited,format=yuv420p,trim=end_frame=${s.frames},setpts=PTS-STARTPTS[s${i}]`));
  const cfOf = (i: number) => transitions.find((t) => t.applied && t.frames > 0 && t.after_scene === scenes[i]!.scene_id);
  const finals: string[] = [];
  scenes.forEach((s, i) => {
    const incoming = i > 0 ? cfOf(i - 1) : undefined;
    let main = `s${i}`;
    if (incoming) { chains.push(`[s${i}]split=2[r${i}][h${i}]`); main = `r${i}`; }
    const out = cfOf(i);
    if (out && i + 1 < scenes.length) {
      chains.push(`[h${i + 1}]trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=${out.frames - 1},fps=${fps}[hd${i + 1}]`);
      chains.push(`[${main}][hd${i + 1}]xfade=transition=${out.xfade}:duration=${(out.frames / fps).toFixed(6)}:offset=${((s.frames - out.frames) / fps).toFixed(6)},trim=end_frame=${s.frames},setpts=PTS-STARTPTS,format=yuv420p,fps=${fps}[x${i}]`);
      finals.push(`[x${i}]`);
    } else finals.push(`[${main}]`);
  });
  return `${chains.join(";")};${finals.join("")}concat=n=${scenes.length}:v=1:a=0[out]`;
}

const mad = (a: Buffer, b: Buffer): number => { let d = 0, n = 0; for (let i = 0; i + 2 < a.length && i + 2 < b.length; i += 12) { d += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!); n += 3; } return n ? d / n : 255; };
const stddev = (a: Buffer): number => { let s = 0, ss = 0, n = 0; for (let i = 0; i + 2 < a.length; i += 12) { const l = 0.299 * a[i]! + 0.587 * a[i + 1]! + 0.114 * a[i + 2]!; s += l; ss += l * l; n++; } const m = s / n; return Math.sqrt(Math.max(0, ss / n - m * m)); };
const E2E_TOLERANCE = 8;

export type AssembleResult =
  | { kind: "complete"; record: RenderRecord; report: DeliveryReport }
  | { kind: "partial"; report: DeliveryReport }
  | { kind: "failed"; errors: string[]; report: DeliveryReport | null };

/**
 * Renders every renderable scene through its engine, builds placeholders for the others, assembles the film with FFmpeg and checks the final file
 * against the clips, scene by scene. A clip, the assembly or any check that fails makes the whole result `failed`: a film that exports but does not
 * match what was rendered is never reported as a success.
 */
export async function renderAssembly(plan: AssemblyPlan, deps: AssembleDeps, opts: { signal?: AbortSignal; now?: () => Date } = {}): Promise<AssembleResult> {
  const now = opts.now ?? (() => new Date());
  const ffmpeg = deps.ffmpegPath ?? "ffmpeg", ffprobe = deps.ffprobePath ?? "ffprobe";
  const signal = opts.signal ?? new AbortController().signal;
  const { settings, scenes, transitions } = plan;
  const work = await mkdtemp(join(deps.workRoot ?? tmpdir(), "assemble-"));
  const clipsDir = join(deps.outputRoot, "clips");
  mkdirSync(clipsDir, { recursive: true });
  const finalPath = join(deps.outputRoot, `${plan.render_id}.mp4`);
  const errors: string[] = [];
  const sceneNotes = new Map<string, string[]>();
  const clips = new Map<string, { path: string; sha256: string | null; placeholder: boolean }>();
  try {
    await writeFile(join(work, "font.ttf"), readFileSync(deps.fontFile));
    // 1. each scene, through its engine
    for (const sp of scenes) {
      const path = sp.job?.output_path ?? join(clipsDir, `rn_${randomUUID().replaceAll("-", "").slice(0, 16)}.mp4`);
      const clipSettings = RenderSettings.parse({ ...settings, duration_s: sp.duration_s });
      if (!sp.renderable || !sp.adapter || !sp.job) {
        await renderSlate(sp, sp.reason ?? "unsupported", deps, settings, path, work);
        clips.set(sp.scene_id, { path, sha256: null, placeholder: true });
        continue;
      }
      try {
        const r = await sp.adapter.render({ ...sp.job, signal });
        sceneNotes.set(sp.scene_id, (r && typeof r === "object" ? r.notes : undefined) ?? []);
      } catch (e) { errors.push(`scene ${sp.scene_id} (${sp.engine}): ${(e instanceof Error ? e.message : String(e)).slice(0, 400)}`); continue; }
      const v = await validateOutput(path, clipSettings, false);
      if (!v.ok) { errors.push(`scene ${sp.scene_id} (${sp.engine}): its clip is not what was approved: ${v.issues.join("; ")}`); continue; }
      const n = await frameCount(path, ffprobe);
      if (n !== sp.frames) { errors.push(`scene ${sp.scene_id} (${sp.engine}): its clip has ${n} frames, not the approved ${sp.frames}`); continue; }
      clips.set(sp.scene_id, { path, sha256: v.output.sha256, placeholder: false });
    }
    if (errors.length) return { kind: "failed", errors, report: null };

    // 2. assembly, one final encode
    const args = ["-hide_banner", "-nostdin", "-v", "error", "-n", ...scenes.flatMap((s) => ["-i", clips.get(s.scene_id)!.path]), "-filter_complex", assembleGraph(scenes, transitions, settings.fps), "-map", "[out]", "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-movflags", "+faststart", "-frames:v", String(scenes.reduce((n, s) => n + s.frames, 0)), finalPath];
    try { await run(ffmpeg, args, { signal, maxBuffer: 1 << 20, windowsHide: true }); } catch (e) { await rm(finalPath, { force: true }); return { kind: "failed", errors: [`the assembly failed: ${((e as { stderr?: string }).stderr || (e instanceof Error ? e.message : String(e))).trim().slice(0, 400)}`], report: null }; }

    // 3. the final file, measured
    const total = scenes.reduce((n, s) => n + s.frames, 0);
    const final = await validateOutput(finalPath, RenderSettings.parse({ ...settings, duration_s: total / settings.fps }), false, now);
    if (!final.ok) { await rm(finalPath, { force: true }); return { kind: "failed", errors: final.issues.map((i) => `the final video: ${i}`), report: null }; }
    const finalFrames = await frameCount(finalPath, ffprobe);
    if (finalFrames !== total) { await rm(finalPath, { force: true }); return { kind: "failed", errors: [`the final video has ${finalFrames} frames, not the approved ${total}`], report: null }; }

    // 4. end to end: the final film must show each scene's clip, and the transitions must really blend
    const problems: string[] = [];
    const sceneChecks = new Map<string, string[]>();
    const W = settings.width, H = settings.height;
    const fr = (file: string, n: number) => rawFrame(file, n, W, H, ffmpeg);
    for (const sp of scenes) {
      const clip = clips.get(sp.scene_id)!.path, out = transitions.find((t) => t.applied && t.frames > 0 && t.after_scene === sp.scene_id);
      const lastClean = sp.frames - (out?.frames ?? 0) - 1;
      const checks: string[] = [];
      for (const k of [0, Math.floor(lastClean / 2), lastClean]) {
        if (k < 0) continue;
        const d = mad(await fr(finalPath, sp.from_frame + k), await fr(clip, k));
        if (d > E2E_TOLERANCE) problems.push(`scene ${sp.scene_id}: frame ${k} of the final video differs from the scene's own clip by ${d.toFixed(1)} of 255 (allowed ${E2E_TOLERANCE})`); else checks.push(`frame ${k} of the final video matches the clip (difference ${d.toFixed(1)})`);
      }
      if (!clips.get(sp.scene_id)!.placeholder && sp.engine === "ffmpeg") {
        const sd = stddev(await fr(clip, sp.frames - 1));
        if (sd < 4) problems.push(`scene ${sp.scene_id}: its last frame is blank (brightness spread ${sd.toFixed(1)})`); else checks.push(`its last frame is not blank (brightness spread ${sd.toFixed(1)})`);
      }
      sceneChecks.set(sp.scene_id, checks);
    }
    for (const t of transitions.filter((x) => x.applied && x.frames > 0)) {
      const i = scenes.findIndex((s) => s.scene_id === t.after_scene), sp = scenes[i]!, next = scenes[i + 1]!;
      const mid = sp.frames - Math.ceil(t.frames / 2);
      const f = await fr(finalPath, sp.from_frame + mid);
      const a = mad(f, await fr(clips.get(sp.scene_id)!.path, mid)), b = mad(f, await fr(clips.get(next.scene_id)!.path, 0));
      if (a < 2.5 || b < 2.5) problems.push(`the transition after ${sp.scene_id} does not blend: the middle frame is ${a.toFixed(1)} from the first scene and ${b.toFixed(1)} from the next (a real blend differs from both)`);
      else sceneChecks.get(sp.scene_id)!.push(`the ${t.template} transition really blends (middle frame ${a.toFixed(1)} from the scene and ${b.toFixed(1)} from the next)`);
      const after = mad(await fr(finalPath, next.from_frame), await fr(clips.get(next.scene_id)!.path, 0));
      if (after > E2E_TOLERANCE) problems.push(`scene ${next.scene_id} does not start cleanly after the transition (${after.toFixed(1)} from its own clip)`);
    }
    if (problems.length) { await rm(finalPath, { force: true }); return { kind: "failed", errors: problems, report: null }; }

    // 5. the report: every stage on its own
    const ffv = execFileSync(ffmpeg, ["-version"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0]!.trim();
    const engines = [...new Set(scenes.map((s) => s.engine).filter((e): e is Engine => !!e))];
    const rendered = scenes.filter((s) => !clips.get(s.scene_id)!.placeholder);
    const draft = plan.base.record.operations.some((o) => !o.production_executable);
    const finalBlockers = [
      ...(plan.complete ? [] : ["the film is incomplete: some approved scenes or operations are missing (see omitted_operations)"]),
      ...(plan.base.record.audio_required ? ["the approved plan requires audio, which this phase cannot produce"] : []),
      ...(draft || plan.purpose !== "production" ? ["every recipe used is still a draft, so this is a preview and production rendering stays blocked"] : []),
    ];
    const output = final.output as RenderOutput;
    const report: DeliveryReport = DeliveryReport.parse({
      format: "digikon.delivery-report", format_version: 1, delivery_id: `dl_${randomUUID().replaceAll("-", "").slice(0, 16)}`, render_id: plan.render_id, kind: plan.complete ? "complete" : "partial", purpose: plan.purpose,
      handoff_content_hash: plan.handoff.content_hash,
      states: { plan_created: true, plan_approved: true, scenes_total: scenes.length, scenes_rendered: rendered.length, scenes_content_validated: rendered.length, final_video_validated: true, final_delivery_ready: finalBlockers.length === 0 },
      final_delivery_blockers: finalBlockers,
      label: plan.complete ? "COMPLETE PREVIEW: every approved scene and operation is present and verified, but it is a preview of draft recipes, not a final deliverable." : `INCOMPLETE PREVIEW: ${scenes.length - rendered.length} scene(s) were not rendered and ${plan.omitted.length} approved operation(s) are missing or unsupported. This is not the approved video.`,
      scenes: scenes.map((s) => {
        const c = clips.get(s.scene_id)!, notes = sceneNotes.get(s.scene_id) ?? [];
        return {
          scene_id: s.scene_id, start_s: s.start_s, duration_s: s.duration_s, frames: s.frames, status: c.placeholder ? "placeholder" : s.engine === "ffmpeg" ? "rendered_unverified" : "rendered_and_verified",
          engine: s.engine, operations: s.operations, unmet: s.unmet, omitted_reason: c.placeholder ? s.reason : null,
          content: { engine_checked: !c.placeholder && s.engine !== "ffmpeg", end_to_end_checked: true, checks: sceneChecks.get(s.scene_id) ?? [], limitations: s.engine === "ffmpeg" ? ["FFmpeg scenes are checked for being non-blank and for matching the final video, not for their text or layout"] : notes.filter((n) => /checked|pixel|OCR/i.test(n)) },
          clip_sha256: c.sha256,
        };
      }),
      transitions: transitions.map((t) => ({ after_scene: t.after_scene, operation_id: t.operation_id, template: t.template, status: t.applied ? "applied" : "omitted", reason: t.reason })),
      omitted_operations: plan.omitted, engines_used: engines,
      assembly: { tool: "ffmpeg", ffmpeg_version: ffv, lossy_encodes: 2, known_differences: ["each scene is encoded by its engine and then re-encoded once by the assembler, so frames differ from the clips by a small amount (allowed: 8 of 255 on average)", "HyperFrames draws backgrounds up to 3 levels darker than specified; Remotion and FFmpeg are within 2", "scene clips are h264 intermediates, not lossless"] },
      output: { path: finalPath, bytes: output.bytes, sha256: output.sha256, width: output.width, height: output.height, fps: output.fps, duration_s: output.duration_s, frames: finalFrames, video_codec: output.video_codec, audio_tracks: output.audio_tracks },
      limitations: ["only the first, middle and last clean frame of each scene are compared with its clip", "text and layout inside a scene are verified by the engine that drew it, by pixel comparison and not OCR", "audio is not produced in this phase"],
      created_at: now().toISOString(),
    });
    if (plan.complete && !plan.base.record.audio_required) {
      const record = RenderRecord.parse({ ...plan.base.record, state: "rendered", blockers: [], errors: [], output: { ...output, checks: [...output.checks, `assembled from ${scenes.length} scene clips by ${engines.join(", ")} and FFmpeg; every scene matches its clip`] }, notes: [...plan.base.record.notes, `assembled from scene clips (${engines.join(", ")}); ${report.label}`], started_at: now().toISOString(), finished_at: now().toISOString() });
      return { kind: "complete", record, report };
    }
    return { kind: "partial", report };
  } catch (e) {
    await rm(finalPath, { force: true });
    return { kind: "failed", errors: [(e instanceof Error ? e.message : String(e)).slice(0, 400)], report: null };
  } finally {
    for (const c of clips.values()) await rm(c.path, { force: true });
    try { rmdirSync(clipsDir); } catch { /* not empty (another render is using it) or already gone */ }
    await rm(work, { recursive: true, force: true });
  }
}

/** Saves a delivery report next to the render records, atomically. */
export function saveDeliveryReport(dir: string, report: DeliveryReport): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.delivery_id}.delivery.json`);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  renameSync(`${file}.tmp`, file);
  return resolve(file);
}

export function loadDeliveryReport(file: string): DeliveryReport | null {
  try { const p = DeliveryReport.safeParse(JSON.parse(readFileSync(file, "utf8"))); return p.success ? p.data : null; } catch { return null; }
}

