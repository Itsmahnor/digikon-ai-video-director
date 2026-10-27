import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Asset, Project, type DirectorHandoff } from "@digikon/contracts";
import { ScriptedClient, SkillLibrary, approveCurrent, buildDirectorGraph, buildHandoff, runEditor, type DirectorStateType } from "@digikon/director";
import { probeFile } from "@digikon/media";
import { cfg, deps, knowledge, root } from "../../director/src/fixtures.js";
import {
  AdapterRegistry, HYPERFRAMES_TEMPLATES, REMOTION_GPU_MEMORY_FLAG, createHyperframesAdapter, createRemotionAdapter, executeRender, findChrome, findRemotionBrowser, inspectBrowser,
  planRender, planWebScenes, previewCoverage, selectRemotionBrowser, selectRemotionBrowserFrom, verifySceneFidelity, type ExecutablePlan, type RenderAdapter, type RenderJob,
} from "./index.js";
import { realPrerequisites, skipReal } from "./test-env.js";

vi.setConfig({ testTimeout: 300_000 });
const FONTS = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];
const font = FONTS.find((f) => existsSync(f));
const chrome = findChrome(), remotionBrowser = findRemotionBrowser();
const can = !!font && !!chrome && !!remotionBrowser;
realPrerequisites({ font: !!font, "a Chrome for HyperFrames": !!chrome, "a 64-bit Edge or Chrome for Remotion": !!remotionBrowser });
const tmp = mkdtempSync(join(tmpdir(), "hardening-"));
const outputRoot = join(tmp, "out"), workRoot = join(tmp, "work");
mkdirSync(outputRoot); mkdirSync(workRoot);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "ignore" });

// ================= 1. browser selection =================
/** A file with a real Windows executable header and nothing else: enough for the word size to be read. */
const fakeExe = (name: string, machine: number) => {
  const b = Buffer.alloc(4096);
  b.write("MZ", 0, "latin1"); b.writeUInt32LE(0x80, 0x3c); b.write("PE\0\0", 0x80, "latin1"); b.writeUInt16LE(machine, 0x84);
  const f = join(tmp, name); writeFileSync(f, b); return f;
};
const fakeElf = (name: string, cls: 1 | 2) => { const b = Buffer.alloc(64); b.write("\x7fELF", 0, "latin1"); b[4] = cls; const f = join(tmp, name); writeFileSync(f, b); return f; };

