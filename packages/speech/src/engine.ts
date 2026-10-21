import { Transcript, type TranscriptSegment, type TranscriptWord } from "@digikon/contracts";
import { decodeToPcm16k, MEDIA_LIMITS } from "@digikon/media";
import { WHISPER_LANGUAGES } from "./languages.js";

const SAMPLE_RATE = 16000;

export interface SpeechIssue {
  code: "no_speech" | "too_long" | "decode_failed" | "engine_failed";
  message: string;
}
export type SpeechResult = { ok: true; transcript: Transcript } | { ok: false; issue: SpeechIssue };

export interface SpeechEngine {
  readonly model: string;
  transcribe(pcm: Float32Array, opts?: { language?: string }): Promise<Transcript>;
}

// ---------- pure helpers (unit tested) ----------

/** Share of 100 ms windows whose loudness is above a quiet-room floor. Whisper invents text on silence, so we gate on this. */
export function speechActivity(pcm: Float32Array): { activeShare: number; firstActiveSample: number; rms: number } {
  const win = SAMPLE_RATE / 10;
  let active = 0, total = 0, first = -1, sumSq = 0;
  for (let i = 0; i + win <= pcm.length; i += win) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += pcm[j]! * pcm[j]!;
    const rms = Math.sqrt(s / win);
    sumSq += s;
    total++;
    if (rms > 0.004) { active++; if (first < 0) first = i; }
  }
  return { activeShare: total ? active / total : 0, firstActiveSample: Math.max(first, 0), rms: Math.sqrt(sumSq / Math.max(total * win, 1)) };
}

const NON_SPEECH = new Set([
  "music", "musica", "applause", "laughter", "laughing", "silence", "noise", "sound", "sounds", "singing", "song",
  "instrumental", "inaudible", "unintelligible", "static", "beep", "bleep", "cheering", "crowd", "cough", "coughing",
]);

/**
 * Whisper writes tags like "Music" or "[Applause]" when it hears no speech. A transcript made only of such tags is not speech.
 * Energy checks cannot catch this, because music is loud.
 */
export function isNonSpeechTranscript(text: string): boolean {
  const words = text.toLowerCase().replace(/[\[\]()*♪♫_.,!?\-]/g, " ").split(/\s+/).filter(Boolean);
  return words.length === 0 || words.every((w) => NON_SPEECH.has(w));
}

/** Groups words into caption-sized phrases: break at sentence ends, long pauses, or a word cap. */
export function buildSegments(words: TranscriptWord[], opts: { maxWords?: number; maxGapS?: number } = {}): TranscriptSegment[] {
  const maxWords = opts.maxWords ?? 12;
  const maxGap = opts.maxGapS ?? 0.8;
  const out: TranscriptSegment[] = [];
  let cur: TranscriptWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ text: cur.map((w) => w.text).join("").trim(), start: cur[0]!.start, end: cur[cur.length - 1]!.end });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > maxGap) flush();
    cur.push(w);
    if (/[.!?。！？؟۔।॥]\s*$/.test(w.text) || cur.length >= maxWords) flush();
  }
  flush();
  return out;
}

/** Softmax over a subset of logits. Returns the best index and its probability among that subset. */
export function pickLanguage(codes: string[], logits: number[]): { code: string; confidence: number } {
  const mx = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - mx));
  const sum = exps.reduce((a, b) => a + b, 0);
  let best = 0;
  exps.forEach((e, i) => { if (e > exps[best]!) best = i; });
  return { code: codes[best]!, confidence: exps[best]! / sum };
}

// ---------- Whisper via transformers.js, running locally ----------

interface Asr {
  (audio: Float32Array, opts: Record<string, unknown>): Promise<{ text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;
  tokenizer: { convert_tokens_to_ids(t: string): number };
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  model: { forward(i: Record<string, unknown>): Promise<{ logits: { data: Float32Array } }> };
}

export interface WhisperOptions {
  /** Hugging Face model id. Must be an export with attention outputs (the Xenova/* exports) for word timestamps. */
  model?: string;
  cacheDir?: string;
}

export class WhisperEngine implements SpeechEngine {
  readonly model: string;
  private readonly cacheDir?: string;
  private loading?: Promise<Asr>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: WhisperOptions = {}) {
    this.model = opts.model ?? (process.env.WHISPER_MODEL || "Xenova/whisper-base");
    this.cacheDir = opts.cacheDir ?? (process.env.WHISPER_CACHE_DIR || undefined);
  }

