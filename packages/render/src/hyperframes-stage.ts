import { createRequire } from "node:module";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { RenderAdapter } from "./adapter.js";
import type { AssetLayer } from "./asset-layers.js";
import { HYPERFRAMES_ASSET_TEMPLATE, buildStageComposition, planStage, stageLayers, usesStage } from "./asset-stage.js";
import { QUIET_ENV, findChrome, runProcess } from "./browser.js";
import { createHyperframesAdapter, type HyperframesAdapterOptions } from "./hyperframes.js";

/**
 * The HyperFrames adapter with uploaded pictures added. It wraps the adapter instead of changing it, because the validated capability evidence is tied to the
 * exact code of hyperframes.ts: everything that adapter could already do stays validated.
 */
export function createHyperframesStageAdapter(opts: HyperframesAdapterOptions): RenderAdapter {
  const inner = createHyperframesAdapter(opts);
  const chrome = findChrome(opts.chromePath)!;
  const bin = join(dirname(createRequire(import.meta.url).resolve("hyperframes/package.json")), "bin", "hyperframes.mjs");
  const planned = (job: Parameters<NonNullable<RenderAdapter["check"]>>[0]) => planStage(job, HYPERFRAMES_ASSET_TEMPLATE, { outputRoot: opts.outputRoot });
  return {
    ...inner,
    templates: { ...inner.templates, [HYPERFRAMES_ASSET_TEMPLATE]: ["render_graphics_scene"] },
    capabilities: { transition_templates: {}, ...inner.capabilities, drawn_templates: [HYPERFRAMES_ASSET_TEMPLATE], image_templates: [...(inner.capabilities?.image_templates ?? []), HYPERFRAMES_ASSET_TEMPLATE] },
    check(job) {
      if (!usesStage(job, HYPERFRAMES_ASSET_TEMPLATE)) return inner.check?.(job) ?? [];
      const s = planned(job);
      return s.ok ? [] : s.issues;
    },
    assetLayers(job) {
      if (!usesStage(job, HYPERFRAMES_ASSET_TEMPLATE)) return [];
      const s = planned(job);
      return s.ok ? stageLayers(s.scenes) : [];
    },
    async render(job) {
      if (!usesStage(job, HYPERFRAMES_ASSET_TEMPLATE)) return inner.render(job);
      const s = planned(job);
      if (!s.ok) throw new Error(`rejected before hyperframes ran: ${s.issues.join("; ")}`);
      const { width, height, fps } = job.settings;
      const dir = await mkdtemp(join(opts.workRoot ?? tmpdir(), "hyperframes-stage-"));
      try {
        await copyFile(opts.fontFile, join(dir, "font.ttf"));
        const name = (i: number, k: number, l: AssetLayer) => `s${i}a${k}${extname(l.source)}`;
        for (const [i, sc] of s.scenes.entries()) for (const [k, l] of sc.asset_layers.entries()) await copyFile(l.source, join(dir, name(i, k, l)));
        await writeFile(join(dir, "index.html"), buildStageComposition(s.scenes, width, height, fps, s.total_frames, name), "utf8");
        const r = await runProcess(process.execPath, [bin, "render", dir, "--output", resolve(job.output_path), "--format", "mp4", "--fps", String(fps), "--workers", "1", "--strict"], { cwd: dir, env: { ...process.env, ...QUIET_ENV, HYPERFRAMES_BROWSER_PATH: chrome }, signal: job.signal });
        if (r.code !== 0) throw new Error(`hyperframes exited with code ${r.code}: ${r.output.trim().slice(-500)}`);
      } catch (e) {
        await rm(job.output_path, { force: true });
        throw e instanceof Error && /^hyperframes /.test(e.message) ? e : new Error(`hyperframes failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`);
      } finally { await rm(dir, { recursive: true, force: true }); }
      return { notes: [`hyperframes drew the uploaded pictures in ${basename(chrome)}`] };
    },
  };
}
