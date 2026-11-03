import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The look embedding of a rendered preview frame: CLIP (Xenova/clip-vit-base-patch32, q8), run locally from storage/models. It downloads nothing and
 * calls no service. The frame is turned into one unit vector; two frames that look alike are close in cosine similarity.
 */

export const LOOK_MODEL = "Xenova/clip-vit-base-patch32";
export const LOOK_MODEL_VERSION = "q8-image_embeds-1";

export interface LookEmbedder { model: string; version: string; embedImage(png: Uint8Array): Promise<number[]> }

export const localLookModelExists = (modelsDir: string): boolean => existsSync(join(modelsDir, "Xenova", "clip-vit-base-patch32", "onnx", "model_quantized.onnx"));

const unit = (v: number[]): number[] => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / n); };

export class ClipLookEmbedder implements LookEmbedder {
  readonly model = LOOK_MODEL;
  readonly version = LOOK_MODEL_VERSION;
  private ready: Promise<{ proc: (img: unknown) => Promise<{ pixel_values: unknown }>; model: (i: Record<string, unknown>) => Promise<{ image_embeds: { data: Float32Array } }>; ids: unknown; mask: unknown; RawImage: { fromBlob(b: Blob): Promise<unknown> } }> | null = null;
  constructor(private readonly modelsDir: string) {}

  private load() {
    return (this.ready ??= (async () => {
      if (!localLookModelExists(this.modelsDir)) throw new Error(`The CLIP model is not on disk under ${this.modelsDir}; this tool never downloads one.`);
      const tf = (await import("@huggingface/transformers")) as unknown as Record<string, any>;
      tf["env"].localModelPath = this.modelsDir;
      tf["env"].allowRemoteModels = false;
      tf["env"].allowLocalModels = true;
      const opts = { local_files_only: true, dtype: "q8" };
      const [proc, tok, model] = await Promise.all([tf["AutoProcessor"].from_pretrained(LOOK_MODEL, { local_files_only: true }), tf["AutoTokenizer"].from_pretrained(LOOK_MODEL, { local_files_only: true }), tf["CLIPModel"].from_pretrained(LOOK_MODEL, opts)]);
      const t = tok("a", { padding: true, truncation: true }); // the full model wants text inputs too; only the image embedding is used
      return { proc, model, ids: t.input_ids, mask: t.attention_mask, RawImage: tf["RawImage"] };
    })());
  }

  async embedImage(png: Uint8Array): Promise<number[]> {
    const m = await this.load();
    const img = await m.RawImage.fromBlob(new Blob([png as BlobPart], { type: "image/png" }));
    const px = await m.proc(img);
    const out = await m.model({ input_ids: m.ids, attention_mask: m.mask, pixel_values: px.pixel_values });
    return unit(Array.from(out.image_embeds.data));
  }
}
