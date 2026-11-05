import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { RenderJob } from "./adapter.js";
import { COMPOSITION_TEMPLATE, planCompositionScenes, type CompositionScene } from "./composition.js";
import { rectAt, type AssetLayer } from "./asset-layers.js";
import type { TextMeter } from "./font-metrics.js";
import { FACE_CSS, FACE_RULES, copyFaceFonts } from "./face-fonts.js";

const run = promisify(execFile);

/**
 * Uploaded pictures through FFmpeg and HyperFrames, laid out by the same planner as Remotion, so a picture lands in the same place whichever engine draws it.
 * Each engine draws only the motion it can draw exactly; anything else is refused before it runs, never quietly dropped.
 */
export const FFMPEG_ASSET_TEMPLATE = "ffmpeg/asset-stage", HYPERFRAMES_ASSET_TEMPLATE = "hyperframes/asset-stage";

const FFMPEG_MOTION = new Set(["none", "fade_in", "slide_up"]);
const HYPERFRAMES_MOTION = new Set(["none", "fade_in", "slide_up", "scale_in"]);

type Job = Omit<RenderJob, "signal">;
export type StagePlan = { ok: true; scenes: CompositionScene[]; total_frames: number } | { ok: false; issues: string[] };

export function planStage(job: Job, template: string, opts: { outputRoot: string; meter?: TextMeter }): StagePlan {
  const p = planCompositionScenes(job, { ...opts, template });
  if (!p.ok) return p;
  const issues: string[] = [];
  const allowed = template === FFMPEG_ASSET_TEMPLATE ? FFMPEG_MOTION : HYPERFRAMES_MOTION;
  for (const sc of p.scenes) {
    if (sc.visual.block !== "asset_stage") issues.push(`scene ${sc.scene_id}: ${template} draws uploaded pictures only, not a ${sc.visual.block} scene`);
    for (const r of job.scene_assets?.[sc.scene_id]?.refs ?? []) if (!allowed.has(r.animation)) issues.push(`scene ${sc.scene_id}: ${template} cannot draw the ${r.animation} animation of ${r.asset_id}; only Remotion does`);
  }
  return issues.length ? { ok: false, issues } : p;
}

export const stageLayers = (scenes: readonly CompositionScene[]) => scenes.map((sc) => ({ scene_id: sc.scene_id, layers: sc.asset_layers, occluders: [...(sc.headline_scrim ? [{ box: sc.headline_scrim }] : []), ...(sc.headline ? [{ box: sc.headline.box }] : [])] }));

const ff = (hex: string) => `0x${hex.slice(1)}`;
const n = (v: number) => String(Math.round(v));

