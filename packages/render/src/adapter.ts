import type { EditorOperation, Renderer, RenderSettings, SceneAssetRef } from "@digikon/contracts";
import type { AssetLayer, ResolvedAssetFile } from "./asset-layers.js";
import type { Box } from "./composition.js";
import type { RendererRegistry } from "@digikon/director";

type OperationType = EditorOperation["operation_type"];

/** What an adapter is given. Data only: typed parameters and verified asset paths, never code. */
export interface RenderJob {
  render_id: string;
  settings: RenderSettings;
  operations: EditorOperation[];
  /** The reviewed-template id (implementation_ref) each operation resolved to, by operation_id. */
  templates: Record<string, string>;
  assets: { asset_id: string; media_type: "video" | "image" | "audio"; uri: string }[];
  /** For each operation that plays a supplied video: which asset, and the approved point in it where the scene starts. */
  clips: { operation_id: string; asset_id: string; source_in_s: number }[];
  /** What was measured about each asset when it was analysed and approved. The renderer measures the file again and compares. */
  asset_info: Record<string, { duration: number | null; width: number | null; height: number | null; audio_tracks: number }>;
  /** Supplied images the plan presents as product screens without the user having declared them a genuine capture. They must be labelled as a concept. */
  concept_asset_ids: string[];
  /** The approved visual spec of each scene that has one, with the scene's approved overlay text, by scene_id. Data only. */
  scene_visuals?: Record<string, { visual: unknown; overlay_text: string | null; visual_purpose: string | null }>;
  /** The pictures each scene places, by scene_id: the approved references, and each one's file as the registry resolved it. */
  scene_assets?: Record<string, { refs: SceneAssetRef[]; files: Record<string, ResolvedAssetFile> }>;
  /** The approved art direction of the film, when the treatment has one. */
  art_direction?: unknown;
  /** The only path the adapter may write. It does not exist when the job starts. */
  output_path: string;
  signal: AbortSignal;
}

/**
 * Renderer-specific code lives behind this interface and nowhere else. An adapter writes a file to `job.output_path`; it
 * does not say whether the result is good. The foundation probes the file and decides.
 */
export interface RenderAdapter {
  renderer: Renderer;
  /** Reviewed templates this adapter can run, each with the operation types it implements. Anything else is refused. */
  templates: Readonly<Record<string, readonly OperationType[]>>;
  /** Writes the file. It may return notes, for example what its own content check could and could not establish; they are kept on the render record. */
  render(job: RenderJob): Promise<void | { notes: string[] }>;
  /** What this adapter can show beyond plain graphics, when that depends on what it was given (learned capabilities). Coverage prefers it over the built-in table. */
  capabilities?: import("./coverage.js").RenderCapabilities;
  /**
   * Everything this adapter would refuse about a job, found without running anything. The planner turns each into a blocker,
   * so an unsupported scene is reported while planning instead of failing at render time.
   */
  check?(job: Omit<RenderJob, "signal">): string[];
  /** Exactly what this adapter draws for each scene's uploaded pictures, so the finished film can be compared with those files. */
  assetLayers?(job: Omit<RenderJob, "signal">): { scene_id: string; layers: AssetLayer[]; occluders: { box: Box }[] }[];
}

/** The adapters that exist. It is also the Editor's RendererRegistry, so the Editor and the renderer agree on what can run. */
export class AdapterRegistry implements RendererRegistry {
  private readonly byRef = new Map<string, RenderAdapter>();
  constructor(adapters: readonly RenderAdapter[] = []) {
    for (const a of adapters) for (const ref of Object.keys(a.templates)) {
      if (ref.split("/")[0] !== a.renderer) throw new Error(`template ${ref} does not belong to the ${a.renderer} renderer`);
      this.byRef.set(ref, a);
    }
  }
  template(ref: string): { renderer: Renderer } | null {
    const a = this.byRef.get(ref);
    return a ? { renderer: a.renderer } : null;
  }
  adapterFor(ref: string): RenderAdapter | null { return this.byRef.get(ref) ?? null; }
  /** The renderers that have at least one registered template. */
  renderers(): Renderer[] { return [...new Set([...this.byRef.values()].map((a) => a.renderer))]; }
  /** Every registered template reference. */
  templateRefs(): string[] { return [...this.byRef.keys()]; }
  supports(ref: string, type: OperationType): boolean { return !!this.byRef.get(ref)?.templates[ref]?.includes(type); }
}

/** No adapters: nothing is executable. This is the real state of the repository today. */
export const NO_ADAPTERS = new AdapterRegistry();

