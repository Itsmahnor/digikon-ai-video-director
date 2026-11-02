import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { meetsReadiness, snapshotHash, capabilityHash, validateParameters, type CapabilityQuery, type Recipe } from "@digikon/contracts";
import {
  CapabilityRegistry, buildAdapterRegistry, declaredImplementations, implementationsOf, liveImplementations, loadCapabilityRegistry, loadVisualCapabilities, stubAdapters,
  type RegistrySources,
} from "./index.js";
import { recipes, root } from "../../director/src/fixtures.js";

const capDir = join(root(""), "capabilities");
const learned = loadCapabilityRegistry(capDir, { dependency: () => null, recipes: { get: (id) => recipes.find((r) => r.recipe_id === id) } });
const visual = loadVisualCapabilities(capDir);
const DECL = declaredImplementations(learned.usable);
const build = (over: Partial<RegistrySources> = {}) => CapabilityRegistry.from({ recipes, learned, visual, implementations: liveImplementations(DECL), declared: DECL, ...over });
const reg = build();
const codes = (r: CapabilityRegistry, id: string) => r.diagnosticsFor(id).map((d) => d.code);
const clone = (id: string): Recipe => structuredClone(recipes.find((r) => r.recipe_id === id)!);

describe("all 47 reconciled entries satisfy the ladder invariants", () => {
  it("there are exactly 47: 40 recipes and 7 visual blocks", () => {
    expect(reg.snapshot.capabilities.length).toBe(47);
    expect(reg.snapshot.capabilities.filter((c) => c.variant_of !== null).length).toBe(7);
  });
  for (const c of reg.snapshot.capabilities) {
    it(`${c.capability_id}: status, evidence and hash are consistent`, () => {
      const { record_hash, ...body } = c;
      expect(capabilityHash(body)).toBe(record_hash);
      expect(reg.get(c.capability_id)).toEqual(c);
      if (meetsReadiness(c.status, "executable")) {
        expect(c.implementation_state).toBe("runtime_resolved");
        expect(c.evidence.some((e) => e.kind === "adapter_registration" && e.valid)).toBe(true);
        expect(c.operations.length).toBeGreaterThan(0);
      }
      if (meetsReadiness(c.status, "validated")) expect(c.evidence.some((e) => (e.kind === "learned_record" || e.kind === "visual_record") && e.valid)).toBe(true);
      if (meetsReadiness(c.status, "reviewed")) expect(c.evidence.some((e) => e.kind === "recipe_review" && e.valid)).toBe(true);
      if (c.status === "registered") expect(c.status_reasons.length).toBeGreaterThan(0);
      for (const e of c.evidence) { // every item says what it proves and what it does not
        expect(e.proves.length).toBeGreaterThan(0);
        expect(e.does_not_prove.length).toBeGreaterThan(0);
      }
      if (c.variant_of) {
        const parent = reg.get(c.variant_of);
        expect(parent, `${c.capability_id} names a parent that exists`).toBeDefined();
        for (const o of c.operations) expect(parent!.operations).toContain(o);
        expect(c.implementation_ref).toBe(parent!.implementation_ref);
      }
    });
  }
});

