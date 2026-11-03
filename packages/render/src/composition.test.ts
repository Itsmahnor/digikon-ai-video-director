import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EditorOperation } from "@digikon/contracts";
import { createRemotionAdapter } from "./remotion.js";
import { COMPOSITION_TEMPLATE, areas, fitFont, planCompositionScenes } from "./composition.js";
import { EXAMPLE_ART_DIRECTION, EXAMPLE_VISUALS } from "./composition-examples.js";
import { measureFrames, verifyCompositionScenes } from "./composition-verify.js";
import { findRemotionBrowser } from "./browser.js";
import { realPrerequisites, skipReal } from "./test-env.js";
import { rawFrame } from "./verify.js";
import type { RenderJob } from "./adapter.js";

const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
const can = !!font && !!findRemotionBrowser();
realPrerequisites({ font: !!font, remotion_browser: !!findRemotionBrowser() });

const tmp = mkdtempSync(join(tmpdir(), "composition-test-"));
const outputRoot = join(tmp, "out");
mkdirSync(outputRoot);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Job = Omit<RenderJob, "signal">;
const BLOCKS = Object.keys(EXAMPLE_VISUALS) as (keyof typeof EXAMPLE_VISUALS)[];
const SCENE_S = 3;
const rid = () => `rn_${Math.random().toString(16).slice(2).padEnd(16, "0").slice(0, 16)}`;
const op = (i: number, over: Partial<EditorOperation> = {}): EditorOperation => ({ operation_id: `E${i + 1}`, target_scene_id: `S${String(i + 1).padStart(2, "0")}`, operation_type: "render_graphics_scene", parameters: {}, timing: { start_s: i * SCENE_S, duration_s: SCENE_S }, asset_ids: [], audio_cues: [], caption: null, ...over } as EditorOperation);
function film(w: number, h: number, blocks: readonly (keyof typeof EXAMPLE_VISUALS)[] = BLOCKS, tweak: (job: Job) => void = () => {}): Job {
  const id = rid();
  const job: Job = {
    render_id: id, settings: { aspect_ratio: w > h ? "16:9" : "9:16", width: w, height: h, fps: 30, duration_s: blocks.length * SCENE_S, container: "mp4", video_codec: "h264", audio_codec: null, source: { type: "user_approved", reference: "test" } } as never,
    operations: blocks.map((_b, i) => op(i)), templates: Object.fromEntries(blocks.map((_b, i) => [`E${i + 1}`, COMPOSITION_TEMPLATE])), assets: [], clips: [], asset_info: {}, concept_asset_ids: [],
    scene_visuals: Object.fromEntries(blocks.map((b, i) => [`S${String(i + 1).padStart(2, "0")}`, { visual: structuredClone(EXAMPLE_VISUALS[b].visual), overlay_text: EXAMPLE_VISUALS[b].overlay_text, visual_purpose: b }])), art_direction: EXAMPLE_ART_DIRECTION,
    output_path: join(outputRoot, `${id}.mp4`),
  };
  tweak(job);
  return job;
}
const issues = (j: Job) => { const p = planCompositionScenes(j, { outputRoot }); return p.ok ? [] : p.issues; };

