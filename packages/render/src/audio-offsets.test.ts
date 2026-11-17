import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkMixedAudio, cueOffset, mixAudio, planAudio } from "./audio.js";

const scene = (id: string, start: number, extra: Partial<{ duration_seconds: number; voiceover: string | null; audio_cues: string[]; asset_ids: string[] }> = {}) => ({ scene_id: id, start_time: start, duration_seconds: 4, voiceover: null, audio_cues: [], asset_ids: [], ...extra });
const CAPS = { tts: null };
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("a cue may name the moment inside its scene", () => {
  it("reads seconds from the scene's start in the forms a Director writes", () => {
    for (const [cue, s] of [["a hit at 1.5s", 1.5], ["a click at 0.8 seconds", 0.8], ["chime @2s", 2], ["a whoosh AT 3 secs", 3], ["soft hit at 2 sec as the cards lock", 2]] as const) expect(cueOffset(cue), cue).toBe(s);
    for (const cue of ["a hit", "a hit on the 3rd card", "a click as each message lands", "a hit at the start", "a hit at s"]) expect(cueOffset(cue), cue).toBeNull();
  });

  it("places the effect at the scene's start plus the moment", () => {
    const p = planAudio({ scenes: [scene("S01", 0), scene("S02", 4, { audio_cues: ["a hit at 1.5s"] })], assets: [] }, CAPS);
    expect(p.tracks).toEqual([{ kind: "sfx", scene_id: "S02", at_s: 5.5, sound: "hit", cue: "a hit at 1.5s" }]);
    expect(p.unresolved).toEqual([]);
  });

  it("a cue with no moment still lands at the scene's start, exactly as before", () => {
    const p = planAudio({ scenes: [scene("S01", 0), scene("S02", 4, { audio_cues: ["a hit"] })], assets: [] }, CAPS);
    expect(p.tracks).toEqual([{ kind: "sfx", scene_id: "S02", at_s: 4, sound: "hit", cue: "a hit" }]);
  });

  it("several effects in one scene each keep their own moment", () => {
    const p = planAudio({ scenes: [scene("S01", 2, { audio_cues: ["a whoosh at 0.2s", "a hit at 1.1s", "a chime at 3s"] })], assets: [] }, CAPS);
    expect(p.tracks.map((t) => (t.kind === "sfx" ? [t.sound, t.at_s] : null))).toEqual([["whoosh", 2.2], ["hit", 3.1], ["chime", 5]]);
  });

  it("a moment outside the scene is reported before approval, never moved or dropped", () => {
    const p = planAudio({ scenes: [scene("S01", 0, { duration_seconds: 3, audio_cues: ["a hit at 3s"] }), scene("S02", 3, { audio_cues: ["a click at 9s"] })], assets: [] }, CAPS);
    expect(p.tracks).toEqual([]);
    expect(p.required).toBe(true);
    expect(p.unresolved).toEqual([
      { scene_id: "S01", detail: expect.stringContaining("outside the 3s scene") },
      { scene_id: "S02", detail: expect.stringContaining("puts a sound at 9s") },
    ]);
  });

  it("a moment just inside the scene is allowed", () => {
    const p = planAudio({ scenes: [scene("S01", 0, { audio_cues: ["a hit at 3.9s"] })], assets: [] }, CAPS);
    expect(p.unresolved).toEqual([]);
    expect(p.tracks).toHaveLength(1);
  });

  it("only sounds the plan already accepts are placed: a sound that cannot be made stays unresolved with its moment", () => {
    const p = planAudio({ scenes: [scene("S01", 0, { audio_cues: ["the crowd roars at 2s"] })], assets: [] }, CAPS);
    expect(p.tracks).toEqual([]);
    expect(p.unresolved[0]!.detail).toContain("the crowd roars at 2s");
  });

  it("a scene with no cues gets no effect: the offset reading adds nothing the storyboard did not ask for", () => {
    const p = planAudio({ scenes: [scene("S01", 0), scene("S02", 4)], assets: [] }, CAPS);
    expect(p).toMatchObject({ required: false, tracks: [], unresolved: [] });
  });
});

describe.skipIf(!hasFfmpeg)("the sound really lands at that moment in the mixed file", () => {
  /** Mean level, in dB, of a stretch of the mixed file; -Infinity when it is digital silence. */
  const meanDb = (file: string, from: number, seconds: number): number => {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-ss", String(from), "-t", String(seconds), "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
    const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr);
    return m && m[1] !== "-inf" ? Number(m[1]) : -Infinity;
  };
  const mix = async (cue: string) => {
    const work = mkdtempSync(join(tmpdir(), "audio-offset-"));
    const video = join(work, "v.mp4"), out = join(work, "o.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
    const plan = planAudio({ scenes: [scene("S01", 0, { audio_cues: [cue] })], assets: [] }, CAPS);
    await mixAudio({ plan, video, duration_s: 4, out, work, caps: CAPS, assetFile: () => null });
    return { work, out, plan };
  };

  it("an effect at 2s is silent before 2s, audible from 2s, and the checker measures it there", async () => {
    const m = await mix("a hit at 2s");
    try {
      expect(m.plan.tracks).toEqual([expect.objectContaining({ kind: "sfx", at_s: 2 })]);
      expect(meanDb(m.out, 0, 1.5)).toBeLessThan(-60);
      expect(meanDb(m.out, 2, 0.5)).toBeGreaterThan(-35);
      const check = await checkMixedAudio(m.out, m.plan);
      expect(check.problems).toEqual([]);
      expect(check.checks.join(" ")).toContain("at 2s");
    } finally { rmSync(m.work, { recursive: true, force: true }); }
  }, 60_000);

  it("the same effect with no moment is heard at the start and is quiet by 2s", async () => {
    const m = await mix("a hit");
    try {
      expect(meanDb(m.out, 0, 0.5)).toBeGreaterThan(-35);
      expect(meanDb(m.out, 2, 1.5)).toBeLessThan(-60);
    } finally { rmSync(m.work, { recursive: true, force: true }); }
  }, 60_000);
});