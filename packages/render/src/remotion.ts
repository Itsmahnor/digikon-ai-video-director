import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RenderAdapter } from "./adapter.js";
import { inspectBrowser, selectRemotionBrowser, selectRemotionBrowserFrom } from "./browser.js";
import { verifySceneFidelity } from "./verify.js";
import { composedCapabilities, planComposedScenes, type ComposedTemplate } from "./web-composed.js";
import { verifyComposedScenes } from "./web-composed-verify.js";
import { CONCEPT_BADGE, planWebScenes, type WebTemplate } from "./web-scenes.js";
import { COMPOSITION_TEMPLATE, planCompositionScenes } from "./composition.js";
import { loadFontMeter } from "./font-metrics.js";
import { verifyCompositionScenes } from "./composition-verify.js";

/** Every template this adapter implements. A reference that is not here is refused, whatever the recipe says. */
export const REMOTION_TEMPLATES: Readonly<Record<string, WebTemplate>> = {
  "remotion/text-slide": { kind: "text", type: "render_graphics_scene" },
  "remotion/image-caption": { kind: "image", type: "render_graphics_scene" },
};
/** The drawn-composition template: it is planned by composition.ts, not by the plain-scene planner. */
const COMPOSITION_TYPES = { [COMPOSITION_TEMPLATE]: ["render_graphics_scene"] as const };

/** What this adapter can show beyond plain graphics, in the form the coverage check takes. No transitions, clips or audio are built. */
export const REMOTION_CAPABILITIES = { image_templates: ["remotion/image-caption"], video_templates: [], transition_templates: {}, drawn_templates: [COMPOSITION_TEMPLATE] } as const;

/**
 * What this adapter can show, including the learned templates it was given: camera moves (by the storyboard motion they carry out), the
 * templates that show their own image, and the templates that start text at the approved delay.
 */
export function remotionCapabilities(learned: readonly ComposedTemplate[] = []) {
  return { image_templates: REMOTION_CAPABILITIES.image_templates, video_templates: REMOTION_CAPABILITIES.video_templates, transition_templates: REMOTION_CAPABILITIES.transition_templates, drawn_templates: REMOTION_CAPABILITIES.drawn_templates, ...composedCapabilities(learned) };
}

export interface RemotionAdapterOptions {
  /** A TrueType/OpenType font file. Required: text is never drawn with a font the adapter has not been given. */
  fontFile: string;
  /** The folder render outputs must be inside. Same value as `RenderDeps.outputRoot`. */
  outputRoot: string;
  /** A Chromium-based browser that is already installed. Defaults to Edge, then Chrome (see findRemotionBrowser); nothing is downloaded. */
  chromePath?: string | null;
  /** Browsers to consider, in order, instead of the default search. Each is still inspected and a 32-bit one is still refused. */
  browserCandidates?: readonly string[];
  /**
   * Tests only. Uses `chromePath` as given even when it is a browser known to render Remotion scenes blank (a 32-bit build), so the
   * content check that must still catch such a render can be tested. Never set in the console.
   */
  unsafeAllowIncompatibleBrowser?: boolean;
  /** Diagnostics only. Keeps the rendered file even when its content check fails, so a failure can be inspected frame by frame. Never set in the console. */
  keepOnContentFailure?: boolean;
  workRoot?: string;
  /** Validated learned templates from the capability registry (engine remotion). Each is one reviewed template this adapter may run; none is registered without validation. */
  learned?: readonly ComposedTemplate[];
}

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "remotion-project", "index.jsx");
/** The scene-composition template has its own Remotion project, so the evidence of the plain and composed scenes stays valid. */
export const COMPOSITIONS_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "remotion-compositions", "index.jsx");

/**
 * The Remotion adapter. It bundles the fixed React composition in `remotion-project/` together with the font and the supplied
 * images, then renders it on this machine with `@remotion/renderer` in an already-installed Chrome. The composition receives
 * only validated numbers, fixed colours and the approved text as props. No Lambda, cloud render or licence key is used.
 */
