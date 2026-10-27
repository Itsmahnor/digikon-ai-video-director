import { createReadStream, readdirSync, writeFileSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { z, ZodError } from "zod";
import { ApprovalSubmission, BrandFact, RUNTIME_TOLERANCE_S, Turn, assetFeasibility, auditClaims, type Asset, type AssetNotes, type DirectorHandoff, type RenderRecord, type RouteResult, type Transcript } from "@digikon/contracts";
import {
  Command, HandoffRefusedError, MAX_REVISIONS, PersistenceError, RunStore, StaleApprovalError, buildDirectorGraph, buildHandoff, buildRunRecord, checkRenderable, classifyLlmError, currentEditPlan, currentStoryboard,
  checkpointOf, restoreRun, runEditor, verifyHandoffWithStore,
  type DirectorStateType, type LlmClient, type SkillLibrary,
} from "@digikon/director";
import {
  AdapterRegistry, FFMPEG_TEMPLATES, HYPERFRAMES_TEMPLATES, NO_ADAPTERS, REMOTION_TEMPLATES, buildRenderEvidence, createFfmpegAdapter, createHyperframesAdapter, createRemotionAdapter, executeRender, loadRenderRecord, planRender, previewCoverage, runRenderQa, saveRenderEvidence, saveRenderRecord, selectRenderer,
  type PlanResult, type RenderAdapter,
} from "@digikon/render";
import { isInside, loadEditorOutput, publicRecord, renderDirs, saveEditorOutput, scrub, timelineEnd } from "./render-service.js";
import { ALL_EXTENSIONS, MEDIA_LIMITS, analyseMedia, buildAssetNotes, probeFile } from "@digikon/media";
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
}

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
const DirectBody = z.object({ facts: z.array(z.string().trim().min(1).max(300)).max(20).default([]) });

class HttpError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 422 | 503, readonly code: string, message: string) { super(message); }
}

