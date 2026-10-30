/**
 * Measurements on the real frames at a scene boundary. A transition is only reported as applied when the frames show it: a crossfade is a
 * mix of the two pictures, a dip to black passes through black, a wipe shows part of each picture side by side, and a match cut joins two
 * pictures that really match. Frames are raw RGB (3 bytes a pixel).
 */

export type Rgb = Buffer;
export interface Check { ok: boolean; detail: string }

const GRID_X = 16, GRID_Y = 9;

/** Average colour of each cell of a GRID_X by GRID_Y grid. */
function cells(f: Rgb, w: number, h: number): number[][] {
  const out: number[][] = [];
  for (let gy = 0; gy < GRID_Y; gy++) for (let gx = 0; gx < GRID_X; gx++) {
    const x0 = Math.floor((gx * w) / GRID_X), x1 = Math.floor(((gx + 1) * w) / GRID_X), y0 = Math.floor((gy * h) / GRID_Y), y1 = Math.floor(((gy + 1) * h) / GRID_Y);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const i = (y * w + x) * 3; r += f[i]!; g += f[i + 1]!; b += f[i + 2]!; n++; }
    out.push(n ? [r / n, g / n, b / n] : [0, 0, 0]);
  }
  return out;
}
const lum = (c: number[]) => 0.299 * c[0]! + 0.587 * c[1]! + 0.114 * c[2]!;
const dist = (a: number[], b: number[]) => (Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!)) / 3;
const meanLum = (cs: number[][]) => cs.reduce((a, c) => a + lum(c), 0) / cs.length;

/** Mean absolute difference per channel (0 to 255) between two frames, on the grid. */
export function gridDifference(a: Rgb, b: Rgb, w: number, h: number): number {
  const ca = cells(a, w, h), cb = cells(b, w, h);
  return ca.reduce((s, c, i) => s + dist(c, cb[i]!), 0) / ca.length;
}

/** A dissolve: the middle frame is the average of the two pictures, and is neither of them. */
export function checkDissolve(mid: Rgb, out: Rgb, inn: Rgb, w: number, h: number): Check {
  const m = cells(mid, w, h), a = cells(out, w, h), b = cells(inn, w, h);
  const avg = a.map((c, i) => c.map((v, k) => (v + b[i]![k]!) / 2));
  const apart = a.reduce((s, c, i) => s + dist(c, b[i]!), 0) / a.length;
  if (apart < 6) return { ok: true, detail: `the two pictures differ by only ${apart.toFixed(1)} of 255 here, so a dissolve looks the same as a cut (nothing to tell apart)` };
  const toAvg = m.reduce((s, c, i) => s + dist(c, avg[i]!), 0) / m.length, toA = m.reduce((s, c, i) => s + dist(c, a[i]!), 0) / m.length, toB = m.reduce((s, c, i) => s + dist(c, b[i]!), 0) / m.length;
  const ok = toAvg < Math.min(toA, toB) * 0.6;
  return { ok, detail: `the middle frame is ${toAvg.toFixed(1)} from the average of the two pictures, ${toA.toFixed(1)} from the first and ${toB.toFixed(1)} from the next${ok ? "" : " (a dissolve is closer to the average)"}` };
}

/**
 * A dip to black: somewhere across the join the frame is much darker than both pictures. The blend is sampled at several points, because how long
 * the screen stays black depends on the transition.
 */
export function checkDipToBlack(samples: Rgb[], out: Rgb, inn: Rgb, w: number, h: number): Check {
  const ls = samples.map((s) => meanLum(cells(s, w, h))), darkest = Math.min(...ls), la = meanLum(cells(out, w, h)), lb = meanLum(cells(inn, w, h));
  const base = Math.min(la, lb);
  const ok = base < 8 ? darkest <= base + 2 : darkest <= base * 0.4;
  return { ok, detail: `across the join the darkest of ${samples.length} sampled frames has brightness ${darkest.toFixed(0)}, against ${la.toFixed(0)} for the first picture and ${lb.toFixed(0)} for the next${ok ? "" : " (a dip passes through black)"}` };
}
/** A wipe: part of the frame is still the first picture and part is already the next, with a clear edge between. */
export function checkWipe(mid: Rgb, out: Rgb, inn: Rgb, w: number, h: number): Check {
  const m = cells(mid, w, h), a = cells(out, w, h), b = cells(inn, w, h);
  const tol = 6;
  let fromA = 0, fromB = 0, neither = 0, tell = 0;
  m.forEach((c, i) => {
    const da = dist(c, a[i]!), db = dist(c, b[i]!), ab = dist(a[i]!, b[i]!);
    if (ab < 2 * tol) return; // this cell looks the same in both pictures: it says nothing
    tell++;
    if (da <= tol && db > tol) fromA++; else if (db <= tol && da > tol) fromB++; else neither++;
  });
  if (tell < m.length * 0.15) return { ok: true, detail: `only ${tell} of ${m.length} areas differ between the two pictures, so a wipe looks the same as a cut here (nothing to tell apart)` };
  const shareA = fromA / tell, shareB = fromB / tell, shareN = neither / tell;
  const ok = shareA >= 0.1 && shareB >= 0.1 && shareN <= 0.3;
  return { ok, detail: `${Math.round(shareA * 100)}% of the telling areas still show the first picture, ${Math.round(shareB * 100)}% already show the next, ${Math.round(shareN * 100)}% show neither${ok ? "" : " (a wipe has a clear edge)"}` };
}

