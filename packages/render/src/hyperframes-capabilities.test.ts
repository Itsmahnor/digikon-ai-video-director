import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Asset, Project } from "@digikon/contracts";
import { ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, runEditor, type DirectorStateType } from "@digikon/director";
import { probeFile } from "@digikon/media";
import { cfg, deps, knowledge, root } from "../../director/src/fixtures.js";
import {
  AdapterRegistry, CAPABILITY_CATALOG, capabilityFile, createHyperframesAdapter, executeRender, findChrome, inkIn, learnCapability, loadCapabilityRegistry, planRender, previewCoverage,
  rawFrame, registryDir, runRenderQa, selectRenderer, type CatalogEntry, type LoadedRegistry,
} from "./index.js";
import { implementationHash } from "./capabilities-remotion.js";
import { realPrerequisites, skipReal } from "./test-env.js";

vi.setConfig({ testTimeout: 600_000 });
const FONTS = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];
const font = FONTS.find((f) => existsSync(f));
const browser = findChrome();
const can = !!font && !!browser;
realPrerequisites({ font: !!font, "a Chrome for HyperFrames": !!browser });
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "hyperframes-caps-"));
const outputRoot = join(tmp, "out"), workRoot = join(tmp, "work");
mkdirSync(outputRoot); mkdirSync(workRoot);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const proofDir = process.env["RENDER_PROOF_DIR"];
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "ignore" });

const library = deps(new ScriptedClient([])).recipes;
const HYPERFRAMES_ENTRIES = CAPABILITY_CATALOG.filter((e) => e.engine === "hyperframes");

// ---- the approved plan: four scenes that need layered operations, three camera moves, three text behaviours and an end card ----
const ready = { status: "ready", questions: [] };
const sceneOf = (id: string, text: string | null, motion: string, assets: string[], required: unknown[]) => ({
  scene_id: id, purpose: "p", duration_seconds: 4, asset_ids: assets, required_assets: required, transition_out: "cut",
  shot: { shot_size: "wide", camera_motion: motion, visual_action: "A supplied picture with text" }, ...(text ? { overlay: { text, safe_area: "platform_safe" } } : {}),
});
const img = (id: string) => [{ need: "A supplied picture", kind: "image", availability: "supplied", asset_id: id }];
const gfx = [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }];
const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, number | string> = {}) => ({ use_id: `U${String(n).padStart(2, "0")}`, scene_id, recipe_id, params, rationale: "fits the beat" });
const settings = (w: number, h: number, duration: number) => ({ aspect_ratio: "16:9", width: w, height: h, fps: 30, duration_s: duration, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test fixture values, not a platform specification" } });
const SETTINGS = settings(640, 360, 16);

async function directed(id: string, scenes: unknown[], uses: unknown[], assets: Asset[], seconds: number) {
  const beats = (scenes as { duration_seconds: number }[]).map((s) => s.duration_seconds);
  const d = deps(new ScriptedClient([ready, { logline: "A short, clear film", hook: "The opening line", tone: "friendly", beats: beats.map((s, i) => ({ beat: `Beat ${i + 1}`, purpose: "p", approx_seconds: s })), cta: "Learn more", claims: [] }, { scenes }, { uses }]));
  const graph = buildDirectorGraph(d);
  const project = Project.parse({ project_id: id, owner_id: "u1", brief: "A short test film.", objective: "Inform the audience", audience: "General", platform: "YouTube", aspect_ratio: "16:9", target_duration: seconds });
  const g1 = await graph.invoke({ project, assets, facts: [] }, cfg(id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(id))) as DirectorStateType;
  const handoff = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: id, model: "scripted" });
  const run = await runEditor(handoff, { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever });
  if (!run.ok) throw new Error(`editor rejected: ${run.reasons.join("; ")}`);
  return { handoff, output: run.output, recipes: d.recipes };
}
type Run = Awaited<ReturnType<typeof directed>>;