/** The filter graph of one scene, from its own inputs onwards. `first` is the index of its first picture input. */
function sceneGraph(sc: CompositionScene, i: number, first: number, fps: number): string {
  const dur = (sc.frames / fps).toFixed(6);
  const boxes: string[] = [];
  for (const l of sc.asset_layers) {
    if (l.plate) boxes.push(`drawbox=x=${n(l.plate.box.x)}:y=${n(l.plate.box.y)}:w=${n(l.plate.box.w)}:h=${n(l.plate.box.h)}:color=${ff(l.plate.colour)}:t=fill`);
    if (l.frame === "browser") boxes.push(`drawbox=x=${n(l.clip.x)}:y=${n(l.clip.y - l.chrome_h)}:w=${n(l.clip.w)}:h=${n(l.chrome_h)}:color=${ff(sc.palette.surface)}:t=fill`);
  }
  const chains = [`color=c=${ff(sc.palette.background)}:s=${sc.width}x${sc.height}:r=${fps}:d=${dur},format=yuv420p${boxes.length ? `,${boxes.join(",")}` : ""}[s${i}b0]`];
  let prev = `s${i}b0`;
  sc.asset_layers.forEach((l, k) => {
    const end = rectAt(l, l.move_frames), rw = Math.round(end.w), rh = Math.round(end.h);
    const cx = Math.max(0, Math.round(l.clip.x - end.x)), cy = Math.max(0, Math.round(l.clip.y - end.y));
    const crop = rw > Math.ceil(l.clip.w) || rh > Math.ceil(l.clip.h) ? `,crop=${Math.round(l.clip.w)}:${Math.round(l.clip.h)}:${cx}:${cy}` : "";
    const fade = l.fade_frames > 0 ? `,fade=t=in:st=0:d=${(l.fade_frames / fps).toFixed(4)}:alpha=1` : "";
    chains.push(`[${first + k}:v]scale=${rw}:${rh}:flags=lanczos,format=rgba${crop}${fade}[s${i}p${k}]`);
    const x = crop ? Math.round(l.clip.x) : Math.round(end.x), y = crop ? Math.round(l.clip.y) : Math.round(end.y);
    const moveS = (l.move_frames / fps).toFixed(4);
    const yExpr = l.move_frames > 0 && l.from.y !== l.to.y ? `'${y}+${Math.round(l.from.y - l.to.y)}*pow(1-min(1,t/${moveS}),3)'` : String(y);
    chains.push(`[${prev}][s${i}p${k}]overlay=x=${x}:y=${yExpr}:eof_action=pass:format=auto[s${i}b${k + 1}]`);
    prev = `s${i}b${k + 1}`;
  });
  const h = sc.headline;
  const texts = h ? h.lines.map((_, j) => `drawtext=fontfile=font-${sc.type.face}.ttf:textfile=s${i}t${j}.txt:expansion=none:fontcolor=${ff(sc.palette.text)}:fontsize=${h.font_px}:x=${n(h.box.x)}:y=${n(h.box.y + j * h.font_px * 1.15)}`) : [];
  const scrim = sc.headline_scrim ? [`drawbox=x=${n(sc.headline_scrim.x)}:y=${n(sc.headline_scrim.y)}:w=${n(sc.headline_scrim.w)}:h=${n(sc.headline_scrim.h)}:color=${ff(sc.palette.background)}@0.84:t=fill`] : [];
  chains.push(`[${prev}]${[...scrim, ...texts, `fps=${fps}`, "format=yuv420p"].join(",")}[s${i}]`);
  return chains.join(";");
}

