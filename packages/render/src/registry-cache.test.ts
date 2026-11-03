import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { directoryStamp, KeyedCache } from "./registry-cache.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "stamp-")); dirs.push(d); return d; };

describe("directoryStamp", () => {
  it("is 'none' for no folder, a missing folder or an empty one", () => {
    expect(directoryStamp(null)).toBe("none");
    expect(directoryStamp(join(tmp(), "missing"))).toBe("none");
    expect(directoryStamp(tmp())).toBe("none");
  });
  it("changes when a record is added, rewritten (mtime or size) or removed, and not otherwise", () => {
    const d = tmp(); mkdirSync(join(d, "visual"));
    const a = join(d, "a.json"), b = join(d, "visual", "b.json");
    writeFileSync(a, "{}");
    const s1 = directoryStamp(d);
    expect(directoryStamp(d)).toBe(s1);
    writeFileSync(b, "{}");
    const s2 = directoryStamp(d); expect(s2).not.toBe(s1);
    utimesSync(a, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const s3 = directoryStamp(d); expect(s3).not.toBe(s2);
    writeFileSync(a, '{"x":1}'); utimesSync(a, new Date(2020, 0, 1), new Date(2020, 0, 1));
    expect(directoryStamp(d)).not.toBe(s3);
    rmSync(b);
    expect(directoryStamp(d)).not.toBe(s3);
  });
  it("ignores non-JSON files", () => {
    const d = tmp(); writeFileSync(join(d, "a.json"), "{}");
    const s = directoryStamp(d); writeFileSync(join(d, "notes.txt"), "x");
    expect(directoryStamp(d)).toBe(s);
  });
});

describe("KeyedCache", () => {
  it("reuses the value while the key is unchanged and rebuilds when it changes", () => {
    const c = new KeyedCache<number>(1000, () => 0);
    let n = 0;
    const build = () => ++n;
    expect(c.get("k", build)).toBe(1); expect(c.get("k", build)).toBe(1);
    expect(c.get("k2", build)).toBe(2);
    expect(c).toMatchObject({ hits: 1, builds: 2 });
  });
  it("rebuilds after the time limit, and after clear()", () => {
    let t = 0; const c = new KeyedCache<number>(1000, () => t);
    let n = 0; const build = () => ++n;
    c.get("k", build); t = 999; expect(c.get("k", build)).toBe(1);
    t = 1000; expect(c.get("k", build)).toBe(2);
    c.clear(); expect(c.get("k", build)).toBe(3);
  });
});
