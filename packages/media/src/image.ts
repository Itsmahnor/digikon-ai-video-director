import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ImageMeasure } from "@digikon/contracts";

const run = promisify(execFile);

/**
 * What can be measured from the pixels of a picture without interpreting it: how much of it is flat colour, how many colours it really
 * uses, and how much is skin-toned. A screen capture or a graphic is mostly flat colour with few colours; a photograph is not. This says what
 * KIND of picture it is. It never says what the picture shows: nobody and nothing is recognised here.
 */
export function measurePixels(rgb: Buffer, width: number, height: number): Omit<ImageMeasure, "width" | "height"> {
  const n = width * height;
  const counts = new Map<number, number>();
  let flat = 0, flatTotal = 0, skin = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3, r = rgb[i]!, g = rgb[i + 1]!, b = rgb[i + 2]!;
      const q = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      counts.set(q, (counts.get(q) ?? 0) + 1);
      if (r > 95 && g > 40 && b > 20 && r > g && r > b && Math.abs(r - g) > 15 && Math.max(r, g, b) - Math.min(r, g, b) > 15) skin++;
      if (x + 1 < width && y + 1 < height) {
        const j = i + 3, k = i + width * 3;
        flatTotal++;
        if (Math.abs(r - rgb[j]!) <= 2 && Math.abs(g - rgb[j + 1]!) <= 2 && Math.abs(b - rgb[j + 2]!) <= 2 && Math.abs(r - rgb[k]!) <= 2 && Math.abs(g - rgb[k + 1]!) <= 2 && Math.abs(b - rgb[k + 2]!) <= 2) flat++;
      }
    }
  }
  const flat_colour_share = flatTotal ? flat / flatTotal : 0;
  const distinct_colours = [...counts.values()].filter((c) => c >= n * 0.001).length;
  const skin_tone_share = skin / n;
  const kind: ImageMeasure["kind"] = flat_colour_share >= 0.55 ? "screen_capture_or_graphic" : flat_colour_share <= 0.25 && distinct_colours >= 40 ? "photographic" : "unclear";
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return { kind, flat_colour_share: r4(flat_colour_share), distinct_colours, skin_tone_share: r4(skin_tone_share) };
}

/** Decodes the picture with the local FFmpeg (never a service) at a fixed width and measures it. */
export async function measureImage(path: string, dims: { width: number; height: number }, ffmpegPath = "ffmpeg"): Promise<ImageMeasure> {
  const w = Math.min(640, dims.width), h = Math.max(1, Math.round((dims.height * w) / dims.width));
  const { stdout } = await run(ffmpegPath, ["-v", "error", "-i", path, "-vf", `scale=${w}:${h}:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: w * h * 3 + 4096, timeout: 30_000, windowsHide: true });
  const buf = stdout as unknown as Buffer;
  if (buf.length < w * h * 3) throw new Error("the picture could not be decoded");
  return { ...measurePixels(buf, w, h), width: dims.width, height: dims.height };
}

/** The line stored as the picture's content summary: what was measured, and plainly what was not. */
export function describeMeasure(m: ImageMeasure): string {
  const kind = m.kind === "screen_capture_or_graphic" ? "It looks like a screen capture or a graphic, not a photograph" : m.kind === "photographic" ? "It looks like a photograph" : "It is neither clearly a screen capture nor clearly a photograph";
  return `Measured, not interpreted: ${kind} (${Math.round(m.flat_colour_share * 100)}% flat colour, ${m.distinct_colours} main colours, ${Math.round(m.skin_tone_share * 100)}% skin-toned pixels). What it shows has not been reviewed.`;
}
