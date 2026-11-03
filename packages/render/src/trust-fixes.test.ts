import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DRAWN_BLOCKS } from "@digikon/contracts";
import { recipeDocs } from "@digikon/rag";
import { xfadeCodeHash, xfadeStaleness, type CapabilityRecord } from "./capabilities.js";
import { COMPOSITION_TEMPLATE } from "./composition.js";
import { canonicalSeal, compositionFingerprint, loadVisualCapabilities, toolDrift, verifySeal, visualDir, visualToolVersions, VisualCapabilityRecord } from "./visual-capabilities.js";

const xfadeRecord = (browser: string | undefined, ffmpeg_version: string) => ({ validated: { ffmpeg_version, ...(browser ? { browser } : {}) } }) as unknown as CapabilityRecord;

describe("xfade evidence goes stale when the code or FFmpeg changes", () => {
  const code = xfadeCodeHash();
  it("a record for the current xfade code and FFmpeg is fine", () => {
    expect(xfadeStaleness(xfadeRecord(`xfade-code ${code}`, "ffmpeg version 7.0"), { ffmpeg: "ffmpeg version 7.0" })).toBeNull();
  });
  it("a record for other xfade code is stale", () => {
    expect(xfadeStaleness(xfadeRecord(`xfade-code ${"0".repeat(16)}`, "v"), { code: "f".repeat(16), ffmpeg: "v" })).toMatch(/xfade code changed/);
  });
  it("a record for another FFmpeg is stale", () => {
    expect(xfadeStaleness(xfadeRecord(`xfade-code ${code}`, "ffmpeg version 6.1"), { ffmpeg: "ffmpeg version 7.0" })).toMatch(/FFmpeg changed/);
  });
  it("a record with no code hash (written before it existed) is judged by FFmpeg alone", () => {
    expect(xfadeStaleness(xfadeRecord(undefined, "v"), { ffmpeg: "v" })).toBeNull();
    expect(xfadeStaleness(xfadeRecord(undefined, "old"), { ffmpeg: "new" })).toMatch(/FFmpeg changed/);
  });
  it("an FFmpeg that cannot be read does not make evidence stale", () => {
    expect(xfadeStaleness(xfadeRecord(`xfade-code ${code}`, "v"), { ffmpeg: null })).toBeNull();
  });
});

describe("the retrieval index does not call an implementation validated unless it is", () => {
  const recipe = { recipe_id: "r1", title: "t", purpose: "p", intents: ["i"], type: "transition", constraints: { energy: "low", min_duration_s: 1, max_duration_s: 2 }, status: "approved", compatibility: { aspect_ratios: ["16:9"], media_types: ["image"] }, source: { origin: "o", license: "l" }, version: "1" } as never;
  it("says an implementation is registered, and says validated only for the validated set", () => {
    const only = recipeDocs([recipe], { implemented: new Set(["r1"]) })[0]!;
    expect(only.text).toContain("an implementation is registered");
    expect(only.text).not.toContain("validated by a real render");
    expect(recipeDocs([recipe], { implemented: new Set(["r1"]), validated: new Set(["r1"]) })[0]!.text).toContain("validated by a real render");
    expect(recipeDocs([recipe], { implemented: new Set() })[0]!.text).toContain("not yet");
  });
});

