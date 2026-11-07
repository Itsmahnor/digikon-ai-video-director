import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Project } from "@digikon/contracts";
import { ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, runEditor, type DirectorStateType } from "@digikon/director";
import { KeywordRetriever, recipeDocs } from "@digikon/rag";
import { cfg, deps, knowledge, root } from "../../director/src/fixtures.js";
import {
  AdapterRegistry, CAPABILITY_CATALOG, CapabilityRecord, FFMPEG_TEMPLATES, LEARNER_VERSION, blankRecord, capabilityFile, createFfmpegAdapter, diagnoseOperations, executeRender, findCapabilityGaps, implementedRecipeIds,
  learnCapability, learningInputHash, legacyDir, legacySpecHash, loadCapabilityRegistry, migrateLegacyStore, planRender, previewCoverage, recordHash, registryDir, runRenderQa, sealRecord, selectRenderer,
  type CatalogEntry, type RenderAdapter,
} from "./index.js";
import { realPrerequisites, skipReal } from "./test-env.js";

vi.setConfig({ testTimeout: 300_000 });
const FONTS = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];
const font = FONTS.find((f) => existsSync(f));
realPrerequisites({ font: !!font });
const tmp = mkdtempSync(join(tmpdir(), "capabilities-"));
const outputRoot = join(tmp, "out"), workRoot = join(tmp, "work"), capRoot = join(tmp, "capabilities");
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
mkdirSync(outputRoot); mkdirSync(workRoot);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const proofDir = process.env["RENDER_PROOF_DIR"];

// ---- approved-plan builders (the same Director, both approvals and Editor path the other render tests use) ----
const ready = { status: "ready", questions: [] };
const gfx = [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }];
const scene = (id: string, dur: number, text: string, transition = "cut") => ({
  scene_id: id, purpose: "p", duration_seconds: dur, asset_ids: [], required_assets: gfx, transition_out: transition,
  shot: { shot_size: "wide", camera_motion: "static", visual_action: "Text on a plain background" }, overlay: { text, safe_area: "platform_safe" },
});
const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, number | string> = {}) => ({ use_id: `U${String(n).padStart(2, "0")}`, scene_id, recipe_id, params, rationale: "fits the beat" });
const treatment = (beats: number[]) => ({ logline: "A short, clear film", hook: "The opening line", tone: "friendly", beats: beats.map((s, i) => ({ beat: `Beat ${i + 1}`, purpose: "p", approx_seconds: s })), cta: "Learn more", claims: [] });
const project = (id: string, brief: string, aspect: "16:9" | "9:16", seconds: number, platform: string) => Project.parse({ project_id: id, owner_id: "u1", brief, objective: "Inform the audience", audience: "General", platform, aspect_ratio: aspect, target_duration: seconds });
async function directed(id: string, p: ReturnType<typeof project>, beats: number[], scenes: unknown[], uses: unknown[]) {
  const d = deps(new ScriptedClient([ready, treatment(beats), { scenes }, { uses }]));
  const graph = buildDirectorGraph(d);
  const g1 = await graph.invoke({ project: p, assets: [], facts: [] }, cfg(id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(id))) as DirectorStateType;
  const handoff = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: id, model: "scripted" });
  const run = await runEditor(handoff, { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever });
  if (!run.ok) throw new Error(`editor rejected: ${run.reasons.join("; ")}`);
  return { handoff, output: run.output, recipes: d.recipes };
}
type Run = Awaited<ReturnType<typeof directed>>;
const settings = (w: number, h: number, duration: number, aspect: "16:9" | "9:16") => ({ aspect_ratio: aspect, width: w, height: h, fps: 30, duration_s: duration, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test fixture values, not a platform specification" } });

/** A registry the way the console builds it: FFmpeg gets whatever the store holds right now. */
const registry = (dir: string | null = capRoot) => new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot, learned: loadCapabilityRegistry(dir).transitions("ffmpeg") })]);
const planFor = (r: Run, s: unknown, reg: AdapterRegistry, purpose: "preview" | "production" = "preview", over: { handoff?: unknown; capabilities?: ReturnType<typeof loadCapabilityRegistry> } = {}) => {
  const { capabilities, ...input } = over;
  const x = planRender({ editor_output: r.output, handoff: r.handoff, settings: s, purpose, ...input }, { recipes: r.recipes, adapters: reg, outputRoot, ...(capabilities ? { capabilities } : {}) });
  if (!x.ok) throw new Error(`rejected: ${x.reasons.join("; ")}`);
  return x;
};
const rawPixel = (video: string, n: number, x: number, y: number) => {
  const b = execFileSync("ffmpeg", ["-v", "error", "-i", video, "-vf", `select=eq(n\\,${n}),format=rgb24,crop=2:2:${x}:${y}`, "-frames:v", "1", "-fps_mode", "passthrough", "-f", "rawvideo", "-"], { maxBuffer: 1 << 16 });
  return [b[0]!, b[1]!, b[2]!];
};
const NAVY = [22, 33, 62], CHARCOAL = [43, 45, 49], FOREST = [30, 61, 47];
const near = (a: number[], b: number[], tol = 14) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const luma = (c: number[]) => 0.299 * c[0]! + 0.587 * c[1]! + 0.114 * c[2]!;