/** Renders a job's pictures with FFmpeg overlays. Transparent pixels stay transparent: the overlay blends on the file's own alpha channel. */
export async function renderFfmpegStage(job: RenderJob, scenes: readonly CompositionScene[], totalFrames: number, opts: { fontFile: string; ffmpegPath?: string; workRoot?: string }): Promise<void> {
  const { fps } = job.settings;
  const dir = await mkdtemp(join(opts.workRoot ?? tmpdir(), "asset-stage-"));
  try {
    await copyFile(opts.fontFile, join(dir, "font.ttf"));
    await copyFaceFonts(dir, opts.fontFile);
    const inputs: string[] = [], graphs: string[] = [];
    let index = 0;
    for (const [i, sc] of scenes.entries()) {
      const first = index;
      for (const [k, l] of sc.asset_layers.entries()) {
        const file = `s${i}a${k}${extname(l.source)}`;
        await copyFile(l.source, join(dir, file));
        inputs.push("-loop", "1", "-framerate", String(fps), "-t", (sc.frames / fps).toFixed(6), "-i", file);
        index++;
      }
      for (const [j, line] of (sc.headline?.lines ?? []).entries()) await writeFile(join(dir, `s${i}t${j}.txt`), line, "utf8");
      graphs.push(sceneGraph(sc, i, first, fps));
    }
    const graph = `${graphs.join(";")};${scenes.map((_, i) => `[s${i}]`).join("")}concat=n=${scenes.length}:v=1:a=0[out]`;
    await run(opts.ffmpegPath ?? "ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-n", ...inputs, "-filter_complex", graph, "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", "1", "-movflags", "+faststart", "-frames:v", String(totalFrames), resolve(job.output_path)], { cwd: dir, signal: job.signal, maxBuffer: 1 << 20, windowsHide: true });
  } catch (e) {
    await rm(job.output_path, { force: true });
    if (job.signal.aborted) throw new Error("ffmpeg was stopped");
    throw new Error(`ffmpeg failed: ${(((e as { stderr?: string }).stderr || (e instanceof Error ? e.message : String(e))).trim()).slice(0, 500)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sec = (frames: number, fps: number) => String(Number((frames / fps).toPrecision(12)));

/** The HyperFrames composition. Numbers and colours come from the validated plan, text is escaped, and each picture is a local file beside the page. */
export function buildStageComposition(scenes: readonly CompositionScene[], width: number, height: number, fps: number, totalFrames: number, fileOf: (scene: number, layer: number, l: AssetLayer) => string): string {
  const css: string[] = [], body: string[] = [];
  scenes.forEach((sc, i) => {
    const parts: string[] = [];
    sc.asset_layers.forEach((l, k) => {
      const id = `s${i}l${k}`, r = rectAt(l, l.move_frames);
      const plate = l.plate ? `<div class="box" style="left:${l.plate.box.x}px;top:${l.plate.box.y}px;width:${l.plate.box.w}px;height:${l.plate.box.h}px;border-radius:${l.plate.radius}px;background:${l.plate.colour}"></div>` : "";
      const chrome = l.frame === "browser" ? `<div class="box" style="left:${l.clip.x}px;top:${l.clip.y - l.chrome_h}px;width:${l.clip.w}px;height:${l.chrome_h}px;background:${sc.palette.surface}"></div>` : "";
      const anim: string[] = [];
      if (l.fade_frames > 0) { css.push(`@keyframes ${id}f{from{opacity:0}to{opacity:1}}`); anim.push(`${id}f ${sec(l.fade_frames, fps)}s linear both`); }
      if (l.move_frames > 0) { css.push(`@keyframes ${id}m{from{left:${l.from.x - l.clip.x}px;top:${l.from.y - l.clip.y}px;width:${l.from.w}px;height:${l.from.h}px}to{left:${r.x - l.clip.x}px;top:${r.y - l.clip.y}px;width:${r.w}px;height:${r.h}px}}`); }
      const move = l.move_frames > 0 ? `animation:${id}m ${sec(l.move_frames, fps)}s cubic-bezier(.33,1,.68,1) both;` : "";
      css.push(`#${id}{left:${l.clip.x}px;top:${l.clip.y}px;width:${l.clip.w}px;height:${l.clip.h}px;overflow:${l.move_frames > 0 ? "visible" : "hidden"};${anim.length ? `animation:${anim.join(",")};` : ""}}#${id} img{position:absolute;left:${r.x - l.clip.x}px;top:${r.y - l.clip.y}px;width:${r.w}px;height:${r.h}px;${move}}`);
      parts.push(`${plate}${chrome}<div id="${id}" class="box"><img src="${esc(fileOf(i, k, l))}" alt=""/></div>`);
    });
    const h = sc.headline, sb = sc.headline_scrim;
    if (sb) parts.push(`<div class="box" style="left:${sb.x}px;top:${sb.y}px;width:${sb.w}px;height:${sb.h}px;background:${sc.palette.background};opacity:.84"></div>`);
    if (h) parts.push(`<div class="box" style="left:${h.box.x}px;top:${h.box.y}px;width:${h.box.w}px;font-size:${h.font_px}px;line-height:1.15;color:${sc.palette.text};font-weight:${sc.type.bold ? 700 : 400}">${h.lines.map(esc).join("<br/>")}</div>`);
    body.push(`<div id="s${i}" class="scene clip face-${sc.type.face}" data-start="${sec(sc.from_frame, fps)}" data-duration="${sec(sc.frames, fps)}" data-track-index="0" style="background:${sc.palette.background}">${parts.join("")}</div>`);
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=${width}, height=${height}"/>
<style>
@font-face{font-family:DigikonStage;src:url(font.ttf)}
${FACE_CSS}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:#000}
.scene{position:absolute;left:0;top:0;width:${width}px;height:${height}px;overflow:hidden;font-family:DigikonStage,sans-serif}
${FACE_RULES}
.box{position:absolute}
${css.join("\n")}
</style></head><body>
<div id="root" data-composition-id="main" data-no-timeline data-start="0" data-duration="${sec(totalFrames, fps)}" data-width="${width}" data-height="${height}" data-fps="${fps}">
${body.join("\n")}
</div></body></html>
`;
}

export const usesStage = (job: Job, template: string): boolean => job.operations.some((o) => job.templates[o.operation_id] === template);
export { COMPOSITION_TEMPLATE };
