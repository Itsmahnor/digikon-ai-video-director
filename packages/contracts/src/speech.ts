import { z } from "zod";

export const TranscriptWord = z.object({
  text: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});

/** A caption-sized phrase built from words. Useful for captions and cut points. */
export const TranscriptSegment = z.object({
  text: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});

export const Transcript = z.object({
  text: z.string(),
  /** ISO 639-1 style code, for example "en", "ur", "hi". */
  language: z.string().min(2),
  /** Share of probability on the detected language among all languages, 0 to 1. */
  language_confidence: z.number().min(0).max(1),
  words: z.array(TranscriptWord),
  segments: z.array(TranscriptSegment),
  duration_s: z.number().nonnegative(),
  model: z.string(),
  /** Reasons a human should double-check this transcript. */
  warnings: z.array(z.enum(["low_language_confidence", "very_quiet_audio", "truncated"])).default([]),
});

export type Transcript = z.infer<typeof Transcript>;
export type TranscriptWord = z.infer<typeof TranscriptWord>;
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;