// Project A: a 16:9 explainer whose first scene ends in a dip to black. Project B: a different brief, a 9:16 film with a wipe and a dip.
let A: Run, B: Run;
const A_SETTINGS = settings(640, 360, 12, "16:9"), B_SETTINGS = settings(360, 640, 12, "9:16");
beforeAll(async () => {
  A = await directed("cap-a", project("capa", "A 12 second explainer for a study planner app.", "16:9", 12, "YouTube"), [4, 4, 4], [
    scene("S01", 4, "Meet the planner", "dip_to_black"), scene("S02", 4, "Plan your week"), scene("S03", 4, "Start today"),
  ], [use(1, "S01", "text-card-fade"), use(2, "S01", "dip-to-black", { duration_s: 0.6 }), use(3, "S02", "text-card-fade", { background: "charcoal" }), use(4, "S03", "text-card-fade", { background: "forest" })]);
  B = await directed("cap-b", project("capb", "A 12 second vertical announcement for a jazz night.", "9:16", 12, "Instagram"), [4, 4, 4], [
    scene("S01", 4, "Jazz night", "wipe"), scene("S02", 4, "Live on Saturday", "dip_to_black"), scene("S03", 4, "Book a table"),
  ], [use(1, "S01", "text-card-fade", { background: "forest" }), use(2, "S01", "directional-wipe", { direction: "up", duration_s: 0.5 }), use(3, "S02", "text-card-fade", { background: "charcoal" }), use(4, "S02", "dip-to-black", { duration_s: 0.6 }), use(5, "S03", "text-card-fade")]);
}, 180_000);

// ================= P1: the shared registry =================
const stable = (v: unknown): string => (Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v));
const library = deps(new ScriptedClient([])).recipes;
const entryFor = (over: Partial<CatalogEntry>): CatalogEntry => ({ engine: "ffmpeg", template: "ffmpeg/xfade-test", family: "xfade_transition", recipe_id: "dip-to-black", recipe_version: "0.1.0", version: "1.0.0", storyboard_transition: "dip_to_black", xfade: "fadeblack", direction_map: null, ...over });
const recordFor = (e: CatalogEntry, over: Record<string, unknown> = {}): CapabilityRecord => {
  const { record_hash: _h, ...rest } = sealRecordFor(e);
  return sealRecord({ ...rest, ...over } as never);
};
const sealRecordFor = (e: CatalogEntry): CapabilityRecord => sealRecord({
  ...blankRecord(e, library.get(e.recipe_id)), status: "validated",
  validated: { at: "2026-10-28T00:00:00.000Z", ffmpeg_version: "ffmpeg version test", xfade_names: ["fadeblack"], renders: [{ variant: "fixed", sha256: "a".repeat(64), bytes: 2000, width: 320, height: 180, fps: 30, duration_s: 4 }], checks: ["a check"] },
  attempts: [{ attempt_id: "a-1", at: "2026-10-28T00:00:00.000Z", outcome: "validated", input_hash: "x", reasons: [] }],
} as never);
const putRecord = (dir: string, rec: CapabilityRecord, file?: string) => { const f = file ?? capabilityFile(dir, rec.engine, rec.template); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, JSON.stringify(rec)); return f; };
const noDeps = () => null;

describe("the registry is consistent with the recipe library", () => {
  it("every catalog entry names an existing draft transition recipe, its own engine's template and a unique capability", () => {
    const ids = new Set<string>(), templates = new Set<string>();
    for (const e of CAPABILITY_CATALOG) {
      const r = library.get(e.recipe_id);
      expect(r, e.recipe_id).toBeDefined();
      expect(r!.implementation_ref).toBe(e.template);
      expect(r!.version).toBe(e.recipe_version); // validated against the recipe version that is approved
      expect(r!.compatibility.renderers).toContain(e.engine); // the engine is one the recipe permits
      expect(e.template.startsWith(`${e.engine}/`)).toBe(true);
      expect(({ xfade_transition: ["transition"], camera_move: ["camera_move", "shot"], text_motion: ["animation"], end_card: ["animation"], logo_reveal: ["animation"] } as Record<string, string[]>)[e.family]).toContain(r!.type); // a transition recipe, or a recipe of its own family
      expect(r!.status).toBe("draft");
      if (e.family === "xfade_transition") expect(["dip_to_black", "wipe"]).toContain(e.storyboard_transition);
      expect(Object.keys(FFMPEG_TEMPLATES)).not.toContain(e.template); // not built in: it has to be learned
      expect(ids.has(`${e.engine}:${e.recipe_id}`)).toBe(false); expect(templates.has(e.template)).toBe(false);
      ids.add(`${e.engine}:${e.recipe_id}`); templates.add(e.template);
    }
  });
});

