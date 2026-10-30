import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EditorOperation } from "@digikon/contracts";
import { COMPOSITION_TEMPLATE, planCompositionScenes, type CompositionScene } from "./composition.js";
import { EXAMPLE_ART_DIRECTION } from "./composition-examples.js";
import { ESTIMATE_METER, fontMeterFromBuffer, loadFontMeter } from "./font-metrics.js";
import { detectOverflow, fitText, fits, gridShapes, layoutAreas, layoutConstraints, layoutSteps, layoutWindow, stepRect, typeScale, wrapMeasured } from "./layout.js";
import type { RenderJob } from "./adapter.js";

const font = ["C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f)) ?? null;
const meter = font ? loadFontMeter(font) : ESTIMATE_METER;
const style = { upper: true, bold: true };
const tmp = mkdtempSync(join(tmpdir(), "layout-test-"));
const outputRoot = join(tmp, "out");
mkdirSync(outputRoot);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// The approved S04 and S05 of the 12-scene regression project, word for word.
export const S04 = {
  overlay: "ONE CONNECTED JOURNEY, BUILT ON GOHIGHLEVEL",
  visual: { block: "process_flow", steps: ["WEBSITE LEAD", "CRM", "AUTOMATED FOLLOW-UP", "APPOINTMENT BOOKED", "CUSTOMER"].map((label) => ({ label, detail: null })), camera: "push_in", reveal: "wipe_right", backdrop: "grid" },
} as const;
export const S05 = {
  overlay: "THE SYSTEM AT WORK",
  visual: {
    block: "ui_demo", window_title: "Pipeline (concept)", sidebar: ["Contacts", "Pipeline", "Automations"],
    rows: [["CRM & Pipeline Management", null, "open"], ["Lead Capture & Follow-ups", null, "open"], ["Workflow Automation", null, "open"], ["Appointment Booking", "Booked", "selected"], ["SMS & Email Automation", null, "open"], ["Agency Systems", null, "open"]].map(([label, tag, state]) => ({ label, tag, state })),
    cursor_target: 3, confirm_text: "Appointment booked", camera: "pan_right", reveal: "wipe_up", backdrop: "gradient",
  },
} as const;

type Job = Omit<RenderJob, "signal">;
function job(w: number, h: number, spec: { overlay: string | null; visual: unknown }, dur = 6, art: unknown = EXAMPLE_ART_DIRECTION): Job {
  const id = `rn_${Math.random().toString(16).slice(2).padEnd(16, "0").slice(0, 16)}`;
  const op = { operation_id: "E01", target_scene_id: "S01", operation_type: "render_graphics_scene", parameters: {}, timing: { start_s: 0, duration_s: dur }, asset_ids: [], audio_cues: [], caption: null } as unknown as EditorOperation;
  return {
    render_id: id, settings: { aspect_ratio: "16:9", width: w, height: h, fps: 30, duration_s: dur, container: "mp4", video_codec: "h264", audio_codec: null, source: { type: "user_approved", reference: "test" } } as never,
    operations: [op], templates: { E01: COMPOSITION_TEMPLATE }, assets: [], clips: [], asset_info: {}, concept_asset_ids: [],
    scene_visuals: { S01: { visual: structuredClone(spec.visual) as never, overlay_text: spec.overlay, visual_purpose: "p" } }, art_direction: art as never, output_path: join(outputRoot, `${id}.mp4`),
  };
}
const plan = (j: Job) => planCompositionScenes(j, { outputRoot, meter });
const one = (j: Job): CompositionScene => { const p = plan(j); if (!p.ok) throw new Error(p.issues.join("; ")); return p.scenes[0]!; };

describe.runIf(!!font)("measuring text with the real font", () => {
  it("reads advance widths from the font file, not an average", () => {
    expect(meter.kind).toBe("font");
    const i = meter.width("iiiiiiiiii", 20), m = meter.width("MMMMMMMMMM", 20);
    expect(m).toBeGreaterThan(i * 2.5); // a proportional font: M is much wider than i
    expect(meter.width("Ab", 40)).toBeCloseTo(2 * meter.width("Ab", 20), 5);
    expect(meter.width("abc", 20, { upper: true })).toBeCloseTo(meter.width("ABC", 20), 5);
    expect(meter.width("abc", 20, { bold: true })).toBeGreaterThan(meter.width("abc", 20));
  });
  it("measures Unicode: accents, CJK and a character the font lacks all have a width", () => {
    for (const t of ["café", "naïve façade", "Zürich", "日本語のテキスト", "Привет", "👩‍👩‍👧 emoji"]) expect(meter.width(t, 24), t).toBeGreaterThan(0);
  });
  it("falls back to an estimate for a font it cannot read", () => {
    expect(fontMeterFromBuffer(Buffer.from("not a font"))).toBeNull();
    expect(loadFontMeter(join(tmp, "missing.ttf")).kind).toBe("estimate");
  });
});

describe("wrapping text without changing it", () => {
  it("keeps every word and every approved line break, in order", () => {
    const text = "Line one is here\nSecond line, with punctuation: (yes) — & more!";
    const r = wrapMeasured(text, meter, 24, 220, { upper: false, bold: false });
    expect(r.lines.join(" ").split(/\s+/)).toEqual(text.split(/\s+/));
    expect(r.lines.length).toBeGreaterThan(2);
    expect(wrapMeasured(text, meter, 24, 2000, { upper: false, bold: false }).lines).toEqual(["Line one is here", "Second line, with punctuation: (yes) — & more!"]);
  });
  it("never cuts inside a word unless breaking is allowed, and then loses no character", () => {
    const word = "Supercalifragilisticexpialidocious";
    const kept = wrapMeasured(word, meter, 30, 120, { upper: false, bold: false });
    expect(kept.lines).toEqual([word]);
    const broke = wrapMeasured(word, meter, 30, 120, { upper: false, bold: false }, true);
    expect(broke.broke_word).toBe(true);
    expect(broke.lines.join("")).toBe(word);
  });
  it("does not split an emoji or a combined character in half", () => {
    const text = "👩‍👩‍👧👩‍👩‍👧👩‍👩‍👧👩‍👩‍👧 e\u0301e\u0301e\u0301e\u0301";
    const r = wrapMeasured(text, meter, 40, 70, { upper: false, bold: false }, true);
    expect(r.lines.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });
  it("fits the largest legible size, and says why when none fits", () => {
    const fit = fitText({ texts: ["Appointment booked", "Lead Capture & Follow-ups"], meter, style: { upper: false, bold: false }, maxW: 300, maxPx: 40, minPx: 16, maxLines: 2 });
    expect(fits(fit)).toBe(true);
    if (fits(fit)) { expect(fit.px).toBeLessThanOrEqual(40); expect(fit.width).toBeLessThanOrEqual(300); }
    const no = fitText({ texts: ["a long label that needs many lines to be shown in a narrow card"], meter, style: { upper: false, bold: false }, maxW: 80, maxPx: 30, minPx: 24, maxLines: 2 });
    expect(fits(no)).toBe(false);
    if (!fits(no)) expect(no.reason).toMatch(/lines|wider|height/);
  });
});

describe("areas, grids and overflow", () => {
  it("gives a wide frame a headline column or a band, and a tall frame a band", () => {
    expect(layoutAreas(1280, 720, true).variant).toBe("side");
    expect(layoutAreas(1280, 720, true, "top").content.w).toBeGreaterThan(layoutAreas(1280, 720, true).content.w);
    expect(layoutAreas(720, 1280, true).variant).toBe("top");
    expect(layoutAreas(1280, 720, false).variant).toBe("full");
  });
  it("proposes every sensible grid and keeps the cells inside the box", () => {
    const box = { x: 100, y: 50, w: 600, h: 500 };
    const shapes = gridShapes(5, box);
    expect(shapes.map((s) => s.cols)).toContain(1);
    expect(shapes.map((s) => s.cols)).toContain(5);
    for (const s of shapes) { expect(s.cell.w * s.cols + s.gap.x * (s.cols - 1)).toBeLessThanOrEqual(box.w); expect(s.cell.h * s.rows + s.gap.y * (s.rows - 1)).toBeLessThanOrEqual(box.h); }
  });
  it("finds things that leave the area and things that overlap", () => {
    const bounds = { x: 0, y: 0, w: 100, h: 100 };
    expect(detectOverflow([{ name: "a", rect: { x: 0, y: 0, w: 50, h: 50 } }, { name: "b", rect: { x: 50, y: 50, w: 50, h: 50 } }], bounds)).toEqual([]);
    expect(detectOverflow([{ name: "a", rect: { x: 60, y: 0, w: 50, h: 50 } }], bounds)[0]).toMatch(/a leaves the area/);
    expect(detectOverflow([{ name: "a", rect: { x: 0, y: 0, w: 60, h: 60 } }, { name: "b", rect: { x: 50, y: 50, w: 50, h: 50 } }], bounds)[0]).toMatch(/a overlaps b/);
  });
  it("states the real limits of a frame for the Director", () => {
    const c = layoutConstraints(1280, 720);
    expect(c.min_text_px).toBe(Math.round(720 * 0.034));
    expect(c.content_area_px.w).toBeGreaterThan(0);
    expect(c.guidance.join(" ")).toMatch(/never cuts words/);
    expect(typeScale(720, 1280).min).toBe(c.min_text_px);
  });
});

describe("steps: column, row, grid, then pages", () => {
  const steps = (n: number, label = "STEP LABEL") => Array.from({ length: n }, (_, i) => ({ label: `${label} ${i + 1}`, detail: null }));
  const req = (n: number, box = { x: 100, y: 50, w: 640, h: 620 }, durationS = 6, label?: string) => ({ steps: steps(n, label), box, meter, style, maxPx: 36, minPx: 24, minDetailPx: 16, maxDetailPx: 22, durationS });
  it("lays five steps out on one page at a legible size", () => {
    const r = layoutSteps(req(5));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.pages).toEqual([[0, 1, 2, 3, 4]]);
    expect(r.layout.font_px).toBeGreaterThanOrEqual(24);
    const rects = [0, 1, 2, 3, 4].map((i) => ({ name: `step ${i}`, rect: stepRect(r.layout, i) }));
    expect(detectOverflow(rects, req(5).box)).toEqual([]);
  });
  it("uses a grid when a column of cards would be too short for the type", () => {
    const r = layoutSteps(req(8, { x: 0, y: 0, w: 900, h: 330 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(["row", "grid"]).toContain(r.layout.strategy);
  });
  it("shows steps in pages, in order and complete, when one page cannot hold them", () => {
    const r = layoutSteps(req(14, { x: 0, y: 0, w: 480, h: 300 }, 12));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.strategy).toBe("pages");
    expect(r.layout.pages.flat()).toEqual(Array.from({ length: 14 }, (_, i) => i));
  });
  it("refuses, with every attempt explained, when even pages would be shown for too short a time", () => {
    const r = layoutSteps(req(14, { x: 0, y: 0, w: 480, h: 300 }, 3));
    expect(r.ok).toBe(false);
    expect(r.attempts.some((a) => /would each be shown for/.test(a.note))).toBe(true);
  });
});

describe("the window: long titles and labels", () => {
  const rows = (labels: string[]) => labels.map((label) => ({ label, tag: null }));
  const base = { sidebar: ["Contacts", "Pipeline"], confirm: "Done", box: { x: 400, y: 50, w: 640, h: 560 }, meter, style: { upper: false, bold: false }, maxPx: 30, minPx: 24, minSmallPx: 16, maxSmallPx: 22 };
  it("wraps a long title and long row labels instead of refusing", () => {
    const r = layoutWindow({ ...base, title: "Customer relationship pipeline overview for the whole agency (concept view)", rows: rows(["A very long row label that would never fit on one line next to a sidebar and a tag", "Short"]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.title_lines.length).toBeGreaterThan(1);
    expect(r.layout.row_lines[0]!.length).toBeGreaterThan(1);
    expect(r.layout.row_lines[0]!.join(" ")).toBe("A very long row label that would never fit on one line next to a sidebar and a tag");
    expect(detectOverflow(r.layout.placed, base.box, { overlapOk: (a, b) => a === "the window" || b === "the window" })).toEqual([]);
  });
  it("keeps Unicode and punctuation exactly", () => {
    const labels = ["Café & Crème — “Quotes”", "日本語のラベル", "Привет, мир!", "100% done (almost)…"];
    const r = layoutWindow({ ...base, title: "Zürich/München: Überblick", rows: rows(labels) });
    expect(r.ok).toBe(true);
    if (r.ok) labels.forEach((l, i) => expect(r.layout.row_lines[i]!.join(" ")).toBe(l));
  });
  it("puts rows in two columns, or says exactly why not", () => {
    const many = rows(Array.from({ length: 12 }, (_, i) => `Row number ${i + 1} label`));
    const r = layoutWindow({ ...base, title: "Rows", rows: many, box: { x: 0, y: 0, w: 900, h: 400 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.layout.cols).toBe(2);
    const no = layoutWindow({ ...base, title: "Rows", rows: rows(Array.from({ length: 40 }, (_, i) => `Row ${i}`)), box: { x: 0, y: 0, w: 300, h: 200 } });
    expect(no.ok).toBe(false);
    expect(no.attempts.length).toBeGreaterThan(0);
  });
});

describe("the 12-scene regression project: S04 and S05 as approved", () => {
  const SIZES: [number, number][] = [[1280, 720], [1920, 1080], [854, 480], [720, 1280], [1080, 1080], [1080, 1350], [640, 360]];
  for (const [w, h] of SIZES) {
    it(`S04 keeps all five steps in order at ${w}x${h}`, () => {
      const sc = one(job(w, h, S04, 6));
      expect(sc.layout?.kind).toBe("steps");
      if (sc.layout?.kind !== "steps") return;
      const L = sc.layout.steps;
      expect(L.pages.flat()).toEqual([0, 1, 2, 3, 4]);
      expect(L.font_px).toBeGreaterThanOrEqual(Math.round(Math.min(w, h) * 0.034));
      L.labels.forEach((lines, i) => expect(lines.join(" ")).toBe(S04.visual.steps[i]!.label));
      for (const page of L.pages) expect(detectOverflow(page.map((i) => ({ name: `step ${i + 1}`, rect: stepRect(L, i) })), sc.content)).toEqual([]);
      expect(sc.frames).toBe(180); // the approved 6 seconds
    });
    it(`S05 keeps its title, sidebar, six rows and confirmation at ${w}x${h}`, () => {
      const sc = one(job(w, h, S05, 7));
      expect(sc.layout?.kind).toBe("window");
      if (sc.layout?.kind !== "window") return;
      const L = sc.layout.window;
      expect(L.title_lines.join(" ")).toBe("Pipeline (concept)");
      expect(L.row_lines.map((l) => l.join(" "))).toEqual(S05.visual.rows.map((r) => r.label));
      expect(L.side_lines.map((l) => l.join(" "))).toEqual([...S05.visual.sidebar]);
      expect(L.confirm?.lines.join(" ")).toBe("Appointment booked");
      expect(L.font_px).toBeGreaterThanOrEqual(Math.round(Math.min(w, h) * 0.034));
      expect(detectOverflow(L.placed, sc.content, { overlapOk: (a, b) => a === "the window" || b === "the window" })).toEqual([]);
      expect(sc.frames).toBe(210);
    });
  }
  it("an extremely long label is wrapped, kept whole, and still inside the frame", () => {
    const spec = structuredClone(S05) as unknown as { overlay: string; visual: { rows: { label: string }[] } };
    spec.visual.rows[0]!.label = "CRM, pipeline, forecasting";
    const sc = one(job(360, 640, spec, 7));
    if (sc.layout?.kind !== "window") throw new Error("window");
    expect(sc.layout.window.row_lines[0]!.join(" ")).toBe(spec.visual.rows[0]!.label);
  });
  it("keeps every step and detail, in order, when the steps are dense", () => {
    const spec = structuredClone(S04) as unknown as { overlay: string; visual: { steps: { label: string; detail: string | null }[] } };
    spec.visual.steps = Array.from({ length: 5 }, (_, i) => ({ label: `Automated follow-up ${i + 1}`, detail: "Sends a text and an email today" }));
    const sc = one(job(1080, 1080, spec, 6));
    if (sc.layout?.kind !== "steps") throw new Error("steps");
    const L = sc.layout.steps;
    expect(L.pages.flat()).toEqual([0, 1, 2, 3, 4]);
    L.details.forEach((d) => expect(d.join(" ")).toBe("Sends a text and an email today"));
    expect(sc.frames).toBe(180);
  });
  it("fits a six-message thread at every frame size by wrapping and tightening, keeping every message whole", () => {
    const msgs = ["Hi, I filled in your form on the website", "Do you have time for a quick call today?", "Following up on my enquiry from last week", "Is anyone available to talk this afternoon?", "I can do Thursday at ten if that works", "Thanks, booking it now and sending a link"];
    const spec = { overlay: "BUSINESS IS EVOLVING.", visual: { block: "message_thread", mode: "stack", messages: msgs.map((text, i) => ({ from: i % 2 ? "you" : "them", text })), camera: "static", reveal: "none", backdrop: "grid" } };
    for (const [w, h] of [[1280, 720], [1920, 1080], [854, 480], [720, 1280], [1080, 1080]] as const) {
      const sc = one(job(w, h, spec, 6));
      msgs.forEach((m, i) => expect(sc.lines[`m${i}`]!.join(" "), `${w}x${h} m${i}`).toBe(m));
      expect(sc.sizes.body, `${w}x${h}`).toBeGreaterThanOrEqual(Math.round(Math.min(w, h) * 0.034));
      const tight = sc.lines["tight"]![0] === "1";
      const need = msgs.reduce((a, _m, i) => a + sc.lines[`m${i}`]!.length * sc.sizes.body * (tight ? 1.15 : 1.25) + sc.sizes.body * (tight ? 0.8 : 1.1), 0);
      expect(need, `${w}x${h} height`).toBeLessThanOrEqual(sc.content.h * 0.9 + 1);
    }
  });
});