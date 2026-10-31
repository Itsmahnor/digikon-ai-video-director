import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Asset } from "@digikon/contracts";
import { AssetRegistry, sha256OfFile } from "./asset-registry.js";
import { deriveFiles, inspectImage, measureRgba, sniffImageFormat } from "./inspect.js";
import { availableOcr, readText } from "./ocr.js";
import { manifestEntry, notesWithAnalysis, understandAsset, analyseContent } from "./understand.js";
import { ALL_PROMPTS, LocalVision, decideCategories, type VisionModel } from "./vision.js";
import { buildAssetNotes } from "./analysis.js";

vi.setConfig({ testTimeout: 120_000 });
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "asset-understanding-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in vision model that says the first prompt in `favour` fits best, and counts its calls. */
const fakeVision = (favour: string, opts: { describe?: string | null; failClassify?: boolean; failDescribe?: boolean } = {}) => {
  const calls = { classify: 0, describe: 0 };
  const model: VisionModel = {
    classifier: "fake-classifier", describer: "fake-describer",
    async classify() { calls.classify++; if (opts.failClassify) throw new Error("model weights are missing"); return ALL_PROMPTS.map((label) => ({ label, score: label.includes(favour) ? 0.5 : 0.5 / ALL_PROMPTS.length })); },
    async describe() { calls.describe++; if (opts.failDescribe) throw new Error("out of memory"); return opts.describe === null ? null : { text: opts.describe ?? "A described picture.", objects: [] }; },
  };
  return { model, calls };
};
const png = async (name: string, colour = "#3366cc", size = 240) => { const p = join(dir, name); await sharp({ create: { width: size, height: Math.round(size * 0.6), channels: 4, background: colour } }).png().toFile(p); return p; };
const assetOf = async (path: string, asset_id: string, name: string) => Asset.parse({ asset_id, uri: path, media_type: "image", duration: null, width: 240, height: 144, metadata: { original_name: name, sha256: await sha256OfFile(path) } });
const ids = (s: string) => ({ session_id: s, project_id: `proj_${s}` });

