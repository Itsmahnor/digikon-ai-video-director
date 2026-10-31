import { describe, expect, it } from "vitest";
import { AssetNotes, type AssetManifestEntry } from "@digikon/contracts";
import { DemoClient, ScriptedClient, buildDirectorGraph, type GenerateRequest } from "./index.js";
import { deps, input, shot, throughGate1, treatment } from "./fixtures.js";

const entry = (over: Partial<AssetManifestEntry> & { asset_id: string }): AssetManifestEntry => ({ original_filename: "file.png", width: 1200, height: 600, analysis_status: "analyzed", categories: [{ category: "product_photo", confidence: 0.8, source: "vision" }], description: "A product.", purpose: "Shows a product.", visible_text: "", subjects: [], dominant_colours: [], transparent: false, background: "busy", suitable_roles: ["hero"], usage: "auto", user_description: null, caveats: [], ...over });
const picture = (e: AssetManifestEntry) => ({ asset: { asset_id: e.asset_id, uri: `/x/${e.asset_id}.png`, media_type: "image" as const, duration: null, width: 1200, height: 600, license: null, genuine_product_ui: null, audio_tracks: 0, transcript_ref: null, keyframe_refs: [], metadata: {} }, notes: AssetNotes.parse({ asset_id: e.asset_id, usable_segments: [], content_summary: e.description ?? "", image_manifest: e }) });
const withPictures = (...es: AssetManifestEntry[]) => ({ ...input, assets: [...input.assets, ...es.map((e) => picture(e).asset)], notes: es.map((e) => picture(e).notes) });

const logo = entry({ asset_id: "asset_logo0001", original_filename: "brand.png", categories: [{ category: "company_logo", confidence: 0.7, source: "vision" }], description: "The company logo.", usage: "must_use" });
const screen = entry({ asset_id: "asset_dash0001", categories: [{ category: "dashboard_ui", confidence: 0.9, source: "vision" }], description: "A dashboard." });
const reference = entry({ asset_id: "asset_refr0001", usage: "reference_only", user_description: "This is a reference design. Do not use it directly." });
const gfx = { need: "Graphics", kind: "graphics", availability: "generate_graphics" };
const placed = (id: string, scene_id: string, kind: string, role: string, extra: Record<string, unknown> = {}) => ({
  scene_id, purpose: "p", duration_seconds: 6, asset_ids: [id], required_assets: [{ need: "The picture", kind, availability: "supplied", asset_id: id }], shot,
  asset_refs: [{ asset_id: id, role, placement: "center", scale: 0.8, fit: "contain", crop: null, layer: 1, animation: "fade_in", frame: "none", mandatory: true, reason: "the brief asks for it" }], transition_out: "cut", ...extra,
});

/** What the Director was told, seen by the model at each step. */
class Watching extends DemoClient {
  seen: Record<string, string> = {};
  override async generate<T>(req: GenerateRequest<T>): Promise<T> { this.seen[req.name] = req.user; return super.generate(req); }
}

describe("the Director and uploaded pictures", () => {
  it("gets the whole analysed manifest at intake, treatment and storyboard, with no file paths", async () => {
    const llm = new Watching({ creative: true });
    await throughGate1(buildDirectorGraph(deps(llm as never)), withPictures(logo, screen, reference), "t-manifest");
    for (const step of ["intake_result", "treatment", "storyboard"]) expect(llm.seen[step], step).toContain("asset_logo0001");
    const block = /## Asset manifest[^\n]*\n([\s\S]*?)\n\n## /.exec(llm.seen["storyboard"]!)![1]!;
    const manifest = JSON.parse(block) as AssetManifestEntry[];
    expect(manifest.map((m) => [m.asset_id, m.usage, m.categories[0]!.category])).toEqual([["asset_logo0001", "must_use", "company_logo"], ["asset_dash0001", "auto", "dashboard_ui"], ["asset_refr0001", "reference_only", "product_photo"]]);
    expect(block).not.toContain("/x/");
    expect(llm.seen["storyboard"]).toContain("must_use means it has to appear");
  });

  it("puts real pictures in scenes with explicit references, and keeps the reference picture off screen", async () => {
    const out = await throughGate1(buildDirectorGraph(deps(new DemoClient({ creative: true }) as never)), withPictures(logo, screen, reference), "t-place");
    const scenes = out.scenePlan!.scenes;
    const refs = scenes.flatMap((s) => (s.asset_refs ?? []).map((r) => ({ scene: s.scene_id, ...r })));
    expect(refs.map((r) => r.asset_id)).toEqual(["asset_logo0001", "asset_dash0001"]);
    expect(refs[0]).toMatchObject({ scene: "S01", role: "logo", fit: "contain", mandatory: true });
    expect(refs[1]).toMatchObject({ role: "screen", frame: "browser" });
    expect(scenes.flatMap((s) => s.asset_ids)).not.toContain("asset_refr0001");
    for (const s of scenes.filter((x) => x.asset_refs?.length)) { expect(s.visual?.block).toBe("asset_stage"); expect(s.required_assets[0]).toMatchObject({ availability: "supplied", asset_id: s.asset_ids[0] }); }
  });

  it("will not accept a plan that invents a picture, shows a reference, or drops a mandatory one: it escalates after asking for a repair", async () => {
    const scenes = (ids: string[]) => ({ scenes: [placed(ids[0]!, "S01", "image", "hero"), { ...placed(ids[1]!, "S02", "image", "hero"), }] });
    const noPlan = { scenes: [1, 2].map((n) => ({ scene_id: `S0${n}`, purpose: "p", duration_seconds: 6, asset_ids: [], required_assets: [gfx], shot, transition_out: "cut" })) };
    for (const [bad, code] of [[scenes(["asset_invented", "asset_dash0001"]), "unknown_asset_ref"], [scenes(["asset_refr0001", "asset_logo0001"]), "asset_reference_only"], [noPlan, "mandatory_asset_unplaced"]] as const) {
      const llm = new ScriptedClient([{ status: "ready", questions: [] }, treatment, bad, bad, bad, bad]);
      const out = await throughGate1(buildDirectorGraph(deps(llm)), withPictures(logo, screen, reference), `t-${code}`);
      expect(out.status, code).toBe("escalated");
      expect(JSON.stringify(out.escalation), code).toContain(code);
    }
  });
});