let film: Run;
const imagePaths: string[] = [];
beforeAll(async () => {
  const sources = ["testsrc2=s=1280x720", "testsrc=s=1280x720", "rgbtestsrc=s=1280x720"];
  const assets: Asset[] = [];
  for (const [i, src] of sources.entries()) {
    const p = join(tmp, `pic${i}.png`); ff("-f", "lavfi", "-i", `${src}:d=1:r=1`, "-frames:v", "1", p); imagePaths.push(p);
    const a = await probeFile(p, { assetId: `asset_0000000${i + 1}` });
    if (!a.ok) throw new Error("test image rejected");
    assets.push(a.asset);
  }
  film = await directed("hf-film", [
    sceneOf("S01", "Your clients, in one place.", "slow_push_in", ["asset_00000001"], img("asset_00000001")),
    sceneOf("S02", "See every conversation", "pan_right", ["asset_00000002"], img("asset_00000002")),
    sceneOf("S03", null, "pull_out", ["asset_00000003"], img("asset_00000003")),
    sceneOf("S04", "Book a demo today", "static", [], gfx),
  ], [
    use(1, "S01", "slow-push-in-hyperframes", { scale_end: 1.15 }), use(2, "S01", "text-fade-up-hyperframes", { delay_s: 0.6, duration_s: 0.6, distance_px: 24 }),
    use(3, "S02", "pan-reframe-hyperframes", { direction: "right", distance_pct: 8 }), use(4, "S02", "text-word-stagger-hyperframes"),
    use(5, "S03", "pull-out-reveal-hyperframes", { scale_start: 1.25 }), use(6, "S04", "end-card-cta-hyperframes", { hold_s: 2, background: "brand" }),
  ], assets, 16);
}, 240_000);

const adapterFrom = (reg: LoadedRegistry) => new AdapterRegistry([createHyperframesAdapter({ fontFile: font!, outputRoot, workRoot, learned: reg.composed("hyperframes") })]);
const repoRegistry = () => loadCapabilityRegistry(join(repoRoot, "capabilities"), { recipes: library });
const planFor = (r: Run, reg: LoadedRegistry, s: unknown = SETTINGS, purpose: "preview" | "production" = "preview") => {
  const x = planRender({ editor_output: r.output, handoff: r.handoff, settings: s, purpose }, { recipes: r.recipes, adapters: adapterFrom(reg), capabilities: reg, outputRoot });
  if (!x.ok) throw new Error(`rejected: ${x.reasons.join("; ")}`);
  return x;
};

describe("the HyperFrames capabilities this project has validated are stored and usable", () => {
  it.skipIf(skipReal(can))("the registry holds a validated record for each HyperFrames template, with real render evidence, and all are usable on this machine", () => {
    const reg = repoRegistry();
    expect(reg.problems).toEqual([]);
    const usable = reg.usable.filter((r) => r.engine === "hyperframes").map((r) => r.capability_id).sort();
    expect(usable, JSON.stringify(reg.records.filter((r) => r.engine === "hyperframes").map((r) => [r.capability_id, r.status, r.attempts.at(-1)?.reasons]))).toEqual(HYPERFRAMES_ENTRIES.map((e) => `hyperframes:${e.recipe_id}`).sort());
    for (const r of reg.usable.filter((x) => x.engine === "hyperframes")) {
      expect(r.validated!.renders.every((x) => x.bytes > 1000 && /^[a-f0-9]{64}$/.test(x.sha256) && x.width === 640 && x.fps === 30)).toBe(true);
      expect(r.validated!.browser).toMatch(/hyperframes 0\.8\./);
      expect(r.validated!.checks.length).toBeGreaterThanOrEqual(3);
      expect(r.known_limitations.length).toBeGreaterThan(0);
      expect(r.combinations.not_validated.length).toBeGreaterThan(0);
    }
    console.log("HYPERFRAMES CAPABILITIES", JSON.stringify(reg.usable.filter((x) => x.engine === "hyperframes").map((r) => [r.capability_id, r.validated!.renders.length, r.validated!.checks.length, r.validated!.browser])));
  });

  it("the evidence is current: every record was validated against the code that draws the scenes as it is now", () => {
    for (const r of repoRegistry().usable.filter((x) => x.engine === "hyperframes")) expect(r.validated!.browser, r.capability_id).toContain(`scenes ${implementationHash("hyperframes")}`);
  });

  it("each catalog entry matches its recipe: same template, version and a compatible engine; the recipes are unchanged drafts", () => {
    for (const e of HYPERFRAMES_ENTRIES) {
      const r = library.get(e.recipe_id)!;
      expect(r.implementation_ref).toBe(e.template);
      expect(r.version).toBe(e.recipe_version);
      expect(r.compatibility.renderers).toContain("hyperframes");
      expect(r.status).toBe("draft");
      expect(r.operation_type).toBe(e.operation_type);
    }
  });
});

