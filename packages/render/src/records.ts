import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RenderRecord } from "@digikon/contracts";

/** One JSON file per render, written whole and then renamed, so an interrupted write never leaves half a record. */
export function saveRenderRecord(dir: string, record: RenderRecord): string {
  const parsed = RenderRecord.parse(record);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${parsed.render_id}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2), "utf8");
  renameSync(tmp, file);
  return file;
}

/** The stored record, or the reason it cannot be trusted. A stored `rendered` record is only as good as its output, so it must still parse. */
export function loadRenderRecord(dir: string, renderId: string): { record: RenderRecord | null; problems: string[] } {
  const file = join(dir, `${renderId}.json`);
  if (!existsSync(file)) return { record: null, problems: [] };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return { record: null, problems: [`${renderId}.json is not valid JSON`] }; }
  const p = RenderRecord.safeParse(raw);
  if (!p.success) return { record: null, problems: p.error.issues.map((i) => `${renderId}.json ${i.path.join(".") || "record"}: ${i.message}`) };
  if (p.data.render_id !== renderId) return { record: null, problems: [`${renderId}.json belongs to ${p.data.render_id}`] };
  return { record: p.data, problems: [] };
}
