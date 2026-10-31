import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AssetUserInput, ContentRecord, ProjectAssetLink, effectiveCategories, effectiveDescription, type ImageAnalysis, type RegistryAsset } from "@digikon/contracts";

export const sha256OfFile = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");

const PIPELINE = "image-understanding-1";

export const pendingAnalysis = (): ImageAnalysis => ({ status: "pending", analysed_at: null, model: { classifier: null, describer: null, ocr: null, pipeline_version: PIPELINE }, categories: [], visual: null, evidence: [], error: null, retryable: true });

/**
 * The shared record of every uploaded picture, on disk so it outlives a restart.
 *
 *   <root>/content/<sha256>/record.json     what the bytes are: analysis, thumbnails, render copies. One per distinct file.
 *   <root>/projects/<session>/<asset>.json  one project's use of a picture: name, path, and what the user said about it.
 *
 * The same picture in two projects is one content record and two links, so it is analysed once, while each project keeps its own name, its own original
 * and its own corrections. An asset id resolves only inside its own session, so one project can never reach another's picture by id.
 */
export class AssetRegistry {
  constructor(private readonly root: string) {}

  contentDir(content_id: string): string { return join(this.root, "content", content_id); }
  private contentFile(id: string) { return join(this.contentDir(id), "record.json"); }
  private linkFile(session: string, asset: string) { return join(this.root, "projects", session, `${asset}.json`); }

  private write(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 1));
    renameSync(tmp, file);
  }

  content(content_id: string): ContentRecord | null {
    const f = this.contentFile(content_id);
    if (!existsSync(f)) return null;
    try { return ContentRecord.parse(JSON.parse(readFileSync(f, "utf8"))); } catch { return null; }
  }

  saveContent(record: ContentRecord): void { this.write(this.contentFile(record.content_id), ContentRecord.parse({ ...record, updated_at: new Date().toISOString() })); }

  /** The record for these bytes, creating an empty one the first time they are seen. */
  ensureContent(content_id: string): ContentRecord {
    const had = this.content(content_id);
    if (had) return had;
    const now = new Date().toISOString();
    const rec: ContentRecord = { content_id, technical: null, analysis: pendingAnalysis(), thumbnail_path: null, normalized_path: null, trimmed_path: null, normalize_reason: null, normalized_size: null, trimmed_size: null, created_at: now, updated_at: now };
    this.saveContent(rec);
    return rec;
  }

  link(input: Omit<ProjectAssetLink, "user" | "uploaded_at"> & { uploaded_at?: string }): ProjectAssetLink {
    const had = this.getLink(input.session_id, input.asset_id);
    if (had) return had;
    const l = ProjectAssetLink.parse({ ...input, uploaded_at: input.uploaded_at ?? new Date().toISOString(), user: AssetUserInput.parse({}) });
    this.write(this.linkFile(l.session_id, l.asset_id), l);
    return l;
  }

  getLink(session_id: string, asset_id: string): ProjectAssetLink | null {
    const f = this.linkFile(session_id, asset_id);
    if (!existsSync(f)) return null;
    try { return ProjectAssetLink.parse(JSON.parse(readFileSync(f, "utf8"))); } catch { return null; }
  }

  linksOf(session_id: string): ProjectAssetLink[] {
    const dir = join(this.root, "projects", session_id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => this.getLink(session_id, f.slice(0, -5))).filter((l): l is ProjectAssetLink => !!l).sort((a, b) => a.uploaded_at.localeCompare(b.uploaded_at));
  }

  /** The project's existing link to these bytes, so the same file is not added to a project twice. */
  duplicateIn(session_id: string, content_id: string): ProjectAssetLink | null { return this.linksOf(session_id).find((l) => l.content_id === content_id) ?? null; }

  /** How many projects hold these bytes, so a shared analysis is known to be shared. */
  projectsUsing(content_id: string): string[] {
    const dir = join(this.root, "projects");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((s) => this.linksOf(s).some((l) => l.content_id === content_id));
  }

  /** Records what the user said. Fields left out stay as they were. It changes this project's link only. */
  setUserInput(session_id: string, asset_id: string, patch: Partial<Omit<AssetUserInput, "updated_at">>): ProjectAssetLink {
    const l = this.getLink(session_id, asset_id);
    if (!l) throw new Error(`${asset_id} is not a picture in this project`);
    const user = AssetUserInput.parse({ ...l.user, ...patch, updated_at: new Date().toISOString() });
    const next = { ...l, user };
    this.write(this.linkFile(session_id, asset_id), next);
    return next;
  }

  removeLink(session_id: string, asset_id: string): void {
    const f = this.linkFile(session_id, asset_id);
    if (existsSync(f)) renameSync(f, `${f}.removed`);
  }

  private view(l: ProjectAssetLink, availability: RegistryAsset["availability"]): RegistryAsset | null {
    const content = this.content(l.content_id);
    if (!content) return null;
    return { ...l, content, availability, effective_categories: effectiveCategories(content.analysis, l.user), effective_description: effectiveDescription(content.analysis, l.user) };
  }

  /** A picture by id, only inside its own session. Checks the file is there and still holds the same bytes. */
  async resolve(session_id: string, asset_id: string): Promise<RegistryAsset | null> {
    const l = this.getLink(session_id, asset_id);
    if (!l) return null;
    let availability: RegistryAsset["availability"] = "available";
    if (!existsSync(l.original_path)) availability = "missing_file";
    else if ((await sha256OfFile(l.original_path)) !== l.content_id) availability = "changed_on_disk";
    return this.view(l, availability);
  }

  /**
   * The actual file a renderer should load for a picture, found by id inside this project only. A logo gets its tight crop; anything a renderer cannot load gets
   * its normalized copy. Null when this project has no such picture, its file has gone or changed, or it never decoded: a renderer then reports it, and nothing stands in.
   */
  renderFile(session_id: string, asset_id: string, role: string) {
    const l = this.getLink(session_id, asset_id);
    const c = l ? this.content(l.content_id) : null;
    if (!l || !c?.technical || !existsSync(l.original_path)) return null;
    if (createHash("sha256").update(readFileSync(l.original_path)).digest("hex") !== l.content_id) return null;
    const t = c.technical;
    const trimmed = role === "logo" && c.trimmed_path && c.trimmed_size && existsSync(c.trimmed_path);
    const normalized = c.normalized_path && c.normalized_size && existsSync(c.normalized_path);
    const path = trimmed ? c.trimmed_path! : normalized ? c.normalized_path! : l.original_path;
    const size = trimmed ? c.trimmed_size! : normalized ? c.normalized_size! : { width: t.width, height: t.height };
    const v = c.analysis.visual;
    const bg = v?.background.colour ?? null;
    return {
      asset_id, path, variant: (trimmed ? "trimmed" : normalized ? "normalized" : "original") as "trimmed" | "normalized" | "original",
      sha256: path === l.original_path ? l.content_id : createHash("sha256").update(readFileSync(path)).digest("hex"), width: size.width, height: size.height,
      transparent: t.transparent_share > 0.01, background: bg, colours: (v?.dominant_colours ?? []).filter((d) => d.hex !== bg && d.share >= 0.03).map((d) => d.hex),
    };
  }

  async list(session_id: string): Promise<RegistryAsset[]> {
    const out = await Promise.all(this.linksOf(session_id).map((l) => this.resolve(session_id, l.asset_id)));
    return out.filter((a): a is RegistryAsset => !!a);
  }
}