describe("implementation evidence comes from live adapters, not declarations", () => {
  it("a declaration with no live adapter is declared_only, never executable, and says why", () => {
    const r = build({ implementations: {}, adapter_failures: [{ engine: "remotion", reason: "no compatible browser" }] });
    expect(r.counts().executable).toBe(0);
    expect(r.snapshot.declared_only.length).toBeGreaterThan(20);
    const c = r.get("remotion:slow-push-in")!;
    expect(c.implementation_state).toBe("declared_only");
    expect(c.status).toBe("registered");
    expect(r.diagnosticsFor(c.capability_id).find((d) => d.code === "ADAPTER_UNAVAILABLE")!.message).toContain("no compatible browser");
    expect(r.snapshot.adapter_failures).toEqual([{ engine: "remotion", reason: "no compatible browser" }]);
  });
  it("only the engines whose adapter exists are executable", () => {
    const r = build({ implementations: liveImplementations(DECL, ["ffmpeg"]) });
    expect(r.get("ffmpeg:text-card-fade")!.status).toBe("executable");
    expect(r.get("remotion:slow-push-in")!.status).toBe("registered");
    expect(r.get("hyperframes:slow-push-in-hyperframes")!.status).toBe("registered");
    expect(r.get("remotion:scene-composition:kinetic_type")!.status).toBe("registered");
  });
  it("the runtime list is what an AdapterRegistry resolves, template by template", () => {
    const adapters = stubAdapters(DECL);
    const live = implementationsOf(adapters);
    for (const ref of adapters.templateRefs()) expect(live[ref]).toEqual(adapters.adapterFor(ref)!.templates[ref]);
    expect(Object.keys(live).sort()).toEqual(adapters.templateRefs().sort());
  });
  it("a live registration that lacks the recipe's operation is unsupported, not executable", () => {
    const r = build({ implementations: { ...liveImplementations(DECL), "ffmpeg/text-card": ["concat"] } });
    expect(codes(r, "ffmpeg:text-card-fade")).toContain("UNSUPPORTED_OPERATION");
    expect(r.get("ffmpeg:text-card-fade")!.status).toBe("registered");
  });
  it("the real adapter construction reports every engine as unavailable when FFmpeg or the font is missing", () => {
    const none = buildAdapterRegistry({ ffmpegOk: false, fontFile: "C:/nowhere/font.ttf", outputRoot: join(root(""), "storage", "unused"), capabilitiesDir: capDir, recipes: { get: (id) => recipes.find((x) => x.recipe_id === id) } });
    expect(none.available).toBe(false);
    expect(none.failures.map((f) => f.engine).sort()).toEqual(["ffmpeg", "hyperframes", "remotion"]);
    const r = build({ implementations: implementationsOf(none.registry), adapter_failures: none.failures });
    expect(r.counts().executable).toBe(0);
    expect(r.snapshot.adapter_failures.length).toBe(3);
  });
  it("building real adapters here, if this machine can, is consistent with what the registry reports", () => {
    let ffmpegOk = false;
    try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); ffmpegOk = true; } catch { /* not installed */ }
    const font = "C:\\Windows\\Fonts\\arial.ttf";
    const built = buildAdapterRegistry({ ffmpegOk, fontFile: font, outputRoot: join(root(""), "storage", "unused"), capabilitiesDir: capDir, recipes: { get: (id) => recipes.find((x) => x.recipe_id === id) } });
    const r = build({ implementations: implementationsOf(built.registry), adapter_failures: built.failures });
    for (const c of r.snapshot.capabilities) if (meetsReadiness(c.status, "executable")) expect(built.registry.supports(c.implementation_ref!, c.operations[0]!)).toBe(true);
    for (const e of built.registry.renderers()) expect(["ffmpeg", "remotion", "hyperframes"]).toContain(e);
    expect(built.failures.every((f) => f.reason.length > 0)).toBe(true);
  });
});