  private load(): Promise<Asr> {
    this.loading ??= (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      if (this.cacheDir) env.cacheDir = this.cacheDir;
      return (await pipeline("automatic-speech-recognition", this.model, { dtype: "q8", device: "cpu" })) as unknown as Asr;
    })();
    this.loading.catch(() => { this.loading = undefined; }); // allow retry after a failed download
    return this.loading;
  }

  /** Loads the model now so the first user request is not slow. Safe to call repeatedly. */
  async warmUp(): Promise<void> { await this.load(); }

  async transcribe(pcm: Float32Array, opts: { language?: string } = {}): Promise<Transcript> {
    // One job at a time: the model is CPU-bound and not safe to run concurrently in one process.
    const job = this.chain.then(() => this.run(pcm, opts));
    this.chain = job.catch(() => undefined);
    return job;
  }

  private async run(pcm: Float32Array, opts: { language?: string }): Promise<Transcript> {
    const asr = await this.load();
    const activity = speechActivity(pcm);
    const { Tensor } = await import("@huggingface/transformers");

    let language = opts.language?.toLowerCase();
    let confidence = 1;
    if (!language) {
      const from = Math.max(0, activity.firstActiveSample - SAMPLE_RATE / 2);
      const window = pcm.slice(from, from + 30 * SAMPLE_RATE);
      const sot = asr.tokenizer.convert_tokens_to_ids("<|startoftranscript|>");
      const codes = Object.keys(WHISPER_LANGUAGES).filter((c) => {
        const id = asr.tokenizer.convert_tokens_to_ids(`<|${c}|>`);
        return typeof id === "number" && id > sot;
      });
      const inputs = await asr.processor(window);
      const out = await asr.model.forward({
        input_features: inputs.input_features,
        decoder_input_ids: new Tensor("int64", BigInt64Array.from([BigInt(sot)]), [1, 1]),
      });
      const picked = pickLanguage(codes, codes.map((c) => out.logits.data[asr.tokenizer.convert_tokens_to_ids(`<|${c}|>`)]!));
      language = picked.code;
      confidence = picked.confidence;
    }

    const res = await asr(pcm, { language, task: "transcribe", return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 });
    const words: TranscriptWord[] = (res.chunks ?? [])
      .filter((c) => c.text.trim() !== "")
      .map((c) => ({ text: c.text, start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] }));

    const warnings: Transcript["warnings"] = [];
    if (confidence < 0.6) warnings.push("low_language_confidence");
    if (activity.rms < 0.01) warnings.push("very_quiet_audio");
    return Transcript.parse({
      text: res.text.trim(),
      language,
      language_confidence: confidence,
      words,
      segments: buildSegments(words),
      duration_s: Math.round((pcm.length / SAMPLE_RATE) * 100) / 100,
      model: this.model,
      warnings,
    });
  }
}

/** Decode, guard against silence and over-long audio, then transcribe. Never throws for bad input; returns an issue instead. */
export async function transcribeFile(
  engine: SpeechEngine,
  path: string,
  opts: { maxSeconds?: number; language?: string } = {},
): Promise<SpeechResult> {
  const maxSeconds = opts.maxSeconds ?? MEDIA_LIMITS.maxVoicePromptSeconds;
  let pcm: Float32Array;
  try {
    pcm = await decodeToPcm16k(path, maxSeconds + 1);
  } catch {
    return { ok: false, issue: { code: "decode_failed", message: "could not read the audio. Try another recording or format." } };
  }
  const seconds = pcm.length / SAMPLE_RATE;
  if (seconds > maxSeconds) {
    return { ok: false, issue: { code: "too_long", message: `audio is longer than ${maxSeconds}s. Shorten it or split it.` } };
  }
  if (seconds < 0.4 || speechActivity(pcm).activeShare < 0.03) {
    return { ok: false, issue: { code: "no_speech", message: "no speech detected. Check the microphone and try again." } };
  }
  try {
    const transcript = await engine.transcribe(pcm, { language: opts.language });
    if (isNonSpeechTranscript(transcript.text)) {
      return { ok: false, issue: { code: "no_speech", message: "only music or background noise was detected, no speech." } };
    }
    return { ok: true, transcript };
  } catch (e) {
    return { ok: false, issue: { code: "engine_failed", message: `transcription failed: ${e instanceof Error ? e.message : String(e)}` } };
  }
}
