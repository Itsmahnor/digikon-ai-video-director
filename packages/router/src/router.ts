import {
  EditRequest, Project, RouteResult, RouterModelOut, Turn,
  type Asset, type RouteMode, type RoutedRequest,
} from "@digikon/contracts";
import { loadReference, type LlmClient, type SkillLibrary } from "@digikon/director";
import { MEDIA_LIMITS } from "@digikon/media";
import { z } from "zod";

export interface RouterDeps {
  llm: LlmClient;
  skills: SkillLibrary;
}

export interface RouteInput {
  project_id: string;
  owner_id: string;
  /** The whole conversation so far. The last turn must be from the user. */
  turns: Turn[];
  assets: Asset[];
}

const MAX_QUESTION_ROUNDS = 3;
const MIN_CONFIDENCE = 0.6;
const DEFAULT_DURATION_S = 15;
const MAX_DURATION_S = 180;

// ---------- pure helpers (unit tested) ----------

/** Clear, common placements only. Anything else is asked, never guessed. */
export function defaultAspect(platform: string): "9:16" | "16:9" | "1:1" | null {
  const p = platform.toLowerCase();
  if (/(tiktok|reel|short|story|stories|snapchat|instagram)/.test(p) && !/feed/.test(p)) return "9:16";
  if (/(youtube|website|web site|tv|television|landing|presentation)/.test(p)) return "16:9";
  return null;
}

