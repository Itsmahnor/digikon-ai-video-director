import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateParameters, validateSlotBindings, type CapabilityQuery } from "@digikon/contracts";
import { CapabilityRegistry, declaredImplementations, liveImplementations, loadCapabilityRegistry, loadVisualCapabilities } from "./index.js";
import { recipes, root } from "../../director/src/fixtures.js";

const capDir = join(root(""), "capabilities");
const learned = loadCapabilityRegistry(capDir, { dependency: () => null, recipes: { get: (id) => recipes.find((r) => r.recipe_id === id) } });
const DECL = declaredImplementations(learned.usable);
const LIVE = liveImplementations(DECL);
const reg = CapabilityRegistry.from({ recipes, learned, visual: loadVisualCapabilities(capDir), implementations: LIVE, declared: DECL });
const ids = (q: CapabilityQuery) => reg.query(q).candidates.map((c) => c.capability.capability_id);
const why = (q: CapabilityQuery, id: string) => reg.query(q).rejected.find((r) => r.capability_id === id)?.rejections.map((r) => r.code) ?? [];

describe("eligibility", () => {
  it("offers only executable capabilities by default, never one with no implementation", () => {
    const all = ids({});
    expect(all).not.toContain("ffmpeg:loudness-normalise");
    expect(why({}, "ffmpeg:loudness-normalise")).toEqual(["BELOW_READINESS"]);
    expect(all.length).toBe(reg.counts().executable);
  });
  it("lowering the readiness floor is explicit and brings registered entries back", () => {
    expect(ids({ min_readiness: "registered" })).toContain("ffmpeg:loudness-normalise");
  });
  it("minimum readiness validated keeps only validated entries and ranks them first", () => {
    const got = reg.query({ min_readiness: "validated" }).candidates;
    expect(got.length).toBe(reg.counts().validated);
    expect(got.every((c) => c.capability.status === "validated")).toBe(true);
    const mixed = reg.query({}).candidates.map((c) => c.capability.status);
    expect(mixed.indexOf("executable")).toBeGreaterThan(mixed.lastIndexOf("validated"));
  });
  it("filters by required operation", () => {
    const got = reg.query({ required_operations: ["overlay_text"] }).candidates;
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((c) => c.capability.operations.includes("overlay_text"))).toBe(true);
    expect(why({ required_operations: ["overlay_text"] }, "ffmpeg:text-card-fade")).toEqual(["OPERATION_NOT_SUPPORTED"]);
  });
  it("filters by engine availability", () => {
    const got = reg.query({ available_engines: ["ffmpeg"] }).candidates;
    expect(got.every((c) => c.capability.engine === "ffmpeg")).toBe(true);
    expect(why({ available_engines: ["ffmpeg"] }, "remotion:slow-push-in")).toEqual(["ENGINE_UNAVAILABLE"]);
  });
  it("filters by media type and reports unknown media honestly", () => {
    expect(ids({ media_types: ["audio"] })).not.toContain("remotion:slow-push-in");
    expect(why({ media_types: ["audio"] }, "remotion:slow-push-in")).toEqual(["MEDIA_NOT_ACCEPTED"]);
    const block = reg.query({ media_types: ["video"] }).candidates.find((c) => c.capability.capability_id.startsWith("remotion:scene-composition:"));
    expect(block?.unknowns).toContain("media_types"); // kept, flagged unknown, not claimed as supported
  });
  it("checks asset slot compatibility", () => {
    expect(why({ asset_slots: [{ media_type: "video" }] }, "remotion:logo-reveal")).toEqual(["SLOT_INCOMPATIBLE"]);
    expect(ids({ asset_slots: [{ media_type: "image" }] })).toContain("remotion:logo-reveal");
    expect(why({ asset_slots: [{ media_type: "image", role: "logo" }] }, "remotion:logo-reveal")).toEqual(["SLOT_INCOMPATIBLE"]);
  });
  it("filters by aspect ratio and duration", () => {
    const r = recipes.find((x) => x.recipe_id === "slow-push-in")!;
    expect(ids({ aspect_ratio: "9:16" })).toContain("remotion:slow-push-in");
    expect(why({ duration_s: r.constraints.max_duration_s + 1 }, "remotion:slow-push-in")).toEqual(["DURATION_OUT_OF_RANGE"]);
    expect(ids({ duration_s: r.constraints.min_duration_s })).toContain("remotion:slow-push-in");
    const narrow = CapabilityRegistry.from({ recipes: recipes.map((x) => (x.recipe_id === "slow-push-in" ? { ...x, compatibility: { ...x.compatibility, aspect_ratios: ["16:9" as const] } } : x)), learned, visual: [], implementations: LIVE, declared: DECL });
    expect(narrow.query({ aspect_ratio: "1:1" }).rejected.find((x) => x.capability_id === "remotion:slow-push-in")?.rejections[0]?.code).toBe("ASPECT_UNSUPPORTED");
  });
  it("scene type is unrecorded everywhere, so it excludes nothing and says so", () => {
    const got = reg.query({ scene_type: "product_demo" }).candidates;
    expect(got.length).toBe(reg.counts().executable);
    expect(got.every((c) => c.unknowns.includes("scene_types"))).toBe(true);
  });
  it("matches creative purpose words", () => {
    expect(ids({ creative_purpose: "zzzz-no-such-word" })).toEqual([]);
    expect(why({ creative_purpose: "zzzz" }, "remotion:slow-push-in")).toEqual(["PURPOSE_MISMATCH"]);
  });
  it("deprecated entries are rejected whatever the floor", () => {
    const dep = CapabilityRegistry.from({ recipes, learned, visual: [], implementations: LIVE, declared: DECL, deprecated: new Set(["remotion/slow-push-in"]) });
    expect(dep.query({ min_readiness: "registered" }).rejected.find((x) => x.capability_id === "remotion:slow-push-in")?.rejections[0]?.code).toBe("DEPRECATED");
  });
  it("is deterministic: same snapshot and query, same result, in order, tied to the snapshot hash", () => {
    const q: CapabilityQuery = { aspect_ratio: "16:9", media_types: ["image"] };
    const a = reg.query(q), b = reg.query(q);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.snapshot_hash).toBe(reg.snapshot.snapshot_hash);
    const rejectedIds = a.rejected.map((x) => x.capability_id);
    expect(rejectedIds).toEqual([...rejectedIds].sort());
  });
  it("supporting evidence lists only valid evidence", () => {
    for (const c of reg.query({}).candidates) expect(c.supporting_evidence.every((e) => e.valid)).toBe(true);
    const slow = reg.query({}).candidates.find((c) => c.capability.capability_id === "remotion:slow-push-in")!;
    expect(slow.supporting_evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["adapter_registration", "learned_record"]));
  });
});

