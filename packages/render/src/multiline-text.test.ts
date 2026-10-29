import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Project } from "@digikon/contracts";
import { ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, runEditor, type DirectorStateType } from "@digikon/director";
import { cfg, deps, knowledge, root } from "../../director/src/fixtures.js";
import { AdapterRegistry, createFfmpegAdapter, createHyperframesAdapter, createRemotionAdapter, executeRender, findChrome, findRemotionBrowser, loadCapabilityRegistry, planRender } from "./index.js";
import { hasInvalidControl, normaliseText, wrapText } from "./text.js";
import { realPrerequisites, skipReal } from "./test-env.js";

vi.setConfig({ testTimeout: 300_000 });

// The two copy lines the Director approved for S03 and S04 of the failing run. Both contain a line feed, which every adapter used to refuse as a "control character".
const S03_TEXT = "Learn at your pace.\nFast day? Slow day? Your call.";
const S04_TEXT = "Learn at your pace.\nFind out more.";

describe("scene text at the renderer boundary", () => {
  it("keeps a line feed as a line break, and normalises Windows and old Mac line endings to it", () => {
    expect(hasInvalidControl(normaliseText(S03_TEXT))).toBe(false);
    expect(hasInvalidControl(normaliseText(S04_TEXT))).toBe(false);
    expect(normaliseText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
  it("rejects every other control character: NUL, bell, tab, escape, DEL", () => {
    for (const bad of ["a\u0000b", "a\u0007b", "a\tb", "a\u001bb", "a\u007fb", "line one\n\u0008line two"]) expect(hasInvalidControl(normaliseText(bad)), JSON.stringify(bad)).toBe(true);
  });
  it("preserves Unicode and punctuation exactly", () => {
    const t = "Café “smart” — 学习 🚀 50% off! (really?) it's #1 & more";
    expect(hasInvalidControl(normaliseText(t))).toBe(false);
    expect(normaliseText(t)).toBe(t);
    expect(wrapText(t, 200)).toEqual([t]);
  });
  it("starts a new line at every approved break and wraps each line on its own", () => {
    expect(wrapText(S04_TEXT, 40)).toEqual(["Learn at your pace.", "Find out more."]);
    expect(wrapText(S03_TEXT, 25)).toEqual(["Learn at your pace.", "Fast day? Slow day? Your", "call."]);
    expect(wrapText("one two three", 40)).toEqual(["one two three"]); // text without breaks wraps exactly as before
  });
});

const FONTS = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];
const font = FONTS.find((f) => existsSync(f));
const chrome = findChrome(), remotionBrowser = findRemotionBrowser();
const can = !!font && !!chrome && !!remotionBrowser;
realPrerequisites({ font: !!font, "a Chrome for HyperFrames": !!chrome, "a 64-bit Edge or Chrome for Remotion": !!remotionBrowser });
const tmp = mkdtempSync(join(tmpdir(), "multiline-test-"));
const outputRoot = join(tmp, "out"), workRoot = join(tmp, "work");
mkdirSync(outputRoot); mkdirSync(workRoot);
const proofDir = process.env["RENDER_PROOF_DIR"];
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ready = { status: "ready", questions: [] };
const gfx = [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }];
const scene = (id: string, text: string) => ({ scene_id: id, purpose: "p", duration_seconds: 3, asset_ids: [], required_assets: gfx, transition_out: "cut", shot: { shot_size: "wide", camera_motion: "static", visual_action: "Text on a plain background" }, overlay: { text, safe_area: "platform_safe" } });
const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, number | string> = {}) => ({ use_id: `U${String(n).padStart(2, "0")}`, scene_id, recipe_id, params, rationale: "fits the beat" });
const SETTINGS = { aspect_ratio: "16:9", width: 640, height: 360, fps: 30, duration_s: 3, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test fixture values, not a platform specification" } };

async function directed(id: string, text: string, recipe: string) {
  const d = deps(new ScriptedClient([ready, { logline: "A short, clear film", hook: "The opening line", tone: "friendly", beats: [{ beat: "Beat 1", purpose: "p", approx_seconds: 3 }], cta: "Learn more", claims: [] }, { scenes: [scene("S01", text)] }, { uses: [use(1, "S01", recipe)] }]));
  const graph = buildDirectorGraph(d);
  const project = Project.parse({ project_id: id, owner_id: "u1", brief: "A short test film.", objective: "Inform the audience", audience: "General", platform: "YouTube", aspect_ratio: "16:9", target_duration: 3 });
  const g1 = await graph.invoke({ project, assets: [], facts: [] }, cfg(id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(id))) as DirectorStateType;
  const handoff = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: id, model: "scripted" });
  const run = await runEditor(handoff, { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever });
  if (!run.ok) throw new Error(`editor rejected: ${run.reasons.join("; ")}`);
  return { handoff, output: run.output, recipes: d.recipes };
}
type Run = Awaited<ReturnType<typeof directed>>;
// the learned capabilities are the ones stored in the repository's registry: end-card-cta is one of them, and is only usable while its evidence matches the code
const registry = () => loadCapabilityRegistry(join(root(""), "capabilities"));
type Renderer = "remotion" | "hyperframes" | "ffmpeg";
const adapterOf = (r: Renderer) => r === "remotion" ? createRemotionAdapter({ fontFile: font!, outputRoot, workRoot, learned: registry().composed("remotion") }) : r === "hyperframes" ? createHyperframesAdapter({ fontFile: font!, outputRoot, workRoot, learned: registry().composed("hyperframes") }) : createFfmpegAdapter({ fontFile: font!, outputRoot, workRoot });
const planFor = (r: Run, which: Renderer) => planRender({ editor_output: r.output, handoff: r.handoff, settings: SETTINGS, purpose: "preview" },{ recipes: r.recipes, adapters: new AdapterRegistry([adapterOf(which)]), outputRoot });

