import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ArtDirection, Asset, Scene, SoundPolicy } from "@digikon/contracts";

const run = promisify(execFile);

/**
 * The film's sound, planned from what the approved storyboard asks for and mixed by FFmpeg after the picture is assembled. Everything is local: music and effects are
 * synthesised, narration comes from a supplied recording or the machine's own speech synthesiser. A requirement that cannot be met is `unresolved`, which keeps the plan
 * from Gate 2 and the film from being complete; nothing is dropped silently. Generated sound is labelled as generated, never presented as a licensed track or a voice artist.
 */

export type Sfx = "whoosh" | "hit" | "chime" | "click";
export type MusicFeel = ArtDirection["motion_language"]["feel"];
export type AudioTrack =
  | { kind: "narration"; scene_id: string; start_s: number; max_s: number; source: "tts"; text: string }
  | { kind: "narration"; scene_id: string; start_s: number; max_s: number; source: "supplied"; asset_id: string }
  | { kind: "music"; source: "supplied"; asset_id: string }
  | { kind: "music"; source: "generated"; feel: MusicFeel }
  | { kind: "sfx"; scene_id: string; at_s: number; sound: Sfx; cue: string };

export interface AudioPlan {
  /** True when the approved storyboard asks for any sound. */
  required: boolean;
  tracks: AudioTrack[];
  /** What cannot be produced here, by scene. Empty means every requested sound can be made. */
  unresolved: { scene_id: string; detail: string }[];
  /** Stated on the delivery report so that generated sound is never mistaken for something else. */
  labels: string[];
}

/** What this machine can make. `tts` is the local speech synthesiser, or null when there is none. */
export interface AudioCapabilities { tts: "sapi" | "espeak" | null }

const SFX_CUES: readonly [RegExp, Sfx][] = [[/\b(whoosh|swoosh|swish|sweep|riser)\b/i, "whoosh"], [/\b(hit|impact|thud|boom|stinger|sting)\b/i, "hit"], [/\b(chime|ding|bell|notification)\b/i, "chime"], [/\b(click|tick|tap|pop|snap)\b/i, "click"]];
const MUSIC_CUE = /\b(music|bed|score|soundtrack|ambien\w*|pad|beat|melody|piano|strings|drone|underscore)\b/i;
/** A speaking rate that stays clear. Longer narration does not fit its scene, and is reported before approval rather than cut off or sped up. */
const WORDS_PER_SECOND = 2.8;

