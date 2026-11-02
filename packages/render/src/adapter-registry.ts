import type { Recipe, Renderer } from "@digikon/contracts";
import { AdapterRegistry, NO_ADAPTERS, type RenderAdapter } from "./adapter.js";
import { loadCapabilityRegistry } from "./capabilities.js";
import { createFfmpegAdapter } from "./ffmpeg.js";
import { createHyperframesStageAdapter } from "./hyperframes-stage.js";
import { createRemotionAdapter } from "./remotion.js";

export interface AdapterRegistryOptions {
  ffmpegOk: boolean;
  /** The font file the adapters draw with. Null or missing: no adapter can be built. */
  fontFile: string | null | undefined;
  outputRoot: string;
  capabilitiesDir?: string | null;
  recipes: { get(id: string): Pick<Recipe, "version"> | undefined };
}

export interface BuiltAdapters {
  registry: AdapterRegistry;
  available: boolean;
  /** Why an engine's adapter could not be built on this machine (no browser, no font, no ffmpeg). Never swallowed: the capability registry reports it. */
  failures: { engine: Renderer; reason: string }[];
}

const ENGINE_ORDER: Renderer[] = ["ffmpeg", "remotion", "hyperframes"];

/**
 * The adapters that can run on this machine now: the console's `registryFor`, moved here so the console and the capability registry use the same construction.
 * Validated learned templates are handed to the adapters every time, so a capability learned in one project is available in the next. An engine that cannot
 * be built is simply absent from the registry (a plan that needs it is blocked) and is listed in `failures` with the reason.
 */
export function buildAdapterRegistry(opts: AdapterRegistryOptions): BuiltAdapters {
  if (!opts.ffmpegOk || !opts.fontFile) {
    const reason = !opts.ffmpegOk ? "FFmpeg was not found on this machine" : "no font file is configured for the renderers";
    return { registry: NO_ADAPTERS, available: false, failures: ENGINE_ORDER.map((engine) => ({ engine, reason })) };
  }
  const font = opts.fontFile;
  const reg = loadCapabilityRegistry(opts.capabilitiesDir, { recipes: opts.recipes });
  const learned = reg.transitions("ffmpeg"), remotionLearned = reg.composed("remotion"), hyperframesLearned = reg.composed("hyperframes");
  const makers: [Renderer, (o: { fontFile: string; outputRoot: string }) => RenderAdapter][] = [
    ["ffmpeg", (o) => createFfmpegAdapter({ ...o, learned })],
    ["remotion", (o) => createRemotionAdapter({ ...o, learned: remotionLearned })],
    ["hyperframes", (o) => createHyperframesStageAdapter({ ...o, learned: hyperframesLearned })],
  ];
  const adapters: RenderAdapter[] = [], failures: BuiltAdapters["failures"] = [];
  for (const [engine, make] of makers) {
    try { adapters.push(make({ fontFile: font, outputRoot: opts.outputRoot })); } catch (e) { failures.push({ engine, reason: (e instanceof Error ? e.message : String(e)).slice(0, 300) }); }
  }
  return adapters.length ? { registry: new AdapterRegistry(adapters), available: true, failures } : { registry: NO_ADAPTERS, available: false, failures };
}
