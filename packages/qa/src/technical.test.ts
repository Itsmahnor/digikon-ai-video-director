import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QAFinding } from "@digikon/contracts";
import { ownerFor, runTechnicalChecks, ticketsFromFindings, type QaExpectation } from "./index.js";

let dir: string;
const f = (n: string) => join(dir, n);
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "ignore" });
const tone = (d: number) => ["-f", "lavfi", "-t", String(d), "-i", "sine=frequency=440:sample_rate=44100"];

const base: QaExpectation = { duration_s: 6, width: 320, height: 240, fps: 25, expect_audio: true };
const scenes = [{ scene_id: "S01", start: 0, end: 2.5 }, { scene_id: "S02", start: 2.5, end: 6.5 }, { scene_id: "S03", start: 6.5, end: 8.5 }];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "qa-test-"));
  ff("-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=6", ...tone(6), "-shortest", "-pix_fmt", "yuv420p", f("clean.mp4"));
  ff("-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=2.5", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=25:d=1.5",
    "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=2.5", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=25:d=2",
    ...tone(3), "-f", "lavfi", "-t", "2", "-i", "anullsrc=r=44100:cl=mono", ...tone(3.5),
    "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v];[4:a][5:a][6:a]concat=n=3:v=0:a=1[a]",
    "-map", "[v]", "-map", "[a]", "-pix_fmt", "yuv420p", "-t", "8.5", f("defects.mp4"));
  ff("-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=6", "-pix_fmt", "yuv420p", f("noaudio.mp4"));
  ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=4", ...tone(4), "-shortest", "-pix_fmt", "yuv420p", f("wrong.mp4"));
  ff("-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=4", "-f", "lavfi", "-t", "4", "-i", "anullsrc=r=44100:cl=mono", "-shortest", "-pix_fmt", "yuv420p", f("mute.mp4"));
  writeFileSync(f("broken.mp4"), "not a video");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a clean video", () => {
  it("passes every check and records the evidence for each pass", async () => {
    const r = await runTechnicalChecks(f("clean.mp4"), base);
    expect(r.findings).toEqual([]);
    expect(r.passed.map((p) => p.check)).toEqual(expect.arrayContaining(["duration", "resolution", "frame_rate", "audio_track", "black_frames", "frozen_frames", "silence", "true_peak"]));
    for (const p of r.passed) expect(p.evidence).toMatch(/^probe:/); // a pass is only recorded with a measurement
    expect(r.measurements["loudness_lufs"]).toBeLessThan(0);
  }, 60_000);

  it("checks loudness only when a target is supplied, and reports a miss", async () => {
    const clean = await runTechnicalChecks(f("clean.mp4"), base);
    expect(clean.passed.map((p) => p.check)).not.toContain("loudness"); // no verified target: measured, not judged
    const measured = clean.measurements["loudness_lufs"] as number;
    expect((await runTechnicalChecks(f("clean.mp4"), { ...base, loudness_target_lufs: measured })).passed.map((p) => p.check)).toContain("loudness");
    const off = await runTechnicalChecks(f("clean.mp4"), { ...base, loudness_target_lufs: measured + 8, loudness_tolerance_lu: 2 });
    expect(off.findings).toMatchObject([{ category: "audio", severity: "major", evidence_ref: expect.stringContaining("ebur128") }]);
  }, 60_000);

  it("flags a true peak above the ceiling", async () => {
    const r = await runTechnicalChecks(f("clean.mp4"), { ...base, max_true_peak_db: -40 });
    expect(r.findings.map((x) => x.evidence_ref)).toEqual([expect.stringMatching(/^probe:truepeak=/)]);
  }, 60_000);
});

