import { BUILDING_BLOCKS as B } from "@digikon/contracts";

/**
 * What the stub model does instead of choosing blocks when it is asked to compose (DemoClient with `compose`). It is not Claude and has no taste: it varies the layout of each
 * scene from a seed taken from the film's own words, so two different briefs get visibly different layouts, and it draws only words the treatment and the scene already carry,
 * so the same grounding check that guards a real model's compositions passes. A real model writes its own elements; this exists so the pipeline can be run and tested end to end.
 */
export interface DemoLines { logline: string; hook: string; cta: string; overlay: string | null }
const words = (s: string): string[] => s.replace(/[.!?]+$/g, "").split(/\s+/).filter(Boolean);
/** n contiguous runs of at most `max` words from the pool, wrapping to the start when the pool is short. Every run is a fragment of the text it came from. */
function runs(pool: string[], n: number, max: number): string[] {
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    if (at >= pool.length) at = 0;
    const len = Math.min(max, Math.max(1, pool.length - at));
    out.push(pool.slice(at, at + len).join(" ").replace(/[,;:]+$/, ""));
    at += len;
  }
  return out;
}
export const seedOf = (s: string): number => { let h = 7; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
const BACKDROPS = ["flat", "gradient", "grid", "dots", "spotlight", "vignette", "paper"] as const;
const CAMERAS: Record<string, "static" | "push_in" | "pull_out" | "pan_left" | "pan_right"> = { static: "static", slow_push_in: "push_in", pull_out: "pull_out", pan_left: "pan_left", pan_right: "pan_right" };

export function composeScene(kind: "open" | "middle" | "close", index: number, shotCamera: string, l: DemoLines) {
  const seed = seedOf(`${l.logline}|${l.hook}|${l.cta}`);
  const pool = words(l.logline), hook = words(l.hook);
  const camera = CAMERAS[shotCamera] ?? "static";
  const base = { block: "composition" as const, camera, reveal: "none" as const, backdrop: BACKDROPS[(seed + index) % BACKDROPS.length]! };
  if (kind === "open") {
    const line = l.overlay ?? l.hook;
    return { ...base, intent: "Open on the one line the film is about, set large and arriving word by word.", elements: (seed % 2 ? B.kineticHeadline(line) : B.titleBlock(line, undefined, undefined)) };
  }
  if (kind === "close") {
    const action = l.cta;
    return { ...base, intent: "Close on one action, held still.", elements: (seed % 2 ? B.endCard(action) : B.closingBlock(action)) };
  }
  const pick = (seed + index) % 5;
  switch (pick) {
    case 0: return { ...base, intent: "Show the idea as stacked layers of the film's own words, one on top of the next.", elements: B.layeredCards(runs(pool, 3, 3).map((title) => ({ title }))) };
    case 1: return { ...base, intent: "Cut the frame into panels, one word of the idea on each.", elements: B.splitPanels(runs(hook.length >= 3 ? hook : pool, 3, 1).map((word) => ({ word }))) };
    case 2: return { ...base, intent: "Lay the idea out as a short sequence that draws itself in order.", elements: B.processFlow(runs(pool, 3, 2).map((label) => ({ label }))) };
    case 3: return { ...base, intent: "Place the idea along a line, moment by moment.", elements: B.timelineRule(runs(pool, 3, 2).map((label, i) => ({ when: words(l.hook)[i] ?? words(l.logline)[i] ?? "Now", label }))) };
    default: return { ...base, intent: "Pull the idea apart into labelled parts around one form.", elements: B.specCallouts(runs(pool, 3, 3).map((label) => ({ label }))) };
  }
}