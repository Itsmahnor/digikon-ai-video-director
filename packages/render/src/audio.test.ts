import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkMixedAudio, detectAudio, mixAudio, planAudio } from "./audio.js";

const scene = (id: string, start: number, extra: Partial<{ voiceover: string | null; audio_cues: string[]; asset_ids: string[] }> = {}) => ({ scene_id: id, start_time: start, duration_seconds: 3, voiceover: null, audio_cues: [], asset_ids: [], ...extra });
const CAPS = { tts: "sapi" as const };
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("the film's sound is planned from what the storyboard asks for", () => {
  it("a film that asks for nothing has no audio plan, and none is invented", () => {
    expect(planAudio({ scenes: [scene("S01", 0)], assets: [] }, CAPS)).toMatchObject({ required: false, tracks: [], unresolved: [] });
  });

  it("turns cues into music and effects, and labels what it generates", () => {
    const p = planAudio({ scenes: [scene("S01", 0, { audio_cues: ["soft piano music bed"] }), scene("S02", 3, { audio_cues: ["whoosh into the reveal"] })], assets: [], feel: "calm" }, CAPS);
    expect(p.tracks).toEqual([{ kind: "sfx", scene_id: "S02", at_s: 3, sound: "whoosh", cue: "whoosh into the reveal" }, { kind: "music", source: "generated", feel: "calm" }]);
    expect(p.unresolved).toEqual([]);
    expect(p.labels.join(" ")).toMatch(/generated on this computer, *|generated on this computer/);
  });

  it("a voiceover with no way to speak it is unresolved, never dropped", () => {
    const p = planAudio({ scenes: [scene("S01", 0, { voiceover: "Hello there." })], assets: [] }, { tts: null });
    expect(p.required).toBe(true);
    expect(p.unresolved).toEqual([{ scene_id: "S01", detail: expect.stringContaining("voiceover") }]);
  });

  it("narration that cannot fit its scene is reported before approval, not cut off", () => {
    const p = planAudio({ scenes: [scene("S01", 0, { voiceover: Array(30).fill("word").join(" ") })], assets: [] }, CAPS);
    expect(p.unresolved[0]!.detail).toMatch(/30 words/);
  });

  it("a cue it cannot make is unresolved, and a supplied recording is used for the voiceover in its scene", () => {
    expect(planAudio({ scenes: [scene("S01", 0, { audio_cues: ["the crowd roars"] })], assets: [] }, CAPS).unresolved[0]!.detail).toContain("the crowd roars");
    const p = planAudio({ scenes: [scene("S01", 0, { voiceover: "Hello.", asset_ids: ["A1"] })], assets: [{ asset_id: "A1", media_type: "audio" }] }, { tts: null });
    expect(p.tracks).toEqual([expect.objectContaining({ kind: "narration", source: "supplied", asset_id: "A1" })]);
    expect(p.unresolved).toEqual([]);
  });
});

describe.skipIf(!hasFfmpeg)("the sound is really in the finished file", () => {
  it("mixes music and an effect under the picture without touching it, and measures them", async () => {
    const work = mkdtempSync(join(tmpdir(), "audio-test-"));
    try {
      const video = join(work, "v.mp4"), out = join(work, "o.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
      const plan = planAudio({ scenes: [scene("S01", 0, { audio_cues: ["upbeat music bed"] }), scene("S02", 2, { audio_cues: ["soft chime"] })], assets: [], feel: "snappy" }, { tts: null });
      await mixAudio({ plan, video, duration_s: 4, out, work, caps: { tts: null }, assetFile: () => null });
      const check = await checkMixedAudio(out, plan);
      expect(check.problems).toEqual([]);
      const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", out], { encoding: "utf8" });
      expect(streams).toContain("aac");
      const hash = (f: string) => execFileSync("ffmpeg", ["-v", "error", "-i", f, "-map", "0:v", "-c", "copy", "-f", "md5", "-"], { encoding: "utf8" }).trim();
      expect(hash(out)).toBe(hash(video)); // the frames that were checked are the frames delivered
    } finally { rmSync(work, { recursive: true, force: true }); }
  }, 60_000);

  it.skipIf(detectAudio().tts === null)("speaks narration on this machine, and hears it in the right scene", async () => {
    const work = mkdtempSync(join(tmpdir(), "audio-test-"));
    try {
      const video = join(work, "v.mp4"), out = join(work, "o.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
      const caps = detectAudio();
      const plan = planAudio({ scenes: [scene("S01", 0, { voiceover: "Welcome to the show." })], assets: [] }, caps);
      await mixAudio({ plan, video, duration_s: 3, out, work, caps, assetFile: () => null });
      expect((await checkMixedAudio(out, plan)).problems).toEqual([]);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }, 90_000);
});
