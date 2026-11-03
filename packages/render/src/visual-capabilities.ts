import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DRAWN_BLOCKS, type EditorOperation, type DrawnBlock } from "@digikon/contracts";
import { createRemotionAdapter } from "./remotion.js";
import { COMPOSITION_TEMPLATE, planCompositionScenes } from "./composition.js";
import { EXAMPLE_ART_DIRECTION, EXAMPLE_VISUALS } from "./composition-examples.js";
import { verifyCompositionScenes } from "./composition-verify.js";
import { execFileSync } from "node:child_process";
import { browserVersion, selectRemotionBrowser } from "./browser.js";
import type { RenderJob } from "./adapter.js";

/**
 * Evidence for the scene-composition blocks, kept in capabilities/visual/<block>.json.
 *
 * A record says: this version of this block was rendered for real, with these inputs, at these sizes, by this code, and passed these checks;
 * and it says what has NOT been tried. It is bound to a fingerprint of the code that draws it: when that code changes, the record is stale
 * and the block must be validated again. One record is evidence about its test inputs, not about every input: each film's own scenes are
 * still checked frame by frame when they are rendered.
 */

export const VISUAL_CAPABILITY_VERSION = "1.0.0";
const here = dirname(fileURLToPath(import.meta.url));
const pkgVersion = (name: string): string => { try { return (createRequire(import.meta.url)(`${name}/package.json`) as { version: string }).version; } catch { return "unknown"; } };

/** A fingerprint of everything that decides how a composition looks and is checked. */
export function compositionFingerprint(): string {
  try {
    const h = createHash("sha256");
    for (const f of ["composition.ts", "composition-verify.ts", "text.ts", "layout.ts", "font-metrics.ts"]) h.update(f).update(readFileSync(join(here, f)));
    h.update("visual.ts").update(readFileSync(join(here, "..", "..", "contracts", "src", "visual.ts")));
    const d = join(here, "..", "remotion-compositions");
    for (const f of readdirSync(d).filter((x) => /\.(jsx?|json)$/.test(x)).sort()) h.update(f).update(readFileSync(join(d, f)));
    return h.digest("hex").slice(0, 16);
  } catch { return "unknown"; }
}

/** The rendered file as ffprobe and a hash see it. */
async function probeRender(path: string): Promise<{ width: number; height: number; duration_s: number; bytes: number; sha256: string }> {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path], { encoding: "utf8" })) as { streams: { width: number; height: number }[]; format: { duration: string } };
  const b = readFileSync(path);
  return { width: j.streams[0]!.width, height: j.streams[0]!.height, duration_s: Number(j.format.duration), bytes: b.length, sha256: createHash("sha256").update(b).digest("hex") };
}