export function createRemotionAdapter(opts: RemotionAdapterOptions): RenderAdapter {
  const ext = extname(opts.fontFile).toLowerCase();
  if (ext !== ".ttf" && ext !== ".otf") throw new Error("fontFile must be a .ttf or .otf file");
  if (!statSync(opts.fontFile, { throwIfNoEntry: false })?.isFile()) throw new Error(`font file not found: ${opts.fontFile}`);
  const choice = opts.unsafeAllowIncompatibleBrowser && opts.chromePath ? { path: opts.chromePath, bits: inspectBrowser(opts.chromePath).bits } : opts.browserCandidates ? selectRemotionBrowserFrom(opts.browserCandidates) : selectRemotionBrowser(opts.chromePath);
  const chrome = choice.path;
  if (!chrome) {
    const seen = "inspected" in choice ? choice.inspected.map((i) => `${i.path}: ${i.reason}`).join("; ") : "";
    throw new Error(`no compatible browser is installed for Remotion (nothing is downloaded)${seen ? `. Looked at: ${seen}` : ""}`);
  }
  for (const l of opts.learned ?? []) if (!l.template.startsWith("remotion/")) throw new Error(`${l.template} is not a Remotion template, so the Remotion adapter will not run it`);
  const meter = loadFontMeter(opts.fontFile);
  const planOpts = { renderer: "remotion" as const, templates: REMOTION_TEMPLATES, outputRoot: opts.outputRoot };
  const composedTemplates = Object.fromEntries((opts.learned ?? []).map((l) => [l.template, l]));
  /** A film that uses any learned template is planned as composed scenes; otherwise as the plain text and image scenes. The two are not mixed in one film yet. */
  const plan = (job: Parameters<RenderAdapter["render"]>[0] | Omit<Parameters<RenderAdapter["render"]>[0], "signal">) => {
    if (job.operations.some((o) => job.templates[o.operation_id] === COMPOSITION_TEMPLATE)) {
      const p = planCompositionScenes(job, { outputRoot: opts.outputRoot, meter });
      return p.ok ? { kind: "composition" as const, plan: p } : { kind: "issues" as const, issues: p.issues };
    }
    const composed = job.operations.some((o) => composedTemplates[job.templates[o.operation_id] ?? ""]);
    if (!composed) { const p = planWebScenes(job, planOpts); return p.ok ? { kind: "base" as const, plan: p } : { kind: "issues" as const, issues: p.issues }; }
    const mixed = job.operations.filter((o) => !composedTemplates[job.templates[o.operation_id] ?? ""]);
    if (mixed.length) return { kind: "issues" as const, issues: mixed.map((o) => `operation ${o.operation_id}: ${job.templates[o.operation_id] ?? "(none)"} is not a composed-scene template, and plain scenes cannot be combined with composed scenes in one film yet`) };
    const p = planComposedScenes(job, { renderer: "remotion", templates: composedTemplates, outputRoot: opts.outputRoot });
    return p.ok ? { kind: "composed" as const, plan: p } : { kind: "issues" as const, issues: p.issues };
  };

  return {
    renderer: "remotion",
    templates: { ...Object.fromEntries(Object.entries(REMOTION_TEMPLATES).map(([ref, t]) => [ref, [t.type]])), ...COMPOSITION_TYPES, ...Object.fromEntries((opts.learned ?? []).map((l) => [l.template, [l.type]])) },
    capabilities: remotionCapabilities(opts.learned),
    check(job) {
      const p = plan(job);
      return p.kind === "issues" ? p.issues : [];
    },
    async render(job) {
      const planned = plan(job);
      if (planned.kind === "issues") throw new Error(`rejected before remotion ran: ${planned.issues.join("; ")}`);
      const plan2 = planned.plan;
      const { width, height, fps } = job.settings;
      const notes: string[] = [];
      const dir = await mkdtemp(join(opts.workRoot ?? tmpdir(), "remotion-render-"));
      try {
        const publicDir = join(dir, "public");
        await mkdir(publicDir);
        await copyFile(opts.fontFile, join(publicDir, "font.ttf"));
        const scenes = await Promise.all((plan2.scenes as { image: null | { ext: string; uri: string }; logo?: null | { ext: string; uri: string } }[]).map(async (sc, i) => {
          let out: Record<string, unknown> = sc;
          if (sc.image) { const file = `img${i}${sc.image.ext}`; await copyFile(sc.image.uri, join(publicDir, file)); out = { ...out, image: { ...sc.image, uri: undefined, file } }; }
          if (sc.logo) { const file = `logo${i}${sc.logo.ext}`; await copyFile(sc.logo.uri, join(publicDir, file)); out = { ...out, logo: { ...sc.logo, uri: undefined, file } }; }
          return out;
        }));
        const { bundle } = await import("@remotion/bundler");
        const { renderMedia, selectComposition, makeCancelSignal } = await import("@remotion/renderer");
        const serveUrl = await bundle({ entryPoint: planned.kind === "composition" ? COMPOSITIONS_ENTRY : ENTRY, outDir: join(dir, "bundle"), publicDir });
        const inputProps = { width, height, fps, total_frames: plan2.total_frames, font: "font.ttf", badge: CONCEPT_BADGE, scenes };
        const compId = planned.kind === "composition" ? "Compositions" : "Scenes";
        // "chrome-for-testing" is Remotion's mode for a full browser (headless=new); its default mode targets chrome-headless-shell, which is not installed
        const common = { browserExecutable: chrome, chromeMode: "chrome-for-testing" as const, logLevel: "error" as const, chromiumOptions: { gl: "angle" as const } };
        const composition = await selectComposition({ serveUrl, id: compId, inputProps, ...common });
        if (composition.width !== width || composition.height !== height || composition.fps !== fps || composition.durationInFrames !== plan2.total_frames) {
          throw new Error(`remotion measured the composition as ${composition.width}x${composition.height} at ${composition.fps} fps for ${composition.durationInFrames} frames, not what was approved`);
        }
        const { cancelSignal, cancel } = makeCancelSignal();
        const onAbort = () => cancel();
        job.signal.addEventListener("abort", onAbort, { once: true });
        try {
          await renderMedia({ composition, serveUrl, inputProps, codec: "h264", pixelFormat: "yuv420p", muted: true, outputLocation: resolve(job.output_path), overwrite: false, concurrency: 1, cancelSignal, ...common });
        } finally {
          job.signal.removeEventListener("abort", onAbort);
        }
        const checked = planned.kind === "composition"
          ? await verifyCompositionScenes(resolve(job.output_path), planned.plan.scenes, width, height, { fontFile: opts.fontFile, workRoot: opts.workRoot })
          : planned.kind === "composed"
          ? await verifyComposedScenes(resolve(job.output_path), planned.plan.scenes, width, height, { fontFile: opts.fontFile, workRoot: opts.workRoot })
          : await verifySceneFidelity(resolve(job.output_path), planned.plan.scenes, width, height, { fontFile: opts.fontFile, workRoot: opts.workRoot });
        if (checked.problems.length) {
          if (opts.keepOnContentFailure) { notes.push(`kept ${resolve(job.output_path)} for inspection`); throw Object.assign(new Error(`the output is missing approved content: ${checked.problems.join("; ")}`), { keep: true }); }
          throw new Error(`the output is missing approved content: ${checked.problems.join("; ")}`);
        }
        notes.push(`remotion rendered in ${basename(chrome)} (${choice.bits})`, ...checked.limitations);
      } catch (e) {
        if (!(opts.keepOnContentFailure && (e as { keep?: boolean }).keep)) await rm(job.output_path, { force: true });
        if (job.signal.aborted) throw new Error("remotion was stopped");
        throw new Error(`remotion failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return { notes };
    },
  };
}

