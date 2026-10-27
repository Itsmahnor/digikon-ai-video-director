import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Transcript } from "@digikon/contracts";
import { DemoClient, RunStore, SkillLibrary } from "@digikon/director";
import { KeywordRetriever, loadKnowledge, recipeDocs } from "@digikon/rag";
import { RecipeLibrary, loadRecipes } from "@digikon/recipes";
import type { SpeechEngine } from "@digikon/speech";
import { createApp, type AppContext } from "./app.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const recipes = loadRecipes(join(repo, "recipes"));
let dir: string;
let fixtures: string;

const speech: SpeechEngine = {
  model: "stub",
  transcribe: async () => Transcript.parse({
    text: "Ø§ÛŒÚ© Ø§Ø´ØªÛØ§Ø± Ø¨Ù†Ø§Ø¦ÛŒÚº", language: "ur", language_confidence: 0.97, model: "stub", duration_s: 3,
    words: [{ text: " Ø§ÛŒÚ©", start: 0, end: 0.5 }], segments: [{ text: "Ø§ÛŒÚ© Ø§Ø´ØªÛØ§Ø± Ø¨Ù†Ø§Ø¦ÛŒÚº", start: 0, end: 3 }],
  }),
};
const llm = Object.assign(new DemoClient(), {});
const build = (over: Partial<AppContext> = {}) => createApp({
  llm, demo: true, speech, whisper: () => ({ state: "ready" }), skills: new SkillLibrary(join(repo, "skills")),
  retriever: new KeywordRetriever([...recipeDocs(recipes), ...loadKnowledge(join(repo, "knowledge"))]),
  recipes: new RecipeLibrary(recipes, "draft"), ffmpegOk: true, storageDir: dir, publicDir: join(repo, "apps/console/public"), ...over,
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "console-test-"));
  fixtures = mkdtempSync(join(tmpdir(), "console-fx-"));
  const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "ignore" });
  ff("-f", "lavfi", "-i", "testsrc2=s=360x640:d=30:r=30", "-f", "lavfi", "-i", "sine=frequency=440:d=30", "-shortest", "-pix_fmt", "yuv420p", join(fixtures, "reel.mp4"));
  ff("-f", "lavfi", "-i", "sine=frequency=300:d=3", join(fixtures, "tone.wav"));
  // picture: moving 0-2.5s, black 2.5-4s, moving 4-6.5s, frozen 6.5-8.5s. sound: tone, then 2s of silence, then tone.
  const tone = (d: number) => ["-f", "lavfi", "-t", String(d), "-i", "sine=frequency=440:sample_rate=44100"];
  ff("-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=2.5", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=25:d=1.5", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=2.5", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=25:d=2",
    ...tone(3), "-f", "lavfi", "-t", "2", "-i", "anullsrc=r=44100:cl=mono", ...tone(3.5),
    "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v];[4:a][5:a][6:a]concat=n=3:v=0:a=1[a]", "-map", "[v]", "-map", "[a]", "-pix_fmt", "yuv420p", "-t", "8.5", join(fixtures, "defects.mp4"));
  ff("-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "2", join(fixtures, "silence.wav"));
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); rmSync(fixtures, { recursive: true, force: true }); });

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const file = (name: string, field = "files") => { const fd = new FormData(); fd.append(field, new File([readFileSync(join(fixtures, name))], name)); return { method: "POST", body: fd }; };
const newSession = async (app: ReturnType<typeof build>) => ((await (await app.request("/api/sessions", { method: "POST" })).json()) as { id: string }).id;

async function readSse(res: Response) {
  const events: { event: string; data: any }[] = [];
  for (const block of (await res.text()).split("\n\n")) {
    const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
  }
  return events;
}

describe("status and sessions", () => {
  it("reports model, speech, ffmpeg and recipe status", async () => {
    const h = (await (await build().request("/api/health")).json()) as any;
    expect(h).toMatchObject({ llm: { available: true, demo: true }, whisper: { state: "ready" }, ffmpeg: true, recipes: { available: recipes.length, mode: "draft" } });
  });
  it("answers 404 for unknown or malformed session ids", async () => {
    const app = build();
    expect((await app.request("/api/sessions/nope")).status).toBe(404);
    expect((await app.request("/api/sessions/..%2f..%2fetc")).status).toBe(404);
    expect((await app.request("/api/sessions/aaaaaaaaaaaa")).status).toBe(404);
  });
});

