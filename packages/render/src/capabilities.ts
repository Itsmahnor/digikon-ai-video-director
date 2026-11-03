import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { EditorOperation, RenderSettings, type Recipe, type RenderRecord, type Renderer } from "@digikon/contracts";
import type { RenderJob } from "./adapter.js";
import { readNormalized } from "./fingerprint.js";
import { createFfmpegAdapter } from "./ffmpeg.js";
import type { LearnedTransition } from "./learned-types.js";
import { validateOutput } from "./output.js";
import type { ComposedTemplate } from "./web-composed.js";

const run = promisify(execFile);

/**
 * The shared capability registry. One authoritative record per (recipe, engine) says whether that engine can carry out that recipe, with
 * the evidence for it. A recipe whose template has no working implementation is a *gap*. A gap is closed only when a reviewed engine already
 * knows how to carry it out and a real render proves it. "Learning" is validating a declarative catalog entry against the local tools and
 * keeping the evidence. It never generates or runs new code: the contract says an `implementation_ref` is a reviewed template, never
 * model-written code. A capability that cannot be validated is recorded as failed and never trusted; nothing is substituted for it.
 */

export const ENGINES = ["ffmpeg", "remotion", "hyperframes"] as const satisfies readonly Renderer[];
export type Engine = (typeof ENGINES)[number];

/** Bumped when the way a capability is validated changes, so an old failure is retried under the new rules. */
export const LEARNER_VERSION = "8";

/** One engine family entry: which recipe it implements on which engine and how the engine is parameterised. Extending the catalog is a reviewed code change. */
export type CapabilityFamily = "xfade_transition" | "camera_move" | "text_motion" | "end_card" | "logo_reveal";
export interface CatalogEntry {
  engine: Engine;
  template: string;
  family: CapabilityFamily;
  recipe_id: string;
  /** The recipe version this entry was written and validated against. A different recipe version is a different recipe. */
  recipe_version: string;
  /** This capability's own version; bump it when the entry changes. */
  version: string;
  /** The storyboard transition the template carries out ("none" for a family that is not a transition). */
  storyboard_transition: string;
  xfade: string | null;
  direction_map: Record<string, string> | null;
  /** The family's constant: a camera move's motion (zoom_in, zoom_out, pan), a text motion (fade_up, stagger) or "card". */
  motion?: string;
  /** The operation type the recipe becomes. */
  operation_type?: "concat" | "trim_clip" | "overlay_text" | "render_graphics_scene";
}

export const CAPABILITY_CATALOG: readonly CatalogEntry[] = [
  { engine: "ffmpeg", template: "ffmpeg/xfade-fadeblack", family: "xfade_transition", recipe_id: "dip-to-black", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "dip_to_black", xfade: "fadeblack", direction_map: null },
  { engine: "ffmpeg", template: "ffmpeg/xfade-wipe", family: "xfade_transition", recipe_id: "directional-wipe", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "wipe", xfade: null, direction_map: { left: "wipeleft", right: "wiperight", up: "wipeup", down: "wipedown" } },
  // Remotion scene capabilities. Each is a reviewed template in `remotion-project/`; it is registered for use only after the learner has rendered it for real.
  { engine: "remotion", template: "remotion/slow-push-in", family: "camera_move", recipe_id: "slow-push-in", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "zoom_in", operation_type: "trim_clip" },
  { engine: "remotion", template: "remotion/pull-out-reveal", family: "camera_move", recipe_id: "pull-out-reveal", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "zoom_out", operation_type: "trim_clip" },
  { engine: "remotion", template: "remotion/pan-reframe", family: "camera_move", recipe_id: "pan-reframe", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "pan", operation_type: "trim_clip" },
  { engine: "remotion", template: "remotion/text-fade-up", family: "text_motion", recipe_id: "text-fade-up", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "fade_up", operation_type: "overlay_text" },
  { engine: "remotion", template: "remotion/text-word-stagger", family: "text_motion", recipe_id: "text-word-stagger", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "stagger", operation_type: "overlay_text" },
  { engine: "remotion", template: "remotion/end-card-cta", family: "end_card", recipe_id: "end-card-cta", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "card", operation_type: "render_graphics_scene" },
  // Remotion capabilities for the remaining approved recipes that nothing could draw: a punch-in, a crop to a detail, a lower third and a logo reveal (images only; no footage, no audio).
  { engine: "remotion", template: "remotion/punch-in-emphasis", family: "camera_move", recipe_id: "punch-in-emphasis", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "punch", operation_type: "trim_clip" },
  { engine: "remotion", template: "remotion/crop-to-detail", family: "camera_move", recipe_id: "crop-to-detail", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "crop", operation_type: "trim_clip" },
  { engine: "remotion", template: "remotion/lower-third-slide", family: "text_motion", recipe_id: "lower-third-slide", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "lower_third", operation_type: "overlay_text" },
  { engine: "remotion", template: "remotion/logo-reveal", family: "logo_reveal", recipe_id: "logo-reveal", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "reveal", operation_type: "render_graphics_scene" },
  // HyperFrames scene capabilities: separate implementations (HTML and CSS keyframes in hyperframes-composed.ts) of the same approved behaviour. Each belongs to a sibling draft recipe, because the
  // original recipes do not list HyperFrames; each is registered for use only after the learner has rendered it for real and measured the frames.
  { engine: "hyperframes", template: "hyperframes/slow-push-in", family: "camera_move", recipe_id: "slow-push-in-hyperframes", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "zoom_in", operation_type: "trim_clip" },
  { engine: "hyperframes", template: "hyperframes/pull-out-reveal", family: "camera_move", recipe_id: "pull-out-reveal-hyperframes", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "zoom_out", operation_type: "trim_clip" },
  { engine: "hyperframes", template: "hyperframes/pan-reframe", family: "camera_move", recipe_id: "pan-reframe-hyperframes", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "pan", operation_type: "trim_clip" },
  { engine: "hyperframes", template: "hyperframes/text-fade-up", family: "text_motion", recipe_id: "text-fade-up-hyperframes", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "fade_up", operation_type: "overlay_text" },
  { engine: "hyperframes", template: "hyperframes/text-word-stagger", family: "text_motion", recipe_id: "text-word-stagger-hyperframes", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "stagger", operation_type: "overlay_text" },
  { engine: "hyperframes", template: "hyperframes/end-card-cta", family: "end_card", recipe_id: "end-card-cta-hyperframes", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "none", xfade: null, direction_map: null, motion: "card", operation_type: "render_graphics_scene" },
];

// ------------------------------------------------------------------------------------------------------------------
// The persistent registry: capabilities/registry/<engine>/<template>.json, one record per capability, sealed with a hash.
// ------------------------------------------------------------------------------------------------------------------