describe("browser selection for Remotion", () => {
  it("reads the word size from the executable header and accepts only a 64-bit browser", () => {
    expect(inspectBrowser(fakeExe("x64.exe", 0x8664))).toMatchObject({ bits: "64-bit", compatible: true });
    expect(inspectBrowser(fakeExe("arm64.exe", 0xaa64))).toMatchObject({ bits: "64-bit", compatible: true });
    const x86 = inspectBrowser(fakeExe("x86.exe", 0x14c));
    expect(x86).toMatchObject({ bits: "32-bit", compatible: false });
    expect(x86.reason).toContain(REMOTION_GPU_MEMORY_FLAG);
    expect(inspectBrowser(fakeElf("elf64", 2))).toMatchObject({ bits: "64-bit", compatible: true });
    expect(inspectBrowser(fakeElf("elf32", 1))).toMatchObject({ bits: "32-bit", compatible: false });
  });

  it("refuses what it cannot read: a missing file, a folder, an unknown processor, a broken header", () => {
    expect(inspectBrowser(join(tmp, "nothing.exe")).compatible).toBe(false);
    expect(inspectBrowser(tmp).compatible).toBe(false);
    expect(inspectBrowser(fakeExe("weird.exe", 0x1c0))).toMatchObject({ compatible: false });
    const broken = join(tmp, "broken.exe"); const b = Buffer.alloc(4096); b.write("MZ", 0, "latin1"); b.writeUInt32LE(0x80, 0x3c); writeFileSync(broken, b);
    expect(inspectBrowser(broken)).toMatchObject({ compatible: false, reason: "its Windows header cannot be read" });
  });

  it("never picks a 32-bit browser, even when it is named explicitly, and says why it passed over it", () => {
    const x86 = fakeExe("explicit32.exe", 0x14c), x64 = fakeExe("explicit64.exe", 0x8664);
    const choice = selectRemotionBrowserFrom([x86, x64]);
    expect(choice.path).toBe(x64);
    expect(choice.inspected.map((i) => [i.path, i.compatible])).toEqual([[x86, false], [x64, true]]);
    expect(choice.inspected[0]!.reason).toContain("32-bit");
    expect(selectRemotionBrowserFrom([x86])).toMatchObject({ path: null, bits: null });
    expect(selectRemotionBrowser(x86).path).not.toBe(x86);
    expect(selectRemotionBrowser(x64).path).toBe(x64); // a compatible explicit choice comes first
    expect(findRemotionBrowser(x86)).not.toBe(x86);
  });

  it("the adapter refuses to start when only 32-bit browsers are offered, instead of downloading one", () => {
    expect(() => createRemotionAdapter({ fontFile: font ?? process.execPath.replace(/\.exe$/, ".ttf"), outputRoot, browserCandidates: [fakeExe("only32.exe", 0x14c)] })).toThrow(/no compatible browser is installed for Remotion.*32-bit/);
  });

  const installed = [process.env["ProgramFiles(x86)"], process.env["ProgramFiles"], process.env["LOCALAPPDATA"]].flatMap((r) => (r ? [join(r, "Google", "Chrome", "Application", "chrome.exe")] : [])).filter(existsSync);
  const chrome32 = installed.find((p) => inspectBrowser(p).bits === "32-bit");
  const edge = [process.env["ProgramFiles(x86)"], process.env["ProgramFiles"]].flatMap((r) => (r ? [join(r, "Microsoft", "Edge", "Application", "msedge.exe")] : [])).find(existsSync);

  it.skipIf(!edge)("prefers an installed Edge, and it is the browser chosen on this machine when Chrome is 32-bit", () => {
    const c = selectRemotionBrowser();
    expect(c.path).toBe(edge);
    expect(c.bits).toBe("64-bit");
    console.log("REMOTION BROWSER CHOICE", JSON.stringify(c));
  });

  // The known defect itself, kept as a regression test. It needs the defective browser, so it is skipped (visibly) where there is none.
  it.skipIf(!chrome32)("the known defect: Remotion's hard-coded GPU memory flag makes this 32-bit Chrome paint no children", () => {
    const html = join(tmp, "defect.html");
    writeFileSync(html, '<html><body style="margin:0"><div style="position:absolute;inset:0;background:#00ff00"><div style="position:absolute;left:0;top:0;width:100px;height:100px;background:#ff0000"></div></div></body></html>');
    const paint = (extra: string[]) => {
      const png = join(tmp, `defect-${extra.length}.png`), bin = `${png}.bin`;
      execFileSync(chrome32!, ["--headless=new", "--no-sandbox", `--user-data-dir=${join(tmp, `ud-${extra.length}`)}`, "--window-size=200,200", `--screenshot=${png}`, ...extra, `file:///${html.replaceAll("\\", "/")}`], { stdio: "ignore", timeout: 60_000 });
      ff("-i", png, "-vf", "crop=2:2:20:20,format=rgb24", "-frames:v", "1", "-f", "rawvideo", bin);
      const b = execFileSync("ffmpeg", ["-v", "error", "-i", png, "-vf", "crop=2:2:20:20,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 1 << 16 });
      return [b[0], b[1], b[2]];
    };
    expect(paint([])).toEqual([255, 0, 0]); // the child (red) is painted without the flag
    expect(paint([REMOTION_GPU_MEMORY_FLAG])).toEqual([0, 255, 0]); // with it only the parent (green) is
    expect(inspectBrowser(chrome32!).compatible).toBe(false); // which is why this browser is refused
  });

  describe.skipIf(!chrome32 || skipReal(can))("second line of defence: a blank render is caught even when the browser check is bypassed", () => {
    it("rendering in the 32-bit Chrome on purpose fails with the missing content named, and leaves no file", async () => {
      const adapter = createRemotionAdapter({ fontFile: font!, outputRoot, workRoot, chromePath: chrome32!, unsafeAllowIncompatibleBrowser: true });
      const rr = await filmT("remotion");
      const y = planRender({ editor_output: rr.output, handoff: rr.handoff, settings: T_SETTINGS, purpose: "preview" }, { recipes: rr.recipes, adapters: new AdapterRegistry([adapter]), outputRoot });
      if (!y.ok || !y.plan) throw new Error("not executable");
      const rec = await executeRender(y.plan);
      expect(rec.state).toBe("failed");
      expect(rec.output).toBeNull();
      expect(rec.errors.map((e) => e.message).join(" ")).toMatch(/missing approved content: E01: the scene shows only its background/);
      expect(existsSync(y.plan.job.output_path)).toBe(false);
    });
  });
});

// ================= approved-plan builders =================
interface SceneIn { id: string; dur: number; text?: string; camera?: string; transition?: string; assets?: string[]; required?: unknown[]; voiceover?: string }
const gfx = [{ need: "Animated graphics", kind: "graphics", availability: "generate_graphics" }];
const scene = (s: SceneIn) => ({
  scene_id: s.id, purpose: "p", duration_seconds: s.dur, asset_ids: s.assets ?? [], required_assets: s.required ?? gfx, transition_out: s.transition ?? "cut",
  shot: { shot_size: "wide", camera_motion: s.camera ?? "static", visual_action: "Text and shapes on a plain background" },
  ...(s.text ? { overlay: { text: s.text, safe_area: "platform_safe" } } : {}), ...(s.voiceover ? { voiceover: s.voiceover } : {}),
});
const use = (n: number, scene_id: string, recipe_id: string, params: Record<string, number | string> = {}) => ({ use_id: `U${String(n).padStart(2, "0")}`, scene_id, recipe_id, params, rationale: "fits the beat" });
const treatment = (beats: number[]) => ({ logline: "A short, clear film", hook: "The opening line", tone: "friendly", beats: beats.map((s, i) => ({ beat: `Beat ${i + 1}`, purpose: "p", approx_seconds: s })), cta: "Learn more", claims: [] });
const project = (id: string, aspect: "16:9" | "9:16", seconds: number) => Project.parse({ project_id: id, owner_id: "u1", brief: "A short test film.", objective: "Inform the audience", audience: "General", platform: aspect === "16:9" ? "YouTube" : "Instagram", aspect_ratio: aspect, target_duration: seconds });
const ready = { status: "ready", questions: [] };
async function directed(id: string, p: ReturnType<typeof project>, beats: number[], scenes: unknown[], uses: unknown[], assets: Asset[] = []) {
  const d = deps(new ScriptedClient([ready, treatment(beats), { scenes }, { uses }]));
  const graph = buildDirectorGraph(d);
  const input = { project: p, assets, facts: [] };
  const g1 = await graph.invoke(input, cfg(id));
  const g2 = await graph.invoke(approveCurrent(g1), cfg(id));
  const done = (await graph.invoke(approveCurrent(g2), cfg(id))) as DirectorStateType;
  const handoff = buildHandoff(done, { recipes: d.recipes, skills: new SkillLibrary(root("skills")), knowledge, run_id: id, model: "scripted" });
  const run = await runEditor(handoff, { recipes: d.recipes, skills: new SkillLibrary(root("skills/editor")), retriever: d.retriever });
  if (!run.ok) throw new Error(`editor rejected: ${run.reasons.join("; ")}`);
  return { handoff, output: run.output, recipes: d.recipes };
}
type Run = Awaited<ReturnType<typeof directed>>;
const settings = (w: number, h: number, duration: number, aspect: "16:9" | "9:16") => ({ aspect_ratio: aspect, width: w, height: h, fps: 30, duration_s: duration, container: "mp4", video_codec: "h264", audio_codec: null, source: { kind: "user_approved", reference: "test fixture values, not a platform specification" } });
const T_SETTINGS = settings(640, 360, 9, "16:9"), I_SETTINGS = settings(360, 640, 10, "9:16");
const filmT = (which: "hyperframes" | "remotion" = "hyperframes") => {
  const rc = which === "remotion" ? "text-slide-remotion" : "text-fade-hyperframes";
  return directed(`h-t-${which}`, project(`ht${which}`, "16:9", 9), [3, 3, 3], [scene({ id: "S01", dur: 3, text: "Meet Lumen" }), scene({ id: "S02", dur: 3, text: "Plan your week in one place" }), scene({ id: "S03", dur: 3, text: "Start today" })],
    [use(1, "S01", rc), use(2, "S02", rc, { background: "charcoal", accent: "teal", fade_in_s: 1 }), use(3, "S03", rc, { background: "forest", accent: "coral" })]);
};
const hfRegistry = () => new AdapterRegistry([createHyperframesAdapter({ fontFile: font!, outputRoot, workRoot })]);
const planWith = (r: Run, s: unknown, adapters: AdapterRegistry, purpose: "preview" | "production" = "preview") => {
  const x = planRender({ editor_output: r.output, handoff: r.handoff, settings: s, purpose }, { recipes: r.recipes, adapters, outputRoot });
  if (!x.ok) throw new Error(`rejected: ${x.reasons.join("; ")}`);
  return x;
};

// ================= 2. coverage inside the renderer =================
describe.skipIf(skipReal(can))("the planner itself refuses what the approved plan asks for and the renderer cannot do", () => {
  it("camera motion on a plain text scene is a blocker naming the scene, not a silent static scene", async () => {
    const r = await directed("h-cam", project("hcam", "16:9", 4), [4], [scene({ id: "S01", dur: 4, text: "Hello there", camera: "slow_push_in" })], [use(1, "S01", "text-fade-hyperframes")]);
    const x = planWith(r, settings(640, 360, 4, "16:9"), hfRegistry());
    expect(x.record.state).toBe("planning");
    expect(x.plan).toBeNull();
    expect(x.record.blockers.join("\n")).toContain("S01: the approved shot calls for camera motion (slow push in), but no renderer here has a camera-move template, so the scene would be shown static");
  });

  it("an approved transition no registered renderer carries out is a blocker, not a hard cut", async () => {
    const r = await directed("h-tr", project("htr", "16:9", 6), [3, 3], [scene({ id: "S01", dur: 3, text: "One", transition: "crossfade" }), scene({ id: "S02", dur: 3, text: "Two" })],
      [use(1, "S01", "text-fade-hyperframes"), use(2, "S01", "crossfade", { duration_s: 0.5 }), use(3, "S02", "text-fade-hyperframes")]);
    const x = planWith(r, settings(640, 360, 6, "16:9"), hfRegistry());
    expect(x.record.state).toBe("planning");
    expect(x.plan).toBeNull();
    const text = x.record.blockers.join("\n");
    expect(text).toContain("E02: no template is registered for ffmpeg/xfade-fade");
    expect(text).toContain("S01: its crossfade transition is not rendered (a hard cut would be used)");
  });

  it("a plan that is fully covered records, as notes, the approved details no renderer changes or checks", async () => {
    const r = await filmT();
    const x = planWith(r, T_SETTINGS, hfRegistry());
    expect(x.record.state).toBe("executable");
    expect(x.record.notes.join("\n")).toContain("S01: text is centred and kept inside the middle 84% of the frame width; the approved platform safe area setting is not checked against any platform specification");
    expect(x.record.notes.join("\n")).toContain('S01: the approved shot size (wide) and visual action ("Text and shapes on a plain background") describe the content; the renderer does not change or check them');
  });

  // A stand-in for a renderer, to test the planner and executeRender without a browser: it writes a real video of the approved size.
  const makeVideo = (path: string) => ff("-f", "lavfi", "-i", "color=c=blue:s=640x360:d=4:r=30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path);
  let calls = 0;
  const spy: RenderAdapter = { renderer: "remotion", templates: { "remotion/text-fade-up": ["overlay_text"] }, render: async (job) => { calls++; makeVideo(job.output_path); } };
  const fakeRun = (params: Record<string, number | string>) => directed(`h-fake-${JSON.stringify(params)}`, project("hfake", "16:9", 4), [4], [scene({ id: "S01", dur: 4, text: "Hello there" })], [use(1, "S01", "text-fade-up", params)]);
  const FAKE_SETTINGS = settings(640, 360, 4, "16:9");

  it("caption timing: an approved delayed caption is a blocker, because every renderer shows text from the first frame of the scene", async () => {
    const delayed = planWith(await fakeRun({ delay_s: 0.5 }), FAKE_SETTINGS, new AdapterRegistry([spy]));
    expect(delayed.record.state).toBe("planning");
    expect(delayed.record.blockers.join("\n")).toContain("S01: E01: its text is timed 0.5s to 4s, but the renderer shows text for the whole scene (0s to 4s) and has no caption timing");
    const plain = planWith(await fakeRun({ delay_s: 0 }), FAKE_SETTINGS, new AdapterRegistry([spy]));
    expect(plain.record.state).toBe("executable");
  });

  it("executeRender refuses on its own: blockers, a template the adapter cannot run, a coverage gap added after planning; the adapter is never started", async () => {
    const good = planWith(await fakeRun({ delay_s: 0 }), FAKE_SETTINGS, new AdapterRegistry([spy])).plan as ExecutablePlan;
    const base = calls;
    // 1. a plan that carries a blocker
    const blocked = { ...good, record: { ...good.record, blockers: ["S01: something approved is not carried out"] } } as ExecutablePlan;
    const r1 = await executeRender(blocked);
    expect(r1.state).toBe("failed");
    expect(r1.errors[0]).toMatchObject({ stage: "precheck", message: "S01: something approved is not carried out" });
    // 2. a job changed after planning to name a template the adapter does not implement
    const job = structuredClone(good.job); job.templates["E01"] = "remotion/not-built";
    const r2 = await executeRender({ ...good, job });
    expect(r2.state).toBe("failed");
    expect(r2.errors.map((e) => e.message).join(" ")).toContain("remotion/not-built does not implement overlay_text operations on the remotion renderer");
    // 3. an approved requirement the renderer does not carry out, found by executeRender itself from the handoff it was given
    const handoff = structuredClone(good.handoff) as DirectorHandoff; handoff.storyboard.scenes[0]!.shot.camera_motion = "pan_left";
    const r3 = await executeRender({ ...good, handoff });
    expect(r3.state).toBe("failed");
    expect(r3.errors.map((e) => e.message).join(" ")).toContain("S01: the approved shot calls for camera motion (pan left)");
    // 4. a record that plans the operations for another renderer than the adapter that was chosen
    const r4 = await executeRender({ ...good, record: { ...good.record, operations: good.record.operations.map((o) => ({ ...o, renderer: "ffmpeg" as const })) } });
    expect(r4.state).toBe("failed");
    expect(calls).toBe(base); // none of the refusals started the adapter
    for (const rec of [r1, r2, r3, r4]) { expect(rec.output).toBeNull(); expect(existsSync(good.job.output_path)).toBe(false); }
    // and the same plan, untouched, does run
    const ok = await executeRender(good);
    expect(ok.state, JSON.stringify(ok.errors)).toBe("rendered");
    expect(calls).toBe(base + 1);
  });

  it("the console's check and the planner's are the same check", async () => {
    const r = await directed("h-same", project("hsame", "16:9", 4), [4], [scene({ id: "S01", dur: 4, text: "Hello there", camera: "pull_out" })], [use(1, "S01", "text-fade-hyperframes")]);
    const x = planWith(r, settings(640, 360, 4, "16:9"), hfRegistry());
    const cov = previewCoverage(r.handoff, r.output, x.record, { image_templates: [], video_templates: [], transition_templates: {} });
    for (const s of cov.scenes) for (const m of s.missing) expect(x.record.blockers).toContain(`${s.scene_id}: ${m}`);
    expect(cov.complete).toBe(false);
  });
});

// ================= 3. content verification against real renders =================
describe.skipIf(skipReal(can))("scene-content verification on real HyperFrames renders", () => {
  let tFilm: { path: string; scenes: ReturnType<typeof scenesOf>; settings: typeof T_SETTINGS; notes: string[] };
  let iFilm: { path: string; scenes: ReturnType<typeof scenesOf>; settings: typeof I_SETTINGS; photo: string; screen: string; other: string };
  const scenesOf = (job: Omit<RenderJob, "signal">) => { const p = planWebScenes(job, { renderer: "hyperframes", templates: HYPERFRAMES_TEMPLATES, outputRoot }); if (!p.ok) throw new Error(p.issues.join("; ")); return p.scenes; };
  const verify = (path: string, scenes: unknown[], s: { width: number; height: number }) => verifySceneFidelity(path, scenes as never, s.width, s.height, { fontFile: font!, workRoot });

  beforeAll(async () => {
    const t = await filmT();
    const tp = planWith(t, T_SETTINGS, hfRegistry()).plan!;
    const trec = await executeRender(tp);
    if (trec.state !== "rendered") throw new Error(`text film failed: ${JSON.stringify(trec.errors)}`);
    tFilm = { path: trec.output!.path, scenes: scenesOf(tp.job), settings: T_SETTINGS, notes: trec.notes };

    // images with real structure, so identity can be checked by layout and not only by colour
    const photo = join(tmp, "photo.png"), screen = join(tmp, "screen.png"), other = join(tmp, "other.png");
    ff("-f", "lavfi", "-i", "testsrc2=s=1280x720:d=1:r=1", "-frames:v", "1", photo);
    ff("-f", "lavfi", "-i", "testsrc=s=1280x720:d=1:r=1", "-frames:v", "1", screen);
    ff("-f", "lavfi", "-i", "mandelbrot=s=1280x720:r=1", "-frames:v", "1", other);
    const ph = await probeFile(photo, { assetId: "asset_0a1b2c3d" }), sc = await probeFile(screen, { assetId: "asset_1a2b3c4d" });
    if (!ph.ok || !sc.ok) throw new Error("test image rejected");
    const rc = "image-caption-hyperframes";
    const i = await directed("h-img", project("himg", "9:16", 10), [3, 4, 3], [
      scene({ id: "S01", dur: 3, text: "Riverside jazz" }),
      scene({ id: "S02", dur: 4, text: "Live on the terrace", assets: ["asset_0a1b2c3d"], required: [{ need: "Venue photo", kind: "image", availability: "supplied", asset_id: "asset_0a1b2c3d" }] }),
      scene({ id: "S03", dur: 3, text: "An illustration of the idea", assets: ["asset_1a2b3c4d"], required: [{ need: "Dashboard screen", kind: "ui_screenshot", availability: "supplied", asset_id: "asset_1a2b3c4d" }] }),
    ], [use(1, "S01", "text-fade-hyperframes"), use(2, "S02", rc, { fit: "cover", motion: "slow_zoom", fade_in_s: 0.6 }), use(3, "S03", rc)], [ph.asset, Asset.parse({ ...sc.asset, genuine_product_ui: false })]);
    const ip = planWith(i, I_SETTINGS, hfRegistry()).plan!;
    const irec = await executeRender(ip);
    if (irec.state !== "rendered") throw new Error(`image film failed: ${JSON.stringify(irec.errors)}`);
    iFilm = { path: irec.output!.path, scenes: scenesOf(ip.job), settings: I_SETTINGS, photo, screen, other };
  }, 300_000);

  const S = { t: { width: 640, height: 360 }, i: { width: 360, height: 640 } };

  it("a render record carries what the render could and could not establish", () => {
    expect(tFilm.notes.join("\n")).toMatch(/hyperframes rendered in /);
    expect(tFilm.notes.join("\n")).toContain("not read by OCR");
    expect(tFilm.notes.join("\n")).toContain("could pass");
  });

  it("passes the approved films, with limitations stated", async () => {
    const a = await verify(tFilm.path, tFilm.scenes, S.t);
    expect(a.problems).toEqual([]);
    expect(a.limitations.length).toBeGreaterThanOrEqual(4);
    const b = await verify(iFilm.path, iFilm.scenes, S.i);
    expect(b.problems).toEqual([]);
    expect(b.limitations.join(" ")).toContain("smaller than 28 px");
  });

  it("rejects the wrong text in the right scene: different words, too short, too long", async () => {
    for (const [scene, text] of [[0, "Plan Weeks"], [0, "Hi"], [1, "Make your day in one place!"], [2, "Learn more"], [1, "Plan your week in one place, every week, again"]] as const) {
      const scenes = structuredClone(tFilm.scenes);
      scenes[scene]!.text = text; scenes[scene]!.lines = [text];
      const r = await verify(tFilm.path, scenes, S.t);
      expect(r.problems.join(" "), `${scene}: ${text}`).toContain(`E0${scene + 1}: the text`);
    }
  });

  it("rejects the right text in the wrong scene: scenes swapped", async () => {
    const scenes = structuredClone(tFilm.scenes);
    [scenes[0]!.text, scenes[2]!.text] = [scenes[2]!.text, scenes[0]!.text];
    [scenes[0]!.lines, scenes[2]!.lines] = [[scenes[0]!.text], [scenes[2]!.text]];
    const r = await verify(tFilm.path, scenes, S.t);
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it("rejects the wrong colours: a background or an accent bar that is not the approved one", async () => {
    const a = structuredClone(tFilm.scenes); a[0]!.background = "#fb7185";
    expect((await verify(tFilm.path, a, S.t)).problems.join(" ")).toContain("E01: the scene's background colour is not #fb7185");
    const b = structuredClone(tFilm.scenes); b[1]!.accent = "#f5b942";
    expect((await verify(tFilm.path, b, S.t)).problems.join(" ")).toContain("E02: the scene's accent bar (#f5b942) is missing");
  });

  it("rejects a scene that is blank, and a film shorter than the plan", async () => {
    const blank = join(tmp, "blank.mp4");
    ff("-f", "lavfi", "-i", "color=c=0x16213e:s=640x360:d=9:r=30", "-pix_fmt", "yuv420p", blank);
    const r = await verify(blank, tFilm.scenes, S.t);
    expect(r.problems.filter((p) => p.includes("shows only its background")).length).toBe(3);
    const short = join(tmp, "short.mp4");
    ff("-i", tFilm.path, "-t", "4", "-c", "copy", short);
    expect((await verify(short, tFilm.scenes, S.t)).problems.join(" ")).toMatch(/E02: .*(missing|could not be read)/);
  });

  it("checks the supplied image: the right one passes, another picture or a flipped one does not", async () => {
    const wrongFile = structuredClone(iFilm.scenes); wrongFile[1]!.image!.uri = iFilm.other;
    expect((await verify(iFilm.path, wrongFile, S.i)).problems.join(" ")).toMatch(/E02: the image on screen (is not|does not have)/);
    const swapped = structuredClone(iFilm.scenes); swapped[1]!.image!.uri = iFilm.screen; // a different test pattern with a similar palette
    expect((await verify(iFilm.path, swapped, S.i)).problems.join(" ")).toMatch(/E02: the image on screen/);
    const flipped = join(tmp, "flipped.png"); ff("-i", iFilm.photo, "-vf", "hflip", flipped);
    const f = structuredClone(iFilm.scenes); f[1]!.image!.uri = flipped;
    expect((await verify(iFilm.path, f, S.i)).problems.join(" ")).toMatch(/E02: the image on screen/);
  });

  it("checks the concept label: required but not shown fails, and the fit and zoom must match the approved ones", async () => {
    const needsLabel = structuredClone(iFilm.scenes); needsLabel[1]!.image!.concept = true; // the photo scene was rendered without one
    expect((await verify(iFilm.path, needsLabel, S.i)).problems.join(" ")).toContain('E02: the "Concept illustration" label required for asset_0a1b2c3d is not on screen');
    const wrongFit = structuredClone(iFilm.scenes); wrongFit[2]!.image!.fit = "cover"; // rendered with contain
    expect((await verify(iFilm.path, wrongFit, S.i)).problems.join(" ")).toMatch(/E03: the image on screen/);
    const wrongCaption = structuredClone(iFilm.scenes); wrongCaption[1]!.text = "x"; wrongCaption[1]!.lines = ["x"];
    expect((await verify(iFilm.path, wrongCaption, S.i)).problems.join(" ")).toContain("E02: the text");
  });
});
