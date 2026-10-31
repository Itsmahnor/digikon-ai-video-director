import sharp from "sharp";
import type { ImageAnalysis, ImageCategory, ImageTechnical, ImageVisual } from "@digikon/contracts";
import { type PixelFacts } from "./inspect.js";
import { readText, type OcrEngine, type OcrResult } from "./ocr.js";

const PIPELINE_VERSION = "image-understanding-1";
export const CLIP_MODEL = "Xenova/clip-vit-base-patch32";
export const DESCRIBE_MODEL = "onnx-community/Florence-2-base-ft";

/**
 * What a local vision model can do. Both models run on this machine through the library Whisper already uses; their weights are downloaded once,
 * free, into storage/models. No paid service is called, and the file name is never shown to a model.
 */
export interface VisionModel {
  classifier: string;
  describer: string | null;
  /** How well each label fits, best first. */
  classify(png: Buffer, labels: readonly string[]): Promise<{ label: string; score: number }[]>;
  /** A sentence about the picture and the objects found in it. Null when no describer is available. */
  describe(png: Buffer): Promise<{ text: string; objects: string[] } | null>;
}

/** The local models, loaded on first use and run one at a time: the two together are heavy on a CPU. */
export class LocalVision implements VisionModel {
  classifier = CLIP_MODEL;
  describer: string | null = DESCRIBE_MODEL;
  private lib: Promise<typeof import("@huggingface/transformers")> | null = null;
  private clip: Promise<(img: unknown, labels: string[]) => Promise<{ label: string; score: number }[]>> | null = null;
  private florence: Promise<{ model: any; processor: any; tokenizer: any }> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: { cacheDir?: string } = {}) {}

  private load() {
    return (this.lib ??= import("@huggingface/transformers").then((m) => { if (this.opts.cacheDir) m.env.cacheDir = this.opts.cacheDir; return m; }));
  }
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async image(png: Buffer) {
    const { RawImage } = await this.load();
    return (await RawImage.fromBlob(new Blob([new Uint8Array(png)], { type: "image/png" }))).rgb();
  }

  classify(png: Buffer, labels: readonly string[]) {
    return this.serial(async () => {
      const { pipeline } = await this.load();
      this.clip ??= pipeline("zero-shot-image-classification", CLIP_MODEL, { dtype: "q8", device: "cpu" }) as never;
      try { return await (await this.clip!)(await this.image(png), [...labels]); } catch (e) { this.clip = null; throw e; }
    });
  }

  describe(png: Buffer) {
    return this.serial(async () => {
      const { Florence2ForConditionalGeneration, AutoProcessor, AutoTokenizer } = await this.load();
      this.florence ??= (async () => ({
        model: await Florence2ForConditionalGeneration.from_pretrained(DESCRIBE_MODEL, { dtype: { embed_tokens: "fp16", vision_encoder: "q8", encoder_model: "q8", decoder_model_merged: "q8" }, device: "cpu" } as never),
        processor: await AutoProcessor.from_pretrained(DESCRIBE_MODEL, {}),
        tokenizer: await AutoTokenizer.from_pretrained(DESCRIBE_MODEL),
      }))();
      try {
        const { model, processor, tokenizer } = await this.florence;
        const image = await this.image(png);
        const ask = async (task: string) => {
          const inputs = await processor(image, processor.construct_prompts(task));
          const ids = await model.generate({ ...inputs, max_new_tokens: 90 });
          return processor.post_process_generation(tokenizer.batch_decode(ids, { skip_special_tokens: false })[0], task, image.size)[task];
        };
        const text = String(await ask("<MORE_DETAILED_CAPTION>")).trim();
        const od = (await ask("<OD>")) as { labels?: string[] };
        return { text, objects: [...new Set((od.labels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean))].slice(0, 12) };
      } catch (e) { this.florence = null; throw e; }
    });
  }
}

/** Each category is described in several ways and the scores added, so one odd wording cannot decide it. Logos are one visual group; text decides which kind. */
const PROMPTS: { key: ImageCategory | "logo"; labels: string[] }[] = [
  { key: "logo", labels: ["a company logo on a plain background", "a brand logo mark with the company name", "a corporate logo design"] },
  { key: "product_photo", labels: ["a product photograph on a clean background", "a studio photo of a consumer product", "a photo of a physical object for sale"] },
  { key: "person_or_team_photo", labels: ["a photograph of a person", "a group photo of a team of people", "a portrait photo of a human face"] },
  { key: "website_screenshot", labels: ["a screenshot of a website", "a landing page in a web browser"] },
  { key: "app_screenshot", labels: ["a screenshot of a mobile app", "a phone application screen"] },
  { key: "dashboard_ui", labels: ["a screenshot of a software dashboard with tables and charts", "a business software interface with a sidebar"] },
  { key: "icon_symbol", labels: ["a simple icon", "a small flat pictogram symbol"] },
  { key: "illustration", labels: ["a drawn illustration", "a cartoon or vector artwork"] },
  { key: "background_texture", labels: ["an abstract background", "a seamless texture", "a blurred colourful wallpaper"] },
  { key: "marketing_graphic", labels: ["a marketing banner with a slogan", "a social media advertisement graphic"] },
  { key: "document_infographic", labels: ["a scanned text document", "an infographic with diagrams and text"] },
];