describe("what the file itself proves", () => {
  it("reads a transparent logo as transparent, with the box its mark sits in", async () => {
    const p = join(dir, "logo.png");
    await sharp({ create: { width: 800, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: await sharp({ create: { width: 200, height: 100, channels: 4, background: "#81d870" } }).png().toBuffer(), left: 300, top: 350 }]).png().toFile(p);
    const r = await inspectImage(p);
    if (!r.ok) throw new Error(r.message);
    expect(r.technical.has_alpha_channel).toBe(true);
    expect(r.technical.transparent_share).toBeGreaterThan(0.9);
    expect(r.facts.background.kind).toBe("transparent");
    expect(r.technical.content_box.x).toBeCloseTo(0.375, 1);
    expect(r.technical.content_box.w).toBeCloseTo(0.25, 1);
    expect(r.facts.dominant_colours[0]!.hex).toBe("#81d870");
    const d = await deriveFiles(p, r.technical, join(dir, "d"));
    expect(d.trimmed_size!.width).toBeLessThan(260);
    expect(readFileSync(p).length).toBe(statSync(p).size); // the original is only read
  });
  it("trims padding around a mark on a flat background and describes that background", () => {
    const w = 100, h = 100, px = Buffer.alloc(w * h * 4, 255);
    for (let y = 40; y < 60; y++) for (let x = 20; x < 80; x++) { const i = (y * w + x) * 4; px[i] = 10; px[i + 1] = 40; px[i + 2] = 50; }
    const f = measureRgba(px, w, h);
    expect(f.background.kind).toBe("flat_light");
    expect(f.content_box).toEqual({ x: 0.2, y: 0.4, w: 0.6, h: 0.2 });
    expect(f.composition.subject_position).toBe("center");
  });
  it("catches a renamed file from its bytes, not its name", async () => {
    const p = await png("real.png");
    const fake = join(dir, "photo.jpg");
    copyFileSync(p, fake);
    expect(await sniffImageFormat(fake)).toBe("png");
    const r = await inspectImage(fake);
    if (!r.ok) throw new Error(r.message);
    expect(r.technical.mime).toBe("image/png");
    expect(r.technical.extension_matches).toBe(false);
    expect((await deriveFiles(fake, r.technical, join(dir, "d"))).normalize_reason).toMatch(/extension does not match/);
  });
  it("gives a very large picture a smaller copy and leaves the original alone", async () => {
    const p = join(dir, "big.png");
    await sharp({ create: { width: 5000, height: 2000, channels: 3, background: "#123456" } }).png().toFile(p);
    const before = createHash("sha256").update(readFileSync(p)).digest("hex");
    const r = await inspectImage(p);
    if (!r.ok) throw new Error(r.message);
    const d = await deriveFiles(p, r.technical, join(dir, "d"));
    expect(d.normalized_size).toEqual({ width: 4096, height: 1638 });
    expect(createHash("sha256").update(readFileSync(p)).digest("hex")).toBe(before);
  });
  it("normalizes a format the renderers do not load, and says it cannot read a damaged one", async () => {
    const tif = join(dir, "a.tiff");
    await sharp({ create: { width: 100, height: 60, channels: 3, background: "#884400" } }).tiff().toFile(tif);
    const r = await inspectImage(tif);
    if (!r.ok) throw new Error(r.message);
    expect((await deriveFiles(tif, r.technical, join(dir, "d"))).normalized_path).toMatch(/normalized\.png$/);

    const broken = join(dir, "broken.png");
    writeFileSync(broken, readFileSync(await png("ok.png")).subarray(0, 60));
    const bad = await inspectImage(broken);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("corrupt");
    const notImage = join(dir, "note.png");
    writeFileSync(notImage, "this is text, whatever the name says");
    const no = await inspectImage(notImage);
    expect(no.ok).toBe(false);
    if (!no.ok) expect(no.code).toBe("unsupported_format");
  });
});

describe("deciding what a picture is", () => {
  const scored = (favour: string) => ALL_PROMPTS.map((label) => ({ label, score: label.includes(favour) ? 0.5 : 0.01 }));
  const facts = { word_count: 0, has_transparency: false, photographic: false, aspect_ratio: 1.6 };
  it("tells a logo with words from a mark without", () => {
    expect(decideCategories(scored("company logo"), { ...facts, word_count: 3 }).categories[0]!.category).toBe("company_logo");
    expect(decideCategories(scored("company logo"), facts).categories[0]!.category).toBe("brand_logo");
  });
  it("says unknown instead of guessing when nothing is confident", () => {
    const flat = ALL_PROMPTS.map((label) => ({ label, score: 1 / ALL_PROMPTS.length }));
    const r = decideCategories(flat, facts);
    expect(r.categories[0]!.category).toBe("other_unknown");
    expect(r.evidence.join(" ")).toMatch(/nothing is claimed/);
  });
  it("does not call a photograph of people with laptops a screenshot", () => {
    const r = decideCategories(ALL_PROMPTS.map((label) => ({ label, score: label.includes("dashboard") ? 0.42 : label.includes("group photo") ? 0.09 : 0.02 })), { ...facts, photographic: true, objects: ["person", "human face"] });
    expect(r.categories[0]!.category).toBe("person_or_team_photo");
  });
  it("never sees a file name: two names for the same bytes get the same answer", async () => {
    const a = await png("logo.png"), b = join(dir, "holiday-beach.png");
    copyFileSync(a, b);
    const reg = new AssetRegistry(join(dir, "reg"));
    const { model, calls } = fakeVision("a screenshot of a website");
    const deps = { registry: reg, vision: model, ocr: [] };
    const one = await understandAsset(deps, ids("sess1"), await assetOf(a, "asset_00000001", "logo.png"), null);
    const two = await understandAsset(deps, ids("sess2"), await assetOf(b, "asset_00000002", "holiday-beach.png"), null);
    expect(one!.effective_categories).toEqual(two!.effective_categories);
    expect(one!.effective_categories[0]!.category).toBe("website_screenshot");
    expect(calls.classify).toBe(1);
  });
});