describe("uploads", () => {
  it("accepts real media, rejects fakes with reasons, and serves files with range support", async () => {
    const app = build(); const id = await newSession(app);
    const ok = (await (await app.request(`/api/sessions/${id}/assets`, file("reel.mp4"))).json()) as any;
    expect(ok.added[0]).toMatchObject({ media_type: "video", audio_tracks: 1, width: 360, height: 640 });
    const fd = new FormData();
    fd.append("files", new File(["not a video"], "fake.mp4")); fd.append("files", new File(["x"], "notes.txt"));
    const bad = (await (await app.request(`/api/sessions/${id}/assets`, { method: "POST", body: fd })).json()) as any;
    expect(bad.added).toHaveLength(0);
    expect(bad.rejected.map((r: any) => r.issues[0].code).sort()).toEqual(["unreadable", "unsupported_type"]);

    const assetId = ok.added[0].asset_id;
    const part = await app.request(`/api/sessions/${id}/files/${assetId}`, { headers: { range: "bytes=0-99" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toMatch(/^bytes 0-99\//);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    expect((await app.request(`/api/sessions/${id}/files/${assetId}`, { headers: { range: "bytes=999999999-" } })).status).toBe(416);
  });
  it("refuses path-like asset ids and empty uploads", async () => {
    const app = build(); const id = await newSession(app);
    expect((await app.request(`/api/sessions/${id}/files/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await app.request(`/api/sessions/${id}/assets/asset_../transcribe`, { method: "POST" })).status).toBe(404);
    const empty = await app.request(`/api/sessions/${id}/assets`, { method: "POST", body: new FormData() });
    expect(empty.status).toBe(400);
  });
  it("removes an asset", async () => {
    const app = build(); const id = await newSession(app);
    const a = ((await (await app.request(`/api/sessions/${id}/assets`, file("reel.mp4"))).json()) as any).added[0].asset_id;
    const res = (await (await app.request(`/api/sessions/${id}/assets/${a}`, { method: "DELETE" })).json()) as any;
    expect(res.assets).toEqual([]);
  });
});

describe("speech", () => {
  it("transcribes a recording and names the language", async () => {
    const app = build(); const id = await newSession(app);
    const t = (await (await app.request(`/api/sessions/${id}/transcribe`, file("tone.wav", "audio"))).json()) as any;
    expect(t).toMatchObject({ language: "ur", language_name: "Urdu" });
  });
  it("rejects silence with a clear message", async () => {
    const app = build(); const id = await newSession(app);
    const res = await app.request(`/api/sessions/${id}/transcribe`, file("silence.wav", "audio"));
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error).toBe("no_speech");
  });
});

describe("routing and the Director run", () => {
  it("A: no assets, asks for the platform, then plans after the reply", async () => {
    const app = build(); const id = await newSession(app);
    const first = (await (await app.request(`/api/sessions/${id}/route`, json({ text: "Make a short ad for my coffee roaster." }))).json()) as any;
    expect(first.result.status).toBe("needs_input");
    expect(first.turns.map((t: any) => t.role)).toEqual(["user", "assistant"]);
    const second = (await (await app.request(`/api/sessions/${id}/route`, json({ text: "Instagram Reels, 12 seconds" }))).json()) as any;
    expect(second.result.status).toBe("ready");
    expect(second.result.request).toMatchObject({ mode: "create_minimal", project: { aspect_ratio: "9:16", target_duration: 12 } });
  });

  /** Routes and builds the plan up to the storyboard gate; returns the app, session id and the gate-1 state. */
  async function atGate1() {
    const app = build(); const id = await newSession(app);
    await app.request(`/api/sessions/${id}/route`, json({ text: "A 12 second Instagram ad for my coffee roaster." }));
    const res = await app.request(`/api/sessions/${id}/direct`, json({ facts: ["Beans are roasted weekly.", "Ships within two days."] }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(res);
    return { app, id, events, state: events.find((e) => e.event === "state")!.data };
  }
  const decide = (app: ReturnType<typeof build>, id: string, body: Record<string, unknown>) => app.request(`/api/sessions/${id}/approve`, json(body));
  const decided = async (res: Response) => (await res.json()) as any;

  it("streams the run up to the storyboard gate and stops there, with no edit plan", async () => {
    const { events, state } = await atGate1();
    expect(events.filter((e) => e.event === "step").map((e) => e.data.node)).toEqual(["intake", "analyse_assets", "treatment", "storyboard"]);
    expect(state).toMatchObject({ status: "awaiting_approval", gate: "storyboard", editPlan: null, versions: { storyboard: 1, edit_plan: null } });
    expect(state.hashes.storyboard).toMatch(/^[a-f0-9]{64}$/);
    expect(state.scenePlan.scenes.reduce((a: number, s: any) => a + s.duration_seconds, 0)).toBeCloseTo(12, 1);
    expect(state.treatment.claims.find((c: any) => c.claim_id === "C09").brand_fact_id).toBeNull(); // unsupported claim is kept visible, not used
    expect(state.scenePlan.scenes.flatMap((s: any) => s.claim_ids)).not.toContain("C09");
    expect(state.renderable.ok).toBe(false);
    expect(state.revisions).toEqual({ used: { storyboard: 0, edit_plan: 0 }, max: 2 });
  });

  it("walks both gates, records each decision, and stays non-renderable until both match", async () => {
    const { app, id } = await atGate1();
    const g2 = await decided(await decide(app, id, { stage: "storyboard", plan_version: 1, decision: "approved", notes: "good" }));
    expect(g2.state).toMatchObject({ status: "awaiting_approval", gate: "edit_plan", versions: { storyboard: 1, edit_plan: 1 } });
    expect(g2.state.editPlan.uses.length).toBeGreaterThan(2);
    expect(g2.state.approvals).toHaveLength(1);
    expect(g2.state.renderable.ok).toBe(false);
    expect(g2.state.renderable.reasons).toEqual(["the edit plan has not been approved"]);

    const done = await decided(await decide(app, id, { stage: "edit_plan", plan_version: 1, storyboard_version: 1, decision: "approved" }));
    expect(done.state.status).toBe("approved");
    expect(done.state.approvals.map((a: any) => [a.stage, a.plan_version, a.decision])).toEqual([["storyboard", 1, "approved"], ["edit_plan", 1, "approved"]]);
    expect(done.state.renderable).toEqual({ ok: true, reasons: [] });
    expect(done.record).toMatchObject({ status: "approved", recipe_library_mode: "draft" });
    expect(done.record.approvals).toHaveLength(2);
    expect(done.record.plans.storyboard.hash).toBe(done.state.hashes.storyboard);
    expect(done.record.skills.length).toBeGreaterThan(4);
    expect((await decide(app, id, { stage: "edit_plan", plan_version: 1, decision: "approved" })).status).toBe(409); // cannot approve twice
  });

  it("serves the Editor handoff only after both approvals, and 409 with reasons before", async () => {
    const { app, id } = await atGate1();
    const early = await app.request(`/api/sessions/${id}/handoff`);
    expect(early.status).toBe(409);
    const body = await decided(early);
    expect(body.error).toBe("handoff_refused");
    expect(body.reasons).toContain("the storyboard has not been approved");

    await decide(app, id, { stage: "storyboard", plan_version: 1, decision: "approved" });
    expect((await app.request(`/api/sessions/${id}/handoff`)).status).toBe(409); // edit plan not approved yet
    await decide(app, id, { stage: "edit_plan", plan_version: 1, decision: "approved" });
    const res = await app.request(`/api/sessions/${id}/handoff`);
    expect(res.status).toBe(200);
    const h = await decided(res);
    expect(h).toMatchObject({ schema_version: "1.3.0", run: { model: "demo", recipe_library_mode: "draft" }, approved: { storyboard: { version: 1 }, edit_plan: { version: 1 } } });
    expect(h.handoff_id).toBe(`ho_${h.content_hash.slice(0, 16)}`);
    expect(h.claims.map((c: any) => c.claim.claim_id)).not.toContain("C09"); // the unsupported claim stays out
    expect((await app.request(`/api/sessions/nosuchsession/handoff`)).status).toBe(404);
  });

  it("requires the stage and plan version, and answers 409 for a stale stage or version without changing anything", async () => {
    const { app, id } = await atGate1();
    expect((await decide(app, id, { decision: "approved" })).status).toBe(400); // the old body shape is not enough
    expect((await decide(app, id, { stage: "storyboard", decision: "approved" })).status).toBe(400); // no version
    expect((await decide(app, id, { stage: "storyboard", plan_version: 1, decision: "revision_requested" })).status).toBe(400); // no notes

    const wrongStage = await decide(app, id, { stage: "edit_plan", plan_version: 1, decision: "approved" });
    expect(wrongStage.status).toBe(409);
    expect((await decided(wrongStage)).error).toBe("stale_stage");
    const wrongVersion = await decide(app, id, { stage: "storyboard", plan_version: 5, decision: "approved" });
    expect(wrongVersion.status).toBe(409);
    expect((await decided(wrongVersion)).error).toBe("stale_version");

    // Still at gate 1 with nothing recorded: the correct decision works.
    const ok = await decided(await decide(app, id, { stage: "storyboard", plan_version: 1, decision: "approved" }));
    expect(ok.state.gate).toBe("edit_plan");
    expect(ok.state.approvals).toHaveLength(1);

    // The gate-1 screen is now stale.
    expect((await decide(app, id, { stage: "storyboard", plan_version: 1, decision: "approved" })).status).toBe(409);
    // A gate-2 decision that assumes another storyboard version is stale too.
    const wrongSb = await decide(app, id, { stage: "edit_plan", plan_version: 1, storyboard_version: 9, decision: "approved" });
    expect(wrongSb.status).toBe(409);
    expect((await decided(wrongSb)).error).toBe("stale_storyboard");
  });

  it("turns change notes into the next version at the same gate, and refuses the old version afterwards", async () => {
    const { app, id } = await atGate1();
    const rev = await decided(await decide(app, id, { stage: "storyboard", plan_version: 1, decision: "revision_requested", notes: "Shorter opening" }));
    expect(rev.state).toMatchObject({ status: "awaiting_approval", gate: "storyboard", editPlan: null, versions: { storyboard: 2 }, revisions: { used: { storyboard: 1 } } });
    expect(rev.state.approvals[0]).toMatchObject({ plan_version: 1, decision: "revision_requested", notes: "Shorter opening" });
    expect((await decide(app, id, { stage: "storyboard", plan_version: 1, decision: "approved" })).status).toBe(409); // the old screen
    const g2 = await decided(await decide(app, id, { stage: "storyboard", plan_version: 2, decision: "approved" }));
    expect(g2.state).toMatchObject({ gate: "edit_plan", versions: { storyboard: 2, edit_plan: 1 } });

    const rev2 = await decided(await decide(app, id, { stage: "edit_plan", plan_version: 1, decision: "revision_requested", notes: "Calmer edits" }));
    expect(rev2.state).toMatchObject({ gate: "edit_plan", versions: { storyboard: 2, edit_plan: 2 } });
    const done = await decided(await decide(app, id, { stage: "edit_plan", plan_version: 2, decision: "approved" }));
    expect(done.state.status).toBe("approved");
    expect(done.state.renderable.ok).toBe(true);
  });

  it("escalates after the revision limit instead of looping", async () => {
    const { app, id } = await atGate1();
    for (const v of [1, 2]) await decide(app, id, { stage: "storyboard", plan_version: v, decision: "revision_requested", notes: `change ${v}` });
    const last = await decided(await decide(app, id, { stage: "storyboard", plan_version: 3, decision: "revision_requested", notes: "still wrong" }));
    expect(last.state.status).toBe("escalated");
    expect(last.state.escalation.what_failed).toContain("2 revisions");
    expect(last.state.gate).toBeNull();
    expect((await decide(app, id, { stage: "storyboard", plan_version: 3, decision: "approved" })).status).toBe(409); // nothing is waiting any more
  });

  it("B: builds around a real uploaded clip", async () => {
    const app = build(); const id = await newSession(app);
    await app.request(`/api/sessions/${id}/assets`, file("reel.mp4"));
    await app.request(`/api/sessions/${id}/route`, json({ text: "Make an ad from my footage for TikTok, 15 seconds. Goal: more orders." }));
    const events = await readSse(await app.request(`/api/sessions/${id}/direct`, json({})));
    const state = events.find((e) => e.event === "state")!.data;
    expect(state.status).toBe("awaiting_approval");
    expect(state.scenePlan.scenes[0].asset_ids).toHaveLength(1);
  }, 30_000); // measuring the upload is real ffmpeg work, which can pass 5s when the whole suite runs in parallel

  it("checks the uploaded files on disk before handing off, and refuses when one has gone", async () => {
    const app = build(); const id = await newSession(app);
    await app.request(`/api/sessions/${id}/assets`, file("reel.mp4"));
    await app.request(`/api/sessions/${id}/route`, json({ text: "Make an ad from my footage for TikTok, 15 seconds. Goal: more orders." }));
    const state = (await readSse(await app.request(`/api/sessions/${id}/direct`, json({})))).find((e) => e.event === "state")!.data;
    const g2 = (await (await app.request(`/api/sessions/${id}/approve`, json({ stage: "storyboard", plan_version: state.versions.storyboard, decision: "approved" }))).json()) as any;
    await app.request(`/api/sessions/${id}/approve`, json({ stage: "edit_plan", plan_version: g2.state.versions.edit_plan, decision: "approved" }));
    const ok = await app.request(`/api/sessions/${id}/handoff`);
    expect(ok.status).toBe(200);
    const h = (await ok.json()) as any;
    expect(h.approvals.storyboard.evidence_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(h.assets[0].metadata.bytes).toBeGreaterThan(0);

    rmSync(h.assets[0].uri); // the file disappears after approval
    const gone = await app.request(`/api/sessions/${id}/handoff`);
    expect(gone.status).toBe(409);
    expect(((await gone.json()) as any).reasons).toEqual([`asset ${h.assets[0].asset_id} is missing at handoff time (${h.assets[0].uri})`]);
  }, 30_000); // uploading and measuring the file is real ffmpeg work: with the default 5 s it failed once when the whole suite ran in parallel (it passes alone in about 2 s)

  /** Upload, route, plan and approve both gates in the demo console. Returns the app, session id and handoff. */
  async function approvedWithUpload(app: ReturnType<typeof build>) {
    const id = await newSession(app);
    await app.request(`/api/sessions/${id}/assets`, file("reel.mp4"));
    await app.request(`/api/sessions/${id}/route`, json({ text: "Make an ad from my footage for TikTok, 15 seconds. Goal: more orders." }));
    const state = (await readSse(await app.request(`/api/sessions/${id}/direct`, json({})))).find((e) => e.event === "state")!.data;
    const g2 = (await (await app.request(`/api/sessions/${id}/approve`, json({ stage: "storyboard", plan_version: state.versions.storyboard, decision: "approved" }))).json()) as any;
    await app.request(`/api/sessions/${id}/approve`, json({ stage: "edit_plan", plan_version: g2.state.versions.edit_plan, decision: "approved" }));
    const res = await app.request(`/api/sessions/${id}/handoff`);
    return { id, res, handoff: (await res.json()) as any };
  }

  it("records a content hash at upload and recovers the approved handoff after a restart", async () => {
    const { id, res, handoff } = await approvedWithUpload(build());
    expect(res.status).toBe(200);
    expect(handoff.assets[0].metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    const runId = handoff.run.run_id;

    const restarted = build(); // same storage folder, empty memory
    expect((await restarted.request(`/api/sessions/${id}/handoff`)).status).toBe(404); // the in-memory session is gone
    const back = await restarted.request(`/api/sessions/${id}/runs/${runId}/handoff`);
    expect(back.status).toBe(200);
    const body = (await back.json()) as any;
    expect(body.verification).toEqual({ ok: true, reasons: [] });
    expect(body.handoff.content_hash).toBe(handoff.content_hash);
    expect((await restarted.request(`/api/sessions/${id}/runs/${id}-1/handoff`)).status).toBe(404);
    expect((await restarted.request(`/api/sessions/${id}/runs/..%2F..%2Fescape/handoff`)).status).toBe(404);
  });

  it("refuses a same-size replacement of an approved upload, and a missing stored approval, after a restart", async () => {
    const { id, handoff } = await approvedWithUpload(build());
    const runId = handoff.run.run_id;
    const bytes = readFileSync(handoff.assets[0].uri);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff; // same size, different content
    writeFileSync(handoff.assets[0].uri, bytes);
    const changed = await build().request(`/api/sessions/${id}/runs/${runId}/handoff`);
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as any).verification.reasons).toEqual([`asset ${handoff.assets[0].asset_id} content changed: its SHA-256 is not the one recorded at upload`]);

    rmSync(join(dir, "sessions", id, "runs", runId, "approvals", "000001.json"));
    const missing = await build().request(`/api/sessions/${id}/runs/${runId}/handoff`);
    expect(missing.status).toBe(409);
    expect(((await missing.json()) as any).verification.reasons).toEqual(["stored approvals cannot be trusted: approval 000001.json is missing (the sequence has a gap)"]);
  });

  /** Upload, route and plan up to gate 1. Returns the session, run id and gate-1 state. */
  async function atGate1WithUpload(app: ReturnType<typeof build>) {
    const id = await newSession(app);
    await app.request(`/api/sessions/${id}/assets`, file("reel.mp4"));
    await app.request(`/api/sessions/${id}/route`, json({ text: "Make an ad from my footage for TikTok, 15 seconds. Goal: more orders." }));
    const state = (await readSse(await app.request(`/api/sessions/${id}/direct`, json({})))).find((e) => e.event === "state")!.data;
    return { id, runId: state.run_id as string, state };
  }
  const resume = (app: ReturnType<typeof build>, id: string, runId: string) => app.request(`/api/sessions/${id}/runs/${runId}/resume`, { method: "POST" });

  it("resumes a run waiting at gate 1 after a restart, at the same gate, and continues through both gates", async () => {
    const { id, runId, state } = await atGate1WithUpload(build());
    expect(state.checkpoint).toEqual({ saved: true });

    const app = build(); // restart
    const res = await resume(app, id, runId);
    expect(res.status).toBe(200);
    const back = (await res.json()) as any;
    expect(back.state).toMatchObject({ status: "awaiting_approval", gate: "storyboard", versions: { storyboard: 1, edit_plan: null } });
    expect(back.state.hashes.storyboard).toBe(state.hashes.storyboard);
    expect(back.state.approvals).toEqual([]);
    expect((await resume(app, id, runId)).status).toBe(409); // already open

    const g2 = (await (await app.request(`/api/sessions/${id}/approve`, json({ stage: "storyboard", plan_version: 1, decision: "approved" }))).json()) as any;
    expect(g2.state.gate).toBe("edit_plan");
    expect(g2.checkpoint).toEqual({ saved: true });
    const done = (await (await app.request(`/api/sessions/${id}/approve`, json({ stage: "edit_plan", plan_version: 1, decision: "approved" }))).json()) as any;
    expect(done.state.status).toBe("approved");
    expect((await app.request(`/api/sessions/${id}/handoff`)).status).toBe(200);
  });

  it("resumes a run waiting at gate 2 after a restart, keeping the storyboard approval and refusing a repeat of gate 1", async () => {
    const first = build();
    const { id, runId } = await atGate1WithUpload(first);
    const g2 = (await (await first.request(`/api/sessions/${id}/approve`, json({ stage: "storyboard", plan_version: 1, decision: "approved" }))).json()) as any;

    const app = build(); // restart
    const back = (await (await resume(app, id, runId)).json()) as any;
    expect(back.state).toMatchObject({ status: "awaiting_approval", gate: "edit_plan" });
    expect(back.state.hashes).toEqual(g2.state.hashes);
    expect(back.state.approvals).toEqual(g2.state.approvals);
    expect((await app.request(`/api/sessions/${id}/approve`, json({ stage: "storyboard", plan_version: 1, decision: "approved" }))).status).toBe(409);
    expect(new RunStore(join(dir, "sessions", id)).loadApprovals(runId).records).toHaveLength(1);
  });

  it("refuses to resume from a corrupt checkpoint or a changed upload, and answers 404 for an unknown run", async () => {
    const { id, runId } = await atGate1WithUpload(build());
    const cp = join(dir, "sessions", id, "runs", runId, "checkpoint.json");
    const good = readFileSync(cp, "utf8");
    writeFileSync(cp, good.slice(0, 40));
    const bad = await resume(build(), id, runId);
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as any).reasons).toEqual(["checkpoint.json is not valid JSON (it may be an interrupted write)"]);

    writeFileSync(cp, good);
    const env = JSON.parse(good);
    const upload = env.state.assets[0].uri as string;
    const bytes = readFileSync(upload); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff; writeFileSync(upload, bytes);
    const changed = await resume(build(), id, runId);
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as any).reasons).toEqual([`asset ${env.state.assets[0].asset_id} content changed: its SHA-256 is not the one recorded at upload`]);

    expect((await resume(build(), id, `${id}-1`)).status).toBe(404);
    expect((await resume(build(), "000000000000", "000000000000-1")).status).toBe(404);
  });

  it("C: an edit request routes to the editing agent and cannot start a plan", async () => {
    const app = build(); const id = await newSession(app);
    await app.request(`/api/sessions/${id}/assets`, file("reel.mp4"));
    const r = (await (await app.request(`/api/sessions/${id}/route`, json({ text: "Cut the silent parts, add captions" }))).json()) as any;
    expect(r.result.request.mode).toBe("edit_existing");
    expect(r.result.request.edit.source_asset_ids).toHaveLength(1);
    const res = await app.request(`/api/sessions/${id}/direct`, json({}));
    expect(res.status).toBe(409);
  });

  it("validates input and fails clearly without a key", async () => {
    const app = build(); const id = await newSession(app);
    expect((await app.request(`/api/sessions/${id}/route`, json({ text: "" }))).status).toBe(400);
    expect((await app.request(`/api/sessions/${id}/route`, json({ text: "x".repeat(4001) }))).status).toBe(400);
    expect((await app.request(`/api/sessions/${id}/direct`, json({}))).status).toBe(409); // nothing routed yet
    const none = build({ llm: null });
    const id2 = await newSession(none);
    const res = await none.request(`/api/sessions/${id2}/route`, json({ text: "make an ad" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toBe("no_api_key");
  });
});

describe("footage analysis and transcripts reach the Director", () => {
  const settle = async (app: ReturnType<typeof build>, id: string) => {
    for (let i = 0; i < 80; i++) {
      const s = (await (await app.request(`/api/sessions/${id}`)).json()) as any;
      if (s.analysis.length && s.analysis.every((a: any) => a.status !== "running")) return s;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("analysis did not finish");
  };

  it("measures an upload in the background and reports what it found", async () => {
    const app = build(); const id = await newSession(app);
    const up = (await (await app.request(`/api/sessions/${id}/assets`, file("defects.mp4"))).json()) as any;
    const s = await settle(app, id);
    const a = s.analysis[0];
    expect(a).toMatchObject({ asset_id: up.added[0].asset_id, status: "done" });
    expect(a.black).toBeGreaterThanOrEqual(1);
    expect(a.frozen).toBeGreaterThanOrEqual(1);
    expect(a.silences).toBeGreaterThanOrEqual(1);
    expect(a.shots).toBeGreaterThan(2);
    expect(a.loudness_lufs).toBeLessThan(0);
    expect(a.usable_s).toBeLessThan(8.5 - 1); // black and frozen stretches are not usable
    expect(a.speech).toMatchObject({ language: "ur" }); // the stub engine "heard" speech in the tone
  }, 60_000);

  it("serves the full transcript, and answers 404 when there is none", async () => {
    const app = build(); const id = await newSession(app);
    const aid = ((await (await app.request(`/api/sessions/${id}/assets`, file("defects.mp4"))).json()) as any).added[0].asset_id;
    await settle(app, id);
    const tr = (await (await app.request(`/api/sessions/${id}/assets/${aid}/transcript`)).json()) as any;
    expect(tr).toMatchObject({ language: "ur", language_name: "Urdu" });
    expect((await app.request(`/api/sessions/${id}/assets/asset_00000000/transcript`)).status).toBe(404);
    expect((await app.request(`/api/sessions/${id}/assets/..%2fx/transcript`)).status).toBe(404);
  }, 60_000);

  it("tells the user when there is no speech instead of inventing a transcript", async () => {
    const quiet = build({ speech: { model: "stub", transcribe: async () => Transcript.parse({ text: " Music", language: "en", language_confidence: 0.4, words: [], segments: [], duration_s: 8, model: "stub" }) } });
    const id = await newSession(quiet);
    await quiet.request(`/api/sessions/${id}/assets`, file("defects.mp4"));
    const a = (await settle(quiet, id)).analysis[0];
    expect(a.speech).toBeNull();
    expect(a.note).toBe("No speech detected.");
  }, 60_000);

  it("plans only inside the usable stretches, using the measured notes", async () => {
    const app = build(); const id = await newSession(app);
    await app.request(`/api/sessions/${id}/assets`, file("defects.mp4"));
    await app.request(`/api/sessions/${id}/route`, json({ text: "Make a 6 second TikTok ad from my footage. Goal: more orders." }));
    const events = await readSse(await app.request(`/api/sessions/${id}/direct`, json({}))); // waits for the analysis to finish
    const state = events.find((e) => e.event === "state")!.data;
    expect(state.status).toBe("awaiting_approval");
    const used = state.scenePlan.scenes.filter((s: any) => s.asset_ids.length);
    expect(used.length).toBeGreaterThan(0);
    for (const s of used) {
      const from = s.source_in_seconds, to = from + s.duration_seconds;
      const inBlack = from < 3.9 && to > 2.6; // the black stretch is about 2.5s to 4s
      const inFrozen = to > 6.6; // the frozen end card of the source
      expect(inBlack || inFrozen, `scene ${s.scene_id} uses ${from}-${to}s of the source`).toBe(false);
    }
  }, 60_000);

  it("forgets the analysis when a file is removed", async () => {
    const app = build(); const id = await newSession(app);
    const aid = ((await (await app.request(`/api/sessions/${id}/assets`, file("defects.mp4"))).json()) as any).added[0].asset_id;
    await settle(app, id);
    await app.request(`/api/sessions/${id}/assets/${aid}`, { method: "DELETE" });
    const s = (await (await app.request(`/api/sessions/${id}`)).json()) as any;
    expect(s.analysis).toEqual([]);
    expect((await app.request(`/api/sessions/${id}/assets/${aid}/transcript`)).status).toBe(404);
  }, 60_000);
});
describe("model failures", () => {
  /** The real SDK throws Error instances that carry an HTTP status. */
  const apiErr = (status: number, message: string) => Object.assign(new Error(message), { status });
  const broke = (error: unknown) => Object.assign({ generate: async () => { throw error; } }, { model: "claude-test" });

  it("explains a billing failure, remembers it in the status bar, and clears it after a success", async () => {
    let fail = true;
    const flaky = { model: "claude-test", generate: (req: any) => (fail ? Promise.reject(apiErr(400, "Your credit balance is too low")) : llm.generate(req)) };
    const app = build({ llm: flaky as never, demo: false });
    const id = await newSession(app);
    const res = await app.request(`/api/sessions/${id}/route`, json({ text: "Make an ad for my coffee roaster on TikTok" }));
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("llm_billing");
    expect(body.message).toContain("no credit");
    expect(body.message).not.toContain("balance is too low"); // provider text is not passed through
    expect(((await (await app.request("/api/health")).json()) as any).llm.problem.code).toBe("llm_billing");

    fail = false;
    expect((await app.request(`/api/sessions/${id}/route`, json({ text: "Make an ad for my coffee roaster on TikTok" }))).status).toBe(200);
    expect(((await (await app.request("/api/health")).json()) as any).llm.problem).toBeNull();
  });

  it("maps other failures to useful statuses and hides internal errors", async () => {
    const post = async (error: unknown) => {
      const app = build({ llm: broke(error) as never, demo: false });
      const id = await newSession(app);
      const r = await app.request(`/api/sessions/${id}/route`, json({ text: "make a tiktok ad" }));
      return { status: r.status, body: (await r.json()) as any };
    };
    expect(await post(apiErr(401, "bad"))).toMatchObject({ status: 502, body: { error: "llm_auth" } });
    expect(await post(apiErr(429, "slow"))).toMatchObject({ status: 429, body: { error: "llm_rate_limit" } });
    const bug = await post(new Error("secret internal detail sk-ant-xyz"));
    expect(bug).toMatchObject({ status: 500, body: { error: "internal" } });
    expect(JSON.stringify(bug.body)).not.toContain("secret internal detail");
  });

  it("reports a model failure during a streamed run as a friendly failure event", async () => {
    // route with the demo model, then break the model for the run
    let calls = 0;
    const dying = { model: "claude-test", generate: (req: any) => (++calls > 1 ? Promise.reject(apiErr(401, "bad key")) : llm.generate(req)) };
    const app = build({ llm: dying as never, demo: false });
    const id = await newSession(app);
    await app.request(`/api/sessions/${id}/route`, json({ text: "A 10 second TikTok ad for my shoe shop." })); // call 1
    const events = await readSse(await app.request(`/api/sessions/${id}/direct`, json({})));
    const failure = events.find((e) => e.event === "failure")!;
    expect(failure.data.code).toBe("llm_auth");
    expect(failure.data.message).toContain("API key");
  });
});

describe("static UI", () => {
  it("serves the page and assets", async () => {
    const app = build();
    const html = await (await app.request("/")).text();
    expect(html).toContain("Director Console");
    expect((await app.request("/app.js")).status).toBe(200);
    expect((await app.request("/styles.css")).status).toBe(200);
  });
});
