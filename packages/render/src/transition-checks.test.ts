import { describe, expect, it } from "vitest";
import { checkBlend, checkDipToBlack, checkDissolve, checkMatchCut, checkWipe } from "./transition-checks.js";

const W = 160, H = 90;
type C = [number, number, number];
/** A frame from a function of (x, y). */
const frame = (f: (x: number, y: number) => C): Buffer => { const b = Buffer.alloc(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = f(x, y), i = (y * W + x) * 3; b[i] = c[0]; b[i + 1] = c[1]; b[i + 2] = c[2]; } return b; };
const solid = (c: C) => frame(() => c);
const mix = (a: Buffer, b: Buffer, t: number) => { const o = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.round(a[i]! * (1 - t) + b[i]! * t); return o; };
const RED = solid([200, 40, 40]), BLUE = solid([40, 60, 200]);

describe("checking what the frames at a join show", () => {
  it("accepts a real dissolve and rejects a cut or the wrong picture", () => {
    expect(checkDissolve(mix(RED, BLUE, 0.5), RED, BLUE, W, H).ok).toBe(true);
    expect(checkDissolve(RED, RED, BLUE, W, H).ok).toBe(false); // still the first picture: no blend happened
    expect(checkDissolve(BLUE, RED, BLUE, W, H).ok).toBe(false); // already the next picture
  });
  it("accepts a dip that passes through black and rejects a plain blend", () => {
    expect(checkDipToBlack([mix(RED, solid([0, 0, 0]), 0.5), solid([4, 4, 4]), mix(solid([0, 0, 0]), BLUE, 0.5)], RED, BLUE, W, H).ok).toBe(true);
    expect(checkDipToBlack([mix(RED, BLUE, 0.3), mix(RED, BLUE, 0.5), mix(RED, BLUE, 0.7)], RED, BLUE, W, H).ok).toBe(false);
  });
  it("accepts a wipe with a clear edge and rejects a blend or an untouched picture", () => {
    const wiped = frame((x, y) => (x < W / 2 ? [200, 40, 40] : [40, 60, 200]) as C);
    expect(checkWipe(wiped, RED, BLUE, W, H).ok).toBe(true);
    expect(checkWipe(mix(RED, BLUE, 0.5), RED, BLUE, W, H).ok).toBe(false);
    expect(checkWipe(RED, RED, BLUE, W, H).ok).toBe(false);
  });
  it("chooses the check by the xfade, and treats an unknown learned transition as 'neither picture'", () => {
    expect(checkBlend("fade", [mix(RED, BLUE, 0.5)], RED, BLUE, W, H).ok).toBe(true);
    expect(checkBlend("fadeblack", [solid([0, 0, 0])], RED, BLUE, W, H).ok).toBe(true);
    expect(checkBlend("wipeleft", [frame((x) => (x < 60 ? [200, 40, 40] : [40, 60, 200]) as C)], RED, BLUE, W, H).ok).toBe(true);
    expect(checkBlend("circleopen", [RED], RED, BLUE, W, H).ok).toBe(false);
    expect(checkBlend("circleopen", [mix(RED, BLUE, 0.3)], RED, BLUE, W, H).ok).toBe(true);
  });
  it("two pictures that look alike cannot show a blend, and that is said, not failed", () => {
    const r = checkDissolve(RED, RED, RED, W, H);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/looks the same as a cut/);
  });
});

describe("a match cut is measured, not assumed", () => {
  const bg: C = [10, 30, 40];
  const shape = (cx: number, cy: number, c: C = [130, 216, 112]) => frame((x, y) => (Math.hypot(x - cx, (y - cy) * 1.6) < 22 ? c : bg));
  it("matches the same shape in the same place on the same background", () => {
    const r = checkMatchCut(shape(80, 45), shape(82, 46, [150, 230, 130]), W, H);
    expect(r.ok).toBe(true);
    expect(r.correlation).toBeGreaterThan(0.5);
  });
  it("does not match a shape that has moved across the frame", () => {
    const r = checkMatchCut(shape(30, 45), shape(130, 45), W, H);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/centres are|correlate/);
  });
  it("does not match a different background, or an empty picture", () => {
    expect(checkMatchCut(shape(80, 45), frame((x, y) => (Math.hypot(x - 80, (y - 45) * 1.6) < 22 ? [130, 216, 112] : [240, 240, 235]) as C), W, H).ok).toBe(false);
    const empty = checkMatchCut(shape(80, 45), solid(bg), W, H);
    expect(empty.ok).toBe(false);
    expect(empty.detail).toMatch(/empty/);
  });
});
