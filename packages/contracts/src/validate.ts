import type { AssetNotes, BrandFact, Claim } from "./director.js";
import { classifyClaim, deriveProductionMethod } from "./audit.js";
import type { Asset, Project, RequiredAsset, ScenePlan } from "./schemas.js";

export interface PlanIssue {
  code:
    | "unknown_asset" | "duplicate_scene" | "overlap" | "gap" | "asset_bounds" | "over_duration"
    | "unknown_claim" | "unsupported_claim" | "unusable_segment" | "under_duration"
    | "out_of_order" | "timestamp_inconsistent"
    | "required_asset_invalid" | "footage_cannot_be_generated" | "placeholder_not_labelled" | "production_method_mismatch";
  scene_id: string;
  message: string;
}

/** Optional context that enables the asset-use and claims checks. */
export interface PlanContext {
  notes?: AssetNotes[];
  claims?: Claim[];
  facts?: BrandFact[];
}

const EPS = 1e-6;

/**
 * The timing contract: scenes are listed in start order, run back to back from 0 with no gap or overlap, each has a positive
 * duration, and together they last exactly the requested runtime (to within a twentieth of a second of rounding).
 */
export const RUNTIME_TOLERANCE_S = 0.05;

/** The media each kind of requirement can be satisfied by when it is a supplied file. */
const KIND_MEDIA: Record<RequiredAsset["kind"], readonly Asset["media_type"][]> = {
  footage: ["video"], image: ["image"], logo: ["image"], ui_screenshot: ["image", "video"], audio: ["audio"], graphics: [],
};

/** Cross-field checks that Zod alone cannot express. Returns [] when the plan is valid. */
export function validatePlan(plan: ScenePlan, assets: Asset[], project: Project, ctx: PlanContext = {}): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const byId = new Map(assets.map((a) => [a.asset_id, a]));
  const notesById = new Map((ctx.notes ?? []).map((n) => [n.asset_id, n]));
  const claimsById = new Map((ctx.claims ?? []).map((c) => [c.claim_id, c]));
  const facts = ctx.facts ?? [];
  const seen = new Set<string>();
  const ordered = [...plan.scenes].sort((a, b) => a.start_time - b.start_time);
  if (ordered.some((s, i) => s !== plan.scenes[i])) {
    issues.push({ code: "out_of_order", scene_id: plan.scenes[0]!.scene_id, message: "scenes are not listed in the order they play" });
  }

  let cursor = 0;
  for (const s of ordered) {
    if (seen.has(s.scene_id)) {
      issues.push({ code: "duplicate_scene", scene_id: s.scene_id, message: "duplicate scene_id" });
    }
    seen.add(s.scene_id);

    if (s.end_time !== null && Math.abs(s.end_time - (s.start_time + s.duration_seconds)) > 1e-3) {
      issues.push({ code: "timestamp_inconsistent", scene_id: s.scene_id, message: `end_time ${s.end_time}s is not start ${s.start_time}s plus duration ${s.duration_seconds}s` });
    }

    for (const id of s.asset_ids) {
      const a = byId.get(id);
      if (!a) {
        issues.push({ code: "unknown_asset", scene_id: s.scene_id, message: `unknown asset ${id}` });
        continue;
      }
      if (a.media_type !== "video") continue;
      if (a.duration !== null && s.source_in_seconds + s.duration_seconds > a.duration + EPS) {
        issues.push({
          code: "asset_bounds",
          scene_id: s.scene_id,
          message: `scene uses ${s.source_in_seconds}s-${s.source_in_seconds + s.duration_seconds}s of asset ${id}, which lasts ${a.duration}s`,
        });
      }
      const notes = notesById.get(id);
      if (notes) {
        const from = s.source_in_seconds;
        const to = from + s.duration_seconds;
        const inside = notes.usable_segments.some((seg) => from >= seg.start - EPS && to <= seg.end + EPS);
        if (!inside) {
          issues.push({
            code: "unusable_segment",
            scene_id: s.scene_id,
            message: `${from}s-${to}s of asset ${id} is not inside any usable segment`,
          });
        }
      }
    }

    for (const cid of s.claim_ids) {
      const claim = claimsById.get(cid);
      if (!claim) {
        issues.push({ code: "unknown_claim", scene_id: s.scene_id, message: `claim ${cid} is not in the claims register` });
      } else if (classifyClaim(claim, facts).status === "unsupported") {
        issues.push({
          code: "unsupported_claim",
          scene_id: s.scene_id,
          message: `claim ${cid} is an unsupported factual claim (no approved brand fact${claim.kind === "illustrative" ? ", and its wording reads as fact" : ""}); do not show it, or show the safe alternative`,
        });
      }
    }

    for (const r of s.required_assets) {
      const bad = (message: string, code: PlanIssue["code"] = "required_asset_invalid") => issues.push({ code, scene_id: s.scene_id, message });
      if (r.availability === "supplied") {
        const a = r.asset_id ? byId.get(r.asset_id) : undefined;
        if (!r.asset_id || !a) bad(`"${r.need}" is marked supplied but ${r.asset_id ?? "no asset_id"} is not a project asset`);
        else {
          if (!s.asset_ids.includes(r.asset_id)) bad(`"${r.need}" names ${r.asset_id}, which the scene does not list in asset_ids`);
          if (!KIND_MEDIA[r.kind].includes(a.media_type)) bad(`"${r.need}" is a ${r.kind}, but ${r.asset_id} is ${a.media_type}`);
        }
      }
      if (r.availability === "generate_graphics") {
        if (r.kind === "footage" || r.kind === "audio") bad(`"${r.need}" is ${r.kind}; the graphics workflow cannot create it. Mark it needs_external, or describe a graphics treatment instead`, "footage_cannot_be_generated");
        else if ((r.kind === "logo" || r.kind === "ui_screenshot" || r.kind === "image") && !r.placeholder) {
          bad(`"${r.need}" stands in for a ${r.kind.replace("_", " ")} that was not supplied; set placeholder to true and list it under unresolved so the user can approve it`, "placeholder_not_labelled");
        }
      }
    }
    if (s.production_method !== null && s.production_method !== deriveProductionMethod(s)) {
      issues.push({ code: "production_method_mismatch", scene_id: s.scene_id, message: `production_method ${s.production_method} does not match the scene's assets and graphics (${deriveProductionMethod(s)})` });
    }

    if (s.start_time < cursor - EPS) {
      issues.push({ code: "overlap", scene_id: s.scene_id, message: "scene overlaps previous scene" });
    } else if (s.start_time > cursor + EPS) {
      issues.push({ code: "gap", scene_id: s.scene_id, message: "gap before scene" });
    }
    cursor = Math.max(cursor, s.start_time + s.duration_seconds);
  }

  if (cursor > project.target_duration + RUNTIME_TOLERANCE_S) {
    issues.push({
      code: "over_duration",
      scene_id: ordered[ordered.length - 1]!.scene_id,
      message: `timeline ${cursor}s exceeds the requested ${project.target_duration}s`,
    });
  }
  if (cursor < project.target_duration - RUNTIME_TOLERANCE_S) {
    issues.push({
      code: "under_duration",
      scene_id: ordered[ordered.length - 1]!.scene_id,
      message: `timeline ${cursor}s is shorter than the requested ${project.target_duration}s`,
    });
  }
  return issues;
}
