import { z } from "zod";
import { AspectRatio, Project } from "./schemas.js";

/**
 * A: user has little or nothing and wants a video made.
 * B: user has footage, audio and facts and wants a video made.
 * C: user has a finished video (a reel) and wants it edited.
 */
export const RouteMode = z.enum(["create_minimal", "create_full", "edit_existing"]);
export type RouteMode = z.infer<typeof RouteMode>;

export const Turn = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).max(4000),
  /** True when the text came from a spoken prompt transcribed by Whisper. */
  from_voice: z.boolean().default(false),
  language: z.string().nullable().default(null),
});
export type Turn = z.infer<typeof Turn>;

/** What the model reads out of the conversation. Code validates every field before it is used. */
export const RouterFields = z.object({
  objective: z.string().nullable(),
  audience: z.string().nullable(),
  platform: z.string().nullable(),
  aspect_ratio: AspectRatio.nullable(),
  target_duration_s: z.number().nullable(),
  tone: z.string().nullable(),
  language: z.string().nullable(),
  edit_instructions: z.array(z.string()).default([]),
});

export const RouterModelOut = z.object({
  mode: RouteMode,
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  fields: RouterFields,
  questions: z.array(z.string()).default([]),
});
export type RouterModelOut = z.infer<typeof RouterModelOut>;

export const EditRequest = z.object({
  instructions: z.array(z.string().min(1).max(300)).min(1).max(10),
  /** Source reel(s) to edit. */
  source_asset_ids: z.array(z.string()).min(1),
  platform: z.string().nullable(),
  aspect_ratio: AspectRatio.nullable(),
  target_duration_s: z.number().positive().max(180).nullable(),
});
export type EditRequest = z.infer<typeof EditRequest>;

export const RoutedRequest = z.object({
  mode: RouteMode,
  language: z.string().nullable(),
  /** Everything the router filled in on its own. Shown to the user so nothing is silently invented. */
  assumptions: z.array(z.string()),
  /** Set for create_minimal and create_full. */
  project: Project.nullable(),
  /** Set for edit_existing. */
  edit: EditRequest.nullable(),
  asset_ids: z.array(z.string()),
});
export type RoutedRequest = z.infer<typeof RoutedRequest>;

export const RouteResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("needs_input"),
    questions: z.array(z.string()).min(1),
    mode_guess: RouteMode.nullable(),
    /** After repeated rounds the UI should offer a plain form instead of more questions. */
    form_fallback: z.boolean(),
    notes: z.array(z.string()),
  }),
  z.object({ status: z.literal("ready"), request: RoutedRequest, rationale: z.string(), confidence: z.number() }),
]);
export type RouteResult = z.infer<typeof RouteResult>;