/** The 16-hex seal of records written before the canonical seal existed. Still accepted when a record is read; never written. */
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
/** Key order must not change a seal: objects are written with their keys sorted. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
export const canonicalSeal = (v: unknown): string => createHash("sha256").update(canonical(v)).digest("hex");
/** True when `hash` seals `body`: a full 64-hex canonical seal, or (during migration) a legacy 16-hex one. */
export function verifySeal(body: unknown, hash: string): boolean {
  if (/^[0-9a-f]{64}$/.test(hash)) return canonicalSeal(body) === hash;
  if (/^[0-9a-f]{16}$/.test(hash)) return sha(body) === hash;
  return false;
}
const ffmpegVersion = (): string => { try { return execFileSync("ffmpeg", ["-version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 }).split(/\r?\n/)[0]!.trim() || "unknown"; } catch { return "unknown"; } }
/** What the evidence depends on, read from this machine. */
type ToolVersions = { remotion: string; remotion_renderer: string; ffmpeg: string; chrome: string };
let versionsCache: ToolVersions | undefined;
/** Read once per process: the tools do not change under a running console. */
export const visualToolVersions = (): ToolVersions => (versionsCache ??= { remotion: pkgVersion("remotion"), remotion_renderer: pkgVersion("@remotion/renderer"), ffmpeg: ffmpegVersion(), chrome: browserVersion(selectRemotionBrowser().path) });

const Validation = z.object({
  at: z.string().datetime(),
  fingerprint: z.string(),
  remotion: z.string(),
  browser: z.string(),
  /** Tool versions at validation. Absent in records written before they were recorded. */
  remotion_renderer: z.string().optional(),
  ffmpeg: z.string().optional(),
  chrome: z.string().optional(),
  /** What was rendered: the example spec and text, the art direction, and the frame size. */
  inputs: z.array(z.object({ width: z.number().int(), height: z.number().int(), fps: z.number(), duration_s: z.number(), spec_hash: z.string(), art_direction_hash: z.string(), overlay_text: z.string().nullable() })).min(1),
  renders: z.array(z.object({ width: z.number().int(), height: z.number().int(), sha256: z.string(), bytes: z.number().int(), frames: z.number().int(), film_scene: z.string() })),
  checks: z.array(z.string()).min(1),
  measures: z.array(z.object({ width: z.number().int(), coverage: z.number(), motion: z.number(), edge_ink: z.number() })),
});
export const VisualCapabilityRecord = z.object({
  format: z.literal("digikon.visual-capability"),
  format_version: z.literal(1),
  capability_id: z.string().regex(/^remotion:scene-composition:[a-z_]+$/),
  capability_version: z.string(),
  engine: z.literal("remotion"),
  template: z.literal(COMPOSITION_TEMPLATE),
  block: z.enum(DRAWN_BLOCKS as [DrawnBlock, ...DrawnBlock[]]),
  creative_use: z.string(),
  example: z.unknown(),
  limitations: z.array(z.string()),
  /** What no validation covered, stated so one passing render is never read as proof of every input. */
  not_validated: z.array(z.string()),
  status: z.enum(["validated", "validation_failed"]),
  validated: Validation.nullable(),
  /** Earlier validations, kept when the code changed and the block was validated again. */
  history: z.array(Validation).default([]),
  failure: z.string().nullable().default(null),
  record_hash: z.string(),
});
export type VisualCapabilityRecord = z.infer<typeof VisualCapabilityRecord>;

const seal = (r: Omit<VisualCapabilityRecord, "record_hash">): VisualCapabilityRecord => VisualCapabilityRecord.parse({ ...r, record_hash: canonicalSeal(r) });
export const visualDir = (root: string) => join(root, "visual");
const fileOf = (root: string, block: string) => join(visualDir(root), `${block}.json`);

export interface VisualCapabilityState {
  block: DrawnBlock;
  record: VisualCapabilityRecord | null;
  /** Usable only when validated, intact, and validated against the code as it is now. */
  usable: boolean;
  reason: string;
}

/** Why the tools have changed since validation (a different Remotion, Remotion renderer, FFmpeg or Chrome), or null. A version that was not recorded, or cannot be read now, is not compared. */
export function toolDrift(v: Pick<z.infer<typeof Validation>, "remotion" | "remotion_renderer" | "ffmpeg" | "chrome">, now: { remotion: string; remotion_renderer: string; ffmpeg: string; chrome: string }): string | null {
  const changed: string[] = [];
  const cmp = (name: string, rec: string | undefined, cur: string) => { if (rec && rec !== "unknown" && cur !== "unknown" && rec !== cur) changed.push(`${name} ${rec} -> ${cur}`); };
  cmp("remotion", v.remotion, now.remotion); cmp("@remotion/renderer", v.remotion_renderer, now.remotion_renderer); cmp("ffmpeg", v.ffmpeg, now.ffmpeg); cmp("chrome", v.chrome, now.chrome);
  return changed.length ? `the tools changed after it was validated (${changed.join("; ")}); validate it again` : null;
}

export function loadVisualCapabilities(root: string | null | undefined): VisualCapabilityState[] {
  const now = compositionFingerprint();
  const tools = visualToolVersions();
  return DRAWN_BLOCKS.map((block): VisualCapabilityState => {
    const f = root ? fileOf(root, block) : null;
    if (!f || !existsSync(f)) return { block, record: null, usable: false, reason: "no validation record exists for this block" };
    try {
      const parsed = VisualCapabilityRecord.parse(JSON.parse(readFileSync(f, "utf8")));
      const { record_hash, ...rest } = parsed;
      if (!verifySeal(rest, record_hash)) return { block, record: parsed, usable: false, reason: "the record was changed after it was written (hash mismatch)" };
      if (parsed.status !== "validated" || !parsed.validated) return { block, record: parsed, usable: false, reason: `the last validation failed: ${parsed.failure ?? "no reason recorded"}` };
      if (parsed.validated.fingerprint !== now) return { block, record: parsed, usable: false, reason: `the drawing code changed after it was validated (evidence is for ${parsed.validated.fingerprint}, the code is now ${now}); validate it again` };
      const drift = toolDrift(parsed.validated, tools);
      if (drift) return { block, record: parsed, usable: false, reason: drift };
      return { block, record: parsed, usable: true, reason: `validated ${parsed.validated.at.slice(0, 10)} on ${parsed.validated.inputs.map((i) => `${i.width}x${i.height}`).join(" and ")}` };
    } catch (e) { return { block, record: null, usable: false, reason: `the record cannot be read: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}` }; }
  });
}

const GENERAL_LIMITS = [
  "Validated on one example spec per block at the listed frame sizes, in one palette. Other text, lengths, palettes and sizes are checked when a film is rendered, not by this record.",
  "Frame checks measure background, coverage, edge contact, headline ink and movement. They do not read text or judge design quality.",
  "No audio, no supplied images or footage inside a block, one typeface file, one block per scene.",
];

export interface ValidateOptions { root: string; fontFile: string; sizes?: readonly (readonly [number, number])[]; workRoot?: string; blocks?: readonly DrawnBlock[] }

/** Renders the example film of every block at each size with the real adapter, and stores the result. A failure is recorded as a failure, never as a pass. */
export async function validateVisualCapabilities(opts: ValidateOptions): Promise<VisualCapabilityState[]> {
  const sizes = opts.sizes ?? [[960, 540], [540, 960]];
  const blocks = opts.blocks ?? DRAWN_BLOCKS;
  const tmp = mkdtempSync(join(opts.workRoot ?? tmpdir(), "visual-cap-"));
  const outputRoot = join(tmp, "out");
  mkdirSync(outputRoot);
  const fp = compositionFingerprint();
  const adapter = createRemotionAdapter({ fontFile: opts.fontFile, outputRoot, workRoot: tmp });
  const per = new Map<DrawnBlock, { inputs: z.infer<typeof Validation>["inputs"]; renders: z.infer<typeof Validation>["renders"]; checks: string[]; measures: z.infer<typeof Validation>["measures"]; failure: string | null }>();
  for (const b of blocks) per.set(b, { inputs: [], renders: [], checks: [], measures: [], failure: null });
  try {
    for (const [w, h] of sizes) {
      const scene_s = 3;
      const id = `rn_${createHash("sha256").update(`${w}x${h}${Date.now()}`).digest("hex").slice(0, 16)}`;
      const op = (i: number): EditorOperation => ({ operation_id: `E${i + 1}`, target_scene_id: `S${String(i + 1).padStart(2, "0")}`, operation_type: "render_graphics_scene", parameters: {}, timing: { start_s: i * scene_s, duration_s: scene_s }, asset_ids: [], audio_cues: [], caption: null } as unknown as EditorOperation);
      const job: Omit<RenderJob, "signal"> = {
        render_id: id, settings: { aspect_ratio: w > h ? "16:9" : "9:16", width: w, height: h, fps: 30, duration_s: blocks.length * scene_s, container: "mp4", video_codec: "h264", audio_codec: null, source: { type: "user_approved", reference: "visual capability validation" } } as never,
        operations: blocks.map((_b, i) => op(i)), templates: Object.fromEntries(blocks.map((_b, i) => [`E${i + 1}`, COMPOSITION_TEMPLATE])), assets: [], clips: [], asset_info: {}, concept_asset_ids: [],
        scene_visuals: Object.fromEntries(blocks.map((b, i) => [`S${String(i + 1).padStart(2, "0")}`, { visual: EXAMPLE_VISUALS[b].visual, overlay_text: EXAMPLE_VISUALS[b].overlay_text, visual_purpose: b }])), art_direction: EXAMPLE_ART_DIRECTION,
        output_path: join(outputRoot, `${id}.mp4`),
      };
      let failure: string | null = null;
      let measures: Awaited<ReturnType<typeof verifyCompositionScenes>>["measures"] = [];
      let probe: Awaited<ReturnType<typeof probeRender>> | null = null;
      try {
        await adapter.render({ ...job, signal: new AbortController().signal });
        const plan = planCompositionScenes(job, { outputRoot });
        if (!plan.ok) throw new Error(plan.issues.join("; "));
        const r = await verifyCompositionScenes(job.output_path, plan.scenes, w, h, { fontFile: opts.fontFile });
        if (r.problems.length) throw new Error(r.problems.join("; "));
        measures = r.measures;
        probe = await probeRender(job.output_path);
      } catch (e) { failure = (e instanceof Error ? e.message : String(e)).slice(0, 400); }
      blocks.forEach((b, i) => {
        const s = per.get(b)!;
        const ex = EXAMPLE_VISUALS[b];
        s.inputs.push({ width: w, height: h, fps: 30, duration_s: scene_s, spec_hash: sha(ex.visual), art_direction_hash: sha(EXAMPLE_ART_DIRECTION), overlay_text: ex.overlay_text });
        if (failure || !probe) { s.failure = s.failure ?? `${w}x${h}: ${failure}`; return; }
        s.renders.push({ width: w, height: h, sha256: probe.sha256, bytes: probe.bytes, frames: Math.round(probe.duration_s * 30), film_scene: `S${String(i + 1).padStart(2, "0")} of a ${blocks.length}-scene film` });
        const m = measures.find((x) => x.scene_id === `S${String(i + 1).padStart(2, "0")}`);
        if (m) s.measures.push({ width: w, coverage: Number(m.coverage.toFixed(3)), motion: Number(m.motion.toFixed(2)), edge_ink: Number(m.edge_ink.toFixed(4)) });
        s.checks.push(`${w}x${h}: rendered by remotion in a ${blocks.length}-scene film; background on the approved palette, ${(m?.coverage ?? 0) * 100 > 0 ? `${((m?.coverage ?? 0) * 100).toFixed(0)}% of the frame drawn` : "content drawn"}, nothing on the frame edge, headline area inked, motion ${m?.motion.toFixed(1)} of 255 between frames, file probed as ${probe.width}x${probe.height}`);
      });
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  const browser = "chrome via remotion";
  const tv = visualToolVersions();
  const results: VisualCapabilityState[] = [];
  for (const b of blocks) {
    const s = per.get(b)!;
    const old = existsSync(fileOf(opts.root, b)) ? (() => { try { return VisualCapabilityRecord.parse(JSON.parse(readFileSync(fileOf(opts.root, b), "utf8"))); } catch { return null; } })() : null;
    const ok = !s.failure && s.checks.length === sizes.length;
    const validated = ok ? { at: new Date().toISOString(), fingerprint: fp, ...tv, browser, inputs: s.inputs, renders: s.renders, checks: s.checks, measures: s.measures } : null;
    const history = [...(old?.history ?? []), ...(old?.validated && old.validated.fingerprint !== fp ? [old.validated] : [])].slice(-5);
    const ex = EXAMPLE_VISUALS[b];
    const rec = seal({
      format: "digikon.visual-capability", format_version: 1, capability_id: `remotion:scene-composition:${b}`, capability_version: VISUAL_CAPABILITY_VERSION, engine: "remotion", template: COMPOSITION_TEMPLATE, block: b,
      creative_use: ex.creative_use, example: { visual: ex.visual, overlay_text: ex.overlay_text }, limitations: [...ex.limitations, ...GENERAL_LIMITS],
      not_validated: ["any other text, list length, palette or frame size than the listed inputs", "1:1 frames", "frame rates other than 30", "scenes longer or shorter than 3 s", "a person's judgement of the design"],
      status: ok ? "validated" : "validation_failed", validated, history, failure: ok ? null : (s.failure ?? "incomplete"),
    });
    mkdirSync(visualDir(opts.root), { recursive: true });
    const f = fileOf(opts.root, b), tmpf = `${f}.tmp`;
    writeFileSync(tmpf, `${JSON.stringify(rec, null, 2)}\n`);
    renameSync(tmpf, f);
    results.push(...loadVisualCapabilities(opts.root).filter((x) => x.block === b));
  }
  return results;
}



