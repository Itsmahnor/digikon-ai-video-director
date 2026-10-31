import { describe, expect, it } from "vitest";
import { AssetNotes } from "./director.js";
import { Scene } from "./schemas.js";
import { hashCanonical } from "./approval.js";
import { SceneVisual, creativeIssues } from "./visual.js";
import { assetRefIssues, effectiveCategories, type ImageAnalysis, type SceneAssetRef } from "./assets.js";

const ref = (over: Partial<SceneAssetRef> = {}): SceneAssetRef => ({ asset_id: "asset_00000001", role: "hero", placement: "center", scale: 0.8, fit: "contain", crop: null, layer: 1, animation: "none", frame: "none", mandatory: false, reason: "fits this beat", ...over });
const entry = (over: { asset_id?: string; usage?: "auto" | "must_use" | "optional" | "reference_only" | "do_not_use"; category?: "company_logo" } = {}) => ({ asset_id: over.asset_id ?? "asset_00000001", usage: over.usage ?? "auto", original_filename: "a.png", categories: [{ category: over.category ?? ("product_photo" as const), confidence: 0.8, source: "vision" as const }] });
const scene = (refs: SceneAssetRef[], extra: Record<string, unknown> = {}) => ({ scene_id: "S01", asset_ids: refs.map((r) => r.asset_id), asset_refs: refs, unresolved: [], ...extra });
const codes = (s: Parameters<typeof assetRefIssues>[0], m: Parameters<typeof assetRefIssues>[1]) => assetRefIssues(s, m).map((i) => i.code);

describe("what a plan may do with the project's pictures", () => {
  it("accepts a placed picture from the manifest", () => expect(codes([scene([ref()])], [entry()])).toEqual([]));
  it("refuses an asset id that is not in the manifest", () => expect(codes([scene([ref({ asset_id: "asset_invented" })])], [entry()])).toEqual(["unknown_asset_ref"]));
  it("refuses showing a reference picture or one the user ruled out", () => {
    expect(codes([scene([ref()])], [entry({ usage: "reference_only" })])).toEqual(["asset_reference_only"]);
    expect(codes([scene([ref()])], [entry({ usage: "do_not_use" })])).toEqual(["asset_do_not_use"]);
  });
  it("requires a mandatory picture to be placed, or named as unresolved", () => {
    const m = [entry({ usage: "must_use" })];
    expect(codes([{ scene_id: "S01", asset_ids: [], unresolved: [] }], m)).toEqual(["mandatory_asset_unplaced"]);
    expect(codes([{ scene_id: "S01", asset_ids: [], unresolved: [{ note: "asset_00000001 is too small for this format" }] }], m)).toEqual([]);
    expect(codes([scene([ref()])], m)).toEqual([]);
  });
  it("refuses a picture on top of a kinetic type scene's words", () => expect(codes([scene([ref({ placement: "top_right", scale: 0.3 })], { visual: { block: "kinetic_type" } })], [entry()])).toContain("picture_over_kinetic_type"));
  it("does not make every upload mandatory", () => expect(codes([{ scene_id: "S01", asset_ids: [], unresolved: [] }], [entry({ usage: "auto" }), entry({ asset_id: "asset_00000002", usage: "optional" })])).toEqual([]));
  it("never crops a logo", () => {
    expect(codes([scene([ref({ role: "logo", fit: "cover" })])], [entry()])).toContain("logo_altered");
    expect(codes([scene([ref({ role: "logo", fit: "crop", crop: { x: 0, y: 0, w: 0.5, h: 0.5 } })])], [entry()])).toContain("logo_altered");
  });
  it("requires the id in asset_ids, a crop region inside the picture, and one picture per layer", () => {
    expect(codes([{ ...scene([ref()]), asset_ids: [] }], [entry()])).toContain("asset_ref_not_listed");
    expect(codes([scene([ref({ fit: "crop" })])], [entry()])).toContain("asset_crop_missing");
    expect(codes([scene([ref({ fit: "crop", crop: { x: 0.8, y: 0, w: 0.5, h: 1 } })])], [entry()])).toContain("asset_crop_outside");
    expect(codes([scene([ref(), ref({ asset_id: "asset_00000002" })])], [entry(), entry({ asset_id: "asset_00000002" })])).toContain("asset_layer_clash");
  });
});

describe("a user's correction", () => {
  const analysis = { status: "analyzed", analysed_at: null, model: { classifier: "m", describer: null, ocr: null, pipeline_version: "1" }, categories: [{ category: "illustration", confidence: 0.9 }], visual: null, evidence: [], error: null, retryable: false } satisfies ImageAnalysis;
  it("replaces the model's labels", () => {
    expect(effectiveCategories(analysis, { description: null, category: "company_logo", usage: "auto", updated_at: null })).toEqual([{ category: "company_logo", confidence: 1, source: "user" }]);
    expect(effectiveCategories(analysis, { description: null, category: null, usage: "auto", updated_at: null })[0]).toMatchObject({ category: "illustration", source: "vision" });
  });
});

describe("plans made before pictures could be placed", () => {
  const raw = { scene_id: "S01", purpose: "p", start_time: 0, duration_seconds: 4, shot: { shot_size: "wide", camera_motion: "static", visual_action: "x" }, transition_out: "cut" };
  it("hash the same as they always did, so existing approvals stay valid", () => {
    const parsed = Scene.parse(raw);
    expect("asset_refs" in parsed).toBe(false);
    const notes = AssetNotes.parse({ asset_id: "a", usable_segments: [], content_summary: "" });
    expect("image_manifest" in notes).toBe(false);
    expect(hashCanonical(parsed)).toBe(hashCanonical(Scene.parse(JSON.parse(JSON.stringify(parsed)))));
  });
});

describe("a scene built from pictures", () => {
  const art = { palette: {} } as never;
  const s = (id: string, over: Record<string, unknown>) => ({ scene_id: id, visual_purpose: `purpose ${id}`, overlay: null, claim_ids: [], asset_ids: [] as string[], ...over }) as never;
  const stage = SceneVisual.parse({ block: "asset_stage" });
  it("may repeat, because each shows a different picture", () => {
    const scenes = [1, 2, 3, 4].map((n) => s(`S0${n}`, { visual: stage, asset_ids: [`a${n}`], asset_refs: [{ asset_id: `a${n}` }] }));
    expect(creativeIssues(scenes, art).map((i) => i.code)).toEqual([]);
  });
  it("must carry a picture, and a drawn scene must place the assets it lists", () => {
    expect(creativeIssues([s("S01", { visual: stage })], art).map((i) => i.code)).toContain("asset_stage_empty");
    expect(creativeIssues([s("S01", { visual: { block: "end_card", wordmark: null, button: "Go", subline: null, camera: "static", reveal: "none", backdrop: "flat" }, asset_ids: ["a"] })], art).map((i) => i.code)).toContain("visual_with_assets");
  });
  it("has no whole-frame camera, so a frame can be compared with the file", () => expect(SceneVisual.safeParse({ block: "asset_stage", camera: "push_in" }).success).toBe(false));
});