const PURPOSE: Record<ImageCategory, string> = {
  brand_logo: "Identifies the brand.", company_logo: "Identifies the company.", product_photo: "Shows a product.", person_or_team_photo: "Shows people, for credibility or introduction.",
  website_screenshot: "Shows a website.", app_screenshot: "Shows an application.", dashboard_ui: "Shows software in use.", icon_symbol: "Marks an idea or feature.",
  illustration: "Illustrates an idea.", background_texture: "Works as a background.", marketing_graphic: "Promotes something.", document_infographic: "Presents information.", other_unknown: "Not established.",
};
const ROLES: Record<ImageCategory, string[]> = {
  brand_logo: ["logo_reveal", "corner_mark", "closing_frame"], company_logo: ["logo_reveal", "corner_mark", "closing_frame"], product_photo: ["hero", "detail_shot", "feature_highlight"],
  person_or_team_photo: ["team_introduction", "credibility"], website_screenshot: ["browser_frame", "interface_closeup"], app_screenshot: ["device_frame", "interface_closeup"], dashboard_ui: ["browser_frame", "zoom_to_region", "interface_closeup"],
  icon_symbol: ["inset", "feature_mark"], illustration: ["hero", "inset"], background_texture: ["background"], marketing_graphic: ["full_frame", "inset"], document_infographic: ["inset", "zoom_to_region"], other_unknown: [],
};

/** Below this the top label is not trusted on its own, and the entry says the picture is unknown. */
export const CONFIDENT = 0.35;

/** Adds up the prompt scores and turns them into the final labels. Pure, so it is tested without a model. */
export function decideCategories(scores: readonly { label: string; score: number }[], facts: { word_count: number; has_transparency: boolean; photographic: boolean; aspect_ratio: number; objects?: readonly string[] }): { categories: ImageAnalysis["categories"]; evidence: string[] } {
  const sums = new Map<string, number>();
  for (const p of PROMPTS) sums.set(p.key, p.labels.reduce((a, l) => a + (scores.find((s) => s.label === l)?.score ?? 0), 0));
  const evidence: string[] = [];
  // a page of running text is not a logo, whatever its shapes look like: logos carry a few words
  if (facts.word_count > 14 && (sums.get("logo") ?? 0) > 0.05) { sums.set("logo", (sums.get("logo") ?? 0) * 0.25); evidence.push(`${facts.word_count} words were read, more than a logo carries, so the logo score was reduced`); }
  // measured pixels and the objects found outrank a text prompt: a photograph of people at laptops is not a screen capture
  const shrink = (keys: readonly string[], by: number) => { for (const k of keys) sums.set(k, (sums.get(k) ?? 0) * by); };
  const SCREENS = ["website_screenshot", "app_screenshot", "dashboard_ui"];
  if (facts.photographic) { shrink(SCREENS, 0.3); evidence.push("measured: its pixels are photographic, not flat like a screen capture, so the screenshot scores were reduced"); }
  if ((facts.objects ?? []).some((o) => /\b(person|man|woman|human face|people)\b/.test(o)) && facts.photographic) { sums.set("person_or_team_photo", (sums.get("person_or_team_photo") ?? 0) * 2.5); evidence.push(`people were detected (${facts.objects!.slice(0, 4).join(", ")})`); }
  if (facts.aspect_ratio < 0.85 && facts.word_count > 20) { shrink(["dashboard_ui", "website_screenshot"], 0.4); evidence.push("a tall page of running text reads as a document, so the screen scores were reduced"); }
  const total = [...sums.values()].reduce((a, b) => a + b, 0) || 1;
  const ranked = [...sums.entries()].map(([k, v]) => ({ key: k, score: v / total })).sort((a, b) => b.score - a.score);
  evidence.push(`classifier: ${ranked.slice(0, 3).map((r) => `${r.key} ${r.score.toFixed(2)}`).join(", ")}`);
  const top = ranked[0]!;
  const chosen = ranked.filter((r) => r.score >= 0.2 && r.score >= top.score * 0.45).slice(0, 3);
  const categories: ImageAnalysis["categories"] = [];
  for (const r of chosen) {
    if (r.key === "logo") {
      if (facts.word_count > 0) { categories.push({ category: "company_logo", confidence: round(r.score) }, { category: "brand_logo", confidence: round(r.score * 0.9) }); evidence.push("the logo carries readable words, so it is treated as a company logo"); }
      else { categories.push({ category: "brand_logo", confidence: round(r.score) }); evidence.push("no words were read in the mark, so it is treated as a brand mark"); }
    } else categories.push({ category: r.key as ImageCategory, confidence: round(r.score) });
  }
  if (top.score < CONFIDENT) { categories.unshift({ category: "other_unknown", confidence: round(1 - top.score) }); evidence.push(`the best label reached only ${top.score.toFixed(2)}, below ${CONFIDENT}, so nothing is claimed`); }
  if (facts.has_transparency) evidence.push("measured: the picture has transparent pixels");
  return { categories, evidence };
}
const round = (n: number) => Math.round(n * 1000) / 1000;