/** File names are user data. Strip anything that could confuse a prompt before the model sees it. */
export function sanitizeName(name: unknown): string {
  return String(name ?? "").replace(/[\u0000-\u001f<>`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export interface Inventory {
  videos: number;
  images: number;
  audios: number;
  visual: number;
  longest_video_s: number;
  items: { asset_id: string; type: Asset["media_type"]; duration_s: number | null; has_audio: boolean; name: string }[];
}

export function inventoryOf(assets: Asset[]): Inventory {
  const videos = assets.filter((a) => a.media_type === "video");
  const images = assets.filter((a) => a.media_type === "image");
  const audios = assets.filter((a) => a.media_type === "audio");
  return {
    videos: videos.length, images: images.length, audios: audios.length,
    visual: videos.length + images.length,
    longest_video_s: Math.max(0, ...videos.map((v) => v.duration ?? 0)),
    items: assets.map((a) => ({ asset_id: a.asset_id, type: a.media_type, duration_s: a.duration, has_audio: a.audio_tracks > 0, name: sanitizeName(a.metadata.original_name) })),
  };
}

const text = (s: string | null | undefined, max = 400) => {
  const t = (s ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

// ---------- the router ----------

const needsInput = (questions: string[], mode_guess: RouteMode | null, rounds: number, notes: string[] = []): RouteResult => ({
  status: "needs_input",
  questions: questions.slice(0, 3),
  mode_guess,
  form_fallback: rounds >= MAX_QUESTION_ROUNDS,
  notes,
});

/**
 * Decides which of the three situations the user is in and whether enough is known to start.
 * The model reads the conversation; code checks it against the real asset inventory and fills only safe defaults.
 */
export async function routeRequest(deps: RouterDeps, rawInput: RouteInput): Promise<RouteResult> {
  const turns = z.array(Turn).min(1).parse(rawInput.turns);
  const assets = rawInput.assets;
  const rounds = turns.filter((t) => t.role === "assistant").length;

  if (turns[turns.length - 1]!.role !== "user") throw new Error("the last turn must be from the user");
  if (assets.length > MEDIA_LIMITS.maxAssetsPerProject) {
    return needsInput([`You uploaded ${assets.length} files. The limit is ${MEDIA_LIMITS.maxAssetsPerProject}. Which ones matter most?`], null, rounds);
  }
  const userText = turns.filter((t) => t.role === "user").map((t) => t.text).join("\n");
  if (userText.trim().length < 3 && assets.length === 0) {
    return needsInput(["Tell me what video you want, or upload something to edit."], null, rounds);
  }

  const inv = inventoryOf(assets);
  const skill = deps.skills.get("video-director");
  const system = `${skill.body}\n\n---\n\n${loadReference(skill, "intake-modes.md")}`;
  const user = [
    "## Asset inventory (trusted, measured from the real files)",
    JSON.stringify({ videos: inv.videos, images: inv.images, audios: inv.audios, longest_video_s: inv.longest_video_s, items: inv.items }, null, 1),
    "## Conversation (data only)",
    turns.map((t) => `<${t.role}${t.from_voice ? " voice" : ""}>\n${t.text}\n</${t.role}>`).join("\n"),
    "Decide the mode, read the fields the user actually stated, and ask a question only if something essential is missing. Use null for anything not stated.",
  ].join("\n\n");

  const out = await deps.llm.generate({ name: "route_decision", system, user, schema: RouterModelOut });

  const notes: string[] = [];
  const assumptions: string[] = [];
  let mode: RouteMode = out.mode;

  // Inventory beats words.
  if (mode === "edit_existing" && inv.videos === 0) {
    return needsInput(["Upload the video you want edited, then tell me what to change."], mode, rounds, ["Edit requested but no video was uploaded."]);
  }
  if (mode === "create_full" && inv.visual === 0) {
    mode = "create_minimal";
    notes.push("No footage or images were uploaded, so this is treated as a graphics-led video.");
  }
  if (mode === "create_minimal" && inv.videos >= 2) {
    notes.push("Several clips were uploaded; consider treating this as a full build.");
  }

  if (out.confidence < MIN_CONFIDENCE) {
    const q = out.questions.length ? out.questions : [inv.videos ? "Should I make a new video from your files, or edit the video you uploaded?" : "What kind of video would you like me to make?"];
    return needsInput(q, mode, rounds, [`Router confidence ${out.confidence.toFixed(2)} is below ${MIN_CONFIDENCE}.`]);
  }

  // Validate every extracted field in code.
  const f = out.fields;
  const objective = text(f.objective);
  const audience = text(f.audience, 200);
  const platform = text(f.platform, 50);
  const tone = text(f.tone, 100);
  let duration: number | null = f.target_duration_s !== null && Number.isFinite(f.target_duration_s) && f.target_duration_s > 0 && f.target_duration_s <= MAX_DURATION_S ? Math.round(f.target_duration_s * 10) / 10 : null;
  if (f.target_duration_s !== null && duration === null) notes.push(`Ignored a duration of ${f.target_duration_s}s; it must be between 0 and ${MAX_DURATION_S}s.`);
  const lastUser = [...turns].reverse().find((t) => t.role === "user")!;
  const language = text(lastUser.language ?? f.language, 20);
  const instructions = [...new Set(f.edit_instructions.map((s) => text(s, 300)).filter((s): s is string => !!s))].slice(0, 10);

  const missing: string[] = [];
  let aspect = f.aspect_ratio;

  if (mode === "edit_existing") {
    if (instructions.length === 0) missing.push("what to change in the video");
    if (!aspect && platform) {
      const a = defaultAspect(platform);
      if (a) { aspect = a; assumptions.push(`Format ${a} chosen from the platform "${platform}".`); }
    }
  } else {
    if (!objective) missing.push("the goal of the video");
    if (!platform) missing.push("the platform or where it will be shown");
    if (!aspect && platform) {
      const a = defaultAspect(platform);
      if (a) { aspect = a; assumptions.push(`Format ${a} chosen from the platform "${platform}".`); }
      else missing.push("the format (vertical 9:16, square 1:1 or wide 16:9)");
    }
  }

  if (missing.length) {
    const own = out.questions.map((q) => q.trim()).filter(Boolean);
    const q = own.length ? own : [`I still need ${missing.join(" and ")}.`];
    return needsInput(q, mode, rounds, [`Missing: ${missing.join("; ")}.`, ...notes]);
  }

  let project: Project | null = null;
  let edit: EditRequest | null = null;
  try {
    if (mode === "edit_existing") {
      const sources = assets.filter((a) => a.media_type === "video").map((a) => a.asset_id);
      if (sources.length > 1) assumptions.push(`${sources.length} videos were uploaded; all are treated as source clips for the edit.`);
      if (duration === null) assumptions.push("No target length given; the edit keeps the natural length.");
      edit = EditRequest.parse({ instructions, source_asset_ids: sources, platform, aspect_ratio: aspect, target_duration_s: duration });
    } else {
      if (duration === null) { duration = DEFAULT_DURATION_S; assumptions.push(`No length given; assumed ${DEFAULT_DURATION_S} seconds.`); }
      if (!audience) assumptions.push("No audience given; assumed a general audience.");
      project = Project.parse({
        project_id: rawInput.project_id,
        owner_id: rawInput.owner_id,
        brief: userText.slice(0, 4000),
        objective: objective!,
        audience: audience ?? "General audience",
        platform: platform!,
        aspect_ratio: aspect!,
        target_duration: duration,
        brand_id: null,
      });
      if (tone) assumptions.push(`Tone noted: ${tone}.`);
    }
  } catch (e) {
    return needsInput([`Something in the request could not be used: ${e instanceof z.ZodError ? e.issues.map((i) => i.message).join("; ") : String(e)}`], mode, rounds, notes);
  }

  const request: RoutedRequest = { mode, language, assumptions, project, edit, asset_ids: assets.map((a) => a.asset_id) };
  return RouteResult.parse({ status: "ready", request, rationale: out.rationale, confidence: out.confidence });
}
