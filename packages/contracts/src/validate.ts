import type { AssetNotes, BrandFact, Claim } from "./director.js";
import type { Asset, Project, ScenePlan } from "./schemas.js";

export interface PlanIssue {
  code:
    | "unknown_asset" | "duplicate_scene" | "overlap" | "gap" | "asset_bounds" | "over_duration"
    | "unknown_claim" | "unsupported_claim" | "unusable_segment" | "under_duration";
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

/** Cross-field checks that Zod alone cannot express. Returns [] when the plan is valid. */
export function validatePlan(plan: ScenePlan, assets: Asset[], project: Project, ctx: PlanContext = {}): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const byId = new Map(assets.map((a) => [a.asset_id, a]));
  const notesById = new Map((ctx.notes ?? []).map((n) => [n.asset_id, n]));
  const claimsById = new Map((ctx.claims ?? []).map((c) => [c.claim_id, c]));
  const factIds = new Set((ctx.facts ?? []).map((f) => f.fact_id));
  const seen = new Set<string>();
  const ordered = [...plan.scenes].sort((a, b) => a.start_time - b.start_time);

  let cursor = 0;
  for (const s of ordered) {
    if (seen.has(s.scene_id)) {
      issues.push({ code: "duplicate_scene", scene_id: s.scene_id, message: "duplicate scene_id" });
    }
    seen.add(s.scene_id);

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
      } else if (claim.brand_fact_id === null || !factIds.has(claim.brand_fact_id)) {
        issues.push({
          code: "unsupported_claim",
          scene_id: s.scene_id,
          message: `claim ${cid} has no approved brand fact`,
        });
      }
    }

    if (s.start_time < cursor - EPS) {
      issues.push({ code: "overlap", scene_id: s.scene_id, message: "scene overlaps previous scene" });
    } else if (s.start_time > cursor + EPS) {
      issues.push({ code: "gap", scene_id: s.scene_id, message: "gap before scene" });
    }
    cursor = Math.max(cursor, s.start_time + s.duration_seconds);
  }

  if (cursor > project.target_duration + 0.5) {
    issues.push({
      code: "over_duration",
      scene_id: ordered[ordered.length - 1]!.scene_id,
      message: `timeline ${cursor}s exceeds target ${project.target_duration}s`,
    });
  }
  if (cursor < project.target_duration - 1) {
    issues.push({
      code: "under_duration",
      scene_id: ordered[ordered.length - 1]!.scene_id,
      message: `timeline ${cursor}s is more than 1s shorter than target ${project.target_duration}s`,
    });
  }
  return issues;
}