describe.skipIf(skipReal(can))("approved layered scenes render through HyperFrames, visibly, at the approved times", () => {
  let rec: Awaited<ReturnType<typeof executeRender>>;
  const SCENE = 120; // frames per scene

  it("the plan is executable: every operation has a validated HyperFrames capability, the camera motions and delayed caption are carried out, and the recipes stay draft", () => {
    const x = planFor(film, repoRegistry());
    expect(x.record.state, x.record.blockers.join("; ")).toBe("executable");
    expect(x.record.operations.map((o) => [o.operation_id, o.recipe_id, o.renderer])).toEqual([
      ["E01", "slow-push-in-hyperframes", "hyperframes"], ["E02", "text-fade-up-hyperframes", "hyperframes"], ["E03", "pan-reframe-hyperframes", "hyperframes"], ["E04", "text-word-stagger-hyperframes", "hyperframes"], ["E05", "pull-out-reveal-hyperframes", "hyperframes"], ["E06", "end-card-cta-hyperframes", "hyperframes"],
    ]);
    expect(x.diagnosis.every((d) => d.status === "validated_available" && d.selected_engine === "hyperframes")).toBe(true);
    const cov = previewCoverage(film.handoff, film.output, x.record, selectRenderer(x.record, adapterFrom(repoRegistry())).capabilities);
    expect(cov.scenes.map((s) => [s.scene_id, s.represented, s.missing])).toEqual([["S01", true, []], ["S02", true, []], ["S03", true, []], ["S04", true, []]]);
    expect(x.record.operations.every((o) => !o.production_executable)).toBe(true);
    expect(planFor(film, repoRegistry(), SETTINGS, "production").record.state).toBe("planning");
  });

  it("renders a real 16 second film: metadata, QA and the adapter's own content check pass", async () => {
    rec = await executeRender(planFor(film, repoRegistry()).plan!);
    expect(rec.state, JSON.stringify(rec.errors)).toBe("rendered");
    expect(rec.output).toMatchObject({ container: "mp4", width: 640, height: 360, fps: 30, duration_s: 16, video_codec: "h264", audio_codec: null, audio_tracks: 0 });
    expect(rec.notes.join(" ")).toMatch(/hyperframes rendered in /);
    expect(rec.notes.join(" ")).toContain("Composed scenes were checked on their last frame");
    const qa = await runRenderQa(rec, film.handoff);
    expect(qa.findings.filter((f) => f.severity !== "info"), JSON.stringify(qa.findings)).toEqual([]);
    console.log("HYPERFRAMES LAYERED FILM", JSON.stringify({ ...rec.output, path: "<tmp>" }));
    if (proofDir) { mkdirSync(proofDir, { recursive: true }); copyFileSync(rec.output!.path, join(proofDir, "hyperframes-layered-film.mp4")); }
  });

  const frame = (n: number) => rawFrame(rec.output!.path, n, 640, 360, "ffmpeg");
  const mad = (a: Buffer, b: Buffer) => { let d = 0, n = 0; for (let i = 0; i < a.length; i += 12) { d += Math.abs(a[i]! - b[i]!); n++; } return d / n; };
  const band = (b: Buffer, y: number) => inkIn(b, 640, 360, y * 360 - 40, y * 360 + 40);

  it("camera movements are visible: the picture of each camera scene is not the same at the start and the end", async () => {
    for (const [i, name] of [[0, "slow push in"], [1, "pan right"], [2, "pull out"]] as const) {
      const d = mad(await frame(i * SCENE + 1), await frame(i * SCENE + SCENE - 1));
      expect(d, `${name}: the first and last frames differ by ${d.toFixed(1)}`).toBeGreaterThan(4);
    }
  });

  it("the delayed caption respects its approved timing: nothing before 0.6 s, the text complete after the entrance, rising into place", async () => {
    const finalInk = band(await frame(SCENE - 1), 0.84);
    expect(finalInk.count).toBeGreaterThan(200);
    expect(band(await frame(15), 0.84).count).toBeLessThan(0.03 * finalInk.count); // frame 15 is 0.5 s, before the 0.6 s delay
    expect(band(await frame(18 + 19), 0.84).count).toBeGreaterThan(0.85 * finalInk.count); // the 0.6 s entrance has finished
    const mid = band(await frame(18 + 6), 0.84);
    expect(mid.cy - finalInk.cy).toBeGreaterThan(24 * 0.15); // it is still lower than its final place a little into the entrance
  });

  it("the word stagger shows the words one after another, and the end card is a card with its approved text", async () => {
    const s2 = SCENE, final = band(await frame(s2 + SCENE - 1), 0.84).count;
    const early = band(await frame(s2 + 6), 0.84).count, later = band(await frame(s2 + 14), 0.84).count;
    expect(final).toBeGreaterThan(200);
    expect(early).toBeLessThan(0.7 * final);
    expect(later).toBeGreaterThan(early);
    const card = await frame(3 * SCENE + SCENE - 1);
    expect([card[0], card[1], card[2]].every((v, i) => Math.abs(v! - [22, 33, 62][i]!) < 16)).toBe(true); // the brand card
    expect(inkIn(card, 640, 360, 0.45 * 360 - 50, 0.45 * 360 + 50).count).toBeGreaterThan(300);
  });

  it("scene order and boundaries are exact: each scene's first frame is that scene, the last frame of the previous one is the previous scene", async () => {
    for (const s of [1, 2, 3]) expect(mad(await frame(s * SCENE - 1), await frame(s * SCENE))).toBeGreaterThan(15); // a hard cut between different pictures
    expect(mad(await frame(SCENE - 1), await frame(SCENE - 2))).toBeLessThan(6); // and no cut inside a scene
  });
});

