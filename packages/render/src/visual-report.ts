import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DirectorHandoff } from "@digikon/contracts";
import { ticketsFromFindings, visualQa, type VisualQaResult } from "@digikon/qa";
import type { DeliveryReport } from "./assemble.js";

/**
 * The three kinds of result a delivered film has, kept apart:
 * - technical validity: the rendered file itself (probe, size, frame rate, duration; already in the delivery report and the render QA),
 * - plan compliance: every approved scene present, in order, with the planned template and engine, and nothing silently replaced,
 * - visual QA: measurements on the real frames (see packages/qa/src/visual.ts).
 * `final_ready` is false while any of them has an open critical or major problem; it is never true for an incomplete film.
 */
export interface FilmQuality {
  technical: { ok: boolean; evidence: string[] };
  plan_compliance: { ok: boolean; problems: string[]; evidence: string[] };
  visual: VisualQaResult;
  tickets: ReturnType<typeof ticketsFromFindings>;
  final_ready: boolean;
  /** Why the film is not final, in words a person can act on. Empty only when nothing blocks it (and a person may still reject it). */
  blockers: string[];
}

const MOTION = /scene-composition|slow-push|pull-out|pan-reframe|text-fade|word-stagger|lower-third|logo-reveal|end-card|punch|crop/;

export function planCompliance(report: DeliveryReport, handoff: DirectorHandoff): FilmQuality["plan_compliance"] {
  const problems: string[] = [], evidence: string[] = [];
  const approved = handoff.storyboard.scenes.map((s) => s.scene_id);
  const got = report.scenes.map((s) => s.scene_id);
  if (approved.join() !== got.join()) problems.push(`the scenes in the film (${got.join(", ")}) are not the approved scenes in order (${approved.join(", ")})`);
  else evidence.push(`${got.length} scenes, in the approved order`);
  for (const s of handoff.storyboard.scenes) {
    const r = report.scenes.find((x) => x.scene_id === s.scene_id);
    if (!r) continue;
    if (Math.abs(r.duration_s - s.duration_seconds) > 1e-6 || Math.abs(r.start_s - s.start_time) > 1e-6) problems.push(`${s.scene_id}: planned ${s.start_time}s for ${s.duration_seconds}s, rendered ${r.start_s}s for ${r.duration_s}s`);
    if (r.status === "placeholder") problems.push(`${s.scene_id}: not rendered (${r.omitted_reason ?? "no reason recorded"})`);
    for (const u of r.unmet) problems.push(`${s.scene_id}: ${u}`);
    if (s.visual && r.status !== "placeholder" && !r.operations.some((o) => o.template === "remotion/scene-composition")) problems.push(`${s.scene_id}: the approved visual (${s.visual.block}) was not drawn by the composition template; ${r.operations.map((o) => o.template).join(", ") || "no operation"} was used instead`);
  }
  if (report.omitted_operations.length) problems.push(`${report.omitted_operations.length} approved operation(s) are missing: ${report.omitted_operations.map((o) => `${o.operation_id} (${o.recipe_id})`).join(", ")}`);
  for (const t of report.transitions) if (t.status === "omitted") problems.push(`transition after ${t.after_scene} was not applied: ${t.reason}`);
  evidence.push(`engines: ${report.engines_used.join(", ")}`, `final video validated: ${report.states.final_video_validated}`);
  return { ok: problems.length === 0, problems, evidence };
}

export async function filmQuality(report: DeliveryReport, handoff: DirectorHandoff, opts: { ffmpegPath?: string } = {}): Promise<FilmQuality> {
  const compliance = planCompliance(report, handoff);
  const technical = { ok: !!report.output && report.states.final_video_validated, evidence: report.output ? [`${report.output.width}x${report.output.height} at ${report.output.fps} fps, ${report.output.duration_s}s, ${report.output.video_codec}, sha256 ${report.output.sha256.slice(0, 12)}`] : ["no video was produced"] };
  const empty: VisualQaResult = { findings: [], measures: [], checks: [], not_checked: ["No video exists, so no frames were inspected."] };
  const visual = report.output
    ? await visualQa({
        video: report.output.path, ffmpegPath: opts.ffmpegPath, palette_background: handoff.treatment.art_direction?.palette.background ?? null,
        scenes: report.scenes.map((s) => ({ scene_id: s.scene_id, start_s: s.start_s, duration_s: s.duration_s, rendered: s.status !== "placeholder", planned_motion: s.operations.some((o) => MOTION.test(o.template)), drawn_by: s.operations.map((o) => o.template).filter((t) => !t.startsWith("ffmpeg/concat")).join("+") || "nothing" })),
      })
    : empty;
  const blockers = [
    ...(technical.ok ? [] : ["the rendered file did not pass technical validation"]),
    ...compliance.problems.map((p) => `plan: ${p}`),
    ...visual.findings.filter((f) => f.severity === "critical" || f.severity === "major").map((f) => `visual ${f.scene_id ?? "film"}: ${f.description}`),
    ...report.final_delivery_blockers,
  ];
  return { technical, plan_compliance: compliance, visual, tickets: ticketsFromFindings(visual.findings, report.scenes.map((s) => s.scene_id)), final_ready: blockers.length === 0 && report.kind === "complete", blockers };
}

/** Appends one line per visual-QA run to a log, so failures and what fixed them are kept (capabilities/visual/qa-log.jsonl). */
export function logVisualQa(file: string, entry: { at: string; render_id: string; session?: string; findings: { finding_id: string; scene_id: string | null; severity: string; description: string }[]; fixed?: string[]; note?: string }): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}
