import type { Renderer, RenderRecord } from "@digikon/contracts";
import type { RenderCapabilities } from "./coverage.js";
import { FFMPEG_CAPABILITIES } from "./ffmpeg.js";
import { HYPERFRAMES_CAPABILITIES } from "./hyperframes.js";
import { REMOTION_CAPABILITIES } from "./remotion.js";

/** What each renderer can show, in the form the coverage check takes. Anything not listed counts as not shown. */
export const RENDERER_CAPABILITIES: Readonly<Record<Renderer, RenderCapabilities>> = {
  ffmpeg: FFMPEG_CAPABILITIES,
  remotion: REMOTION_CAPABILITIES,
  hyperframes: HYPERFRAMES_CAPABILITIES,
};

export interface RendererSelection {
  /** The one renderer that can run every operation, or null. */
  selected: Renderer | null;
  /** Every renderer the operations' templates name, so a plan that needs two is visible. */
  needed: Renderer[];
  /** True when the plan needs more than one renderer. Composing renderers into one video is not built, so such a plan is blocked. */
  composition_required: boolean;
  /** Operations no registered renderer can run, each with the reasons the planner gave. */
  unsupported: { operation_id: string; template: string; reasons: string[] }[];
  /** The capabilities to judge the render's coverage against: the selected renderer's, else the first renderer the plan needs, else FFmpeg's (the original default). */
  capabilities: RenderCapabilities;
}

/**
 * The renderer comes from the approved edit plan, never the other way round: each operation's recipe names a template, the template
 * belongs to one renderer, and only an adapter that is registered for it counts. Nothing is swapped for another renderer's look-alike.
 * A plan whose operations need different renderers is reported, not silently split or simplified.
 */
export function selectRenderer(record: Pick<RenderRecord, "operations" | "blockers">): RendererSelection {
  const supported = record.operations.filter((o) => o.renderer !== null);
  const needed = [...new Set(supported.map((o) => o.renderer!))];
  const unsupported = record.operations.filter((o) => o.renderer === null).map((o) => ({
    operation_id: o.operation_id,
    template: o.implementation_ref,
    reasons: record.blockers.filter((b) => b.startsWith(`${o.operation_id}:`)).map((b) => b.slice(o.operation_id.length + 1).trim()),
  }));
  const selected = unsupported.length === 0 && needed.length === 1 ? needed[0]! : null;
  return { selected, needed, composition_required: needed.length > 1, unsupported, capabilities: RENDERER_CAPABILITIES[selected ?? needed[0] ?? "ffmpeg"] };
}
