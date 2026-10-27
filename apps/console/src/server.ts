import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { AnthropicClient, DemoClient, SkillLibrary } from "@digikon/director";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import { WhisperEngine } from "@digikon/speech";
import { createApp, type WhisperStatus } from "./app.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
if (!process.env.ANTHROPIC_API_KEY) delete process.env.ANTHROPIC_API_KEY;
try { process.loadEnvFile(join(repoRoot, ".env")); } catch { /* optional */ }

const demo = process.argv.includes("--demo") || process.env.DEMO === "1";
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1"; // local only. Do not expose this console to a network without auth.

const ffmpegOk = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
if (!ffmpegOk) console.warn("FFmpeg/ffprobe not found on PATH: uploads and transcription will fail.");

const recipes = loadRecipes(join(repoRoot, "recipes"));
// Development default: draft recipes are allowed until templates are test-rendered and reviewed.
const library = new RecipeLibrary(recipes, process.env.RECIPES_MODE === "reviewed" ? "reviewed" : "draft");
const knowledge = loadKnowledge(join(repoRoot, "knowledge"));
const retriever = new KeywordRetriever([...recipeDocs(recipes), ...knowledge]);
const skills = new SkillLibrary(join(repoRoot, "skills"));

const speech = new WhisperEngine({ cacheDir: process.env.WHISPER_CACHE_DIR ? resolve(repoRoot, process.env.WHISPER_CACHE_DIR) : join(repoRoot, "storage", "models") });
let whisper: WhisperStatus = { state: "loading" };
speech.warmUp().then(() => { whisper = { state: "ready" }; console.log(`Whisper ready (${speech.model})`); }).catch((e) => { whisper = { state: "error", error: e instanceof Error ? e.message : String(e) }; console.error("Whisper failed to load:", whisper.error); });

const llm = demo ? new DemoClient() : process.env.ANTHROPIC_API_KEY ? new AnthropicClient() : null;
if (!llm) console.warn("No ANTHROPIC_API_KEY: the console runs, but routing and planning need a key (or --demo).");

// The preview renderer draws text with one font file. RENDER_FONT_FILE names it; otherwise a common system font is used if present.
const renderFont = [process.env.RENDER_FONT_FILE ? resolve(repoRoot, process.env.RENDER_FONT_FILE) : "", "C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => f && existsSync(f)) ?? null;
if (!renderFont) console.warn("No font file found for preview renders. Set RENDER_FONT_FILE to a .ttf file to enable them.");

const app = createApp({
  llm, demo, speech, whisper: () => whisper, skills, retriever, knowledge, recipes: library, ffmpegOk,
  editorSkills: new SkillLibrary(join(repoRoot, "skills", "editor")), renderFont,
  storageDir: join(repoRoot, "storage"), publicDir: join(repoRoot, "apps", "console", "public"),
});

serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`\nDigikon Director Console: http://${host === "127.0.0.1" ? "localhost" : host}:${port}${demo ? "  [DEMO MODE: canned answers, not Claude]" : ""}`);
});
