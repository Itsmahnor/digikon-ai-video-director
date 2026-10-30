import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ticketsFromFindings } from "./technical.js";
import { visualQa, dominantColour, type VisualSceneSpan } from "./visual.js";

const dir = mkdtempSync(join(tmpdir(), "visual-qa-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CREAM = "f6f2ea";
/** One 2-second scene: a coloured box on a background, moving by the given x and y expressions (t is seconds). Background null means nothing drawn. */
type Clip = { bg?: string; box: string | null; x?: string; y?: string; w?: number; h?: number };
function film(name: string, clips: Clip[]): string {
  const out = join(dir, `${name}.mp4`);
  const args: string[] = ["-v", "error", "-y"];
  const parts: string[] = [];
  clips.forEach((c, i) => {
    args.push("-f", "lavfi", "-i", `color=c=0x${c.bg ?? CREAM}:s=320x180:r=30:d=2`);
    if (c.box) args.push("-f", "lavfi", "-i", `color=c=0x${c.box}:s=${c.w ?? 60}x${c.h ?? 40}:r=30:d=2`);
  });
  let k = 0;
  clips.forEach((c, i) => {
    const bgIdx = k++;
    if (c.box) { const bx = k++; parts.push(`[${bgIdx}][${bx}]overlay=x='${c.x ?? "20+t*60"}':y='${c.y ?? "40"}'[v${i}]`); } else parts.push(`[${bgIdx}]null[v${i}]`);
  });
  parts.push(`${clips.map((_c, i) => `[v${i}]`).join("")}concat=n=${clips.length}:v=1:a=0,format=yuv420p[out]`);
  args.push("-filter_complex", parts.join(";"), "-map", "[out]", "-c:v", "libx264", out);
  execFileSync("ffmpeg", args);
  return out;
}
const spans = (n: number, over: Partial<VisualSceneSpan> = {}): VisualSceneSpan[] => Array.from({ length: n }, (_x, i) => ({ scene_id: `S0${i + 1}`, start_s: i * 2, duration_s: 2, planned_motion: true, drawn_by: "remotion/scene-composition", rendered: true, ...over }));
const settle = "min(20+t*140,90)"; // reaches its place after half a second, then holds: a scene that comes to rest
const varied: Clip[] = [
  { box: "e8590c", x: "20+t*60", y: "40" },
  { box: "2b8a6e", x: "200", y: "20+t*50", w: 80, h: 60 },
  { box: "1b2230", x: settle, y: "100", w: 100, h: 50 },
];
const names = (r: Awaited<ReturnType<typeof visualQa>>) => r.checks.filter((c) => c.outcome === "failed").map((c) => c.name);

describe("visual QA on real frames", () => {
  it("passes a varied film that opens with content, moves, shares a palette and comes to rest, and still says what it did not check", async () => {
    const r = await visualQa({ video: film("varied", varied), scenes: spans(3), palette_background: `#${CREAM}` });
    expect(r.findings.map((f) => f.description)).toEqual([]);
    expect(names(r)).toEqual([]);
    expect(r.checks.map((c) => c.outcome)).not.toContain("failed");
    expect(r.measures).toHaveLength(3);
    expect(r.not_checked.join(" ")).toMatch(/No vision model/);
    expect(r.not_checked.length).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it("finds a film that repeats one layout, and names the second scene", async () => {
    const same = { box: "e8590c", x: settle, y: "40" };
    const r = await visualQa({ video: film("repeat", [{ ...same }, { ...same }, { box: "2b8a6e", x: "200", y: "100", w: 80, h: 60 }]), scenes: spans(3), palette_background: `#${CREAM}` });
    expect(names(r)).toContain("neighbouring scenes look different");
    expect(r.findings.find((f) => f.description.includes("repeats one layout"))?.scene_id).toBe("S02");
  }, 120_000);

  it("finds a scene planned as animated that does not move", async () => {
    const r = await visualQa({ video: film("static", [varied[0]!, { box: "2b8a6e", x: "200", y: "60", w: 80, h: 60 }, varied[2]!]), scenes: spans(3), palette_background: `#${CREAM}` });
    expect(r.findings.some((f) => f.scene_id === "S02" && /hardly moves/.test(f.description))).toBe(true);
    // a scene that was never meant to move is not judged for it
    const ok = await visualQa({ video: film("static2", [varied[0]!, { box: "2b8a6e", x: "200", y: "60", w: 80, h: 60 }, varied[2]!]), scenes: spans(3).map((s, i) => (i === 1 ? { ...s, planned_motion: false } : s)), palette_background: `#${CREAM}` });
    expect(ok.findings.some((f) => /hardly moves/.test(f.description))).toBe(false);
  }, 120_000);

  it("never hides a placeholder slate: it is critical, the check fails, and it is not judged as a design", async () => {
    const r = await visualQa({ video: film("slate", varied), scenes: spans(3).map((s, i) => (i === 1 ? { ...s, rendered: false } : s)), palette_background: null });
    const f = r.findings.find((x) => x.scene_id === "S02")!;
    expect(f.severity).toBe("critical");
    expect(names(r)).toContain("every scene is a rendered picture");
    expect(r.measures.map((m) => m.scene_id)).toEqual(["S01", "S03"]);
  }, 120_000);

  it("finds a blank opening, a scene on another background, and an ending that is still moving", async () => {
    const r = await visualQa({ video: film("defects", [{ box: null }, { bg: "102a43", box: "e8590c", x: "20+t*60", y: "40" }, { box: "1b2230", x: "20+t*60", y: "100", w: 100, h: 50 }]), scenes: spans(3), palette_background: `#${CREAM}` });
    expect(names(r)).toEqual(expect.arrayContaining(["no blank or crowded scene", "scenes share one palette", "the opening shows something within a second", "the ending holds still"]));
    expect(r.findings.find((f) => /different background/.test(f.description))?.scene_id).toBe("S02");
  }, 120_000);

  it("turns open findings into revision tickets for the scene named", async () => {
    const r = await visualQa({ video: film("tickets", [varied[0]!, { box: "2b8a6e", x: "200", y: "60", w: 80, h: 60 }, varied[2]!]), scenes: spans(3), palette_background: null });
    const tickets = ticketsFromFindings(r.findings, ["S01", "S02", "S03"]);
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.every((t) => t.scene_ids.length === 1 && t.status === "open")).toBe(true);
    expect(tickets.find((t) => t.scene_ids[0] === "S02")).toBeTruthy();
  }, 120_000);

  it("estimates a frame's background as its most common colour", () => {
    const b = Buffer.alloc(192 * 108 * 3, 0);
    for (let i = 0; i < b.length; i += 3) { b[i] = 246; b[i + 1] = 242; b[i + 2] = 234; }
    for (let i = 0; i < 900; i += 3) { b[i] = 10; b[i + 1] = 10; b[i + 2] = 10; }
    const [r, g, bl] = dominantColour(b);
    expect(Math.abs(r - 246) + Math.abs(g - 242) + Math.abs(bl - 234)).toBeLessThan(30);
  });
});
