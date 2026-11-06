import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = join(fileURLToPath(new URL("../../../", import.meta.url)), "evals", "heldout");
const sha = (f: string) => createHash("sha256").update(readFileSync(join(dir, f))).digest("hex");

describe("held-out retrieval set", () => {
  it("has 100 draft queries in the four kinds", () => {
    const q = (JSON.parse(readFileSync(join(dir, "queries.json"), "utf8")) as { queries: string[][] }).queries;
    expect(q.length).toBe(100);
    expect(new Set(q.map((x) => x[0])).size).toBe(100);
    const kinds = (k: string) => q.filter((x) => x[4] === k).length;
    expect([kinds("brief"), kinds("scene"), kinds("paraphrase"), kinds("off_topic")]).toEqual([40, 30, 20, 10]);
  });
  it("once locked, queries.json and labels.json never change", () => {
    if (!existsSync(join(dir, "LOCK.json"))) return; // not locked yet: the labels are still to be graded by a person
    const lock = JSON.parse(readFileSync(join(dir, "LOCK.json"), "utf8")) as { queries_sha256: string; labels_sha256: string };
    expect(sha("queries.json")).toBe(lock.queries_sha256);
    expect(sha("labels.json")).toBe(lock.labels_sha256);
  });
});