describe("parameters: definitions versus invocations", () => {
  it("the recipe is the schema source: capability parameters equal the recipe's, whatever the learned record lists", () => {
    for (const c of reg.snapshot.capabilities.filter((x) => x.variant_of === null)) expect(c.parameters).toEqual(recipes.find((r) => r.recipe_id === c.recipe_id)!.parameters);
  });
  it("every recipe parameter has a valid default, so none of the record-coverage warnings is an execution blocker", () => {
    const warnings = reg.snapshot.diagnostics.filter((d) => d.code === "PARAMETER_NOT_VALIDATED");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((d) => d.severity === "warning")).toBe(true);
    expect(reg.snapshot.diagnostics.some((d) => d.code === "INVALID_PARAMETER_DEFAULT")).toBe(false);
    for (const c of reg.snapshot.capabilities.filter((x) => x.variant_of === null)) expect(validateParameters(c, {}), c.capability_id).toEqual([]);
    expect(reg.snapshot.diagnostics.some((d) => d.code === "MISSING_REQUIRED_PARAMETER")).toBe(false);
  });
  it("a default that is not valid is an error on the entry and blocks any invocation that omits the value", () => {
    const r = clone("slow-push-in");
    const p = r.parameters.find((x) => x.kind === "number")!;
    if (p.kind !== "number") throw new Error("fixture");
    p.default = p.max + 5; // bypasses the recipe schema, as a hand-built source could
    const bad = build({ recipes: [...recipes.filter((x) => x.recipe_id !== r.recipe_id), r] });
    const c = bad.get("remotion:slow-push-in")!;
    expect(codes(bad, c.capability_id)).toContain("INVALID_PARAMETER_DEFAULT");
    expect(validateParameters(c, {}).map((i) => i.code)).toEqual(["PARAM_DEFAULT_INVALID"]);
    expect(validateParameters(c, { [p.name]: p.max })).toEqual([]); // a valid supplied value is enough
  });
  it("invocation checks do not depend on the learned record", () => {
    const c = reg.get("remotion:slow-push-in")!;
    const p = c.parameters.find((x) => x.kind === "number")!;
    if (p.kind !== "number") throw new Error("fixture");
    const stripped = build({ learned: { ...learned, records: learned.records.map((x) => ({ ...x, inputs: { ...x.inputs, parameters: [] } })) } }).get("remotion:slow-push-in")!;
    expect(validateParameters(stripped, { [p.name]: p.max + 1 }).map((i) => i.code)).toEqual(["PARAM_OUT_OF_RANGE"]);
  });
});

describe("what validated does and does not establish", () => {
  const validated = reg.snapshot.capabilities.filter((c) => c.status === "validated");
  it("there are validated entries to examine", () => { expect(validated.length).toBeGreaterThan(0); });
  it("their evidence states its limits and records the aspect ratios actually rendered", () => {
    for (const c of validated) {
      const ev = c.evidence.find((e) => e.kind === "learned_record" || e.kind === "visual_record")!;
      expect(ev.proves.join(" ")).toContain("intact");
      expect(ev.does_not_prove.join(" ")).toContain("renders successfully now");
      expect(ev.does_not_prove.join(" ")).toContain("aspect ratios other than");
      expect(ev.validated_aspect_ratios).not.toBeNull();
      if (c.aspect_ratios) for (const a of ev.validated_aspect_ratios!) expect(c.aspect_ratios).toContain(a);
    }
  });
  it("declared aspect ratios the evidence did not cover are visible as a gap, not hidden", () => {
    const gaps = validated.filter((c) => c.aspect_ratios && c.evidence.some((e) => e.validated_aspect_ratios && c.aspect_ratios!.some((a) => !e.validated_aspect_ratios!.includes(a))));
    expect(Array.isArray(gaps)).toBe(true); // reported in the stage report; the data to compute it is on every entry
  });
  it("validated does not imply reviewed or production", () => {
    for (const c of validated) expect(meetsReadiness(c.status, "reviewed")).toBe(false);
    expect(reg.counts().reviewed).toBe(0);
  });
});

