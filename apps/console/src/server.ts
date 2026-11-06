import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { AnthropicClient, DemoClient, SkillLibrary } from "@digikon/director";
import { CachedEmbedder, KeywordRetriever, MemoryDataStore, SKILLS_KEYWORD_FLOOR, SKILLS_LOCAL_OPTIONS, chooseEmbedder, createDbBackedRetriever, createLocalHybridRetriever, describeRetrieval, loadKnowledge, loadSkillDocs, openStore, recipeDocs, skillDoc, type Doc, type RetrievalStatus, type Retriever } from "@digikon/rag";
import { buildInspiration, ingestTemplateText, loadLibrary } from "@digikon/templates";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import { detectAudio, loadCapabilityRegistry, migrateLegacyStore } from "@digikon/render";
import { LocalVision, availableOcr } from "@digikon/media";
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
// Validated learned capabilities live here. They are loaded by the render registry and marked on the recipes, so retrieval knows which recipes have a working template.
const capabilitiesDir = join(repoRoot, "capabilities");
const migration = migrateLegacyStore(capabilitiesDir); // version 1 files become registry records, evidence unchanged; the old files are left in place
if (migration.migrated.length) console.log(`Migrated learned capabilities to the registry: ${migration.migrated.join(", ")}`);
for (const problem of migration.problems) console.warn(`Not migrated: ${problem}`);
const learned = loadCapabilityRegistry(capabilitiesDir, { recipes: library });
for (const problem of learned.problems) console.warn(`Ignored capability record: ${problem}`);
for (const u of learned.unusable.filter((x) => x.record.status === "validated")) console.warn(`Capability ${u.record.capability_id} is not usable here: ${u.reason}`);
// Which recipes can be carried out is not decided here: the console asks the capability registry per request (see `retrieverFor`), so nothing fixed at start-up can go stale.
// Skills. The shipped ones are files under examples/skills; with DATABASE_URL set they are read from the database instead (import them with `npm run skills -- import examples/skills`).
// Every shipped skill is a draft, so none is retrieved unless SKILLS_INCLUDE_DRAFT=1. That switch only widens what may be read; it promotes nothing and no approval or render gate sees it.
const skillsIncludeDraft = process.env.SKILLS_INCLUDE_DRAFT === "1";
let skillDocs: Doc[] = loadSkillDocs(join(repoRoot, "examples", "skills"));
let skillsFrom = "files (examples/skills)";
let buildDbRetriever: ((docs: Doc[]) => Retriever) | null = null;
// Which retriever is running is decided here and then said out loud: in the log, on /api/health and as a banner in the console when it is degraded.
const degraded: string[] = [];
const modelsDir = join(repoRoot, "storage", "models");
const chosen = chooseEmbedder(modelsDir);
const embedder = chosen.real ? new CachedEmbedder(chosen.embedder, join(repoRoot, "storage", "index", `${chosen.embedder.model.replace(/[\/]/g, "_")}@${chosen.embedder.version}.json`)) : chosen.embedder;
let mode: RetrievalStatus["mode"] = "bm25-only";
if (!chosen.real) degraded.push(`No sentence-embedding model under storage/models, so search matches words, not meaning. Place Xenova/bge-small-en-v1.5 there (nothing is downloaded automatically).`);
if (process.env.DATABASE_URL) {
  try {
    const store = await openStore();
    const health = await store.health();
    if (!health.ok) throw new Error(health.detail);
    const rows = await store.listSkills();
    skillDocs = rows.map(skillDoc).filter((d): d is Doc => d !== null);
    skillsFrom = `Postgres (${rows.length} skills)`;
    if (rows.length === 0) throw new Error("the skills table is empty: run `npm run skills -- import examples/skills`");
    if (!chosen.real) throw new Error("no real embedding model, so database vectors would be meaningless");
    buildDbRetriever = await createDbBackedRetriever(store, embedder, [...recipeDocs(recipes), ...knowledge], SKILLS_LOCAL_OPTIONS);
    mode = "pgvector-hybrid";
  } catch (e) {
    degraded.push(`DATABASE_URL is set but the database cannot be used (${e instanceof Error ? e.message : String(e)}); using ${chosen.real ? "the in-process index" : "keyword search"} with skills from files.`);
    skillDocs = loadSkillDocs(join(repoRoot, "examples", "skills"));
    skillsFrom = "files (examples/skills)";
    buildDbRetriever = null;
  }
}
if (!buildDbRetriever && chosen.real) {
  // No Docker needed: embed every document once (cached on disk), hold the vectors in memory, search with the same hybrid retriever.
  try {
    buildDbRetriever = await createLocalHybridRetriever(embedder, [...recipeDocs(recipes), ...knowledge, ...skillDocs], SKILLS_LOCAL_OPTIONS);
    (embedder as CachedEmbedder).save();
    mode = "memory-hybrid";
  } catch (e) { degraded.push(`The in-process vector index could not be built (${e instanceof Error ? e.message : String(e)}); using keyword search.`); }
}
console.log(`Skills: ${skillDocs.length} from ${skillsFrom}; draft skills ${skillsIncludeDraft ? "ARE" : "are not"} retrieved (SKILLS_INCLUDE_DRAFT).`);
// Template library as layout inspiration for the Director (in-process: files -> text embeddings -> memory store). Needs a real embedder; otherwise it is off, and that is reported.
let templates: Awaited<ReturnType<typeof buildInspiration>> | undefined;
if (mode !== "bm25-only") {
  try {
    const records = loadLibrary(join(repoRoot, "templates")).flatMap((l) => (l.record ? [l.record] : []));
    if (records.length) {
      const tstore = new MemoryDataStore();
      await ingestTemplateText(tstore, embedder, records);
      (embedder as CachedEmbedder).save();
      templates = await buildInspiration(tstore, embedder);
    } else degraded.push("No template files found under templates/, so the Director gets no layout inspiration.");
  } catch (e) { degraded.push(`Template inspiration is off (${e instanceof Error ? e.message : String(e)}).`); }
} else degraded.push("Template inspiration is off because meaning-based search is off.");
const retrievalStatus: RetrievalStatus = {
  mode, embedder: { model: chosen.embedder.model, version: chosen.embedder.version, real: chosen.real },
  counts: { skills: skillDocs.length, templates: templates?.count ?? 0, recipes: recipes.length, notes: knowledge.length }, degraded,
  vectors: embedder instanceof CachedEmbedder ? `${embedder.hits} from cache, ${embedder.misses} computed` : null,
};
console.log(describeRetrieval(retrievalStatus));
const retrieverFor = (implemented?: ReadonlySet<string>, validated?: ReadonlySet<string>): Retriever => {
  const docs = [...recipeDocs(recipes, implemented ? { implemented, ...(validated ? { validated } : {}) } : {}), ...knowledge, ...skillDocs];
  return buildDbRetriever ? buildDbRetriever(docs) : new KeywordRetriever(docs, 1.5, 0.75, SKILLS_KEYWORD_FLOOR);
};
const retriever = retrieverFor();const skills = new SkillLibrary(join(repoRoot, "skills"));

