import { describe, expect, it } from "vitest";
import type { Asset, AssetNotes } from "@digikon/contracts";
import { matchAssetsToScenes } from "./asset-match.js";

const asset = (id: string): Asset => ({ asset_id: id, media_type: "image", uri: `${id}.png`, duration: null, width: 1680, height: 916, audio_tracks: 0, metadata: {}, transcript_ref: null } as never);
const notes = (id: string, over: Partial<AssetNotes> = {}): AssetNotes => ({ asset_id: id, usable_segments: [], quality_flags: [], content_summary: "", uncertain: [], transcript_ref: null, shots: [], loudness_lufs: null, speech: null, keyframe_refs: [], image_measure: { kind: "screen_capture_or_graphic", flat_colour_share: 0.77, distinct_colours: 25, skin_tone_share: 0.01, width: 1680, height: 916 }, visual_review: null, ...over });
const review = (people: boolean, ui: boolean, summary: string) => ({ reviewed_by: "assistant" as const, reviewed_at: "2026-10-28T12:00:00.000Z", method: "looked at the file", summary, subjects: [], has_people: people, shows_product_ui: ui });
const S02 = { scene_id: "S02", required_assets: [{ need: "A product screen", kind: "ui_screenshot", availability: "generate_graphics", asset_id: null }] };
const S04 = { scene_id: "S04", required_assets: [{ need: "Supplied team or people image, if one matches.", kind: "image", availability: "needs_external", asset_id: null, fallback: "Use generic avatar circles drawn as graphics." }] };
const A = ["asset_aaaaaaa1", "asset_aaaaaaa2", "asset_aaaaaaa3"];

describe("matching supplied pictures to scene needs", () => {
  it("with nothing reviewed it does not guess: a people need is 'needs_review', never a match", () => {
    const m = matchAssetsToScenes([S04], A.map((a) => notes(a)), A.map(asset));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ scene_id: "S04", wants: "people", decision: "needs_review", candidates: [] });
    expect(m[0]!.rejected).toHaveLength(3);
    expect(m[0]!.fallback).toContain("generic avatar");
  });

  it("when every picture was reviewed and none shows people, the need has no suitable picture and the approved fallback stays", () => {
    const m = matchAssetsToScenes([S04], A.map((a) => notes(a, { visual_review: review(false, true, "A dashboard screen") })), A.map(asset));
    expect(m[0]).toMatchObject({ decision: "none_suitable", candidates: [] });
    expect(m[0]!.rejected.map((r) => r.reason).join(" ")).toContain("does not show people");
  });

  it("a reviewed picture that shows people is matched to the people need, and only that one", () => {
    const n = [notes(A[0]!, { visual_review: review(true, false, "Four colleagues at a table") }), notes(A[1]!, { visual_review: review(false, true, "A dashboard") }), notes(A[2]!)];
    const m = matchAssetsToScenes([S04], n, A.map(asset));
    expect(m[0]).toMatchObject({ decision: "use" });
    expect(m[0]!.candidates.map((c) => [c.asset_id, c.basis])).toEqual([[A[0], "reviewed"]]);
  });

  it("a product-screen need is matched to reviewed product screens; unreviewed screen captures are only candidates that need a review", () => {
    const unrev = matchAssetsToScenes([S02], A.map((a) => notes(a)), A.map(asset));
    expect(unrev[0]).toMatchObject({ wants: "product_ui", decision: "needs_review" });
    expect(unrev[0]!.candidates.every((c) => c.basis === "measured")).toBe(true);
    const rev = matchAssetsToScenes([S02], [notes(A[0]!, { visual_review: review(false, true, "The dashboard") }), notes(A[1]!), notes(A[2]!)], A.map(asset));
    expect(rev[0]).toMatchObject({ decision: "use" });
    expect(rev[0]!.candidates.find((c) => c.basis === "reviewed")!.asset_id).toBe(A[0]);
  });

  it("graphics needs and needs the plan already filled are not matched, and no pictures means 'no_pictures'", () => {
    const m = matchAssetsToScenes([{ scene_id: "S01", required_assets: [{ need: "Graphics", kind: "graphics", availability: "generate_graphics", asset_id: null }, { need: "Picture", kind: "image", availability: "supplied", asset_id: A[0]! }] }, S04], [], []);
    expect(m.map((x) => [x.scene_id, x.decision])).toEqual([["S04", "no_pictures"]]);
  });
});