export const ALL_PROMPTS: readonly string[] = PROMPTS.flatMap((p) => p.labels);

export interface AnalyseInput {
  technical: ImageTechnical;
  facts: PixelFacts;
  /** The picture the classifier and OCR see: the original, or its trimmed copy when padding would mislead them. */
  viewPath: string;
  /** The picture the describer sees: always the whole original, because a tight crop of a logo reads as a sign. */
  describePath: string;
  /** Whether the pixels measured as a photograph rather than flat graphics or a screen. */
  photographic: boolean;
  vision: VisionModel | null;
  ocr: readonly OcrEngine[];
}

/**
 * What this picture is, as far as the models can tell. Each part stands alone: if the describer fails the labels are kept and the status says "partial";
 * if classification fails the status is "failed" and retryable, and no label or description is made up.
 */
export async function analyseImage(input: AnalyseInput): Promise<ImageAnalysis> {
  const { technical, facts, vision } = input;
  const model = { classifier: null as string | null, describer: null as string | null, ocr: null as string | null, pipeline_version: PIPELINE_VERSION };
  const prepare = (p: string) => sharp(p, { animated: false }).rotate().flatten({ background: facts.background.kind === "transparent" ? "#ffffff" : (facts.background.colour ?? "#ffffff") }).resize(768, 768, { fit: "inside", withoutEnlargement: false }).png().toBuffer();
  const png = await prepare(input.viewPath);
  const ocr: OcrResult = await readText(input.viewPath, input.ocr).catch(() => ({ status: "failed" as const, engine: null, text: "", lines: [] }));
  model.ocr = ocr.engine;
  const evidence: string[] = [];
  if (ocr.status === "unavailable") evidence.push("no local OCR engine is available, so visible text was not read");
  if (ocr.status === "failed") evidence.push("OCR failed, so visible text was not read");

  let categories: ImageAnalysis["categories"] = [];
  let error: string | null = null;
  let description: string | null = null, subjects: string[] = [];
  if (!vision) error = "No vision model is available on this machine.";
  else {
    try {
      const scores = await vision.classify(png, ALL_PROMPTS);
      model.classifier = vision.classifier;
      if (vision.describer) {
        try {
          const d = await vision.describe(await prepare(input.describePath));
          if (d?.text) { description = d.text.slice(0, 800); subjects = d.objects; model.describer = vision.describer; }
        } catch (e) { evidence.push(`the describer failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`); }
      }
      const d = decideCategories(scores, { word_count: ocr.text.split(/\s+/).filter(Boolean).length, has_transparency: technical.transparent_share > 0.01, photographic: input.photographic, aspect_ratio: technical.aspect_ratio, objects: subjects });
      categories = d.categories;
      evidence.push(...d.evidence);
    } catch (e) { error = `The vision model could not run: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`; }
  }
  const primary = categories.find((c) => c.category !== "other_unknown")?.category ?? "other_unknown";
  const visual: ImageVisual = {
    description, purpose: categories.length ? PURPOSE[primary] : null, subjects, ocr,
    dominant_colours: facts.dominant_colours, background: facts.background, composition: facts.composition,
    suitable_roles: [...new Set(categories.flatMap((c) => ROLES[c.category]))].slice(0, 12),
  };
  if (error) return { status: "failed", analysed_at: new Date().toISOString(), model, categories: [], visual, evidence, error, retryable: true };
  const whole = !!description && ocr.status !== "failed" && ocr.status !== "unavailable";
  // a part that failed can be tried again; a part this machine does not have cannot
  return { status: whole ? "analyzed" : "partial", analysed_at: new Date().toISOString(), model, categories, visual, evidence, error: null, retryable: ocr.status === "failed" || (!!vision?.describer && !description) };
}