export function createApp(ctx: AppContext) {
  const app = new Hono();
  const sessions = new Map<string, Session>();
  /** Last model failure that needs the owner's attention (billing, key, model). Shown in the status bar until a call succeeds. */
  let llmProblem: { code: string; message: string } | null = null;
  const noteLlm = (e: { code: string; message: string } | null) => { llmProblem = e && ['llm_billing', 'llm_auth', 'llm_model'].includes(e.code) ? { code: e.code, message: e.message } : llmProblem; };

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
    if (err instanceof HandoffRefusedError) return c.json({ error: "handoff_refused", message: err.message, reasons: err.reasons }, 409);
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
    render: { available: ctx.ffmpegOk && !!ctx.renderFont && !!ctx.editorSkills, templates: [...Object.keys(FFMPEG_TEMPLATES), ...Object.keys(REMOTION_TEMPLATES), ...Object.keys(HYPERFRAMES_TEMPLATES)], renderers: availableRenderers(), note: "Preview renders only. Nothing is production-ready." },
    limits: { maxVoicePromptSeconds: MEDIA_LIMITS.maxVoicePromptSeconds, maxAssets: MEDIA_LIMITS.maxAssetsPerProject, maxRequestMb: MAX_REQUEST_BYTES / 1048576, extensions: ALL_EXTENSIONS },
  }));

  app.post("/api/sessions", async (c) => {
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const dir = join(ctx.storageDir, "sessions", id);
    await mkdir(join(dir, "uploads"), { recursive: true });
    sessions.set(id, { id, dir, assets: [], turns: [], route: null, facts: [], analysis: new Map(), pending: new Map() });
    return c.json({ id });
  });

  /** Measures a file and transcribes its speech without blocking the upload. The Director waits for this before planning. */
  const analyseAsset = (s: Session, asset: Asset): void => {
    if (asset.media_type === "image") {
      s.analysis.set(asset.asset_id, { status: "done", notes: buildAssetNotes(asset, null), transcript: null, note: null });
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
      // Hash while writing, so the content hash costs no extra read. It is checked again before any handoff.
      const hash = createHash("sha256");
      const tee = new Transform({ transform(chunk: Buffer, _enc, done) { hash.update(chunk); done(null, chunk); } });
      await pipeline(Readable.fromWeb(file.stream() as never), tee, createWriteStream(path));
      const probed = await probeFile(path, { assetId, originalName: name });
      if (probed.ok) added.push({ ...probed.asset, metadata: { ...probed.asset.metadata, sha256: hash.digest("hex") } });
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

    s.facts = body.facts.map((text, i) => BrandFact.parse({ fact_id: `F${String(i + 1).padStart(2, "0")}`, text, source: "entered in the console" }));
    s.threadId = `${s.id}-${Date.now()}`;
    // Every gate decision is written to storage/sessions/<id>/runs/<run id>/approvals before it takes effect.
    s.graph = buildDirectorGraph({ llm, skills: ctx.skills, retriever: ctx.retriever, recipes: ctx.recipes, approvalLog: new RunStore(s.dir).approvalLog(s.threadId) });
    const graph = s.graph;
    const config = { configurable: { thread_id: s.threadId } };
    const project = request.project;
    const assets = s.assets;
    const facts = s.facts;
    await Promise.allSettled([...s.pending.values()]); // measurements and transcripts must be ready before planning
    const notes = assets.map((a) => s.analysis.get(a.asset_id)?.notes).filter((n): n is AssetNotes => !!n);

    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
      try {
        await send("start", { nodes: ["intake", "analyse_assets", "treatment", "storyboard", "storyboard_gate", "edit_plan", "edit_plan_gate"] });
        for await (const chunk of await graph.stream({ project, assets, facts, notes }, { ...config, streamMode: "updates" })) {
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
      return c.json({ state: summarise(state, ctx), record, checkpoint: saveCheckpoint(s, state) });
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
    const graph = buildDirectorGraph({ llm, skills: ctx.skills, retriever: ctx.retriever, recipes: ctx.recipes, approvalLog: store.approvalLog(runId) });
    const r = await restoreRun({ store, graph, session_id: id, run_id: runId, ctx: { recipes: ctx.recipes, storageRoot: dir, requireContentHash: true } });
    if (!r.ok) {
      if (r.missing) throw new HttpError(404, "no_checkpoint", r.reasons[0]!);
      return c.json({ error: "cannot_resume", message: "This run cannot be resumed safely. Start a new run from the same files.", reasons: r.reasons }, 409);
    }
    const st = r.state;
    const analysis = new Map(st.notes.map((n) => [n.asset_id, { status: "done" as const, notes: n, transcript: null, note: null }]));
    sessions.set(id, { id, dir, assets: st.assets, turns: [], route: null, facts: st.facts, analysis, pending: new Map(), graph, threadId: runId });
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
    if (!ctx.ffmpegOk || !ctx.renderFont) return { registry: NO_ADAPTERS, available: false };
    // Every renderer that can run on this machine is registered; one that cannot (for example no browser) is simply absent, and a plan that needs it is blocked.
    const adapters: RenderAdapter[] = [];
    for (const make of [createFfmpegAdapter, createRemotionAdapter, createHyperframesAdapter]) { try { adapters.push(make({ fontFile: ctx.renderFont, outputRoot: out })); } catch { /* not available here */ } }
    return adapters.length ? { registry: new AdapterRegistry(adapters), available: true } : { registry: NO_ADAPTERS, available: false };
  };
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
    const base = { recipes: ctx.recipes, adapters: registry, outputRoot: dirs.out, store: new RunStore(s.dir), storageRoot: s.dir, requireContentHash: true };
    const planned = planRender({ editor_output: stored.output, handoff, settings, purpose: "preview" }, base);
    if (!planned.ok) throw new HandoffRefusedError(planned.reasons.map((r) => scrub(r, scrubRoots(s))));
    const production = planRender({ editor_output: stored.output, handoff, settings, purpose: "production" }, base);
    const selection = selectRenderer(planned.record);
    const coverage = previewCoverage(handoff, stored.output, planned.record, selection.capabilities);
    const eligible = planned.record.state === "executable" && coverage.complete && !!planned.plan;
    return { runId, handoff, dirs, editor: stored.output, planned: planned as Extract<PlanResult, { ok: true }>, production, coverage, selection, registered: registry.renderers(), eligible, available };
  };

  const planView = (s: Session, p: Awaited<ReturnType<typeof prepare>>) => {
    const sceneOf = new Map(p.editor.operations.map((o) => [o.operation_id, o.target_scene_id]));
    const ops = p.planned.record.operations.map((o) => ({ operation_id: o.operation_id, scene_id: sceneOf.get(o.operation_id) ?? null, recipe_id: o.recipe_id, template: o.implementation_ref, renderer: o.renderer, supported: o.renderer !== null }));
    const blockers = [...new Set([...p.planned.record.blockers, ...p.coverage.scenes.flatMap((x) => x.missing.map((m) => `${x.scene_id}: ${m}`))])].map((b) => scrub(b, scrubRoots(s)));
    return {
      run_id: p.runId,
      renderer_available: p.available,
      editor: { status: p.editor.status, validation: p.editor.validation, conflicts: p.editor.conflicts, revision_requests: p.editor.revision_requests, operations: p.editor.operations.length, rendered: p.editor.execution.rendered },
      renderer: { selected: p.selection.selected, needed: p.selection.needed, composition_required: p.selection.composition_required, registered: p.registered },
      plan: { state: p.planned.record.state, purpose: "preview" as const, operations: ops, supported: ops.filter((o) => o.supported).length, unsupported: ops.filter((o) => !o.supported).length, notes: p.planned.record.notes },
      coverage: p.coverage,
      eligible: p.eligible,
      blockers,
      /** A separate question from the preview: could this go to production? Never true while any recipe is a draft. */
      production: { ready: p.production.ok && p.production.record.state === "executable", blockers: p.production.ok ? p.production.record.blockers.map((b) => scrub(b, scrubRoots(s))) : [] },
      needs: { aspect_ratio: p.handoff.constraints.aspect_ratio, duration_s: timelineEnd(p.handoff), supported_output: { container: "mp4", video_codec: "h264", audio_codec: null }, you_provide: ["width", "height", "fps"] },
      label: p.eligible ? "Preview only: every approved scene rendered with the templates of the selected renderer. It is not production-ready." : "No preview can be made yet. Nothing here is rendered, and no partial video is offered.",
    };
  };

  /** Runs the Editor on the verified handoff. Deterministic checks only: no model is called. */
  app.post("/api/sessions/:id/editor", async (c) => {
    const s = session(c.req.param("id"));
    if (!ctx.editorSkills) throw new HttpError(503, "no_editor", "The Editor skills are not loaded, so the Editor cannot run.");
    const handoff = await currentHandoff(s); // refuses until both approvals match the current plans
    const run = await runEditor(handoff, { recipes: ctx.recipes, skills: ctx.editorSkills, retriever: ctx.retriever, store: new RunStore(s.dir), storageRoot: s.dir, requireContentHash: true });
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
   * Renders the preview, but only when the render plan is executable and the approved plan is fully shown by it. Otherwise 409
   * with every reason and nothing is started. A record is written before the renderer starts and again when it ends.
   */
  app.post("/api/sessions/:id/render", async (c) => {
    const s = session(c.req.param("id"));
    const body = SettingsBody.parse(await c.req.json().catch(() => ({})));
    if (s.rendering) throw new HttpError(409, "busy", "A preview is already being rendered for this session.");
    s.rendering = true;
    try {
      const p = await prepare(s, body.settings);
      const view = planView(s, p);
      if (!p.eligible || !p.planned.plan) return c.json({ error: "not_renderable", message: "A preview cannot be rendered yet.", ...view }, 409);
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
    const path = rec.output.path;
    if (!isInside(dirs.out, path)) throw new HttpError(404, "no_video", "There is no validated video for that render.");
    const st = await stat(path).catch(() => null);
    if (!st?.isFile() || st.size !== rec.output.bytes) throw new HttpError(409, "output_changed", "The video file is missing or no longer matches its record, so it is not served.");
    const key = `${path}:${st.size}:${st.mtimeMs}:${rec.output.sha256}`;
    if (!verified.has(key)) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
      if (hash.digest("hex") !== rec.output.sha256) throw new HttpError(409, "output_changed", "The video file is missing or no longer matches its record, so it is not served.");
      verified.set(key, true);
    }
    const size = st.size;
    const headers: Record<string, string> = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      return new Response(Readable.toWeb(createReadStream(path, { start, end })) as never, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
    }
    return new Response(Readable.toWeb(createReadStream(path)) as never, { headers: { ...headers, "Content-Length": String(size) } });
  });

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
    scenePlan: s["scenePlan"] ?? null, editPlan: s["editPlan"] ?? null, escalation: s["escalation"] ?? null,
    gate: s["gate"] ?? null,
    versions: { storyboard: sb?.version ?? null, edit_plan: ep?.version ?? null },
    hashes: { storyboard: sb?.hash ?? null, edit_plan: ep?.hash ?? null },
    approvals: s["approvals"] ?? [],
    revisions: { used: s["revisions"] ?? { storyboard: 0, edit_plan: 0 }, max: MAX_REVISIONS },
    renderable: check.ok ? { ok: true, reasons: [] as string[] } : { ok: false, reasons: check.reasons },
    citations: s["citations"] ?? [], skillsUsed: s["skillsUsed"] ?? [], referencesUsed: s["referencesUsed"] ?? [], trace: s["trace"] ?? [], notes: s["notes"] ?? [],
  };
}