describe("the asset registry", () => {
  it("survives a restart, and a correction outranks the model", async () => {
    const p = await png("a.png");
    const root = join(dir, "reg");
    const a = await assetOf(p, "asset_00000001", "a.png");
    await understandAsset({ registry: new AssetRegistry(root), vision: fakeVision("a screenshot of a website").model, ocr: [] }, ids("sess1"), a, null);
    const fresh = new AssetRegistry(root); // a new process reads the same folder
    const before = await fresh.resolve("sess1", a.asset_id);
    expect(before!.effective_categories[0]).toMatchObject({ category: "website_screenshot", source: "vision" });
    expect(before!.original_filename).toBe("a.png");
    fresh.setUserInput("sess1", a.asset_id, { category: "company_logo", description: "This is our official company logo.", usage: "must_use" });
    const after = await new AssetRegistry(root).resolve("sess1", a.asset_id);
    expect(after!.effective_categories).toEqual([{ category: "company_logo", confidence: 1, source: "user" }]);
    expect(after!.effective_description).toBe("This is our official company logo.");
    expect(manifestEntry(after!).usage).toBe("must_use");
  });
  it("reuses an analysis across projects, while a correction stays in its own project", async () => {
    const p = await png("a.png"), copy = join(dir, "b.png");
    copyFileSync(p, copy);
    const reg = new AssetRegistry(join(dir, "reg"));
    const { model, calls } = fakeVision("a photo of a physical object");
    const deps = { registry: reg, vision: model, ocr: [] };
    await understandAsset(deps, ids("sess1"), await assetOf(p, "asset_00000001", "a.png"), null);
    await understandAsset(deps, ids("sess2"), await assetOf(copy, "asset_00000002", "b.png"), null);
    expect(calls.classify).toBe(1);
    expect(calls.describe).toBe(1);
    expect(reg.projectsUsing(await sha256OfFile(p)).sort()).toEqual(["sess1", "sess2"]);
    reg.setUserInput("sess1", "asset_00000001", { usage: "do_not_use" });
    expect((await reg.resolve("sess1", "asset_00000001"))!.user.usage).toBe("do_not_use");
    expect((await reg.resolve("sess2", "asset_00000002"))!.user.usage).toBe("auto");
  });
  it("never resolves another project's picture by id", async () => {
    const p = await png("a.png");
    const reg = new AssetRegistry(join(dir, "reg"));
    await understandAsset({ registry: reg, vision: fakeVision("simple icon").model, ocr: [] }, ids("sess1"), await assetOf(p, "asset_00000001", "a.png"), null);
    expect(await reg.resolve("sess2", "asset_00000001")).toBeNull();
    expect(reg.renderFile("sess2", "asset_00000001", "hero")).toBeNull();
    expect(reg.renderFile("sess1", "asset_00000001", "hero")?.path).toBe(p);
  });
  it("notices a file that has gone or changed, and does not hand it to a renderer", async () => {
    const p = await png("a.png"), reg = new AssetRegistry(join(dir, "reg"));
    await understandAsset({ registry: reg, vision: fakeVision("simple icon").model, ocr: [] }, ids("sess1"), await assetOf(p, "asset_00000001", "a.png"), null);
    writeFileSync(p, Buffer.concat([readFileSync(p), Buffer.from([0])]));
    expect((await reg.resolve("sess1", "asset_00000001"))!.availability).toBe("changed_on_disk");
    expect(reg.renderFile("sess1", "asset_00000001", "hero")).toBeNull();
    rmSync(p);
    expect((await reg.resolve("sess1", "asset_00000001"))!.availability).toBe("missing_file");
  });
  it("hands a logo's trimmed copy to the renderer, and the same file for any other role", async () => {
    const p = join(dir, "pad.png");
    await sharp({ create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: await sharp({ create: { width: 200, height: 50, channels: 4, background: "#203339" } }).png().toBuffer(), left: 200, top: 275 }]).png().toFile(p);
    const reg = new AssetRegistry(join(dir, "reg"));
    await understandAsset({ registry: reg, vision: fakeVision("a company logo").model, ocr: [] }, ids("sess1"), await assetOf(p, "asset_00000001", "pad.png"), null);
    const logo = reg.renderFile("sess1", "asset_00000001", "logo")!;
    expect(logo.variant).toBe("trimmed");
    expect(logo.width).toBeLessThan(240);
    expect(logo.transparent).toBe(true);
    expect(logo.sha256).toBe(await sha256OfFile(logo.path));
    expect(reg.renderFile("sess1", "asset_00000001", "hero")!.path).toBe(p);
  });
});

describe("when analysis cannot finish", () => {
  it("keeps the upload, invents nothing, says it failed, and works on a retry", async () => {
    const p = await png("a.png"), reg = new AssetRegistry(join(dir, "reg"));
    const a = await assetOf(p, "asset_00000001", "a.png");
    const broken = fakeVision("x", { failClassify: true });
    const r = await understandAsset({ registry: reg, vision: broken.model, ocr: [] }, ids("sess1"), a, null);
    expect(r!.content.analysis.status).toBe("failed");
    expect(r!.content.analysis.retryable).toBe(true);
    expect(r!.content.analysis.categories).toEqual([]);
    expect(r!.effective_description).toBeNull();
    expect(existsSync(p)).toBe(true);
    const m = manifestEntry(r!);
    expect(m.caveats.join(" ")).toMatch(/Analysis failed/);
    const notes = notesWithAnalysis(buildAssetNotes(a, null), r!);
    expect(notes.content_summary).not.toMatch(/logo|photo/i);

    const ok = await analyseContent({ registry: reg, vision: fakeVision("a simple icon").model, ocr: [] }, r!.content_id, p, null, { force: true });
    expect(ok.analysis.categories[0]!.category).toBe("icon_symbol");
  });
  it("runs without any vision model and says so", async () => {
    const p = await png("a.png"), reg = new AssetRegistry(join(dir, "reg"));
    const r = await understandAsset({ registry: reg, vision: null, ocr: [] }, ids("sess1"), await assetOf(p, "asset_00000001", "a.png"), null);
    expect(r!.content.analysis.error).toMatch(/No vision model/);
    expect(r!.content.technical!.width).toBe(240);
    expect(r!.content.thumbnail_path).toBeTruthy();
  });
  it("keeps the labels when only the describer fails, and marks that as partial", async () => {
    const p = await png("a.png"), reg = new AssetRegistry(join(dir, "reg"));
    const r = await understandAsset({ registry: reg, vision: fakeVision("a simple icon", { failDescribe: true }).model, ocr: [] }, ids("sess1"), await assetOf(p, "asset_00000001", "a.png"), null);
    expect(r!.content.analysis.status).toBe("partial");
    expect(r!.content.analysis.visual!.description).toBeNull();
    expect(r!.effective_categories[0]!.category).toBe("icon_symbol");
    expect(r!.content.analysis.evidence.join(" ")).toMatch(/describer failed/);
  });
  it("records a file that cannot be decoded as unusable, with a reason", async () => {
    const p = join(dir, "bad.png"), reg = new AssetRegistry(join(dir, "reg"));
    writeFileSync(p, "not a picture");
    const r = await understandAsset({ registry: reg, vision: fakeVision("x").model, ocr: [] }, ids("sess1"), await assetOf(p, "asset_00000001", "bad.png"), null);
    expect(r!.content.analysis.status).toBe("unsupported");
    expect(r!.content.analysis.error).toMatch(/not a supported picture/);
    expect(r!.content.analysis.retryable).toBe(false);
  });
});

