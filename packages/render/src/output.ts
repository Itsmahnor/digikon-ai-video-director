import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";
import { RenderOutput, type RenderSettings } from "@digikon/contracts";

const run = promisify(execFile);

/** What ffprobe calls each codec the contract names. */
const VIDEO_NAME: Record<RenderSettings["video_codec"], string> = { h264: "h264", h265: "hevc", vp9: "vp9", prores: "prores" };
const FORMAT_TOKEN: Record<RenderSettings["container"], string> = { mp4: "mp4", mov: "mov", webm: "webm" };

const rate = (r?: string) => {
  const [n, d] = (r ?? "").split("/").map(Number);
  return n && d ? n / d : null;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export type OutputCheck = { ok: true; output: RenderOutput } | { ok: false; issues: string[] };

/**
 * Decides whether a file is the video the settings describe. Everything is measured with ffprobe (arguments as an array, no
 * shell); nothing is taken from the adapter. A missing, empty, unreadable or mismatching file is a list of issues, never a pass.
 */
export async function validateOutput(path: string, settings: RenderSettings, audioRequired: boolean, now: () => Date = () => new Date()): Promise<OutputCheck> {
  let bytes: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) return { ok: false, issues: [`no output file was produced at ${path}`] };
    bytes = st.size;
  } catch {
    return { ok: false, issues: [`no output file was produced at ${path}`] };
  }
  if (bytes === 0) return { ok: false, issues: ["the output file is empty"] };

  let probe: { format?: { format_name?: string; duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; disposition?: { attached_pic?: number } }[] };
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    probe = JSON.parse(stdout);
  } catch {
    return { ok: false, issues: ["the output file cannot be read as media (it may be corrupt or truncated)"] };
  }

  const issues: string[] = [], checks: string[] = [];
  const videos = (probe.streams ?? []).filter((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audios = (probe.streams ?? []).filter((s) => s.codec_type === "audio");
  const v = videos[0];
  if (!v) return { ok: false, issues: ["the output has no video stream"] };

  const ext = extname(path).toLowerCase().slice(1);
  const formats = (probe.format?.format_name ?? "").split(",");
  if (ext !== settings.container) issues.push(`the file extension is .${ext}, not .${settings.container}`);
  else if (!formats.includes(FORMAT_TOKEN[settings.container]) && !(settings.container === "webm" && formats.includes("matroska"))) issues.push(`the file is "${probe.format?.format_name}", not ${settings.container}`);
  else checks.push(`container=${settings.container} (probe format ${probe.format?.format_name})`);

  if (v.width !== settings.width || v.height !== settings.height) issues.push(`the frame is ${v.width}x${v.height}, not ${settings.width}x${settings.height}`);
  else checks.push(`size=${v.width}x${v.height}`);

  const fps = rate(v.avg_frame_rate);
  if (fps === null || Math.abs(fps - settings.fps) > 0.05) issues.push(`the frame rate is ${fps === null ? "unknown" : r2(fps)}, not ${settings.fps}`);
  else checks.push(`fps=${r2(fps)}`);

  const duration = Number(probe.format?.duration ?? NaN);
  const tol = Math.max(0.25, 1 / settings.fps);
  if (!Number.isFinite(duration) || duration <= 0) issues.push("the duration cannot be measured");
  else if (Math.abs(duration - settings.duration_s) > tol) issues.push(`the video lasts ${r2(duration)}s, not ${settings.duration_s}s (tolerance ${r2(tol)}s)`);
  else checks.push(`duration=${r2(duration)}s (settings ${settings.duration_s}s)`);

  if (v.codec_name !== VIDEO_NAME[settings.video_codec]) issues.push(`the video codec is ${v.codec_name}, not ${settings.video_codec}`);
  else checks.push(`video_codec=${v.codec_name}`);

  if (settings.audio_codec) {
    const a = audios[0];
    if (!a) issues.push("the settings ask for audio but the output has no audio track");
    else if (a.codec_name !== settings.audio_codec) issues.push(`the audio codec is ${a.codec_name}, not ${settings.audio_codec}`);
    else checks.push(`audio_codec=${a.codec_name} tracks=${audios.length}`);
  } else {
    if (audioRequired) issues.push("the plan includes audio but the settings choose no audio codec");
    if (audios.length) issues.push("the settings choose no audio, but the output has an audio track");
    else checks.push("audio_tracks=0 (as settings)");
  }
  if (issues.length) return { ok: false, issues };

  const parsed = RenderOutput.safeParse({
    path, bytes, sha256: await sha256Of(path), container: settings.container, width: v.width, height: v.height, fps: r2(fps!), duration_s: r2(duration),
    video_codec: settings.video_codec, audio_codec: settings.audio_codec, audio_tracks: audios.length, validated_at: now().toISOString(), checks,
  });
  return parsed.success ? { ok: true, output: parsed.data } : { ok: false, issues: parsed.error.issues.map((i) => `output ${i.path.join(".")}: ${i.message}`) };
}
