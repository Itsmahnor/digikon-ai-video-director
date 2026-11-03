import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readNormalized } from "./fingerprint.js";

describe("readNormalized", () => {
  it("gives the same bytes for LF, CRLF and a stray CR, and leaves other bytes alone", () => {
    const d = mkdtempSync(join(tmpdir(), "fp-"));
    try {
      const w = (n: string, s: string) => { const p = join(d, n); writeFileSync(p, s, "latin1"); return p; };
      const lf = readNormalized(w("a", "one\ntwo\n"));
      expect(readNormalized(w("b", "one\r\ntwo\r\n")).equals(lf)).toBe(true);
      expect(readNormalized(w("c", "one\ntwo\r\n")).equals(lf)).toBe(true);
      expect(readNormalized(w("d", "one\ntwo\n\r")).equals(lf)).toBe(true);
      expect(readNormalized(w("e", "one\ntwo!\n")).equals(lf)).toBe(false);
      expect(readNormalized(w("f", "caf\xe9\n")).toString("latin1")).toBe("caf\xe9\n");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
