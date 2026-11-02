import type { Renderer } from "@digikon/contracts";
import { AdapterRegistry, type RenderAdapter } from "./adapter.js";
import { implementationsOf, type ImplementationList } from "./capability-registry.js";

/**
 * Test support: real `AdapterRegistry` objects built from stub adapters, so tests exercise the same runtime resolution path (`implementationsOf`) as the console
 * instead of handing the registry a list. A stub renders nothing. `engines` limits which engines have a live adapter, to model an adapter that could not be built.
 */
export function stubAdapters(templates: ImplementationList, engines: readonly Renderer[] = ["ffmpeg", "remotion", "hyperframes"]): AdapterRegistry {
  const byEngine = new Map<Renderer, Record<string, readonly string[]>>();
  for (const [ref, ops] of Object.entries(templates)) {
    const engine = ref.split("/")[0] as Renderer;
    if (!engines.includes(engine)) continue;
    byEngine.set(engine, { ...(byEngine.get(engine) ?? {}), [ref]: ops });
  }
  const adapters: RenderAdapter[] = [...byEngine].map(([renderer, t]) => ({ renderer, templates: t as RenderAdapter["templates"], render: async () => undefined }));
  return new AdapterRegistry(adapters);
}

/** Live (stub-adapter) resolution of a declared list. */
export const liveImplementations = (declared: ImplementationList, engines?: readonly Renderer[]): ImplementationList => implementationsOf(stubAdapters(declared, engines));
