import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RenderSettings, hashCanonical, type Asset, type EditorOperation, type Scene } from "@digikon/contracts";
import type { AdapterRegistry, RenderAdapter, RenderJob } from "./adapter.js";
import type { AssetFileResolver } from "./asset-layers.js";
import type { Engine } from "./capabilities.js";
import { jobVisuals } from "./composition.js";

/**
 * The one place a scene's render job is built and judged. Final assembly (`planAssembly`) and the pre-flight both call it, so what the pre-flight asks the adapter's
 * planner is exactly what assembly will ask it: the same operations, templates, settings, assets, visual specs and art direction. Nothing here renders anything.
 */

export interface SceneJobArgs {
  scene: Pick<Scene, "scene_id" | "start_time" | "duration_seconds">;
  /** The scene's picture operations (everything except joins and audio), with their times as the Editor wrote them (film time). */
  visual: readonly EditorOperation[];
  /** For each operation: the implementation reference it will run, the engine that has it registered (null when none), and how to describe it when it cannot run. */
  info: (op: EditorOperation) => { template: string; renderer: Engine | null; unsupported: string };
  adapters: AdapterRegistry;
  /** The film's output settings; the job takes the scene's own duration. */
  settings: RenderSettings;
  handoff: Parameters<typeof jobVisuals>[0] & { storyboard: { scenes: readonly Pick<Scene, "required_assets">[] }; assets: readonly Asset[] };
  /** The assets as the renderer will read them (resolved paths), when the caller has them; otherwise the assets' own uris. */
  resolvedAssets?: readonly RenderJob["assets"][number][];
  assetFiles?: AssetFileResolver;
  outputRoot: string;
}

/**
 * The supplied product screens the plan shows without the user declaring them genuine captures: the renderer must label them as a concept. The one definition, used by the
 * render plan, by assembly and by the pre-flight, so the three can never derive different lists from the same handoff.
 */
export function conceptAssetIdsOf(handoff: { storyboard: { scenes: readonly Pick<Scene, "required_assets">[] }; assets: readonly Pick<Asset, "asset_id" | "genuine_product_ui">[] }): string[] {
  const byId = new Map(handoff.assets.map((a) => [a.asset_id, a]));
  return [...new Set(handoff.storyboard.scenes.flatMap((sc) => sc.required_assets.filter((r) => r.kind === "ui_screenshot" && r.availability === "supplied" && r.asset_id && byId.get(r.asset_id)?.genuine_product_ui !== true).map((r) => r.asset_id!)))];
}

export type SceneJobKind = "no_operation" | "unsupported" | "cross_engine" | "no_adapter" | "refused";
export type SceneJobResult =
  | { ok: true; engine: Engine; adapter: RenderAdapter; job: Omit<RenderJob, "signal">; fingerprint: string }
  | { ok: false; kind: SceneJobKind; reason: string; engine: Engine | null; issues: string[]; job: Omit<RenderJob, "signal"> | null; fingerprint: string | null };

/** A hash of what the planner saw: the job without its random id and output path. Equal inputs give equal fingerprints. */
export function jobFingerprint(job: Omit<RenderJob, "signal">): string {
  const { render_id: _r, output_path: _o, ...rest } = job;
  return hashCanonical({ stage: "scene_job", ...rest });
}

export function planSceneJob(a: SceneJobArgs): SceneJobResult {
  const { scene: s, visual } = a;
  const fail = (kind: SceneJobKind, reason: string, engine: Engine | null = null, issues: string[] = [], job: Omit<RenderJob, "signal"> | null = null): SceneJobResult =>
    ({ ok: false, kind, reason, engine, issues, job, fingerprint: job ? jobFingerprint(job) : null });
  const infos = new Map(visual.map((o) => [o.operation_id, a.info(o)]));
  const unsupported = visual.filter((o) => infos.get(o.operation_id)!.renderer == null);
  const engines = new Set(visual.map((o) => infos.get(o.operation_id)!.renderer).filter((x): x is Engine => !!x));
  if (!visual.length) return fail("no_operation", "no operation produces this scene's picture");
  if (unsupported.length) return fail("unsupported", unsupported.map((o) => infos.get(o.operation_id)!.unsupported).join("; "));
  if (engines.size > 1) return fail("cross_engine", `its operations need more than one engine (${[...engines].join(", ")}) inside one scene, and layering across engines is not supported`);
  const engine = [...engines][0]!;
  const firstRef = infos.get(visual[0]!.operation_id)!.template;
  const adapter = a.adapters.adapterFor(firstRef);
  if (!adapter) return fail("no_adapter", `no ${engine} adapter is registered for ${firstRef}`, engine);

  const shift = (o: EditorOperation): EditorOperation => ({ ...o, timing: { start_s: Math.max(0, o.timing.start_s - s.start_time), duration_s: o.timing.duration_s }, ...(o.caption ? { caption: { ...o.caption, start_s: Math.max(0, o.caption.start_s - s.start_time), end_s: o.caption.end_s - s.start_time } } : {}) });
  const render_id = `rn_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const used = new Set(visual.flatMap((o) => o.asset_ids));
  const job: Omit<RenderJob, "signal"> = {
    render_id, settings: RenderSettings.parse({ ...a.settings, duration_s: s.duration_seconds }), operations: visual.map(shift),
    templates: Object.fromEntries(visual.map((o) => [o.operation_id, infos.get(o.operation_id)!.template])),
    assets: a.resolvedAssets?.filter((x) => used.has(x.asset_id)).map((x) => ({ ...x })) ?? a.handoff.assets.filter((x) => used.has(x.asset_id)).map((x) => ({ asset_id: x.asset_id, media_type: x.media_type, uri: x.uri })),
    clips: [], asset_info: Object.fromEntries(a.handoff.assets.filter((x) => used.has(x.asset_id)).map((x) => [x.asset_id, { duration: x.duration, width: x.width, height: x.height, audio_tracks: x.audio_tracks }])),
    concept_asset_ids: conceptAssetIdsOf(a.handoff).filter((id) => used.has(id)), ...jobVisuals(a.handoff, a.assetFiles), output_path: join(a.outputRoot, "clips", `${render_id}.mp4`),
  };
  const issues = adapter.check?.(job) ?? [];
  if (issues.length) return fail("refused", `the ${engine} adapter refuses this scene: ${issues.join("; ")}`, engine, issues, job);
  return { ok: true, engine, adapter, job, fingerprint: jobFingerprint(job) };
}
