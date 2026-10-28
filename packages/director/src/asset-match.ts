import type { Asset, AssetNotes } from "@digikon/contracts";

/**
 * Which supplied pictures could fill which scene needs, decided only from what was actually found out about each picture: its measured kind
 * and, when someone has reviewed it, what they said it shows. A suggestion only. It changes no plan and no approval: using a picture in a scene
 * the approved plan left to graphics is a plan change, and it needs the Director to plan again and the user to approve again.
 */

export interface MatchScene {
  scene_id: string;
  required_assets: readonly { need: string; kind: string; availability: string; asset_id: string | null; fallback?: string | null }[];
}

export type MatchDecision = "use" | "none_suitable" | "needs_review" | "no_pictures";

export interface AssetMatch {
  scene_id: string;
  need: string;
  /** What kind of picture the need asks for: people, a product screen, a logo, or just an image. */
  wants: "people" | "product_ui" | "logo" | "image";
  decision: MatchDecision;
  candidates: { asset_id: string; basis: "reviewed" | "measured"; reason: string }[];
  rejected: { asset_id: string; reason: string }[];
  reason: string;
  /** What the approved plan already says to do when no picture fits. */
  fallback: string | null;
}

const PEOPLE = /\b(team|teams|people|person|persons|faces?|staff|colleagues?|employees?|customers?|users?\s+photo|portrait|headshots?)\b/i;
const wantsOf = (r: { need: string; kind: string }): AssetMatch["wants"] => (r.kind === "ui_screenshot" ? "product_ui" : r.kind === "logo" ? "logo" : PEOPLE.test(r.need) ? "people" : "image");

export function matchAssetsToScenes(scenes: readonly MatchScene[], notes: readonly AssetNotes[], assets: readonly Asset[]): AssetMatch[] {
  const images = assets.filter((a) => a.media_type === "image");
  const noteOf = new Map(notes.map((n) => [n.asset_id, n]));
  const out: AssetMatch[] = [];
  for (const s of scenes) {
    for (const r of s.required_assets) {
      if (r.kind === "graphics" || r.kind === "audio" || r.kind === "footage") continue;
      if (r.availability === "supplied" && r.asset_id) continue; // already assigned by the approved plan
      const wants = wantsOf(r);
      const candidates: AssetMatch["candidates"] = [], rejected: AssetMatch["rejected"] = [];
      let unreviewed = 0;
      for (const a of images) {
        const n = noteOf.get(a.asset_id);
        const rv = n?.visual_review ?? null, m = n?.image_measure ?? null;
        if (rv) {
          const fits = wants === "people" ? rv.has_people : wants === "product_ui" ? rv.shows_product_ui : wants === "logo" ? rv.subjects.some((x) => /logo|brand mark|wordmark/i.test(x)) : true;
          if (fits) candidates.push({ asset_id: a.asset_id, basis: "reviewed", reason: `reviewed (${rv.reviewed_by}): ${rv.summary}` });
          else rejected.push({ asset_id: a.asset_id, reason: `reviewed (${rv.reviewed_by}): ${rv.summary}${wants === "people" ? " It does not show people." : wants === "product_ui" ? " It does not show the product." : " It is not a logo."}` });
        } else if (wants === "product_ui" && m?.kind === "screen_capture_or_graphic") {
          candidates.push({ asset_id: a.asset_id, basis: "measured", reason: "measured as a screen capture or graphic; nobody has confirmed it shows the product" }); unreviewed++;
        } else { unreviewed++; rejected.push({ asset_id: a.asset_id, reason: m ? `only its kind was measured (${m.kind.replaceAll("_", " ")}); nobody has reviewed what it shows` : "it has not been measured or reviewed" }); }
      }
      let decision: MatchDecision, reason: string;
      if (!images.length) { decision = "no_pictures"; reason = "no pictures were supplied"; }
      else if (candidates.some((c) => c.basis === "reviewed")) { decision = "use"; reason = `${candidates.filter((c) => c.basis === "reviewed").length} reviewed picture(s) fit this need`; }
      else if (unreviewed) { decision = "needs_review"; reason = `${unreviewed} picture(s) have not been reviewed, so nothing can be said about whether they fit; review them first`; }
      else { decision = "none_suitable"; reason = "every supplied picture was reviewed and none fits this need"; }
      out.push({ scene_id: s.scene_id, need: r.need, wants, decision, candidates, rejected, reason, fallback: r.fallback ?? null });
    }
  }
  return out;
}
