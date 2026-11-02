import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityHash, snapshotHash, type Recipe } from "@digikon/contracts";
import { CapabilityRegistry, declaredImplementations, liveImplementations, implementationsOf, loadCapabilityRegistry, loadVisualCapabilities, AdapterRegistry, type RegistrySources, type CapabilityRecord } from "./index.js";
import { recipes, root } from "../../director/src/fixtures.js";

const capDir = join(root(""), "capabilities");
const learned = loadCapabilityRegistry(capDir, { dependency: () => null, recipes: { get: (id) => recipes.find((r) => r.recipe_id === id) } });
const visual = loadVisualCapabilities(capDir);
const DECL = declaredImplementations(learned.usable);
const LIVE = liveImplementations(DECL);
const sources = (over: Partial<RegistrySources> = {}): RegistrySources => ({ recipes, learned, visual, implementations: LIVE, declared: DECL, ...over });
const build = (over: Partial<RegistrySources> = {}) => CapabilityRegistry.from(sources(over));
const codes = (r: CapabilityRegistry, id: string) => r.diagnosticsFor(id).map((d) => d.code);
const recipe = (id: string): Recipe => structuredClone(recipes.find((r) => r.recipe_id === id)!);

describe("reconciliation covers every source", () => {
  const reg = build();
  it("accounts for every recipe, learned record and visual block", () => {
    expect(recipes.length).toBe(40);
    expect(learned.records.length).toBe(18);
    expect(visual.length).toBe(7);
    for (const r of recipes) expect(reg.snapshot.capabilities.some((c) => c.recipe_id === r.recipe_id && c.variant_of === null), r.recipe_id).toBe(true);
    for (const l of learned.records) expect(reg.get(l.capability_id), l.capability_id).toBeDefined();
    for (const v of visual) expect(reg.get(`remotion:scene-composition:${v.block}`), v.block).toBeDefined();
    expect(reg.snapshot.capabilities.length).toBe(recipes.length + visual.length);
  });
  it("resolves real adapter implementations and marks the rest as not executable", () => {
    expect(reg.get("ffmpeg:text-card-fade")!.status).toBe("executable");
    expect(reg.get("ffmpeg:loudness-normalise")!.status).toBe("registered");
    expect(codes(reg, "ffmpeg:loudness-normalise")).toContain("MISSING_IMPLEMENTATION");
  });
  it("derives readiness honestly from the repository data", () => {
    const c = reg.counts();
    expect(c.registered).toBe(47);
    expect(c.executable).toBeGreaterThanOrEqual(c.validated);
    expect(c.reviewed).toBe(0);
    expect(c.production).toBe(0);
    expect(c.deprecated).toBe(0);
    for (const e of reg.snapshot.capabilities) expect(e.status === "reviewed" || e.status === "production").toBe(false);
  });
  it("a learned record's validation does not make a capability executable without an implementation", () => {
    const reg2 = build({ implementations: {}, declared: {} });
    expect(reg2.counts().executable).toBe(0);
    expect(reg2.counts().validated).toBe(0);
    expect(codes(reg2, "remotion:slow-push-in")).toContain("MISSING_IMPLEMENTATION");
    expect(reg2.get("remotion:slow-push-in")!.implementation_state).toBe("absent");
  });
  it("lists the live adapter implementations when given an AdapterRegistry", () => {
    expect(implementationsOf(new AdapterRegistry())).toEqual({});
  });
  it("keeps visual blocks as variants of the composition template with unknowns left unknown", () => {
    const b = reg.get("remotion:scene-composition:kinetic_type")!;
    expect(b.variant_of).toBe("remotion:scene-composition");
    expect(b.media_types).toBeNull();
    expect(b.scene_types).toBeNull();
    expect(reg.get("remotion:slow-push-in")!.scene_types).toBeNull();
    expect(reg.get("remotion:slow-push-in")!.asset_slots[0]!.min_resolution).toBeNull();
  });
  it("keeps recipe parameters with their types, ranges and defaults", () => {
    const r = recipes.find((x) => x.recipe_id === "slow-push-in")!;
    expect(reg.get("remotion:slow-push-in")!.parameters).toEqual(r.parameters);
  });
});

