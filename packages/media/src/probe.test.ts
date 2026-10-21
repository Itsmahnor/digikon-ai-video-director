import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeToPcm16k, probeFile } from "./index.js";

let dir: string;
const f = (n: string) => join(dir, n);
const ff = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "ignore" });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "media-test-"));
  ff("-f", "lavfi", "-i", "color=c=blue:s=320x568:d=2:r=30", "-f", "lavfi", "-i", "sine=frequency=440:d=2", "-shortest", "-pix_fmt", "yuv420p", f("clip.mp4"));
  ff("-f", "lavfi", "-i", "color=c=blue:s=320x568:d=1:r=30", "-pix_fmt", "yuv420p", f("silent.mp4"));
  ff("-f", "lavfi", "-i", "sine=frequency=330:d=1.5", f("tone.mp3"));
  ff("-f", "lavfi", "-i", "color=c=red:s=200x200:d=1", "-frames:v", "1", f("pic.png"));
  ff("-f", "lavfi", "-i", "color=c=red:s=32x32:d=1", "-frames:v", "1", f("tiny.png"));
  writeFileSync(f("fake.mp4"), "this is not a video");
  writeFileSync(f("empty.mp4"), "");
  writeFileSync(f("notes.txt"), "hello");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("probeFile", () => {
  it("reads a video with audio", async () => {
    const r = await probeFile(f("clip.mp4"), { assetId: "asset_clip" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.asset).toMatchObject({ asset_id: "asset_clip", media_type: "video", width: 320, height: 568, audio_tracks: 1 });
      expect(r.asset.duration).toBeCloseTo(2, 0);
      expect(r.asset.metadata.fps).toBe(30);
    }
  });
  it("reports a video with no audio track", async () => {
    const r = await probeFile(f("silent.mp4"));
    expect(r.ok && r.asset.audio_tracks).toBe(0);
  });
  it("reads audio and images with the right type", async () => {
    const a = await probeFile(f("tone.mp3"));
    expect(a.ok && a.asset.media_type).toBe("audio");
    expect(a.ok && a.asset.width).toBeNull();
    const i = await probeFile(f("pic.png"));
    expect(i.ok && i.asset.media_type).toBe("image");
    expect(i.ok && i.asset.duration).toBeNull();
  });
  it("rejects unsupported, fake, empty, missing and tiny files with a reason", async () => {
    expect((await probeFile(f("notes.txt")))).toMatchObject({ ok: false, issues: [{ code: "unsupported_type" }] });
    expect((await probeFile(f("fake.mp4")))).toMatchObject({ ok: false, issues: [{ code: "unreadable" }] });
    expect((await probeFile(f("empty.mp4")))).toMatchObject({ ok: false, issues: [{ code: "empty_file" }] });
    expect((await probeFile(f("nope.mp4")))).toMatchObject({ ok: false, issues: [{ code: "missing_file" }] });
    expect((await probeFile(f("tiny.png")))).toMatchObject({ ok: false, issues: [{ code: "bad_dimensions" }] });
  });
  it("uses the original name for the type check when the stored name is opaque", async () => {
    const r = await probeFile(f("clip.mp4"), { originalName: "my reel.txt" });
    expect(r.ok).toBe(false);
  });
  it("is safe against shell metacharacters in the path", async () => {
    const r = await probeFile(`${f("clip.mp4")}; echo pwned`);
    expect(r.ok).toBe(false);
  });
});

describe("decodeToPcm16k", () => {
  it("returns mono 16 kHz samples", async () => {
    const pcm = await decodeToPcm16k(f("clip.mp4"));
    expect(pcm.length).toBeGreaterThan(16000 * 1.8);
    expect(pcm.length).toBeLessThan(16000 * 2.3);
    expect(Math.max(...pcm.slice(0, 16000).map(Math.abs))).toBeGreaterThan(0.1); // the sine wave is audible
  });
});
