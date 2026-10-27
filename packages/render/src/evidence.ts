import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DirectorHandoff, QAFinding, Recipe, RenderRecord } from "@digikon/contracts";
import { runTechnicalChecks, type TechnicalReport } from "@digikon/qa";

/**
 * Measures a rendered file with the QA package against what the render record and the approved plan promised. Scene stretches are
 * allowed to be still: the supported template is a static text card by design, so a still picture is intended anywhere on the
 * timeline (neighbouring scenes with the same background form one long still stretch, so per-scene spans would not cover it).
 */
export async function runRenderQa(record: RenderRecord, handoff: DirectorHandoff): Promise<TechnicalReport> {
  if (record.state !== "rendered" || !record.output || !record.settings) throw new Error("QA needs a rendered record");
  const spans = handoff.qa.scene_spans.map((s) => ({ scene_id: s.scene_id, start: s.start, end: s.end }));
  return runTechnicalChecks(record.output.path, {
    duration_s: record.settings.duration_s, width: record.settings.width, height: record.settings.height, fps: record.settings.fps,
    expect_audio: record.audio_required, scenes: spans, allowed_freeze: [{ start: 0, end: record.settings.duration_s }],
  });
}

/**
 * What a successful real test render proves about one recipe, written for a human reviewer. It never changes the recipe: the
 * recipe stays `draft` until a person adds a review record to its file.
 */
export interface RenderEvidence {
  kind: "recipe_render_evidence";
  recipe_id: string;
  recipe_version: string;
  recipe_status: Recipe["status"];
  implementation_ref: string;
  render_id: string;
  purpose: RenderRecord["purpose"];
  settings: RenderRecord["settings"];
  output: NonNullable<RenderRecord["output"]>;
  qa: { findings: QAFinding[]; passed: TechnicalReport["passed"]; measurements: TechnicalReport["measurements"] };
  recorded_at: string;
  note: string;
}

export function buildRenderEvidence(record: RenderRecord, recipe: Recipe, qa: TechnicalReport, now: () => Date = () => new Date()): RenderEvidence {
  if (record.state !== "rendered" || !record.output) throw new Error("evidence can only be recorded for a rendered record");
  const op = record.operations.find((o) => o.recipe_id === recipe.recipe_id);
  if (!op) throw new Error(`render ${record.render_id} did not use recipe ${recipe.recipe_id}`);
  return {
    kind: "recipe_render_evidence", recipe_id: recipe.recipe_id, recipe_version: recipe.version, recipe_status: recipe.status,
    implementation_ref: op.implementation_ref, render_id: record.render_id, purpose: record.purpose, settings: record.settings, output: record.output,
    qa: { findings: qa.findings, passed: qa.passed, measurements: qa.measurements },
    recorded_at: now().toISOString(),
    note: "Evidence for a human reviewer. Settings are test values, not a platform specification. This file does not review the recipe or change its status.",
  };
}

export function saveRenderEvidence(dir: string, e: RenderEvidence): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${e.recipe_id}@${e.recipe_version}.${e.render_id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(e, null, 2), "utf8");
  renameSync(`${file}.tmp`, file);
  return file;
}
