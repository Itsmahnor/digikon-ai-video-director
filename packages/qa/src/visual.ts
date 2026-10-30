import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { QAFinding } from "@digikon/contracts";

const run = promisify(execFile);

/**
 * Visual QA of a rendered film, from its real frames. Everything here is measured, not judged: it finds scenes that are blank, crowded,
 * static when motion was planned, near-identical to a neighbour, off the film's palette, or that open late or end without holding still.
 * It cannot tell whether a design is good. A film can pass every check here and still deserve a person's eye, so the result always lists
 * what was not checked and a passing result is "no measurable defect", never "good".
 */

const W = 192, H = 108;

export interface VisualSceneSpan {
  scene_id: string;
  start_s: number;
  duration_s: number;
  /** True when the approved plan has this scene animated (a composition, a camera move or a text entrance). */
  planned_motion: boolean;
  /** Which block or template drew it, for the report. */
  drawn_by: string;
  /** False for a placeholder slate: it is reported, never judged as a design. */
  rendered: boolean;
}

export interface VisualQaInput {
  video: string;
  scenes: VisualSceneSpan[];
  /** The approved background colour, when the film has art direction. */
  palette_background: string | null;
  ffmpegPath?: string;
}

export interface VisualMeasure {
  scene_id: string;
  coverage: number;
  /** Largest mean step between sampled frames, 0-255. */
  motion: number;
  /** Mean step across the last stretch of the scene: near zero means it holds still. */
  end_motion: number;
  background: string;
  signature: number[];
  /** Share of the frame, at 1.0s into the scene, that differs from the background. */
  coverage_at_1s: number;
}

export interface VisualQaResult {
  findings: QAFinding[];
  measures: VisualMeasure[];
  checks: { name: string; outcome: "passed" | "failed" | "not_applicable"; evidence: string }[];
  /** What this report does not establish. Always present. */
  not_checked: string[];
}

type Frame = Buffer;

async function frameAt(video: string, t: number, ffmpeg: string): Promise<Frame> {
  const { stdout } = await run(ffmpeg, ["-v", "error", "-ss", String(Math.max(0, t)), "-i", video, "-frames:v", "1", "-vf", `scale=${W}:${H}:flags=area,format=rgb24`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: W * H * 3 + 4096, timeout: 60_000, windowsHide: true });
  const b = stdout as unknown as Buffer;
  if (b.length < W * H * 3) throw new Error(`no frame at ${t}s`);
  return b;
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const dist = (b: Frame, i: number, c: readonly number[]) => Math.abs(b[i]! - c[0]!) + Math.abs(b[i + 1]! - c[1]!) + Math.abs(b[i + 2]! - c[2]!);
const mad = (a: Frame, b: Frame) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!); return d / a.length; };

/** The most common colour of a frame, in steps of 8, which stands for its background. */
export function dominantColour(f: Frame): [number, number, number] {
  const counts = new Map<number, number>();
  for (let i = 0; i + 2 < f.length; i += 3) { const k = ((f[i]! >> 3) << 10) | ((f[i + 1]! >> 3) << 5) | (f[i + 2]! >> 3); counts.set(k, (counts.get(k) ?? 0) + 1); }
  let best = 0, bk = 0;
  for (const [k, n] of counts) if (n > best) { best = n; bk = k; }
  return [((bk >> 10) & 31) * 8 + 4, ((bk >> 5) & 31) * 8 + 4, (bk & 31) * 8 + 4];
}
/** Share of the frame that is content: far from the background colour, or sitting on an edge (a white card on cream differs little in colour but has an outline and a shadow). */
const coverageOf = (f: Frame, bg: readonly number[]) => {
  let n = 0, c = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    n++;
    const edge = (x + 1 < W && Math.abs(f[i]! - f[i + 3]!) + Math.abs(f[i + 1]! - f[i + 4]!) + Math.abs(f[i + 2]! - f[i + 5]!) > 24) || (y + 1 < H && Math.abs(f[i]! - f[i + W * 3]!) + Math.abs(f[i + 1]! - f[i + W * 3 + 1]!) + Math.abs(f[i + 2]! - f[i + W * 3 + 2]!) > 24);
    if (dist(f, i, bg) > 60 || edge) c++;
  }
  return c / n;
};
const signatureOf = (f: Frame): number[] => {
  const out: number[] = [];
  for (let cy = 0; cy < 9; cy++) for (let cx = 0; cx < 16; cx++) {
    let s = 0, c = 0;
    for (let y = cy * 12; y < cy * 12 + 12; y++) for (let x = cx * 12; x < cx * 12 + 12; x++) { const i = (y * W + x) * 3; s += 0.299 * f[i]! + 0.587 * f[i + 1]! + 0.114 * f[i + 2]!; c++; }
    out.push(s / c);
  }
  return out;
};
const sigDist = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;