describe("visual capability seals", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const legacy16 = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

  it("a canonical seal is 64 hex and does not depend on key order", () => {
    const a = canonicalSeal({ x: 1, y: { b: 2, a: 3 } }), b = canonicalSeal({ y: { a: 3, b: 2 }, x: 1 });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(canonicalSeal({ x: 2 })).not.toBe(a);
  });
  it("verifySeal accepts a legacy 16-hex and a full 64-hex seal, and nothing else", () => {
    const body = { a: 1, b: [1, 2] };
    expect(verifySeal(body, legacy16(body))).toBe(true);
    expect(verifySeal(body, canonicalSeal(body))).toBe(true);
    expect(verifySeal({ ...body, a: 2 }, canonicalSeal(body))).toBe(false);
    expect(verifySeal({ ...body, a: 2 }, legacy16(body))).toBe(false);
    expect(verifySeal(body, "abc")).toBe(false);
  });

  const write = (versions: Partial<ReturnType<typeof visualToolVersions>> | "legacy", seal: "legacy" | "full", tamper = false) => {
    const root = mkdtempSync(join(tmpdir(), "visual-seal-"));
    dirs.push(root);
    mkdirSync(visualDir(root), { recursive: true });
    const tools = visualToolVersions();
    const extra = versions === "legacy" ? {} : { remotion_renderer: tools.remotion_renderer, ffmpeg: tools.ffmpeg, chrome: tools.chrome, ...versions };
    const block = DRAWN_BLOCKS[0]!;
    const rest = VisualCapabilityRecord.omit({ record_hash: true }).parse({
      format: "digikon.visual-capability", format_version: 1, capability_id: `remotion:scene-composition:${block}`, capability_version: "1.0.0", engine: "remotion", template: COMPOSITION_TEMPLATE, block,
      creative_use: "x", example: {}, limitations: [], not_validated: [],
      status: "validated", failure: null,
      validated: { at: new Date().toISOString(), fingerprint: compositionFingerprint(), remotion: tools.remotion, browser: "chrome via remotion", ...extra, inputs: [{ width: 960, height: 540, fps: 30, duration_s: 3, spec_hash: "s", art_direction_hash: "a", overlay_text: null }], renders: [], checks: ["ok"], measures: [] },
    });
    const record_hash = seal === "full" ? canonicalSeal(rest) : legacy16(rest);
    const out = tamper ? { ...rest, creative_use: "changed" } : rest;
    writeFileSync(join(visualDir(root), `${block}.json`), JSON.stringify({ ...out, record_hash }));
    return { root, block };
  };
  const state = (root: string, block: string) => loadVisualCapabilities(root).find((s) => s.block === block)!;

  it("loads an old 16-hex record and a new 64-hex record", () => {
    const old = write("legacy", "legacy"); expect(state(old.root, old.block)).toMatchObject({ usable: true });
    const neu = write({}, "full"); expect(state(neu.root, neu.block)).toMatchObject({ usable: true });
    expect(state(neu.root, neu.block).record!.record_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects a record changed after it was sealed, under either seal", () => {
    for (const seal of ["legacy", "full"] as const) {
      const t = write({}, seal, true);
      expect(state(t.root, t.block)).toMatchObject({ usable: false, reason: expect.stringContaining("hash mismatch") });
    }
  });
  it("a record whose Remotion or Chrome version differs from this machine is stale", () => {
    const r = write({ remotion_renderer: "0.0.0-other" }, "full");
    expect(state(r.root, r.block)).toMatchObject({ usable: false, reason: expect.stringContaining("@remotion/renderer") });
    const c = write({ chrome: "1.2.3.4-other" }, "full");
    const cur = visualToolVersions().chrome;
    if (cur !== "unknown") expect(state(c.root, c.block)).toMatchObject({ usable: false, reason: expect.stringContaining("chrome") });
  });
  it("toolDrift compares only versions that were recorded and can be read", () => {
    const now = { remotion: "4.0.1", remotion_renderer: "4.0.1", ffmpeg: "f2", chrome: "c2" };
    expect(toolDrift({ remotion: "4.0.1" }, now)).toBeNull();
    expect(toolDrift({ remotion: "4.0.0" }, now)).toContain("remotion 4.0.0 -> 4.0.1");
    expect(toolDrift({ remotion: "unknown", ffmpeg: "f1" }, now)).toContain("ffmpeg f1 -> f2");
    expect(toolDrift({ remotion: "4.0.1", chrome: "c1" }, { ...now, chrome: "unknown" })).toBeNull();
  });
});
