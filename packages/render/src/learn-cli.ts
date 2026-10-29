import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_CATALOG, learnCapability, loadCapabilityRegistry, migrateLegacyStore } from "./capabilities.js";
import "./capabilities-remotion.js"; // registers the Remotion families

/**
 * Learns catalog capabilities with real renders and stores the validated ones.
 *   npm run capabilities                      learn everything in the catalog
 *   npm run capabilities -- ffmpeg/xfade-wipe  learn one template
 *   npm run capabilities -- --list             show what is stored and what is not
 * Needs the local FFmpeg and a font file (RENDER_FONT_FILE, or Arial/DejaVu if present). Nothing is downloaded and no service is called.
 */
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const root = join(repoRoot, "capabilities");
const m = migrateLegacyStore(root);
if (m.migrated.length) console.log(`migrated to the registry: ${m.migrated.join(", ")}`);
const args = process.argv.slice(2);

if (args.includes("--list")) {
  const l = loadCapabilityRegistry(root);
  for (const e of CAPABILITY_CATALOG) {
    const r = l.get(e.engine, e.recipe_id);
    const why = l.unusable.find((u) => u.record.template === e.template)?.reason;
    const label = l.usable.some((s) => s.template === e.template) ? "validated  " : why && r?.status === "validated" ? "NOT USABLE " : r ? r.status.padEnd(11) : "not learned ";
    console.log(`${label} ${e.engine}:${e.recipe_id} ${e.template} v${e.version}${r?.attempts.length ? ` (${r.attempts.length} attempt${r.attempts.length === 1 ? "" : "s"})` : ""}${why && r?.status === "validated" ? ` - ${why}` : ""}`);
  }
  for (const p of l.problems) console.log(`ignored: ${p}`);
  process.exit(0);
}
const font = [process.env["RENDER_FONT_FILE"] ?? "", "C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => f && existsSync(f));
if (!font) { console.error("No font file found. Set RENDER_FONT_FILE to a .ttf file."); process.exit(2); }
const wanted = args.filter((a) => !a.startsWith("--")).length ? args.filter((a) => !a.startsWith("--")) : CAPABILITY_CATALOG.map((e) => e.template);
let failed = 0;
for (const template of wanted) {
  const r = await learnCapability(template, { root, fontFile: font, force: args.includes("--force") });
  if (r.status === "learned") console.log(`${r.reused ? "already learned" : "learned"}    ${template}: ${r.record.validated!.checks.length} checks passed, recorded in capabilities/registry/${r.record.engine}`);
  else { failed++; console.log(`unsupported ${template}: ${r.reasons.join(" | ")}`); }
}
process.exit(failed ? 1 : 0);
