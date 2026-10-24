import { z } from "zod";
import { BrandFact, type Claim } from "./director.js";
import { AssetAvailability, AssetKind, type Asset, type ProductionMethod, type Scene, type ScenePlan } from "./schemas.js";

// ---------- claims ----------

export const ClaimStatus = z.enum(["supported", "illustrative", "unsupported"]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

/**
 * Wording that reads as a verifiable fact: figures, prices, rankings, guarantees, awards. A claim like this cannot be
 * passed off as an "illustrative concept", whatever the model says; it needs an approved fact.
 */
const FACT_LIKE = /\d|%|[$€£]|\b(best|#1|number one|no\.? ?1|fastest|cheapest|guarantee[sd]?|proven|certified|awards?|award-winning|leading|most|only)\b/i;

export const ClaimAuditEntry = z.object({
  claim_id: z.string(),
  text: z.string(),
  status: ClaimStatus,
  /** The approved fact behind a supported claim. */
  fact: BrandFact.nullable(),
  /** Scenes that show or imply the claim. */
  scene_ids: z.array(z.string()),
  /** Whether the claim may be shown in a scene at all. Unsupported factual claims may not. */
  usable_in_scenes: z.boolean(),
  explanation: z.string(),
  safe_alternative: z.string().nullable(),
});
export type ClaimAuditEntry = z.infer<typeof ClaimAuditEntry>;

const GENERIC_ALTERNATIVE = "Show the idea visually without stating it as fact, or supply an approved fact (from the product team or a document) that supports the wording.";

/** What one claim is. Code decides; the model only proposes `kind` and a fact link. */
export function classifyClaim(claim: Claim, facts: readonly BrandFact[]): { status: ClaimStatus; fact: BrandFact | null; explanation: string } {
  const fact = claim.brand_fact_id ? facts.find((f) => f.fact_id === claim.brand_fact_id) ?? null : null;
  if (fact) return { status: "supported", fact, explanation: `Supported by approved fact ${fact.fact_id} (source: ${fact.source}).` };
  if (claim.kind === "illustrative") {
    if (FACT_LIKE.test(claim.text)) {
      return { status: "unsupported", fact: null, explanation: "Marked as an illustrative concept, but the wording reads as a verifiable fact (a figure, price, ranking or guarantee) and no approved fact supports it." };
    }
    return { status: "illustrative", fact: null, explanation: "A proposed feature or illustrative concept. No supplied evidence supports it, so show it as a concept and never as a verified product fact." };
  }
  const why = claim.brand_fact_id ? `Fact ${claim.brand_fact_id} was not supplied.` : "No approved fact supports this wording.";
  return { status: "unsupported", fact: null, explanation: `${why} It must not be presented as a verified product fact.` };
}

/** Every claim in the treatment, classified, with the scenes that use it. Nothing is dropped: unsupported claims stay visible. */
export function auditClaims(claims: readonly Claim[], scenes: readonly Scene[], facts: readonly BrandFact[]): ClaimAuditEntry[] {
  return claims.map((claim) => {
    const c = classifyClaim(claim, facts);
    return {
      claim_id: claim.claim_id,
      text: claim.text,
      status: c.status,
      fact: c.fact,
      scene_ids: scenes.filter((s) => s.claim_ids.includes(claim.claim_id)).map((s) => s.scene_id),
      usable_in_scenes: c.status !== "unsupported",
      explanation: c.explanation,
      safe_alternative: c.status === "supported" ? null : claim.safe_alternative ?? GENERIC_ALTERNATIVE,
    };
  });
}

// ---------- production method and asset feasibility ----------

/**
 * How the scene is meant to be made. Supplied or still-needed real material (footage, a logo file, a screenshot) counts as
 * "supplied footage"; overlay text and generated graphics count as graphics. Both together is "mixed".
 */
export function deriveProductionMethod(s: Pick<Scene, "asset_ids" | "overlay" | "required_assets">): ProductionMethod {
  const material = s.asset_ids.length > 0 || s.required_assets.some((r) => r.availability !== "generate_graphics");
  const graphics = s.overlay !== null || s.required_assets.some((r) => r.availability === "generate_graphics") || !material;
  return material && graphics ? "mixed" : material ? "supplied_footage" : "graphics";
}

export const FeasibilityItem = z.object({
  scene_id: z.string(),
  need: z.string(),
  kind: AssetKind,
  availability: AssetAvailability,
  asset_id: z.string().nullable(),
  placeholder: z.boolean(),
  fallback: z.string().nullable(),
  severity: z.enum(["ok", "warning", "blocker"]),
  message: z.string(),
});
export type FeasibilityItem = z.infer<typeof FeasibilityItem>;

export const AssetFeasibility = z.object({
  items: z.array(FeasibilityItem),
  counts: z.object({ supplied: z.number(), generate_graphics: z.number(), needs_external: z.number(), missing_blocking: z.number() }),
  /** Things that stop production until they are resolved. */
  blockers: z.array(z.string()),
  /** Things the user should see and approve: placeholders and open decisions. */
  warnings: z.array(z.string()),
});
export type AssetFeasibility = z.infer<typeof AssetFeasibility>;

/**
 * Sorts what the storyboard needs into: supplied, buildable with the graphics workflow, needing external material, or
 * genuinely missing. A graphics-led scene with no supplied footage is not a problem; real material that is not supplied is.
 */
export function assetFeasibility(plan: ScenePlan, assets: readonly Asset[]): AssetFeasibility {
  const items: FeasibilityItem[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const counts = { supplied: 0, generate_graphics: 0, needs_external: 0, missing_blocking: 0 };
  const have = new Set(assets.map((a) => a.asset_id));

  for (const s of plan.scenes) {
    for (const r of s.required_assets) {
      counts[r.availability]++;
      let severity: FeasibilityItem["severity"] = "ok";
      let message = "";
      switch (r.availability) {
        case "supplied":
          if (r.asset_id && have.has(r.asset_id)) message = `${s.scene_id}: "${r.need}" is supplied (${r.asset_id}).`;
          else { severity = "blocker"; message = `${s.scene_id}: "${r.need}" is listed as supplied, but ${r.asset_id ?? "no file"} is not in the project.`; }
          break;
        case "generate_graphics":
          if (r.placeholder) { severity = "warning"; message = `${s.scene_id}: "${r.need}" is a graphics-only placeholder, not the real thing. It needs your approval and should be replaced by the real asset.`; }
          else message = `${s.scene_id}: "${r.need}" can be built with the graphics workflow.`;
          break;
        case "needs_external":
          severity = "blocker";
          message = `${s.scene_id} needs ${r.kind} "${r.need}" that is not supplied${r.fallback ? ` (alternative: ${r.fallback})` : ""}.`;
          break;
        case "missing_blocking":
          severity = "blocker";
          message = `${s.scene_id} needs ${r.kind} "${r.need}", which is missing and cannot be replaced${r.fallback ? ` (alternative: ${r.fallback})` : ""}.`;
          break;
      }
      items.push({ scene_id: s.scene_id, need: r.need, kind: r.kind, availability: r.availability, asset_id: r.asset_id, placeholder: r.placeholder, fallback: r.fallback, severity, message });
      if (severity === "blocker") blockers.push(message);
      else if (severity === "warning") warnings.push(message);
    }
    for (const u of s.unresolved) warnings.push(`${s.scene_id}: ${u.kind.replace("_", " ")}: ${u.note}`);
  }
  return { items, counts, blockers, warnings };
}
