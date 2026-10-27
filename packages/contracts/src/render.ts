import { z } from "zod";
import { Renderer } from "./recipe.js";
import { AspectRatio, OperationType } from "./schemas.js";

/**
 * The boundary of rendering. A render starts from a contract-valid, approved EditorOutput and ends in exactly one of five
 * states. Only `rendered` says a video exists, and it cannot be expressed without a measured output file.
 *
 *   planning    - something is missing or refused (settings, assets, template, renderer, readiness); `blockers` says what;
 *   executable  - every check passed and a renderer is available, but nothing has been started;
 *   rendering   - an adapter is running;
 *   rendered    - the adapter produced a file and it was probed and matched the settings (`output`);
 *   failed      - the adapter or the output check failed; `errors` says why. No output is recorded.
 */
export const RENDER_SCHEMA_VERSION = "1.0.0" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const PlanRef = z.object({ version: z.number().int().positive(), hash: Sha256 });

export const OutputContainer = z.enum(["mp4", "mov", "webm"]);
export const VideoCodec = z.enum(["h264", "h265", "vp9", "prores"]);
export const AudioCodec = z.enum(["aac", "mp3", "opus", "pcm_s16le"]);

/** Which codecs each container can carry. A technical rule of the formats, not a platform specification. */
export const CONTAINER_CODECS: Record<z.infer<typeof OutputContainer>, { video: readonly string[]; audio: readonly string[] }> = {
  mp4: { video: ["h264", "h265"], audio: ["aac", "mp3"] },
  mov: { video: ["h264", "h265", "prores"], audio: ["aac", "pcm_s16le"] },
  webm: { video: ["vp9"], audio: ["opus"] },
};
const RATIO: Record<z.infer<typeof AspectRatio>, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 };
const MAX_SIDE = 7680;

/** Where the settings came from. They are never defaulted: a user decision or a verified specification must stand behind them. */
export const SettingsSource = z.object({
  kind: z.enum(["user_approved", "verified_documentation"]),
  reference: z.string().min(1),
});

/** What the output file must be. Every field is required; there are no project defaults to fall back on. */
export const RenderSettings = z
  .object({
    aspect_ratio: AspectRatio,
    width: z.number().int().positive().max(MAX_SIDE),
    height: z.number().int().positive().max(MAX_SIDE),
    fps: z.number().positive().max(240),
    duration_s: z.number().positive(),
    container: OutputContainer,
    video_codec: VideoCodec,
    /** null: the output carries no audio track. A plan that includes audio needs a codec here. */
    audio_codec: AudioCodec.nullable(),
    source: SettingsSource,
  })
  .superRefine((s, ctx) => {
    const bad = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
    const ratio = s.width / s.height;
    if (Math.abs(ratio - RATIO[s.aspect_ratio]) / RATIO[s.aspect_ratio] > 0.01) bad(`${s.width}x${s.height} is not ${s.aspect_ratio}`, "width");
    if ((s.video_codec === "h264" || s.video_codec === "h265") && (s.width % 2 || s.height % 2)) bad(`${s.video_codec} needs even width and height`, "width");
    const allowed = CONTAINER_CODECS[s.container];
    if (!allowed.video.includes(s.video_codec)) bad(`${s.container} cannot carry ${s.video_codec} video (allowed: ${allowed.video.join(", ")})`, "video_codec");
    if (s.audio_codec && !allowed.audio.includes(s.audio_codec)) bad(`${s.container} cannot carry ${s.audio_codec} audio (allowed: ${allowed.audio.join(", ")})`, "audio_codec");
  });
export type RenderSettings = z.infer<typeof RenderSettings>;

export const RenderState = z.enum(["planning", "executable", "rendering", "rendered", "failed"]);
export type RenderState = z.infer<typeof RenderState>;

export const RenderPurpose = z.enum(["production", "preview"]);
export type RenderPurpose = z.infer<typeof RenderPurpose>;

