import { z } from "zod";
import type { LlmClient } from "./llm.js";

/**
 * Look-and-fix. A human art director does not approve a storyboard from a list of element positions: they look at the frames. This step shows the model one still of each
 * composed scene (drawn locally by the renderer's own scene engine) in ONE call, asks for a critique, and turns what it says into concrete problems that the existing repair
 * attempt then fixes. It runs at most once per storyboard, only when a port is supplied, and the revised plan is kept only if it passes every check the first one did.
 * The pictures are reference data for the model; nothing here approves anything.
 */
export interface VisualCritiquePort {
  /** One still per composed scene, as PNG bytes; `skipped` names scenes that could not be drawn (fixed blocks), and `problem` says why nothing could be drawn. */
  stills(req: { scenes: readonly { scene_id: string; duration_seconds: number; visual: { block: string } | null }[]; aspect_ratio: "16:9" | "9:16" | "1:1"; art_direction: unknown }): Promise<{ stills: { scene_id: string; png: Buffer }[]; skipped: { scene_id: string; why: string }[]; problem: string | null }>;
}

export const StoryboardCritique = z.object({
  verdict: z.enum(["ok", "revise"]),
  /** One or two sentences: what the film looks like as a whole. */
  summary: z.string().min(1).max(400),
  /** What is visibly wrong or ordinary, scene by scene. Empty when the verdict is ok. At most six: the ones that matter most. */
  problems: z.array(z.object({
    scene_id: z.string().regex(/^S\d{2,}$/),
    /** What you can SEE is wrong or weak (overlap, cramped, empty, flat hierarchy, nothing leads, looks like the neighbouring scene). */
    seen: z.string().min(1).max(300),
    /** A concrete change to the composition (move, resize, change the entrance, add a group or mask), not a general wish. */
    fix: z.string().min(1).max(300),
  })).max(6),
});
export type StoryboardCritique = z.infer<typeof StoryboardCritique>;

export const CRITIQUE_SYSTEM = [
  "You are an art director reviewing a storyboard by looking at one still of each composed scene (the frame after everything has arrived).",
  "Judge what you can see: does one thing clearly lead; is there room to breathe; does anything overlap, crowd the edge or sit in dead space; do neighbouring scenes look different from each other; does the set read as one film with a consistent look yet real variety?",
  "Be specific and sparing. Name only problems that a viewer would notice, at most six, and give a concrete fix for each in the terms of the composition (positions and sizes as shares of the frame, text size, entrance, a group, a mask, a shape that gives the eye a place to land).",
  "Do not ask for new words, figures, claims, logos or pictures: the copy is approved and fixed. If the film already looks good, say verdict ok with no problems.",
].join(" ");

export interface CritiqueInput {
  stills: readonly { scene_id: string; png: Buffer }[];
  skipped: readonly { scene_id: string; why: string }[];
  treatment: { logline: string; tone: string };
  scenes: readonly { scene_id: string; duration_seconds: number; purpose: string }[];
}

/** One model call. Returns the critique, or null when there is nothing to look at. */
export async function critiqueStoryboard(llm: LlmClient, input: CritiqueInput): Promise<StoryboardCritique | null> {
  if (!input.stills.length) return null;
  const user = [
    `The film: ${input.treatment.logline} Tone: ${input.treatment.tone}.`,
    "Scenes (the stills above are in this order):",
    ...input.scenes.map((s) => `- ${s.scene_id} (${s.duration_seconds}s): ${s.purpose}`),
    input.skipped.length ? `Not shown (drawn another way, so judge only how the shown scenes sit beside them): ${input.skipped.map((s) => s.scene_id).join(", ")}.` : "",
    "Review the stills and return your critique through the storyboard_critique tool.",
  ].filter(Boolean).join("\n");
  return llm.generate({ name: "storyboard_critique", system: CRITIQUE_SYSTEM, user, schema: StoryboardCritique, maxTokens: 1500, forceTool: true, images: input.stills.map((s) => ({ label: `Scene ${s.scene_id}:`, media_type: "image/png" as const, data_base64: s.png.toString("base64") })) });
}

/** The critique as problems for the repair attempt, one line each. Empty when the critique is ok. Only scenes that exist are kept. */
export function critiqueIssues(c: StoryboardCritique | null, sceneIds: ReadonlySet<string>): string[] {
  if (!c || c.verdict === "ok") return [];
  return c.problems.filter((p) => sceneIds.has(p.scene_id)).map((p) => `${p.scene_id}: seen in the rendered still: ${p.seen} Change: ${p.fix}`);
}
