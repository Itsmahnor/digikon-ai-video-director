import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  DirectorHandoff, EditorOutput, RENDER_SCHEMA_VERSION, RenderRecord, RenderSettings,
  type Asset, type RenderError, type RenderPurpose, type Renderer,
} from "@digikon/contracts";
import {
  checkEditorOutput, checkHandoff, executionReport, localFiles, verifyHandoffWithStore, assetFileProblems,
  type AssetFiles, type RunStore,
} from "@digikon/director";
import type { RecipeLibrary } from "@digikon/recipes";
import { jobVisuals } from "./composition.js";
import { AdapterRegistry, type RenderAdapter, type RenderJob } from "./adapter.js";
import { planAudio, type AudioCapabilities } from "./audio.js";
import { alternativeImplementation, diagnoseOperations, loadCapabilityRegistry, type LoadedRegistry, type OperationDiagnosis } from "./capabilities.js";
import { previewCoverage } from "./coverage.js";
import { selectRenderer } from "./select.js";
import { conceptAssetIdsOf } from "./scene-job.js";
import { selectionProblems, type ApprovedSelection } from "./selection-integrity.js";
import { validateOutput } from "./output.js";

export interface RenderDeps {
  recipes: RecipeLibrary;
  adapters: AdapterRegistry;
  /** Folder the adapters write into. A render's file is `<render_id>.<container>` here and must not exist beforehand. */
  outputRoot: string;
  /** Finds a picture's real file through the asset registry, by id and only within this project. Absent: scenes that place pictures are refused. */
  assetFiles?: import("./asset-layers.js").AssetFileResolver;
  /** When set, the handoff is verified against the approvals stored for its run, not only against itself. */
  store?: RunStore;
  files?: AssetFiles;
  storageRoot?: string;
  requireContentHash?: boolean;
  now?: () => Date;
  /** The shared capability registry. When a recipe's own template cannot run, an engine the recipe lists may run it through a validated record. */
  capabilities?: LoadedRegistry;
  /** What this machine can make for the film's sound. Absent: no sound is produced, and a plan that asks for some stays incomplete. */
  audio?: AudioCapabilities;
}

export interface RenderInput {
  /** The Editor's result, exactly as returned. It is parsed and checked again here. */
  editor_output: unknown;
  /** The handoff the Editor worked from. */
  handoff: unknown;
  /** Output settings. Never defaulted: leave out what is not decided and the render stays in planning. */
  settings?: unknown;
  purpose?: RenderPurpose;
  /**
   * The implementation and engine the approved production plan selected for each operation. When given, a renderer choice that differs from it (an alternative
   * implementation, another engine) is a blocker, not a substitution. Absent only where no production plan exists (the workflow without a ProductionPort).
   */
  approved_selection?: readonly ApprovedSelection[];
}

/** Everything the adapter needs, and the snapshot that was verified. Only an `executable` record has one. */
export interface ExecutablePlan {
  record: RenderRecord;
  job: Omit<RenderJob, "signal">;
  adapter: RenderAdapter;
  /** The handoff's assets, so they can be checked again just before rendering. */
  assets: Asset[];
  /** The verified handoff and Editor result the plan came from, so `executeRender` can check coverage again on its own. */
  handoff: DirectorHandoff;
  editor_output: EditorOutput;
}

export type PlanResult =
  | { ok: false; stage: "input" | "handoff" | "editor_output"; reasons: string[] }
  | { ok: true; record: RenderRecord; plan: ExecutablePlan | null; /** Per operation: which engines could run it, why, which was selected and its status. */ diagnosis: OperationDiagnosis[];
      /**
       * The blockers that are only true of running every operation through ONE adapter (mixed engines, a join handed to a scene planner, a transition one engine cannot draw).
       * They stop `executeRender`, but scene-by-scene assembly carries such a plan out, and judges those requirements itself: see `planAssembly` and `assemblyBlockers`.
       */
      single_run_blockers: string[] };

const iso = (d: Date) => d.toISOString();

/**
 * Decides whether a render may start. It re-runs the Director's handoff verification and the Director's check of the Editor's
 * output, then recomputes what can run from the adapters that actually exist. Input that fails either check is rejected with
 * no record. Input that passes but cannot run yet becomes a `planning` record that lists every blocker. Nothing is rendered.
 */
