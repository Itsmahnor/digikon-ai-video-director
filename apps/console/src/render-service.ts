import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { EditorOutput, type DirectorHandoff, type RenderRecord } from "@digikon/contracts";

/** Where one run's render files live, all inside the session folder: storage/sessions/<id>/renders/<run>/. */
export function renderDirs(sessionDir: string, runId: string) {
  const root = join(sessionDir, "renders", runId);
  return { root, out: join(root, "out"), records: join(root, "records"), evidence: join(root, "evidence"), editor: join(root, "editor-output.json") };
}

const EDITOR_FORMAT = "digikon.editor-output", EDITOR_FORMAT_VERSION = 1;

/** The Editor's result for one run, bound to the exact handoff it was made from. */
export function saveEditorOutput(file: string, runId: string, output: EditorOutput): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({ format: EDITOR_FORMAT, format_version: EDITOR_FORMAT_VERSION, run_id: runId, output }, null, 2), "utf8");
  renameSync(`${file}.tmp`, file);
}

/** The stored result, or why it cannot be used. Absent is not a problem: the Editor has not run yet. */
export function loadEditorOutput(file: string, runId: string): { output: EditorOutput | null; problems: string[] } {
  if (!existsSync(file)) return { output: null, problems: [] };
  let env: Record<string, unknown>;
  try { env = JSON.parse(readFileSync(file, "utf8")); } catch { return { output: null, problems: ["the stored Editor result is not valid JSON"] }; }
  if (env["format"] !== EDITOR_FORMAT || env["format_version"] !== EDITOR_FORMAT_VERSION) return { output: null, problems: ["the stored Editor result has an unsupported format"] };
  if (env["run_id"] !== runId) return { output: null, problems: ["the stored Editor result belongs to another run"] };
  const p = EditorOutput.safeParse(env["output"]);
  return p.success ? { output: p.data, problems: [] } : { output: null, problems: p.error.issues.map((i) => `the stored Editor result is invalid: ${i.path.join(".") || "root"}: ${i.message}`) };
}

/** True when `path` is inside `root` (after resolving), never equal to it. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Removes absolute folders from text shown to the user, so errors never reveal where the project lives. */
export function scrub(text: string, roots: readonly string[]): string {
  let out = text;
  for (const r of [...roots, tmpdir()].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(r).join("<storage>").split(r.replaceAll("\\", "/")).join("<storage>");
  }
  return out;
}

/** A record as the browser sees it: no absolute paths, and a playback address only for a rendered record. */
export function publicRecord(record: RenderRecord, sessionId: string, runRoot: string, scrubRoots: readonly string[]) {
  const out = record.output;
  return {
    ...record,
    errors: record.errors.map((e) => ({ ...e, message: scrub(e.message, scrubRoots) })),
    blockers: record.blockers.map((b) => scrub(b, scrubRoots)),
    assets: record.assets.map(({ uri: _uri, ...a }) => a),
    output: out ? { ...out, path: relative(runRoot, out.path).replaceAll("\\", "/"), video_url: record.state === "rendered" ? `/api/sessions/${sessionId}/renders/${record.render_id}/video` : null } : null,
  };
}

export const timelineEnd = (h: DirectorHandoff) => Math.max(...h.storyboard.scenes.map((s) => s.start_time + s.duration_seconds));
