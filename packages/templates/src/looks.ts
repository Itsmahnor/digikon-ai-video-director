import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LibraryTemplate } from "@digikon/contracts";
import { REPORT_DIR, REPO_ROOT } from "./library.js";
import { ClipLookEmbedder, LOOK_MODEL, LOOK_MODEL_VERSION } from "./look.js";
import { PreviewRenderer, RENDER_REV, lookVector } from "./preview.js";

/**
 * The look vectors (CLIP of each template's rendered 16:9 preview) are kept in the repository next to the templates, keyed by content hash, so that
 * stats, dedupe and ingest never need a browser unless a template has changed. A vector whose hash no longer matches is recomputed.
 */
export const LOOKS_FILE = join(REPORT_DIR, "look-vectors.json");
export const MODELS_DIR = join(REPO_ROOT, "storage", "models");

interface LookFile { model: string; version: string; rev: string; vectors: Record<string, { hash: string; v: number[] }> }

export function loadLooks(file = LOOKS_FILE): LookFile {
  if (existsSync(file)) {
    const j = JSON.parse(readFileSync(file, "utf8")) as LookFile;
    if (j.model === LOOK_MODEL && j.version === LOOK_MODEL_VERSION && j.rev === RENDER_REV) return j; // vectors drawn by a different renderer are stale
  }
  return { model: LOOK_MODEL, version: LOOK_MODEL_VERSION, rev: RENDER_REV, vectors: {} };
}
export function saveLooks(l: LookFile, file = LOOKS_FILE): void {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(l) + "\n", "utf8");
}

const r3 = (v: number[]) => v.map((x) => Math.round(x * 1000) / 1000);

/**
 * Look vectors for the given templates. Stored ones are reused when the hash matches; the rest are rendered and embedded (this needs Chrome and the CLIP
 * model on disk). With `render: false` a missing vector is an error instead.
 */
export async function ensureLooks(ts: readonly LibraryTemplate[], o: { render: boolean; save?: boolean; log?: (s: string) => void; file?: string } = { render: true }): Promise<Map<string, number[]>> {
  const store = loadLooks(o.file), out = new Map<string, number[]>(), missing: LibraryTemplate[] = [];
  for (const t of ts) { const s = store.vectors[t.template_id]; if (s && s.hash === t.content_hash) out.set(t.template_id, s.v); else missing.push(t); }
  if (missing.length) {
    if (!o.render) throw new Error(`${missing.length} template(s) have no stored look vector (for example ${missing[0]!.template_id}); run \`npm run templates -- dedupe\` to render them`);
    const r = new PreviewRenderer(), e = new ClipLookEmbedder(MODELS_DIR);
    await r.open();
    try {
      let i = 0;
      for (const t of missing) {
        const v = r3(await lookVector(r, e, t));
        // re-normalise after rounding so dot products stay cosines
        const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1, u = v.map((x) => x / n);
        out.set(t.template_id, u); store.vectors[t.template_id] = { hash: t.content_hash, v: u.map((x) => Math.round(x * 1e4) / 1e4) };
        if (++i % 25 === 0) o.log?.(`  looked at ${i}/${missing.length} previews`);
      }
    } finally { await r.close(); }
  }
  if (missing.length && o.save !== false) saveLooks(store, o.file);
  return out;
}

/** Drops stored vectors of templates that are no longer in the library. */
export function pruneLooks(ids: ReadonlySet<string>, file = LOOKS_FILE): void {
  const s = loadLooks(file);
  for (const k of Object.keys(s.vectors)) if (!ids.has(k)) delete s.vectors[k];
  saveLooks(s, file);
}