describe("the version 1 store migrates into the registry with its evidence kept", () => {
  const realLegacy = join(repoRoot, "capabilities", "learned");
  const real = existsSync(realLegacy) ? readdirSync(realLegacy).filter((f) => f.endsWith(".json")) : [];

  it.skipIf(!real.length)("the files this project really validated migrate, with every piece of their evidence unchanged, and the originals are left alone", () => {
    const r = join(tmp, "migrate-real"); mkdirSync(legacyDir(r), { recursive: true });
    for (const f of real) copyFileSync(join(realLegacy, f), join(legacyDir(r), f));
    const before = Object.fromEntries(real.map((f) => [f, readFileSync(join(legacyDir(r), f), "utf8")]));
    const m = migrateLegacyStore(r);
    expect(m.problems).toEqual([]);
    expect(m.migrated.sort()).toEqual(real.map((f) => f.replace("ffmpeg__", "ffmpeg/").replace(".json", "")).sort());
    const reg = loadCapabilityRegistry(r, { dependency: noDeps });
    expect(reg.problems).toEqual([]);
    for (const f of real) {
      const old = JSON.parse(before[f]!);
      const rec = reg.get("ffmpeg", old.recipe_id)!;
      expect(rec.status).toBe("validated");
      expect(rec.validated).toEqual(old.validated); // the render hashes, the checks, the FFmpeg version and the date, exactly
      expect(rec.migrated_from).toEqual({ format_version: 1, spec_hash: old.spec_hash, file: f });
      expect(rec.capability_id).toBe(`ffmpeg:${old.recipe_id}`);
      expect(rec.spec).toEqual({ xfade: old.xfade, direction_map: old.direction_map });
      expect(readFileSync(join(legacyDir(r), f), "utf8")).toBe(before[f]); // not rewritten or deleted
    }
    const again = migrateLegacyStore(r);
    expect(again.migrated).toEqual([]); // running it again changes nothing
    expect(again.already.sort()).toEqual(m.migrated.sort());
  });

  const v1 = (over: Record<string, unknown> = {}) => {
    const body = { format: "digikon.learned-capability", format_version: 1, template: "ffmpeg/xfade-fadeblack", family: "xfade_transition", recipe_id: "dip-to-black", storyboard_transition: "dip_to_black", xfade: "fadeblack", direction_map: null,
      validated: { at: "2026-10-27T00:00:00.000Z", ffmpeg_version: "ffmpeg version old", xfade_names: ["fadeblack"], renders: [{ variant: "fixed", sha256: "b".repeat(64), bytes: 1234, width: 320, height: 180, fps: 30, duration_s: 4 }], checks: ["old check one", "old check two"] }, ...over };
    return { ...body, spec_hash: legacySpecHash(body as never) };
  };
  const putV1 = (name: string, spec: unknown, file = "ffmpeg__xfade-fadeblack.json") => { const r = join(tmp, "migrate", name); mkdirSync(legacyDir(r), { recursive: true }); writeFileSync(join(legacyDir(r), file), JSON.stringify(spec)); return r; };

  it("migrates a synthetic v1 file, keeping its evidence", () => {
    const r = putV1("ok", v1());
    expect(migrateLegacyStore(r).migrated).toEqual(["ffmpeg/xfade-fadeblack"]);
    const rec = loadCapabilityRegistry(r, { dependency: noDeps }).get("ffmpeg", "dip-to-black")!;
    expect(rec.validated!.checks).toEqual(["old check one", "old check two"]);
    expect(rec.validated!.ffmpeg_version).toBe("ffmpeg version old");
  });

  it.each([
    ["edited after validation", () => ({ ...v1(), xfade: "wipeleft" }), "hash mismatch"],
    ["not matching the catalog", () => v1({ xfade: "wipeleft" }), "does not match the catalog entry"],
    ["with no evidence", () => v1({ validated: { at: "2026-10-27T00:00:00.000Z", ffmpeg_version: "x", xfade_names: ["fadeblack"], renders: [], checks: [] } }), "renders"],
  ] as const)("does not migrate a v1 file that is %s, and says why", (name, make, why) => {
    const r = putV1(name, make());
    const m = migrateLegacyStore(r);
    expect(m.migrated).toEqual([]);
    expect(m.problems.join(" ")).toContain(why);
    expect(loadCapabilityRegistry(r, { dependency: noDeps }).records).toEqual([]);
  });
});

describe("a record is only trusted when its file verifies, belongs to its engine and its dependencies exist", () => {
  const e = CAPABILITY_CATALOG[0]!;
  it("accepts an intact record and keeps its engine separate", () => {
    const r = join(tmp, "trust", "ok"); putRecord(r, recordFor(e));
    const l = loadCapabilityRegistry(r, { dependency: noDeps });
    expect(l.problems).toEqual([]);
    expect(l.usable.map((x) => x.capability_id)).toEqual(["ffmpeg:dip-to-black"]);
    expect(l.transitions("ffmpeg")).toEqual([{ template: "ffmpeg/xfade-fadeblack", storyboard_transition: "dip_to_black", xfade: "fadeblack", direction_map: null }]);
    expect(l.transitions("remotion")).toEqual([]); expect(l.transitions("hyperframes")).toEqual([]);
  });

  it.each([
    ["edited after it was written", (x: CapabilityRecord) => ({ ...x, spec: { xfade: "wipeleft", direction_map: null } }), "hash mismatch"],
    ["claiming validation without evidence", (x: CapabilityRecord) => { const { record_hash: _h, ...b } = x; return sealRecord({ ...b, validated: null }); }, "carries no validation evidence"],
    ["with evidence but a failed status", (x: CapabilityRecord) => { const { record_hash: _h, ...b } = x; return sealRecord({ ...b, status: "validation_failed" }); }, "carries validation evidence"],
    ["with the hash recomputed but not what the catalog says", (x: CapabilityRecord) => { const { record_hash: _h, ...b } = x; return sealRecord({ ...b, spec: { xfade: "wipeleft", direction_map: null } }); }, "does not match the catalog entry"],
    ["validated for a different recipe version", (x: CapabilityRecord) => { const { record_hash: _h, ...b } = x; return sealRecord({ ...b, recipe_version: "0.2.0" }); }, "does not match the catalog entry"],
    ["at an older capability version", (x: CapabilityRecord) => { const { record_hash: _h, ...b } = x; return sealRecord({ ...b, capability_version: "0.9.0" }); }, "must be validated again"],
    ["with a filter-like xfade name", (x: CapabilityRecord) => { const { record_hash: _h, ...b } = x; return sealRecord({ ...b, spec: { xfade: "fade,drawtext=text=x" as never, direction_map: null } }); }, "xfade"],
  ] as const)("ignores a record that is %s", (name, make, why) => {
    const r = join(tmp, "trust", name); mkdirSync(join(r, "registry", "ffmpeg"), { recursive: true });
    writeFileSync(capabilityFile(r, "ffmpeg", e.template), JSON.stringify((() => { try { return make(recordFor(e)); } catch (err) { return { zodFailure: String(err) }; } })()));
    const l = loadCapabilityRegistry(r, { dependency: noDeps });
    expect(l.usable).toEqual([]);
    expect(l.transitions("ffmpeg")).toEqual([]);
    expect(l.problems.join(" ")).toContain(why === "xfade" ? "" : why);
  });

  it("ignores a record stored under the wrong engine, and one whose template is another engine's", () => {
    const r = join(tmp, "trust", "engine"); const rec = recordFor(e);
    putRecord(r, rec, join(registryDir(r), "remotion", "ffmpeg__xfade-fadeblack.json"));
    expect(loadCapabilityRegistry(r, { dependency: noDeps }).problems.join(" ")).toContain("it says engine ffmpeg but is stored under remotion");
    const wrongTemplate = join(tmp, "trust", "engine2"); const { record_hash: _h, ...b } = rec;
    putRecord(wrongTemplate, sealRecord({ ...b, template: "remotion/xfade-fadeblack" }), join(registryDir(wrongTemplate), "ffmpeg", "remotion__xfade-fadeblack.json"));
    expect(loadCapabilityRegistry(wrongTemplate, { dependency: noDeps }).problems.join(" ")).toContain("does not belong to engine ffmpeg");
  });

  it("a validated record whose dependency is missing is not reported as available, and says why", () => {
    const r = join(tmp, "trust", "dep"); putRecord(r, recordFor(e));
    const l = loadCapabilityRegistry(r, { dependency: () => "the local FFmpeg does not have the xfade transition fadeblack" });
    expect(l.usable).toEqual([]);
    expect(l.unusable).toEqual([expect.objectContaining({ reason: "the local FFmpeg does not have the xfade transition fadeblack" })]);
    expect(l.transitions("ffmpeg")).toEqual([]);
  });

  it("a validated record for a recipe version the library no longer has is not used for it", () => {
    const r = join(tmp, "trust", "version"); putRecord(r, recordFor(e));
    const l = loadCapabilityRegistry(r, { dependency: noDeps, recipes: { get: () => ({ version: "0.2.0" }) } });
    expect(l.usable).toEqual([]);
    expect(l.unusable[0]!.reason).toContain("validated for recipe version 0.1.0, but the library has 0.2.0");
  });

  it("a missing or empty registry is simply empty", () => {
    for (const x of [loadCapabilityRegistry(join(tmp, "nowhere")), loadCapabilityRegistry(null)]) expect({ records: x.records, usable: x.usable, problems: x.problems }).toEqual({ records: [], usable: [], problems: [] });
  });

  it("the FFmpeg adapter refuses a learned template that belongs to another engine", () => {
    expect(() => createFfmpegAdapter({ fontFile: font ?? process.execPath, outputRoot, learned: [{ template: "remotion/xfade-wipe", storyboard_transition: "wipe", xfade: null, direction_map: { left: "wipeleft" } }] })).toThrow(/is not an FFmpeg template/);
  });
});

