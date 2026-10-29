import { createRequire } from "node:module";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { RenderAdapter } from "./adapter.js";
import { QUIET_ENV, findChrome, runProcess } from "./browser.js";
import { buildComposedComposition } from "./hyperframes-composed.js";
import { verifySceneFidelity } from "./verify.js";
import { composedCapabilities, planComposedScenes, type ComposedTemplate } from "./web-composed.js";
import { verifyComposedScenes } from "./web-composed-verify.js";
import { CONCEPT_BADGE, WEB_FONT_FAMILY, planWebScenes, type WebScene, type WebTemplate } from "./web-scenes.js";

/** Every template this adapter implements. A reference that is not here is refused, whatever the recipe says. */
export const HYPERFRAMES_TEMPLATES: Readonly<Record<string, WebTemplate>> = {
  "hyperframes/text-fade": { kind: "text", type: "render_graphics_scene" },
  "hyperframes/image-caption": { kind: "image", type: "render_graphics_scene" },
};

/** What this adapter can show beyond plain graphics, in the form the coverage check takes. No transitions, clips or audio are built. */
export const HYPERFRAMES_CAPABILITIES = { image_templates: ["hyperframes/image-caption"], video_templates: [], transition_templates: {} } as const;

export interface HyperframesAdapterOptions {
  /** A TrueType/OpenType font file. Required: text is never drawn with a font the adapter has not been given. */
  fontFile: string;
  /** The folder render outputs must be inside. Same value as `RenderDeps.outputRoot`. */
  outputRoot: string;
  /** A Chrome that is already installed. Defaults to the usual install locations; nothing is downloaded. */
  chromePath?: string | null;
  workRoot?: string;
  /** Validated learned templates from the capability registry (engine hyperframes). Each is one reviewed template this adapter may run; none is registered without validation. */
  learned?: readonly ComposedTemplate[];
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const sec = (frames: number, fps: number) => String(Number((frames / fps).toPrecision(12)));

/**
 * The composition, as one HTML file. It is built from validated numbers, fixed colours and the HTML-escaped approved text only.
 * Animations are CSS keyframes: HyperFrames seeks them frame by frame, so the same input gives the same frames.
 */
export function buildComposition(scenes: readonly WebScene[], width: number, height: number, fps: number, totalFrames: number): string {
  const css: string[] = [], body: string[] = [];
  scenes.forEach((sc, i) => {
    const fade = `${sc.fade_in_s}s`, dur = sec(sc.frames, fps);
    const common = `left:${(((1 - sc.text_w) / 2) * 100).toFixed(2)}%;width:${(sc.text_w * 100).toFixed(2)}%;top:${(sc.text_y * 100).toFixed(2)}%;font-size:${sc.font_px}px`;
    if (sc.kind === "text") {
      css.push(`#s${i} .t{${common};transform:translateY(-50%);animation:hf-text ${fade} linear both}#s${i} .bar{left:40%;width:20%;top:80%;height:6px;background:${sc.accent};animation:hf-in ${fade} linear both}`);
      body.push(`<div id="s${i}" class="scene clip" data-start="${sec(sc.from_frame, fps)}" data-duration="${dur}" data-track-index="0" style="background:${sc.background}"><div class="t">${esc(sc.text)}</div><div class="bar"></div></div>`);
      return;
    }
    const im = sc.image!;
    const zoom = im.motion === "slow_zoom" ? `animation:hf-zoom ${dur}s linear both;` : "";
    css.push(`#s${i} .frame{left:${im.box.x}px;top:${im.box.y}px;width:${im.box.w}px;height:${im.box.h}px;animation:hf-in ${fade} linear both}#s${i} .frame img{width:100%;height:100%;object-fit:${im.fit};${zoom}}#s${i} .t{${common};transform:translateY(-50%);animation:hf-in ${fade} linear both}#s${i} .badge{left:${im.box.x + 12}px;top:${im.box.y + 12}px;font-size:${Math.max(10, Math.round(Math.min(height, (width * 9) / 16) / 28))}px}`);
    body.push(`<div id="s${i}" class="scene clip" data-start="${sec(sc.from_frame, fps)}" data-duration="${dur}" data-track-index="0" style="background:${sc.background}"><div class="frame"><img src="img${i}${im.ext}" alt=""/></div><div class="t">${esc(sc.text)}</div>${im.concept ? `<div class="badge">${CONCEPT_BADGE}</div>` : ""}</div>`);
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=${width}, height=${height}"/>
<style>
@font-face{font-family:${WEB_FONT_FAMILY};src:url(font.ttf)}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:#000}
.scene{position:absolute;left:0;top:0;width:${width}px;height:${height}px;overflow:hidden;font-family:${WEB_FONT_FAMILY},sans-serif;color:#fff}
.t{position:absolute;text-align:center;line-height:1.2;overflow-wrap:anywhere;white-space:pre-line}
.bar,.frame,.badge{position:absolute}
.frame{overflow:hidden}
.badge{color:#fff;background:rgba(0,0,0,.65);padding:6px 8px;line-height:1.2}
@keyframes hf-in{from{opacity:0}to{opacity:1}}
@keyframes hf-text{from{opacity:0;transform:translateY(-50%) scale(.96)}to{opacity:1;transform:translateY(-50%) scale(1)}}
@keyframes hf-zoom{from{transform:scale(1)}to{transform:scale(1.12)}}
${css.join("\n")}
</style></head><body>
<div id="root" data-composition-id="main" data-no-timeline data-start="0" data-duration="${sec(totalFrames, fps)}" data-width="${width}" data-height="${height}" data-fps="${fps}">
${body.join("\n")}
</div></body></html>
`;
}

function hyperframesBin(): string {
  const pkg = createRequire(import.meta.url).resolve("hyperframes/package.json");
  return join(dirname(pkg), "bin", "hyperframes.mjs");
}

/**
 * The HyperFrames adapter. It writes a project (one HTML composition plus the font and the supplied images) into a temporary
 * folder and renders it with the installed `hyperframes` command line tool on this machine, using a Chrome that is already
 * installed. No cloud render, telemetry or update check is used. Everything it cannot draw exactly is refused before the tool starts.
 */
export function createHyperframesAdapter(opts: HyperframesAdapterOptions): RenderAdapter {
  const ext = extname(opts.fontFile).toLowerCase();
  if (ext !== ".ttf" && ext !== ".otf") throw new Error("fontFile must be a .ttf or .otf file");
  if (!statSync(opts.fontFile, { throwIfNoEntry: false })?.isFile()) throw new Error(`font file not found: ${opts.fontFile}`);
  const chrome = findChrome(opts.chromePath);
  if (!chrome) throw new Error("no Chrome is installed, and HyperFrames needs one (nothing is downloaded)");
  const bin = hyperframesBin();
  for (const l of opts.learned ?? []) if (!l.template.startsWith("hyperframes/")) throw new Error(`${l.template} is not a HyperFrames template, so the HyperFrames adapter will not run it`);
  const planOpts = { renderer: "hyperframes" as const, templates: HYPERFRAMES_TEMPLATES, outputRoot: opts.outputRoot };
  const composedTemplates = Object.fromEntries((opts.learned ?? []).map((l) => [l.template, l]));
  /** A film that uses any learned template is planned as composed scenes; otherwise as the plain text and image scenes. The two are not mixed in one film yet. */
  const plan = (job: Parameters<RenderAdapter["render"]>[0] | Omit<Parameters<RenderAdapter["render"]>[0], "signal">) => {
    const composed = job.operations.some((o) => composedTemplates[job.templates[o.operation_id] ?? ""]);
    if (!composed) { const p = planWebScenes(job, planOpts); return p.ok ? { kind: "base" as const, plan: p } : { kind: "issues" as const, issues: p.issues }; }
    const mixed = job.operations.filter((o) => !composedTemplates[job.templates[o.operation_id] ?? ""]);
    if (mixed.length) return { kind: "issues" as const, issues: mixed.map((o) => `operation ${o.operation_id}: ${job.templates[o.operation_id] ?? "(none)"} is not a composed-scene template, and plain scenes cannot be combined with composed scenes in one film yet`) };
    const p = planComposedScenes(job, { renderer: "hyperframes", templates: composedTemplates, outputRoot: opts.outputRoot });
    return p.ok ? { kind: "composed" as const, plan: p } : { kind: "issues" as const, issues: p.issues };
  };

  return {
    renderer: "hyperframes",
    templates: { ...Object.fromEntries(Object.entries(HYPERFRAMES_TEMPLATES).map(([ref, t]) => [ref, [t.type]])), ...Object.fromEntries((opts.learned ?? []).map((l) => [l.template, [l.type]])) },
    capabilities: { ...HYPERFRAMES_CAPABILITIES, ...composedCapabilities(opts.learned ?? []) },
    check(job) {
      const p = plan(job);
      return p.kind === "issues" ? p.issues : [];
    },
    async render(job) {
      const planned = plan(job);
      if (planned.kind === "issues") throw new Error(`rejected before hyperframes ran: ${planned.issues.join("; ")}`);
      const plan2 = planned.plan;
      const { width, height, fps } = job.settings;
      const notes: string[] = [];
      const dir = await mkdtemp(join(opts.workRoot ?? tmpdir(), "hyperframes-render-"));
      try {
        await copyFile(opts.fontFile, join(dir, "font.ttf"));
        await Promise.all((plan2.scenes as { image: null | { uri: string; ext: string } }[]).flatMap((sc, i) => (sc.image ? [copyFile(sc.image.uri, join(dir, `img${i}${sc.image.ext}`))] : [])));
        await writeFile(join(dir, "index.html"), planned.kind === "composed" ? buildComposedComposition(planned.plan.scenes, width, height, fps, planned.plan.total_frames) : buildComposition(planned.plan.scenes, width, height, fps, planned.plan.total_frames), "utf8");
        const args = [bin, "render", dir, "--output", resolve(job.output_path), "--format", "mp4", "--fps", String(fps), "--workers", "1", "--strict"];
        const r = await runProcess(process.execPath, args, { cwd: dir, env: { ...process.env, ...QUIET_ENV, HYPERFRAMES_BROWSER_PATH: chrome }, signal: job.signal });
        if (r.code !== 0) throw new Error(`hyperframes exited with code ${r.code}: ${r.output.trim().slice(-500)}`);
        const checked = planned.kind === "composed"
          ? await verifyComposedScenes(resolve(job.output_path), planned.plan.scenes, width, height, { fontFile: opts.fontFile, workRoot: opts.workRoot })
          : await verifySceneFidelity(resolve(job.output_path), planned.plan.scenes, width, height, { fontFile: opts.fontFile, workRoot: opts.workRoot });
        if (checked.problems.length) throw new Error(`hyperframes output is missing approved content: ${checked.problems.join("; ")}`);
        notes.push(`hyperframes rendered in ${basename(chrome)}`, ...checked.limitations);
      } catch (e) {
        await rm(job.output_path, { force: true });
        if (job.signal.aborted) throw new Error("hyperframes was stopped");
        throw e instanceof Error && /^hyperframes /.test(e.message) ? e : new Error(`hyperframes failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return { notes };
    },
  };
}