describe("rejections carry reason codes and nothing is dropped", () => {
  it("unsupported operation", () => {
    const impl = { ...LIVE, "ffmpeg/text-card": ["concat" as const] };
    const reg = build({ implementations: impl });
    expect(codes(reg, "ffmpeg:text-card-fade")).toContain("UNSUPPORTED_OPERATION");
    expect(reg.get("ffmpeg:text-card-fade")!.status).toBe("registered");
  });
  it("duplicate ids are detected and the duplicate kept but not executable", () => {
    const dup = recipe("text-card-fade");
    const reg = build({ recipes: [...recipes, dup] });
    expect(reg.snapshot.capabilities.length).toBe(48);
    expect(reg.snapshot.diagnostics.some((d) => d.code === "DUPLICATE_CAPABILITY_ID")).toBe(true);
    expect(reg.get("ffmpeg:text-card-fade#duplicate2")!.status).toBe("registered");
  });
  it("an engine the recipe does not list is refused", () => {
    const r = recipe("text-card-fade");
    r.implementation_ref = "remotion/text-slide";
    const reg = build({ recipes: [...recipes.filter((x) => x.recipe_id !== "text-card-fade"), r] });
    expect(codes(reg, "remotion:text-card-fade")).toContain("INVALID_ENGINE");
    expect(reg.get("remotion:text-card-fade")!.status).toBe("registered");
  });
  it("an unknown engine becomes an invalid entry", () => {
    const r = recipe("text-card-fade");
    r.implementation_ref = "blender/text-card";
    const reg = build({ recipes: [...recipes.filter((x) => x.recipe_id !== "text-card-fade"), r] });
    expect(reg.get("invalid:text-card-fade")!.engine).toBeNull();
    expect(codes(reg, "invalid:text-card-fade")).toContain("INVALID_ENGINE");
  });
  it("deprecated implementations are not selectable", () => {
    const reg = build({ deprecated: new Set(["remotion/slow-push-in"]) });
    expect(reg.get("remotion:slow-push-in")!.status).toBe("deprecated");
    expect(codes(reg, "remotion:slow-push-in")).toContain("DEPRECATED_OR_ABSENT_IMPLEMENTATION");
    expect(reg.counts().deprecated).toBe(1);
  });
  it("stale evidence: a record for another recipe version stops being validated", () => {
    const r = recipe("slow-push-in");
    r.version = "0.2.0";
    const reg = build({ recipes: [...recipes.filter((x) => x.recipe_id !== "slow-push-in"), r] });
    expect(codes(reg, "remotion:slow-push-in")).toContain("STALE_EVIDENCE");
    expect(reg.get("remotion:slow-push-in")!.status).toBe("executable");
  });
  it("evidence that is not usable now is stale", () => {
    const l = { ...learned, usable: learned.usable.filter((u) => u.capability_id !== "remotion:slow-push-in") };
    const reg = build({ learned: l });
    expect(codes(reg, "remotion:slow-push-in")).toContain("STALE_EVIDENCE");
    expect(reg.get("remotion:slow-push-in")!.status).toBe("executable");
  });
  it("a failed learned record is reported and never validated", () => {
    const failed: CapabilityRecord = { ...structuredClone(learned.records.find((r) => r.capability_id === "remotion:slow-push-in")!), status: "validation_failed", validated: null };
    const l = { records: learned.records.map((r) => (r.capability_id === failed.capability_id ? failed : r)), usable: learned.usable.filter((u) => u.capability_id !== failed.capability_id), problems: [] };
    const reg = build({ learned: l });
    expect(codes(reg, failed.capability_id)).toContain("EVIDENCE_FAILED");
    expect(reg.get(failed.capability_id)!.status).toBe("executable");
  });
  it("evidence rendered at an undeclared aspect ratio is inconsistent", () => {
    const r = recipe("slow-push-in");
    r.compatibility.aspect_ratios = ["16:9"];
    const rec = structuredClone(learned.records.find((x) => x.capability_id === "remotion:slow-push-in")!);
    rec.validated!.renders[0]!.width = 540; rec.validated!.renders[0]!.height = 960;
    const l = { records: learned.records.map((x) => (x.capability_id === rec.capability_id ? rec : x)), usable: learned.usable, problems: [] };
    const reg = build({ recipes: [...recipes.filter((x) => x.recipe_id !== "slow-push-in"), r], learned: l });
    expect(codes(reg, "remotion:slow-push-in")).toContain("ASPECT_INCONSISTENT");
  });
  it("parameters the record does not cover are reported", () => {
    const withParams = recipes.filter((r) => r.parameters.length).length;
    expect(withParams).toBeGreaterThan(0);
    const reg = build();
    expect(reg.snapshot.diagnostics.filter((d) => d.code === "MISSING_REQUIRED_PARAMETER").every((d) => d.severity === "warning")).toBe(true);
  });
  it("a learned record whose recipe is absent is kept and flagged", () => {
    const reg = build({ recipes: recipes.filter((r) => r.recipe_id !== "slow-push-in") });
    expect(codes(reg, "remotion:slow-push-in")).toContain("RECIPE_ABSENT");
    expect(reg.get("remotion:slow-push-in")!.status).toBe("registered");
  });
  it("refused record files and orphan implementations are reported", () => {
    const reg = build({ learned: { ...learned, problems: ["remotion/x.json: not valid JSON"] }, implementations: { ...LIVE, "remotion/orphan": ["trim_clip"] } });
    expect(reg.snapshot.diagnostics.some((d) => d.code === "INVALID_RECORD")).toBe(true);
    expect(reg.snapshot.diagnostics.some((d) => d.code === "ORPHAN_IMPLEMENTATION" && d.message.includes("remotion/orphan"))).toBe(true);
  });
});