describe("planning a drawn scene", () => {
  it("accepts every example block at a wide and at a tall frame size", () => {
    for (const [w, h] of [[1280, 720], [720, 1280], [1080, 1080], [640, 360]] as const) expect(issues(film(w, h)).join("; "), `${w}x${h}`).toBe("");
  });
  it("plans the scenes back to back with their own frames, palette and sizes", () => {
    const p = planCompositionScenes(film(960, 540), { outputRoot });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.scenes.map((s) => s.from_frame)).toEqual(BLOCKS.map((_b, i) => i * SCENE_S * 30));
    expect(p.total_frames).toBe(BLOCKS.length * SCENE_S * 30);
    expect(p.scenes[0]!.palette.accent).toBe("#b8430a");
    expect(p.scenes[0]!.portrait).toBe(false);
  });
  it("lays text out from the short side, so a portrait frame gets legible type and a headline above the picture", () => {
    const wide = planCompositionScenes(film(1280, 720, ["process_flow"]), { outputRoot });
    const tall = planCompositionScenes(film(720, 1280, ["process_flow"]), { outputRoot });
    if (!wide.ok || !tall.ok) throw new Error("plans should be ok");
    expect(tall.scenes[0]!.sizes.body).toBeGreaterThanOrEqual(Math.round(720 * 0.034));
    expect(wide.scenes[0]!.headline!.box.x).toBeLessThan(wide.scenes[0]!.content.x); // a column beside the picture
    expect(tall.scenes[0]!.headline!.box.y).toBeLessThan(tall.scenes[0]!.content.y); // above it
    const a = areas(720, 1280, true), b = areas(1280, 720, true);
    expect(a.headline!.w).toBeGreaterThan(b.headline!.w);
  });
  it("shrinks type to fit before refusing, and refuses only when text could not be read at the smallest size", () => {
    expect(fitFont(["A fairly long message that wraps"], 600, 60, 20, 2)).toBeLessThan(60);
    expect(fitFont(["x".repeat(200)], 100, 60, 30, 2)).toBeNull();
  });
  it("refuses what it cannot draw as approved, naming the scene", () => {
    expect(issues(film(960, 540, ["kinetic_type"], (j) => { delete j.scene_visuals; })).join(" ")).toMatch(/no approved visual spec/);
    expect(issues(film(960, 540, ["kinetic_type"], (j) => { j.scene_visuals!["S01"]!.overlay_text = null; })).join(" ")).toMatch(/overlay text/);
    expect(issues(film(960, 540, ["end_card"], (j) => { (j.scene_visuals!["S01"]!.visual as { block: string }).block = "hologram"; })).join(" ")).toMatch(/not valid/);
    expect(issues(film(960, 540, ["end_card"], (j) => { j.operations[0]!.parameters = { speed: 2 }; })).join(" ")).toMatch(/takes no parameters/);
    expect(issues(film(960, 540, ["end_card"], (j) => { j.operations[0]!.audio_cues = ["whoosh"]; })).join(" ")).toMatch(/audio cues/);
    expect(issues(film(960, 540, ["end_card"], (j) => { j.templates["E1"] = "remotion/text-slide"; })).join(" ")).toMatch(/cannot be combined/);
    expect(issues(film(960, 540, ["end_card"], (j) => { j.settings = { ...j.settings, audio_codec: "aac" } as never; })).join(" ")).toMatch(/no audio/);
    expect(issues(film(960, 540, ["end_card"], (j) => { j.output_path = join(tmp, "elsewhere.mp4"); })).join(" ")).toMatch(/output path/);
    expect(issues(film(960, 540, ["end_card"], (j) => { j.operations[0]!.timing.start_s = 1; })).join(" ")).toMatch(/gaps and overlaps/);
    expect(issues(film(960, 540, ["end_card"], (j) => { j.art_direction = { ...EXAMPLE_ART_DIRECTION, palette: { ...EXAMPLE_ART_DIRECTION.palette, text: "#eeeeee" } }; })).join(" ")).toMatch(/art direction is not valid/);
  });
});

describe("measuring frames", () => {
  const p = planCompositionScenes(film(160, 90, ["end_card"]), { outputRoot });
  const sc = p.ok ? p.scenes[0]! : (() => { throw new Error("plan"); })();
  const solid = (c: [number, number, number]) => { const b = Buffer.alloc(160 * 90 * 3); for (let i = 0; i < b.length; i += 3) { b[i] = c[0]; b[i + 1] = c[1]; b[i + 2] = c[2]; } return b; };
  it("sees an empty, unmoving scene as empty and unmoving", () => {
    const bg = solid([0xf6, 0xf2, 0xea]);
    const m = measureFrames([bg, bg, bg], sc);
    expect(m.coverage).toBe(0);
    expect(m.motion).toBe(0);
    expect(m.edge_ink).toBe(0);
  });
  it("sees content on the frame edge", () => {
    const bg = solid([0xf6, 0xf2, 0xea]);
    const edge = Buffer.from(bg);
    for (let y = 0; y < 90; y++) for (let x = 0; x < 3; x++) { const i = (y * 160 + x) * 3; edge[i] = 0; edge[i + 1] = 0; edge[i + 2] = 0; }
    expect(measureFrames([bg, edge], sc).edge_ink).toBeGreaterThan(0.01);
  });
});