export function planRender(input: RenderInput, deps: RenderDeps): PlanResult {
  const purpose: RenderPurpose = input.purpose ?? "production";
  const now = deps.now ?? (() => new Date());

  const handoffParsed = DirectorHandoff.safeParse(input.handoff);
  if (!handoffParsed.success) return { ok: false, stage: "input", reasons: handoffParsed.error.issues.map((i) => `handoff ${i.path.join(".") || "root"}: ${i.message}`) };
  const h = handoffParsed.data;
  const ctx = { recipes: deps.recipes, files: deps.files, storageRoot: deps.storageRoot, requireContentHash: deps.requireContentHash };
  const handoffReasons = deps.store ? verifyHandoffWithStore(h, deps.store, ctx) : checkHandoff(h, ctx);
  if (handoffReasons.length) return { ok: false, stage: "handoff", reasons: handoffReasons };

  const outParsed = EditorOutput.safeParse(input.editor_output);
  if (!outParsed.success) return { ok: false, stage: "editor_output", reasons: outParsed.error.issues.map((i) => `editor output ${i.path.join(".") || "root"}: ${i.message}`) };
  const out = outParsed.data;
  const check = checkEditorOutput(out, h, { recipes: deps.recipes });
  const reasons = [...check.issues];
  if (check.requires_reapproval) reasons.push("the result asks for a change to an approved plan, which needs the Director and a new human approval");
  // The one conflict that does not stop a PREVIEW: approved audio cues nobody can produce (no sound recipe, no audio asset). Audio is not built, so the film is incomplete and never final,
  // and each such scene is reported with its audio as unresolved; nothing is dropped silently. Any other conflict, and every revision request, still refuses.
  const audioOnly = out.conflicts.length > 0 && out.revision_requests.length === 0 && out.conflicts.every((x) => x.kind === "missing_information" && /lists audio cues/.test(x.description));
  if (out.status !== "ready" && !(audioOnly && out.status === "blocked")) reasons.push(`the Editor's status is ${out.status}, not ready`);
  if (!out.validation.ok) reasons.push("the Editor's result did not pass its own validation");
  if ((out.conflicts.length && !audioOnly) || out.revision_requests.length) reasons.push("the Editor's result has open conflicts or revision requests");
  if (!out.operations.length) reasons.push("the Editor's result has no operations to render");
  if (reasons.length) return { ok: false, stage: "editor_output", reasons };

  // ----- what can run, recomputed from the adapters that exist (the Editor's own report may have used none) -----
  const blockers: string[] = [], notes: string[] = [];
  // Engine selection. A recipe runs through its own template when a registered adapter has it. Otherwise another engine may run it, but only one the
  // approved recipe lists in `compatibility.renderers`, through a validated registry record. The recipe itself is never changed; the choice is recorded.
  const registry = deps.capabilities ?? loadCapabilityRegistry(null);
  const chosen = new Map<string, { template: string; engine: string }>();
  for (const op of out.operations) {
    const r = deps.recipes.get(op.recipe_id);
    if (!r || chosen.has(r.recipe_id) || deps.adapters.supports(r.implementation_ref, op.operation_type)) continue;
    const alt = alternativeImplementation(r, registry, (t) => deps.adapters.supports(t, op.operation_type));
    if (alt) chosen.set(r.recipe_id, { template: alt.template, engine: alt.engine });
  }
  const effective = Object.create(deps.recipes) as typeof deps.recipes;
  effective.get = (id: string) => { const r = deps.recipes.get(id); const c = r && chosen.get(r.recipe_id); return r && c ? { ...r, implementation_ref: c.template } : r; };
  for (const [id, c] of chosen) notes.push(`${id} runs on ${c.engine} through ${c.template}: its own template has no working implementation here, the approved recipe lists ${c.engine}, and that capability is validated in the registry`);
  const report = executionReport(out.operations, effective, deps.adapters, { conflicts: 0, missing_inputs: [], notes: [] });
  const operations = out.operations.map((op, i) => {
    const recipe = effective.get(op.recipe_id)!;
    const ex = report.operations[i]!;
    let renderer: Renderer | null = ex.renderer;
    if (renderer && !deps.adapters.supports(recipe.implementation_ref, op.operation_type)) {
      blockers.push(`${op.operation_id}: template ${recipe.implementation_ref} does not implement ${op.operation_type} operations`);
      renderer = null;
    } else if (!ex.executable) blockers.push(...ex.blockers.map((b) => `${op.operation_id}: ${b}`));
    else if (!ex.production_executable) {
      if (purpose === "production") blockers.push(`${op.operation_id}: ${ex.blockers.join("; ")}`);
      else notes.push(`${op.operation_id}: ${ex.blockers.join("; ")}`);
    }
    return { operation_id: op.operation_id, operation_type: op.operation_type, recipe_id: op.recipe_id, implementation_ref: recipe.implementation_ref, renderer, production_executable: ex.production_executable };
  });
  if (input.approved_selection) blockers.push(...selectionProblems(input.approved_selection, operations));
  if (purpose === "production") blockers.push(...h.readiness.blockers.map((b) => `handoff is not production-ready: ${b}`));
  else notes.push("preview render: it may use draft recipes and is not a production video");
  const renderers = new Set(operations.map((o) => o.renderer).filter((r): r is Renderer => !!r));
  const singleRun = new Set<string>();
  const single = (b: string) => { singleRun.add(b); if (!blockers.includes(b)) blockers.push(b); };
  if (renderers.size > 1) single(`the operations need more than one renderer (${[...renderers].join(", ")}); one render run cannot mix them, so the preview is assembled scene by scene instead (see the assembly plan)`);

  // ----- coverage: every approved requirement must be carried out by the selected renderer, or it is a blocker naming the scene -----
  // This is the same check the console shows. It runs here so no caller can render a plan that leaves out an approved transition, camera move,
  // voiceover, audio, footage, logo or caption timing. Details a renderer neither changes nor checks become notes, never silence.
  const selection = selectRenderer({ operations, blockers }, deps.adapters);
  const coverage = previewCoverage(h, out, { operations }, selection.capabilities);
  for (const sc of coverage.scenes) {
    for (const m of sc.missing) single(`${sc.scene_id}: ${m}`); // judged again per scene, against the engine that draws it, by assembly
    for (const l of sc.labelled) notes.push(`${sc.scene_id}: ${l}`);
  }

  // ----- output settings: explicit, from the user or verified documentation, and consistent with the approved plan -----
  // A source's sound is only left out when the approved edit plan says so (a source_audio of "drop" on every operation that uses it).
  // only the operations that play a source count: a transition lists its scene's assets but does not play them
  const droppedSounds = (id: string) => { const uses = out.operations.filter((o) => o.operation_type === "trim_clip" && o.asset_ids.includes(id)); return uses.length > 0 && uses.every((o) => o.parameters["source_audio"] === "drop"); };
  const soundSources = h.assets.filter((a) => a.audio_tracks > 0 || a.media_type === "audio");
  const allSoundDropped = soundSources.length > 0 && soundSources.every((a) => a.media_type === "video" && droppedSounds(a.asset_id));
  if (allSoundDropped) notes.push(`the sound of ${soundSources.map((a) => a.asset_id).join(", ")} is left out because the approved edit plan says so (source_audio drop); no audio is produced`);
  const audioRequired = out.operations.some((o) => o.operation_type === "mix_audio") || (h.qa.expect_audio && !allSoundDropped) || audioOnly || (!!deps.audio && planAudio({ scenes: h.storyboard.scenes, assets: h.assets }, deps.audio).required);
  if (audioOnly) notes.push(`approved audio cues cannot be produced (${out.conflicts.length} scene(s)): the film is an incomplete preview and cannot be final`);
  let settings: RenderSettings | null = null;
  if (input.settings === undefined || input.settings === null) {
    blockers.push("no output settings were supplied: aspect ratio, size, frame rate, duration, container and codecs are required and none are assumed");
  } else {
    const s = RenderSettings.safeParse(input.settings);
    if (!s.success) blockers.push(...s.error.issues.map((i) => `output settings ${i.path.join(".") || "root"}: ${i.message}`));
    else {
      settings = s.data;
      const timeline = Math.max(...h.storyboard.scenes.map((x) => x.start_time + x.duration_seconds));
      if (settings.aspect_ratio !== h.constraints.aspect_ratio) blockers.push(`output settings are ${settings.aspect_ratio}, but the approved project is ${h.constraints.aspect_ratio}`);
      if (Math.abs(settings.duration_s - timeline) > 1 / settings.fps) blockers.push(`output settings last ${settings.duration_s}s, but the approved storyboard lasts ${timeline}s`);
      if (audioRequired && !settings.audio_codec) blockers.push("the plan includes audio but the output settings choose no audio codec");
      if (!audioRequired && settings.audio_codec) blockers.push("the output settings ask for an audio track but the plan has no audio; none is added silently");
    }
  }

  // ----- assets -----
  const files = deps.files ?? localFiles;
  const assets = h.assets.map((a) => ({ asset_id: a.asset_id, media_type: a.media_type, uri: a.uri, present: files.size(a.uri) !== null }));
  for (const a of assets) if (!a.present) blockers.push(`asset ${a.asset_id} is not on disk (${a.uri})`);

  const render_id = `rn_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  // Product screens the plan shows without the user declaring them genuine captures: the renderer must label them as a concept. One definition, shared with assembly and the pre-flight.
  const concept_asset_ids = conceptAssetIdsOf(h);

  // The approved source start of each clip (the storyboard's source_in_seconds) and what was measured about every asset when it was approved.
  const sceneById = new Map(h.storyboard.scenes.map((sc) => [sc.scene_id, sc]));
  const clips = out.operations.filter((o) => o.operation_type === "trim_clip" && o.asset_ids.length === 1).map((o) => ({ operation_id: o.operation_id, asset_id: o.asset_ids[0]!, source_in_s: sceneById.get(o.target_scene_id)?.source_in_seconds ?? Number.NaN }));
  const asset_info = Object.fromEntries(h.assets.map((a) => [a.asset_id, { duration: a.duration, width: a.width, height: a.height, audio_tracks: a.audio_tracks }]));

  // The adapter says what it would refuse (an unsupported layout, text that does not fit, a gap in the timeline), so it is a blocker now.
  // It is asked whenever the settings are valid and every operation has a renderer, even if other blockers exist, so all reasons are reported together.
  const askable = settings !== null && operations.every((o) => o.renderer !== null);
  const adapter = askable ? deps.adapters.adapterFor(operations[0]!.implementation_ref) : null;
  const job = askable ? { render_id, settings: settings!, operations: out.operations, templates: Object.fromEntries(operations.map((o) => [o.operation_id, o.implementation_ref])), clips, asset_info, assets: assets.map(({ present: _p, ...a }) => a), concept_asset_ids, ...jobVisuals(h, deps.assetFiles), output_path: join(deps.outputRoot, `${render_id}.${settings!.container}`) } : null;
  if (job && adapter?.check) for (const b of adapter.check(job)) single(b); // the whole film through one adapter; assembly asks each scene's adapter about that scene's pictures only

  const executable = blockers.length === 0 && settings !== null && !!job && !!adapter;
  const record = RenderRecord.parse({
    schema_version: RENDER_SCHEMA_VERSION, render_id, purpose,
    handoff_id: h.handoff_id, handoff_content_hash: h.content_hash, approved: h.approved,
    state: executable ? "executable" : "planning", settings, operations, assets, audio_required: audioRequired,
    blockers, errors: [], output: null, notes, created_at: iso(now()), started_at: null, finished_at: null,
  });
  const diagnosis = diagnoseOperations({
    operations: out.operations, recipes: deps.recipes, registry,
    supports: (t, type) => deps.adapters.supports(t, type as never), engineOf: (t) => (deps.adapters.template(t)?.renderer as never) ?? null,
  });
  const single_run_blockers = [...singleRun];
  if (!executable) return { ok: true, record, plan: null, diagnosis, single_run_blockers };
  return { ok: true, record, plan: { record, adapter: adapter!, assets: h.assets, job: job!, handoff: h, editor_output: out }, diagnosis, single_run_blockers };
}

/**
 * Everything that makes an executable plan unfit to start: blockers on the record, an operation the adapter cannot run or that names another
 * renderer, anything the adapter itself refuses, and any approved requirement the selected renderer does not carry out.
 */
export function planProblems(plan: ExecutablePlan): string[] {
  const problems: string[] = [...plan.record.blockers];
  const ops = new Map(plan.record.operations.map((o) => [o.operation_id, o]));
  for (const op of plan.job.operations) {
    const rec = ops.get(op.operation_id);
    const ref = plan.job.templates[op.operation_id];
    if (!rec || rec.renderer !== plan.adapter.renderer) problems.push(`${op.operation_id}: it is not planned for the ${plan.adapter.renderer} renderer that was chosen`);
    else if (!ref || !plan.adapter.templates[ref]?.includes(op.operation_type)) problems.push(`${op.operation_id}: ${ref ?? "(no template)"} does not implement ${op.operation_type} operations on the ${plan.adapter.renderer} renderer`);
  }
  if (plan.job.operations.length !== plan.record.operations.length) problems.push("the job and the record list different operations");
  problems.push(...(plan.adapter.check?.(plan.job) ?? []).map((x) => `${plan.adapter.renderer}: ${x}`));
  const cov = previewCoverage(plan.handoff, plan.editor_output, plan.record, selectRenderer(plan.record, { adapterFor: () => plan.adapter }).capabilities);
  for (const s of cov.scenes) for (const m of s.missing) problems.push(`${s.scene_id}: ${m}`);
  return [...new Set(problems)];
}

export interface ExecuteOptions {
  files?: AssetFiles;
  storageRoot?: string;
  requireContentHash?: boolean;
  /** Stops the adapter and fails the render. Default 30 minutes. */
  timeoutMs?: number;
  now?: () => Date;
  /** Called with the `rendering` record before the adapter starts, so it can be persisted. */
  onUpdate?: (record: RenderRecord) => void;
}

/**
 * Runs an executable plan. The adapter writes a file; this function then probes it against the settings. `rendered` is only
 * reachable with a file that exists, is not empty, was not there before, and matches the settings. Every other path ends in
 * `failed` with its reasons, and never carries an output.
 */
export async function executeRender(plan: ExecutablePlan, opts: ExecuteOptions = {}): Promise<RenderRecord> {
  const now = opts.now ?? (() => new Date());
  if (plan.record.state !== "executable") throw new Error(`a render in state ${plan.record.state} cannot be executed`);
  // The plan is judged again here, on its own, before any record says it is running and before any adapter starts: a plan built by hand or
  // changed since planning is not trusted. Nothing is persisted as "rendering" for a plan that is refused.
  const unsupported = planProblems(plan);
  if (unsupported.length) {
    const at = iso(now());
    return RenderRecord.parse({ ...plan.record, state: "failed", errors: unsupported.map((message) => ({ stage: "precheck" as const, message })), output: null, started_at: at, finished_at: at });
  }
  const settings = plan.record.settings!;
  const started = RenderRecord.parse({ ...plan.record, state: "rendering", started_at: iso(now()) });
  opts.onUpdate?.(started);

  const fail = (errors: RenderError[]) => RenderRecord.parse({ ...started, state: "failed", errors, output: null, finished_at: iso(now()) });

  const stale = assetFileProblems(plan.assets, opts.files ?? localFiles, opts.storageRoot, opts.requireContentHash);
  if (stale.length) return fail(stale.map((message) => ({ stage: "precheck", message })));
  if (await stat(plan.job.output_path).then(() => true, () => false)) return fail([{ stage: "precheck", message: `${plan.job.output_path} already exists, so a file there cannot be proven to come from this render` }]);

  const ctl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => { ctl.abort(); resolve("timeout"); }, timeoutMs); });
  let adapterNotes: string[] = [];
  const adapterRun = plan.adapter.render({ ...plan.job, signal: ctl.signal }).then((r) => { adapterNotes = (r && typeof r === "object" ? r.notes : undefined) ?? []; return "done" as const; });
  adapterRun.catch(() => undefined); // a late failure after a timeout is already reported
  try {
    const result = await Promise.race([adapterRun, timeout]);
    if (result === "timeout") return fail([{ stage: "timeout", message: `the ${plan.adapter.renderer} adapter did not finish within ${timeoutMs} ms` }]);
  } catch (e) {
    return fail([{ stage: "adapter", message: e instanceof Error ? e.message : String(e) }]);
  } finally {
    clearTimeout(timer);
  }

  const checked = await validateOutput(plan.job.output_path, settings, plan.record.audio_required, now);
  if (!checked.ok) {
    await rm(plan.job.output_path, { force: true }); // the path did not exist before this render, so anything there is this render's invalid output
    const missing = checked.issues.some((i) => i.startsWith("no output file"));
    return fail(checked.issues.map((message) => ({ stage: missing ? "missing_output" : "output_validation", message })));
  }
  return RenderRecord.parse({ ...started, state: "rendered", output: checked.output, notes: [...started.notes, ...adapterNotes], finished_at: iso(now()) });
}