describe.skipIf(skipReal(can))("what HyperFrames cannot do is refused before rendering, naming the scene and operation", () => {
  const job = () => { const x = planFor(film, repoRegistry()); return { plan: x.plan!, job: structuredClone(x.plan!.job), adapter: x.plan!.adapter }; };
  const issues = (mutate: (j: ReturnType<typeof job>["job"]) => void) => { const t = job(); mutate(t.job); return t.adapter.check!(t.job).join(" | "); };

  it.each([
    ["an end card in the same scene as a camera move", (j: ReturnType<typeof job>["job"]) => { j.operations.find((o) => o.operation_id === "E06")!.target_scene_id = "S01"; }, "scene S01: an end card combined with a camera move is not a validated combination"],
    ["two text animations in one scene", (j: ReturnType<typeof job>["job"]) => { j.operations.find((o) => o.operation_id === "E04")!.target_scene_id = "S01"; }, "scene S01: it has 2 text animations (E02, E04)"],
    ["a caption that does not start at the approved delay", (j: ReturnType<typeof job>["job"]) => { j.operations.find((o) => o.operation_id === "E02")!.caption!.start_s = 0; }, "operation E02: its caption is timed 0s to 4s but the approved delay puts the text at 0.6s to 4s"],
    ["a pan direction outside the list", (j: ReturnType<typeof job>["job"]) => { j.operations.find((o) => o.operation_id === "E03")!.parameters["direction"] = "diagonal"; }, "operation E03: direction must be one of left, right, up, down"],
    ["a zoom outside its range", (j: ReturnType<typeof job>["job"]) => { j.operations.find((o) => o.operation_id === "E01")!.parameters["scale_end"] = 3; }, "operation E01: scale_end must be a number from 1.03 to 1.25"],
    ["an unknown parameter", (j: ReturnType<typeof job>["job"]) => { j.operations.find((o) => o.operation_id === "E05")!.parameters["spin"] = 1; }, "operation E05: unknown parameter spin"],
    ["a video instead of an image", (j: ReturnType<typeof job>["job"]) => { j.assets[0]!.media_type = "video"; }, "only an image can be moved here, and nothing is substituted for it"],
    ["an image the renderer was not given", (j: ReturnType<typeof job>["job"]) => { j.assets = j.assets.slice(1); }, "was not supplied to the renderer"],
    ["text that does not fit", (j: ReturnType<typeof job>["job"]) => { const o = j.operations.find((x) => x.operation_id === "E06")!; o.caption = { text: "word ".repeat(23).trim(), start_s: 12, end_s: 16 }; j.settings.width = 360; j.settings.height = 640; }, "does not fit in"],
    ["an audio cue", (j: ReturnType<typeof job>["job"]) => { j.operations.find((o) => o.operation_id === "E01")!.audio_cues = ["whoosh"]; }, "audio cues cannot be produced"],
    ["a gap in the timeline", (j: ReturnType<typeof job>["job"]) => { for (const o of j.operations.filter((x) => x.target_scene_id === "S02")) o.timing.start_s += 0.5; }, "gaps and overlaps are not rendered"],
    ["a plain scene template next to composed ones", (j: ReturnType<typeof job>["job"]) => { j.templates["E06"] = "hyperframes/text-slide"; }, "plain scenes cannot be combined with composed scenes in one film yet"],
  ])("refuses %s", (_name, mutate, expected) => { expect(issues(mutate)).toContain(expected); });

  it("without the validated capability the operation is not usable, the gap is named, and nothing else is substituted", () => {
    const partial = join(tmp, "partial"); mkdirSync(join(registryDir(partial), "hyperframes"), { recursive: true });
    for (const f of readdirSync(join(registryDir(join(repoRoot, "capabilities")), "hyperframes"))) if (f !== "hyperframes__text-fade-up.json") copyFileSync(join(registryDir(join(repoRoot, "capabilities")), "hyperframes", f), join(registryDir(partial), "hyperframes", f));
    const reg = loadCapabilityRegistry(partial, { recipes: library });
    const x = planFor(film, reg);
    expect(x.record.state).toBe("planning");
    const d = x.diagnosis.find((o) => o.recipe_id === "text-fade-up-hyperframes")!;
    expect(d).toMatchObject({ status: "learning_required", scene_id: "S01", selected_engine: null });
    expect(d.engines.find((e) => e.engine === "hyperframes")).toMatchObject({ verdict: "learnable" });
    expect(x.diagnosis.filter((o) => o.status === "validated_available").map((o) => o.recipe_id).sort()).toEqual(["end-card-cta-hyperframes", "pan-reframe-hyperframes", "pull-out-reveal-hyperframes", "slow-push-in-hyperframes", "text-word-stagger-hyperframes"]);
    expect(x.record.blockers.join("\n")).toContain("E02: no template is registered for hyperframes/text-fade-up");
  });
});