describe.skipIf(skipReal(can))("real renders of every block, wide and tall", () => {
  const rendered = new Map<string, Promise<{ path: string; job: Job; notes: string[] }>>();
  const render = (w: number, h: number) => {
    const k = `${w}x${h}`;
    if (!rendered.has(k)) rendered.set(k, (async () => {
      const job = film(w, h);
      const adapter = createRemotionAdapter({ fontFile: font!, outputRoot, workRoot: tmp });
      expect(adapter.check!(job).join("; ")).toBe("");
      const r = await adapter.render({ ...job, signal: new AbortController().signal });
      return { path: job.output_path, job, notes: (r && typeof r === "object" ? r.notes : []) ?? [] };
    })());
    return rendered.get(k)!;
  };
  for (const [w, h] of [[960, 540], [540, 960]] as const) {
    it(`${w}x${h}: all ${BLOCKS.length} blocks render, pass their own frame checks, and the film has the planned size and length`, async () => {
      const { path, job, notes } = await render(w, h);
      expect(notes.join(" ")).toContain("remotion rendered");
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames,r_frame_rate", "-of", "json", path], { encoding: "utf8" })).streams[0];
      expect([probe.width, probe.height, Number(probe.nb_read_frames)]).toEqual([w, h, BLOCKS.length * SCENE_S * 30]);
      const plan = planCompositionScenes(job, { outputRoot });
      if (!plan.ok) throw new Error("plan");
      const checked = await verifyCompositionScenes(path, plan.scenes, w, h, { fontFile: font! });
      expect(checked.problems).toEqual([]);
      expect(checked.measures).toHaveLength(BLOCKS.length);
      for (const m of checked.measures) { expect(m.motion).toBeGreaterThan(0.4); expect(m.coverage).toBeGreaterThan(0.008); expect(m.coverage).toBeLessThan(0.88); }
    }, 300_000);

    it(`${w}x${h}: scenes look different from each other (no two last frames share a layout)`, async () => {
      const { path, job } = await render(w, h);
      const plan = planCompositionScenes(job, { outputRoot });
      if (!plan.ok) throw new Error("plan");
      const sigs = await Promise.all(plan.scenes.map(async (s) => measureFrames([await rawFrame(path, s.from_frame + s.frames - 1, w, h, "ffmpeg")], s).signature));
      for (let i = 0; i < sigs.length; i++) for (let j = i + 1; j < sigs.length; j++) {
        const d = sigs[i]!.reduce((a, v, k) => a + Math.abs(v - sigs[j]![k]!), 0) / sigs[i]!.length;
        const sparse = (b: string | undefined) => b === "route_map" || b === "timeline_path"; // both are a thin line with labels, so they differ less in coarse brightness cells than in what they show
        expect(d, `${BLOCKS[i]} vs ${BLOCKS[j]}`).toBeGreaterThan(sparse(BLOCKS[i]) && sparse(BLOCKS[j]) ? 3 : 4);
      }
    }, 300_000);

    it(`${w}x${h}: the verifier catches a film that is not what was planned (wrong background, blank frames)`, async () => {
      const { path, job } = await render(w, h);
      const plan = planCompositionScenes(job, { outputRoot });
      if (!plan.ok) throw new Error("plan");
      const wrong = plan.scenes.map((s) => ({ ...s, palette: { ...s.palette, background: "#102a43" } }));
      const r1 = await verifyCompositionScenes(path, wrong, w, h, { fontFile: font! });
      expect(r1.problems.join(" ")).toMatch(/approved background colour/);
      const blank = join(tmp, `blank-${w}.mp4`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0xf6f2ea:s=${w}x${h}:r=30:d=${BLOCKS.length * SCENE_S}`, "-pix_fmt", "yuv420p", "-c:v", "libx264", blank]);
      const r2 = await verifyCompositionScenes(blank, plan.scenes, w, h, { fontFile: font! });
      expect(r2.problems.join(" ")).toMatch(/almost nothing is drawn/);
      expect(r2.problems.join(" ")).toMatch(/hardly moves/);
    }, 300_000);
  }
});
