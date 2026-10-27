import { readdirSync } from "node:fs";
import { expect, it } from "vitest";

/** How many recipe files are on disk. Tests compare the loaded library with this instead of a number that must change with every new recipe. */
export const recipeFileCount = (dir: string): number => readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".json")).length;

/**
 * Real-render tests need a font, ffmpeg and (for Remotion and HyperFrames) a browser that is already installed. On a developer's machine
 * without them the tests may be skipped. In CI, and anywhere RENDER_TESTS_REQUIRE_REAL=1, a missing prerequisite is a failure, never a
 * skip. RENDER_TESTS_ALLOW_SKIP=1 turns the skip back on for a local environment that is configured that way on purpose.
 */
export const STRICT = (process.env["CI"] === "true" || process.env["CI"] === "1" || process.env["RENDER_TESTS_REQUIRE_REAL"] === "1") && process.env["RENDER_TESTS_ALLOW_SKIP"] !== "1";

/** For `describe.skipIf(...)`: skip only when the prerequisite is missing and strict mode is off. */
export const skipReal = (available: boolean): boolean => !available && !STRICT;

/** Registers one test that names what is missing. Strict mode fails it; otherwise it only warns, so a silent skip is never invisible. */
export function realPrerequisites(needs: Record<string, boolean>): void {
  const missing = Object.entries(needs).filter(([, ok]) => !ok).map(([name]) => name);
  it("has what the real-render tests need", () => {
    if (missing.length && !STRICT) console.warn(`real-render tests are being skipped: missing ${missing.join(", ")} (set CI=1 or RENDER_TESTS_REQUIRE_REAL=1 to make this a failure)`);
    expect(STRICT ? missing : [], `strict mode: real-render prerequisites are missing (${missing.join(", ")})`).toEqual([]);
  });
}
