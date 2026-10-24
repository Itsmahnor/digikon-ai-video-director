import { describe, expect, it } from "vitest";
import { Asset, AssetLicense, Scene, ScenePlan, Treatment, evidenceHash } from "./index.js";

describe("asset declarations the Editor relies on", () => {
  const base = { asset_id: "a1", uri: "a.png", media_type: "image", duration: null, width: 800, height: 600 };

  it("are never inferred: an asset without them has none recorded", () => {
    const a = Asset.parse(base);
    expect(a.license).toBeNull();
    expect(a.genuine_product_ui).toBeNull();
  });

  it("accept a user's licence declaration and reject an invented status", () => {
    expect(Asset.parse({ ...base, license: { status: "licensed", note: "stock licence 123" } }).license).toEqual({ status: "licensed", note: "stock licence 123" });
    expect(AssetLicense.parse({ status: "unknown" }).note).toBeNull();
    expect(Asset.safeParse({ ...base, license: { status: "probably fine" } }).success).toBe(false);
  });

  it("are covered by the evidence hash, so editing a declaration after approval invalidates the approval", () => {
    const scene = Scene.parse({
      scene_id: "S01", purpose: "p", start_time: 0, duration_seconds: 5, asset_ids: ["a1"],
      shot: { shot_size: "wide", camera_motion: "static", visual_action: "x" }, transition_out: "cut",
    });
    const treatment = Treatment.parse({ logline: "l", hook: "h", tone: "t", beats: [{ beat: "b", purpose: "p", approx_seconds: 5 }], cta: "c" });
    const plan = ScenePlan.parse({ project_id: "p", version: 1, scenes: [scene] });
    const hash = (a: Asset) => evidenceHash({ treatment, scenePlan: plan, assets: [a], facts: [], notes: [] });
    const plain = Asset.parse(base);
    expect(hash(Asset.parse({ ...base, genuine_product_ui: true }))).not.toBe(hash(plain));
    expect(hash(Asset.parse({ ...base, license: { status: "user_owned" } }))).not.toBe(hash(plain));
    expect(hash(Asset.parse(base))).toBe(hash(plain));
  });
});