describe("promotion needs evidence", () => {
  const reviewedRecipe = (id: string): Recipe => ({ ...recipe(id), status: "reviewed", review: { reviewed_by: "A. Reviewer", reviewed_at: "2026-10-01T00:00:00.000Z", evidence: "test render" } });
  it("a review record on an unvalidated capability is an invalid promotion and stays below reviewed", () => {
    const r = reviewedRecipe("text-card-fade"); // built in, no learned record
    const reg = build({ recipes: [...recipes.filter((x) => x.recipe_id !== r.recipe_id), r] });
    expect(codes(reg, "ffmpeg:text-card-fade")).toContain("INVALID_PROMOTION");
    expect(reg.get("ffmpeg:text-card-fade")!.status).toBe("executable");
  });
  it("review without an implementation is invalid too", () => {
    const r = reviewedRecipe("slow-push-in");
    const reg = build({ recipes: [...recipes.filter((x) => x.recipe_id !== r.recipe_id), r], implementations: {} });
    expect(reg.get("remotion:slow-push-in")!.status).toBe("registered");
    expect(codes(reg, "remotion:slow-push-in")).toContain("INVALID_PROMOTION");
  });
  it("executable + validated + review record is production; a failed learner render never promotes", () => {
    const r = reviewedRecipe("slow-push-in");
    const reg = build({ recipes: [...recipes.filter((x) => x.recipe_id !== r.recipe_id), r] });
    expect(reg.get("remotion:slow-push-in")!.status).toBe("production");
    expect(reg.counts().production).toBe(1);
    expect(build().get("remotion:slow-push-in")!.status).toBe("validated"); // validated render alone is not review
  });
});

describe("the snapshot hash", () => {
  it("is stable, independent of source order and verifiable", () => {
    const a = build(), b = build({ recipes: [...recipes].reverse(), visual: [...visual].reverse() });
    expect(a.snapshot.snapshot_hash).toBe(b.snapshot.snapshot_hash);
    const { snapshot_hash, ...rest } = a.snapshot;
    expect(snapshotHash(rest)).toBe(snapshot_hash);
    for (const c of a.snapshot.capabilities) { const { record_hash, ...body } = c; expect(capabilityHash(body)).toBe(record_hash); }
  });
  it("changes when an implementation, a recipe or a record changes", () => {
    const base = build().snapshot.snapshot_hash;
    expect(build({ implementations: { ...LIVE, "ffmpeg/text-card": [] } }).snapshot.snapshot_hash).not.toBe(base);
    const r = recipe("text-card-fade"); r.purpose += " changed";
    expect(build({ recipes: [...recipes.filter((x) => x.recipe_id !== r.recipe_id), r] }).snapshot.snapshot_hash).not.toBe(base);
    expect(build({ learned: { ...learned, usable: learned.usable.slice(1) } }).snapshot.snapshot_hash).not.toBe(base);
  });
});

describe("reading is side-effect free", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });
  const digest = () => createHash("sha256").update(files(capDir).sort().map((f) => f + readFileSync(f).toString("base64")).join("|")).digest("hex");
  it("building the registry writes nothing under capabilities/", () => {
    const before = digest();
    build(); build();
    expect(digest()).toBe(before);
  });
  it("does not mutate its inputs", () => {
    const copy = JSON.stringify(recipes);
    build();
    expect(JSON.stringify(recipes)).toBe(copy);
  });
});
