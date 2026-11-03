import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tokenize } from "./keyword.js";

/**
 * Text embeddings behind one small interface, so retrieval never depends on which model made the vectors. Two implementations:
 *  - HashEmbedder: deterministic feature hashing of stemmed words, word pairs and letter triples. No model, no network, always available. It matches
 *    wording, spelling and word forms, not meaning, so it is the test embedder and a fallback, not a substitute for a real sentence model.
 *  - TransformersEmbedder: a sentence-embedding model from @huggingface/transformers, loaded from a folder on this machine only (local_files_only).
 *    Nothing is ever downloaded by this code; if the folder is missing it throws and says which model to place there.
 * Every vector is unit length, so cosine similarity is a dot product.
 */
export interface Embedder {
  readonly model: string;
  readonly version: string;
  readonly dim: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

const fnv1a = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
const normalise = (v: number[]): number[] => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n); return n === 0 ? v : v.map((x) => x / n); };

export class HashEmbedder implements Embedder {
  readonly model = "hash-features";
  readonly version = "1";
  constructor(readonly dim = 384) {}
  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.one(t));
  }
  private one(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const add = (feature: string, w: number) => { const h = fnv1a(feature); v[h % this.dim]! += (h & 0x80000000 ? -1 : 1) * w; };
    const toks = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) {
      add(`w:${t}`, 1 + Math.log(n));
      const g = `^${t}$`;
      for (let i = 0; i + 3 <= g.length; i++) add(`c:${g.slice(i, i + 3)}`, 0.25);
    }
    for (let i = 0; i + 1 < toks.length; i++) add(`b:${toks[i]} ${toks[i + 1]}`, 0.5);
    return normalise(v);
  }
}

/** Sentence-embedding models this code knows how to use, in order of preference. A folder named like one of these under the models directory is used. */
export const KNOWN_SENTENCE_MODELS = ["Xenova/bge-small-en-v1.5", "Xenova/all-MiniLM-L6-v2", "Xenova/gte-small", "Xenova/paraphrase-multilingual-MiniLM-L12-v2", "Xenova/multilingual-e5-small", "onnx-community/bge-small-en-v1.5", "onnx-community/all-MiniLM-L6-v2"] as const;

/** The first known sentence model present on disk (with a config and an ONNX file), or null. Reads the directory only. */
export function findLocalSentenceModel(modelsDir: string): string | null {
  for (const m of KNOWN_SENTENCE_MODELS) {
    const dir = join(modelsDir, m);
    if (!existsSync(join(dir, "config.json"))) continue;
    const onnx = join(dir, "onnx");
    if (existsSync(onnx) && readdirSync(onnx).some((f) => f.endsWith(".onnx"))) return m;
  }
  return null;
}

type Extractor = (texts: string[], o: { pooling: "mean"; normalize: true }) => Promise<{ tolist(): number[][] }>;

export class TransformersEmbedder implements Embedder {
  readonly version = "1";
  dim = 0;
  private extractor: Promise<Extractor> | null = null;
  constructor(readonly model: string, private readonly modelsDir: string) {}

  /** Loads the model from `modelsDir/<model>` only. */
  private load(): Promise<Extractor> {
    this.extractor ??= (async () => {
      if (findLocalSentenceModel(this.modelsDir) === null && !existsSync(join(this.modelsDir, this.model, "config.json"))) {
        throw new Error(`No sentence-embedding model at ${join(this.modelsDir, this.model)}. This code never downloads one. Place the files of ${this.model} there (config.json, tokenizer files and onnx/model*.onnx) after the model has been approved.`);
      }
      const name = "@huggingface/transformers";
      const tf = (await import(name)) as { env: { localModelPath: string; allowRemoteModels: boolean; allowLocalModels: boolean }; pipeline: (task: string, model: string, o: { local_files_only: boolean }) => Promise<Extractor> };
      tf.env.localModelPath = this.modelsDir;
      tf.env.allowRemoteModels = false;
      tf.env.allowLocalModels = true;
      return tf.pipeline("feature-extraction", this.model, { local_files_only: true });
    })();
    return this.extractor;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const ex = await this.load();
    const out = (await ex([...texts], { pooling: "mean", normalize: true })).tolist();
    if (out[0]) this.dim = out[0].length;
    return out;
  }
}

/** Picks the embedder to use: a local sentence model when one is on disk, else the hash embedder, and says which and why. */
export function chooseEmbedder(modelsDir: string): { embedder: Embedder; real: boolean; note: string } {
  const m = findLocalSentenceModel(modelsDir);
  if (m) return { embedder: new TransformersEmbedder(m, modelsDir), real: true, note: `local sentence model ${m}` };
  return { embedder: new HashEmbedder(), real: false, note: `no sentence-embedding model under ${modelsDir}; using the hash embedder (wording only, not meaning). A model must be downloaded and approved: one of ${KNOWN_SENTENCE_MODELS.slice(0, 3).join(", ")}` };
}

export const dot = (a: readonly number[], b: readonly number[]): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };
