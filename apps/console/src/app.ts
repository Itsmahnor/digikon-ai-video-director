import { createReadStream, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { z, ZodError } from "zod";
import { ApprovalSubmission, RenderSettings, AssetUsage, BrandFact, CATEGORY_LABELS, ImageCategory, VisualReview, RUNTIME_TOLERANCE_S, Turn, assetFeasibility, auditClaims, type Asset, type AssetNotes, type DirectorHandoff, type RenderRecord, type RouteResult, type Transcript } from "@digikon/contracts";
import {
  Command, HandoffRefusedError, matchAssetsToScenes, MAX_REVISIONS, PersistenceError, RunStore, StaleApprovalError, buildDirectorGraph, buildHandoff, buildRunRecord, checkRenderable, classifyLlmError, currentEditPlan, currentStoryboard,
  checkpointOf, restoreRun, runEditor, verifyHandoffWithStore,
  type DirectorStateType, type ProductionPort, type LlmClient, type SkillLibrary,
  classifyChange,
  templateOptions,
} from "@digikon/director";
import {
  AdapterRegistry, COMPOSITION_TEMPLATE, verifyProductionForRender, replanAtActualSettings, renderTimeProblems, type ProductionGate, CapabilityRegistry, buildAdapterRegistry, implementationsOf, runAdapterPreflight, DeliveryReport, FFMPEG_TEMPLATES, filmQuality, layoutConstraints, loadVisualCapabilities, logVisualQa, findCapabilityGaps, loadDeliveryReport, assemblyBlockers, planAssembly, planAudio, type AudioCapabilities, renderAssembly, saveDeliveryReport, type AssembleDeps, type AssemblePlanResult, learnGaps, loadCapabilityRegistry, HYPERFRAMES_TEMPLATES, NO_ADAPTERS, REMOTION_TEMPLATES, buildRenderEvidence, createFfmpegAdapter, createHyperframesStageAdapter, createRemotionAdapter, executeRender, loadRenderRecord, planRender, previewCoverage, runRenderQa, saveRenderEvidence, saveRenderRecord, selectRenderer,
  type PlanResult, type RenderAdapter,
  directoryStamp, KeyedCache,
  checkComposition,
  renderDraftScene,
  renderScenePreview,
} from "@digikon/render";
import { isInside, loadEditorOutput, publicRecord, renderDirs, saveEditorOutput, scrub, timelineEnd } from "./render-service.js";
import { ALL_EXTENSIONS, AssetRegistry, MEDIA_LIMITS, analyseContent, analyseMedia, buildAssetNotes, manifestEntry, measureImage, notesWithAnalysis, probeFile, understandAsset, type OcrEngine, type VisionModel } from "@digikon/media";
import type { Doc, Retriever } from "@digikon/rag";
import type { RecipeLibrary } from "@digikon/recipes";
import { routeRequest } from "@digikon/router";
import { languageName, transcribeFile, type SpeechEngine } from "@digikon/speech";

export interface WhisperStatus { state: "loading" | "ready" | "error"; error?: string }

export interface AppContext {
  /** null when no API key is configured. Routes that need a model then answer 503 with a clear message. */
  llm: (LlmClient & { model: string }) | null;
  demo: boolean;
  speech: SpeechEngine;
  whisper: () => WhisperStatus;
  skills: SkillLibrary;
  retriever: Retriever;
  /** Tests only: lets the website reader reach a local fixture server. The console never sets it. */
  websiteOptions?: ReadOptions;
  /** Let draft skills reach the Director and Editor (SKILLS_INCLUDE_DRAFT=1). Off by default, because every shipped skill is a draft. Only affects which skills may be read. */
  skillsIncludeDraft?: boolean;
  /**
   * Builds a retriever whose recipe documents are labelled with which recipes can be carried out. When set (with `capabilitiesDir`), the labels come from the capability
   * registry as it is now, and the retriever is rebuilt whenever the registry snapshot hash changes, instead of using a list fixed at start-up.
   */
  retrieverFor?: (implemented: ReadonlySet<string>, validated?: ReadonlySet<string>) => Retriever;
  /** The knowledge notes behind the retriever. Used only to name the sources in the Editor handoff; optional. */
  knowledge?: readonly Doc[];
  recipes: RecipeLibrary;
  ffmpegOk: boolean;
  storageDir: string;
  publicDir: string;
  /** Reads skills/editor. Without it the Editor route answers 503. */
  editorSkills?: SkillLibrary;
  /** The font the FFmpeg scene adapter draws with. Null or missing: no renderer is available, and the console says so. */
  renderFont?: string | null;
  /** What this machine can make for a film's sound. Absent: no audio stage, and requested sound stays an open, reported requirement. */
  audio?: AudioCapabilities;
  /** The capability registry root (for example `capabilities`; records live under `registry/<engine>`). Absent: none are loaded. */
  capabilitiesDir?: string | null;
  /** The local vision models. Null: pictures are measured and listed, and their analysis says it could not run. */
  vision?: VisionModel | null;
  /** The local OCR engines. Empty: the analysis says text was not read. */
  ocr?: readonly OcrEngine[];
}

import { registerKitRoutes, type Extraction } from "./kit-routes.js";
import { kitIsStarted } from "@digikon/director";
import { approvedFacts, type ProjectKit } from "@digikon/contracts";
import type { ReadOptions } from "@digikon/media";
import { PLAIN_CANNOT_PRODUCE, PLAIN_PLAN_CHANGED, plainEscalation, plainReasons, publicApprovals } from "./public-view.js";
type Graph = ReturnType<typeof buildDirectorGraph>;
/** Measurements and speech for one uploaded file. Built in the background after upload. */
interface AssetAnalysis {
  status: "running" | "done" | "failed";
  notes: AssetNotes | null;
  transcript: Transcript | null;
  /** Something the user should know, for example that no speech was found. */
  note: string | null;
}
interface Session {
  id: string;
  dir: string;
  assets: Asset[];
  turns: Turn[];
  route: RouteResult | null;
  facts: BrandFact[];
  analysis: Map<string, AssetAnalysis>;
  pending: Map<string, Promise<void>>;
  graph?: Graph;
  threadId?: string;
  /** True while a decision is being applied, so two submissions cannot both act on the same gate. */
  deciding?: boolean;
  /** True while a preview render runs, so two requests cannot render the same run at once. */
  rendering?: boolean;
  /** The guided-intake project kit and anything extracted from a website or file that the user has not confirmed yet. */
  kit?: ProjectKit;
  extractions?: Partial<Record<"website" | "guideline", Extraction>>;
}

const SettingsBody = z.object({ settings: z.record(z.unknown()).optional() });
const RENDER_ID = /^rn_[a-f0-9]{16}$/;

const ID = /^[a-f0-9]{12}$/;
const ASSET_ID = /^asset_[a-f0-9]{8}$/;
const MAX_REQUEST_BYTES = 400 * 1024 * 1024; // the console buffers multipart bodies; large masters belong in a later upload service

const RouteBody = z.object({
  text: z.string().trim().min(1).max(4000),
  from_voice: z.boolean().default(false),
  language: z.string().max(20).nullable().default(null),
});
const ReviewBody = z.object({
  summary: z.string().trim().min(1).max(600),
  subjects: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  has_people: z.boolean(),
  shows_product_ui: z.boolean(),
  reviewed_by: z.enum(["user", "assistant"]),
  method: z.string().trim().min(1).max(300),
});
/** What a user can say about a picture. Omitted fields stay as they are; null clears one. */
const CorrectionBody = z.object({
  description: z.string().trim().max(500).nullable().optional(),
  category: ImageCategory.nullable().optional(),
  usage: AssetUsage.optional(),
  /** The user says this is a real capture of their product, so it is shown without a concept label. */
  genuine_product_ui: z.boolean().nullable().optional(),
}).strict();
const DirectBody = z.object({
  facts: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  /** Kind of video, which decides the skills read. Unset (or null) means only the cross-cutting skills are used. */
  video_category: z.enum(["saas", "ecommerce", "general-promo"]).nullable().default(null),
  /** Chosen video type playbook. */
  video_type: z.string().nullable().default(null),
});

class HttpError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 422 | 503, readonly code: string, message: string) { super(message); }
}

export function createApp(ctx: AppContext) {
  const app = new Hono();
  const sessions = new Map<string, Session>();
  /** Last model failure that needs the owner's attention (billing, key, model). Shown in the status bar until a call succeeds. */
  let llmProblem: { code: string; message: string } | null = null;
  const noteLlm = (e: { code: string; message: string } | null) => { llmProblem = e && ['llm_billing', 'llm_auth', 'llm_model'].includes(e.code) ? { code: e.code, message: e.message } : llmProblem; };

  const assets = new AssetRegistry(join(ctx.storageDir, "assets"));
  const understanding = () => ({ registry: assets, vision: ctx.vision ?? null, ocr: ctx.ocr ?? [] });
  const session = (id: string): Session => {
    const s = ID.test(id) ? sessions.get(id) : undefined;
    if (!s) throw new HttpError(404, "no_session", "That session does not exist. Refresh the page to start a new one.");
    return s;
  };
  const needLlm = () => {
    if (!ctx.llm) throw new HttpError(503, "no_api_key", "No API key is set. Add ANTHROPIC_API_KEY to .env and restart, or start the console in demo mode.");
    return ctx.llm;
  };
  /**
   * Saves where the run stopped, so it can resume after a restart. Reports honestly: `saved: false` when the write failed,
   * in which case the progress exists only in memory until the next successful save.
   */
  const saveCheckpoint = (s: Session, state: DirectorStateType): { saved: boolean; error?: string } => {
    if (!s.threadId || !["awaiting_approval", "approved", "escalated"].includes(state.status)) return { saved: false, error: "This state is not saved: only a run waiting at a gate, approved or escalated can be resumed." };
    try {
      new RunStore(s.dir).saveCheckpoint(checkpointOf(state, { session_id: s.id, run_id: s.threadId }));
      return { saved: true };
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      return { saved: false, error: "Progress could not be saved to disk. It will be lost if the server restarts." };
    }
  };
  const guardSize = (req: Request) => {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_REQUEST_BYTES) throw new HttpError(413, "too_large", `Upload is larger than ${MAX_REQUEST_BYTES / 1048576} MB for this console.`);
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status);
    if (err instanceof StaleApprovalError) return c.json({ error: "stale_approval", message: err.message }, 409);
    if (err instanceof HandoffRefusedError) { const reasons = plainReasons(err.reasons); return c.json({ error: "handoff_refused", message: `The handoff to the Editor is refused: ${reasons.join("; ")}`, reasons }, 409); }
    if (err instanceof PersistenceError) {
      console.error(err.message);
      return c.json({ error: "not_saved", message: "The decision could not be saved to disk, so it was not applied. Check free disk space and try again." }, 503);
    }
    const llmErr = classifyLlmError(err, ctx.llm?.model);
    if (llmErr) {
      noteLlm(llmErr);
      console.error(`[model] ${llmErr.code}`);
      return c.json({ error: llmErr.code, message: llmErr.message }, llmErr.code === "llm_billing" ? 402 : llmErr.code === "llm_rate_limit" ? 429 : 502);
    }
    if (err instanceof ZodError) return c.json({ error: "invalid_request", message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400);
    console.error(err);
    return c.json({ error: "internal", message: "Something went wrong on the server. Check the console log." }, 500);
  });

  // ---------- status ----------
  app.get("/api/health", (c) => c.json({
    llm: { available: !!ctx.llm, model: ctx.llm?.model ?? null, demo: ctx.demo, problem: llmProblem },
    whisper: { model: ctx.speech.model, ...ctx.whisper() },
    ffmpeg: ctx.ffmpegOk,
    recipes: { available: ctx.recipes.available().length, mode: ctx.recipes.minStatus },
    render: { available: ctx.ffmpegOk && !!ctx.renderFont && !!ctx.editorSkills, templates: [...Object.keys(FFMPEG_TEMPLATES), ...Object.keys(REMOTION_TEMPLATES), ...Object.keys(HYPERFRAMES_TEMPLATES)], renderers: availableRenderers(), learned: loadCapabilityRegistry(ctx.capabilitiesDir, { recipes: ctx.recipes }).usable.map((x) => x.capability_id), note: "Preview renders only. Nothing is production-ready." },
    limits: { maxVoicePromptSeconds: MEDIA_LIMITS.maxVoicePromptSeconds, maxAssets: MEDIA_LIMITS.maxAssetsPerProject, maxRequestMb: MAX_REQUEST_BYTES / 1048576, extensions: ALL_EXTENSIONS },
  }));

  app.post("/api/sessions", async (c) => {
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const dir = join(ctx.storageDir, "sessions", id);
    await mkdir(join(dir, "uploads"), { recursive: true });
    sessions.set(id, { id, dir, assets: [], turns: [], route: null, facts: [], analysis: new Map(), pending: new Map() });
    return c.json({ id });
  });

  const kits = registerKitRoutes(app, { session: (id) => session(id), fail: (status, code, message) => { throw new HttpError(status, code, message); }, storageDir: ctx.storageDir, ...(ctx.websiteOptions ? { websiteOptions: ctx.websiteOptions } : {}) });

  const reviewFile = (s: Session, assetId: string) => join(s.dir, "reviews", `${assetId}.json`);
  /** The same review keyed by the picture's SHA-256: another project that uploads the same bytes finds it, and a different picture never does. */
  const sharedReviewFile = (sha256: string) => join(ctx.storageDir, "reviews", `${sha256}.json`);
  const shaOf = (s: Session, assetId: string): string | null => { const v = s.assets.find((x) => x.asset_id === assetId)?.metadata?.["sha256"]; return typeof v === "string" && /^[a-f0-9]{64}$/.test(v) ? v : null; };
  /** A stored review of a picture, read from disk. Anything that does not parse is ignored, never trusted. */
  const loadReview = (s: Session, assetId: string): VisualReview | null => {
    const sha = shaOf(s, assetId);
    for (const f of [reviewFile(s, assetId), ...(sha ? [sharedReviewFile(sha)] : [])]) {
      try { const p = VisualReview.safeParse(JSON.parse(readFileSync(f, "utf8"))); if (p.success) return p.data; } catch { /* try the next place */ }
    }
    return null;
  };
  /** Notes with the stored review of that picture added, so a review survives a restart and a new run. */
  const withReview = (s: Session, n: AssetNotes): AssetNotes => {
    const rv = loadReview(s, n.asset_id);
    return rv ? { ...n, visual_review: rv, content_summary: `${n.content_summary} Reviewed (${rv.reviewed_by}): ${rv.summary}`.trim(), uncertain: n.uncertain.filter((u) => !/Nobody has reviewed/.test(u)) } : n;
  };

  /** Measures a file and transcribes its speech without blocking the upload. The Director waits for this before planning. */
  const analyseAsset = (s: Session, asset: Asset): void => {
    if (asset.media_type === "image") {
      // What kind of picture it is is measured from its pixels with the local FFmpeg. What it SHOWS is not guessed: that needs a review (see the review route).
      s.analysis.set(asset.asset_id, { status: "running", notes: null, transcript: null, note: null });
      const still = () => s.assets.some((x) => x.asset_id === asset.asset_id);
      const imgJob = (async () => {
        try {
          const m = asset.width && asset.height ? await measureImage(asset.uri, { width: asset.width, height: asset.height }) : null;
          const known = await understandAsset(understanding(), { session_id: s.id, project_id: `proj_${s.id}` }, asset, m);
          const notes = withReview(s, buildAssetNotes(asset, null, null, m));
          if (still()) s.analysis.set(asset.asset_id, { status: "done", notes: known ? notesWithAnalysis(notes, known) : notes, transcript: null, note: m ? null : "The picture could not be measured." });
        } catch (e) {
          console.error(e);
          if (still()) s.analysis.set(asset.asset_id, { status: "failed", notes: withReview(s, buildAssetNotes(asset, null)), transcript: null, note: "The picture could not be measured, so only its size is known." });
        }
      })();
      s.pending.set(asset.asset_id, imgJob);
      void imgJob.finally(() => s.pending.delete(asset.asset_id));
      return;
    }
    s.analysis.set(asset.asset_id, { status: "running", notes: null, transcript: null, note: null });
    const stillThere = () => s.assets.some((x) => x.asset_id === asset.asset_id);
    const job = (async () => {
      let note: string | null = null;
      let transcript: Transcript | null = null;
      try {
        const m = await analyseMedia(asset.uri, {
          hasVideo: asset.media_type === "video", hasAudio: asset.audio_tracks > 0, duration_s: asset.duration ?? 0,
          framesDir: join(s.dir, "frames"), framePrefix: asset.asset_id,
        });
        if (asset.audio_tracks > 0) {
          if (ctx.whisper().state === "error") note = "Speech recognition is unavailable, so the audio was not transcribed.";
          else {
            const r = await transcribeFile(ctx.speech, asset.uri, { maxSeconds: 600 });
            if (r.ok) transcript = r.transcript;
            else note = r.issue.code === "no_speech" ? "No speech detected." : r.issue.message;
          }
        }
        const speech = transcript ? { language: transcript.language, text: transcript.text.slice(0, 1200), word_count: transcript.words.length } : null;
        if (stillThere()) s.analysis.set(asset.asset_id, { status: "done", notes: buildAssetNotes(asset, m, speech), transcript, note });
      } catch (e) {
        console.error(e);
        if (stillThere()) s.analysis.set(asset.asset_id, { status: "failed", notes: buildAssetNotes(asset, null), transcript: null, note: "Analysis failed, so this file is treated as unmeasured." });
      }
    })();
    s.pending.set(asset.asset_id, job);
    void job.finally(() => s.pending.delete(asset.asset_id));
  };

  const summary = (s: Session, assetId: string) => {
    const a = s.analysis.get(assetId);
    if (!a) return null;
    const n = a.notes;
    const flags = (f: string) => n?.quality_flags.filter((x) => x.flag === f).length ?? 0;
    return {
      asset_id: assetId, status: a.status, note: a.note,
      shots: n ? n.shots.length + 1 : null, silences: flags("silence"), black: flags("black_frames"), frozen: flags("frozen"),
      loudness_lufs: n?.loudness_lufs ?? null, speech: n?.speech ? { language: n.speech.language, word_count: n.speech.word_count } : null,
      usable_s: n ? Math.round(n.usable_segments.reduce((acc, u) => acc + u.end - u.start, 0) * 10) / 10 : null,
      image_kind: n?.image_measure?.kind ?? null, reviewed: !!n?.visual_review,
    };
  };

  app.get("/api/sessions/:id", (c) => {
    const s = session(c.req.param("id"));
    return c.json({ id: s.id, assets: s.assets, turns: s.turns, route: s.route, analysis: s.assets.map((a) => summary(s, a.asset_id)).filter(Boolean) });
  });

  // ---------- uploads ----------
  app.post("/api/sessions/:id/assets", async (c) => {
    const s = session(c.req.param("id"));
    guardSize(c.req.raw);
    const body = await c.req.parseBody({ all: true });
    const raw = body["files"];
    const files = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => typeof f !== "string");
    if (files.length === 0) throw new HttpError(400, "no_files", "No files were sent.");

    const added: Asset[] = [];
    const rejected: { name: string; issues: { code: string; message: string }[] }[] = [];
    for (const file of files) {
      const name = file.name || "upload";
      if (s.assets.length + added.length >= MEDIA_LIMITS.maxAssetsPerProject) {
        rejected.push({ name, issues: [{ code: "too_many_assets", message: `A project can hold ${MEDIA_LIMITS.maxAssetsPerProject} files.` }] });
        continue;
      }
      const ext = extname(name).toLowerCase();
      if (!ALL_EXTENSIONS.includes(ext)) {
        rejected.push({ name, issues: [{ code: "unsupported_type", message: `"${ext || "no extension"}" is not supported.` }] });
        continue;
      }
      const assetId = `asset_${randomUUID().slice(0, 8)}`;
      const path = join(s.dir, "uploads", `${assetId}${ext}`);
      // the same bytes twice in one project is one picture; another project may hold them too, with its own record
      // Hash while writing, so the content hash costs no extra read. It is checked again before any handoff.
      const hash = createHash("sha256");
      const tee = new Transform({ transform(chunk: Buffer, _enc, done) { hash.update(chunk); done(null, chunk); } });
      await pipeline(Readable.fromWeb(file.stream() as never), tee, createWriteStream(path));
      const sha = hash.digest("hex");
      const twin = s.assets.concat(added).find((a) => a.metadata?.["sha256"] === sha);
      if (twin) { await rm(path, { force: true }); rejected.push({ name, issues: [{ code: "duplicate", message: `This is the same file as ${String(twin.metadata?.["original_name"] ?? twin.asset_id)}, which is already in this project.` }] }); continue; }
      const probed = await probeFile(path, { assetId, originalName: name });
      if (probed.ok) added.push({ ...probed.asset, metadata: { ...probed.asset.metadata, sha256: sha } });
      else { await rm(path, { force: true }); rejected.push({ name, issues: probed.issues }); }
    }
    s.assets.push(...added);
    for (const a of added) analyseAsset(s, a);
    s.route = null; // the inventory changed, so an earlier routing decision no longer holds
    return c.json({ added, rejected, assets: s.assets });
  });

  app.delete("/api/sessions/:id/assets/:assetId", async (c) => {
    const s = session(c.req.param("id"));
    const assetId = c.req.param("assetId");
    const a = ASSET_ID.test(assetId) ? s.assets.find((x) => x.asset_id === assetId) : undefined;
    if (!a) throw new HttpError(404, "no_asset", "That file is not in this project.");
    s.assets = s.assets.filter((x) => x.asset_id !== assetId);
    s.analysis.delete(assetId);
    s.route = null;
    assets.removeLink(s.id, assetId);
    await rm(a.uri, { force: true });
    return c.json({ assets: s.assets });
  });

  app.get("/api/sessions/:id/files/:assetId", async (c) => {
    const s = session(c.req.param("id"));
    const a = ASSET_ID.test(c.req.param("assetId")) ? s.assets.find((x) => x.asset_id === c.req.param("assetId")) : undefined;
    if (!a) throw new HttpError(404, "no_asset", "That file is not in this project.");
    const size = (await stat(a.uri)).size;
    const ext = extname(a.uri).toLowerCase();
    const type = ({ ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": a.media_type === "audio" ? "audio/webm" : "video/webm", ".mkv": "video/x-matroska", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<string, string>)[ext] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff" };
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      return new Response(Readable.toWeb(createReadStream(a.uri, { start, end })) as never, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
    }
    return new Response(Readable.toWeb(createReadStream(a.uri)) as never, { headers: { ...headers, "Content-Length": String(size) } });
  });

  // ---------- speech ----------
  const transcribeUpload = async (c: { req: { raw: Request; parseBody: (o: { all: true }) => Promise<Record<string, unknown>> } }, dir: string, field: string, maxSeconds: number) => {
    guardSize(c.req.raw);
    const body = await c.req.parseBody({ all: true });
    const f = Array.isArray(body[field]) ? (body[field] as unknown[])[0] : body[field];
    if (!f || typeof f === "string") throw new HttpError(400, "no_audio", "No audio was sent.");
    const file = f as File;
    const tmp = join(dir, `voice_${randomUUID().slice(0, 8)}${extname(file.name || ".webm") || ".webm"}`);
    try {
      await pipeline(Readable.fromWeb(file.stream() as never), createWriteStream(tmp));
      const probed = await probeFile(tmp, { originalName: file.name || "voice.webm" });
      if (!probed.ok) throw new HttpError(422, probed.issues[0]!.code, probed.issues[0]!.message);
      if (probed.asset.media_type === "image") throw new HttpError(422, "not_audio", "That file has no audio.");
      const res = await transcribeFile(ctx.speech, tmp, { maxSeconds });
      if (!res.ok) throw new HttpError(422, res.issue.code, res.issue.message);
      return { ...res.transcript, language_name: languageName(res.transcript.language) };
    } finally {
      await rm(tmp, { force: true });
    }
  };

  app.post("/api/sessions/:id/transcribe", async (c) => {
    const s = session(c.req.param("id"));
    if (ctx.whisper().state === "error") throw new HttpError(503, "whisper_unavailable", `Speech recognition could not start: ${ctx.whisper().error}`);
    return c.json(await transcribeUpload(c, s.dir, "audio", MEDIA_LIMITS.maxVoicePromptSeconds));
  });

  app.get("/api/sessions/:id/assets/:assetId/transcript", (c) => {
    const s = session(c.req.param("id"));
    const id = c.req.param("assetId");
    const tr = ASSET_ID.test(id) ? s.analysis.get(id)?.transcript : undefined;
    if (!tr) throw new HttpError(404, "no_transcript", "There is no transcript for that file (no speech, or it is still being analysed).");
    return c.json({ ...tr, language_name: languageName(tr.language) });
  });

  // ---------- routing ----------
  app.post("/api/sessions/:id/route", async (c) => {
    const s = session(c.req.param("id"));
    const llm = needLlm();
    const body = RouteBody.parse(await c.req.json().catch(() => ({})));
    const turn = Turn.parse({ role: "user", text: body.text, from_voice: body.from_voice, language: body.language });
    const turns = [...s.turns, turn];
    const result = await routeRequest({ llm, skills: ctx.skills }, { project_id: `proj_${s.id}`, owner_id: "console-user", turns, assets: s.assets });
    llmProblem = null;
    s.turns = turns;
    if (result.status === "needs_input") s.turns = [...s.turns, Turn.parse({ role: "assistant", text: result.questions.join("\n") })];
    s.route = result;
    return c.json({ result, turns: s.turns });
  });

  // ---------- what the pictures are, and where they could go ----------
  /**
   * Records what a reviewer says a supplied picture shows. The reviewer is named (the user, or an assistant that looked at the file) and says how, and
   * nothing is stored for a file that is not a picture of this project. It changes no plan and no approval: only a later Director run reads it.
   */
  app.post("/api/sessions/:id/assets/:assetId/review", async (c) => {
    const s = session(c.req.param("id"));
    const assetId = c.req.param("assetId");
    const a = ASSET_ID.test(assetId) ? s.assets.find((x) => x.asset_id === assetId) : undefined;
    if (!a) throw new HttpError(404, "no_asset", "That file is not in this project.");
    if (a.media_type !== "image") throw new HttpError(409, "not_an_image", "Only pictures can be reviewed this way.");
    const body = ReviewBody.parse(await c.req.json().catch(() => ({})));
    const review = VisualReview.parse({ ...body, reviewed_at: new Date().toISOString() });
    await mkdir(join(s.dir, "reviews"), { recursive: true });
    const file = reviewFile(s, assetId);
    writeFileSync(`${file}.tmp`, JSON.stringify(review, null, 2), "utf8");
    renameSync(`${file}.tmp`, file);
    const sha = shaOf(s, assetId);
    if (sha) { await mkdir(join(ctx.storageDir, "reviews"), { recursive: true }); const sf = sharedReviewFile(sha); writeFileSync(`${sf}.tmp`, JSON.stringify(review, null, 2), "utf8"); renameSync(`${sf}.tmp`, sf); }
    const cur = s.analysis.get(assetId);
    const base = cur?.notes ?? buildAssetNotes(a, null);
    s.analysis.set(assetId, { status: cur?.status ?? "done", notes: withReview(s, base), transcript: null, note: cur?.note ?? null });
    return c.json({ asset_id: assetId, review, summary: summary(s, assetId) });
  });

  // ---------- the asset gallery ----------
  /** The project's picture by id, in this project only: another project's picture is simply not found here. */
  const pictureIn = (s: Session, assetId: string): Asset => {
    const a = ASSET_ID.test(assetId) ? s.assets.find((x) => x.asset_id === assetId) : undefined;
    if (!a) throw new HttpError(404, "no_asset", "That file is not in this project.");
    if (a.media_type !== "image") throw new HttpError(409, "not_an_image", "Only pictures have this.");
    return a;
  };
  /** Brings a project's pictures back after a restart, from the registry and the files on disk. Only for a project that is not already open. */
  const restoreUploads = async (id: string): Promise<Session | null> => {
    if (!ID.test(id)) return null;
    const open = sessions.get(id);
    if (open) return open;
    const links = assets.linksOf(id);
    const dir = join(ctx.storageDir, "sessions", id);
    if (!links.length || !existsSync(dir)) return null;
    const s: Session = { id, dir, assets: [], turns: [], route: null, facts: [], analysis: new Map(), pending: new Map() };
    for (const l of links) {
      const probed = await probeFile(l.original_path, { assetId: l.asset_id, originalName: l.original_filename }).catch(() => null);
      if (!probed?.ok) continue;
      const asset = { ...probed.asset, metadata: { ...probed.asset.metadata, sha256: l.content_id } };
      s.assets.push(asset);
      const known = await assets.resolve(id, l.asset_id);
      const m = asset.width && asset.height ? await measureImage(asset.uri, { width: asset.width, height: asset.height }).catch(() => null) : null;
      const notes = withReview(s, buildAssetNotes(asset, null, null, m));
      s.analysis.set(l.asset_id, { status: "done", notes: known ? notesWithAnalysis(notes, known) : notes, transcript: null, note: null });
    }
    sessions.set(id, s);
    return s;
  };
  /** Which scenes of the current run place each picture, and whether that plan has been approved. */
  const storyboardUse = async (s: Session) => {
    const use = new Map<string, string[]>();
    let approved = false;
    if (!s.graph || !s.threadId) return { use, approved };
    const st = (await s.graph.getState({ configurable: { thread_id: s.threadId } }).catch(() => null))?.values as DirectorStateType | undefined;
    for (const sc of st?.scenePlan?.scenes ?? []) for (const id of sc.asset_ids) use.set(id, [...(use.get(id) ?? []), sc.scene_id]);
    approved = !!st?.approvals?.some((r) => r.stage === "storyboard" && r.decision === "approved" && r.plan_version === st.scenePlan?.version);
    return { use, approved };
  };

  app.get("/api/sessions/:id/gallery", async (c) => {
    const s = (await restoreUploads(c.req.param("id"))) ?? session(c.req.param("id"));
    const { use, approved } = await storyboardUse(s);
    const items = await Promise.all(s.assets.filter((a) => a.media_type === "image").map(async (a) => {
      const reg = await assets.resolve(s.id, a.asset_id);
      const t = reg?.content.technical ?? null, an = reg?.content.analysis ?? null;
      const scenes = use.get(a.asset_id) ?? [];
      const inFlight = s.pending.has(a.asset_id) || an?.status === "running" || an?.status === "pending";
      const m = reg ? manifestEntry(reg) : null;
      const stages = ["uploaded", ...(an?.status === "analyzed" || an?.status === "partial" ? ["analyzed"] : []), ...(m?.categories.some((x) => x.category !== "other_unknown") ? ["classified"] : []), ...(reg ? ["available_to_director"] : []), ...(scenes.length ? ["assigned_to_storyboard"] : []), ...(scenes.length && approved ? ["approved"] : [])];
      return {
        asset_id: a.asset_id, session_id: s.id, project_id: reg?.project_id ?? `proj_${s.id}`, original_filename: String(a.metadata?.["original_name"] ?? a.asset_id), thumbnail_url: reg?.content.thumbnail_path ? `/api/sessions/${s.id}/assets/${a.asset_id}/thumbnail` : null,
        status: inFlight ? "running" : an?.status ?? "pending", availability: reg?.availability ?? "available", error: an?.error ?? null, retryable: an?.retryable ?? false,
        categories: (reg?.effective_categories ?? []).map((x) => ({ ...x, label: CATEGORY_LABELS[x.category] })), description: reg?.effective_description ?? null,
        width: t?.width ?? a.width, height: t?.height ?? a.height, aspect_ratio: t?.aspect_ratio ?? null, format: t?.format ?? null, transparent: t ? t.transparent_share > 0.01 : null,
        visible_text: an?.visual?.ocr.lines ?? [], ocr_status: an?.visual?.ocr.status ?? null, dominant_colours: (an?.visual?.dominant_colours ?? []).slice(0, 4).map((x) => x.hex),
        model: an?.model ?? null, evidence: an?.evidence ?? [], user: reg?.user ?? null, genuine_product_ui: a.genuine_product_ui, storyboard_usage: scenes, stages, used_in_projects: reg ? assets.projectsUsing(reg.content_id).length : 1,
      };
    }));
    return c.json({ session_id: s.id, items });
  });

  app.get("/api/sessions/:id/assets/:assetId/thumbnail", async (c) => {
    const s = (await restoreUploads(c.req.param("id"))) ?? session(c.req.param("id"));
    const a = pictureIn(s, c.req.param("assetId"));
    const link = assets.getLink(s.id, a.asset_id);
    const path = link ? assets.content(link.content_id)?.thumbnail_path : null;
    if (!path || !existsSync(path)) throw new HttpError(404, "no_thumbnail", "This picture has no thumbnail yet.");
    return c.body(readFileSync(path), 200, { "content-type": "image/png", "cache-control": "no-store" });
  });

  const applyCorrection = async (s: Session, asset: Asset) => {
    const reg = await assets.resolve(s.id, asset.asset_id);
    const cur = s.analysis.get(asset.asset_id);
    if (reg && cur?.notes) s.analysis.set(asset.asset_id, { ...cur, notes: notesWithAnalysis({ ...cur.notes, uncertain: cur.notes.uncertain.filter((u) => !reg || !/^(Analysis |The classifier|The file is)/.test(u)) }, reg) });
  };

  /** What the user says about a picture. It outranks the model, stays in this project, and only a later Director run reads it. */
  app.post("/api/sessions/:id/assets/:assetId/correction", async (c) => {
    const s = (await restoreUploads(c.req.param("id"))) ?? session(c.req.param("id"));
    const a = pictureIn(s, c.req.param("assetId"));
    const body = CorrectionBody.parse(await c.req.json().catch(() => ({})));
    const { genuine_product_ui, ...input } = body;
    const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    assets.setUserInput(s.id, a.asset_id, patch);
    if (genuine_product_ui !== undefined) s.assets = s.assets.map((x) => (x.asset_id === a.asset_id ? { ...x, genuine_product_ui } : x));
    await applyCorrection(s, s.assets.find((x) => x.asset_id === a.asset_id)!);
    s.route = null;
    return c.json({ ok: true, user: assets.getLink(s.id, a.asset_id)?.user ?? null });
  });

  /** Runs the analysis again. Used after a failure, or when the user asks. The file itself is not touched. */
  app.post("/api/sessions/:id/assets/:assetId/reanalyse", async (c) => {
    const s = (await restoreUploads(c.req.param("id"))) ?? session(c.req.param("id"));
    const a = pictureIn(s, c.req.param("assetId"));
    const link = assets.getLink(s.id, a.asset_id);
    if (!link) throw new HttpError(409, "not_registered", "This picture is not in the asset registry yet.");
    const m = a.width && a.height ? await measureImage(a.uri, { width: a.width, height: a.height }).catch(() => null) : null;
    await analyseContent(understanding(), link.content_id, a.uri, m, { force: true });
    await applyCorrection(s, a);
    return c.json({ ok: true, status: assets.content(link.content_id)?.analysis.status ?? "failed" });
  });

  /**
   * Every uploaded picture as the project actually holds it (registered, on disk, size and hash checked, measured, reviewed), and which scene needs each
   * could fill. Suggestions only; the plan is not touched.
   */
  app.get("/api/sessions/:id/asset-matches", async (c) => {
    const s = session(c.req.param("id"));
    const runId = runIdOf(s);
    const state = (await s.graph!.getState({ configurable: { thread_id: runId } })).values as DirectorStateType;
    await Promise.allSettled([...s.pending.values()]);
    const notes = s.assets.map((a) => s.analysis.get(a.asset_id)?.notes).filter((n): n is AssetNotes => !!n);
    const files = await Promise.all(s.assets.map(async (a) => {
      const st = await stat(a.uri).catch(() => null);
      const bytes = typeof a.metadata?.["bytes"] === "number" ? (a.metadata["bytes"] as number) : null;
      return { asset_id: a.asset_id, original_name: String(a.metadata?.["original_name"] ?? ""), media_type: a.media_type, width: a.width, height: a.height, on_disk: !!st?.isFile(), size_matches: !!st && (bytes === null || st.size === bytes), kind: s.analysis.get(a.asset_id)?.notes?.image_measure?.kind ?? null, reviewed: !!s.analysis.get(a.asset_id)?.notes?.visual_review };
    }));
    const matches = matchAssetsToScenes((state.scenePlan?.scenes ?? []).map((x) => ({ scene_id: x.scene_id, required_assets: x.required_assets })), notes, s.assets);
    return c.json({ run_id: runId, assets: files, matches });
  });

  app.post("/api/sessions/:id/reset", (c) => {
    const s = session(c.req.param("id"));
    s.turns = []; s.route = null; s.graph = undefined; s.threadId = undefined;
    return c.json({ ok: true });
  });

  // ---------- director run (server-sent events) ----------
  app.post("/api/sessions/:id/direct", async (c) => {
    const s = session(c.req.param("id"));
    const llm = needLlm();
    const body = DirectBody.parse(await c.req.json().catch(() => ({})));
    if (s.route?.status !== "ready") throw new HttpError(409, "not_routed", "Describe the video first so I know what to plan.");
    const request = s.route.request;
    if (request.mode === "edit_existing" || !request.project) throw new HttpError(409, "edit_mode", "This is an edit request. The editing agent is the next milestone, so there is no plan to build yet.");

    // Facts typed in the form, plus facts in the guided-intake kit that are the user's own or that they confirmed. Nothing extracted and unconfirmed is ever included.
    const typed = body.facts.map((text, i) => BrandFact.parse({ fact_id: `F${String(i + 1).padStart(2, "0")}`, text, source: "entered in the console" }));
    const kitFacts = approvedFacts(kits.kitOf(s)).filter((f) => !typed.some((t) => t.text === f.text));
    s.facts = [...typed, ...kitFacts.map((f, i) => BrandFact.parse({ ...f, fact_id: `F${String(typed.length + i + 1).padStart(2, "0")}` }))];
    s.threadId = `${s.id}-${Date.now()}`;
    // Every gate decision is written to storage/sessions/<id>/runs/<run id>/approvals before it takes effect.
    s.graph = buildDirectorGraph({ llm, skills: ctx.skills, retriever: liveRetriever, ...(ctx.skillsIncludeDraft ? { skillsIncludeDraft: true } : {}), ...(productionPortFor(s.id) ? { production: productionPortFor(s.id)! } : {}), recipes: ctx.recipes, approvalLog: new RunStore(s.dir).approvalLog(s.threadId) });
    const graph = s.graph;
    const config = { configurable: { thread_id: s.threadId } };
    // The user's choice wins; otherwise whatever the request already carried (null when nothing said).
    const kit = kits.kitOf(s);
    const project = { ...request.project, video_category: body.video_category ?? kit.video_category ?? request.project.video_category ?? null, video_type: body.video_type ?? kit.video_type ?? request.project.video_type ?? null, brand_id: kit.brand_id ?? request.project.brand_id ?? null };
    const assets = s.assets;
    const facts = s.facts;
    await Promise.allSettled([...s.pending.values()]); // measurements and transcripts must be ready before planning
    const notes = assets.map((a) => s.analysis.get(a.asset_id)?.notes).filter((n): n is AssetNotes => !!n);

    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
      try {
        await send("start", { nodes: ["intake", "analyse_assets", "video_type_step", "treatment", "storyboard", "storyboard_gate", "edit_plan", "edit_plan_gate"] });
        for await (const chunk of await graph.stream({ project, assets, facts, notes, ...(kitIsStarted(kit) ? { kit } : {}) }, { ...config, streamMode: "updates" })) {
          for (const [node, update] of Object.entries(chunk as Record<string, unknown>)) {
            if (node === "__interrupt__") continue;
            const trace = (update as { trace?: string[] } | null)?.trace ?? [];
            await send("step", { node, trace });
          }
        }
        const state = (await graph.getState(config)).values;
        llmProblem = null;
        await send("state", { ...summarise(state, ctx), run_id: s.threadId, checkpoint: saveCheckpoint(s, state as DirectorStateType) });
      } catch (e) {
        const llmErr = classifyLlmError(e, llm.model);
        noteLlm(llmErr);
        if (!llmErr) console.error(e);
        await send("failure", llmErr ? { code: llmErr.code, message: llmErr.message } : { code: "internal", message: "The run stopped unexpectedly. Check the server log for details." });
      }
    });
  });

  /**
   * One decision at one gate. The body must name the stage and the plan version the reviewer was looking at; a decision for
   * any other stage or version is refused with 409 and changes nothing. Approving the storyboard continues to the edit plan,
   * a change request produces the next version of the same plan.
   */
  app.post("/api/sessions/:id/approve", async (c) => {
    const s = session(c.req.param("id"));
    const llm = needLlm();
    const sub = ApprovalSubmission.parse(await c.req.json().catch(() => ({})));
    if (!s.graph || !s.threadId) throw new HttpError(409, "no_run", "There is no plan waiting for approval.");
    if (s.deciding) throw new HttpError(409, "busy", "Another decision is being applied to this plan. Wait for it to finish.");
    s.deciding = true;
    try {
      const config = { configurable: { thread_id: s.threadId } };
      const before = (await s.graph.getState(config)).values as DirectorStateType;
      if (before.status !== "awaiting_approval" || !before.gate) throw new HttpError(409, "not_waiting", "No plan is waiting for a decision.");
      if (sub.stage !== before.gate) throw new HttpError(409, "stale_stage", `This decision is for the ${label(sub.stage)}, but the ${label(before.gate)} is the one waiting.`);
      const waiting = before.gate === "storyboard" ? currentStoryboard(before)! : currentEditPlan(before)!;
      if (sub.plan_version !== waiting.version) throw new HttpError(409, "stale_version", `This decision is for ${label(sub.stage)} version ${sub.plan_version}, but version ${waiting.version} is the current one. Reload the plan and review it again.`);
      if (sub.storyboard_version !== undefined && sub.storyboard_version !== before.scenePlan!.version) {
        throw new HttpError(409, "stale_storyboard", `This decision assumes storyboard version ${sub.storyboard_version}, but the storyboard is version ${before.scenePlan!.version}.`);
      }
      const state = await s.graph.invoke(new Command({ resume: sub }), config);
      llmProblem = null;
      const record = buildRunRecord(state, { model: llm.model, skills: ctx.skills, library: ctx.recipes });
      return c.json({ state: summarise(state, ctx), record: { ...record, approvals: publicApprovals(record.approvals) }, checkpoint: saveCheckpoint(s, state) });
    } finally {
      s.deciding = false;
    }
  });

  /**
   * The frozen, validated package the Editor agent will consume. Only exists once both approvals match the current plans;
   * otherwise 409 with every reason. Nothing is rendered or sent anywhere.
   */
  app.get("/api/sessions/:id/handoff", async (c) => {
    const s = session(c.req.param("id"));
    if (!s.graph || !s.threadId) throw new HttpError(409, "no_run", "There is no Director run yet.");
    const state = (await s.graph.getState({ configurable: { thread_id: s.threadId } })).values as DirectorStateType;
    const model = ctx.demo ? "demo" : ctx.llm?.model ?? "unknown";
    const checks = { recipes: ctx.recipes, storageRoot: s.dir, requireContentHash: true };
    const handoff = buildHandoff(state, { ...checks, skills: ctx.skills, knowledge: ctx.knowledge, run_id: s.threadId, model });
    const store = new RunStore(s.dir);
    // The approvals on disk are the reference. A handoff that does not match them is never saved or served.
    const problems = verifyHandoffWithStore(handoff, store, checks);
    if (problems.length) throw new HandoffRefusedError(problems);
    store.saveHandoff(handoff);
    return c.json(handoff);
  });

  /**
   * Brings a stopped run back after a restart: it pauses at the same gate with the same plan, or shows the approved or
   * escalated result. Every stored approval, plan, fact and file is checked first; any problem is 409 with the reasons and
   * nothing is started. The ids in the URL only say where to look. Resuming approves nothing.
   */
  app.post("/api/sessions/:id/runs/:runId/resume", async (c) => {
    const id = c.req.param("id"), runId = c.req.param("runId");
    const dir = join(ctx.storageDir, "sessions", id);
    if (!ID.test(id) || !new RegExp(`^${id}-\\d+$`).test(runId) || !existsSync(dir)) throw new HttpError(404, "no_run", "That run does not exist.");
    const existing = sessions.get(id);
    if (existing?.threadId === runId && existing.graph) throw new HttpError(409, "run_active", "That run is already open. Reload the page instead of resuming it.");
    const llm = needLlm();
    const store = new RunStore(dir);
    const graph = buildDirectorGraph({ llm, skills: ctx.skills, retriever: liveRetriever, ...(ctx.skillsIncludeDraft ? { skillsIncludeDraft: true } : {}), ...(productionPortFor(id) ? { production: productionPortFor(id)! } : {}), recipes: ctx.recipes, approvalLog: store.approvalLog(runId) });
    const r = await restoreRun({ store, graph, session_id: id, run_id: runId, ctx: { recipes: ctx.recipes, storageRoot: dir, requireContentHash: true } });
    if (!r.ok) {
      if (r.missing) throw new HttpError(404, "no_checkpoint", r.reasons[0]!);
      return c.json({ error: "cannot_resume", message: "This run cannot be resumed safely. Start a new run from the same files.", reasons: plainReasons(r.reasons) }, 409);
    }
    const st = r.state;
    const analysis = new Map(st.notes.map((n) => [n.asset_id, { status: "done" as const, notes: n, transcript: null, note: null }]));
    const restored: Session = { id, dir, assets: st.assets, turns: [], route: null, facts: st.facts, analysis, pending: new Map(), graph, threadId: runId };
    sessions.set(id, restored);
    // Pictures saved before they were measured get measured now, and any stored review is attached again. Nothing is invented: a picture with no review stays unreviewed.
    for (const a of restored.assets.filter((x) => x.media_type === "image")) {
      const n = analysis.get(a.asset_id)?.notes ?? buildAssetNotes(a, null);
      let measured = n;
      if (!n.image_measure && a.width && a.height) { try { measured = buildAssetNotes(a, null, null, await measureImage(a.uri, { width: a.width, height: a.height })); } catch { /* stays unmeasured */ } }
      analysis.set(a.asset_id, { status: "done", notes: withReview(restored, measured), transcript: null, note: null });
    }
    return c.json({ state: { ...summarise(st, ctx), run_id: runId }, resumed: true });
  });

  /**
   * A handoff saved earlier, verified again now against the stored approvals and the files on disk. Works after a restart,
   * when the in-memory session is gone. 200 with the handoff when it verifies, 409 with every reason when it does not.
   */
  app.get("/api/sessions/:id/runs/:runId/handoff", (c) => {
    const id = c.req.param("id"), runId = c.req.param("runId");
    const dir = join(ctx.storageDir, "sessions", id);
    if (!ID.test(id) || !new RegExp(`^${id}-\\d+$`).test(runId) || !existsSync(dir)) throw new HttpError(404, "no_run", "That run does not exist.");
    const store = new RunStore(dir);
    const { handoff, problems } = store.loadHandoff(runId);
    if (problems.length) return c.json({ error: "handoff_unreadable", message: "The stored handoff cannot be trusted.", verification: { ok: false, reasons: problems } }, 409);
    if (!handoff) throw new HttpError(404, "no_handoff", "No handoff was saved for that run.");
    const reasons = verifyHandoffWithStore(handoff, store, { recipes: ctx.recipes, storageRoot: dir, requireContentHash: true });
    return c.json({ handoff, verification: { ok: reasons.length === 0, reasons } }, reasons.length ? 409 : 200);
  });

  // ---------- editor and preview render ----------
  const runIdOf = (s: Session) => {
    if (!s.graph || !s.threadId) throw new HttpError(409, "no_run", "There is no Director run yet.");
    return s.threadId;
  };
  /**
   * The handoff for the run as it stands now, verified against the approvals on disk and the files. It is rebuilt on every call,
   * so a plan or approval that changed since earlier is caught here instead of being trusted from memory.
   */
  const currentHandoff = async (s: Session): Promise<DirectorHandoff> => {
    const runId = runIdOf(s);
    const state = (await s.graph!.getState({ configurable: { thread_id: runId } })).values as DirectorStateType;
    const checks = { recipes: ctx.recipes, storageRoot: s.dir, requireContentHash: true };
    const handoff = buildHandoff(state, { ...checks, skills: ctx.skills, knowledge: ctx.knowledge, run_id: runId, model: ctx.demo ? "demo" : ctx.llm?.model ?? "unknown" });
    const problems = verifyHandoffWithStore(handoff, new RunStore(s.dir), checks);
    if (problems.length) throw new HandoffRefusedError(problems);
    return handoff;
  };
  const scrubRoots = (s: Session) => [s.dir, ctx.storageDir];
  const registryFor = (out: string): { registry: AdapterRegistry; available: boolean } => {
    // Every renderer that can run on this machine is registered; one that cannot (for example no browser) is simply absent, and a plan that needs it is blocked.
    const built = buildAdapterRegistry({ ffmpegOk: ctx.ffmpegOk, fontFile: ctx.renderFont, outputRoot: out, capabilitiesDir: ctx.capabilitiesDir, recipes: ctx.recipes });
    return { registry: built.registry, available: built.available };
  };
  /**
   * The capability registry as it is right now: the recipes, the learned and visual records on disk, and what the live adapters register. Built fresh on every call (nothing
   * is kept between calls), so a change in any of them shows up at once and the snapshot hash changes with it.
   */
  type LiveCapabilities = { registry: CapabilityRegistry; engines: ReturnType<AdapterRegistry["renderers"]>; adapters: AdapterRegistry; failures: { engine: "ffmpeg" | "remotion" | "hyperframes"; reason: string }[] };
  const buildLiveCapabilities = (): LiveCapabilities => {
    const built = buildAdapterRegistry({ ffmpegOk: ctx.ffmpegOk, fontFile: ctx.renderFont, outputRoot: tmpdir(), capabilitiesDir: ctx.capabilitiesDir, recipes: ctx.recipes });
    const registry = CapabilityRegistry.from({ recipes: ctx.recipes.all(), learned: loadCapabilityRegistry(ctx.capabilitiesDir, { recipes: ctx.recipes }), visual: loadVisualCapabilities(ctx.capabilitiesDir), implementations: implementationsOf(built.registry), adapter_failures: built.failures });
    return { registry, engines: built.registry.renderers(), adapters: built.registry, failures: built.failures };
  };
  // Off unless DIGIKON_REGISTRY_CACHE=1: the registry is then rebuilt only when a record file, the recipe set or the machine settings change (or after a minute), instead of on every call.
  const registryCache = process.env["DIGIKON_REGISTRY_CACHE"] === "1" ? new KeyedCache<LiveCapabilities>(60_000) : null;
  const liveCapabilities = (): LiveCapabilities => registryCache
    ? registryCache.get([directoryStamp(ctx.capabilitiesDir), ctx.recipes.all().map((r) => `${r.recipe_id}@${r.version}`).join(","), ctx.ffmpegOk, ctx.renderFont ?? ""].join("#"), buildLiveCapabilities)
    : buildLiveCapabilities();
  /**
   * What the Director is given to make production decisions: the registry as data, the engines that exist, and the renderer's own pre-flight (the same planners final assembly
   * runs). The Director never imports the render package; it sees only this. Set only when a capabilities folder is configured.
   */
  const productionPortFor = (sessionId: string): ProductionPort | undefined => ctx.capabilitiesDir ? {
    capabilities: () => { const l = liveCapabilities(); return { snapshot: l.registry.snapshot, available_engines: l.engines }; },
    preflight: (req) => { const l = liveCapabilities(); return runAdapterPreflight(req, { adapters: l.adapters, outputRoot: tmpdir(), assetFiles: (id, role) => assets.renderFile(sessionId, id, role) }); },
    composition: (req) => checkComposition(req.visual, { art_direction: req.art_direction, aspect_ratio: req.aspect_ratio, duration_seconds: req.duration_seconds }),
    ...(ctx.audio ? { audio: (req: { scenePlan: { scenes: readonly Parameters<typeof planAudio>[0]["scenes"][number][] }; assets: readonly Asset[]; feel: Parameters<typeof planAudio>[0]["feel"] }) => planAudio({ scenes: req.scenePlan.scenes, assets: req.assets, feel: req.feel }, ctx.audio!).unresolved.map((u) => `${u.scene_id}: ${u.detail}`) } : {}),
  } : undefined;
  let liveIndex: { hash: string; retriever: Retriever } | null = null;
  const currentRetriever = (): Retriever => {
    if (!ctx.retrieverFor || !ctx.capabilitiesDir) return ctx.retriever;
    const { registry } = liveCapabilities();
    if (liveIndex?.hash !== registry.snapshot.snapshot_hash) {
      const implemented = new Set(registry.atLeast("executable").filter((c) => c.variant_of === null && c.recipe_id).map((c) => c.recipe_id!));
      const validated = new Set(registry.atLeast("validated").filter((c) => c.variant_of === null && c.recipe_id).map((c) => c.recipe_id!));
      liveIndex = { hash: registry.snapshot.snapshot_hash, retriever: ctx.retrieverFor(implemented, validated) };
    }
    return liveIndex.retriever;
  };
  const liveRetriever: Retriever = { retrieve: (q) => currentRetriever().retrieve(q), get: (id, c, fl) => currentRetriever().get(id, c, fl) };
  const availableRenderers = () => (ctx.ffmpegOk && ctx.renderFont ? registryFor(tmpdir()).registry.renderers() : []);

  /** Everything a render decision rests on, recomputed from the stored approvals, the stored Editor result and the settings given. */
  const prepare = async (s: Session, settingsIn: Record<string, unknown> | undefined) => {
    const runId = runIdOf(s);
    const handoff = await currentHandoff(s);
    const dirs = renderDirs(s.dir, runId);
    const stored = loadEditorOutput(dirs.editor, runId);
    if (stored.problems.length) throw new HttpError(409, "editor_output_unreadable", stored.problems.join("; "));
    if (!stored.output) throw new HttpError(409, "no_editor_output", "The Editor has not run for this run yet. Run it first.");
    if (stored.output.handoff_content_hash !== handoff.content_hash) throw new HttpError(409, "stale_editor_output", "The Editor result was made from an earlier version of the approved plans. Run the Editor again.");
    await mkdir(dirs.out, { recursive: true });
    const { registry, available } = registryFor(dirs.out);
    const settings = settingsIn ? { ...settingsIn, source: { kind: "user_approved", reference: `entered in the console form (session ${s.id}, run ${runId})` } } : undefined;
    const base = { recipes: ctx.recipes, adapters: registry, capabilities: loadCapabilityRegistry(ctx.capabilitiesDir, { recipes: ctx.recipes }), ...(ctx.audio ? { audio: ctx.audio } : {}), outputRoot: dirs.out, store: new RunStore(s.dir), storageRoot: s.dir, requireContentHash: true, assetFiles: (id: string, role: string) => assets.renderFile(s.id, id, role) };
    // What Gate 2 approved, checked against what is about to run: the approval binding, the plans' integrity, the registry as it is now and the Editor's operations. A run approved
    // without production planning is not bound and is planned as before. The approved selection goes into render planning, so the renderer cannot choose another implementation.
    const st = (await s.graph!.getState({ configurable: { thread_id: runId } })).values as DirectorStateType;
    const stored_approvals = new RunStore(s.dir).loadApprovals(runId);
    const gate: ProductionGate = stored_approvals.problems.length
      ? { bound: true, ok: false, reasons: stored_approvals.problems, approved_selection: [] }
      : verifyProductionForRender({
        records: stored_approvals.records, productionPlan: st.productionPlan, compiledPlan: st.compiledPlan, refs: currentStoryboard(st) && currentEditPlan(st) ? { storyboard: currentStoryboard(st)!, edit_plan: currentEditPlan(st)! } : null,
        scenePlan: st.scenePlan ?? null, editPlan: st.editPlan ?? null, assets: st.assets, aspect_ratio: st.project.aspect_ratio, editorOperations: stored.output.operations, live: (() => { try { return productionPortFor(s.id)?.capabilities() ?? null; } catch { return null; } })(),
      });
    const approved_selection = gate.bound ? gate.approved_selection : undefined;
    const planned = planRender({ editor_output: stored.output, handoff, settings, purpose: "preview", approved_selection }, base);
    if (!planned.ok) throw new HandoffRefusedError(planned.reasons.map((r) => scrub(r, scrubRoots(s))));
    const production = planRender({ editor_output: stored.output, handoff, settings, purpose: "production", approved_selection }, base);
    const selection = selectRenderer(planned.record, registry);
    const coverage = previewCoverage(handoff, stored.output, planned.record, selection.capabilities);
    const eligible = planned.record.state === "executable" && coverage.complete && !!planned.plan && (!gate.bound || (gate.ok && planned.record.blockers.length === 0));
    // The multi-engine path: scene by scene, each by its own engine, assembled by FFmpeg. Planned from the same approvals; it changes nothing approved.
    // A template counts as validated on its own only with a current validation record for the block a scene draws with it (read once here, not per operation).
    const visualRecords = loadVisualCapabilities(ctx.capabilitiesDir);
    const isolation = (template: string, block: string | null) => template === COMPOSITION_TEMPLATE && !!block && visualRecords.some((v) => v.block === block && v.usable);
    const assembleDeps: AssembleDeps | null = available && ctx.renderFont ? { ...base, fontFile: ctx.renderFont, isolation } : null;
    let assembly: AssemblePlanResult | null = null;
    try { assembly = assembleDeps ? planAssembly({ editor_output: stored.output, handoff, settings, purpose: "preview", approved_selection }, assembleDeps) : null; } catch (e) { console.error(e instanceof Error ? e.message : e); }
    // Bound runs: planned again at the real output settings, and anything final assembly cannot carry out as approved stops the render (no placeholder, no other implementation).
    const production_gate = { bound: gate.bound, integrity: !gate.bound || gate.ok, settings: true, reasons: gate.bound ? [...gate.reasons] : ([] as string[]) };
    if (gate.bound && gate.ok) {
      const parsed = RenderSettings.safeParse(settings);
      if (!parsed.success) production_gate.reasons.push("no valid output settings to plan against");
      else {
        production_gate.reasons.push(...replanAtActualSettings({ plan: st.productionPlan, compiled: st.compiledPlan, storyboard: st.scenePlan!, assets: st.assets, art_direction: st.treatmentDoc?.art_direction ?? null, aspect_ratio: st.project.aspect_ratio, settings: parsed.data, adapters: registry, outputRoot: dirs.out, assetFiles: base.assetFiles }));
        if (assembly?.ok) production_gate.reasons.push(...renderTimeProblems(assembly.plan));
        else production_gate.reasons.push("final assembly could not be planned");
      }
      production_gate.settings = production_gate.reasons.length === 0;
    }
    // Where each approved choice stands on the readiness ladder. Being in the registry is not being ready: `reviewed` and `production` need a person's review, and a render never promotes anything.
    const snapshot = (() => { try { return productionPortFor(s.id)?.capabilities().snapshot ?? null; } catch { return null; } })();
    const decisions = (st.productionPlan?.decisions ?? []) as { use_id: string; scene_id: string; recipe_id: string; engine: string | null; readiness: string | null; variant: { capability_id: string } | null; limitations: string[] }[];
    const ladder = decisions.map((d) => {
      const variant = d.variant ? snapshot?.capabilities.find((c) => c.capability_id === d.variant!.capability_id) : null;
      const readiness = variant?.status ?? d.readiness;
      return { use_id: d.use_id, scene_id: d.scene_id, recipe_id: d.recipe_id, capability: d.variant?.capability_id ?? d.recipe_id, engine: d.engine, readiness, production_ready: readiness === "production", limitations: d.limitations };
    });
    return { runId, handoff, production_gate, dirs, editor: stored.output, planned: planned as Extract<PlanResult, { ok: true }>, production, coverage, selection, registered: registry.renderers(), eligible, available, assembly, assembleDeps, ladder };
  };

  /** A bound run whose approved implementation cannot be rendered as approved: nothing starts. The details go to the log; the user gets one ordinary sentence. */
  const productionRefusal = (p: Awaited<ReturnType<typeof prepare>>) => {
    const g = p.production_gate;
    if (!g.bound || (g.integrity && g.settings)) return null;
    console.error(`render refused (production): ${g.reasons.join(" | ")}`);
    return g.integrity
      ? { error: "cannot_produce_as_approved", message: PLAIN_CANNOT_PRODUCE }
      : { error: "plan_changed", message: PLAIN_PLAN_CHANGED };
  };

  const assemblyView = (s: Session, p: Awaited<ReturnType<typeof prepare>>) => {
    if (!p.assembly) return null;
    if (!p.assembly.ok) return { ok: false as const, reasons: plainReasons(p.assembly.reasons.map((r) => scrub(r, scrubRoots(s)))) };
    const a = p.assembly.plan;
    return {
      ok: true as const, complete: a.complete,
      scenes: a.scenes.map((x) => ({ scene_id: x.scene_id, engine: x.engine, renderable: x.renderable, reason: x.reason ? scrub(x.reason, scrubRoots(s)) : null, unmet: x.unmet.map((u) => scrub(u, scrubRoots(s))) })),
      transitions: a.transitions.map((t) => ({ after_scene: t.after_scene, template: t.template, applied: t.applied, reason: scrub(t.reason, scrubRoots(s)) })),
      omitted: a.omitted.map((o) => ({ ...o, reason: scrub(o.reason, scrubRoots(s)) })),
      label: a.complete ? "A complete preview can be assembled from the scene clips." : "Only an INCOMPLETE preview can be made: scenes or operations that nothing can render are listed and shown as labelled placeholders.",
    };
  };
  /** A delivery report as the browser sees it: no absolute paths, a playback address only for a video that exists, and the stage flags kept apart. */
  const publicDelivery = (s: Session, r: DeliveryReport, runRoot: string) => ({
    ...r,
    // the one decision, as the report holds it; a report written before it existed is read as incomplete or complete preview, never as final
    status: r.decision?.status ?? (r.kind === "complete" ? "complete_preview" : "incomplete_preview"),
    decision: r.decision ? { ...r.decision, criteria: r.decision.criteria.map((c) => ({ ...c, detail: scrub(c.detail, scrubRoots(s)), blockers: c.blockers.map((b) => scrub(b, scrubRoots(s))) })), blockers: r.decision.blockers.map((b) => scrub(b, scrubRoots(s))) } : null,
    final_delivery_blockers: r.final_delivery_blockers.map((b) => scrub(b, scrubRoots(s))),
    transitions: r.transitions.map((t) => ({ ...t, reason: scrub(t.reason, scrubRoots(s)), check: t.check ? scrub(t.check, scrubRoots(s)) : null })),
    scenes: r.scenes.map((x) => ({ ...x, omitted_reason: x.omitted_reason ? scrub(x.omitted_reason, scrubRoots(s)) : null, operations: x.operations.map((o) => ({ ...o, reason: scrub(o.reason, scrubRoots(s)) })) })),
    omitted_operations: r.omitted_operations.map((o) => ({ ...o, reason: scrub(o.reason, scrubRoots(s)) })),
    output: r.output ? { ...r.output, path: relative(runRoot, r.output.path).replaceAll("\\", "/"), video_url: `/api/sessions/${s.id}/deliveries/${r.delivery_id}/video` } : null,
  });

  const planView = (s: Session, p: Awaited<ReturnType<typeof prepare>>) => {
    const sceneOf = new Map(p.editor.operations.map((o) => [o.operation_id, o.target_scene_id]));
    const typeOf = new Map(p.editor.operations.map((o) => [o.operation_id, o.operation_type]));
    // Scene-by-scene assembly is how a film is made, so a plannable assembly is the truth about it: what one adapter could not do alone (mixed engines, a join, a transition) is no blocker.
    const assembled = p.assembly?.ok && !p.eligible ? p.assembly.plan : null; // an eligible one-engine film is rendered in one run, and is judged as that
    const singleRun = new Set(p.production.ok ? p.production.single_run_blockers : []);
    const prodBlockers: string[] = p.production.ok ? p.production.record.blockers.filter((b) => !(assembled && singleRun.has(b))) : [];
    const ops = p.planned.record.operations.map((o) => ({ operation_id: o.operation_id, scene_id: sceneOf.get(o.operation_id) ?? null, note: typeOf.get(o.operation_id) === "mix_audio" ? "audio is not part of this phase: it is reported as unresolved and keeps the film from being complete or final" : null, recipe_id: o.recipe_id, template: o.implementation_ref, renderer: o.renderer, supported: o.renderer !== null }));
    const coverage = assembled ? assembled.coverage : p.coverage;
    const previewSingle = new Set(p.planned.ok ? p.planned.single_run_blockers : []);
    const blockers = plainReasons((assembled ? [...new Set([...p.planned.record.blockers.filter((b) => !previewSingle.has(b)), ...assemblyBlockers(assembled)])] : [...new Set([...p.planned.record.blockers, ...p.coverage.scenes.flatMap((x) => x.missing.map((m) => `${x.scene_id}: ${m}`))])]).map((b) => scrub(b, scrubRoots(s))));
    const refused = productionRefusal(p);
    if (refused) blockers.push(refused.message);
    return {
      run_id: p.runId,
      renderer_available: p.available,
      editor: { status: p.editor.status, validation: p.editor.validation, conflicts: p.editor.conflicts, revision_requests: p.editor.revision_requests, operations: p.editor.operations.length, rendered: p.editor.execution.rendered },
      renderer: { selected: p.selection.selected, needed: p.selection.needed, composition_required: p.selection.composition_required, registered: p.registered, execution: assembled ? "scene_assembly" as const : "single_run" as const },
      plan: { state: p.planned.record.state, purpose: "preview" as const, operations: ops, supported: ops.filter((o) => o.supported).length, unsupported: ops.filter((o) => !o.supported).length, notes: p.planned.record.notes },
      coverage,
      /** Per operation: status, every engine considered and why it was or was not usable, and the engine selected. */
      capability: p.planned.diagnosis.map((d) => ({ operation_id: d.operation_id, scene_id: d.scene_id, recipe_id: d.recipe_id, status: d.status, selected_engine: d.selected_engine, selected_template: d.selected_template, reason: scrub(d.reason, scrubRoots(s)), engines: d.engines.map((e) => ({ engine: e.engine, verdict: e.verdict, reason: scrub(e.reason, scrubRoots(s)) })) })),
      eligible: p.eligible,
      /** What the multi-engine assembler would do: per scene, the engine or the reason it cannot be shown. */
      assembly: assemblyView(s, p),
      /** A render can start: a complete single-renderer preview, or an assembly where at least one scene can be drawn (anything missing is then listed and labelled). */
      can_render: p.eligible || (p.assembly?.ok === true && p.assembly.plan.scenes.some((x) => x.renderable)),
      blockers,
      /** A separate question from the preview: could this go to production? Never true while any recipe is a draft. */
      production: {
        ready: p.production.ok && (assembled ? prodBlockers.length === 0 && assembled.complete : p.production.record.state === "executable"), blockers: prodBlockers.map((b) => scrub(b, scrubRoots(s))),
        /** Per operation: whether its recipe is reviewed, and the exact template or renderer that is missing. */
        operations: p.production.ok ? p.production.record.operations.map((o) => ({ operation_id: o.operation_id, recipe_id: o.recipe_id, template: o.implementation_ref, renderer: o.renderer, reviewed: o.production_executable, missing: o.renderer === null ? `no renderer has the template ${o.implementation_ref} registered (registered here: ${p.registered.join(", ") || "none"})` : null, open: prodBlockers.filter((b) => b.startsWith(`${o.operation_id}:`)).map((b) => scrub(b.slice(o.operation_id.length + 1).trim(), scrubRoots(s))) })) : [],
      },
      /**
       * How far each operation has been shown to work, kept apart: registered, validated on its own, compatible with this scene, rendered with this scene's
       * inputs, validated in the finished video. A registry status of "validated_available" appears only as `registry_status`; it is not one of these levels.
       */
      ladder: p.ladder,
      readiness: p.assembly?.ok ? p.assembly.plan.scenes.flatMap((sc) => sc.operations.map((o) => ({ operation_id: o.operation_id, scene_id: sc.scene_id, recipe_id: o.recipe_id, template: o.template, operation_type: o.operation_type, engine: o.engine, registry_status: o.status, ...o.readiness, missing: o.readiness.missing ? scrub(o.readiness.missing, scrubRoots(s)) : null }))) : null,
      layout_constraints: p.planned.record.settings ? layoutConstraints(p.planned.record.settings.width, p.planned.record.settings.height) : null,
      needs: { aspect_ratio: p.handoff.constraints.aspect_ratio, duration_s: timelineEnd(p.handoff), supported_output: { container: "mp4", video_codec: "h264", audio_codec: p.planned.record.audio_required && ctx.audio ? "aac" : null }, you_provide: ["width", "height", "fps"] },
      label: p.eligible ? "Preview only: every approved scene rendered with the templates of the selected renderer. It is not production-ready." : assembled?.complete ? "Preview only: every approved scene is rendered by its own engine and joined by the assembler. It is not production-ready." : "No preview can be made yet. Nothing here is rendered, and no partial video is offered.",
    };
  };

  /** Runs the Editor on the verified handoff. Deterministic checks only: no model is called. */
  /**
   * DELIBERATE DECISION (Digikon, 2026-11-05): a separate DRAFT preview of one scene may be made before Gate 2, while the edit plan is waiting for approval. It is not the render:
   * it plans and draws one scene into its own folder (`draft-previews`, never the production output), the file is named `draft-...` and carries a burned-in DRAFT label, and
   * validateOutput refuses that name, so it can never be assembled into or accepted as the final film. It reads no approval and writes no approval, render record or delivery
   * report. The production render (`POST .../render`) still needs both approvals and the hash-bound production record; nothing here satisfies or bypasses it.
   */
  const draftDirOf = (s: Session) => join(s.dir, "draft-previews");
  app.post("/api/sessions/:id/scenes/:sceneId/draft-preview", async (c) => {
    const s = session(c.req.param("id"));
    const sceneId = c.req.param("sceneId");
    if (!ctx.renderFont || !ctx.ffmpegOk) throw new HttpError(503, "no_render", "This machine cannot render, so no draft preview can be made.");
    if (!s.graph || !s.threadId) throw new HttpError(409, "no_run", "There is no plan to preview yet.");
    const state = (await s.graph.getState({ configurable: { thread_id: s.threadId } })).values as DirectorStateType;
    if (state.status !== "awaiting_approval" || state.gate !== "edit_plan" || !state.compiledPlan || !state.productionPlan || !state.scenePlan) {
      throw new HttpError(409, "no_draft_available", "A draft preview can be made only while the edit plan is waiting for your approval. After both approvals use the scene preview of the approved plan; before the edit plan exists there is nothing to draw.");
    }
    const templates: Record<string, string> = {};
    for (const op of state.compiledPlan.operations) { const d = state.productionPlan.decisions.find((x) => x.use_id === op.source_use_id); if (d?.implementation_ref) templates[op.operation_id] = d.implementation_ref; }
    const draftDir = draftDirOf(s);
    const { registry, available } = registryFor(join(draftDir, "work"));
    if (!available) throw new HttpError(409, "no_engine", "No render engine is available on this machine.");
    const r = await renderDraftScene(
      { scenePlan: state.scenePlan, assets: state.assets, art_direction: state.treatmentDoc?.art_direction ?? null, operations: state.compiledPlan.operations, templates, aspect_ratio: state.project.aspect_ratio },
      sceneId,
      { adapters: registry, draftDir, fontFile: ctx.renderFont, assetFiles: (id, role) => assets.renderFile(s.id, id, role), audio: ctx.audio ?? null },
    );
    if (!r.ok) return c.json({ error: "scene_not_renderable", draft: true, scene_id: sceneId, reason: scrub(r.reason, scrubRoots(s)) }, 409);
    return c.json({ draft: true, final: false, label: r.label, scene_id: sceneId, key: r.key, cached: r.cached, engine: r.engine, sound: r.sound, notes: r.notes.map((n) => scrub(n, scrubRoots(s))), bytes: r.bytes, video: `/api/sessions/${s.id}/scenes/${sceneId}/draft-preview/${basename(r.path)}` });
  });
  app.get("/api/sessions/:id/scenes/:sceneId/draft-preview/:file", async (c) => {
    const s = session(c.req.param("id"));
    const m = /^(draft-[a-f0-9]{32}\.mp4)$/.exec(c.req.param("file"));
    if (!m) throw new HttpError(404, "no_video", "There is no such draft preview.");
    const dir = draftDirOf(s), path = join(dir, m[1]!);
    const meta = existsSync(`${path}.json`) ? (JSON.parse(readFileSync(`${path}.json`, "utf8")) as { bytes: number; sha256: string }) : null;
    if (!meta) throw new HttpError(404, "no_video", "There is no such draft preview.");
    const res = await serveVideo(c, dir, path, meta.bytes, meta.sha256);
    res.headers.set("x-draft-preview", "true");
    return res;
  });
  /**
   * TEMPORARY template picker: 3 to 5 recipes for a scene from retrieval, and the user's pick (or skip). A pick is stored as a hint for the edit plan only, so it can be made
   * only while the storyboard is waiting at gate 1 (before the edit plan is written), cannot name a recipe that is not offered, and changes no plan or approval.
   */
  const sceneOf = async (s: Session, sceneId: string) => {
    if (!s.graph || !s.threadId) throw new HttpError(409, "no_run", "There is no storyboard yet.");
    const config = { configurable: { thread_id: s.threadId } };
    const state = (await s.graph.getState(config)).values as DirectorStateType;
    const scene = state.scenePlan?.scenes.find((x) => x.scene_id === sceneId);
    if (!state.scenePlan || !scene) throw new HttpError(404, "no_scene", `There is no scene ${sceneId} in the storyboard.`);
    return { config, state, scene, options: await templateOptions({ retriever: liveRetriever, recipes: ctx.recipes }, state.project, state.assets, scene) };
  };
  app.get("/api/sessions/:id/scenes/:sceneId/templates", async (c) => {
    const s = session(c.req.param("id"));
    const { state, options } = await sceneOf(s, c.req.param("sceneId"));
    return c.json({ scene_id: c.req.param("sceneId"), options, picked: state.templateHints?.[c.req.param("sceneId")] ?? null, can_pick: state.status === "awaiting_approval" && state.gate === "storyboard", temporary: true });
  });
  app.post("/api/sessions/:id/scenes/:sceneId/template-hint", async (c) => {
    const s = session(c.req.param("id"));
    const body = z.object({ recipe_id: z.string().max(120).nullable() }).parse(await c.req.json().catch(() => ({})));
    const { config, state, options } = await sceneOf(s, c.req.param("sceneId"));
    if (state.status !== "awaiting_approval" || state.gate !== "storyboard") throw new HttpError(409, "too_late", "A template can only be suggested while the storyboard is waiting for your approval, before the edit plan is written.");
    if (body.recipe_id !== null && !options.some((o) => o.recipe_id === body.recipe_id)) throw new HttpError(400, "not_offered", "That template is not one of the options offered for this scene.");
    const next = { ...(state.templateHints ?? {}) };
    if (body.recipe_id === null) delete next[c.req.param("sceneId")]; else next[c.req.param("sceneId")] = body.recipe_id;
    await s.graph!.updateState(config, { templateHints: next });
    return c.json({ scene_id: c.req.param("sceneId"), picked: body.recipe_id, hint_only: true });
  });
  /**
   * Where a change request goes: a look change to the Editor (gate 2 only), a story change to the Director (gate 1), and one question when it is unclear. It only decides the
   * route: it edits no plan and no approval, and the approved storyboard (version and hash) is returned as it was, before and after.
   */
  app.post("/api/sessions/:id/change-request", async (c) => {
    const s = session(c.req.param("id"));
    const body = z.object({ text: z.string().max(2000) }).parse(await c.req.json().catch(() => ({})));
    if (!s.graph || !s.threadId) throw new HttpError(409, "no_run", "There is no plan to change yet.");
    const state = (await s.graph.getState({ configurable: { thread_id: s.threadId } })).values as DirectorStateType;
    const storyboard = currentStoryboard(state);
    return c.json({ ...classifyChange(body.text), approved_storyboard: storyboard ? { version: storyboard.version, hash: storyboard.hash } : null });
  });
  /** The Editor's advisory model review: on in demo mode (the stub model), and with a real model only when EDITOR_MODEL_REVIEW=1, so a real Claude call is never made by default. */
  const editorModel = (): LlmClient | null => (ctx.llm && (ctx.demo || process.env["EDITOR_MODEL_REVIEW"] === "1") ? ctx.llm : null);
  app.post("/api/sessions/:id/editor", async (c) => {
    const s = session(c.req.param("id"));
    if (!ctx.editorSkills) throw new HttpError(503, "no_editor", "The Editor skills are not loaded, so the Editor cannot run.");
    const handoff = await currentHandoff(s); // refuses until both approvals match the current plans
    const run = await runEditor(handoff, { recipes: ctx.recipes, skills: ctx.editorSkills, retriever: liveRetriever, ...(editorModel() ? { llm: editorModel()! } : {}), ...(ctx.skillsIncludeDraft ? { skillsIncludeDraft: true } : {}), store: new RunStore(s.dir), storageRoot: s.dir, requireContentHash: true, audio_production: !!ctx.audio });
    if (!run.ok) return c.json({ error: "editor_refused", message: "The Editor refused this handoff.", stage: run.stage, reasons: run.reasons.map((r) => scrub(r, scrubRoots(s))) }, 409);
    saveEditorOutput(renderDirs(s.dir, runIdOf(s)).editor, runIdOf(s), run.output);
    return c.json({ run_id: runIdOf(s), output: run.output, check: run.check });
  });

  app.get("/api/sessions/:id/render", async (c) => {
    const s = session(c.req.param("id"));
    return c.json(planView(s, await prepare(s, undefined)));
  });
  app.post("/api/sessions/:id/render/plan", async (c) => {
    const s = session(c.req.param("id"));
    const body = SettingsBody.parse(await c.req.json().catch(() => ({})));
    return c.json(planView(s, await prepare(s, body.settings)));
  });

  /**
   * A preview of one scene at the film's final settings, cached by a hash of the scene's job, its assets and the fonts: a scene that did not change is served from the
   * cache and nothing renders. Needs the same approvals as the film preview (planned from the stored Editor result) and changes nothing that was approved.
   */
  app.post("/api/sessions/:id/scenes/:sceneId/preview", async (c) => {
    const s = session(c.req.param("id"));
    const sceneId = c.req.param("sceneId");
    const body = SettingsBody.parse(await c.req.json().catch(() => ({})));
    if (!ctx.renderFont) throw new HttpError(503, "no_render", "This machine has no render font, so no preview can be made.");
    const p = await prepare(s, body.settings);
    if (!p.assembly) throw new HttpError(409, "no_assembly", "Nothing here can plan a scene preview yet: there is no render engine on this machine.");
    if (!p.assembly.ok) return c.json({ error: "cannot_plan", reasons: plainReasons(p.assembly.reasons.map((r) => scrub(r, scrubRoots(s)))) }, 409);
    const r = await renderScenePreview(p.assembly.plan, sceneId, { cacheDir: join(p.dirs.out, "scene-previews"), fontFile: ctx.renderFont, audio: ctx.audio ?? null });
    if (!r.ok) return c.json({ error: "scene_not_renderable", scene_id: sceneId, reason: scrub(r.reason, scrubRoots(s)) }, 409);
    return c.json({ scene_id: sceneId, key: r.key, cached: r.cached, engine: r.engine, notes: r.notes.map((n) => scrub(n, scrubRoots(s))), bytes: r.bytes, sound: r.sound, video: `/api/sessions/${s.id}/scenes/${sceneId}/preview/${r.key.slice(0, 32)}.mp4` });
  });
  app.get("/api/sessions/:id/scenes/:sceneId/preview/:file", async (c) => {
    const s = session(c.req.param("id"));
    const m = /^([a-f0-9]{32})\.mp4$/.exec(c.req.param("file"));
    if (!m) throw new HttpError(404, "no_video", "There is no such scene preview.");
    const dirs = renderDirs(s.dir, runIdOf(s));
    const dir = join(dirs.out, "scene-previews"), path = join(dir, `${m[1]}.mp4`);
    const meta = existsSync(`${path}.json`) ? (JSON.parse(readFileSync(`${path}.json`, "utf8")) as { bytes: number; sha256: string }) : null;
    if (!meta) throw new HttpError(404, "no_video", "There is no such scene preview.");
    return serveVideo(c, dir, path, meta.bytes, meta.sha256);
  });
  /**
   * Renders the preview, but only when the render plan is executable and the approved plan is fully shown by it. Otherwise 409
   * with every reason and nothing is started. A record is written before the renderer starts and again when it ends.
   */
  app.post("/api/sessions/:id/render", async (c) => {
    const s = session(c.req.param("id"));
    const body = SettingsBody.parse(await c.req.json().catch(() => ({})));
    if (s.rendering) throw new HttpError(409, "busy", "A preview is already being rendered for this session.");
    s.rendering = true;
    try {
      let p = await prepare(s, body.settings);
      const refusedFirst = productionRefusal(p);
      if (refusedFirst) return c.json(refusedFirst, 409);
      let learning: { attempted: unknown[]; not_learnable: unknown[] } | null = null;
      // Generation first: a capability nothing can run yet is learned (a real render that passes its checks), not treated as a reason to stop.
      if (!p.eligible && ctx.capabilitiesDir && ctx.renderFont && ctx.ffmpegOk) {
        const all = findCapabilityGaps(p.planned.record, undefined, p.editor.operations);
        const gaps = all.filter((g) => g.learnable);
        if (all.length) {
          const results = gaps.length ? await learnGaps(gaps, { root: ctx.capabilitiesDir, fontFile: ctx.renderFont, recipes: ctx.recipes }) : [];
          // what was found missing, what was tried, and what came of it: kept with the response, and in the registry as attempt history
          learning = {
            attempted: results.map((r) => (r.status === "learned" ? { template: r.template, status: "learned", reused: r.reused, checks: r.record.validated!.checks.length } : { template: r.template, status: "not_learned", ...(r.retry_skipped ? { retry_skipped: true } : {}), reasons: r.reasons.map((x) => scrub(x, scrubRoots(s))) })),
            not_learnable: all.filter((g) => !g.learnable).map((g) => ({ operation_id: g.operation_id, template: g.template, reason: "no reviewed implementation of this template exists in this project, and none is generated" })),
          };
          if (gaps.length) p = await prepare(s, body.settings);
        }
      }
      const refusedAfter = productionRefusal(p);
      if (refusedAfter) return c.json(refusedAfter, 409);
      const view = planView(s, p);
      if (!p.eligible || !p.planned.plan) {
        const a = p.assembly;
        if (!a?.ok || !p.assembleDeps || !a.plan.scenes.some((x) => x.renderable)) return c.json({ error: "not_renderable", message: "A preview cannot be rendered yet. No scene can be shown with the renderers and capabilities that exist.", learning, ...view }, 409);
        // Multi-engine, or incomplete: every scene by its own engine, assembled by FFmpeg, with anything missing listed and labelled.
        // the visual QA runs inside the assembly, on the finished film, so the one delivery decision has its result; the same result is kept for the log
        let measured: Awaited<ReturnType<typeof filmQuality>> | null = null;
        const result = await renderAssembly(a.plan, { ...p.assembleDeps, visualCheck: async (rep, h) => { measured = await filmQuality(rep, h); return { critical_major: measured.visual.findings.filter((f) => f.severity === "critical" || f.severity === "major").map((f) => `visual ${f.scene_id ?? "film"}: ${f.description}`), not_checked: measured.visual.not_checked }; } });
        if (result.kind === "failed") return c.json({ kind: "failed", error: "render_failed", message: "The render failed. No video is offered.", errors: result.errors.map((e) => scrub(e, scrubRoots(s))), learning, ...view }, 502);
        const delivery = publicDelivery(s, result.report, p.dirs.root);
        try { saveDeliveryReport(p.dirs.records, result.report); } catch { await rm(result.report.output!.path, { force: true }); throw new HttpError(503, "not_saved", "The delivery report could not be saved, so the video was removed. Check free disk space."); }
        if (result.kind === "complete") {
          try { saveRenderRecord(p.dirs.records, result.record); } catch (e) { await rm(result.record.output!.path, { force: true }); throw e; }
          let qa;
          try {
            qa = await runRenderQa(result.record, p.handoff);
            writeFileSync(join(p.dirs.records, `${result.record.render_id}.qa.json`), JSON.stringify(qa, null, 2));
            for (const id of new Set(result.record.operations.map((o) => o.recipe_id))) saveRenderEvidence(p.dirs.evidence, buildRenderEvidence(result.record, ctx.recipes.get(id)!, qa));
          } catch (e) { console.error(e instanceof Error ? e.message : e); }
          const quality = measured ? { ...(measured as Awaited<ReturnType<typeof filmQuality>>), final_ready: result.report.decision?.final ?? false, blockers: result.report.decision?.blockers ?? [] } : null; if (quality && ctx.capabilitiesDir) logVisualQa(join(ctx.capabilitiesDir, "visual", "qa-log.jsonl"), { at: new Date().toISOString(), render_id: result.report.render_id, session: s.id, findings: quality.visual.findings.map((f) => ({ finding_id: f.finding_id, scene_id: f.scene_id, severity: f.severity, description: f.description })) });
          return c.json({ kind: "complete", learning, delivery, quality, record: publicRecord(result.record, s.id, p.dirs.root, scrubRoots(s)), qa: qa ? { findings: qa.findings, passed: qa.passed, measurements: qa.measurements } : null, ...view });
        }
        const quality = measured ? { ...(measured as Awaited<ReturnType<typeof filmQuality>>), final_ready: result.report.decision?.final ?? false, blockers: result.report.decision?.blockers ?? [] } : null; if (quality && ctx.capabilitiesDir) logVisualQa(join(ctx.capabilitiesDir, "visual", "qa-log.jsonl"), { at: new Date().toISOString(), render_id: result.report.render_id, session: s.id, findings: quality.visual.findings.map((f) => ({ finding_id: f.finding_id, scene_id: f.scene_id, severity: f.severity, description: f.description })) });
        return c.json({ kind: "partial", learning, delivery, quality, record: null, qa: null, ...view });
      }
      const save = (r: RenderRecord) => { try { saveRenderRecord(p.dirs.records, r); } catch { throw new HttpError(503, "not_saved", "The render record could not be saved, so nothing was rendered. Check free disk space."); } };
      const record = await executeRender(p.planned.plan, { storageRoot: s.dir, requireContentHash: true, onUpdate: save });
      if (record.state === "rendered") {
        try { save(record); } catch (e) { await rm(record.output!.path, { force: true }); throw e; } // no record, no file
        let qa;
        try {
          qa = await runRenderQa(record, p.handoff);
          writeFileSync(join(p.dirs.records, `${record.render_id}.qa.json`), JSON.stringify(qa, null, 2));
          for (const id of new Set(record.operations.map((o) => o.recipe_id))) saveRenderEvidence(p.dirs.evidence, buildRenderEvidence(record, ctx.recipes.get(id)!, qa));
        } catch (e) {
          console.error(e instanceof Error ? e.message : e); // the video is validated; a QA or evidence problem is reported as missing QA, not as a failed render
        }
        return c.json({ record: publicRecord(record, s.id, p.dirs.root, scrubRoots(s)), qa: qa ? { findings: qa.findings, passed: qa.passed, measurements: qa.measurements } : null, ...view });
      }
      save(record);
      return c.json({ record: publicRecord(record, s.id, p.dirs.root, scrubRoots(s)), qa: null, ...view }, 502);
    } finally {
      s.rendering = false;
    }
  });

  /**
   * Tries to close the capability gaps of the current render plan: each operation whose template nothing can run, when a reviewed engine
   * could. A capability is stored only after a real render passes its checks; otherwise it stays unsupported and the reasons are returned.
   * This renders no video for the project, changes no plan or approval and re-runs nothing: the approved recipes and templates stay as approved.
   */
  app.post("/api/sessions/:id/render/learn", async (c) => {
    const s = session(c.req.param("id"));
    if (!ctx.capabilitiesDir || !ctx.renderFont || !ctx.ffmpegOk) throw new HttpError(503, "no_capability_store", "Capability learning needs FFmpeg, a font file and a capability folder, and one of them is not configured.");
    const body = SettingsBody.parse(await c.req.json().catch(() => ({})));
    const before = await prepare(s, body.settings);
    const gaps = findCapabilityGaps(before.planned.record, undefined, before.editor.operations);
    const results = await learnGaps(gaps.filter((g) => g.learnable), { root: ctx.capabilitiesDir, fontFile: ctx.renderFont, recipes: ctx.recipes });
    const after = await prepare(s, body.settings); // the registry is rebuilt, so what was just learned counts
    return c.json({
      gaps: gaps.map((g) => ({ operation_id: g.operation_id, recipe_id: g.recipe_id, template: g.template, learnable: g.learnable })),
      results: results.map((r) => (r.status === "learned" ? { template: r.template, status: r.status, reused: r.reused, checks: r.record.validated!.checks.length } : { template: r.template, status: r.status, ...(r.retry_skipped ? { retry_skipped: true } : {}), ...(r.in_progress ? { in_progress: true } : {}), reasons: r.reasons.map((x) => scrub(x, scrubRoots(s))) })),
      not_learnable: gaps.filter((g) => !g.learnable).map((g) => ({ operation_id: g.operation_id, template: g.template, reason: "no engine in this project implements it; it stays unsupported" })),
      view: planView(s, after),
    });
  });
  app.get("/api/sessions/:id/renders", (c) => {
    const s = session(c.req.param("id"));
    const dirs = renderDirs(s.dir, runIdOf(s));
    const ids = existsSync(dirs.records) ? readdirSync(dirs.records).filter((f) => /^rn_[a-f0-9]{16}\.json$/.test(f)).map((f) => f.slice(0, -5)) : [];
    const records = ids.map((id) => loadRenderRecord(dirs.records, id)).flatMap((r) => (r.record ? [publicRecord(r.record, s.id, dirs.root, scrubRoots(s))] : []));
    return c.json({ records });
  });

  /** Plays a rendered preview. Served only for a record that says rendered, whose file is inside this run's output folder and still matches its recorded size and SHA-256. */
  const verified = new Map<string, true>();
  app.get("/api/sessions/:id/renders/:renderId/video", async (c) => {
    const s = session(c.req.param("id"));
    const renderId = c.req.param("renderId");
    const dirs = renderDirs(s.dir, runIdOf(s));
    const rec = RENDER_ID.test(renderId) ? loadRenderRecord(dirs.records, renderId).record : null;
    if (!rec || rec.state !== "rendered" || !rec.output) throw new HttpError(404, "no_video", "There is no validated video for that render.");
    return serveVideo(c, dirs.out, rec.output.path, rec.output.bytes, rec.output.sha256);
  });
  app.get("/api/sessions/:id/deliveries", (c) => {
    const s = session(c.req.param("id"));
    const dirs = renderDirs(s.dir, runIdOf(s));
    const files = existsSync(dirs.records) ? readdirSync(dirs.records).filter((f) => /^dl_[a-f0-9]{16}\.delivery\.json$/.test(f)) : [];
    return c.json({ deliveries: files.flatMap((f) => { const r = loadDeliveryReport(join(dirs.records, f)); return r ? [publicDelivery(s, r, dirs.root)] : []; }) });
  });
  app.get("/api/sessions/:id/deliveries/:deliveryId", (c) => {
    const s = session(c.req.param("id"));
    const id = c.req.param("deliveryId");
    const dirs = renderDirs(s.dir, runIdOf(s));
    const r = /^dl_[a-f0-9]{16}$/.test(id) ? loadDeliveryReport(join(dirs.records, `${id}.delivery.json`)) : null;
    if (!r) throw new HttpError(404, "no_delivery", "There is no such delivery report.");
    return c.json(publicDelivery(s, r, dirs.root));
  });
  /** Plays the video of a delivery report, complete or incomplete. Served only for a file inside the run output folder that matches the report size and SHA-256. */
  app.get("/api/sessions/:id/deliveries/:deliveryId/video", async (c) => {
    const s = session(c.req.param("id"));
    const id = c.req.param("deliveryId");
    const dirs = renderDirs(s.dir, runIdOf(s));
    const r = /^dl_[a-f0-9]{16}$/.test(id) ? loadDeliveryReport(join(dirs.records, `${id}.delivery.json`)) : null;
    if (!r?.output) throw new HttpError(404, "no_video", "There is no validated video for that delivery.");
    return serveVideo(c, dirs.out, r.output.path, r.output.bytes, r.output.sha256, r.kind === "complete" ? "complete" : "incomplete");
  });
  async function serveVideo(c: Context, outDir: string, path: string, bytes: number, sha256: string, label?: string) {
    if (!isInside(outDir, path)) throw new HttpError(404, "no_video", "There is no validated video for that render.");
    const st = await stat(path).catch(() => null);
    if (!st?.isFile() || st.size !== bytes) throw new HttpError(409, "output_changed", "The video file is missing or no longer matches its record, so it is not served.");
    const key = `${path}:${st.size}:${st.mtimeMs}:${sha256}`;
    if (!verified.has(key)) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
      if (hash.digest("hex") !== sha256) throw new HttpError(409, "output_changed", "The video file is missing or no longer matches its record, so it is not served.");
      verified.set(key, true);
    }
    const size = st.size;
    const headers: Record<string, string> = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...(label ? { "X-Digikon-Preview": label } : {}) };
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      return new Response(Readable.toWeb(createReadStream(path, { start, end })) as never, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
    }
    return new Response(Readable.toWeb(createReadStream(path)) as never, { headers: { ...headers, "Content-Length": String(size) } });
  }

  // The page and its script are always revalidated, so a console update is never hidden behind a cached copy of an older app.js.
  app.use("/*", async (c, next) => { await next(); if (!c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-cache"); });
  app.use("/*", serveStatic({ root: ctx.publicDir }));
  return app;
}

const label = (stage: "storyboard" | "edit_plan") => (stage === "storyboard" ? "storyboard" : "edit plan");

function summarise(state: Record<string, unknown>, ctx: Pick<AppContext, "recipes">) {
  const s = state as Record<string, unknown>;
  const d = state as unknown as DirectorStateType;
  const sb = currentStoryboard(d), ep = currentEditPlan(d);
  const check = checkRenderable(d, ctx); // the same guard a future render must pass; shown so the console never implies more than is true
  const scenes = d.scenePlan?.scenes ?? [];
  const total = Math.round(scenes.reduce((a, x) => a + x.duration_seconds, 0) * 1000) / 1000;
  return {
    timing: { total_s: total, target_s: d.project.target_duration, scenes: scenes.length, matches_target: Math.abs(total - d.project.target_duration) <= RUNTIME_TOLERANCE_S },
    claimsAudit: d.treatmentDoc ? auditClaims(d.treatmentDoc.claims, scenes, d.facts ?? []) : [],
    assetFeasibility: d.scenePlan ? assetFeasibility(d.scenePlan, d.assets) : null,
    status: s["status"], intake: s["intakeResult"] ?? null, treatment: s["treatmentDoc"] ?? null,
    scenePlan: s["scenePlan"] ?? null, editPlan: s["editPlan"] ?? null, escalation: plainEscalation(s["escalation"] as Parameters<typeof plainEscalation>[0]),
    gate: s["gate"] ?? null,
    versions: { storyboard: sb?.version ?? null, edit_plan: ep?.version ?? null },
    hashes: { storyboard: sb?.hash ?? null, edit_plan: ep?.hash ?? null },
    approvals: publicApprovals((s["approvals"] ?? []) as Parameters<typeof publicApprovals>[0]),
    revisions: { used: s["revisions"] ?? { storyboard: 0, edit_plan: 0 }, max: MAX_REVISIONS },
    renderable: check.ok ? { ok: true, reasons: [] as string[] } : { ok: false, reasons: plainReasons(check.reasons) },
    citations: s["citations"] ?? [], skillsUsed: s["skillsUsed"] ?? [], referencesUsed: s["referencesUsed"] ?? [], trace: s["trace"] ?? [], notes: s["notes"] ?? [],
    videoType: s["chosenVideoType"] ?? null, proposedVideoTypes: s["proposedVideoTypes"] ?? [],
    requirementsSheet: s["requirementsSheet"] ?? null,
    aspectRatio: (s["project"] as { aspect_ratio?: string } | undefined)?.aspect_ratio ?? null,
  };
}
