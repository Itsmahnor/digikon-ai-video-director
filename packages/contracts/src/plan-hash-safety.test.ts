import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ScenePlan, Treatment, storyboardHash } from "./index.js";

/**
 * Hash safety. An approval is bound to the hash of the exact plan the reviewer saw. If the schema ever changes how an old plan parses (a new field with a default, a renamed key,
 * a re-ordered output), its canonical JSON changes, its hash changes, and every stored approval of it stops matching. So every plan saved from a real run must still re-parse
 * and re-hash to the value its approval recorded. This test stays green through every schema change; if it goes red, the change is not safe.
 */
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const read = (p: string) => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
const golden = read(join(root, "tests", "fixtures", "plan-hashes.json")) as { storyboard: Record<string, { session: string; plan_hash: string }> };

describe("approved plans keep their hash through schema changes", () => {
  for (const [folder, { plan_hash }] of Object.entries(golden.storyboard)) {
    it(`baseline/${folder}: the saved treatment and storyboard re-parse and re-hash to the hash its Gate 1 approval recorded`, () => {
      const treatment = read(join(root, "baseline", folder, "treatment.json"));
      const scenes = read(join(root, "baseline", folder, "storyboard.json"));
      expect(storyboardHash(Treatment.parse(treatment), ScenePlan.parse(scenes))).toBe(plan_hash);
    });
  }

  it("covers at least three saved plans", () => {
    expect(Object.keys(golden.storyboard).length).toBeGreaterThanOrEqual(3);
  });

  it("parsing a saved plan twice gives the same JSON (parse is idempotent, so a stored plan is a fixed point)", () => {
    for (const folder of Object.keys(golden.storyboard)) {
      const once = ScenePlan.parse(read(join(root, "baseline", folder, "storyboard.json")));
      expect(JSON.stringify(ScenePlan.parse(once))).toBe(JSON.stringify(once));
    }
  });

  // Plans from this machine's own runs, when they are there. storage/ is not in git, so on another machine this finds nothing and passes on the fixtures above.
  // Only approvals made from the baseline date on are checked: older sessions were written by older code, and 26 of them already do not re-hash (they are not this change's doing).
  const SINCE = "2026-11-17T00:00:00Z";
  it("every Gate 1 approval since the baseline in storage/sessions whose checkpoint still holds that storyboard version re-hashes to its recorded hash", () => {
    const sessions = join(root, "storage", "sessions");
    if (!existsSync(sessions)) return;
    let checked = 0;
    const mismatches: string[] = [];
    for (const sid of readdirSync(sessions)) {
      const runsDir = join(sessions, sid, "runs");
      if (!existsSync(runsDir)) continue;
      for (const run of readdirSync(runsDir)) {
        const apDir = join(runsDir, run, "approvals"), ck = join(runsDir, run, "checkpoint.json");
        if (!existsSync(apDir) || !existsSync(ck)) continue;
        const state = read(ck).state ?? {};
        const plan = ScenePlan.safeParse(state.scenePlan), treatment = Treatment.safeParse(state.treatmentDoc);
        if (!plan.success || !treatment.success) continue; // written by an older schema: not this test's business
        for (const f of readdirSync(apDir)) {
          const rec = read(join(apDir, f)).record;
          if (rec?.stage !== "storyboard" || rec.decision !== "approved" || rec.plan_version !== plan.data.version || String(rec.decided_at ?? "") < SINCE) continue;
          checked++;
          if (storyboardHash(treatment.data, plan.data) !== rec.plan_hash) mismatches.push(`${sid}/${run}/${f}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    void checked;
  });
});