const speech = new WhisperEngine({ cacheDir: process.env.WHISPER_CACHE_DIR ? resolve(repoRoot, process.env.WHISPER_CACHE_DIR) : join(repoRoot, "storage", "models") });
let whisper: WhisperStatus = { state: "loading" };
speech.warmUp().then(() => { whisper = { state: "ready" }; console.log(`Whisper ready (${speech.model})`); }).catch((e) => { whisper = { state: "error", error: e instanceof Error ? e.message : String(e) }; console.error("Whisper failed to load:", whisper.error); });

const llm = demo ? new DemoClient({ creative: true, compose: true }) : process.env.ANTHROPIC_API_KEY ? new AnthropicClient() : null;
if (!llm) console.warn("No ANTHROPIC_API_KEY: the console runs, but routing and planning need a key (or --demo).");

// The preview renderer draws text with one font file. RENDER_FONT_FILE names it; otherwise a common system font is used if present.
const renderFont = [process.env.RENDER_FONT_FILE ? resolve(repoRoot, process.env.RENDER_FONT_FILE) : "", "C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => f && existsSync(f)) ?? null;
if (!renderFont) console.warn("No font file found for preview renders. Set RENDER_FONT_FILE to a .ttf file to enable them.");

const app = createApp({
  llm, demo, speech, whisper: () => whisper, skills, retriever, retrieverFor, retrievalStatus, ...(templates ? { templates } : {}), knowledge: [...knowledge, ...skillDocs], skillsIncludeDraft, recipes: library, ffmpegOk,
  vision: new LocalVision({ cacheDir: process.env.WHISPER_CACHE_DIR ? resolve(repoRoot, process.env.WHISPER_CACHE_DIR) : join(repoRoot, "storage", "models") }), ocr: await availableOcr(),
  editorSkills: new SkillLibrary(join(repoRoot, "skills", "editor")), renderFont, capabilitiesDir, audio: detectAudio(),
  storageDir: join(repoRoot, "storage"), publicDir: join(repoRoot, "apps", "console", "public"),
});

serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`\nDigikon Director Console: http://${host === "127.0.0.1" ? "localhost" : host}:${port}${demo ? "  [DEMO MODE: canned answers, not Claude]" : ""}`);
});
