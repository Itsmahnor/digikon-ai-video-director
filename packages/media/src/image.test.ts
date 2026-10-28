import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { describeMeasure, measureImage, measurePixels } from "./image.js";
import { buildAssetNotes } from "./analysis.js";

const dir = mkdtempSync(join(tmpdir(), "image-measure-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "ignore" });

describe("measuring what kind of picture it is", () => {
  it("a screen-capture-like picture (flat colours, few of them) is measured as a screen capture or graphic", async () => {
    const p = join(dir, "ui.png");
    ff("-f", "lavfi", "-i", "color=c=white:s=800x450:d=1", "-vf", "drawbox=x=40:y=40:w=300:h=60:color=0x4f46e5:t=fill,drawbox=x=40:y=140:w=720:h=200:color=0xeeeeee:t=fill", "-frames:v", "1", p);
    const m = await measureImage(p, { width: 800, height: 450 });
    expect(m.kind).toBe("screen_capture_or_graphic");
    expect(m.flat_colour_share).toBeGreaterThan(0.9);
    expect(m.distinct_colours).toBeLessThan(10);
  });

  it("a noisy, many-coloured picture is not measured as a screen capture", async () => {
    const p = join(dir, "noise.png");
    ff("-f", "lavfi", "-i", "nullsrc=s=400x225:d=1,geq=random(1)*255:random(2)*255:random(3)*255", "-frames:v", "1", p);
    const m = await measureImage(p, { width: 400, height: 225 });
    expect(m.kind).toBe("photographic");
    expect(m.flat_colour_share).toBeLessThan(0.1);
  });

  it("measuring never says what a picture shows: the summary says so, and nobody is identified", async () => {
    const m = measurePixels(Buffer.alloc(40 * 40 * 3, 200), 40, 40);
    const text = describeMeasure({ ...m, width: 40, height: 40 });
    expect(text).toContain("Measured, not interpreted");
    expect(text).toContain("has not been reviewed");
    expect(text).not.toMatch(/\b(team|people|person|face)\b/i);
  });

  it("asset notes for a measured picture are marked as unreviewed, and are not the old empty summary", async () => {
    const asset = { asset_id: "asset_00000001", media_type: "image", uri: "x.png", duration: null, width: 800, height: 450, audio_tracks: 0, metadata: {}, transcript_ref: null } as never;
    const n = buildAssetNotes(asset, null, null, { kind: "screen_capture_or_graphic", flat_colour_share: 0.8, distinct_colours: 20, skin_tone_share: 0, width: 800, height: 450 });
    expect(n.content_summary).toContain("Measured, not interpreted");
    expect(n.uncertain.join(" ")).toContain("Nobody has reviewed what this picture shows");
    expect(n.visual_review).toBeNull();
    expect(n.image_measure?.kind).toBe("screen_capture_or_graphic");
    expect(buildAssetNotes(asset, null).image_measure).toBeNull(); // a picture that was not measured says nothing
  });
});
