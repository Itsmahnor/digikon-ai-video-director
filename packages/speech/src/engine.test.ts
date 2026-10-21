import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Transcript } from "@digikon/contracts";
import { WhisperEngine, buildSegments, isNonSpeechTranscript, pickLanguage, speechActivity, transcribeFile, type SpeechEngine } from "./index.js";

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe("buildSegments", () => {
  it("splits at sentence ends and long pauses", () => {
    const segs = buildSegments([w(" Hello", 0, 0.4), w(" there.", 0.4, 0.9), w(" Next", 1.0, 1.3), w(" one", 1.3, 1.6), w(" later", 3.0, 3.4)]);
    expect(segs.map((s) => s.text)).toEqual(["Hello there.", "Next one", "later"]);
    expect(segs[1]).toMatchObject({ start: 1.0, end: 1.6 });
  });
  it("caps words per segment and handles non-Latin sentence marks", () => {
    const many = Array.from({ length: 30 }, (_, i) => w(` w${i}`, i * 0.2, i * 0.2 + 0.15));
    expect(buildSegments(many).length).toBe(3);
    expect(buildSegments([w(" یہ", 0, 0.3), w(" ٹھیک ہے۔", 0.3, 0.8), w(" اگلا", 0.9, 1.2)]).length).toBe(2);
  });
  it("returns nothing for no words", () => expect(buildSegments([])).toEqual([]));
});

describe("isNonSpeechTranscript", () => {
  it("recognises Whisper's non-speech tags", () => {
    for (const t of ["Music", " [MUSIC] ", "(applause)", "♪ Music ♪", "Music. Applause.", ""]) expect(isNonSpeechTranscript(t), t).toBe(true);
  });
  it("keeps real speech, including speech that mentions music", () => {
    for (const t of ["I love this music", "Hello there", "یہ موسیقی ہے", "Make an ad"]) expect(isNonSpeechTranscript(t), t).toBe(false);
  });
});

describe("pickLanguage", () => {
  it("returns the most likely language with its share", () => {
    const r = pickLanguage(["en", "ur", "hi"], [5, 1, 0]);
    expect(r.code).toBe("en");
    expect(r.confidence).toBeGreaterThan(0.9);
  });
  it("reports low confidence when languages are close", () => {
    expect(pickLanguage(["ur", "hi"], [2, 1.9]).confidence).toBeLessThan(0.6);
  });
});

describe("speechActivity", () => {
  it("treats silence as inactive and a tone as active", () => {
    expect(speechActivity(new Float32Array(16000 * 2)).activeShare).toBe(0);
    const tone = Float32Array.from({ length: 16000 * 2 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 16000));
    expect(speechActivity(tone).activeShare).toBeGreaterThan(0.95);
  });
});

describe("transcribeFile guards", () => {
  let dir: string;
  const stub: SpeechEngine = {
    model: "stub",
    transcribe: async () => Transcript.parse({ text: "ok", language: "en", language_confidence: 1, words: [], segments: [], duration_s: 1, model: "stub" }),
  };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "speech-test-"));
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "2", join(dir, "silence.wav")]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:d=3", join(dir, "tone.wav")]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses silence without calling the engine", async () => {
    expect(await transcribeFile(stub, join(dir, "silence.wav"))).toMatchObject({ ok: false, issue: { code: "no_speech" } });
  });
  it("refuses audio longer than the limit", async () => {
    expect(await transcribeFile(stub, join(dir, "tone.wav"), { maxSeconds: 1 })).toMatchObject({ ok: false, issue: { code: "too_long" } });
  });
  it("reports unreadable files", async () => {
    expect(await transcribeFile(stub, join(dir, "missing.wav"))).toMatchObject({ ok: false, issue: { code: "decode_failed" } });
  });
  it("refuses a transcript that is only a music tag", async () => {
    const musicOnly: SpeechEngine = { model: "stub", transcribe: async () => Transcript.parse({ text: " Music", language: "en", language_confidence: 0.5, words: [], segments: [], duration_s: 3, model: "stub" }) };
    expect(await transcribeFile(musicOnly, join(dir, "tone.wav"))).toMatchObject({ ok: false, issue: { code: "no_speech" } });
  });
  it("passes valid audio to the engine", async () => {
    expect((await transcribeFile(stub, join(dir, "tone.wav"))).ok).toBe(true);
  });
});

// Real model run: only when real speech and a cached model are available (set up by the dev machine, skipped in clean CI).
const root = fileURLToPath(new URL("../../../", import.meta.url));
const speech = join(root, "storage/fixtures/en.wav");
const cache = join(root, "storage/models");
describe.skipIf(!existsSync(speech) || !existsSync(cache))("WhisperEngine (local model)", () => {
  it("detects English and returns word timings for real speech", async () => {
    const engine = new WhisperEngine({ model: "Xenova/whisper-base", cacheDir: cache });
    const r = await transcribeFile(engine, speech);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript.language).toBe("en");
    expect(r.transcript.language_confidence).toBeGreaterThan(0.9);
    expect(r.transcript.text.toLowerCase()).toContain("coffee roaster");
    expect(r.transcript.words.length).toBeGreaterThan(15);
    expect(r.transcript.words.at(-1)!.end).toBeLessThan(r.transcript.duration_s + 0.5);
    expect(r.transcript.segments.length).toBeGreaterThan(1);
  }, 120_000);
});