describe.skipIf(skipReal(!!font))("learning is attempted, recorded, persisted and not repeated without a reason", () => {
  const entry = (over: Partial<CatalogEntry>) => entryFor(over);
  const failing = (over: Partial<CatalogEntry> = {}) => entry({ storyboard_transition: "wipe", xfade: null, direction_map: { left: "fadeblack", right: "fadeblack" }, ...over }); // renders fine but is not a wipe

  it("a failed attempt is recorded with its reasons, never trusted, and survives as history", async () => {
    const r = join(tmp, "learn", "failed"); const catalog = [failing()];
    const res = await learnCapability("ffmpeg/xfade-test", { root: r, fontFile: font!, workRoot, catalog });
    expect(res).toMatchObject({ status: "unsupported" });
    expect(res.status === "unsupported" && res.reasons.join(" ")).toMatch(/not a left and right split/);
    const l = loadCapabilityRegistry(r, { catalog, dependency: noDeps });
    expect(l.usable).toEqual([]);
    const rec = l.get("ffmpeg", "dip-to-black")!;
    expect(rec).toMatchObject({ status: "validation_failed", validated: null });
    expect(rec.attempts).toHaveLength(1);
    expect(rec.attempts[0]).toMatchObject({ outcome: "failed" });
    expect(rec.attempts[0]!.reasons.join(" ")).toMatch(/not a left and right split/);
  });

  it("the same failure is not retried while nothing changed, and is retried when an input changes or on request", async () => {
    const r = join(tmp, "learn", "retry"); const catalog = [failing()];
    const first = await learnCapability("ffmpeg/xfade-test", { root: r, fontFile: font!, workRoot, catalog });
    expect(first.status).toBe("unsupported");
    const second = await learnCapability("ffmpeg/xfade-test", { root: r, fontFile: font!, workRoot, catalog });
    expect(second).toMatchObject({ status: "unsupported", retry_skipped: true });
    expect(second.status === "unsupported" && second.reasons.join(" ")).toContain("is not retried until the entry, the recipe, the engine dependency or the learner changes");
    const attempts = () => loadCapabilityRegistry(r, { catalog, dependency: noDeps }).get("ffmpeg", "dip-to-black")!.attempts;
    expect(attempts()).toHaveLength(1); // the skipped retry did not run or record anything
    const forced = await learnCapability("ffmpeg/xfade-test", { root: r, fontFile: font!, workRoot, catalog, force: true });
    expect(forced.status === "unsupported" && forced.retry_skipped).toBeFalsy();
    expect(attempts()).toHaveLength(2);
    const changed = [failing({ version: "1.0.1", direction_map: { left: "fadeblack", right: "fadewhite" } })]; // a changed entry is a changed input
    const third = await learnCapability("ffmpeg/xfade-test", { root: r, fontFile: font!, workRoot, catalog: changed });
    expect(third.status === "unsupported" && third.retry_skipped).toBeFalsy();
    expect(loadCapabilityRegistry(r, { catalog: changed, dependency: noDeps }).get("ffmpeg", "dip-to-black")!.attempts).toHaveLength(3);
    expect(learningInputHash(failing(), "x")).not.toBe(learningInputHash(failing(), "y")); // so is a new FFmpeg
    expect(LEARNER_VERSION).toBeTruthy();
  });

  it("an attempt in progress blocks a second one, and a stale one does not", async () => {
    const r = join(tmp, "learn", "progress"); const catalog = [failing()];
    const base = blankRecord(catalog[0]!, library.get("dip-to-black"));
    const started = new Date("2026-10-28T10:00:00.000Z");
    putRecord(r, sealRecord({ ...base, status: "learning_in_progress", attempts: [{ attempt_id: "a-run", at: started.toISOString(), outcome: "in_progress", input_hash: "h", reasons: [] }] } as never));
    const busy = await learnCapability("ffmpeg/xfade-test", { root: r, fontFile: font!, workRoot, catalog, now: () => new Date(started.getTime() + 60_000) });
    expect(busy).toMatchObject({ status: "unsupported", in_progress: true });
    const d = diagnoseOperations({ operations: [{ operation_id: "E02", target_scene_id: "S01", operation_type: "concat", recipe_id: "dip-to-black", recipe_version: "0.1.0", parameters: {} }], recipes: library, supports: () => false, engineOf: () => null, registry: loadCapabilityRegistry(r, { catalog, dependency: noDeps }), catalog, now: () => new Date(started.getTime() + 60_000) });
    expect(d[0]).toMatchObject({ status: "learning_in_progress" });
    const stale = await learnCapability("ffmpeg/xfade-test", { root: r, fontFile: font!, workRoot, catalog, now: () => new Date(started.getTime() + 11 * 60_000) });
    expect(stale.status === "unsupported" && stale.in_progress).toBeFalsy(); // a stalled attempt does not block forever
  });

  it("a repeat of a validated capability with unchanged inputs reuses it instead of rendering again", async () => {
    const r = join(tmp, "learn", "reuse");
    const first = await learnCapability("ffmpeg/xfade-fadeblack", { root: r, fontFile: font!, workRoot, recipes: library });
    expect(first).toMatchObject({ status: "learned", reused: false });
    const second = await learnCapability("ffmpeg/xfade-fadeblack", { root: r, fontFile: font!, workRoot, recipes: library });
    expect(second).toMatchObject({ status: "learned", reused: true });
    expect(second.status === "learned" && second.record.validated).toEqual(first.status === "learned" && first.record.validated);
  });

  it("a failed update does not leave a capability trusted: the old evidence is kept as history, and the recipe file is untouched", async () => {
    const r = join(tmp, "learn", "update");
    const ok = await learnCapability("ffmpeg/xfade-fadeblack", { root: r, fontFile: font!, workRoot, recipes: library });
    expect(ok.status).toBe("learned");
    const recipeFile = join(repoRoot, "recipes", "transition", "dip-to-black.json");
    const recipeBefore = createHash("sha256").update(readFileSync(recipeFile)).digest("hex");
    const bad = [entryFor({ template: "ffmpeg/xfade-fadeblack", version: "1.1.0", storyboard_transition: "wipe", xfade: null, direction_map: { left: "fadeblack" } })];
    const upd = await learnCapability("ffmpeg/xfade-fadeblack", { root: r, fontFile: font!, workRoot, catalog: bad });
    expect(upd.status).toBe("unsupported");
    const rec = loadCapabilityRegistry(r, { catalog: bad, dependency: noDeps }).get("ffmpeg", "dip-to-black")!;
    expect(rec).toMatchObject({ status: "validation_failed", validated: null }); // the failed update is not trusted
    expect(rec.attempts.map((a) => a.outcome)).toEqual(["validated", "failed"]); // the history of both attempts is kept
    const raw = JSON.parse(readFileSync(capabilityFile(r, "ffmpeg", "ffmpeg/xfade-fadeblack"), "utf8"));
    expect(raw.status).toBe("validation_failed");
    expect(raw.validated).toBeNull();
    expect(raw.previous_validated.checks.length).toBeGreaterThan(3); // history, never trusted
    expect(createHash("sha256").update(readFileSync(recipeFile)).digest("hex")).toBe(recipeBefore); // learning never rewrites a recipe
    expect(library.get("dip-to-black")!.version).toBe("0.1.0");
  });

  it("a template no engine knows is unsupported and leaves no record at all", async () => {
    const r = join(tmp, "learn", "unknown");
    const res = await learnCapability("ffmpeg/camera-push-in", { root: r, fontFile: font!, workRoot });
    expect(res.status === "unsupported" && res.reasons[0]).toContain("no engine in this project knows how to implement ffmpeg/camera-push-in");
    expect(existsSync(registryDir(r))).toBe(false);
  });
});