/** What the middle frame of a transition must show, by the xfade it was made with. */
export function checkBlend(xfade: string, samples: Rgb[], out: Rgb, inn: Rgb, w: number, h: number): Check {
  const mid = samples[Math.floor(samples.length / 2)]!;
  if (xfade === "fade" || xfade === "dissolve") return checkDissolve(mid, out, inn, w, h);
  if (xfade === "fadeblack") return checkDipToBlack(samples, out, inn, w, h);
  if (/^(wipe|slide|smooth)(left|right|up|down)$/.test(xfade)) return checkWipe(mid, out, inn, w, h);
  // another learned transition: it must at least be neither picture
  const da = gridDifference(mid, out, w, h), db = gridDifference(mid, inn, w, h);
  return { ok: da >= 2.5 && db >= 2.5, detail: `the middle frame is ${da.toFixed(1)} from the first picture and ${db.toFixed(1)} from the next` };
}

export interface MatchResult extends Check { background_difference: number; correlation: number; centroid_shift: number }

/**
 * A match cut joins two pictures that share a shape, a position or a movement. Measured on the last picture of the first scene and the
 * first picture of the next: the same background, and the drawn shapes in the same places in the same amount.
 */
export function checkMatchCut(last: Rgb, first: Rgb, w: number, h: number): MatchResult {
  const a = cells(last, w, h), b = cells(first, w, h);
  const border = (cs: number[][]) => { const idx: number[] = []; for (let i = 0; i < cs.length; i++) { const gx = i % GRID_X, gy = Math.floor(i / GRID_X); if (gx === 0 || gy === 0 || gx === GRID_X - 1 || gy === GRID_Y - 1) idx.push(i); } const pick = (k: number) => idx.map((i) => cs[i]![k]!).sort((x, y) => x - y)[Math.floor(idx.length / 2)]!; return [pick(0), pick(1), pick(2)]; };
  const bgA = border(a), bgB = border(b);
  const bgDiff = dist(bgA, bgB);
  const inkA = a.map((c) => dist(c, bgA)), inkB = b.map((c) => dist(c, bgB));
  const sumA = inkA.reduce((s, v) => s + v, 0), sumB = inkB.reduce((s, v) => s + v, 0);
  const none = (detail: string): MatchResult => ({ ok: false, detail, background_difference: bgDiff, correlation: 0, centroid_shift: 1 });
  if (sumA < 4 || sumB < 4) return none(`${sumA < 4 ? "the last picture of the scene" : "the first picture of the next scene"} is empty, so there is no shape to match`);
  const meanA = sumA / a.length, meanB = sumB / b.length;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) { cov += (inkA[i]! - meanA) * (inkB[i]! - meanB); va += (inkA[i]! - meanA) ** 2; vb += (inkB[i]! - meanB) ** 2; }
  const corr = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
  const centroid = (ink: number[], sum: number) => { let cx = 0, cy = 0; ink.forEach((v, i) => { cx += (v * ((i % GRID_X) + 0.5)) / GRID_X; cy += (v * (Math.floor(i / GRID_X) + 0.5)) / GRID_Y; }); return [cx / sum, cy / sum]; };
  const ca = centroid(inkA, sumA), cb = centroid(inkB, sumB);
  const shift = Math.hypot(ca[0]! - cb[0]!, (ca[1]! - cb[1]!) * (h / w));
  const ok = bgDiff <= 16 && corr >= 0.5 && shift <= 0.12;
  return { ok, background_difference: bgDiff, correlation: corr, centroid_shift: shift, detail: `background differs by ${bgDiff.toFixed(1)} of 255 (at most 16), the drawn shapes correlate at ${corr.toFixed(2)} (at least 0.50) and their centres are ${(shift * 100).toFixed(0)}% of the frame width apart (at most 12%)` };
}