/** Rows of the frame (top to bottom) that contain bright text pixels, grouped into bands: one band per drawn line of text. */
const textBands = (video: string, n: number, w: number, h: number) => {
  const b = execFileSync("ffmpeg", ["-v", "error", "-i", video, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 25 });
  const rows: boolean[] = [];
  for (let y = 0; y < h; y++) { let hit = false; for (let x = 0; x < w && !hit; x++) { const i = (y * w + x) * 3; if (b[i]! > 215 && b[i + 1]! > 215 && b[i + 2]! > 215) hit = true; } rows.push(hit); }
  const bands: [number, number][] = [];
  rows.forEach((r, y) => { if (r) { const last = bands[bands.length - 1]; if (last && y - last[1] <= 3) last[1] = y; else bands.push([y, y]); } });
  return bands;
};
const keep = (video: string, name: string) => { if (proofDir) { mkdirSync(proofDir, { recursive: true }); copyFileSync(video, join(proofDir, name)); } };

const CASES = [
  { name: "E05: text-slide-remotion with the approved S03 copy", engine: "remotion" as const, recipe: "text-slide-remotion", text: S03_TEXT, minLines: 2 },
  { name: "E07: end-card-cta with the approved S04 copy", engine: "remotion" as const, recipe: "end-card-cta", text: S04_TEXT, minLines: 2 },
  { name: "HyperFrames text scene with a line break", engine: "hyperframes" as const, recipe: "text-fade-hyperframes", text: S04_TEXT, minLines: 2 },
  { name: "FFmpeg text card with a line break", engine: "ffmpeg" as const, recipe: "text-card-fade", text: S04_TEXT, minLines: 2 },
];
const runs = new Map<string, Run>();
beforeAll(async () => { for (const c of CASES) runs.set(c.name, await directed(`ml-${runs.size}`, c.text, c.recipe)); }, 180_000);

describe.skipIf(skipReal(can))("multi-line approved text is planned and really rendered, on every engine", () => {
  for (const c of CASES) {
    it(`${c.name}: planned without a control-character issue, drawn on separate lines`, async () => {
      const r = runs.get(c.name)!;
      const p = planFor(r, c.engine);
      if (!p.ok) throw new Error(p.reasons.join("; "));
      expect(p.record.blockers.join(" ")).not.toContain("control characters");
      expect(p.record.state, p.record.blockers.join("; ")).toBe("executable");
      const rec = await executeRender(p.plan!);
      expect(rec.state, JSON.stringify(rec.errors ?? rec.blockers)).toBe("rendered");
      const out = rec.output!;
      expect([out.width, out.height, out.fps, out.duration_s]).toEqual([640, 360, 30, 3]);
      keep(out.path, `multiline-${c.engine}-${c.recipe}.mp4`);
      expect(textBands(out.path, 75, 640, 360).length, "separate lines of text in the final frame").toBeGreaterThanOrEqual(c.minLines);
      // the text is the approved text, so the render still hashes the same operation: nothing was rewritten on the way
      expect(r.output.operations[0]!.caption!.text).toBe(c.text);
    });
  }

  it("a NUL, bell or tab in the text is still refused, by every engine, before anything is rendered", () => {
    for (const c of CASES) {
      const p = planFor(runs.get(c.name)!, c.engine);
      if (!p.ok || !p.plan) throw new Error(`${c.name}: no plan`);
      for (const bad of ["Learn\u0000 at your pace", "Learn\u0007 at your pace", "Learn\tat your pace"]) {
        const job = structuredClone(p.plan.job);
        job.operations[0]!.caption = { text: bad, start_s: 0, end_s: 3 };
        const issues = adapterOf(c.engine).check!(job);
        expect(issues.join(" "), `${c.name} ${JSON.stringify(bad)}`).toContain("text contains control characters");
      }
      const ok = structuredClone(p.plan.job);
      ok.operations[0]!.caption = { text: "Line one\r\nLine two", start_s: 0, end_s: 3 }; // Windows line endings are normalised, not refused
      expect(adapterOf(c.engine).check!(ok).join(" "), c.name).not.toContain("control characters");
    }
  });
});
