import { QAFinding, RevisionTicket, type OwnerSkill } from "@digikon/contracts";
import { analyseMedia, probeFile, type Span } from "@digikon/media";

export interface SceneSpan { scene_id: string; start: number; end: number }

export interface QaExpectation {
  duration_s: number;
  width: number;
  height: number;
  fps?: number;
  expect_audio: boolean;
  /** Platform or project loudness target in LUFS. Leave out when no verified target exists: loudness is then only reported. */
  loudness_target_lufs?: number;
  loudness_tolerance_lu?: number;
  max_true_peak_db?: number;
  /** Timeline of the plan, so a problem can be attributed to a scene. */
  scenes?: SceneSpan[];
  /** Stretches where black is intended, for example a dip-to-black transition. */
  allowed_black?: Span[];
  /** Stretches where a still picture is intended, for example the end card. */
  allowed_freeze?: Span[];
}

export interface TechnicalReport {
  findings: QAFinding[];
  /** Checks that passed, each with the measurement that proves it. A pass without evidence is not recorded. */
  passed: { check: string; evidence: string }[];
  measurements: Record<string, number | string | null>;
}

const covered = (s: Span, allowed: Span[] = [], tol = 0.15) => allowed.some((a) => s.start >= a.start - tol && s.end <= a.end + tol);
const r2 = (n: number) => Math.round(n * 100) / 100;
const range = (s: Span) => `${r2(s.start)}-${r2(s.end)}`;

/**
 * Checks a rendered file against what the plan promised. Every finding carries evidence and a scene when one applies.
 * This is the part of video QA that needs no model: it measures.
 */