/** Whether the machine has a speech synthesiser. Looked for once, at start-up: the check starts a process. */
export function detectAudio(): AudioCapabilities {
  if (process.platform === "win32") {
    try { execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Speech"], { stdio: "ignore", timeout: 15_000, windowsHide: true }); return { tts: "sapi" }; } catch { /* none */ }
  }
  try { execFileSync("espeak-ng", ["--version"], { stdio: "ignore", timeout: 5_000 }); return { tts: "espeak" }; } catch { return { tts: null }; }
}

export function planAudio(story: { scenes: readonly Pick<Scene, "scene_id" | "start_time" | "duration_seconds" | "voiceover" | "audio_cues" | "asset_ids">[]; assets: readonly Pick<Asset, "asset_id" | "media_type">[]; feel?: MusicFeel | null; /** What the brief rules out. A kind of sound it rules out is never planned, whatever the storyboard cues or the files supplied say: the brief wins. */ policy?: SoundPolicy | null }, caps: AudioCapabilities | null): AudioPlan {
  const kind = new Map(story.assets.map((a) => [a.asset_id, a.media_type]));
  const tracks: AudioTrack[] = [], unresolved: AudioPlan["unresolved"] = [], labels: string[] = [];
  const pol = story.policy ?? null, left: string[] = [];
  let wantsMusic = false, musicCueScene: string | null = null;
  const usedAudio = new Set<string>();
  for (const s of story.scenes) {
    const supplied = s.asset_ids.filter((id) => kind.get(id) === "audio");
    if (s.voiceover && pol && !pol.narration) { if (!left.includes("narration")) left.push("narration"); }
    else if (s.voiceover) {
      const words = s.voiceover.trim().split(/\s+/).length;
      if (supplied[0]) { usedAudio.add(supplied[0]); tracks.push({ kind: "narration", scene_id: s.scene_id, start_s: s.start_time, max_s: s.duration_seconds, source: "supplied", asset_id: supplied[0] }); }
      else if (!caps?.tts) unresolved.push({ scene_id: s.scene_id, detail: "its voiceover needs a recording or a speech synthesiser, and neither is available here" });
      else if (words / WORDS_PER_SECOND > s.duration_seconds) unresolved.push({ scene_id: s.scene_id, detail: `its voiceover has ${words} words, which does not fit ${s.duration_seconds}s when spoken clearly; shorten it or lengthen the scene` });
      else tracks.push({ kind: "narration", scene_id: s.scene_id, start_s: s.start_time, max_s: s.duration_seconds, source: "tts", text: s.voiceover.trim() });
    }
    for (const cue of s.audio_cues) {
      const sfx = SFX_CUES.find(([re]) => re.test(cue));
      if (sfx) { if (pol && !pol.effects) { if (!left.includes("sound effects")) left.push("sound effects"); } else tracks.push({ kind: "sfx", scene_id: s.scene_id, at_s: s.start_time, sound: sfx[1], cue }); }
      else if (MUSIC_CUE.test(cue)) { if (pol && !pol.music) { if (!left.includes("music")) left.push("music"); } else { wantsMusic = true; musicCueScene ??= s.scene_id; } }
      else unresolved.push({ scene_id: s.scene_id, detail: `its audio cue ("${cue.slice(0, 60)}") names no sound that can be made here (music, a whoosh, a hit, a chime or a click)` });
    }
  }
  const music = story.scenes.flatMap((s) => s.asset_ids).find((id) => kind.get(id) === "audio" && !usedAudio.has(id));
  if (music && pol && !pol.music) { if (!left.includes("music")) left.push("music"); }
  else if (music) tracks.push({ kind: "music", source: "supplied", asset_id: music });
  else if (wantsMusic) { tracks.push({ kind: "music", source: "generated", feel: story.feel ?? "calm" }); labels.push(`the music is a bed generated on this computer (${story.feel ?? "calm"}), not a licensed track`); }
  if (left.length) labels.push(`left out because the brief rules it out: ${left.join(", ")}`);
  if (tracks.some((t) => t.kind === "narration" && t.source === "tts")) labels.push(`the narration is spoken by this computer's speech synthesiser (${caps?.tts}), not a voice artist`);
  if (tracks.some((t) => t.kind === "sfx")) labels.push("the sound effects are synthesised on this computer");
  return { required: tracks.length > 0 || unresolved.length > 0, tracks, unresolved, labels };
}

/** A chord or pattern per feel, so a calm film and a snappy one do not share a bed. Expressions for FFmpeg's `aevalsrc`; `t` is seconds. */
const MUSIC_EXPR: Record<MusicFeel, { expr: string; filter: string }> = {
  calm: { expr: "0.22*sin(2*PI*220*t)*(0.7+0.3*sin(2*PI*0.11*t))+0.16*sin(2*PI*261.63*t)*(0.7+0.3*sin(2*PI*0.07*t))+0.16*sin(2*PI*329.63*t)*(0.7+0.3*sin(2*PI*0.09*t))+0.1*sin(2*PI*493.88*t)*(0.6+0.4*sin(2*PI*0.05*t))", filter: "lowpass=f=1100" },
  precise: { expr: "0.34*exp(-9*mod(t,0.5))*sin(2*PI*196*t)+0.18*sin(2*PI*98*t)+0.14*exp(-14*mod(t+0.25,0.5))*sin(2*PI*587.33*t)", filter: "lowpass=f=2400" },
  snappy: { expr: "0.42*exp(-16*mod(t,0.25))*sin(2*PI*(220+110*eq(mod(floor(t*4),4),2))*t)+0.24*exp(-30*mod(t,0.5))*sin(2*PI*70*t)", filter: "highpass=f=60" },
  playful: { expr: "0.34*exp(-7*mod(t,0.25))*sin(2*PI*(392+99*mod(floor(t*4),3)+198*gt(mod(floor(t*4),8),5))*t)+0.12*sin(2*PI*196*t)", filter: "lowpass=f=3200" },
};

const SFX_INPUT: Record<Sfx, { lavfi: string; filter: string; seconds: number }> = {
  whoosh: { lavfi: "anoisesrc=color=pink:amplitude=0.7:r=48000:seed=7", filter: "bandpass=f=1400:w=1800,afade=t=in:d=0.28,afade=t=out:st=0.28:d=0.32", seconds: 0.6 },
  hit: { lavfi: "aevalsrc=0.9*exp(-7*t)*sin(2*PI*62*t):s=48000", filter: "lowpass=f=240", seconds: 0.7 },
  chime: { lavfi: "aevalsrc=0.5*exp(-5*t)*sin(2*PI*1046.5*t)+0.3*exp(-6*t)*sin(2*PI*1568*t):s=48000", filter: "anull", seconds: 0.8 },
  click: { lavfi: "aevalsrc=0.8*exp(-120*t)*sin(2*PI*1900*t):s=48000", filter: "anull", seconds: 0.1 },
};

const LUFS_TARGET = -16;

/** A silent-looking mean level. Anything quieter than this over a stretch that should have sound means the sound is not there. */
const SILENCE_DB = -50;

async function speak(text: string, wav: string, caps: AudioCapabilities, work: string, signal?: AbortSignal): Promise<void> {
  if (caps.tts === "espeak") { await run("espeak-ng", ["-w", wav, text], { signal, windowsHide: true }); return; }
  // the text goes through a file: it is approved copy, but it must never be read as part of a command
  const file = join(work, `${wav.split(/[\\/]/).pop()}.txt`);
  writeFileSync(file, text, "utf8");
  const quote = (p: string) => `'${p.replaceAll("'", "''")}'`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile(${quote(wav)}); $s.Speak([IO.File]::ReadAllText(${quote(file)})); $s.Dispose()`], { signal, windowsHide: true, timeout: 60_000 });
}

export interface MixInput {
  plan: AudioPlan;
  /** The assembled picture, with no audio. */
  video: string;
  duration_s: number;
  out: string;
  work: string;
  caps: AudioCapabilities;
  assetFile: (asset_id: string) => string | null;
  ffmpeg?: string;
  signal?: AbortSignal;
}

/** The FFmpeg command that lays the planned sound under the picture. The picture is copied, so the frames that were checked are the frames delivered. */
export async function mixAudio(m: MixInput): Promise<void> {
  const inputs: string[] = ["-i", m.video];
  const graph: string[] = [];
  const narration: string[] = [], beds: string[] = [], effects: string[] = [];
  let n = 1;
  for (const [i, t] of m.plan.tracks.entries()) {
    const label = `a${i}`;
    if (t.kind === "narration") {
      let file: string;
      if (t.source === "tts") { file = join(m.work, `voice-${i}.wav`); await speak(t.text, file, m.caps, m.work, m.signal); }
      else { const f = m.assetFile(t.asset_id); if (!f) throw new Error(`the file for audio ${t.asset_id} could not be found`); file = f; }
      inputs.push("-i", file);
      graph.push(`[${n++}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${t.max_s},adelay=${Math.round(t.start_s * 1000)}:all=1[${label}]`);
      narration.push(`[${label}]`);
    } else if (t.kind === "music") {
      if (t.source === "supplied") { const f = m.assetFile(t.asset_id); if (!f) throw new Error(`the file for audio ${t.asset_id} could not be found`); inputs.push("-stream_loop", "-1", "-i", f); graph.push(`[${n++}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${m.duration_s}[${label}]`); }
      else { const e = MUSIC_EXPR[t.feel]; inputs.push("-f", "lavfi", "-t", String(m.duration_s), "-i", `aevalsrc='${e.expr}':s=48000`); graph.push(`[${n++}:a]${e.filter},aformat=channel_layouts=stereo,afade=t=in:d=0.8,afade=t=out:st=${Math.max(0, m.duration_s - 1.2).toFixed(3)}:d=1.2,volume=0.7[${label}]`); }
      beds.push(`[${label}]`);
    } else {
      const s = SFX_INPUT[t.sound];
      inputs.push("-f", "lavfi", "-t", String(s.seconds), "-i", s.lavfi);
      graph.push(`[${n++}:a]${s.filter},aformat=sample_rates=48000:channel_layouts=stereo,adelay=${Math.round(t.at_s * 1000)}:all=1,volume=0.8[${label}]`);
      effects.push(`[${label}]`);
    }
  }
  const mix = (xs: string[], out: string) => { if (xs.length === 1) graph.push(`${xs[0]}anull[${out}]`); else graph.push(`${xs.join("")}amix=inputs=${xs.length}:duration=longest:normalize=0[${out}]`); };
  const stems: string[] = [];
  if (narration.length) mix(narration, "voice");
  if (beds.length) mix(beds, "bed");
  if (effects.length) { mix(effects, "fx"); stems.push("[fx]"); }
  if (narration.length && beds.length) {
    // the music gives way while someone is speaking
    graph.push("[voice]asplit=2[vo][key]", "[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked]");
    stems.push("[vo]", "[ducked]");
  } else if (narration.length) stems.push("[voice]");
  else if (beds.length) stems.push("[bed]");
  if (stems.length === 1) graph.push(`${stems[0]}anull[all]`); else graph.push(`${stems.join("")}amix=inputs=${stems.length}:duration=longest:normalize=0[all]`);
  graph.push(`[all]apad,atrim=duration=${m.duration_s},loudnorm=I=${LUFS_TARGET}:TP=-1.5:LRA=11,aresample=48000[mixed]`);
  await run(m.ffmpeg ?? "ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-n", ...inputs, "-filter_complex", graph.join(";"), "-map", "0:v", "-map", "[mixed]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", String(m.duration_s), "-movflags", "+faststart", m.out], { signal: m.signal, maxBuffer: 1 << 22, windowsHide: true });
}

async function meanVolume(file: string, ffmpeg: string, start: number | null, seconds: number | null): Promise<number> {
  const { stderr } = await run(ffmpeg, ["-hide_banner", "-nostdin", ...(start !== null ? ["-ss", start.toFixed(3)] : []), ...(seconds !== null ? ["-t", seconds.toFixed(3)] : []), "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], { maxBuffer: 1 << 22, windowsHide: true });
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  return m && m[1] !== "-inf" ? Number(m[1]) : -Infinity;
}

export interface AudioCheck { ok: boolean; checks: string[]; problems: string[] }

/** The sound as it is in the finished file: there overall, and there in each scene that was promised narration or an effect. Levels are measured, never assumed. */
export async function checkMixedAudio(file: string, plan: AudioPlan, ffmpeg = "ffmpeg"): Promise<AudioCheck> {
  const checks: string[] = [], problems: string[] = [];
  const all = await meanVolume(file, ffmpeg, null, null);
  if (all < SILENCE_DB) problems.push(`the film's sound track is silent (mean ${all} dB)`); else checks.push(`the film's sound track is present (mean ${all.toFixed(1)} dB)`);
  for (const t of plan.tracks) {
    if (t.kind === "music") continue;
    const start = t.kind === "narration" ? t.start_s : t.at_s;
    const seconds = t.kind === "narration" ? t.max_s : 0.5;
    const db = await meanVolume(file, ffmpeg, start, seconds);
    const what = t.kind === "narration" ? `${t.scene_id}'s narration` : `${t.scene_id}'s ${t.sound}`;
    if (db < SILENCE_DB) problems.push(`${what} cannot be heard (mean ${db} dB at ${start}s)`); else checks.push(`${what} is present (mean ${db.toFixed(1)} dB at ${start}s)`);
  }
  return { ok: problems.length === 0, checks, problems };
}