describe("seeded defects are found, with evidence and the right scene", () => {
  const exp: QaExpectation = { ...base, duration_s: 8.5, scenes };

  it("finds black, frozen and silent stretches", async () => {
    const r = await runTechnicalChecks(f("defects.mp4"), exp);
    const by = (prefix: string) => r.findings.filter((x) => x.evidence_ref.startsWith(prefix));
    const black = by("probe:blackdetect")[0]!;
    expect(black).toMatchObject({ category: "technical", scene_id: "S02", severity: "critical" }); // 1.5s of black
    expect(black.evidence_ref).toMatch(/@2\.\d+-4\.\d+$/);
    expect(by("probe:freezedetect").some((x) => x.scene_id === "S03")).toBe(true);
    const silence = by("probe:silencedetect")[0]!;
    expect(silence).toMatchObject({ category: "audio", scene_id: "S02" });
    for (const x of r.findings) { expect(x.evidence_ref).toMatch(/^probe:/); expect(x.description.length).toBeGreaterThan(10); }
  }, 60_000);

  it("ignores black and still stretches the plan asked for", async () => {
    const r = await runTechnicalChecks(f("defects.mp4"), { ...exp, allowed_black: [{ start: 2.5, end: 4 }], allowed_freeze: [{ start: 2.5, end: 4 }, { start: 6.5, end: 8.5 }] });
    expect(r.findings.filter((x) => /blackdetect|freezedetect/.test(x.evidence_ref))).toEqual([]);
    expect(r.passed.map((p) => p.check)).toEqual(expect.arrayContaining(["black_frames", "frozen_frames"]));
    expect(r.findings.some((x) => x.evidence_ref.startsWith("probe:silencedetect"))).toBe(true); // silence was not allowed
  }, 60_000);

  it("turns findings into tickets with the right owner and scope", async () => {
    const r = await runTechnicalChecks(f("defects.mp4"), exp);
    const tickets = ticketsFromFindings(r.findings, ["S01", "S02", "S03"]);
    expect(tickets.length).toBe(r.findings.length);
    const blackT = tickets.find((t) => r.findings.find((x) => x.finding_id === t.finding_id)!.evidence_ref.startsWith("probe:blackdetect"))!;
    expect(blackT).toMatchObject({ owner_skill: "editing-director", scene_ids: ["S02"], attempt: 1, status: "open" });
    const silenceT = tickets.find((t) => r.findings.find((x) => x.finding_id === t.finding_id)!.evidence_ref.startsWith("probe:silencedetect"))!;
    expect(silenceT.owner_skill).toBe("sound-design");
  }, 60_000);
});

describe("whole-film problems", () => {
  it("flags wrong duration, size and frame rate", async () => {
    const r = await runTechnicalChecks(f("wrong.mp4"), base);
    const ev = r.findings.map((x) => x.evidence_ref);
    expect(ev).toEqual(expect.arrayContaining([expect.stringMatching(/^probe:duration=/), "probe:size=640x360", "probe:fps=30"]));
    expect(r.findings.find((x) => x.evidence_ref.startsWith("probe:duration"))!.scene_id).toBeNull();
  }, 60_000);

  it("flags a missing audio track as critical and a silent one as critical", async () => {
    const none = await runTechnicalChecks(f("noaudio.mp4"), base);
    expect(none.findings).toContainEqual(expect.objectContaining({ evidence_ref: "probe:audio_tracks=0", severity: "critical", category: "audio" }));
    const mute = await runTechnicalChecks(f("mute.mp4"), { ...base, duration_s: 4 });
    expect(mute.findings.some((x) => x.severity === "critical" && x.category === "audio")).toBe(true);
  }, 60_000);

  it("reports an unplayable file as one critical finding", async () => {
    const r = await runTechnicalChecks(f("broken.mp4"), base);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ severity: "critical", evidence_ref: "probe:unreadable" });
    expect(r.passed).toEqual([]);
  });
});

describe("tickets", () => {
  const finding = (over: Partial<QAFinding>) => QAFinding.parse({ finding_id: "F01", scene_id: null, severity: "major", category: "audio", evidence_ref: "probe:x", description: "d", ...over });
  it("names every scene for a whole-film finding and skips info and closed findings", () => {
    const t = ticketsFromFindings([finding({}), finding({ finding_id: "F02", severity: "info" }), finding({ finding_id: "F03", status: "fixed" })], ["S01", "S02"]);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ scene_ids: ["S01", "S02"], owner_skill: "sound-design", instruction: "d" });
  });
  it("routes each category to its owner and carries the attempt number", () => {
    const owner = (category: QAFinding["category"]) => ownerFor(finding({ category }));
    expect([owner("audio"), owner("product_fidelity"), owner("brand"), owner("pacing"), owner("visual"), owner("technical")]).toEqual(
      ["sound-design", "cinematography", "commercial-strategy", "editing-director", "motion-graphics", "editing-director"]);
    expect(ticketsFromFindings([finding({ scene_id: "S01" })], ["S01"], 2)[0]!.attempt).toBe(2);
  });
});
