import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Embedder } from "./embeddings.js";

/**
 * Wraps an embedder so a text is embedded once per model and then read from a file on disk. The key is a hash of the exact text, so an edited skill is
 * re-embedded and an unchanged one is not; a different model or version uses a different file. Queries are never cached (they are embedded fresh).
 */
export class CachedEmbedder implements Embedder {
  readonly model: string;
  readonly version: string;
  get dim() { return this.inner.dim; }
  private readonly cache = new Map<string, number[]>();
  /** How many texts were served from disk / computed during this process. */
  hits = 0;
  misses = 0;
  private dirty = false;

  constructor(private readonly inner: Embedder, private readonly file: string) {
    this.model = inner.model;
    this.version = inner.version;
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { model: string; version: string; vectors: Record<string, number[]> };
        if (parsed.model === inner.model && parsed.version === inner.version) for (const [k, v] of Object.entries(parsed.vectors)) this.cache.set(k, v);
      }
    } catch { /* a damaged cache is just a cold start */ }
  }

  private key(text: string) { return createHash("sha256").update(text).digest("hex").slice(0, 24); }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const keys = texts.map((t) => this.key(t));
    const missing: number[] = [];
    keys.forEach((k, i) => { if (!this.cache.has(k)) missing.push(i); });
    if (missing.length) {
      const vs = await this.inner.embed(missing.map((i) => texts[i]!));
      missing.forEach((i, j) => this.cache.set(keys[i]!, vs[j]!));
      this.dirty = true;
    }
    this.misses += missing.length;
    this.hits += texts.length - missing.length;
    return keys.map((k) => this.cache.get(k)!);
  }

  embedQuery(text: string): Promise<number[]> {
    return this.inner.embedQuery ? this.inner.embedQuery(text) : this.inner.embed([text]).then((r) => r[0]!);
  }

  /** Writes new vectors to disk (atomically). Call once after start-up indexing. */
  save(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ model: this.model, version: this.version, vectors: Object.fromEntries(this.cache) }));
    renameSync(tmp, this.file);
    this.dirty = false;
  }
}