describe("parameter validation", () => {
  const cap = reg.get("remotion:slow-push-in")!;
  const num = cap.parameters.find((p) => p.kind === "number")!;
  it("accepts defaults and in-range values", () => {
    expect(validateParameters(cap, {})).toEqual([]);
    if (num.kind === "number") expect(validateParameters(cap, { [num.name]: num.default })).toEqual([]);
  });
  it("rejects out-of-range, wrong-type and unknown parameters with codes", () => {
    if (num.kind !== "number") throw new Error("fixture");
    expect(validateParameters(cap, { [num.name]: num.max + 1 })[0]?.code).toBe("PARAM_OUT_OF_RANGE");
    expect(validateParameters(cap, { [num.name]: "x" })[0]?.code).toBe("PARAM_TYPE");
    expect(validateParameters(cap, { nope: 1 })[0]?.code).toBe("PARAM_UNKNOWN");
  });
  it("checks enum options and string length", () => {
    const e = recipes.flatMap((r) => r.parameters.map((p) => ({ r, p }))).find((x) => x.p.kind === "enum")!;
    const ec = reg.snapshot.capabilities.find((c) => c.recipe_id === e.r.recipe_id && c.variant_of === null)!;
    expect(validateParameters(ec, { [e.p.name]: "not-an-option" })[0]?.code).toBe("PARAM_NOT_IN_OPTIONS");
    const s = recipes.flatMap((r) => r.parameters.map((p) => ({ r, p }))).find((x) => x.p.kind === "string");
    if (s && s.p.kind === "string") {
      const sc = reg.snapshot.capabilities.find((c) => c.recipe_id === s.r.recipe_id && c.variant_of === null)!;
      expect(validateParameters(sc, { [s.p.name]: "x".repeat(s.p.max_length + 1) })[0]?.code).toBe("PARAM_TOO_LONG");
    }
  });
});

describe("slot binding validation", () => {
  const cap = reg.get("remotion:slow-push-in")!;
  const slot = cap.asset_slots[0]!;
  it("accepts a correct binding", () => {
    expect(validateSlotBindings(cap, [{ slot_id: slot.slot_id, asset_id: "A1", media_type: "image", aspect_ratio: "16:9" }])).toEqual([]);
  });
  it("flags a missing mandatory asset, unknown slot, wrong media and double binding", () => {
    expect(slot.mandatory).toBe(true);
    expect(validateSlotBindings(cap, []).map((i) => i.code)).toEqual(["SLOT_MANDATORY_EMPTY"]);
    expect(validateSlotBindings(cap, [{ slot_id: "nope", asset_id: "A1", media_type: "image" }]).map((i) => i.code)).toContain("SLOT_UNKNOWN");
    expect(validateSlotBindings(cap, [{ slot_id: slot.slot_id, asset_id: "A1", media_type: "audio" }]).map((i) => i.code)).toEqual(["SLOT_MEDIA_MISMATCH"]);
    const two = validateSlotBindings(cap, [{ slot_id: slot.slot_id, asset_id: "A1", media_type: "image" }, { slot_id: slot.slot_id, asset_id: "A2", media_type: "image" }]);
    expect(two.map((i) => i.code)).toEqual(["SLOT_DOUBLE_BOUND"]);
  });
  it("flags an asset whose aspect ratio the slot does not hint", () => {
    const narrow = { ...cap, asset_slots: [{ ...slot, aspect_hints: ["16:9" as const] }] };
    expect(validateSlotBindings(narrow, [{ slot_id: slot.slot_id, asset_id: "A1", media_type: "image", aspect_ratio: "9:16" }]).map((i) => i.code)).toEqual(["SLOT_ASPECT_MISMATCH"]);
  });
  it("a capability with no slots needs none", () => {
    const text = reg.get("ffmpeg:text-card-fade")!;
    expect(text.asset_slots).toEqual([]);
    expect(validateSlotBindings(text, [])).toEqual([]);
  });
});
