// Validates the scene-composition blocks with real renders and stores the evidence in capabilities/visual/.
//   npx tsx scripts/validate-visual-capabilities.mts            validate every block
//   npx tsx scripts/validate-visual-capabilities.mts --list     show what is stored and whether it is still usable
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVisualCapabilities, validateVisualCapabilities } from "@digikon/render";

const root = join(resolve(fileURLToPath(new URL("..", import.meta.url))), "capabilities");
if (process.argv.includes("--list")) {
  for (const s of loadVisualCapabilities(root)) console.log(`${s.usable ? "validated " : "NOT USABLE"} ${s.block.padEnd(16)} ${s.reason}`);
  process.exit(0);
}
const font = [process.env["RENDER_FONT_FILE"] ?? "", "C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => f && existsSync(f));
if (!font) { console.error("No font file found. Set RENDER_FONT_FILE."); process.exit(2); }
const results = await validateVisualCapabilities({ root, fontFile: font });
for (const s of results) console.log(`${s.usable ? "validated " : "FAILED    "} ${s.block.padEnd(16)} ${s.usable ? s.reason : s.record?.failure ?? s.reason}`);
process.exit(results.every((s) => s.usable) ? 0 : 1);