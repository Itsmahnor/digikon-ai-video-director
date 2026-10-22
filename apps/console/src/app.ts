import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { z, ZodError } from "zod";
import { ApprovalSubmission, BrandFact, Turn, type Asset, type AssetNotes, type RouteResult, type Transcript } from "@digikon/contracts";
import {
  Command, MAX_REVISIONS, StaleApprovalError, buildDirectorGraph, buildRunRecord, checkRenderable, classifyLlmError, currentEditPlan, currentStoryboard,
  type DirectorStateType, type LlmClient, type SkillLibrary,
} from "@digikon/director";
import { ALL_EXTENSIONS, MEDIA_LIMITS, analyseMedia, buildAssetNotes, probeFile } from "@digikon/media";
import type { Retriever } from "@digikon/rag";
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
  recipes: RecipeLibrary;
  ffmpegOk: boolean;
  storageDir: string;
  publicDir: string;
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
}

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
  const guardSize = (req: Request) => {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_REQUEST_BYTES) throw new HttpError(413, "too_large", `Upload is larger than ${MAX_REQUEST_BYTES / 1048576} MB for this console.`);
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status);
    if (err instanceof StaleApprovalError) return c.json({ error: "stale_approval", message: err.message }, 409);
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
      await pipeline(Readable.fromWeb(file.stream() as never), createWriteStream(path));
      const probed = await probeFile(path, { assetId, originalName: name });
      if (probed.ok) added.push(probed.asset);
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
    s.graph = buildDirectorGraph({ llm, skills: ctx.skills, retriever: ctx.retriever, recipes: ctx.recipes });
    s.threadId = `${s.id}-${Date.now()}`;
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
        await send("state", summarise(state, ctx));
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
      return c.json({ state: summarise(state, ctx), record });
    } finally {
      s.deciding = false;
    }
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
  return {
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