export async function visualQa(input: VisualQaInput): Promise<VisualQaResult> {
  const ff = input.ffmpegPath ?? "ffmpeg";
  const findings: QAFinding[] = [];
  const checks: VisualQaResult["checks"] = [];
  const measures: VisualMeasure[] = [];
  let n = 0;
  const find = (scene_id: string | null, severity: QAFinding["severity"], category: QAFinding["category"], evidence_ref: string, description: string, suggested_fix: string) =>
    findings.push(QAFinding.parse({ finding_id: `VQ${String(++n).padStart(2, "0")}`, scene_id, severity, category, evidence_ref, description, suggested_fix }));
  const frames = new Map<string, Frame[]>();

  for (const s of input.scenes) {
    const at = (f: number) => s.start_s + Math.min(s.duration_s - 0.04, f * s.duration_s);
    const times = [0.12, 0.35, 0.6, 0.85, 0.97].map(at);
    const extra = [Math.min(s.start_s + 1, s.start_s + s.duration_s - 0.04), Math.max(s.start_s, s.start_s + s.duration_s - 0.6)];
    try {
      const fs = await Promise.all(times.map((t) => frameAt(input.video, t, ff)));
      const one = await frameAt(input.video, extra[0]!, ff), tail = await frameAt(input.video, extra[1]!, ff);
      frames.set(s.scene_id, fs);
      if (!s.rendered) continue;
      const bg = dominantColour(fs[fs.length - 1]!);
      let motion = 0;
      for (let k = 1; k < fs.length; k++) motion = Math.max(motion, mad(fs[k - 1]!, fs[k]!));
      measures.push({ scene_id: s.scene_id, coverage: coverageOf(fs[fs.length - 1]!, bg), motion, end_motion: mad(tail, fs[fs.length - 1]!), background: hex(...bg), signature: signatureOf(fs[fs.length - 1]!), coverage_at_1s: coverageOf(one, bg) });
    } catch (e) {
      find(s.scene_id, "major", "technical", `frames of ${s.scene_id}`, `frames of ${s.scene_id} could not be read back (${(e instanceof Error ? e.message : String(e)).slice(0, 100)})`, "Re-render the scene.");
    }
  }

  const slates = input.scenes.filter((s) => !s.rendered);
  for (const s of slates) find(s.scene_id, "critical", "visual", `${s.scene_id} is a placeholder slate in the output`, `${s.scene_id} was not rendered: the film shows a placeholder slate in its place. The result is incomplete and cannot be final.`, "Give the scene a drawable visual, or supply what it needs, and render it again.");
  checks.push({ name: "every scene is a rendered picture", outcome: slates.length ? "failed" : "passed", evidence: slates.length ? `placeholders: ${slates.map((s) => s.scene_id).join(", ")}` : `${input.scenes.length} of ${input.scenes.length} scenes rendered` });

  // blank, crowded and static scenes
  const bad = { blank: [] as string[], crowded: [] as string[], static: [] as string[] };
  for (const m of measures) {
    const s = input.scenes.find((x) => x.scene_id === m.scene_id)!;
    if (m.coverage < 0.025) { bad.blank.push(m.scene_id); find(m.scene_id, "major", "visual", `last frame of ${m.scene_id}: ${(m.coverage * 100).toFixed(1)}% differs from the background`, `${m.scene_id} is almost empty at its end.`, "Add content or give the scene a stronger visual."); }
    if (m.coverage > 0.9) { bad.crowded.push(m.scene_id); find(m.scene_id, "major", "visual", `last frame of ${m.scene_id}: ${(m.coverage * 100).toFixed(0)}% differs from the background`, `${m.scene_id} fills the whole frame, so nothing has room or priority.`, "Reduce the content or the size of the picture."); }
    if (s.planned_motion && m.motion < 0.4) { bad.static.push(m.scene_id); find(m.scene_id, "major", "pacing", `${m.scene_id}: largest step between sampled frames ${m.motion.toFixed(2)} of 255`, `${m.scene_id} was planned as animated but hardly moves.`, "Check the scene's camera, reveal and entrance, and render it again."); }
  }
  checks.push({ name: "no blank or crowded scene", outcome: bad.blank.length + bad.crowded.length ? "failed" : "passed", evidence: `coverage per scene: ${measures.map((m) => `${m.scene_id} ${(m.coverage * 100).toFixed(0)}%`).join(", ")}` });
  checks.push({ name: "planned motion is visible", outcome: bad.static.length ? "failed" : "passed", evidence: `largest frame step per scene: ${measures.map((m) => `${m.scene_id} ${m.motion.toFixed(1)}`).join(", ")}` });

  // variation and progression: neighbours must not share one layout
  const pairs: string[] = [];
  for (let i = 1; i < measures.length; i++) {
    const a = measures[i - 1]!, b = measures[i]!;
    const d = sigDist(a.signature, b.signature);
    const da = input.scenes.find((x) => x.scene_id === a.scene_id)!.drawn_by, db = input.scenes.find((x) => x.scene_id === b.scene_id)!.drawn_by;
    if (d < 5) { pairs.push(`${a.scene_id}/${b.scene_id} (${d.toFixed(1)})`); find(b.scene_id, "major", "visual", `${a.scene_id} and ${b.scene_id} last frames differ by ${d.toFixed(1)} of 255 in layout`, `${b.scene_id} looks like ${a.scene_id} (${da} then ${db}): the film repeats one layout.`, "Give the scene a different kind of picture or composition."); }
  }
  checks.push({ name: "neighbouring scenes look different", outcome: measures.length < 2 ? "not_applicable" : pairs.length ? "failed" : "passed", evidence: measures.length < 2 ? "fewer than two rendered scenes" : `layout distance between neighbours: ${measures.slice(1).map((m, i) => sigDist(measures[i]!.signature, m.signature).toFixed(0)).join(", ")} (flagged below 5)` });

  // one design system: scene backgrounds stay close to the film's
  if (measures.length >= 2) {
    const target = input.palette_background && /^#[0-9a-f]{6}$/i.test(input.palette_background) ? [1, 3, 5].map((i) => parseInt(input.palette_background!.slice(i, i + 2), 16)) : null;
    const base = target ?? [0, 1, 2].map((k) => [...measures].map((m) => parseInt(m.background.slice(1 + k * 2, 3 + k * 2), 16)).sort((x, y) => x - y)[Math.floor(measures.length / 2)]!);
    const off = measures.filter((m) => [0, 1, 2].reduce((s, k) => s + Math.abs(parseInt(m.background.slice(1 + k * 2, 3 + k * 2), 16) - base[k]!), 0) > 110);
    for (const m of off) find(m.scene_id, "minor", "visual", `${m.scene_id} background ${m.background} vs film ${hex(base[0]!, base[1]!, base[2]!)}`, `${m.scene_id} is on a different background colour from the rest of the film.`, "Use the film's approved palette in every scene.");
    checks.push({ name: "scenes share one palette", outcome: off.length ? "failed" : "passed", evidence: `backgrounds: ${measures.map((m) => `${m.scene_id} ${m.background}`).join(", ")}${target ? ` (approved ${input.palette_background})` : ""}` });
  } else checks.push({ name: "scenes share one palette", outcome: "not_applicable", evidence: "fewer than two rendered scenes" });

  // opening and ending
  const first = measures.find((m) => m.scene_id === input.scenes[0]?.scene_id), last = measures.find((m) => m.scene_id === input.scenes[input.scenes.length - 1]?.scene_id);
  if (first) {
    const weak = first.coverage_at_1s < 0.03;
    if (weak) find(first.scene_id, "major", "visual", `${first.scene_id} at 1s: ${(first.coverage_at_1s * 100).toFixed(1)}% drawn`, "The opening shows almost nothing after a second.", "Start with something concrete in the first frames.");
    checks.push({ name: "the opening shows something within a second", outcome: weak ? "failed" : "passed", evidence: `${first.scene_id}: ${(first.coverage_at_1s * 100).toFixed(0)}% of the frame drawn at 1s` });
  }
  if (last) {
    const moving = last.end_motion > 1.5;
    if (moving) find(last.scene_id, "minor", "pacing", `${last.scene_id}: the last 0.6s still changes by ${last.end_motion.toFixed(1)} of 255`, "The film does not come to rest on its closing scene, so the last message is hard to read.", "Finish the animation earlier and hold the end still.");
    checks.push({ name: "the ending holds still", outcome: moving ? "failed" : "passed", evidence: `${last.scene_id}: change over the last 0.6s ${last.end_motion.toFixed(2)} of 255` });
  }

  return {
    findings, measures, checks,
    not_checked: [
      "Whether the hierarchy, composition and typography are good: only blank, crowded, static, repeated and off-palette scenes are measured.",
      "Whether the text is spelled as approved, and whether any text is clipped inside a block: the render checks measure the frame edge only. Nothing here reads text.",
      "Whether the concept, copy and pacing persuade the audience, and whether a transition looks right. Transitions are reported from the render's own record, not judged from frames.",
      "Anything between the sampled frames: five frames per scene plus two near its end were read.",
      "No vision model reviewed these frames. A person or a vision model should look at them (the contact sheet) before the film is called good.",
    ],
  };
}