describe.skipIf(skipReal(!!font))("a validated capability survives a restart and is found by another project", () => {
  it("learns, persists in the registry and is read back by a separate process", async () => {
    for (const template of ["ffmpeg/xfade-fadeblack", "ffmpeg/xfade-wipe"]) {
      const r = await learnCapability(template, { root: capRoot, fontFile: font!, workRoot, recipes: library });
      expect(r.status, JSON.stringify(r)).toBe("learned");
      if (r.status !== "learned") continue;
      expect(r.file).toBe(capabilityFile(capRoot, "ffmpeg", template).replaceAll("/", "\\").replace(/\\/g, process.platform === "win32" ? "\\" : "/"));
      expect(r.record.validated!.renders.every((x) => x.bytes > 1000 && /^[a-f0-9]{64}$/.test(x.sha256) && x.fps === 30 && x.duration_s === 4)).toBe(true);
      expect(r.record.validated!.checks.join("\n")).toMatch(/scene two starts on the frame the transition ends/);
      expect(r.record.attempts.at(-1)).toMatchObject({ outcome: "validated" });
      expect(r.record.known_limitations.length).toBeGreaterThan(0);
      expect(r.record.combinations.not_validated.length).toBeGreaterThan(0);
      console.log("LEARNED", r.record.capability_id, JSON.stringify({ renders: r.record.validated!.renders.map((x) => [x.variant, x.sha256.slice(0, 12)]), checks: r.record.validated!.checks.length }));
    }
    expect(readdirSync(join(registryDir(capRoot), "ffmpeg")).sort()).toEqual(["ffmpeg__xfade-fadeblack.json", "ffmpeg__xfade-wipe.json"]);
    const mine = loadCapabilityRegistry(capRoot, { recipes: library });
    expect(mine.problems).toEqual([]);
    // a different process, as after an application restart: nothing is carried over but the files
    const script = join(tmp, "restart.mts");
    writeFileSync(script, `import { loadCapabilityRegistry } from "${new URL("./capabilities.ts", import.meta.url).href}";
const l = loadCapabilityRegistry(process.argv[2]);
console.log(JSON.stringify({ usable: l.usable.map((r) => [r.capability_id, r.record_hash, r.validated.renders.map((x) => x.sha256)]), problems: l.problems, transitions: l.transitions("ffmpeg").map((t) => t.template) }));
`);
    const out = JSON.parse(execFileSync(process.execPath, [join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), script, capRoot], { encoding: "utf8" }).trim().split(/\r?\n/).at(-1)!);
    expect(out.problems).toEqual([]);
    expect(out.usable).toEqual(mine.usable.map((r) => [r.capability_id, r.record_hash, r.validated!.renders.map((x) => x.sha256)]));
    expect(out.transitions.sort()).toEqual(["ffmpeg/xfade-fadeblack", "ffmpeg/xfade-wipe"]);
    console.log("RESTART", JSON.stringify(out.usable.map((u: unknown[]) => [u[0], String(u[1]).slice(0, 12)])));
  });

  it("before learning the approved dip is an unsupported operation with a status and a reason per engine; after learning it is validated and available", async () => {
    const empty = join(tmp, "none");
    const x = planFor(A, A_SETTINGS, registry(empty), "preview", { capabilities: loadCapabilityRegistry(empty, { recipes: A.recipes }) });
    expect(x.record.state).toBe("planning");
    const d = x.diagnosis.find((o) => o.operation_id === "E02")!;
    expect(d).toMatchObject({ recipe_id: "dip-to-black", status: "learning_required", selected_engine: null });
    expect(d.engines.map((e) => [e.engine, e.verdict])).toEqual([["ffmpeg", "learnable"], ["remotion", "not_implemented"], ["hyperframes", "not_permitted"]]);
    expect(d.engines[2]!.reason).toContain("does not list hyperframes as a compatible renderer");
    expect(x.diagnosis.filter((o) => o.status === "validated_available").map((o) => o.recipe_id)).toEqual(["text-card-fade", "text-card-fade", "text-card-fade"]);
    const after = planFor(A, A_SETTINGS, registry(), "preview", { capabilities: loadCapabilityRegistry(capRoot, { recipes: A.recipes }) });
    const d2 = after.diagnosis.find((o) => o.operation_id === "E02")!;
    expect(d2).toMatchObject({ status: "validated_available", selected_engine: "ffmpeg", selected_template: "ffmpeg/xfade-fadeblack" });
    expect(d2.reason).toContain("was validated by real render");
    expect(after.record.state, after.record.blockers.join("; ")).toBe("executable");
  });

  it("project A: the same approved plan renders the dip for real at the approved time, and QA accepts the approved black", async () => {
    const x = planFor(A, A_SETTINGS, registry());
    expect(x.record.operations.map((o) => [o.recipe_id, o.implementation_ref, o.renderer])).toContainEqual(["dip-to-black", "ffmpeg/xfade-fadeblack", "ffmpeg"]);
    expect(x.record.operations.every((o) => !o.production_executable)).toBe(true); // still draft
    const cov = previewCoverage(A.handoff, A.output, x.record, selectRenderer(x.record, registry()).capabilities);
    expect(cov.complete).toBe(true);
    const rec = await executeRender(x.plan!);
    expect(rec.state, JSON.stringify(rec.errors)).toBe("rendered");
    expect(rec.output).toMatchObject({ width: 640, height: 360, fps: 30, duration_s: 12, video_codec: "h264", audio_tracks: 0 });
    const v = rec.output!.path;
    expect(near(rawPixel(v, 60, 8, 8), NAVY)).toBe(true);
    expect(luma(rawPixel(v, 111, 8, 8))).toBeLessThan(0.3 * luma(NAVY));
    expect(near(rawPixel(v, 120, 8, 8), CHARCOAL)).toBe(true);
    expect(near(rawPixel(v, 250, 8, 8), FOREST)).toBe(true);
    const qa = await runRenderQa(rec, A.handoff);
    expect(qa.findings, JSON.stringify(qa.findings)).toEqual([]);
    console.log("PROJECT A", JSON.stringify({ ...rec.output, path: "<tmp>" }));
    if (proofDir) { mkdirSync(proofDir, { recursive: true }); writeFileSync(join(proofDir, "capability-project-a.mp4"), readFileSync(v)); }
  });

  it("project B (another brief, aspect ratio and scenes) finds the capabilities in the registry with a fresh adapter and renders them", async () => {
    const x = planFor(B, B_SETTINGS, registry());
    expect(x.record.state, x.record.blockers.join("; ")).toBe("executable");
    expect(x.record.operations.map((o) => o.implementation_ref).filter((r) => r.includes("xfade")).sort()).toEqual(["ffmpeg/xfade-fadeblack", "ffmpeg/xfade-wipe"]);
    const rec = await executeRender(x.plan!);
    expect(rec.state, JSON.stringify(rec.errors)).toBe("rendered");
    expect(rec.output).toMatchObject({ width: 360, height: 640, fps: 30, duration_s: 12 });
    const v = rec.output!.path;
    expect(near(rawPixel(v, 60, 8, 8), FOREST)).toBe(true);
    const top = rawPixel(v, 112, 8, 40), bottom = rawPixel(v, 112, 8, 600);
    expect((near(top, FOREST) && near(bottom, CHARCOAL)) || (near(top, CHARCOAL) && near(bottom, FOREST))).toBe(true);
    expect(near(rawPixel(v, 130, 8, 8), CHARCOAL)).toBe(true);
    expect(luma(rawPixel(v, 231, 8, 8))).toBeLessThan(0.3 * luma(CHARCOAL));
    expect(near(rawPixel(v, 250, 8, 8), NAVY)).toBe(true);
    console.log("PROJECT B", JSON.stringify({ ...rec.output, path: "<tmp>" }));
    if (proofDir) writeFileSync(join(proofDir, "capability-project-b.mp4"), readFileSync(v));
  });

  it("learning changes neither the recipes nor the approvals: still draft, production still blocked, a changed handoff still refused", () => {
    expect(A.recipes.get("dip-to-black")!.status).toBe("draft");
    expect(A.recipes.get("dip-to-black")!.review).toBeNull();
    const prod = planFor(A, A_SETTINGS, registry(), "production");
    expect(prod.record.state).toBe("planning");
    expect(prod.record.blockers.join(" ")).toContain("is draft: no review evidence");
    const tampered = structuredClone(A.handoff); tampered.storyboard.scenes[0]!.overlay!.text = "Changed after approval";
    const r = planRender({ editor_output: A.output, handoff: tampered, settings: A_SETTINGS, purpose: "preview" }, { recipes: A.recipes, adapters: registry(), outputRoot });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.stage).toBe("handoff");
  });

  it("every wipe direction is accepted, a direction outside the list is refused before rendering, and an unknown parameter too", () => {
    const x = planFor(B, B_SETTINGS, registry());
    const job = structuredClone(x.plan!.job);
    const adapter = x.plan!.adapter;
    const wipe = job.operations.find((o) => o.recipe_id === "directional-wipe")!;
    for (const d of ["left", "right", "up", "down"]) { wipe.parameters["direction"] = d; expect(adapter.check!(job), d).toEqual([]); }
    wipe.parameters["direction"] = "diagonal";
    expect(adapter.check!(job).join(" ")).toContain("direction must be one of left, right, up, down");
    wipe.parameters["direction"] = "up"; wipe.parameters["spin"] = 3;
    expect(adapter.check!(job).join(" ")).toContain("unknown parameter spin");
  });

  it("the retrieval index says the recipe has no working template yet, then that it has one once it is learned", async () => {
    const recipes = [...library.available()];
    const asDoc = (impl: Set<string>) => recipeDocs(recipes, { implemented: impl }).find((d) => d.id === "dip-to-black")!;
    const builtIn = implementedRecipeIds(recipes, Object.keys(FFMPEG_TEMPLATES));
    expect(asDoc(builtIn).metadata.recipe_implemented).toBe(false);
    const learned = [...Object.keys(FFMPEG_TEMPLATES), ...loadCapabilityRegistry(capRoot, { recipes: library }).usable.map((r) => r.template)];
    const doc = asDoc(implementedRecipeIds(recipes, learned));
    expect(doc.metadata.recipe_implemented).toBe(true);
    // "implemented" alone only says an implementation is registered; the stronger wording needs the validated set
    expect(doc.text).toContain("Working template: yes, an implementation is registered.");
    expect(doc.text).not.toContain("validated by a real render");
    const proven = recipeDocs(recipes, { implemented: implementedRecipeIds(recipes, learned), validated: implementedRecipeIds(recipes, learned) }).find((d) => d.id === "dip-to-black")!;
    expect(proven.text).toContain("Working template: yes, validated by a real render");
    const q = { text: "fade to black before the final scene", collection: "shot_recipes" as const, k: 3, filter: { include_draft: true } };
    const score = async (impl: Set<string>) => (await new KeywordRetriever(recipeDocs(recipes, { implemented: impl })).retrieve(q)).find((h) => h.doc.id === "dip-to-black")!.score;
    expect(await score(implementedRecipeIds(recipes, learned))).toBeGreaterThan(await score(builtIn));
  });
});