const Validation = z.object({
  at: z.string().datetime(),
  ffmpeg_version: z.string().min(1),
  /** What the capability needs from the local tools (xfade transitions for FFmpeg); empty for a family that needs none. */
  xfade_names: z.array(z.string().min(1)),
  /** The browser the render ran in, for a browser-based engine. */
  browser: z.string().nullable().optional(),
  /** One entry per variant that was rendered for real (for example each wipe direction). */
  renders: z.array(z.object({ variant: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive(), width: z.number(), height: z.number(), fps: z.number(), duration_s: z.number() })).min(1),
  checks: z.array(z.string().min(1)).min(1),
});
export type CapabilityValidation = z.infer<typeof Validation>;

const Attempt = z.object({
  attempt_id: z.string().min(1),
  at: z.string().datetime(),
  outcome: z.enum(["validated", "failed", "in_progress"]),
  /** What the attempt was made against. Another attempt with the same hash would fail the same way, so it is not made. */
  input_hash: z.string().min(1),
  reasons: z.array(z.string()),
});

export const CapabilityStatus = z.enum(["validated", "validation_failed", "learning_in_progress"]);

export const CapabilityRecord = z.object({
  format: z.literal("digikon.capability-record"),
  format_version: z.literal(2),
  /** `<engine>:<recipe_id>`: the one identity of a capability. */
  capability_id: z.string().regex(/^(ffmpeg|remotion|hyperframes):[a-z0-9-]+$/),
  capability_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  engine: z.enum(ENGINES),
  /** The reviewed template this engine runs for the recipe. Controlled by the application, never by a model. */
  template: z.string().regex(/^(ffmpeg|remotion|hyperframes)\/[a-z0-9-]+$/),
  recipe_id: z.string().min(1),
  recipe_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  family: z.enum(["xfade_transition", "camera_move", "text_motion", "end_card", "logo_reveal"]),
  storyboard_transition: z.string().min(1),
  /** The family's own parameters. Must equal the catalog entry's, or the record is not trusted. */
  spec: z.object({ xfade: z.string().regex(/^[a-z]+$/).nullable(), direction_map: z.record(z.string().regex(/^[a-z]+$/), z.string().regex(/^[a-z]+$/)).nullable(), motion: z.string().regex(/^[a-z_]+$/).optional() }),
  status: CapabilityStatus,
  /** What the capability takes, from the recipe it implements. */
  inputs: z.object({ operation_type: z.string(), parameters: z.array(z.string()) }),
  /** What it was tested in combination with. Anything not listed is unproven. */
  combinations: z.object({ validated_with: z.array(z.string()), not_validated: z.array(z.string()) }),
  compatibility: z.object({ recipe_renderers: z.array(z.enum(ENGINES)), approval: z.string() }),
  /** Present only while status is validated. */
  validated: Validation.nullable(),
  /** The validation a failed or replaced capability used to have. History, never trusted. */
  previous_validated: Validation.nullable().default(null),
  known_limitations: z.array(z.string()),
  attempts: z.array(Attempt).max(20),
  migrated_from: z.object({ format_version: z.literal(1), spec_hash: z.string(), file: z.string() }).nullable().default(null),
  record_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecord>;

const stable = (v: unknown): string => (Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v));
export const recordHash = (r: Omit<CapabilityRecord, "record_hash">): string => createHash("sha256").update(stable(r)).digest("hex");
/** Writes a record's hash into it. Used by the learner and by tooling that builds records by hand. */
export const sealRecord = (r: Omit<CapabilityRecord, "record_hash">): CapabilityRecord => CapabilityRecord.parse({ ...r, record_hash: recordHash(r) });
const seal = (r: Omit<CapabilityRecord, "record_hash">): CapabilityRecord => CapabilityRecord.parse({ ...r, record_hash: recordHash(r) });
const fileFor = (template: string) => `${template.replaceAll("/", "__")}.json`;
export const registryDir = (root: string) => join(root, "registry");
export const legacyDir = (root: string) => join(root, "learned");
export const capabilityFile = (root: string, engine: Engine, template: string) => join(registryDir(root), engine, fileFor(template));

const FAMILY_NOTES: Record<CapabilityFamily, { combinations: { validated_with: string[]; not_validated: string[] }; limitations: string[] }> = {
  xfade_transition: { combinations: { validated_with: ["text-card scenes on either side of the transition", "the film's whole length kept"], not_validated: ["a transition between scenes with supplied images or clips", "a transition between clips rendered by different engines", "audio"] }, limitations: ["validated on a synthetic two-scene text film only", "no audio", "needs the local FFmpeg xfade transition named in the spec"] },
  camera_move: { combinations: { validated_with: ["a supplied image filling the frame"], not_validated: ["an animated text entrance over the image (that combination is validated with the text capability)", "a video clip as the moving picture", "an end card in the same scene", "a transition into or out of a scene rendered by another engine", "audio"] }, limitations: ["validated on a synthetic striped image at one frame size", "moves a supplied image only, never video", "the easing curve is not measured frame by frame", "needs a compatible 64-bit browser for Remotion"] },
  text_motion: { combinations: { validated_with: ["approved text on a plain card", "approved text over a camera-moved image"], not_validated: ["two text animations in one scene", "an end card in the same scene", "audio"] }, limitations: ["validated on synthetic text with the project font only", "text is matched by pixel comparison, not OCR", "needs a compatible 64-bit browser for Remotion"] },
  logo_reveal: { combinations: { validated_with: ["a supplied logo image alone on a plain background"], not_validated: ["a logo with text or a camera move in the same scene", "a video as the logo", "audio"] }, limitations: ["validated on a synthetic logo at one frame size", "the logo is fitted inside the middle half of the frame and never cropped or recoloured", "needs a compatible 64-bit browser for Remotion"] },
  end_card: { combinations: { validated_with: ["approved text on a brand, dark or light card"], not_validated: ["an end card with a camera move or another text animation", "a logo or button graphic", "audio"] }, limitations: ["shows the approved text and an accent bar only", "no logo is drawn", "needs a compatible 64-bit browser for Remotion"] },
};

/** The record a catalog entry would have, before any evidence. */
export function blankRecord(e: CatalogEntry, recipe: Pick<Recipe, "operation_type" | "parameters" | "compatibility"> | undefined): Omit<CapabilityRecord, "record_hash"> {
  return {
    format: "digikon.capability-record", format_version: 2, capability_id: `${e.engine}:${e.recipe_id}`, capability_version: e.version, engine: e.engine, template: e.template,
    recipe_id: e.recipe_id, recipe_version: e.recipe_version, family: e.family, storyboard_transition: e.storyboard_transition, spec: { xfade: e.xfade, direction_map: e.direction_map, ...(e.motion ? { motion: e.motion } : {}) },
    status: "validation_failed", inputs: { operation_type: recipe?.operation_type ?? e.operation_type ?? "concat", parameters: (recipe?.parameters ?? []).map((p) => p.name) },
    combinations: FAMILY_NOTES[e.family].combinations, compatibility: { recipe_renderers: recipe ? [...recipe.compatibility.renderers] : [e.engine], approval: "binds recipe version " + e.recipe_version + "; the recipe itself is never rewritten by learning" },
    validated: null, previous_validated: null,
    known_limitations: FAMILY_NOTES[e.family].limitations,
    attempts: [], migrated_from: null,
  };
}

export interface RegistryProblem { file: string; problem: string }

export interface LoadedRegistry {
  /** Every record that parsed and verified, whatever its status (failures and attempts in progress included). */
  records: CapabilityRecord[];
  /** What an adapter may use: validated, hash-verified, equal to its catalog entry, in its own engine's folder, and its implementation and dependencies are present now. */
  usable: CapabilityRecord[];
  /** Records that verified but cannot be used, with why (for example a missing dependency). */
  unusable: { record: CapabilityRecord; reason: string }[];
  /** Files that were found but not trusted, with why. They are never registered. */
  problems: string[];
  /** What the FFmpeg adapter takes. Only the usable records of that engine. */
  transitions(engine?: Engine): LearnedTransition[];
  /** The record for a capability id, any status. */
  get(engine: Engine, recipe_id: string): CapabilityRecord | undefined;
  /** The usable records for a recipe, by engine. */
  usableFor(recipe_id: string): CapabilityRecord[];
  /** The composed-scene templates (camera moves, text motions, end cards) of one engine that are usable now. */
  composed(engine?: Engine): ComposedTemplate[];
}

export interface LoadOptions {
  catalog?: readonly CatalogEntry[];
  /** Why a record's implementation or dependencies are missing on this machine, or null when present. Defaults to a check of the local FFmpeg. */
  dependency?: (r: CapabilityRecord) => string | null;
  /** Only the records of one engine are used. The others are still read (so they can be reported) but never returned as usable. */
  engine?: Engine;
  /** The recipe library. A record validated for another version of its recipe is not usable for this one: an approved recipe version is never reinterpreted. */
  recipes?: { get(id: string): Pick<Recipe, "version"> | undefined };
}

let xfadeCache: string[] | null | undefined;
/** The xfade transitions the local FFmpeg actually has, read from the tool itself. */
export function localXfadeNames(ffmpegPath = "ffmpeg"): string[] {
  const text = execFileSync(ffmpegPath, ["-hide_banner", "-h", "filter=xfade"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return [...text.matchAll(/^\s{5}([a-z]+)\s+-?\d+\s+\.\.FV/gm)].map((m) => m[1]!);
}
/** What one family needs to be validated and used: the local tools it depends on, its variants, and the real-render check of each. */
export interface FamilyImpl {
  /** Why this machine cannot run the family for this entry (a missing FFmpeg transition, no compatible browser), or null. Also the loader's check for validated records. */
  unavailable(e: { engine: Engine; family: CapabilityFamily; xfade: string | null; direction_map: Record<string, string> | null; motion?: string | undefined }): string | null;
  /** Versions of what the evidence depends on, recorded with it and hashed into the input hash. */
  versions(opts: LearnOptions, entry: CatalogEntry): Promise<{ ffmpeg_version: string; browser: string | null; needs: string[] }>;
  /** Why this validated record no longer describes the code that would run (the implementation changed after validation), or null. Evidence about other code is never trusted. */
  stale?(r: CapabilityRecord): string | null;
  variants(entry: CatalogEntry): (string | null)[];
  validate(entry: CatalogEntry, variant: string | null, opts: LearnOptions, workRoot: string): Promise<VariantOutcome>;
}
export type VariantOutcome = { ok: true; render: CapabilityValidation["renders"][number]; checks: string[] } | { ok: false; reasons: string[] };
const FAMILIES = new Map<CapabilityFamily, FamilyImpl>();
/** Registers the validator of a family. A family with no registered validator can neither be learned nor have its records used. */
export function registerFamily(family: CapabilityFamily, impl: FamilyImpl): void { FAMILIES.set(family, impl); }

/** The default dependency check: the family's own check on this machine. */
export function defaultDependencyCheck(r: CapabilityRecord): string | null {
  const impl = FAMILIES.get(r.family);
  if (!impl) return `no implementation of ${r.family} is registered in this build`;
  return impl.unavailable({ engine: r.engine, family: r.family, xfade: r.spec.xfade, direction_map: r.spec.direction_map, motion: r.spec.motion }) ?? impl.stale?.(r) ?? null;
}
function readRecord(file: string, catalog: readonly CatalogEntry[], engineDir: Engine): { record: CapabilityRecord } | { problem: string } {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return { problem: "not valid JSON" }; }
  const p = CapabilityRecord.safeParse(raw);
  if (!p.success) return { problem: p.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ") };
  const { record_hash, ...rest } = p.data;
  if (recordHash(rest) !== record_hash) return { problem: "the file was changed after it was written (hash mismatch)" };
  if (p.data.engine !== engineDir) return { problem: `it says engine ${p.data.engine} but is stored under ${engineDir}` };
  if (!p.data.template.startsWith(`${p.data.engine}/`)) return { problem: `template ${p.data.template} does not belong to engine ${p.data.engine}` };
  if (p.data.capability_id !== `${p.data.engine}:${p.data.recipe_id}`) return { problem: "its capability id does not match its engine and recipe" };
  if (file.slice(-fileFor(p.data.template).length) !== fileFor(p.data.template)) return { problem: `the file name does not match its template ${p.data.template}` };
  const entry = catalog.find((c) => c.template === p.data.template);
  if (!entry) return { problem: `${p.data.template} is not a capability this engine knows` };
  if (entry.engine !== p.data.engine || entry.recipe_id !== p.data.recipe_id || entry.recipe_version !== p.data.recipe_version || entry.family !== p.data.family || entry.storyboard_transition !== p.data.storyboard_transition
    || stable({ xfade: entry.xfade, direction_map: entry.direction_map, ...(entry.motion ? { motion: entry.motion } : {}) }) !== stable(p.data.spec)) return { problem: `it does not match the catalog entry for ${p.data.template}` };
  if (entry.version !== p.data.capability_version) return { problem: `it was validated as version ${p.data.capability_version} but the catalog is now at ${entry.version}; it must be validated again before it is used` };
  if (p.data.status === "validated" && !p.data.validated) return { problem: "it says validated but carries no validation evidence" };
  if (p.data.status !== "validated" && p.data.validated) return { problem: `it carries validation evidence but its status is ${p.data.status}` };
  return { record: p.data };
}

/**
 * Reads the registry under `capabilities/registry`. A damaged, edited or unrecognised file is reported and ignored, so a capability is never
 * trusted on a file's say-so; a verified record is usable only while its implementation and dependencies are present on this machine.
 */
export function loadCapabilityRegistry(root: string | null | undefined, opts: LoadOptions = {}): LoadedRegistry {
  const catalog = opts.catalog ?? CAPABILITY_CATALOG, dependency = opts.dependency ?? defaultDependencyCheck;
  const out = { records: [] as CapabilityRecord[], usable: [] as CapabilityRecord[], unusable: [] as { record: CapabilityRecord; reason: string }[], problems: [] as string[] };
  const dir = root ? registryDir(root) : null;
  if (dir && existsSync(dir)) {
    for (const engine of readdirSync(dir)) {
      if (!(ENGINES as readonly string[]).includes(engine)) { out.problems.push(`${engine}: not an engine folder`); continue; }
      const eDir = join(dir, engine);
      for (const f of readdirSync(eDir).filter((x) => x.endsWith(".json")).sort()) {
        const r = readRecord(join(eDir, f), catalog, engine as Engine);
        if ("problem" in r) { out.problems.push(`${engine}/${f}: ${r.problem}`); continue; }
        out.records.push(r.record);
        if (r.record.status !== "validated") { out.unusable.push({ record: r.record, reason: `its status is ${r.record.status}` }); continue; }
        if (opts.engine && r.record.engine !== opts.engine) { out.unusable.push({ record: r.record, reason: `it belongs to ${r.record.engine}, not ${opts.engine}` }); continue; }
        const rv = opts.recipes?.get(r.record.recipe_id)?.version;
        if (rv && rv !== r.record.recipe_version) { out.unusable.push({ record: r.record, reason: `it was validated for recipe version ${r.record.recipe_version}, but the library has ${rv}; the approved version is never reinterpreted` }); continue; }
        const missing = dependency(r.record);
        if (missing) out.unusable.push({ record: r.record, reason: missing });
        else out.usable.push(r.record);
      }
    }
  }
  return {
    ...out,
    transitions: (engine: Engine = "ffmpeg") => out.usable.filter((r) => r.engine === engine && r.family === "xfade_transition").map((r) => ({ template: r.template, storyboard_transition: r.storyboard_transition, xfade: r.spec.xfade, direction_map: r.spec.direction_map })),
    get: (engine, recipe_id) => out.records.find((r) => r.engine === engine && r.recipe_id === recipe_id),
    usableFor: (recipe_id) => out.usable.filter((r) => r.recipe_id === recipe_id),
    composed: (engine: Engine = "remotion") => out.usable.filter((r) => r.engine === engine && r.family !== "xfade_transition").map((r) => ({ template: r.template, family: r.family as ComposedTemplate["family"], type: r.inputs.operation_type as ComposedTemplate["type"], motion: r.spec.motion ?? "" })),
  };
}

/** The old name and shape, for callers that only need the learned FFmpeg transitions and the usable records. */
export function loadLearnedCapabilities(root: string | null | undefined, catalog?: readonly CatalogEntry[]) {
  const l = loadCapabilityRegistry(root, { ...(catalog ? { catalog } : {}) });
  return { transitions: l.transitions("ffmpeg"), specs: l.usable, problems: l.problems };
}

// ------------------------------------------------------------------------------------------------------------------
// Migration of the version 1 store (capabilities/learned/<template>.json) into the registry, with its evidence kept as it was.
// ------------------------------------------------------------------------------------------------------------------

const LegacySpec = z.object({
  format: z.literal("digikon.learned-capability"), format_version: z.literal(1), template: z.string().regex(/^ffmpeg\/[a-z0-9-]+$/), family: z.literal("xfade_transition"),
  recipe_id: z.string().min(1), storyboard_transition: z.string().min(1), xfade: z.string().regex(/^[a-z]+$/).nullable(),
  direction_map: z.record(z.string().regex(/^[a-z]+$/), z.string().regex(/^[a-z]+$/)).nullable(), validated: Validation, spec_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
/** The hash a version 1 file carried, kept so old files can still be verified before they are migrated. */
export const legacySpecHash = (s: Omit<z.infer<typeof LegacySpec>, "spec_hash">): string => createHash("sha256").update(stable(s)).digest("hex");
const legacyHash = legacySpecHash;

export interface MigrationResult { migrated: string[]; already: string[]; problems: string[] }

/**
 * Copies every version 1 file that still verifies into the registry as a version 2 record. The validation evidence (render hashes, checks,
 * FFmpeg version, date) is carried over exactly; the original file is left where it is. Running it again changes nothing. A v1 file that fails
 * its hash or no longer matches the catalog is reported and not migrated.
 */
export function migrateLegacyStore(root: string, catalog: readonly CatalogEntry[] = CAPABILITY_CATALOG): MigrationResult {
  const res: MigrationResult = { migrated: [], already: [], problems: [] };
  const dir = legacyDir(root);
  if (!existsSync(dir)) return res;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { res.problems.push(`${f}: not valid JSON`); continue; }
    const p = LegacySpec.safeParse(raw);
    if (!p.success) { res.problems.push(`${f}: ${p.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ")}`); continue; }
    const { spec_hash, ...body } = p.data;
    if (legacyHash(body) !== spec_hash) { res.problems.push(`${f}: the file was changed after it was validated (hash mismatch)`); continue; }
    if (f !== fileFor(p.data.template)) { res.problems.push(`${f}: the file name does not match its template ${p.data.template}`); continue; }
    const entry = catalog.find((c) => c.template === p.data.template);
    if (!entry || entry.recipe_id !== p.data.recipe_id || entry.storyboard_transition !== p.data.storyboard_transition || stable({ xfade: entry.xfade, direction_map: entry.direction_map }) !== stable({ xfade: p.data.xfade, direction_map: p.data.direction_map })) {
      res.problems.push(`${f}: it does not match the catalog entry for ${p.data.template}`); continue;
    }
    const target = capabilityFile(root, "ffmpeg", p.data.template);
    if (existsSync(target)) { res.already.push(p.data.template); continue; }
    const rec = seal({
      ...blankRecord(entry, undefined), status: "validated", validated: p.data.validated,
      attempts: [{ attempt_id: `migrated-${spec_hash.slice(0, 12)}`, at: p.data.validated.at, outcome: "validated", input_hash: "migrated-from-v1", reasons: [] }],
      migrated_from: { format_version: 1, spec_hash, file: f },
    });
    writeRecord(target, rec);
    res.migrated.push(p.data.template);
  }
  return res;
}

function writeRecord(file: string, rec: CapabilityRecord): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
  renameSync(`${file}.tmp`, file); // atomic: a half-written record is never read
}

// ------------------------------------------------------------------------------------------------------------------
// Gaps, engine evaluation and operation status.
// ------------------------------------------------------------------------------------------------------------------

/** The per-operation lifecycle. Derived from evidence on disk and in the plan, never from anyone's assertion. */
export type OperationStatus = "validated_available" | "learning_required" | "learning_in_progress" | "validation_failed" | "blocked_with_reason" | "rendered_and_verified";

export interface CapabilityGap {
  operation_id: string;
  scene_id: string | null;
  recipe_id: string;
  template: string;
  operation_type: string;
  parameters: Record<string, unknown>;
  reasons: string[];
  /** True when the catalog has an engine entry for this template, so learning can be tried. */
  learnable: boolean;
}

/** Operations of a render plan that no registered renderer can run, each marked learnable or not. Nothing is learned here. */
export function findCapabilityGaps(record: Pick<RenderRecord, "operations" | "blockers">, catalog: readonly CatalogEntry[] = CAPABILITY_CATALOG, operations?: readonly { operation_id: string; target_scene_id: string; parameters: Record<string, unknown> }[]): CapabilityGap[] {
  const byId = new Map((operations ?? []).map((o) => [o.operation_id, o]));
  return record.operations.filter((o) => o.renderer === null).map((o) => ({
    operation_id: o.operation_id, scene_id: byId.get(o.operation_id)?.target_scene_id ?? null, recipe_id: o.recipe_id, template: o.implementation_ref, operation_type: o.operation_type,
    parameters: byId.get(o.operation_id)?.parameters ?? {},
    reasons: record.blockers.filter((b) => b.startsWith(`${o.operation_id}:`)).map((b) => b.slice(o.operation_id.length + 1).trim()),
    learnable: catalog.some((c) => c.template === o.implementation_ref),
  }));
}

export interface EngineEvaluation {
  engine: Engine;
  /** The approved recipe lists this engine in `compatibility.renderers`. An engine it does not list is never used, whatever it could do. */
  permitted_by_recipe: boolean;
  implementation: "built_in" | "learned" | "none";
  template: string | null;
  verdict: "usable" | "learnable" | "failed_before" | "in_progress" | "not_permitted" | "not_implemented" | "dependency_missing";
  reason: string;
}

export interface OperationDiagnosis {
  operation_id: string;
  scene_id: string | null;
  recipe_id: string;
  recipe_version: string;
  operation_type: string;
  parameters: Record<string, unknown>;
  status: OperationStatus;
  engines: EngineEvaluation[];
  selected_engine: Engine | null;
  selected_template: string | null;
  /** Why the operation has this status, in words that can be shown to a person. */
  reason: string;
}

export interface DiagnoseInput {
  operations: readonly { operation_id: string; target_scene_id: string; operation_type: string; recipe_id: string; recipe_version: string; parameters: Record<string, unknown> }[];
  recipes: { get(id: string): Recipe | undefined };
  /** Which template references the registered adapters can run for an operation type, built in or learned. */
  supports: (template: string, operationType: string) => boolean;
  /** The engine a registered adapter belongs to for a template, if any. */
  engineOf: (template: string) => Engine | null;
  registry: LoadedRegistry;
  catalog?: readonly CatalogEntry[];
  now?: () => Date;
}

const IN_PROGRESS_STALE_MS = 10 * 60_000;

/**
 * For every operation: which engines could carry it out and why, which one is selected, and the operation's status. An engine is a candidate
 * only if the approved recipe lists it and a validated implementation exists for it; nothing is substituted because it "looks similar".
 */
export function diagnoseOperations(input: DiagnoseInput): OperationDiagnosis[] {
  const catalog = input.catalog ?? CAPABILITY_CATALOG;
  const now = (input.now ?? (() => new Date()))().getTime();
  return input.operations.map((op) => {
    const recipe = input.recipes.get(op.recipe_id);
    const base = { operation_id: op.operation_id, scene_id: op.target_scene_id, recipe_id: op.recipe_id, recipe_version: op.recipe_version, operation_type: op.operation_type, parameters: op.parameters };
    if (!recipe) return { ...base, status: "blocked_with_reason" as const, engines: [], selected_engine: null, selected_template: null, reason: `recipe ${op.recipe_id} does not exist` };
    const permitted = new Set<Engine>(recipe.compatibility.renderers as Engine[]);
    const engines: EngineEvaluation[] = ENGINES.map((engine): EngineEvaluation => {
      const base = { engine, permitted_by_recipe: permitted.has(engine) };
      if (!permitted.has(engine)) return { ...base, implementation: "none", template: null, verdict: "not_permitted", reason: `recipe ${recipe.recipe_id} does not list ${engine} as a compatible renderer, so ${engine} is not used even if it could do something similar` };
      // the recipe's own template, when it belongs to this engine
      const own = recipe.implementation_ref.startsWith(`${engine}/`) ? recipe.implementation_ref : null;
      const rec = input.registry.get(engine, recipe.recipe_id);
      const usable = input.registry.usable.find((r) => r.engine === engine && r.recipe_id === recipe.recipe_id && r.recipe_version === recipe.version);
      const template = own ?? usable?.template ?? rec?.template ?? null;
      if (template && input.supports(template, op.operation_type) && input.engineOf(template) === engine) {
        const builtIn = !usable;
        return { ...base, implementation: builtIn ? "built_in" : "learned", template, verdict: "usable", reason: builtIn ? `${template} is a built-in template of ${engine}` : `${template} was validated by real render on ${usable!.validated!.at.slice(0, 10)} (${usable!.capability_id} v${usable!.capability_version})` };
      }
      const entry = catalog.find((c) => c.engine === engine && c.recipe_id === recipe.recipe_id && c.recipe_version === recipe.version);
      if (rec?.status === "learning_in_progress") {
        const last = rec.attempts.at(-1);
        if (last && now - new Date(last.at).getTime() < IN_PROGRESS_STALE_MS) return { ...base, implementation: "none", template: rec.template, verdict: "in_progress", reason: `learning ${rec.capability_id} started ${last.at} and has not finished` };
      }
      const unusable = input.registry.unusable.find((u) => u.record.engine === engine && u.record.recipe_id === recipe.recipe_id && u.record.status === "validated");
      if (unusable) return { ...base, implementation: "none", template: unusable.record.template, verdict: "dependency_missing", reason: `${unusable.record.capability_id} was validated but cannot be used now: ${unusable.reason}` };
      if (rec?.status === "validation_failed") {
        const last = rec.attempts.at(-1);
        return { ...base, implementation: "none", template: rec.template, verdict: "failed_before", reason: `learning ${rec.capability_id} failed${last ? ` on ${last.at.slice(0, 10)}: ${last.reasons.join("; ").slice(0, 300)}` : ""}; it is retried only when its inputs change` };
      }
      if (entry) return { ...base, implementation: "none", template: entry.template, verdict: "learnable", reason: `${engine} has a catalog entry (${entry.template}) that has not been validated yet` };
      return { ...base, implementation: "none", template: own, verdict: "not_implemented", reason: `${engine} has no validated template for ${recipe.recipe_id} and no engine family in this project can implement it` };
    });
    const chosen = engines.find((e) => e.verdict === "usable" && e.engine === (recipe.implementation_ref.split("/")[0] as Engine)) ?? engines.find((e) => e.verdict === "usable");
    if (chosen) return { ...base, status: "validated_available" as const, engines, selected_engine: chosen.engine, selected_template: chosen.template, reason: chosen.reason };
    const inProgress = engines.find((e) => e.verdict === "in_progress");
    if (inProgress) return { ...base, status: "learning_in_progress" as const, engines, selected_engine: null, selected_template: null, reason: inProgress.reason };
    const learnable = engines.find((e) => e.verdict === "learnable");
    if (learnable) return { ...base, status: "learning_required" as const, engines, selected_engine: null, selected_template: null, reason: learnable.reason };
    const failed = engines.find((e) => e.verdict === "failed_before" || e.verdict === "dependency_missing");
    if (failed) return { ...base, status: failed.verdict === "failed_before" ? ("validation_failed" as const) : ("blocked_with_reason" as const), engines, selected_engine: null, selected_template: null, reason: failed.reason };
    return { ...base, status: "blocked_with_reason" as const, engines, selected_engine: null, selected_template: null, reason: `no permitted engine has a validated implementation: ${engines.map((e) => `${e.engine}: ${e.reason}`).join("; ")}` };
  });
}

/**
 * The template an engine other than the recipe's own can use for it: only an engine the approved recipe lists, and only a validated, usable
 * registry record. The recipe is never changed; the choice is returned so it can be recorded with the render.
 */
export function alternativeImplementation(recipe: Pick<Recipe, "recipe_id" | "implementation_ref" | "compatibility" | "version">, registry: LoadedRegistry, supports: (template: string) => boolean): CapabilityRecord | null {
  const own = recipe.implementation_ref.split("/")[0];
  for (const r of registry.usableFor(recipe.recipe_id)) {
    if (r.recipe_version !== (recipe as { version?: string }).version) continue; // validated for another version of the recipe: not this approved one
    if (r.engine === own || !(recipe.compatibility.renderers as string[]).includes(r.engine) || !supports(r.template)) continue;
    return r;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------------------
// Learning: validate with the local tools and a real render, then record the evidence (or the failure).
// ------------------------------------------------------------------------------------------------------------------

export interface LearnOptions {
  /** The capabilities root, for example `capabilities`. Records go to `<root>/registry/<engine>`. */
  root: string;
  fontFile: string;
  ffmpegPath?: string;
  workRoot?: string;
  catalog?: readonly CatalogEntry[];
  recipes?: { get(id: string): Recipe | undefined };
  now?: () => Date;
  /** Retry a failed capability although its inputs have not changed. */
  force?: boolean;
}

export type LearnResult =
  | { status: "learned"; template: string; record: CapabilityRecord; file: string; reused: boolean }
  | { status: "unsupported"; template: string; reasons: string[]; /** True when the attempt was not made because an earlier attempt with the same inputs failed. */ retry_skipped?: boolean; in_progress?: boolean; file?: string };

const W = 320, H = 180, FPS = 30;
const NAVY = [22, 33, 62], FOREST = [30, 61, 47];
const near = (a: readonly number[], b: readonly number[], tol = 14) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const luma = (c: readonly number[]) => 0.299 * c[0]! + 0.587 * c[1]! + 0.114 * c[2]!;

async function pixel(video: string, n: number, x: number, y: number, ffmpegPath: string): Promise<number[]> {
  const { stdout } = await run(ffmpegPath, ["-v", "error", "-i", video, "-vf", `select=eq(n\\,${n}),format=rgb24,crop=2:2:${x}:${y}`, "-frames:v", "1", "-fps_mode", "passthrough", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 16, timeout: 60_000, windowsHide: true });
  const b = stdout as unknown as Buffer;
  return [b[0] ?? -1, b[1] ?? -1, b[2] ?? -1];
}

/** A synthetic two-scene film: navy for two seconds, a half-second transition at the end of it, then forest for two seconds. */
function syntheticJob(candidate: LearnedTransition, variant: string | null, outDir: string): Omit<RenderJob, "signal"> {
  const op = (id: string, scene: string, type: "render_graphics_scene" | "concat", start: number, dur: number, params: Record<string, string | number>, caption: string | null) => EditorOperation.parse({
    operation_id: id, target_scene_id: scene, operation_type: type, parameters: params, preconditions: [], expected_result: "capability validation", validation_status: "unvalidated",
    source_use_id: `U${id.slice(1)}`, recipe_id: "capability-validation", recipe_version: "0.0.1", asset_ids: [], timing: { start_s: start, duration_s: dur },
    caption: caption ? { text: caption, start_s: start, end_s: start + dur } : null, audio_cues: [],
  });
  const render_id = `rn_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const transition: Record<string, string | number> = { duration_s: 0.5, ...(variant ? { direction: variant } : {}) };
  return {
    render_id,
    settings: RenderSettings.parse({ aspect_ratio: "16:9", width: W, height: H, fps: FPS, duration_s: 4, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "capability validation values, not a platform specification" } }),
    operations: [
      op("E01", "S01", "render_graphics_scene", 0, 2, { fade_in_s: 0.2, background: "navy" }, "One"),
      op("E02", "S01", "concat", 1.5, 0.5, transition, null),
      op("E03", "S02", "render_graphics_scene", 2, 2, { fade_in_s: 0.2, background: "forest" }, "Two"),
    ],
    templates: { E01: "ffmpeg/text-card", E02: candidate.template, E03: "ffmpeg/text-card" },
    assets: [], clips: [], asset_info: {}, concept_asset_ids: [], output_path: join(outDir, `${render_id}.mp4`),
  };
}

/** Renders one variant for real and checks it. Returns the evidence, or the reasons it failed. */
async function validateVariant(entry: CatalogEntry, variant: string | null, opts: LearnOptions, workRoot: string): Promise<{ ok: true; render: CapabilityValidation["renders"][number]; checks: string[] } | { ok: false; reasons: string[] }> {
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  const label = variant ? `${entry.template} (${variant})` : entry.template;
  const candidate: LearnedTransition = { template: entry.template, storyboard_transition: entry.storyboard_transition, xfade: entry.xfade, direction_map: entry.direction_map };
  const outDir = join(workRoot, "out");
  mkdirSync(outDir, { recursive: true });
  const adapter = createFfmpegAdapter({ fontFile: opts.fontFile, outputRoot: outDir, workRoot, ffmpegPath, learned: [candidate] });
  const job = syntheticJob(candidate, variant, outDir);
  const issues = adapter.check?.(job) ?? [];
  if (issues.length) return { ok: false, reasons: issues.map((i) => `${label}: the adapter refuses the validation film: ${i}`) };
  try { await adapter.render({ ...job, signal: new AbortController().signal }); } catch (e) { return { ok: false, reasons: [`${label}: the render failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`] }; }
  const checked = await validateOutput(job.output_path, job.settings, false);
  if (!checked.ok) return { ok: false, reasons: checked.issues.map((i) => `${label}: ${i}`) };
  const out = job.output_path, reasons: string[] = [], checks: string[] = [];
  const at = (n: number, x: number, y: number) => pixel(out, n, x, y, ffmpegPath);
  // timing: the film keeps its length, scene one is on screen before the transition and scene two from the frame it ends
  const a = await at(24, 8, 8), b = await at(100, 8, 8), first = await at(60, 8, 8);
  if (!near(a, NAVY)) reasons.push(`${label}: the first scene is not on screen at 0.8 s (${a.join(",")})`); else checks.push("scene one on screen before the transition (0.8 s)");
  if (!near(b, FOREST)) reasons.push(`${label}: the second scene is not on screen at 3.3 s (${b.join(",")})`); else checks.push("scene two on screen after the transition (3.3 s)");
  if (!near(first, FOREST)) reasons.push(`${label}: the second scene does not start exactly when the transition ends (frame 60: ${first.join(",")})`); else checks.push("scene two starts on the frame the transition ends (frame 60)");
  const mid = 52; // the middle of the half-second transition
  if (entry.storyboard_transition === "dip_to_black") {
    const m = await at(mid, 8, 8), early = await at(46, 8, 8), late = await at(58, 8, 8);
    if (!(luma(m) < 0.25 * Math.min(luma(NAVY), luma(FOREST)))) reasons.push(`${label}: the middle of the transition is not dark (luma ${luma(m).toFixed(1)})`); else checks.push(`the middle of the transition is dark (luma ${luma(m).toFixed(1)} against ${luma(NAVY).toFixed(1)} and ${luma(FOREST).toFixed(1)})`);
    if (!(luma(early) > luma(m) && luma(late) > luma(m))) reasons.push(`${label}: the picture does not dip and come back`); else checks.push("the picture dips and comes back");
  } else if (entry.storyboard_transition === "wipe") {
    const horizontal = variant === "left" || variant === "right";
    const p1 = horizontal ? await at(mid, Math.round(W * 0.1), Math.round(H * 0.15)) : await at(mid, Math.round(W * 0.1), Math.round(H * 0.08));
    const p2 = horizontal ? await at(mid, Math.round(W * 0.9), Math.round(H * 0.15)) : await at(mid, Math.round(W * 0.1), Math.round(H * 0.92));
    const split = (near(p1, NAVY) && near(p2, FOREST)) || (near(p1, FOREST) && near(p2, NAVY));
    if (!split) reasons.push(`${label}: the middle of the transition is not a ${horizontal ? "left and right" : "top and bottom"} split of the two scenes (${p1.join(",")} and ${p2.join(",")})`); else checks.push(`the middle of the ${variant} wipe shows both scenes split ${horizontal ? "left and right" : "top and bottom"}`);
  } else reasons.push(`${label}: there is no check for a ${entry.storyboard_transition} transition, so it cannot be validated`);
  if (reasons.length) return { ok: false, reasons };
  checks.push(`validateOutput passed: ${checked.output.width}x${checked.output.height} at ${checked.output.fps} fps, ${checked.output.duration_s}s, h264, no audio`);
  return { ok: true, checks, render: { variant: variant ?? "fixed", sha256: checked.output.sha256, bytes: checked.output.bytes, width: checked.output.width, height: checked.output.height, fps: checked.output.fps, duration_s: checked.output.duration_s } };
}

/** The record on disk for a capability, if its own hash verifies, whatever catalog version it was written under: its attempt history must survive an update. */
function readExisting(file: string): CapabilityRecord | undefined {
  try {
    const p = CapabilityRecord.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!p.success) return undefined;
    const { record_hash, ...rest } = p.data;
    return recordHash(rest) === record_hash ? p.data : undefined;
  } catch { return undefined; }
}

const dependencyVersion = (ffmpegPath: string): string => execFileSync(ffmpegPath, ["-version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 }).split(/\r?\n/)[0]!.trim();
/** Everything an attempt depends on. Another attempt with the same hash would fail the same way. */
export const learningInputHash = (entry: CatalogEntry, dependency: string): string => createHash("sha256").update(stable({ entry, dependency, learner: LEARNER_VERSION })).digest("hex");

/**
 * Tries to learn one capability. It must be in the catalog, the local FFmpeg must have the xfade transitions it needs, and every variant
 * (each wipe direction) must render for real and pass its frame checks. Only then is the record marked validated. A failure is written down
 * as a failed record with its reasons, never trusted, and is not retried until its inputs (the entry, the engine dependency, the learner)
 * change or `force` is set. The recipe itself is never touched.
 */
export async function learnCapability(template: string, opts: LearnOptions): Promise<LearnResult> {
  const entry = (opts.catalog ?? CAPABILITY_CATALOG).find((c) => c.template === template);
  if (!entry) return { status: "unsupported", template, reasons: [`no engine in this project knows how to implement ${template}; it stays unsupported`] };
  const impl = FAMILIES.get(entry.family);
  if (!impl) return { status: "unsupported", template, reasons: [`no validator for the ${entry.family} family is registered in this build, so ${template} cannot be validated`] };
  const now = opts.now ?? (() => new Date());
  const file = capabilityFile(opts.root, entry.engine, template);
  const recipe = opts.recipes?.get(entry.recipe_id);
  const base = blankRecord(entry, recipe);
  let versions: Awaited<ReturnType<FamilyImpl["versions"]>>;
  try { versions = await impl.versions(opts, entry); } catch (e) { return { status: "unsupported", template, reasons: [`the local tools could not be inspected: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`] }; }
  const input_hash = learningInputHash(entry, `${versions.ffmpeg_version}|${versions.browser ?? ""}`);
  const existing = readExisting(file);
  const attempts = [...(existing?.attempts ?? [])];
  const t0 = now();

  if (existing) {
    const last = existing.attempts.at(-1);
    if (existing.status === "validated" && existing.validated && last?.input_hash === input_hash && existing.template === template) return { status: "learned", template, record: existing, file: resolve(file), reused: true };
    if (existing.status === "learning_in_progress" && last && t0.getTime() - new Date(last.at).getTime() < IN_PROGRESS_STALE_MS) return { status: "unsupported", template, in_progress: true, reasons: [`learning ${existing.capability_id} is already in progress (started ${last.at})`] };
    if (existing.status === "validation_failed" && last?.outcome === "failed" && last.input_hash === input_hash && !opts.force) {
      return { status: "unsupported", template, retry_skipped: true, file: resolve(file), reasons: [`an earlier attempt on ${last.at} with the same inputs failed (${last.reasons.join("; ").slice(0, 300)}); it is not retried until the entry, the recipe, the engine dependency or the learner changes`] };
    }
  }
  const attemptId = `a-${randomUUID().slice(0, 8)}`;
  const keep = existing?.validated ?? existing?.previous_validated ?? null;
  const mark = (outcome: "in_progress" | "failed" | "validated", reasons: string[]) => [...attempts.filter((a) => a.attempt_id !== attemptId), { attempt_id: attemptId, at: t0.toISOString(), outcome, input_hash, reasons }].slice(-20);
  writeRecord(file, seal({ ...base, status: "learning_in_progress", previous_validated: keep, attempts: mark("in_progress", []) }));

  const fail = (reasons: string[]): LearnResult => {
    writeRecord(file, seal({ ...base, status: "validation_failed", validated: null, previous_validated: keep, attempts: mark("failed", reasons) }));
    return { status: "unsupported", template, reasons, file: resolve(file) };
  };
  const unavailable = impl.unavailable({ engine: entry.engine, family: entry.family, xfade: entry.xfade, direction_map: entry.direction_map, motion: entry.motion });
  if (unavailable) return fail([unavailable]);

  const work = await mkdtemp(join(opts.workRoot ?? tmpdir(), "learn-"));
  try {
    const renders: CapabilityValidation["renders"] = [], checks: string[] = [];
    for (const v of impl.variants(entry)) {
      const r = await impl.validate(entry, v, opts, join(work, v ?? "fixed"));
      if (!r.ok) return fail(r.reasons);
      renders.push(r.render); checks.push(...r.checks);
    }
    const validated = Validation.parse({ at: t0.toISOString(), ffmpeg_version: versions.ffmpeg_version, xfade_names: versions.needs, ...(versions.browser ? { browser: versions.browser } : {}), renders, checks });
    const record = seal({ ...base, status: "validated", validated, previous_validated: null, attempts: mark("validated", []) });
    writeRecord(file, record);
    return { status: "learned", template, record, file: resolve(file), reused: false };
  } catch (e) {
    return fail([`the validation stopped unexpectedly: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** A fingerprint of the code that builds and checks an FFmpeg xfade transition. */
export function xfadeCodeHash(): string {
  try {
    const h = createHash("sha256");
    for (const f of ["assemble.ts", "ffmpeg.ts", "transition-checks.ts"]) h.update(f).update(readNormalized(fileURLToPath(new URL(`./${f}`, import.meta.url))));
    return h.digest("hex").slice(0, 16);
  } catch { return "unknown"; }
}
let ffmpegVersionCache: string | null | undefined;
const currentFfmpegVersion = (): string | null => {
  if (ffmpegVersionCache === undefined) { try { ffmpegVersionCache = dependencyVersion("ffmpeg"); } catch { ffmpegVersionCache = null; } }
  return ffmpegVersionCache;
};
/**
 * Why an xfade record no longer describes what would run: the xfade code changed, or FFmpeg was upgraded or replaced. A record written before the code hash was
 * recorded is judged by its FFmpeg version alone (it is not discarded outright, so existing evidence keeps working until the next validation).
 */
export function xfadeStaleness(r: CapabilityRecord, now: { code?: string; ffmpeg?: string | null } = {}): string | null {
  const recordedCode = /xfade-code ([0-9a-f]{16}|unknown)/.exec(r.validated?.browser ?? "")?.[1];
  const code = now.code ?? xfadeCodeHash();
  if (recordedCode && recordedCode !== code) return `the xfade code changed after it was validated (the evidence is for ${recordedCode}, the code is now ${code}); it must be validated again`;
  const recordedFfmpeg = r.validated?.ffmpeg_version;
  const ffmpeg = now.ffmpeg === undefined ? currentFfmpegVersion() : now.ffmpeg;
  if (recordedFfmpeg && ffmpeg && recordedFfmpeg !== ffmpeg) return `FFmpeg changed after it was validated (the evidence is for "${recordedFfmpeg}", it is now "${ffmpeg}"); it must be validated again`;
  return null;
}

/** The FFmpeg xfade transition family: needs the transitions in the spec to exist in the local FFmpeg; validated on a synthetic two-scene film. */
registerFamily("xfade_transition", {
  unavailable: (e) => {
    if (e.engine !== "ffmpeg") return `no ${e.engine} implementation of the xfade transition family exists in this build`;
    if (xfadeCache === undefined) { try { xfadeCache = localXfadeNames(); } catch { xfadeCache = null; } }
    if (!xfadeCache) return "the local FFmpeg could not be inspected";
    const needed = e.xfade ? [e.xfade] : Object.values(e.direction_map ?? {});
    const missing = needed.filter((n) => !xfadeCache!.includes(n));
    return !needed.length || missing.length ? `the local FFmpeg does not have the xfade transition${missing.length === 1 ? "" : "s"} ${missing.join(", ") || "(none named)"} that ${e.engine} needs` : null;
  },
  versions: async (o) => ({ ffmpeg_version: dependencyVersion(o.ffmpegPath ?? "ffmpeg"), browser: `xfade-code ${xfadeCodeHash()}`, needs: [] }),
  stale: (r) => xfadeStaleness(r),
  variants: (e) => (e.direction_map ? Object.keys(e.direction_map) : [null]),
  validate: (e, v, o, w) => validateVariant(e, v, o, w),
});
/** Tries to learn every learnable gap once (several operations can share a template). Unlearnable gaps are returned as unsupported, not skipped. */
export async function learnGaps(gaps: readonly CapabilityGap[], opts: LearnOptions): Promise<LearnResult[]> {
  const out: LearnResult[] = [];
  for (const template of [...new Set(gaps.map((g) => g.template))]) out.push(await learnCapability(template, opts));
  return out;
}

/** The recipe ids that have a working template: built in, or learned and validated. Used to mark recipes in retrieval. */
export function implementedRecipeIds(recipes: readonly { recipe_id: string; implementation_ref: string }[], templateRefs: Iterable<string>): Set<string> {
  const refs = new Set(templateRefs);
  return new Set(recipes.filter((r) => refs.has(r.implementation_ref)).map((r) => r.recipe_id));
}
