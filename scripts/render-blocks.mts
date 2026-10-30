// Renders every visual block (or the ones named) at the given sizes and extracts frames, for looking at real output while iterating.
// Usage: npx tsx scripts/render-blocks.mts <outDir> [WxH,WxH] [block,block]
import { mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRemotionAdapter, planCompositionScenes, verifyCompositionScenes, COMPOSITION_TEMPLATE } from "@digikon/render";
import { EXAMPLE_ART_DIRECTION, EXAMPLE_VISUALS } from "../packages/render/src/composition-examples.ts";

const [outDir = "docs/quality/blocks", sizes = "1280x720,720x1280", only] = process.argv.slice(2);
const font = "C:\\Windows\\Fonts\\arial.ttf";
mkdirSync(outDir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "blocks-"));
const outputRoot = join(tmp, "out"); mkdirSync(outputRoot);
const adapter = createRemotionAdapter({ fontFile: font, outputRoot, workRoot: tmp, keepOnContentFailure: true });
for (const size of sizes.split(",")) {
  const [w, h] = size.split("x").map(Number) as [number, number];
  for (const [block, ex] of Object.entries(EXAMPLE_VISUALS)) {
    if (only && !only.split(",").includes(block)) continue;
    const dur = 6, fps = 30;
    const id = `rn_${Math.random().toString(16).slice(2).padEnd(16, "0").slice(0, 16)}`;
    const job = {
      render_id: id, settings: { aspect_ratio: w > h ? "16:9" : "9:16", width: w, height: h, fps, duration_s: dur, container: "mp4", video_codec: "h264", audio_codec: null, source: { type: "user_approved", reference: "test" } } as never,
      operations: [{ operation_id: "E01", target_scene_id: "S01", operation_type: "render_graphics_scene", parameters: {}, timing: { start_s: 0, duration_s: dur }, asset_ids: [], audio_cues: [], caption: null } as never],
      templates: { E01: COMPOSITION_TEMPLATE }, assets: [], clips: [], asset_info: {}, concept_asset_ids: [],
      scene_visuals: { S01: { visual: ex.visual, overlay_text: ex.overlay_text, visual_purpose: block } }, art_direction: EXAMPLE_ART_DIRECTION,
      output_path: join(outputRoot, `${id}.mp4`),
    };
    const plan = planCompositionScenes(job, { outputRoot });
    if (!plan.ok) { console.log(`${block} ${size}: PLAN REFUSED: ${plan.issues.join("; ")}`); continue; }
    try {
      await adapter.render({ ...job, signal: new AbortController().signal });
      const name = `${block}_${size}`;
      const v = join(outDir, `${name}.mp4`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", job.output_path, "-c", "copy", v]);
      for (const t of [0.4, 1.2, 2.4, 5.5]) execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", v, "-frames:v", "1", join(outDir, `${name}_t${t}.png`)]);
      console.log(`${block} ${size}: rendered`);
    } catch (e) { console.log(`${block} ${size}: FAILED ${(e as Error).message.slice(0, 400)}`); }
  }
}
void existsSync; void verifyCompositionScenes;

