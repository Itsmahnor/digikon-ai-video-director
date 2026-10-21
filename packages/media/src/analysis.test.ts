import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Asset } from "@digikon/contracts";
import {
  analyseMedia, buildAssetNotes, parseBlack, parseFreeze, parseLoudness, parseShots, parseSilence, pickFrameTimes, probeFile, subtractSpans,
} from "./index.js";

describe("parsers", () => {
  it("pairs silence start and end, and closes an open silence at the end of the file", () => {
    const log = "[silencedetect @ 0x1] silence_start: 3.01\n[silencedetect @ 0x1] silence_end: 5.0 | silence_duration: 1.99\n[silencedetect @ 0x1] silence_start: 9.5";
    expect(parseSilence(log, 12)).toEqual([{ start: 3.01, end: 5.0 }, { start: 9.5, end: 12 }]);
    expect(parseSilence("nothing here", 5)).toEqual([]);
  });
  it("reads black and freeze spans", () => {
    expect(parseBlack("[blackdetect @ 0x1] black_start:2.5 black_end:4 black_duration:1.5")).toEqual([{ start: 2.5, end: 4 }]);
    const f = "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 6.5\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 2\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 8.5";
    expect(parseFreeze(f, 9)).toEqual([{ start: 6.5, end: 8.5 }]);
    expect(parseFreeze("freeze_start: 7", 9)).toEqual([{ start: 7, end: 9 }]); // ends on a still frame
  });
  it("reads cuts, de-duplicated and ignoring the very first frame", () => {
    expect(parseShots("pts_time:0.0 x\npts_time:2.5 y\npts_time:2.5 y\npts_time:4.01 z")).toEqual([2.5, 4.01]);
  });
  it("reads the loudness summary, not the running values", () => {
    const log = "[Parsed_ebur128] t: 1 M: -20 S: -21 I: -22.0 LUFS\n  I:         -16.9 LUFS\n  Peak:       -1.2 dBFS\n";
    expect(parseLoudness(log)).toEqual({ integrated_lufs: -16.9, true_peak_db: -1.2 });
    expect(parseLoudness("  I:         -inf LUFS\n").integrated_lufs).toBeNull();
  });
  it("subtracts spans and drops slivers", () => {
    expect(subtractSpans(10, [{ start: 2, end: 4 }, { start: 8, end: 10 }])).toEqual([{ start: 0, end: 2 }, { start: 4, end: 8 }]);
    expect(subtractSpans(10, [{ start: 0.2, end: 9.8 }])).toEqual([]); // 0.2s pieces are too short to use
    expect(subtractSpans(5, [])).toEqual([{ start: 0, end: 5 }]);
  });
  it("picks frame times inside usable spans, near cuts first", () => {
    const t = pickFrameTimes([{ start: 0, end: 2.5 }, { start: 4, end: 6.5 }], [2.5, 4], 4);
    expect(t.length).toBeLessThanOrEqual(4);
    expect(t.every((x) => (x >= 0 && x < 2.5) || (x >= 4 && x < 6.5))).toBe(true);
    expect(t).toContain(4.3); // just after the cut that starts the second usable span
    expect(pickFrameTimes([], [], 4)).toEqual([]);
  });
});

describe("analyseMedia on real footage with known defects", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "analysis-test-"));
    const sine = (d: number) => ["-f", "lavfi", "-t", String(d), "-i", `sine=frequency=440:sample_rate=44100`];
    // picture: moving 0-2.5s, black 2.5-4s, moving 4-6.5s, frozen red 6.5-8.5s. sound: tone 0-3s, silence 3-5s, tone 5-8.5s.
    execFileSync("ffmpeg", ["-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=2.5", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=25:d=1.5",
      "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=2.5", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=25:d=2",
      ...sine(3), "-f", "lavfi", "-t", "2", "-i", "anullsrc=r=44100:cl=mono", ...sine(3.5),
      "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v];[4:a][5:a][6:a]concat=n=3:v=0:a=1[a]",
      "-map", "[v]", "-map", "[a]", "-pix_fmt", "yuv420p", "-t", "8.5", join(dir, "defects.mp4")]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the black, frozen and silent stretches, the cuts and the loudness", async () => {
    const probed = await probeFile(join(dir, "defects.mp4"), { assetId: "asset_def" });
    expect(probed.ok).toBe(true);
    if (!probed.ok) return;
    const a = await analyseMedia(join(dir, "defects.mp4"), { hasVideo: true, hasAudio: true, duration_s: probed.asset.duration!, framesDir: join(dir, "frames"), framePrefix: "def" });

    const near = (spans: { start: number; end: number }[], s: number, e: number, tol = 0.4) => spans.some((x) => Math.abs(x.start - s) < tol && Math.abs(x.end - e) < tol);
    expect(near(a.black, 2.5, 4.0)).toBe(true);
    expect(near(a.freeze, 6.5, 8.5)).toBe(true);
    expect(near(a.silence, 3.0, 5.0)).toBe(true);
    for (const cut of [2.5, 4.0, 6.5]) expect(a.shots.some((t) => Math.abs(t - cut) < 0.25), `cut near ${cut} in ${a.shots}`).toBe(true);
    expect(a.loudness!.integrated_lufs).toBeLessThan(0);
    expect(a.loudness!.integrated_lufs).toBeGreaterThan(-60);
    expect(a.warnings).toEqual([]);

    expect(a.keyframes.length).toBeGreaterThan(1);
    for (const k of a.keyframes) {
      expect(existsSync(k.path)).toBe(true);
      expect(k.t < 2.5 || (k.t >= 4 && k.t < 6.5), `frame at ${k.t}s should be in a usable stretch`).toBe(true);
    }

    const notes = buildAssetNotes(probed.asset, a, { language: "en", text: "hello", word_count: 1 });
    expect(notes.usable_segments.length).toBe(2);
    expect(notes.usable_segments[0]!.start).toBeCloseTo(0, 0);
    expect(notes.usable_segments[0]!.end).toBeLessThan(2.9);
    expect(notes.usable_segments[1]!.start).toBeGreaterThan(3.6);
    expect(notes.usable_segments[1]!.end).toBeLessThan(6.9);
    expect(notes.quality_flags.map((f) => f.flag)).toEqual(expect.arrayContaining(["black_frames", "frozen", "silence"]));
    expect(notes.transcript_ref).toBe("transcript:asset_def");
    expect(notes.content_summary).toBe(""); // never invented without a vision pass
    expect(notes.uncertain[0]).toContain("vision pass");
    expect(notes.keyframe_refs.length).toBe(a.keyframes.length);
  }, 120_000);

  it("degrades to honest metadata-only notes when nothing could be measured", () => {
    const asset = Asset.parse({ asset_id: "asset_x", uri: "x.mp4", media_type: "video", duration: 10, width: 640, height: 360, audio_tracks: 0 });
    const notes = buildAssetNotes(asset, null);
    expect(notes.usable_segments).toEqual([{ start: 0, end: 10 }]);
    expect(notes.quality_flags.map((f) => f.flag)).toEqual(["low_resolution"]);
    expect(notes.uncertain.join(" ")).toContain("Measurements were not available");
  });

  it("gives images no time segments", () => {
    const img = Asset.parse({ asset_id: "asset_i", uri: "i.png", media_type: "image", duration: null, width: 800, height: 800 });
    expect(buildAssetNotes(img, null).usable_segments).toEqual([]);
  });
});