describe.skipIf(skipReal(can))("learning a HyperFrames capability: recorded, persisted across a restart, and failures stay unsupported", () => {
  const capRoot = join(tmp, "caps");
  it("learns one for real, records the browser and HyperFrames version, and a separate process finds it usable", async () => {
    const r = await learnCapability("hyperframes/pull-out-reveal", { root: capRoot, fontFile: font!, workRoot, recipes: library });
    expect(r.status, JSON.stringify(r)).toBe("learned");
    if (r.status !== "learned") return;
    expect(r.record.validated!.browser).toMatch(/hyperframes 0\.8\./);
    expect(r.record.validated!.checks.join("\n")).toMatch(/the picture shrinks by/);
    expect(existsSync(capabilityFile(capRoot, "hyperframes", "hyperframes/pull-out-reveal"))).toBe(true);
    const script = join(tmp, "restart-hyperframes.mts");
    writeFileSync(script, `import { loadCapabilityRegistry } from "${new URL("./index.ts", import.meta.url).href}";
const l = loadCapabilityRegistry(process.argv[2]);
console.log(JSON.stringify({ usable: l.usable.map((r) => [r.capability_id, r.record_hash]), problems: l.problems, composed: l.composed("hyperframes").map((t) => [t.template, t.family, t.type, t.motion]) }));
`);
    const out = JSON.parse(execFileSync(process.execPath, [join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), script, capRoot], { encoding: "utf8" }).trim().split(/\r?\n/).at(-1)!);
    expect(out.problems).toEqual([]);
    expect(out.usable).toEqual([["hyperframes:pull-out-reveal-hyperframes", r.record.record_hash]]);
    expect(out.composed).toEqual([["hyperframes/pull-out-reveal", "camera_move", "trim_clip", "zoom_out"]]);
    // an FFmpeg-engine view of the same store never sees it
    expect(loadCapabilityRegistry(capRoot, { engine: "ffmpeg" }).composed("hyperframes")).toEqual([]);
  });

  it("an entry whose implementation does not do what it claims fails, is recorded as failed, is never used, and is not retried while nothing changes", async () => {
    const bad: CatalogEntry = { ...(HYPERFRAMES_ENTRIES.find((e) => e.recipe_id === "slow-push-in-hyperframes") as CatalogEntry), motion: "teleport" };
    const root2 = join(tmp, "caps-bad");
    const first = await learnCapability("hyperframes/slow-push-in", { root: root2, fontFile: font!, workRoot, catalog: [bad] });
    expect(first.status).toBe("unsupported");
    expect(first.status === "unsupported" && first.reasons.join(" ")).toMatch(/refuses the validation film/);
    const reg = loadCapabilityRegistry(root2, { catalog: [bad] });
    expect(reg.usable).toEqual([]);
    expect(reg.get("hyperframes", "slow-push-in-hyperframes")).toMatchObject({ status: "validation_failed", validated: null });
    const again = await learnCapability("hyperframes/slow-push-in", { root: root2, fontFile: font!, workRoot, catalog: [bad] });
    expect(again).toMatchObject({ status: "unsupported", retry_skipped: true });
  });

  it("the recipe files are untouched by learning", () => {
    for (const e of HYPERFRAMES_ENTRIES) expect(JSON.parse(readFileSync(join(repoRoot, "recipes", library.get(e.recipe_id)!.type, `${e.recipe_id}.json`), "utf8")).status).toBe("draft");
    void rawFrame;
  });
});
