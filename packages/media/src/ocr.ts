import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import type { ImageVisual } from "@digikon/contracts";

const run = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "windows-ocr.ps1");

export type OcrResult = ImageVisual["ocr"];

/** A local text reader. It returns lines, or throws; it never returns text it did not read. */
export interface OcrEngine { name: string; read(pngPath: string): Promise<string[]> }

export function windowsOcr(): OcrEngine | null {
  if (process.platform !== "win32" || !existsSync(SCRIPT)) return null;
  return {
    name: "windows-media-ocr",
    async read(path) {
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, path], { timeout: 45_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    },
  };
}

export function tesseractOcr(binary = "tesseract"): OcrEngine {
  return {
    name: "tesseract",
    async read(path) {
      const { stdout } = await run(binary, [path, "stdout", "--psm", "11"], { timeout: 45_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    },
  };
}

/** The local readers that exist on this machine, best first. May be empty: the result then says OCR was unavailable, not that there is no text. */
export async function availableOcr(): Promise<OcrEngine[]> {
  const out: OcrEngine[] = [];
  const win = windowsOcr();
  if (win) out.push(win);
  try { await run("tesseract", ["--version"], { timeout: 5000, windowsHide: true }); out.push(tesseractOcr()); } catch { /* not installed */ }
  return out;
}

const same = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Reads a picture twice: as it is on white, and as stretched greyscale, because brand colours such as light green on white are easy to miss. */
export async function readText(source: string | Buffer, engines: readonly OcrEngine[]): Promise<OcrResult> {
  if (!engines.length) return { status: "unavailable", engine: null, text: "", lines: [] };
  const dir = await mkdtemp(join(tmpdir(), "digikon-ocr-"));
  let lastError: unknown = null;
  try {
    const meta = await sharp(source).metadata();
    const long = Math.max(meta.width ?? 1, meta.height ?? 1);
    const size = long < 1200 ? 1600 : Math.min(long, 2600);
    const base = sharp(source).rotate().flatten({ background: "#ffffff" }).resize(size, size, { fit: "inside" });
    const plain = join(dir, "plain.png"), stretched = join(dir, "stretched.png");
    await base.clone().png().toFile(plain);
    await base.clone().greyscale().normalise({ lower: 2, upper: 98 }).linear(1.6, -60).png().toFile(stretched);
    for (const e of engines) {
      try {
        const lines: string[] = [];
        for (const f of [plain, stretched]) for (const l of await e.read(f)) if (!lines.some((x) => same(x) === same(l) || same(x).includes(same(l)))) lines.push(l);
        const kept = lines.filter((l) => same(l).length >= 2).slice(0, 60).map((l) => l.slice(0, 300));
        return { status: kept.length ? "read" : "no_text", engine: e.name, text: kept.join("\n").slice(0, 4000), lines: kept };
      } catch (err) { lastError = err; }
    }
    return { status: "failed", engine: engines[0]!.name, text: "", lines: [] };
  } catch (err) {
    lastError = err;
    return { status: "failed", engine: engines[0]!.name, text: "", lines: [] };
  } finally {
    if (lastError) console.warn(`OCR failed: ${lastError instanceof Error ? lastError.message.slice(0, 200) : String(lastError)}`);
    await rm(dir, { recursive: true, force: true });
  }
}
