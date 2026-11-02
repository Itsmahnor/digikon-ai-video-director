import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilityVerification, capabilityHash, meetsReadiness } from "@digikon/contracts";
import { CapabilityRegistry, declaredImplementations, liveImplementations, loadCapabilityRegistry, loadVisualCapabilities, type RegistrySources } from "./index.js";
import { recipes, root } from "../../director/src/fixtures.js";

const capDir = join(root(""), "capabilities");
const learned = loadCapabilityRegistry(capDir, { dependency: () => null, recipes: { get: (id) => recipes.find((r) => r.recipe_id === id) } });
const visual = loadVisualCapabilities(capDir);
const DECL = declaredImplementations(learned.usable);
const build = (over: Partial<RegistrySources> = {}) => CapabilityRegistry.from({ recipes, learned, visual, implementations: liveImplementations(DECL), declared: DECL, ...over });
const reg = build();
const v = (r: CapabilityRegistry, id: string) => r.get(id)!.verification;

describe("verification state on every capability", () => {
  it("every one of the 47 entries carries a valid verification, and current_execution is always not_performed", () => {
    expect(reg.snapshot.capabilities.length).toBe(47);
    for (const c of reg.snapshot.capabilities) {
      expect(CapabilityVerification.safeParse(c.verification).success, c.capability_id).toBe(true);
      expect(c.verification.current_execution).toBe("not_performed");
    }
  });
  it("no combination of the other facts makes current_execution anything else (schema accepts only not_performed)", () => {
    const ok = { adapter_available: true, implementation_resolved: true, historical_evidence: "current" as const };
    expect(CapabilityVerification.safeParse({ ...ok, current_execution: "not_performed" }).success).toBe(true);
    for (const other of ["verified", "passed", "performed", true, null]) expect(CapabilityVerification.safeParse({ ...ok, current_execution: other }).success).toBe(false);
  });
  it("is consistent with status: executable or above means resolved and available; validated or above means current evidence", () => {
    for (const c of reg.snapshot.capabilities) {
      if (meetsReadiness(c.status, "executable")) { expect(c.verification.implementation_resolved).toBe(true); expect(c.verification.adapter_available).toBe(true); }
      if (meetsReadiness(c.status, "validated")) expect(c.verification.historical_evidence).toBe("current");
      if (c.verification.implementation_resolved) expect(c.verification.adapter_available).toBe(true);
    }
    expect(reg.counts().reviewed).toBe(0);
    expect(reg.counts().production).toBe(0);
  });
});

describe("the four questions are answered independently", () => {
  it("live adapter + current record: all three recorded answers true, execution still not performed", () => {
    expect(v(reg, "remotion:slow-push-in")).toEqual({ adapter_available: true, implementation_resolved: true, historical_evidence: "current", current_execution: "not_performed" });
    expect(reg.get("remotion:slow-push-in")!.status).toBe("validated");
  });
  it("live adapter, no record: resolved, no evidence", () => {
    expect(v(reg, "ffmpeg:text-card-fade")).toEqual({ adapter_available: true, implementation_resolved: true, historical_evidence: "none", current_execution: "not_performed" });
  });
  it("live adapter, a record that no longer counts: resolved but stale", () => {
    const r = build({ learned: { ...learned, usable: learned.usable.filter((u) => u.capability_id !== "remotion:slow-push-in") } });
    expect(v(r, "remotion:slow-push-in")).toMatchObject({ adapter_available: true, implementation_resolved: true, historical_evidence: "stale" });
    expect(r.get("remotion:slow-push-in")!.status).toBe("executable");
  });
  it("a failed record counts as stale, never current", () => {
    const rec = { ...structuredClone(learned.records.find((x) => x.capability_id === "remotion:slow-push-in")!), status: "validation_failed" as const, validated: null };
    const r = build({ learned: { records: learned.records.map((x) => (x.capability_id === rec.capability_id ? rec : x)), usable: learned.usable.filter((u) => u.capability_id !== rec.capability_id), problems: [] } });
    expect(v(r, rec.capability_id).historical_evidence).toBe("stale");
  });
  it("the engine's adapter could not be built: unavailable, unresolved, yet the old record is still current", () => {
    const r = build({ implementations: liveImplementations(DECL, ["ffmpeg"]), adapter_failures: [{ engine: "remotion", reason: "no browser" }] });
    expect(v(r, "remotion:slow-push-in")).toEqual({ adapter_available: false, implementation_resolved: false, historical_evidence: "current", current_execution: "not_performed" });
    expect(r.get("remotion:slow-push-in")!.status).toBe("registered");
  });
  it("the adapter exists but does not register this reference: available, not resolved", () => {
    const live = { ...liveImplementations(DECL) } as Record<string, readonly string[]>;
    delete live["remotion/slow-push-in"];
    const r = build({ implementations: live as never });
    expect(v(r, "remotion:slow-push-in")).toMatchObject({ adapter_available: true, implementation_resolved: false, historical_evidence: "current" });
  });
  it("nothing registered anywhere: nothing available or resolved", () => {
    const r = build({ implementations: {}, declared: {} });
    for (const c of r.snapshot.capabilities) expect(c.verification).toMatchObject({ adapter_available: false, implementation_resolved: false });
  });
  it("a visual block whose record is stale: resolved, stale, and not validated", () => {
    const stale = visual.map((x) => ({ ...x, usable: false, reason: "the drawing code changed after it was validated" }));
    const r = build({ visual: stale });
    const b = r.get("remotion:scene-composition:kinetic_type")!;
    expect(b.verification).toMatchObject({ implementation_resolved: true, historical_evidence: "stale" });
    expect(b.status).toBe("executable");
  });
  it("a variant is not resolved while its parent is not", () => {
    const live = { ...liveImplementations(DECL) } as Record<string, readonly string[]>;
    delete live["remotion/scene-composition"];
    const r = build({ implementations: live as never });
    for (const c of r.snapshot.capabilities.filter((x) => x.variant_of)) expect(c.verification.implementation_resolved).toBe(false);
  });
});

describe("the verification block is part of each entry's identity", () => {
  it("is covered by the entry hash, so a change in availability changes the hash", () => {
    for (const c of reg.snapshot.capabilities) { const { record_hash, ...body } = c; expect(capabilityHash(body)).toBe(record_hash); }
    const down = build({ implementations: liveImplementations(DECL, ["ffmpeg"]) });
    expect(down.get("remotion:slow-push-in")!.record_hash).not.toBe(reg.get("remotion:slow-push-in")!.record_hash);
    expect(down.snapshot.snapshot_hash).not.toBe(reg.snapshot.snapshot_hash);
  });
});
