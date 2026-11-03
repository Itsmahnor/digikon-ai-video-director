import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LibraryTemplate } from "@digikon/contracts";
import { selectRemotionBrowser } from "@digikon/render";
import { REPO_ROOT } from "./library.js";
import { ClipLookEmbedder, type LookEmbedder } from "./look.js";
import type { Aspect } from "./kit.js";

/**
 * Real preview frames: the template's own scene graph drawn by the Remotion scene-graph composition, in headless Chrome, with the font files the
 * renderer ships. One browser and one bundle are reused for a whole run. Previews and their look vectors are cached by content hash in the temp folder,
 * so a run that changed nothing renders nothing.
 */

const ENTRY = join(REPO_ROOT, "packages", "render", "remotion-scene-graph", "index.jsx");
const FONT_DIR = join(REPO_ROOT, "packages", "render", "fonts");
export const CACHE_DIR = join(tmpdir(), "digikon-template-previews");
/** Cached previews are keyed by the renderer that drew them, so a change to the composition or the compiler can never reuse a stale picture. */
export const RENDER_REV = createHash("sha256").update(readFileSync(join(REPO_ROOT, "packages", "render", "remotion-scene-graph", "SceneGraph.jsx"))).update(readFileSync(join(REPO_ROOT, "packages", "render", "src", "scene-graph", "compile.ts"))).digest("hex").slice(0, 8);

const FACE_FILES = [["EB Garamond", "EBGaramond-400.woff2", 400], ["EB Garamond", "EBGaramond-700.woff2", 700], ["JetBrains Mono", "JetBrainsMono-400.woff2", 400], ["JetBrains Mono", "JetBrainsMono-700.woff2", 700]] as const;
const css = (family: string) => (family === "EB Garamond" ? "'EB Garamond', Georgia, serif" : family === "JetBrains Mono" ? "'JetBrains Mono', monospace" : "sans-serif");

/** The fraction of the scene at which the preview frame is taken: everything is on screen and the hold has begun. */
export const PREVIEW_AT = 0.88;
/** Overlays and backgrounds are empty or static at the end, so their preview is taken mid-motion. */
export const PREVIEW_AT_BY_CATEGORY: Partial<Record<string, number>> = { transitions: 0.5, backgrounds: 0.62, camera_moves: 0.9 };

export interface StillRequest { template: LibraryTemplate; aspect: Aspect; at?: number; scale?: number }

export class PreviewRenderer {
  private serveUrl = "";
  private tmp = "";
  private browser: unknown;
  private rt!: typeof import("@remotion/renderer");
  private chrome = "";

  async open(): Promise<void> {
    const sel = selectRemotionBrowser(undefined);
    if (!sel.path) throw new Error("no compatible browser for previews");
    this.chrome = sel.path;
    this.tmp = mkdtempSync(join(tmpdir(), "tpl-bundle-"));
    const pub = join(this.tmp, "public");
    mkdirSync(pub);
    for (const [, file] of FACE_FILES) copyFileSync(join(FONT_DIR, file), join(pub, file));
    const { bundle } = await import("@remotion/bundler");
    this.rt = await import("@remotion/renderer");
    this.serveUrl = await bundle({ entryPoint: ENTRY, outDir: join(this.tmp, "bundle"), publicDir: pub });
    this.browser = await this.rt.openBrowser("chrome", { browserExecutable: this.chrome, chromeMode: "chrome-for-testing", logLevel: "error", chromiumOptions: { gl: "angle" } });
  }

  async close(): Promise<void> {
    try { await (this.browser as { close(o: unknown): Promise<unknown> } | undefined)?.close({ silent: true }); } catch { /* already gone */ }
    if (this.tmp) rmSync(this.tmp, { recursive: true, force: true });
  }

  inputProps(t: LibraryTemplate, aspect: Aspect) {
    const p = t.type_rules.pairing;
    return {
      graph: t.scene_graph[aspect],
      palette: { background: t.palette_rules.reference_palette.background, surface: t.palette_rules.reference_palette.surface, text: t.palette_rules.reference_palette.text, muted: t.palette_rules.reference_palette.muted, accent: t.palette_rules.reference_palette.accent, accent_2: t.palette_rules.reference_palette.accent_2 },
      font_family: "sans-serif",
      fonts: { display: css(p.display), body: css(p.body), mono: css(p.mono) },
      font_faces: FACE_FILES.map(([name, file, weight]) => ({ name, file, weight })),
    };
  }

  async still(req: StillRequest): Promise<Uint8Array> {
    const { template: t, aspect } = req;
    const g = t.scene_graph[aspect]!;
    const at = req.at ?? PREVIEW_AT_BY_CATEGORY[t.category] ?? PREVIEW_AT, scale = req.scale ?? 0.5;
    const key = join(CACHE_DIR, `${RENDER_REV}-${t.content_hash}-${aspect.replace(":", "x")}-${Math.round(at * 100)}-${Math.round(scale * 100)}.png`);
    if (existsSync(key)) return readFileSync(key);
    mkdirSync(CACHE_DIR, { recursive: true });
    const inputProps = this.inputProps(t, aspect);
    const common = { browserExecutable: this.chrome, chromeMode: "chrome-for-testing" as const, logLevel: "error" as const, puppeteerInstance: this.browser as never };
    const composition = await this.rt.selectComposition({ serveUrl: this.serveUrl, id: "SceneGraph", inputProps, ...common });
    const frame = Math.min(composition.durationInFrames - 1, Math.round(g.duration_s * g.canvas.fps * at));
    await this.rt.renderStill({ composition, serveUrl: this.serveUrl, frame, output: key, inputProps, scale, ...common });
    return readFileSync(key);
  }
}

/** Look vector of a template: CLIP on its 16:9 preview frame. Cached by content hash. */
export async function lookVector(r: PreviewRenderer, e: LookEmbedder, t: LibraryTemplate): Promise<number[]> {
  const cache = join(CACHE_DIR, `${RENDER_REV}-${t.content_hash}-look-${e.model.replace(/\W/g, "_")}-${e.version}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as number[];
  const aspect: Aspect = t.needs.aspect_ratios.includes("16:9") ? "16:9" : (t.needs.aspect_ratios[0] as Aspect);
  const v = await e.embedImage(await r.still({ template: t, aspect, scale: 0.5 }));
  mkdirSync(CACHE_DIR, { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(cache, JSON.stringify(v));
  return v;
}

export { ClipLookEmbedder };