// ================= engine selection: only an engine the approved recipe lists, only through a validated record =================
describe.skipIf(skipReal(!!font))("engine selection never goes beyond what the approved recipe permits", () => {
  // test doubles for other engines: they write nothing; only planning is under test here
  const double = (renderer: "remotion" | "hyperframes", templates: Record<string, readonly ("concat" | "render_graphics_scene")[]>): RenderAdapter => ({ renderer, templates, render: async () => undefined });
  const ffmpegOnly = (): AdapterRegistry => new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot })]); // no learned transitions

  it("a recipe that lists remotion runs on remotion through a validated remotion record, recorded on the render, with the recipe untouched", () => {
    const entry = entryFor({ engine: "remotion", template: "remotion/xfade-wipe", recipe_id: "directional-wipe", storyboard_transition: "wipe", xfade: null, direction_map: { left: "wipeleft", right: "wiperight", up: "wipeup", down: "wipedown" } });
    const r = join(tmp, "select", "ok"); putRecord(r, recordFor(entry));
    const reg = loadCapabilityRegistry(r, { catalog: [entry], dependency: noDeps, recipes: library });
    expect(reg.usable.map((u) => u.capability_id)).toEqual(["remotion:directional-wipe"]);
    const adapters = new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot }), double("remotion", { "remotion/xfade-wipe": ["concat"] })]);
    const x = planRender({ editor_output: B.output, handoff: B.handoff, settings: B_SETTINGS, purpose: "preview" }, { recipes: B.recipes, adapters, capabilities: reg, outputRoot });
    if (!x.ok) throw new Error(x.reasons.join("; "));
    const wipe = x.record.operations.find((o) => o.recipe_id === "directional-wipe")!;
    expect(wipe).toMatchObject({ implementation_ref: "remotion/xfade-wipe", renderer: "remotion" });
    expect(x.record.notes.join("\n")).toContain("directional-wipe runs on remotion through remotion/xfade-wipe");
    const d = x.diagnosis.find((o) => o.recipe_id === "directional-wipe")!;
    expect(d).toMatchObject({ status: "validated_available", selected_engine: "ffmpeg" === d.selected_engine ? "ffmpeg" : "remotion" });
    expect(B.recipes.get("directional-wipe")!.implementation_ref).toBe("ffmpeg/xfade-wipe"); // the approved recipe is as approved
    // another engine is involved now, so the plan needs two renderers: the combination is P3 and is blocked, not silently split
    expect(x.record.blockers.join(" ")).toContain("the operations need more than one renderer");
  });

  it("an engine the recipe does not list is never selected, even with a validated record and a working adapter, and the reason is precise", () => {
    const entry = entryFor({ engine: "hyperframes", template: "hyperframes/xfade-fadeblack", recipe_id: "dip-to-black" });
    const r = join(tmp, "select", "notlisted"); putRecord(r, recordFor(entry));
    const reg = loadCapabilityRegistry(r, { catalog: [entry], dependency: noDeps, recipes: library });
    const adapters = new AdapterRegistry([createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot }), double("hyperframes", { "hyperframes/xfade-fadeblack": ["concat"] })]);
    const x = planRender({ editor_output: A.output, handoff: A.handoff, settings: A_SETTINGS, purpose: "preview" }, { recipes: A.recipes, adapters, capabilities: reg, outputRoot });
    if (!x.ok) throw new Error(x.reasons.join("; "));
    expect(x.record.operations.find((o) => o.recipe_id === "dip-to-black")).toMatchObject({ renderer: null, implementation_ref: "ffmpeg/xfade-fadeblack" });
    expect(x.record.state).toBe("planning");
    const d = x.diagnosis.find((o) => o.recipe_id === "dip-to-black")!;
    expect(d.status).toBe("learning_required"); // FFmpeg, which the recipe does list, can still learn it; hyperframes is not an option at all
    expect(d.selected_engine).toBeNull();
    expect(d.engines.find((e) => e.engine === "hyperframes")).toMatchObject({ verdict: "not_permitted", permitted_by_recipe: false });
    expect(d.engines.find((e) => e.engine === "hyperframes")!.reason).toContain("recipe dip-to-black does not list hyperframes as a compatible renderer");
  });

  it("an engine-specific implementation cannot be used by the wrong renderer", () => {
    const entry = entryFor({ engine: "remotion", template: "remotion/xfade-wipe", recipe_id: "directional-wipe", storyboard_transition: "wipe", xfade: null, direction_map: { left: "wipeleft" } });
    const r = join(tmp, "select", "wrong"); putRecord(r, recordFor(entry));
    const reg = loadCapabilityRegistry(r, { catalog: [entry], dependency: noDeps, recipes: library, engine: "ffmpeg" });
    expect(reg.transitions("ffmpeg")).toEqual([]); // the FFmpeg adapter is never given a remotion capability
    expect(reg.usable).toEqual([]);
    expect(reg.unusable[0]!.reason).toContain("it belongs to remotion, not ffmpeg");
    const x = planRender({ editor_output: B.output, handoff: B.handoff, settings: B_SETTINGS, purpose: "preview" }, { recipes: B.recipes, adapters: ffmpegOnly(), capabilities: reg, outputRoot });
    if (!x.ok) throw new Error(x.reasons.join("; "));
    expect(x.record.operations.find((o) => o.recipe_id === "directional-wipe")!.renderer).toBeNull();
  });

  it("the plan blocker names the operation and every engine's reason when nothing validated exists", () => {
    const x = planFor(B, B_SETTINGS, ffmpegOnly());
    const d = x.diagnosis.find((o) => o.recipe_id === "directional-wipe")!;
    expect(d.status).toBe("learning_required");
    const hf = d.engines.find((e) => e.engine === "hyperframes")!;
    expect(hf.reason).toContain("does not list hyperframes");
    expect(d.engines.find((e) => e.engine === "remotion")!.reason).toContain("no validated template for directional-wipe and no engine family in this project can implement it");
    expect(findCapabilityGaps(x.record, undefined, B.output.operations).find((g) => g.recipe_id === "directional-wipe")).toMatchObject({ scene_id: "S01", parameters: { direction: "up" }, learnable: true });
  });
});

describe("the shipped capability records match the code", () => {
  it("none is invalidated because the code it was validated against has changed", async () => {
    const { fileURLToPath } = await import("node:url");
    const { join } = await import("node:path");
    const registry = loadCapabilityRegistry(join(fileURLToPath(new URL("../../../", import.meta.url)), "capabilities"));
    const stale = registry.unusable.filter((u) => /(?:code|implementation) changed after it was validated/i.test(u.reason)).map((u) => `${u.record.capability_id}: ${u.reason}`);
    // If this fails, code that a transition or scene capability depends on was edited: run \`npm run capabilities -- --force <template>\` and commit the new records.
    expect(stale).toEqual([]);
  });
});