// The real local models on real pictures. Needs storage/fixtures/assets and the downloaded weights; on a machine without them the tests say so and skip.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const models = join(repo, "storage", "models");
const fx = (n: string) => join(repo, "storage", "fixtures", "assets", n);
const haveReal = existsSync(join(models, "Xenova", "clip-vit-base-patch32")) && existsSync(join(models, "onnx-community", "Florence-2-base-ft")) && ["logo-digikon.png", "dashboard.png", "product-b.jpg", "team-a.jpg"].every((n) => existsSync(fx(n)));

describe.skipIf(!haveReal)("real local vision on real pictures", () => {
  const see = async (name: string) => {
    const reg = new AssetRegistry(join(dir, "reg"));
    const p = fx(name);
    const a = Asset.parse({ asset_id: "asset_00000001", uri: p, media_type: "image", duration: null, width: null, height: null, metadata: { original_name: "upload", sha256: await sha256OfFile(p) } });
    const { measureImage } = await import("./image.js");
    const insp = await inspectImage(p);
    if (!insp.ok) throw new Error(insp.message);
    return understandAsset({ registry: reg, vision: real, ocr: await availableOcr() }, ids("sess1"), a, await measureImage(p, { width: insp.technical.width, height: insp.technical.height }));
  };
  const real = new LocalVision({ cacheDir: models });
  it("identifies a company logo, reads its words and finds its transparency", async () => {
    const r = (await see("logo-digikon.png"))!;
    expect(r.effective_categories[0]!.category).toBe("company_logo");
    expect(r.content.analysis.status).toBe("analyzed");
    expect(r.content.technical!.transparent_share).toBeGreaterThan(0.5);
    if (r.content.analysis.visual!.ocr.status !== "unavailable") expect(r.content.analysis.visual!.ocr.text.toUpperCase()).toContain("SOLUTIONS");
  });
  it("identifies a dashboard screenshot and reads text from it", async () => {
    const r = (await see("dashboard.png"))!;
    expect(r.effective_categories[0]!.category).toBe("dashboard_ui");
    if (r.content.analysis.visual!.ocr.status !== "unavailable") expect(r.content.analysis.visual!.ocr.text).toMatch(/KINETIC/);
  });
  it("identifies a product photograph", async () => {
    const r = (await see("product-b.jpg"))!;
    expect(r.effective_categories[0]!.category).toBe("product_photo");
    expect(r.effective_description!.toLowerCase()).toContain("camera");
  });
  it("identifies a team photograph", async () => {
    const r = (await see("team-a.jpg"))!;
    expect(r.effective_categories[0]!.category).toBe("person_or_team_photo");
    expect(r.effective_description!.toLowerCase()).toMatch(/people|group/);
  });
});

describe("reading visible text", () => {
  it("reads rendered text when a local OCR engine exists, and otherwise says OCR is unavailable", async () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="260"><rect width="900" height="260" fill="#ffffff"/><text x="40" y="150" font-family="Arial" font-size="90" fill="#111111">Hello DigiKon</text></svg>`);
    const p = join(dir, "text.png");
    await sharp(svg).png().toFile(p);
    const engines = await availableOcr();
    const r = await readText(p, engines);
    if (!engines.length) expect(r.status).toBe("unavailable");
    else { expect(r.status).toBe("read"); expect(r.text).toMatch(/Hello\s+Digi\s?Kon/i); }
    expect((await readText(p, [])).status).toBe("unavailable");
  });
  it("reports a failed read as failed, not as no text", async () => {
    const r = await readText(await png("x.png"), [{ name: "broken", read: async () => { throw new Error("no engine"); } }]);
    expect(r.status).toBe("failed");
  });
});