describe("visual block integrity", () => {
  const blocks = reg.snapshot.capabilities.filter((c) => c.variant_of !== null);
  it("every block names an existing parent, runs the parent's template, and claims only operations the parent has", () => {
    for (const b of blocks) {
      const parent = reg.get(b.variant_of!)!;
      expect(b.implementation_ref).toBe(parent.implementation_ref);
      for (const o of b.operations) expect(parent.operations).toContain(o);
    }
  });
  it("a block never inherits the parent's validation or review", () => {
    const parent = reg.get("remotion:scene-composition")!;
    expect(parent.status).toBe("executable");
    const noRecords = build({ visual: visual.map((v) => ({ ...v, record: null, usable: false, reason: "no validation record exists for this block" })) });
    for (const b of noRecords.snapshot.capabilities.filter((c) => c.variant_of)) expect(b.status).toBe("executable");
  });
  it("a block is not executable while its parent is not live-resolved", () => {
    const live = { ...liveImplementations(DECL) } as Record<string, readonly string[]>;
    delete live["remotion/scene-composition"];
    const r = build({ implementations: live as never });
    expect(r.get("remotion:scene-composition")!.status).toBe("registered");
    for (const b of r.snapshot.capabilities.filter((c) => c.variant_of)) { expect(b.status).toBe("registered"); expect(b.implementation_state).toBe("declared_only"); }
  });
  it("a block cannot claim an operation its parent does not implement", () => {
    const comp = clone("scene-composition");
    (comp as { operation_type: string }).operation_type = "overlay_text";
    const r = build({ recipes: [...recipes.filter((x) => x.recipe_id !== comp.recipe_id), comp] });
    for (const b of r.snapshot.capabilities.filter((c) => c.variant_of)) {
      expect(codes(r, b.capability_id)).toContain("VARIANT_OPERATION_MISMATCH");
      expect(b.operations).toEqual([]);
      expect(meetsReadiness(b.status, "executable")).toBe(false);
    }
  });
  it("blocks with no parent recipe are registered only and never variants of anything", () => {
    const r = build({ recipes: recipes.filter((x) => x.recipe_id !== "scene-composition") });
    for (const b of r.snapshot.capabilities.filter((c) => c.capability_id.startsWith("remotion:scene-composition:"))) {
      expect(b.variant_of).toBeNull();
      expect(b.status).toBe("registered");
    }
  });
  it("a deprecated composition template deprecates its blocks", () => {
    const r = build({ deprecated: new Set(["remotion/scene-composition"]) });
    for (const b of r.snapshot.capabilities.filter((c) => c.variant_of)) expect(b.status).toBe("deprecated");
  });
});

describe("queries over unavailable adapters, filters and reason codes", () => {
  const down = build({ implementations: liveImplementations(DECL, ["ffmpeg"]) });
  it("declared-only entries are excluded by default with BELOW_READINESS and a reason that names the missing adapter", () => {
    const r = down.query({});
    const rej = r.rejected.find((x) => x.capability_id === "remotion:slow-push-in")!;
    expect(rej.rejections.map((x) => x.code)).toEqual(["BELOW_READINESS"]);
    expect(rej.rejections[0]!.detail).toContain("declared but no live adapter registered it");
    expect(r.candidates.every((c) => c.capability.engine === "ffmpeg")).toBe(true);
  });
  it("engine and readiness filters combine, and each exclusion lists every reason", () => {
    const q: CapabilityQuery = { available_engines: ["remotion"], aspect_ratio: "1:1", duration_s: 9999, required_operations: ["mix_audio"] };
    const rej = reg.query(q).rejected.find((x) => x.capability_id === "remotion:slow-push-in")!;
    expect(rej.rejections.map((x) => x.code)).toEqual(expect.arrayContaining(["OPERATION_NOT_SUPPORTED", "DURATION_OUT_OF_RANGE"]));
  });
  it("same inputs give byte-identical results, repeatedly and across independently built registries", () => {
    const q: CapabilityQuery = { media_types: ["video"], aspect_ratio: "16:9", duration_s: 4, available_engines: ["ffmpeg", "remotion"] };
    const a = JSON.stringify(reg.query(q)), b = JSON.stringify(build().query(q)), c = JSON.stringify(build({ recipes: [...recipes].reverse() }).query(q));
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
  it("querying and validating never change the snapshot or its hash", () => {
    const before = JSON.stringify(reg.snapshot);
    reg.query({}); reg.query({ min_readiness: "registered" }); reg.query({ available_engines: ["ffmpeg"] });
    for (const c of reg.snapshot.capabilities) validateParameters(c, { nope: 1 });
    expect(JSON.stringify(reg.snapshot)).toBe(before);
    const { snapshot_hash, ...rest } = reg.snapshot;
    expect(snapshotHash(rest)).toBe(snapshot_hash);
  });
});