export const RenderOperation = z.object({
  operation_id: z.string(),
  operation_type: OperationType,
  recipe_id: z.string(),
  implementation_ref: z.string(),
  /** The renderer that would run it, or null when none can. */
  renderer: Renderer.nullable(),
  production_executable: z.boolean(),
});

/** An asset the render needs, and whether it was found unchanged. A missing file is recorded as missing, never as present. */
export const RenderAsset = z.object({
  asset_id: z.string(),
  media_type: z.enum(["video", "image", "audio"]),
  uri: z.string(),
  present: z.boolean(),
});

export const RenderError = z.object({
  stage: z.enum(["precheck", "adapter", "timeout", "missing_output", "output_validation"]),
  message: z.string().min(1),
});
export type RenderError = z.infer<typeof RenderError>;

/** A measured output file. Every value comes from probing the file, none from the adapter's claim. */
export const RenderOutput = z.object({
  path: z.string().min(1),
  bytes: z.number().int().positive(),
  sha256: Sha256,
  container: OutputContainer,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  duration_s: z.number().positive(),
  video_codec: VideoCodec,
  audio_codec: AudioCodec.nullable(),
  audio_tracks: z.number().int().nonnegative(),
  validated_at: z.string().datetime(),
  /** The checks that passed, each with the measurement behind it. */
  checks: z.array(z.string()).min(1),
});
export type RenderOutput = z.infer<typeof RenderOutput>;

export const RenderRecord = z
  .object({
    schema_version: z.literal(RENDER_SCHEMA_VERSION),
    render_id: z.string().regex(/^rn_[a-f0-9]{16}$/),
    /** `production` needs reviewed recipes and a production-ready handoff. `preview` may use draft recipes and says so. */
    purpose: RenderPurpose,
    handoff_id: z.string().min(1),
    handoff_content_hash: Sha256,
    approved: z.object({ storyboard: PlanRef, edit_plan: PlanRef }),
    state: RenderState,
    /** null while the caller has not supplied valid settings. */
    settings: RenderSettings.nullable(),
    operations: z.array(RenderOperation),
    assets: z.array(RenderAsset),
    /** True when the plan includes audio (a mix operation or a source that carries audio). */
    audio_required: z.boolean(),
    /** Why the render cannot start. Empty from `executable` on. */
    blockers: z.array(z.string()),
    errors: z.array(RenderError),
    output: RenderOutput.nullable(),
    notes: z.array(z.string()),
    created_at: z.string().datetime(),
    started_at: z.string().datetime().nullable(),
    finished_at: z.string().datetime().nullable(),
  })
  .superRefine((r, ctx) => {
    const bad = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
    if (r.state !== "rendered" && r.output) bad("only a rendered record may carry an output file", "output");
    if (r.state === "planning" && !r.blockers.length) bad("planning needs at least one blocker", "blockers");
    if (r.state !== "planning" && r.state !== "failed" && r.blockers.length) bad("a render with blockers cannot be executable, running or rendered", "blockers");
    if (r.state !== "planning" && !r.settings) bad("a render without valid settings cannot leave planning", "settings");
    if (r.state === "failed" && !r.errors.length) bad("failed needs at least one error", "errors");
    if (r.state === "rendering" && !r.started_at) bad("rendering needs started_at", "started_at");
    if ((r.state === "rendered" || r.state === "failed") && !r.finished_at) bad("a finished render needs finished_at", "finished_at");
    if (r.state === "rendered") {
      if (!r.output) bad("rendered needs a validated output file", "output");
      if (r.errors.length) bad("a rendered record cannot carry errors", "errors");
      if (r.output && r.settings) {
        const o = r.output, s = r.settings;
        if (o.width !== s.width || o.height !== s.height) bad("the output frame size is not the settings' size", "output");
        if (o.container !== s.container || o.video_codec !== s.video_codec || o.audio_codec !== s.audio_codec) bad("the output container or codecs are not the settings'", "output");
        if (r.audio_required && o.audio_tracks === 0) bad("the plan includes audio but the output has no audio track", "output");
      }
    }
  });
export type RenderRecord = z.infer<typeof RenderRecord>;
