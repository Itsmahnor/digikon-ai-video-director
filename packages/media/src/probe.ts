import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { Asset } from "@digikon/contracts";
import { ALLOWED_EXTENSIONS, ALL_EXTENSIONS, MEDIA_LIMITS } from "./limits.js";

const run = promisify(execFile);

export interface UploadIssue {
  code:
    | "missing_file" | "unsupported_type" | "too_large" | "empty_file" | "unreadable" | "no_streams"
    | "too_long" | "zero_duration" | "bad_dimensions" | "too_many_assets";
  message: string;
}

export type ProbeResult = { ok: true; asset: Asset } | { ok: false; issues: UploadIssue[] };

const Probe = z.object({
  format: z.object({ duration: z.string().optional(), format_name: z.string().optional(), size: z.string().optional() }).passthrough(),
  streams: z.array(z.object({
    codec_type: z.string().optional(),
    codec_name: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    avg_frame_rate: z.string().optional(),
    duration: z.string().optional(),
    nb_frames: z.string().optional(),
    disposition: z.object({ attached_pic: z.number().optional() }).passthrough().optional(),
  }).passthrough()),
});

const fps = (r?: string) => {
  if (!r) return null;
  const [n, d] = r.split("/").map(Number);
  return n && d ? Math.round((n / d) * 100) / 100 : null;
};

const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "bmp", "gif", "tiff", "av1"]);

/**
 * Probes a file with ffprobe and returns an Asset, or every reason it cannot be used.
 * Arguments are passed as an array, never through a shell, so file names cannot inject commands.
 */
export async function probeFile(path: string, opts: { assetId?: string; originalName?: string } = {}): Promise<ProbeResult> {
  const name = opts.originalName ?? path;
  const ext = extname(name).toLowerCase();
  const issues: UploadIssue[] = [];

  if (!ALL_EXTENSIONS.includes(ext)) {
    return { ok: false, issues: [{ code: "unsupported_type", message: `"${ext || "no extension"}" is not supported. Use ${ALL_EXTENSIONS.join(", ")}.` }] };
  }
  let size: number;
  try { size = (await stat(path)).size; } catch { return { ok: false, issues: [{ code: "missing_file", message: "file not found" }] }; }
  if (size === 0) return { ok: false, issues: [{ code: "empty_file", message: "file is empty" }] };

  let parsed: z.infer<typeof Probe>;
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    parsed = Probe.parse(JSON.parse(stdout));
  } catch {
    return { ok: false, issues: [{ code: "unreadable", message: "could not read this file. It may be corrupt or not a real media file." }] };
  }

  const video = parsed.streams.find((s) => s.codec_type === "video");
  const audioTracks = parsed.streams.filter((s) => s.codec_type === "audio").length;
  if (!video && audioTracks === 0) return { ok: false, issues: [{ code: "no_streams", message: "no audio or video found in this file" }] };

  const attachedPic = video?.disposition?.attached_pic === 1;
  const isImage = !!video && (ALLOWED_EXTENSIONS.image as readonly string[]).includes(ext) && IMAGE_CODECS.has(video.codec_name ?? "");
  const media_type: Asset["media_type"] = isImage ? "image" : video && !attachedPic ? "video" : "audio";
  const duration = media_type === "image" ? null : Number(parsed.streams.find((s) => s.duration)?.duration ?? parsed.format.duration ?? NaN);
  const limit = media_type === "video" ? MEDIA_LIMITS.maxVideoBytes : media_type === "audio" ? MEDIA_LIMITS.maxAudioBytes : MEDIA_LIMITS.maxImageBytes;

  if (size > limit) issues.push({ code: "too_large", message: `${(size / 1048576).toFixed(0)} MB exceeds the ${(limit / 1048576).toFixed(0)} MB limit for ${media_type}` });
  if (media_type !== "image") {
    if (duration === null || !Number.isFinite(duration) || duration <= 0) issues.push({ code: "zero_duration", message: "could not determine a positive duration" });
    else if (duration > MEDIA_LIMITS.maxAssetSeconds) issues.push({ code: "too_long", message: `${Math.round(duration)}s exceeds the ${MEDIA_LIMITS.maxAssetSeconds}s limit` });
  }
  const width = media_type === "audio" ? null : video?.width ?? null;
  const height = media_type === "audio" ? null : video?.height ?? null;
  if (media_type !== "audio" && (!width || !height || Math.min(width, height) < MEDIA_LIMITS.minDimension || Math.max(width, height) > MEDIA_LIMITS.maxDimension)) {
    issues.push({ code: "bad_dimensions", message: `frame size ${width ?? "?"}x${height ?? "?"} is outside ${MEDIA_LIMITS.minDimension}-${MEDIA_LIMITS.maxDimension}px` });
  }
  if (issues.length) return { ok: false, issues };

  return {
    ok: true,
    asset: Asset.parse({
      asset_id: opts.assetId ?? `asset_${randomUUID().slice(0, 8)}`,
      uri: path,
      media_type,
      duration: duration === null ? null : Math.round(duration * 1000) / 1000,
      width,
      height,
      audio_tracks: audioTracks,
      metadata: {
        original_name: name,
        bytes: size,
        container: parsed.format.format_name ?? null,
        video_codec: video?.codec_name ?? null,
        fps: media_type === "video" ? fps(video?.avg_frame_rate) : null,
      },
    }),
  };
}

/** Decodes any audio or video file to mono 16 kHz float samples, which is what Whisper expects. */
export async function decodeToPcm16k(path: string, maxSeconds: number = MEDIA_LIMITS.maxAssetSeconds): Promise<Float32Array> {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-i", path, "-vn", "-t", String(maxSeconds), "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
    { encoding: "buffer", timeout: 120_000, maxBuffer: 16000 * 4 * (maxSeconds + 5) },
  );
  const buf = stdout as unknown as Buffer;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4)));
}