export async function runTechnicalChecks(path: string, exp: QaExpectation): Promise<TechnicalReport> {
  const findings: QAFinding[] = [];
  const passed: TechnicalReport["passed"] = [];
  const measurements: TechnicalReport["measurements"] = {};
  let n = 0;
  const sceneAt = (t: number) => exp.scenes?.find((s) => t >= s.start && t < s.end)?.scene_id ?? null;
  const add = (f: Omit<QAFinding, "finding_id" | "status" | "suggested_fix"> & { suggested_fix?: string | null }) =>
    findings.push(QAFinding.parse({ finding_id: `F${String(++n).padStart(2, "0")}`, status: "open", suggested_fix: null, ...f }));

  const probed = await probeFile(path);
  if (!probed.ok) {
    add({ scene_id: null, severity: "critical", category: "technical", evidence_ref: "probe:unreadable", description: `The file cannot be played: ${probed.issues.map((i) => i.message).join(" ")}`, suggested_fix: "Re-render the video." });
    return { findings, passed, measurements };
  }
  const a = probed.asset;
  const hasVideo = a.media_type === "video";
  const duration = a.duration ?? 0;
  measurements["duration_s"] = r2(duration); measurements["width"] = a.width; measurements["height"] = a.height;
  measurements["fps"] = (a.metadata["fps"] as number | null) ?? null; measurements["audio_tracks"] = a.audio_tracks;

  if (!hasVideo) {
    add({ scene_id: null, severity: "critical", category: "technical", evidence_ref: "probe:no_video_stream", description: "The output has no video.", suggested_fix: "Re-render the video." });
    return { findings, passed, measurements };
  }

  // duration
  const tol = Math.max(0.25, 1 / (Number(measurements["fps"]) || 25));
  if (Math.abs(duration - exp.duration_s) > tol) {
    add({ scene_id: null, severity: Math.abs(duration - exp.duration_s) > exp.duration_s * 0.2 ? "critical" : "major", category: "technical", evidence_ref: `probe:duration=${r2(duration)}`, description: `The video lasts ${r2(duration)}s but the plan says ${r2(exp.duration_s)}s.`, suggested_fix: "Fix scene timing so the render matches the plan." });
  } else passed.push({ check: "duration", evidence: `probe:duration=${r2(duration)} (plan ${r2(exp.duration_s)})` });

  // resolution and frame rate
  if (a.width !== exp.width || a.height !== exp.height) {
    add({ scene_id: null, severity: "major", category: "technical", evidence_ref: `probe:size=${a.width}x${a.height}`, description: `The frame is ${a.width}x${a.height} but the project needs ${exp.width}x${exp.height}.`, suggested_fix: "Render at the project's resolution." });
  } else passed.push({ check: "resolution", evidence: `probe:size=${a.width}x${a.height}` });
  if (exp.fps !== undefined && measurements["fps"] !== null) {
    if (Math.abs(Number(measurements["fps"]) - exp.fps) > 0.5) add({ scene_id: null, severity: "minor", category: "technical", evidence_ref: `probe:fps=${measurements["fps"]}`, description: `Frame rate is ${measurements["fps"]} but ${exp.fps} was expected.`, suggested_fix: "Render at the project's frame rate." });
    else passed.push({ check: "frame_rate", evidence: `probe:fps=${measurements["fps"]}` });
  }

  // audio presence
  const hasAudio = a.audio_tracks > 0;
  if (exp.expect_audio && !hasAudio) {
    add({ scene_id: null, severity: "critical", category: "audio", evidence_ref: "probe:audio_tracks=0", description: "The video has no audio track, but the plan includes audio.", suggested_fix: "Mix the planned music and sound into the final render." });
  } else if (exp.expect_audio) passed.push({ check: "audio_track", evidence: `probe:audio_tracks=${a.audio_tracks}` });

  const m = await analyseMedia(path, { hasVideo: true, hasAudio, duration_s: duration });
  for (const w of m.warnings) add({ scene_id: null, severity: "info", category: "technical", evidence_ref: "probe:analysis_warning", description: `A measurement could not be completed: ${w}` });

  // black frames
  const badBlack = m.black.filter((s) => !covered(s, exp.allowed_black));
  for (const s of badBlack) {
    add({ scene_id: sceneAt((s.start + s.end) / 2), severity: s.end - s.start >= 1 ? "critical" : "major", category: "technical", evidence_ref: `probe:blackdetect@${range(s)}`, description: `Black frames from ${r2(s.start)}s to ${r2(s.end)}s that the plan does not call for.`, suggested_fix: "Check the clip or graphics at this time; something failed to render or a gap was left." });
  }
  if (!badBlack.length) passed.push({ check: "black_frames", evidence: `probe:blackdetect found ${m.black.length} span(s), all intended` });

  // frozen picture
  const badFreeze = m.freeze.filter((s) => !covered(s, exp.allowed_freeze));
  for (const s of badFreeze) {
    add({ scene_id: sceneAt((s.start + s.end) / 2), severity: "major", category: "technical", evidence_ref: `probe:freezedetect@${range(s)}`, description: `The picture is frozen from ${r2(s.start)}s to ${r2(s.end)}s.`, suggested_fix: "Replace the frozen stretch with moving footage or shorten the scene." });
  }
  if (!badFreeze.length) passed.push({ check: "frozen_frames", evidence: `probe:freezedetect found ${m.freeze.length} span(s), all intended` });

  // silence and loudness
  if (exp.expect_audio && hasAudio) {
    const { integrated_lufs: lufs, true_peak_db: peak } = m.loudness ?? { integrated_lufs: null, true_peak_db: null };
    measurements["loudness_lufs"] = lufs; measurements["true_peak_db"] = peak;
    // FFmpeg reports digital silence as about -70 LUFS rather than -inf, so also look at how much of the file is silent.
    const silentTotal = m.silence.reduce((acc, s) => acc + Math.min(s.end, duration) - s.start, 0);
    const entirelySilent = lufs === null || lufs <= -69 || (duration > 0 && silentTotal >= duration * 0.95);

    const longSilence = entirelySilent ? [] : m.silence.filter((s) => s.end - s.start >= 1);
    for (const s of longSilence) {
      add({ scene_id: sceneAt((s.start + s.end) / 2), severity: s.end - s.start >= 3 ? "major" : "minor", category: "audio", evidence_ref: `probe:silencedetect@${range(s)}`, description: `Silence from ${r2(s.start)}s to ${r2(s.end)}s.`, suggested_fix: "Add music or sound here, or confirm the silence is intended." });
    }
    if (!longSilence.length) passed.push({ check: "silence", evidence: `probe:silencedetect found no silence of 1s or more` });

    if (entirelySilent) {
      add({ scene_id: null, severity: "critical", category: "audio", evidence_ref: lufs === null ? "probe:ebur128=-inf" : `probe:ebur128=${lufs}LUFS silent=${r2(silentTotal)}s/${r2(duration)}s`, description: "The audio track is completely silent.", suggested_fix: "Mix the planned audio into the render." });
    } else if (exp.loudness_target_lufs !== undefined) {
      const lt = exp.loudness_tolerance_lu ?? 2;
      if (Math.abs(lufs - exp.loudness_target_lufs) > lt) add({ scene_id: null, severity: "major", category: "audio", evidence_ref: `probe:ebur128=${lufs}LUFS`, description: `Loudness is ${lufs} LUFS; the target is ${exp.loudness_target_lufs} LUFS (plus or minus ${lt}).`, suggested_fix: "Normalise the final mix to the target loudness." });
      else passed.push({ check: "loudness", evidence: `probe:ebur128=${lufs}LUFS (target ${exp.loudness_target_lufs})` });
    }
    const ceiling = exp.max_true_peak_db ?? -1;
    if (peak !== null && peak > ceiling) add({ scene_id: null, severity: "major", category: "audio", evidence_ref: `probe:truepeak=${peak}dB`, description: `True peak ${peak} dB is above the ${ceiling} dB ceiling, so it can clip when a platform re-encodes it.`, suggested_fix: "Lower the master level or add a limiter." });
    else if (peak !== null) passed.push({ check: "true_peak", evidence: `probe:truepeak=${peak}dB (ceiling ${ceiling})` });
  }
  return { findings, passed, measurements };
}

// ---------- findings to revision tickets ----------

/** Who fixes what. Mirrors skills/video-qa/references/severity.md. */
export function ownerFor(f: QAFinding): OwnerSkill {
  switch (f.category) {
    case "audio": return "sound-design";
    case "product_fidelity": return "cinematography";
    case "brand": return "commercial-strategy";
    case "pacing": return "editing-director";
    case "visual": return "motion-graphics";
    default: return "editing-director"; // technical: timing, black or frozen stretches
  }
}

/**
 * Turns open findings into revision tickets. Findings with no scene apply to the whole film, so they name every scene.
 * Info findings are observations and never become work.
 */
export function ticketsFromFindings(findings: QAFinding[], allSceneIds: string[], attempt: 1 | 2 = 1): RevisionTicket[] {
  return findings
    .filter((f) => f.status === "open" && f.severity !== "info")
    .map((f) => RevisionTicket.parse({
      ticket_id: `T_${f.finding_id}`,
      finding_id: f.finding_id,
      scene_ids: f.scene_id ? [f.scene_id] : allSceneIds,
      owner_skill: ownerFor(f),
      instruction: f.suggested_fix ?? f.description,
      attempt,
    }));
}
