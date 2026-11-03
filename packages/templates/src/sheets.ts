import sharp, { type OverlayOptions } from "sharp";

/** A contact sheet: preview frames in a grid with the template id under each, as one PNG. */
export async function contactSheet(items: { id: string; png: Uint8Array; note?: string }[], opts: { cols?: number; tileW?: number; tileH?: number } = {}): Promise<Buffer> {
  const cols = opts.cols ?? 4, tw = opts.tileW ?? 480, th = opts.tileH ?? 270, cap = 34, pad = 10;
  const rows = Math.max(1, Math.ceil(items.length / cols));
  const W = cols * (tw + pad) + pad, H = rows * (th + cap + pad) + pad;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const layers: OverlayOptions[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!, x = pad + (i % cols) * (tw + pad), y = pad + Math.floor(i / cols) * (th + cap + pad);
    const tile = await sharp(it.png).resize(tw, th, { fit: "contain", background: "#222222" }).png().toBuffer();
    layers.push({ input: tile, left: x, top: y });
    const label = esc(it.id.length > 56 ? it.id.slice(0, 55) + "…" : it.id), note = it.note ? esc(it.note) : "";
    layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${cap}"><text x="2" y="14" font-family="sans-serif" font-size="12" fill="#e8e8e8">${label}</text>${note ? `<text x="2" y="29" font-family="sans-serif" font-size="11" fill="#9aa4b2">${note}</text>` : ""}</svg>`), left: x, top: y + th });
  }
  return sharp({ create: { width: W, height: H, channels: 3, background: "#111418" } }).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}
